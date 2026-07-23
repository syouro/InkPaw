"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

let portSequence = 0;

const startOAuthServer = async (dir) => {
  const port = 24000 + ((process.pid * 17 + portSequence++) % 3000);
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [path.join(__dirname, "..", "src", "server.js"), "--http"], {
    env: {
      ...process.env,
      DOCX_MCP_HOST: "127.0.0.1",
      DOCX_MCP_PORT: String(port),
      DOCX_MCP_AUTH: "oauth",
      DOCX_MCP_PUBLIC_URL: `${origin}/mcp`,
      DOCX_MCP_OAUTH_PASSWORD: "owner-password-for-tests",
      DOCX_MCP_OAUTH_DB: path.join(dir, "oauth.db"),
      DOCX_MCP_DB: path.join(dir, "global.db"),
      DOCX_MCP_USERS: path.join(dir, "users"),
      DOCX_MCP_OUTPUT: path.join(dir, "output"),
      DOCX_MCP_TEMPLATES: path.join(dir, "templates"),
      DOCX_MCP_PROFILE: path.join(dir, "profile.json"),
      DOCX_MCP_DOWNLOADS: path.join(dir, "downloads"),
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  await new Promise((resolve, reject) => {
    let stderr = "";
    const timer = setTimeout(() => reject(new Error(`OAuth 服务 10 秒未就绪：${stderr}`)), 10000);
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
      if (stderr.includes("已启动")) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`OAuth 服务提前退出 code=${code}：${stderr}`));
    });
  });
  return { child, origin, resource: `${origin}/mcp` };
};

const form = (values) => new URLSearchParams(values);

