#!/usr/bin/env node
/**
 * server.js — docx-mcp 启动入口：传输选择
 *
 *   node src/server.js            stdio（默认，npm start）
 *   node src/server.js --http     Streamable HTTP，端点 /mcp（npm run start:http）
 *
 * 工具注册在 mcp-server.js，业务逻辑在 service.js，两种传输共用同一份 service。
 * HTTP 走 SDK 的无状态模式：每请求新建 McpServer + transport，不管理会话。
 *
 * 环境变量（都有缺省，首次运行自动建目录）：
 *   DOCX_MCP_DB       SQLite 路径，默认 <repo>/data/docx-mcp.db
 *   DOCX_MCP_OUTPUT   渲染产物目录，默认 <repo>/data/output
 *   DOCX_MCP_PROFILE  style profile 路径，默认 <repo>/data/style-profile.json（可不存在）
 *   DOCX_MCP_TEMPLATES 填槽模板目录，默认 <repo>/data/templates
 *   DOCX_MCP_HOST     HTTP 监听地址，默认 127.0.0.1
 *   DOCX_MCP_PORT     HTTP 端口，默认 8765
 *   DOCX_MCP_AUTH     token（默认，本地兼容）或 oauth（公网）
 *   DOCX_MCP_TOKEN    /mcp 鉴权 token，缺省读/生成 data/mcp-token（Bearer 头校验）
 *   DOCX_MCP_PUBLIC_URL OAuth 模式的最终 HTTPS 地址，如 https://mcp.example.com/mcp
 *   DOCX_MCP_OAUTH_PASSWORD OAuth 授权页的资源所有者密码（至少 12 字符）
 *   DOCX_MCP_OAUTH_DB OAuth 客户端/授权/令牌数据库，默认 <repo>/data/oauth.db
 *   DOCX_MCP_TLS_CERT / DOCX_MCP_TLS_KEY 可选原生 TLS 证书链与私钥（通常由反代终止 TLS）
 *   DOCX_MCP_TRUST_PROXY 可信反代跳数（如 1），用于 OAuth 端点按真实客户端 IP 限流
 *   DOCX_MCP_DOWNLOADS 下载区目录，默认 <repo>/data/downloads（token 见 data/dl-token，公网经 openresty /docx-dl/ 反代）
 *   DOCX_MCP_USERS    多用户作用域根目录，默认 <repo>/data/users（X-Docx-Scope-User 头触发，见 docs/architecture.md）
 *   DOCX_MCP_SCOPED_MAX 作用域 service 实例缓存上限，默认 32（超限挤掉最久未用；闲置 30 分钟自动关闭）
 *   DOCX_MCP_MAX_TEMPLATES / DOCX_MCP_MAX_OUTPUT_MB 作用域用户存储粗闸，默认 20 个 / 200 MB（本地全局不设限）
 */
const http = require("http");
const https = require("https");
const fs = require("fs");
const crypto = require("crypto");
const path = require("path");
const express = require("express");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { StreamableHTTPServerTransport } = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const {
  getOAuthProtectedResourceMetadataUrl,
  mcpAuthRouter,
} = require("@modelcontextprotocol/sdk/server/auth/router.js");
const { requireBearerAuth } = require("@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js");
const { createService } = require("./service");
const { createMcpServer } = require("./mcp-server");
const { InkPawOAuthProvider, createOAuthManagementRouter } = require("./oauth");

const ROOT = path.join(__dirname, "..");
const service = createService({
  dbPath: process.env.DOCX_MCP_DB || path.join(ROOT, "data", "docx-mcp.db"),
  outputDir: process.env.DOCX_MCP_OUTPUT || path.join(ROOT, "data", "output"),
  profilePath: process.env.DOCX_MCP_PROFILE || path.join(ROOT, "data", "style-profile.json"),
  templatesDir: process.env.DOCX_MCP_TEMPLATES || path.join(ROOT, "data", "templates"),
});

// ------------------------------------------------------- 多用户作用域（HTTP 专用）
// 可信网关可在 /mcp 请求上带 X-Docx-Scope-User 头（docs/architecture.md）：
// 有头→该用户独立的 DB/产物/模板/profile（data/users/<userId>/），无头→上面的全局 service，
// 本地 stdio / Claude Code 用法零改动。头只在过了 mcp-token 鉴权的请求上生效；
// userId 必须由通过鉴权的可信网关填入，模型的工具参数里不存在作用域概念。
const USERS_ROOT = process.env.DOCX_MCP_USERS || path.join(ROOT, "data", "users");
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SCOPED_MAX = Number(process.env.DOCX_MCP_SCOPED_MAX) || 32;
const SCOPED_IDLE_MS = 30 * 60 * 1000;
// 存储粗闸：仅作用域用户受限，本地全局 service 不设限
const SCOPED_LIMITS = {
  maxTemplates: Number(process.env.DOCX_MCP_MAX_TEMPLATES) || 20,
  maxOutputMB: Number(process.env.DOCX_MCP_MAX_OUTPUT_MB) || 200,
};
const scopedServices = new Map(); // userId -> { service, lastUsed }

