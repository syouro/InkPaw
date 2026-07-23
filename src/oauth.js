"use strict";

// InkPaw 自托管 OAuth 2.1 provider。
// 协议路由和参数校验交给 MCP SDK；本模块负责持久化客户端、授权码、
// 访问/刷新令牌，以及真正由资源所有者确认和撤销授权。

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const express = require("express");
const Database = require("better-sqlite3");
const {
  AccessDeniedError,
  InvalidGrantError,
  InvalidClientMetadataError,
  InvalidScopeError,
  InvalidTargetError,
  InvalidTokenError,
} = require("@modelcontextprotocol/sdk/server/auth/errors.js");

const ACCESS_TTL_SECONDS = 60 * 60;
const REFRESH_TTL_SECONDS = 30 * 24 * 60 * 60;
const CODE_TTL_SECONDS = 5 * 60;
const MANAGEMENT_TTL_MS = 10 * 60 * 1000;
const ALLOWED_SCOPES = new Set(["mcp:tools"]);

const nowSeconds = () => Math.floor(Date.now() / 1000);
const opaqueToken = (prefix) => `${prefix}_${crypto.randomBytes(32).toString("base64url")}`;
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const safeEqual = (left, right) => {
  const a = crypto.createHash("sha256").update(String(left)).digest();
  const b = crypto.createHash("sha256").update(String(right)).digest();
  return crypto.timingSafeEqual(a, b);
};
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[char]);

class OAuthClientsStore {
  constructor(db) {
    this.db = db;
  }

  async getClient(clientId) {
    const row = this.db.prepare("SELECT json FROM oauth_clients WHERE client_id = ?").get(clientId);
    return row ? JSON.parse(row.json) : undefined;
  }

  async registerClient(client) {
    if (!Array.isArray(client.redirect_uris) || client.redirect_uris.length < 1 || client.redirect_uris.length > 10) {
      throw new InvalidClientMetadataError("redirect_uris must contain between 1 and 10 entries");
    }
    for (const redirect of client.redirect_uris) {
      const url = new URL(redirect);
      const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
      if ((!loopback && url.protocol !== "https:") || url.hash || url.username || url.password) {
        throw new InvalidClientMetadataError("redirect URIs must use HTTPS or a loopback host, without fragments or userinfo");
      }
    }
    if (client.token_endpoint_auth_method && !["none", "client_secret_post"].includes(client.token_endpoint_auth_method)) {
      throw new InvalidClientMetadataError("unsupported token_endpoint_auth_method");
    }
    if (client.grant_types && client.grant_types.some((grant) => !["authorization_code", "refresh_token"].includes(grant))) {
      throw new InvalidClientMetadataError("unsupported grant_type");
    }
    if (client.response_types && client.response_types.some((type) => type !== "code")) {
      throw new InvalidClientMetadataError("unsupported response_type");
    }
    this.db.prepare(`
      INSERT INTO oauth_clients (client_id, json, created_at)
      VALUES (?, ?, ?)
      ON CONFLICT(client_id) DO UPDATE SET json = excluded.json
    `).run(client.client_id, JSON.stringify(client), nowSeconds());
    return client;
  }
}