test("OAuth：发现、同意、PKCE、刷新轮换、MCP 鉴权与撤销完整闭环", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "inkpaw-oauth-"));
  const { child, origin, resource } = await startOAuthServer(dir);
  t.after(() => {
    child.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const health = await fetch(`${origin}/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: "ok", service: "inkpaw", version: "0.1.0", auth: "oauth" });

  const protectedMetadata = await fetch(`${origin}/.well-known/oauth-protected-resource/mcp`);
  assert.equal(protectedMetadata.status, 200);
  const protectedJson = await protectedMetadata.json();
  assert.equal(protectedJson.resource, resource);
  assert.deepEqual(protectedJson.authorization_servers, [`${origin}/`]);

  const metadata = await (await fetch(`${origin}/.well-known/oauth-authorization-server`)).json();
  assert.equal(metadata.authorization_endpoint, `${origin}/authorize`);
  assert.equal(metadata.token_endpoint, `${origin}/token`);
  assert.equal(metadata.revocation_endpoint, `${origin}/revoke`);
  assert.deepEqual(metadata.code_challenge_methods_supported, ["S256"]);

  const insecureRegistration = await fetch(`${origin}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ redirect_uris: ["http://client.example.com/callback"] }),
  });
  assert.equal(insecureRegistration.status, 400);
  assert.equal((await insecureRegistration.json()).error, "invalid_client_metadata");

  const registration = await fetch(`${origin}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      redirect_uris: ["http://127.0.0.1/callback"],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      client_name: "InkPaw OAuth test client",
    }),
  });
  assert.equal(registration.status, 201, await registration.clone().text());
  const client = await registration.json();
  assert.ok(client.client_id);

  const verifier = "pkce-verifier-0123456789abcdefghijklmnopqrstuvwxyz-ABCDE";
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  const authorizeParams = {
    client_id: client.client_id,
    redirect_uri: "http://127.0.0.1/callback",
    response_type: "code",
    code_challenge: challenge,
    code_challenge_method: "S256",
    scope: "mcp:tools",
    state: "state-123",
    resource,
  };
  const consent = await fetch(`${origin}/authorize?${form(authorizeParams)}`, { redirect: "manual" });
  assert.equal(consent.status, 200);
  assert.match(await consent.text(), /允许访问 InkPaw/);

  const approved = await fetch(`${origin}/authorize`, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form({ ...authorizeParams, decision: "approve", password: "owner-password-for-tests" }),
  });
  assert.equal(approved.status, 302);
  const callback = new URL(approved.headers.get("location"));
  assert.equal(callback.searchParams.get("state"), "state-123");
  const code = callback.searchParams.get("code");
  assert.ok(code);

  const tokenResponse = await fetch(`${origin}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form({
      grant_type: "authorization_code",
      client_id: client.client_id,
      code,
      code_verifier: verifier,
      redirect_uri: "http://127.0.0.1/callback",
      resource,
    }),
  });
  assert.equal(tokenResponse.status, 200, await tokenResponse.clone().text());
  const tokens = await tokenResponse.json();
  assert.ok(tokens.access_token);
  assert.ok(tokens.refresh_token);
  assert.equal(tokens.scope, "mcp:tools");

  const rpcBody = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
  const mcpHeaders = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
  const unauthenticated = await fetch(resource, {
    method: "POST", headers: mcpHeaders, body: rpcBody,
  });
  assert.equal(unauthenticated.status, 401);
  assert.match(unauthenticated.headers.get("www-authenticate"), /resource_metadata=/);

  const authenticated = await fetch(resource, {
    method: "POST",
    headers: { ...mcpHeaders, Authorization: `Bearer ${tokens.access_token}` },
    body: rpcBody,
  });
  assert.equal(authenticated.status, 200, await authenticated.clone().text());
  const toolList = await authenticated.json();
  assert.ok(toolList.result.tools.length >= 10);
  const renderTool = toolList.result.tools.find((tool) => tool.name === "render_document");
  assert.equal(renderTool.inputSchema.properties.docId.format, "uuid");
  assert.equal(renderTool.inputSchema.properties.outPath.maxLength, 4096);
  const insertTool = toolList.result.tools.find((tool) => tool.name === "insert_nodes");
  assert.deepEqual(insertTool.inputSchema.properties.position.enum, ["before", "after"]);
  assert.equal(insertTool.inputSchema.properties.nodes.minItems, 1);
  assert.equal(insertTool.inputSchema.properties.nodes.maxItems, 5000);

  const refreshResponse = await fetch(`${origin}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form({
      grant_type: "refresh_token",
      client_id: client.client_id,
      refresh_token: tokens.refresh_token,
      resource,
    }),
  });
  assert.equal(refreshResponse.status, 200, await refreshResponse.clone().text());
  const refreshed = await refreshResponse.json();
  assert.notEqual(refreshed.refresh_token, tokens.refresh_token);

  const replay = await fetch(`${origin}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form({
      grant_type: "refresh_token",
      client_id: client.client_id,
      refresh_token: tokens.refresh_token,
      resource,
    }),
  });
  assert.equal(replay.status, 400);

  const revoked = await fetch(`${origin}/revoke`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form({ client_id: client.client_id, token: tokens.access_token, token_type_hint: "access_token" }),
  });
  assert.equal(revoked.status, 200, await revoked.text());

  const oldAccessAfterRevoke = await fetch(resource, {
    method: "POST",
    headers: { ...mcpHeaders, Authorization: `Bearer ${tokens.access_token}` },
    body: rpcBody,
  });
  assert.equal(oldAccessAfterRevoke.status, 401);

  const ownerLogin = await fetch(`${origin}/oauth/authorizations`, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form({ password: "owner-password-for-tests" }),
  });
  assert.equal(ownerLogin.status, 303);
  const ownerCookie = ownerLogin.headers.get("set-cookie").split(";", 1)[0];
  const grantsPage = await fetch(`${origin}/oauth/authorizations`, { headers: { Cookie: ownerCookie } });
  assert.equal(grantsPage.status, 200);
  const grantsHtml = await grantsPage.text();
  assert.match(grantsHtml, /InkPaw OAuth test client/);
  const csrf = grantsHtml.match(/name="csrf" value="([^"]+)"/)[1];
  const grantId = grantsHtml.match(/name="grant_id" value="([^"]+)"/)[1];
  const ownerRevoke = await fetch(`${origin}/oauth/authorizations/revoke`, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: ownerCookie },
    body: form({ csrf, grant_id: grantId }),
  });
  assert.equal(ownerRevoke.status, 303);

  const afterRevoke = await fetch(resource, {
    method: "POST",
    headers: { ...mcpHeaders, Authorization: `Bearer ${refreshed.access_token}` },
    body: rpcBody,
  });
  assert.equal(afterRevoke.status, 401, await afterRevoke.clone().text());
});