const closeScoped = (userId) => {
  const entry = scopedServices.get(userId);
  if (!entry) return;
  scopedServices.delete(userId);
  try { entry.service.close(); } catch { /* 已关闭无所谓 */ }
};

const scopedServiceFor = (userId) => {
  let entry = scopedServices.get(userId);
  if (!entry) {
    // 实例上限：挤掉最久未用的（SQLite 连接不能无限攒）
    if (scopedServices.size >= SCOPED_MAX) {
      const oldest = [...scopedServices.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
      if (oldest) closeScoped(oldest[0]);
    }
    const base = path.join(USERS_ROOT, userId);
    entry = {
      service: createService({
        dbPath: path.join(base, "docx-mcp.db"),
        outputDir: path.join(base, "output"),
        profilePath: path.join(base, "style-profile.json"),
        templatesDir: path.join(base, "templates"),
        scoped: true,
        limits: SCOPED_LIMITS,
      }),
      lastUsed: 0,
    };
    scopedServices.set(userId, entry);
  }
  entry.lastUsed = Date.now();
  return entry.service;
};

setInterval(() => {
  const now = Date.now();
  for (const [userId, entry] of scopedServices) {
    if (now - entry.lastUsed > SCOPED_IDLE_MS) closeScoped(userId);
  }
}, 5 * 60 * 1000).unref();

const startStdio = async () => {
  await createMcpServer(service).connect(new StdioServerTransport());
};

// ---------------------------------------------------------------- 下载区
// 可选下载区；若经反向代理暴露，使用随机 token 做路径鉴权：
// 列表页 /downloads/<token>/，单文件 /downloads/<token>/f/<文件名>
const DOWNLOADS_DIR = process.env.DOCX_MCP_DOWNLOADS || path.join(ROOT, "data", "downloads");
const DL_TOKEN_FILE = path.join(ROOT, "data", "dl-token");
const MCP_TOKEN_FILE = path.join(ROOT, "data", "mcp-token");

// token 落盘持久化：重启后已配好的客户端/分享链接不失效；要轮换删文件重启即可
const loadToken = (file, bytes) => {
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, crypto.randomBytes(bytes).toString("hex"));
  }
  return fs.readFileSync(file, "utf8").trim();
};

// /mcp 无会话概念，一切能力（读写文档库、往磁盘写渲染产物）都在这一个端点上——
// 反代手滑或端口意外暴露时，鉴权是唯一防线，所以默认强制而非 opt-in
const loadMcpToken = () =>
  (process.env.DOCX_MCP_TOKEN || "").trim() || loadToken(MCP_TOKEN_FILE, 24);

const mcpAuthOk = (req, token) => {
  const got = req.headers.authorization || "";
  const want = `Bearer ${token}`;
  return got.length === want.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want));
};

const DL_MIME = {
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".zip": "application/zip",
  ".pdf": "application/pdf",
  ".png": "image/png",
};

const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const humanSize = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);