class InkPawOAuthProvider {
  constructor({ dbPath, resourceUrl, ownerPassword }) {
    if (!ownerPassword || ownerPassword.length < 12) {
      throw new Error("DOCX_MCP_OAUTH_PASSWORD 至少需要 12 个字符");
    }
    this.resourceUrl = new URL(resourceUrl);
    this.ownerPassword = ownerPassword;
    this.managementSessions = new Map();

    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    try { fs.chmodSync(dbPath, 0o600); } catch { /* 部分平台不支持 chmod */ }
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS oauth_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS oauth_clients (
        client_id TEXT PRIMARY KEY,
        json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS oauth_codes (
        code_hash TEXT PRIMARY KEY,
        client_id TEXT NOT NULL,
        redirect_uri TEXT NOT NULL,
        code_challenge TEXT NOT NULL,
        scopes TEXT NOT NULL,
        resource TEXT NOT NULL,
        user_id TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS oauth_tokens (
        token_hash TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK(kind IN ('access', 'refresh')),
        client_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        scopes TEXT NOT NULL,
        resource TEXT NOT NULL,
        grant_id TEXT NOT NULL,
        issued_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        revoked_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_oauth_tokens_grant ON oauth_tokens(grant_id);
      CREATE INDEX IF NOT EXISTS idx_oauth_tokens_expiry ON oauth_tokens(expires_at);
    `);
    this.ownerId = this.#setting("owner_id", () => crypto.randomUUID());
    this.clientsStore = new OAuthClientsStore(this.db);
    this.db.prepare("DELETE FROM oauth_codes WHERE expires_at < ?").run(nowSeconds());
    this.db.prepare("DELETE FROM oauth_tokens WHERE expires_at < ?").run(nowSeconds());
  }

  #setting(key, createValue) {
    const current = this.db.prepare("SELECT value FROM oauth_settings WHERE key = ?").get(key);
    if (current) return current.value;
    const value = createValue();
    this.db.prepare("INSERT INTO oauth_settings (key, value) VALUES (?, ?)").run(key, value);
    return value;
  }

  #resourceMatches(resource) {
    if (!resource) return false;
    try {
      const actual = new URL(resource);
      actual.hash = "";
      const expected = new URL(this.resourceUrl);
      expected.hash = "";
      return actual.href === expected.href;
    } catch {
      return false;
    }
  }

  #validateScopes(scopes) {
    const normalized = [...new Set(scopes && scopes.length ? scopes : ["mcp:tools"])]
      .filter(Boolean);
    if (!normalized.length || normalized.some((scope) => !ALLOWED_SCOPES.has(scope))) {
      throw new InvalidScopeError("仅支持 mcp:tools scope");
    }
    return normalized;
  }

  #renderConsent(res, client, params, errorMessage = "") {
    const hidden = {
      client_id: client.client_id,
      redirect_uri: params.redirectUri,
      response_type: "code",
      code_challenge: params.codeChallenge,
      code_challenge_method: "S256",
      scope: (params.scopes || []).join(" "),
      state: params.state,
      resource: params.resource && params.resource.href,
    };
    const hiddenFields = Object.entries(hidden)
      .filter(([, value]) => value !== undefined)
      .map(([name, value]) => `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`)
      .join("");
    const clientName = client.client_name || client.client_id;
    const redirectHost = new URL(params.redirectUri).host;
    res.status(errorMessage ? 401 : 200).type("html").send(`<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>授权 InkPaw</title>
<style>body{font-family:system-ui,sans-serif;background:#f5f2ea;color:#24221f;margin:0}.card{max-width:520px;margin:8vh auto;background:#fff;padding:30px;border-radius:16px;box-shadow:0 12px 40px #0002}h1{font-size:1.5rem}.meta{background:#f7f7f7;padding:14px;border-radius:10px;word-break:break-all}.error{color:#a32020}label{display:block;margin:18px 0 7px}input[type=password]{box-sizing:border-box;width:100%;padding:11px;border:1px solid #aaa;border-radius:8px}.actions{display:flex;gap:12px;margin-top:22px}button{padding:10px 18px;border:0;border-radius:8px;cursor:pointer}.approve{background:#222;color:#fff}.deny{background:#eee}</style></head>
<body><main class="card"><h1>允许访问 InkPaw？</h1>
<p><strong>${escapeHtml(clientName)}</strong> 请求代表你调用文档工具。</p>
<div class="meta">权限：${escapeHtml((params.scopes || []).join(" ") || "mcp:tools")}<br>回调域名：${escapeHtml(redirectHost)}</div>
${errorMessage ? `<p class="error">${escapeHtml(errorMessage)}</p>` : ""}
<form method="post" action="/authorize">${hiddenFields}
<label for="password">资源所有者密码</label><input id="password" name="password" type="password" required autocomplete="current-password">
<div class="actions"><button class="approve" name="decision" value="approve">允许</button><button class="deny" name="decision" value="deny">拒绝</button></div>
</form><p><small>授权后可在 <a href="/oauth/authorizations">授权管理</a> 中随时撤销。</small></p></main></body></html>`);
  }

  async authorize(client, params, res) {
    if (!this.#resourceMatches(params.resource)) {
      throw new InvalidTargetError("resource 必须是当前 InkPaw MCP 地址");
    }
    params.scopes = this.#validateScopes(params.scopes);
    const body = res.req && res.req.body ? res.req.body : {};
    if (res.req.method !== "POST" || !body.decision) {
      this.#renderConsent(res, client, params);
      return;
    }
    if (body.decision === "deny") throw new AccessDeniedError("用户拒绝了授权请求");
    if (!safeEqual(body.password || "", this.ownerPassword)) {
      this.#renderConsent(res, client, params, "密码不正确，未授予任何权限");
      return;
    }

    const code = opaqueToken("ink_code");
    this.db.prepare(`
      INSERT INTO oauth_codes
        (code_hash, client_id, redirect_uri, code_challenge, scopes, resource, user_id, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      sha256(code), client.client_id, params.redirectUri, params.codeChallenge,
      JSON.stringify(params.scopes), params.resource.href, this.ownerId, nowSeconds() + CODE_TTL_SECONDS,
    );
    const target = new URL(params.redirectUri);
    target.searchParams.set("code", code);
    if (params.state !== undefined) target.searchParams.set("state", params.state);
    res.redirect(302, target.href);
  }

  async challengeForAuthorizationCode(client, authorizationCode) {
    const row = this.db.prepare(`
      SELECT code_challenge, client_id, expires_at FROM oauth_codes WHERE code_hash = ?
    `).get(sha256(authorizationCode));
    if (!row || row.client_id !== client.client_id || row.expires_at < nowSeconds()) {
      throw new InvalidGrantError("授权码无效或已过期");
    }
    return row.code_challenge;
  }

  #issueTokens({ clientId, userId, scopes, resource, grantId = crypto.randomUUID() }) {
    const issuedAt = nowSeconds();
    const accessToken = opaqueToken("ink_at");
    const refreshToken = opaqueToken("ink_rt");
    const insert = this.db.prepare(`
      INSERT INTO oauth_tokens
        (token_hash, kind, client_id, user_id, scopes, resource, grant_id, issued_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insert.run(sha256(accessToken), "access", clientId, userId, JSON.stringify(scopes), resource, grantId, issuedAt, issuedAt + ACCESS_TTL_SECONDS);
    insert.run(sha256(refreshToken), "refresh", clientId, userId, JSON.stringify(scopes), resource, grantId, issuedAt, issuedAt + REFRESH_TTL_SECONDS);
    return {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: ACCESS_TTL_SECONDS,
      refresh_token: refreshToken,
      scope: scopes.join(" "),
    };
  }

  async exchangeAuthorizationCode(client, authorizationCode, _codeVerifier, redirectUri, resource) {
    const row = this.db.prepare("SELECT * FROM oauth_codes WHERE code_hash = ?").get(sha256(authorizationCode));
    if (!row || row.client_id !== client.client_id || row.expires_at < nowSeconds()) {
      throw new InvalidGrantError("授权码无效或已过期");
    }
    if (redirectUri !== row.redirect_uri) throw new InvalidGrantError("redirect_uri 与授权请求不一致");
    if (!this.#resourceMatches(resource) || resource.href !== row.resource) {
      throw new InvalidTargetError("token 请求的 resource 不匹配");
    }
    const issue = this.db.transaction(() => {
      const removed = this.db.prepare("DELETE FROM oauth_codes WHERE code_hash = ?").run(sha256(authorizationCode));
      if (removed.changes !== 1) throw new InvalidGrantError("授权码已被使用");
      return this.#issueTokens({
        clientId: client.client_id,
        userId: row.user_id,
        scopes: JSON.parse(row.scopes),
        resource: row.resource,
      });
    });
    return issue();
  }

  async exchangeRefreshToken(client, refreshToken, requestedScopes, resource) {
    const row = this.db.prepare("SELECT * FROM oauth_tokens WHERE token_hash = ? AND kind = 'refresh'")
      .get(sha256(refreshToken));
    if (!row || row.client_id !== client.client_id || row.revoked_at || row.expires_at < nowSeconds()) {
      throw new InvalidGrantError("刷新令牌无效、已撤销或已过期");
    }
    if (!this.#resourceMatches(resource) || resource.href !== row.resource) {
      throw new InvalidTargetError("刷新请求的 resource 不匹配");
    }
    const originalScopes = JSON.parse(row.scopes);
    const scopes = requestedScopes ? this.#validateScopes(requestedScopes) : originalScopes;
    if (scopes.some((scope) => !originalScopes.includes(scope))) {
      throw new InvalidScopeError("刷新时不能扩大原授权范围");
    }
    const rotate = this.db.transaction(() => {
      const revoked = this.db.prepare(`
        UPDATE oauth_tokens SET revoked_at = ?
        WHERE token_hash = ? AND revoked_at IS NULL
      `).run(nowSeconds(), sha256(refreshToken));
      if (revoked.changes !== 1) throw new InvalidGrantError("刷新令牌已经使用");
      return this.#issueTokens({
        clientId: row.client_id,
        userId: row.user_id,
        scopes,
        resource: row.resource,
        grantId: row.grant_id,
      });
    });
    return rotate();
  }

  async verifyAccessToken(token) {
    const row = this.db.prepare("SELECT * FROM oauth_tokens WHERE token_hash = ? AND kind = 'access'")
      .get(sha256(token));
    if (!row || row.revoked_at || row.expires_at < nowSeconds() || !this.#resourceMatches(row.resource)) {
      // SDK 会把消息放进 WWW-Authenticate；HTTP header 只能使用可安全编码的 ASCII。
      throw new InvalidTokenError("Invalid, revoked, or expired access token");
    }
    return {
      token,
      clientId: row.client_id,
      scopes: JSON.parse(row.scopes),
      expiresAt: row.expires_at,
      resource: new URL(row.resource),
      extra: { userId: row.user_id, grantId: row.grant_id },
    };
  }

  async revokeToken(client, request) {
    const row = this.db.prepare("SELECT grant_id, kind FROM oauth_tokens WHERE token_hash = ? AND client_id = ?")
      .get(sha256(request.token), client.client_id);
    if (!row) return;
    if (row.kind === "refresh") {
      this.revokeGrant(row.grant_id);
    } else {
      this.db.prepare("UPDATE oauth_tokens SET revoked_at = ? WHERE token_hash = ?")
        .run(nowSeconds(), sha256(request.token));
    }
  }

  listActiveGrants() {
    return this.db.prepare(`
      SELECT t.grant_id, t.client_id, c.json AS client_json,
             MIN(t.issued_at) AS issued_at, MAX(t.expires_at) AS expires_at,
             t.scopes
      FROM oauth_tokens t
      LEFT JOIN oauth_clients c ON c.client_id = t.client_id
      WHERE t.revoked_at IS NULL AND t.expires_at >= ?
      GROUP BY t.grant_id, t.client_id, c.json, t.scopes
      ORDER BY issued_at DESC
    `).all(nowSeconds()).map((row) => {
      const client = row.client_json ? JSON.parse(row.client_json) : {};
      return {
        grantId: row.grant_id,
        clientId: row.client_id,
        clientName: client.client_name || row.client_id,
        scopes: JSON.parse(row.scopes),
        issuedAt: row.issued_at,
        expiresAt: row.expires_at,
      };
    });
  }

  revokeGrant(grantId) {
    return this.db.prepare("UPDATE oauth_tokens SET revoked_at = ? WHERE grant_id = ? AND revoked_at IS NULL")
      .run(nowSeconds(), grantId).changes;
  }

  verifyOwnerPassword(password) {
    return safeEqual(password || "", this.ownerPassword);
  }

  close() {
    this.db.close();
  }
}

const parseCookies = (header) => Object.fromEntries(String(header || "").split(";")
  .map((part) => part.trim()).filter(Boolean).map((part) => {
    const index = part.indexOf("=");
    return index < 0 ? [part, ""] : [part.slice(0, index), decodeURIComponent(part.slice(index + 1))];
  }));

function createOAuthManagementRouter(provider, { secureCookies = true } = {}) {
  const router = express.Router();
  router.use(express.urlencoded({ extended: false }));

  const sessionFor = (req) => {
    const token = parseCookies(req.headers.cookie).inkpaw_oauth_admin;
    const session = token && provider.managementSessions.get(token);
    if (!session || session.expiresAt < Date.now()) {
      if (token) provider.managementSessions.delete(token);
      return null;
    }
    return { token, ...session };
  };
  const loginPage = (message = "") => `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>InkPaw 授权管理</title><style>body{font-family:system-ui;max-width:680px;margin:8vh auto;padding:0 20px}input,button{padding:10px;margin:5px 0}.error{color:#a20}</style></head><body><h1>InkPaw 授权管理</h1>${message ? `<p class="error">${escapeHtml(message)}</p>` : ""}<form method="post"><input type="password" name="password" placeholder="资源所有者密码" required autocomplete="current-password"><button>登录</button></form></body></html>`;

  router.get("/", (req, res) => {
    res.set("Cache-Control", "no-store");
    const session = sessionFor(req);
    if (!session) return res.status(200).type("html").send(loginPage());
    const rows = provider.listActiveGrants().map((grant) => `<tr><td>${escapeHtml(grant.clientName)}</td><td>${escapeHtml(grant.scopes.join(" "))}</td><td>${escapeHtml(new Date(grant.issuedAt * 1000).toLocaleString("zh-CN"))}</td><td><form method="post" action="/oauth/authorizations/revoke"><input type="hidden" name="csrf" value="${escapeHtml(session.csrf)}"><input type="hidden" name="grant_id" value="${escapeHtml(grant.grantId)}"><button>撤销</button></form></td></tr>`).join("");
    return res.type("html").send(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>InkPaw 授权管理</title><style>body{font-family:system-ui;max-width:900px;margin:5vh auto;padding:0 20px}table{width:100%;border-collapse:collapse}td,th{padding:10px;border-bottom:1px solid #ddd;text-align:left}button{padding:7px 12px}</style></head><body><h1>有效授权</h1>${rows ? `<table><tr><th>客户端</th><th>权限</th><th>授权时间</th><th></th></tr>${rows}</table>` : "<p>当前没有有效授权。</p>"}</body></html>`);
  });

  router.post("/", (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!provider.verifyOwnerPassword(req.body.password)) {
      return res.status(401).type("html").send(loginPage("密码不正确"));
    }
    const token = opaqueToken("ink_admin");
    provider.managementSessions.set(token, {
      csrf: opaqueToken("ink_csrf"),
      expiresAt: Date.now() + MANAGEMENT_TTL_MS,
    });
    res.set("Set-Cookie", `inkpaw_oauth_admin=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/oauth/authorizations; Max-Age=${MANAGEMENT_TTL_MS / 1000}${secureCookies ? "; Secure" : ""}`);
    return res.redirect(303, "/oauth/authorizations");
  });

  router.post("/revoke", (req, res) => {
    res.set("Cache-Control", "no-store");
    const session = sessionFor(req);
    if (!session || !safeEqual(req.body.csrf || "", session.csrf)) return res.status(403).send("forbidden");
    if (!/^[0-9a-f-]{36}$/i.test(req.body.grant_id || "")) return res.status(400).send("invalid grant");
    provider.revokeGrant(req.body.grant_id);
    return res.redirect(303, "/oauth/authorizations");
  });

  return router;
}

module.exports = {
  InkPawOAuthProvider,
  createOAuthManagementRouter,
  ACCESS_TTL_SECONDS,
  REFRESH_TTL_SECONDS,
};