const dlListPage = (linkPrefix) => {
  fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
  const rows = fs.readdirSync(DOWNLOADS_DIR)
    .map((name) => ({ name, stat: fs.statSync(path.join(DOWNLOADS_DIR, name)) }))
    .filter((f) => f.stat.isFile())
    .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)
    .map(({ name, stat }) => {
      const href = `${linkPrefix}f/${encodeURIComponent(name)}`;
      const time = new Date(stat.mtimeMs).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
      return `<tr><td><a href="${href}" download>${escapeHtml(name)}</a></td><td>${humanSize(stat.size)}</td><td>${time}</td></tr>`;
    });
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>docx-mcp 下载区</title><style>
body{font-family:system-ui,"Microsoft YaHei",sans-serif;max-width:720px;margin:2rem auto;padding:0 1rem;color:#222}
table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:.5rem .6rem;border-bottom:1px solid #ddd;font-size:.95rem}
th{color:#666;font-weight:600}a{color:#0b62c4;text-decoration:none;word-break:break-all}a:hover{text-decoration:underline}
.empty{color:#999;padding:2rem 0;text-align:center}
@media(prefers-color-scheme:dark){body{background:#1b1b1f;color:#ddd}th{color:#999}th,td{border-color:#333}a{color:#6cb2ff}}
</style></head><body><h2>docx-mcp 下载区</h2>
${rows.length ? `<table><tr><th>文件</th><th>大小</th><th>更新时间</th></tr>${rows.join("")}</table>` : `<p class="empty">目前没有可下载的文件</p>`}
</body></html>`;
};

// 下载区一律 no-store：token 保护的私有内容不能进 CDN 边缘缓存——
// 缓存期内知道 URL 就能取（token 轮换也失效不了缓存），且文件更新后
// 经过 CDN 时仍可能拿到旧版或绕过 token 轮换。
const DL_NO_CACHE = { "Cache-Control": "no-store, private" };

const handleDownloads = (pathname, token, res) => {
  const seg = pathname.split("/").filter(Boolean); // ["downloads", token, ...]
  if (seg[1] !== token) {
    // 错误 token 一律 404，不区分「路径不存在」和「token 不对」，避免探测
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", ...DL_NO_CACHE });
    return res.end("not found");
  }
  if (seg.length === 2) {
    // 无尾斜杠时相对链接会解析错基准，链接前缀补上 token 段兜住两种写法
    const linkPrefix = pathname.endsWith("/") ? "" : `${token}/`;
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", ...DL_NO_CACHE });
    return res.end(dlListPage(linkPrefix));
  }
  if (seg.length === 4 && seg[2] === "f") {
    const name = decodeURIComponent(seg[3]);
    const full = path.join(DOWNLOADS_DIR, name);
    // 目录穿越防线：文件名不含分隔符，且解析后仍落在下载目录内
    if (/[/\\]|\.\./.test(name) || !full.startsWith(DOWNLOADS_DIR + path.sep) || !fs.existsSync(full)) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", ...DL_NO_CACHE });
      return res.end("not found");
    }
    const stat = fs.statSync(full);
    res.writeHead(200, {
      "Content-Type": DL_MIME[path.extname(name).toLowerCase()] || "application/octet-stream",
      "Content-Length": stat.size,
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
      ...DL_NO_CACHE,
    });
    return fs.createReadStream(full).pipe(res);
  }
  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", ...DL_NO_CACHE });
  res.end("not found");
};

const startHttp = () => {
  const host = process.env.DOCX_MCP_HOST || "127.0.0.1";
  const port = Number(process.env.DOCX_MCP_PORT) || 8765;
  const dlToken = loadToken(DL_TOKEN_FILE, 12);
  const authMode = (process.env.DOCX_MCP_AUTH || "token").trim().toLowerCase();
  if (!["token", "oauth"].includes(authMode)) {
    throw new Error("DOCX_MCP_AUTH 仅支持 token 或 oauth");
  }

  const rpcError = (res, status, message) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }));
  };

  const app = express();
  if (process.env.DOCX_MCP_TRUST_PROXY) {
    const value = process.env.DOCX_MCP_TRUST_PROXY;
    app.set("trust proxy", /^\d+$/.test(value) ? Number(value) : value === "true");
  }
  app.disable("x-powered-by");

  app.get(["/health", "/readyz"], (_req, res) => {
    res.set("Cache-Control", "no-store");
    res.json({ status: "ok", service: "inkpaw", version: "0.1.0", auth: authMode });
  });

  let authMiddleware;
  let scopeUserForRequest;
  let publicMcpUrl;
  if (authMode === "oauth") {
    const configured = (process.env.DOCX_MCP_PUBLIC_URL || "").trim();
    if (!configured) throw new Error("OAuth 模式必须设置 DOCX_MCP_PUBLIC_URL=https://稳定域名/mcp");
    publicMcpUrl = new URL(configured);
    if (publicMcpUrl.pathname !== "/mcp" || publicMcpUrl.search || publicMcpUrl.hash) {
      throw new Error("DOCX_MCP_PUBLIC_URL 必须是无查询参数的完整 /mcp 地址");
    }
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(publicMcpUrl.hostname);
    if (publicMcpUrl.protocol !== "https:" && !loopback) {
      throw new Error("OAuth 公网地址必须使用 HTTPS");
    }
    const ownerPassword = process.env.DOCX_MCP_OAUTH_PASSWORD || "";
    const provider = new InkPawOAuthProvider({
      dbPath: process.env.DOCX_MCP_OAUTH_DB || path.join(ROOT, "data", "oauth.db"),
      resourceUrl: publicMcpUrl,
      ownerPassword,
    });
    const issuerUrl = new URL(`${publicMcpUrl.origin}/`);
    app.use(mcpAuthRouter({
      provider,
      issuerUrl,
      baseUrl: issuerUrl,
      resourceServerUrl: publicMcpUrl,
      scopesSupported: ["mcp:tools"],
      resourceName: "InkPaw document tools",
      serviceDocumentationUrl: new URL("https://github.com/syouro/InkPaw"),
    }));
    app.use("/oauth/authorizations", createOAuthManagementRouter(provider, {
      secureCookies: publicMcpUrl.protocol === "https:",
    }));
    authMiddleware = requireBearerAuth({
      verifier: provider,
      requiredScopes: ["mcp:tools"],
      resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(publicMcpUrl),
    });
    scopeUserForRequest = (req) => req.auth && req.auth.extra && req.auth.extra.userId;
  } else {
    const mcpToken = loadMcpToken();
    authMiddleware = (req, res, next) => {
      if (!mcpAuthOk(req, mcpToken)) {
        return rpcError(res, 401, "需要鉴权：Authorization: Bearer <token>（token 见服务端 data/mcp-token）");
      }
      next();
    };
    scopeUserForRequest = (req) => (req.headers["x-docx-scope-user"] || "").trim();
  }

  app.get(/^\/downloads\//, (req, res) => {
    try {
      return handleDownloads(req.path, dlToken, res);
    } catch (e) {
      if (!res.headersSent) res.status(500).type("text");
      return res.end(`内部错误: ${e.message}`);
    }
  });

  app.post("/mcp", authMiddleware, express.json({ limit: "10mb" }), async (req, res) => {
    const scopeUser = scopeUserForRequest(req);
    if (!scopeUser || !UUID_RE.test(scopeUser)) {
      if (authMode === "oauth") return rpcError(res, 401, "OAuth token 缺少有效用户身份");
      if (scopeUser) return rpcError(res, 400, "X-Docx-Scope-User 必须是 UUID");
    }
    try {
      const server = createMcpServer(scopeUser ? scopedServiceFor(scopeUser) : service);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,   // 无状态
        enableJsonResponse: true,        // 纯 JSON 响应，不开 SSE
      });
      res.on("close", () => { transport.close(); server.close(); });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      if (!res.headersSent) rpcError(res, 500, `内部错误: ${e.message}`);
    }
  });

  app.all("/mcp", (_req, res) => rpcError(res, 405, "仅支持 POST（stateless streamable HTTP）"));
  app.use((err, _req, res, _next) => {
    if (err instanceof SyntaxError) return rpcError(res, 400, "请求体必须是合法 JSON");
    console.error("[docx-mcp] HTTP 请求失败:", err);
    return rpcError(res, 500, "内部错误");
  });
  app.use((_req, res) => rpcError(res, 404, "端点是 /mcp"));

  const tlsCert = process.env.DOCX_MCP_TLS_CERT;
  const tlsKey = process.env.DOCX_MCP_TLS_KEY;
  if (!!tlsCert !== !!tlsKey) throw new Error("DOCX_MCP_TLS_CERT 与 DOCX_MCP_TLS_KEY 必须同时设置");
  const httpServer = tlsCert
    ? https.createServer({ cert: fs.readFileSync(tlsCert), key: fs.readFileSync(tlsKey) }, app)
    : http.createServer(app);

  httpServer.listen(port, host, () => {
    // stdio 模式 stdout 是协议通道，日志统一走 stderr
    const localScheme = tlsCert ? "https" : "http";
    const advertised = publicMcpUrl ? publicMcpUrl.href : `${localScheme}://${host}:${port}/mcp`;
    console.error(`[docx-mcp] Streamable HTTP 已启动: ${advertised}（${authMode === "oauth" ? "OAuth 2.1 + PKCE" : `Bearer token：${process.env.DOCX_MCP_TOKEN ? "DOCX_MCP_TOKEN" : MCP_TOKEN_FILE}`}）`);
    console.error(`[docx-mcp] 健康检查: ${publicMcpUrl ? publicMcpUrl.origin : `${localScheme}://${host}:${port}`}/health`);
    console.error(`[docx-mcp] 下载区: ${localScheme}://${host}:${port}/downloads/${dlToken}/ （目录 ${DOWNLOADS_DIR}）`);
  });
};

if (process.argv.includes("--http")) startHttp();
else startStdio();
