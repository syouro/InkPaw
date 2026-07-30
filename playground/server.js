"use strict";
// InkPaw Playground：本地网页版文档 Agent 服务端。
// BYOK：模型 baseURL/apiKey/model 由前端每次请求带来，仅内存转发——不落库、不写日志。
// 身份：匿名恢复码；除创建身份外所有 /api/* 走
// Authorization: Bearer <恢复码>，服务端解析出 userId 再做一切归属操作。
// 推荐启动：npm run playground（同时拉起核心 MCP 与本服务）。

const path = require("path");
const fs = require("fs");
const express = require("express");
const { McpBridge, BridgePool } = require("./mcp-bridge");
const { runAgentTurn } = require("./agent");
const { Store } = require("./store");

const PORT = process.env.INKPAW_PLAYGROUND_PORT || 8766;
const MCP_URL = process.env.DOCX_MCP_URL || "http://127.0.0.1:8765/mcp";
const OUTPUT_DIR = path.join(__dirname, "..", "data", "output");
const USERS_ROOT = path.join(__dirname, "..", "data", "users");
const SYSTEM_PROMPT = fs.readFileSync(path.join(__dirname, "system-prompt.md"), "utf8");
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// /mcp 的鉴权 token：一键启动时由父进程注入；单独启动时也可读取核心服务生成的文件。
const loadMcpToken = () => {
  if (process.env.DOCX_MCP_TOKEN) return process.env.DOCX_MCP_TOKEN.trim();
  try {
    return fs.readFileSync(path.join(__dirname, "..", "data", "mcp-token"), "utf8").trim();
  } catch {
    return null;
  }
};

const sseWrite = (res, ev) => res.write(`data: ${JSON.stringify(ev)}\n\n`);

// 渲染并发闸：LibreOffice 转换吃 CPU，并发渲染排队而不是立即拒绝。
let renderSlots = 2;
const renderQueue = [];
const acquireRender = () => new Promise((r) => (renderSlots > 0 ? (renderSlots--, r()) : renderQueue.push(r)));
const releaseRender = () => { const next = renderQueue.shift(); if (next) next(); else renderSlots++; };

// ── 文档产物路径 ───────────────────────────────────────────────────
// PDF 有两个来源：pdf:true 的正式产物（output 根）和预览管线的中转 PDF（-preview 目录，
// 每次渲染必新鲜）。根目录那份只在显式 pdf:true 时重写——改完只 preview 重渲染会留下旧版，
// 所以取两者中 mtime 最新的，保证下载永远对应最后一次渲染。
function freshPdfPath(outputDir, docId) {
  const candidates = [
    path.join(outputDir, `${docId}.pdf`),
    path.join(outputDir, `${docId}-preview`, `${docId}.pdf`),
  ].filter((p) => fs.existsSync(p));
  if (!candidates.length) return null;
  return candidates.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
}

function docInfo(outputDir, docId) {
  const previewDir = path.join(outputDir, `${docId}-preview`);
  let pages = [];
  if (fs.existsSync(previewDir)) {
    // docx2png（pdftoppm）产物命名 <docId>-N.png；目录里还有中转 PDF，忽略
    pages = fs.readdirSync(previewDir)
      .filter((f) => /-(\d+)\.png$/.test(f))
      .sort((a, b) => parseInt(a.match(/-(\d+)\.png$/)[1], 10) - parseInt(b.match(/-(\d+)\.png$/)[1], 10))
      .map((f) => `/api/docs/${docId}/preview/${f}`);
  }
  return {
    docId,
    pages,
    docx: fs.existsSync(path.join(outputDir, `${docId}.docx`)) ? `/api/docs/${docId}/inkpaw.docx` : null,
    pdf: freshPdfPath(outputDir, docId) ? `/api/docs/${docId}/inkpaw.pdf` : null,
  };
}

// ── 应用组装（可注入 store/bridgePool 供测试）──────────────────────
function createApp({ store, bridgePool, systemPrompt = SYSTEM_PROMPT, usersRoot = USERS_ROOT }) {
  const app = express();
  // 产物按身份分目录：路径由鉴权 userId + docId
  // 拼出，别人的 docId 拼不出存在的路径——归属校验几乎免费，但 UUID 格式校验不能省
  const userOutputDir = (userId) => path.join(usersRoot, userId, "output");

  app.use(express.json({ limit: "8mb" })); // base64 图片走 def 时消息体可能不小
  app.use(express.static(path.join(__dirname, "public")));
  // 前端 markdown 渲染直接用仓里 markdown-it 的浏览器包，不复制进 public
  app.use("/vendor", express.static(path.join(__dirname, "..", "node_modules", "markdown-it", "dist")));

  // ── 身份 ────────────────────────────────────────────────────────
  // 恢复码是 bearer secret：只在创建响应里出现一次，不进 URL/日志/DB 明文。
  // 创建端点仅面向本地体验。若对公网开放，必须在入口增加限流和滥用防护。
  app.post("/api/identity", (req, res) => {
    const { recoveryCode, createdAt } = store.createIdentity();
    res.json({ recoveryCode, createdAt });
  });

  // 鉴权中间件：除创建身份外的全部 /api/* 都要 Authorization: Bearer <恢复码>。
  // userId 只能从这里解析出来，不接受请求体/查询参数自报
  app.use("/api", (req, res, next) => {
    const m = /^Bearer (\S+)$/.exec(req.headers.authorization || "");
    const auth = m ? store.verifyIdentity(m[1]) : null;
    if (!auth) return res.status(401).json({ error: "需要有效身份（Authorization: Bearer <恢复码>）" });
    req.auth = auth;
    next();
  });

  app.get("/api/identity", (req, res) => {
    res.json({ ok: true, createdAt: req.auth.createdAt });
  });

  // ── 聊天（SSE over POST）──────────────────────────────────────────
  app.post("/api/chat", async (req, res) => {
    const { sessionId, message, llm, selectedTemplateId } = req.body || {};
    const { userId } = req.auth;
    if (typeof message !== "string" || !message.trim()) {
      return res.status(400).json({ error: "缺少 message" });
    }
    if (!llm || !llm.baseURL || !llm.apiKey || !llm.model) {
      return res.status(400).json({ error: "缺少模型配置（baseURL/apiKey/model），请先在设置里填写" });
    }

    // 归属校验进查询本身：别人的 sessionId 一律当不存在（404 不泄露存在性）
    let session = sessionId ? store.getSession(sessionId, userId) : null;
    if (sessionId && !session) return res.status(404).json({ error: "会话不存在" });

    // 用户作用域桥：连接失败要在 SSE 开始前报出去（还能回 JSON 状态码）
    let bridge;
    try {
      bridge = await bridgePool.for(userId);
    } catch (e) {
      return res.status(502).json({ error: `文档服务连接失败：${e.message}` });
    }

    // 选定模板是可信上下文（§7.3）：前端只提交 templateId，这里在该用户作用域里
    // 验证归属后把模板名/槽位注入当轮系统提示——客户端指定不了服务器路径
    let turnPrompt = systemPrompt;
    if (selectedTemplateId) {
      const list = await bridge.callTool("list_templates", {});
      const tpl = !list.isError
        && (JSON.parse(list.text).templates || []).find((x) => x.templateId === selectedTemplateId);
      if (!tpl) return res.status(404).json({ error: "所选模板不存在" });
      turnPrompt += `\n\n## 当前会话选定模板\n用户已在界面上选定模板「${tpl.name}」（templateId: ${tpl.templateId}），槽位：${tpl.slots.join("、") || "（模板无占位符）"}。用户要求产出该版式文档时，直接用 create_document_from_template 基于此 templateId 建档填槽（改槽用 update_template_slots），不要走自由 def 流，也不要再 register_template。`;
    }

    if (!session) {
      const created = store.createSession(userId, message.trim().slice(0, 24));
      session = store.getSession(created.id, userId);
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    });
    sseWrite(res, { type: "session", sessionId: session.id, title: session.title });

    // 注意不能挂 req 的 close——body 读完就触发；res 的 close 且未正常结束才是客户端断开
    const abort = new AbortController();
    res.on("close", () => { if (!res.writableEnded) abort.abort(); });

    const messages = store.getMessages(session.id);
    messages.push({ role: "user", content: message });
    const persistFrom = messages.length - 1;

    // 拦截 render_document：强制 preview，产物信息推给前端；渲染过并发闸
    const callTool = async (name, args) => {
      if (name !== "render_document") return bridge.callTool(name, args);
      args = { ...args, preview: true };
      await acquireRender();
      let result;
      try {
        result = await bridge.callTool(name, args);
      } finally {
        releaseRender();
      }
      if (!result.isError && args.docId && UUID_RE.test(args.docId)) {
        store.touchSession(session.id, { docId: args.docId });
        sseWrite(res, { type: "preview", ...docInfo(userOutputDir(userId), args.docId) });
      }
      return result;
    };

    try {
      await runAgentTurn({
        llm: {
          baseURL: String(llm.baseURL),
          apiKey: String(llm.apiKey),
          model: String(llm.model),
          thinking: !!llm.thinking,
        },
        systemPrompt: turnPrompt,
        messages,
        tools: bridge.openaiTools,
        callTool,
        onEvent: (ev) => sseWrite(res, ev),
        signal: abort.signal,
      });
      for (let i = persistFrom; i < messages.length; i++) store.appendMessage(session.id, messages[i]);
      store.touchSession(session.id);
      sseWrite(res, { type: "done" });
    } catch (e) {
      if (!abort.signal.aborted) {
        // 出错的轮次不入库（半截的 tool_calls 回灌会 400），用户重发即重来
        sseWrite(res, { type: "error", message: e.message || "模型调用失败" });
      }
    }
    res.end();
  });

  // ── 会话管理 ──────────────────────────────────────────────────────
  app.get("/api/sessions", (req, res) => {
    res.json(store.listSessions(req.auth.userId).map((s) => ({
      id: s.id, title: s.title, docId: s.doc_id, updatedAt: s.updated_at,
    })));
  });

  app.get("/api/sessions/:id/messages", (req, res) => {
    const session = store.getSession(req.params.id, req.auth.userId);
    if (!session) return res.status(404).json({ error: "会话不存在" });
    res.json({
      docId: session.doc_id,
      docInfo: session.doc_id ? docInfo(userOutputDir(req.auth.userId), session.doc_id) : null,
      messages: store.getMessages(session.id).map(displayMessage).filter(Boolean),
    });
  });

  app.delete("/api/sessions/:id", (req, res) => {
    const session = store.getSession(req.params.id, req.auth.userId);
    if (!session) return res.status(404).json({ error: "会话不存在" });
    // 删除会话不联动删除文档。
    store.deleteSession(session.id);
    res.json({ ok: true });
  });

  // ── 模板管理 ────────────────────────────────────────────────────
  // 全走该用户的作用域桥调 MCP 工具：归属天然限定在自己的模板库；
  // 客户端只能传 base64，不存在服务器路径入口
  const userToolCall = async (req, res, name, args) => {
    let bridge;
    try {
      bridge = await bridgePool.for(req.auth.userId);
    } catch (e) {
      res.status(502).json({ error: `文档服务连接失败：${e.message}` });
      return null;
    }
    return bridge.callTool(name, args);
  };

  const TEMPLATE_LIMIT_BYTES = 5 * 1024 * 1024;

  app.post("/api/templates", async (req, res) => {
    const { name, base64 } = req.body || {};
    if (typeof base64 !== "string" || !base64) {
      return res.status(400).json({ error: "缺少 base64（浏览器读取模板文件后上传）" });
    }
    // 不只信 Content-Length：按解码后的原始字节再限一次 5MB
    const rawBytes = Math.floor(base64.length * 3 / 4);
    if (rawBytes > TEMPLATE_LIMIT_BYTES) {
      return res.status(413).json({ error: "模板超过 5MB 上限" });
    }
    const result = await userToolCall(req, res, "register_template", {
      ...(typeof name === "string" && name.trim() ? { name: name.trim().slice(0, 80) } : {}),
      base64,
    });
    if (!result) return;
    if (result.isError) return res.status(400).json({ error: result.text });
    res.json(JSON.parse(result.text)); // { templateId, name, slots, warnings }
  });

  app.get("/api/templates", async (req, res) => {
    const result = await userToolCall(req, res, "list_templates", {});
    if (!result) return;
    if (result.isError) return res.status(500).json({ error: result.text });
    res.json(JSON.parse(result.text)); // { templates: [...] }
  });

  app.delete("/api/templates/:templateId", async (req, res) => {
    const result = await userToolCall(req, res, "delete_template", { templateId: req.params.templateId });
    if (!result) return;
    if (result.isError) return res.status(404).json({ error: "模板不存在" });
    res.json({ ok: true });
  });

  // ── 文档产物：预览图 / 下载 ────────────────────────────────────────
  // no-store：同名预览和产物会在每次渲染时覆盖，客户端不得缓存旧版本。
  app.get("/api/docs/:docId/preview/:file", (req, res) => {
    const { docId, file } = req.params;
    if (!UUID_RE.test(docId) || !/^[0-9a-f-]{36}-\d+\.png$/i.test(file)) return res.status(404).end();
    const full = path.join(userOutputDir(req.auth.userId), `${docId}-preview`, file);
    if (!fs.existsSync(full)) return res.status(404).end(); // 跨用户/不存在统一 404
    res.set("Cache-Control", "no-store");
    res.sendFile(full);
  });

  // 可编辑草稿视图（docs/editable-preview.md §3）。走 MCP 的 get_draft_html——
  // 编号与引用解析必须和 DOCX 出自同一条 transform，前端自己拼会对不上。
  // 作用域由 bridgePool 按 userId 隔离，别人的 docId 在自己的库里查不到。
  app.get("/api/docs/:docId/draft", async (req, res) => {
    const { docId } = req.params;
    if (!UUID_RE.test(docId)) return res.status(404).end();
    try {
      const bridge = await bridgePool.for(req.auth.userId);
      const { text, isError } = await bridge.callTool("get_draft_html", { docId }, { truncate: false });
      if (isError) return res.status(404).json({ error: text });
      res.set("Cache-Control", "no-store");
      res.json(JSON.parse(text));
    } catch (e) {
      res.status(500).json({ error: e.message || "草稿视图生成失败" });
    }
  });

  // 草稿视图写回：一次一个叶子。走 MCP update_node_value → 既有 update 路径 + validator，
  // 不新开平行写入口（docs/editable-preview.md §3.4）。
  app.post("/api/docs/:docId/draft", async (req, res) => {
    const { docId } = req.params;
    if (!UUID_RE.test(docId)) return res.status(404).end();
    const { id, path: leafPath, value } = req.body || {};
    if (typeof id !== "string" || !Array.isArray(leafPath) || typeof value !== "string") {
      return res.status(400).json({ error: "需要 { id, path: [...], value }" });
    }
    try {
      const bridge = await bridgePool.for(req.auth.userId);
      const { text, isError } = await bridge.callTool("update_node_value", { docId, id, path: leafPath, value });
      if (isError) return res.status(400).json({ error: text });
      res.json(JSON.parse(text));
    } catch (e) {
      res.status(500).json({ error: e.message || "写回失败" });
    }
  });

  // 页眉页脚配置（docs/editable-preview.md §3.5）：读写都走 MCP 的类型化通道。
  app.get("/api/docs/:docId/config", async (req, res) => {
    const { docId } = req.params;
    if (!UUID_RE.test(docId)) return res.status(404).end();
    try {
      const bridge = await bridgePool.for(req.auth.userId);
      const { text, isError } = await bridge.callTool("get_doc_config", { docId }, { truncate: false });
      if (isError) return res.status(404).json({ error: text });
      res.set("Cache-Control", "no-store");
      res.json(JSON.parse(text));
    } catch (e) {
      res.status(500).json({ error: e.message || "读取配置失败" });
    }
  });

  app.post("/api/docs/:docId/config", async (req, res) => {
    const { docId } = req.params;
    if (!UUID_RE.test(docId)) return res.status(404).end();
    const { sectionId, set, clear } = req.body || {};
    if (set !== undefined && (typeof set !== "object" || set === null || Array.isArray(set))) {
      return res.status(400).json({ error: "set 必须是对象" });
    }
    if (clear !== undefined && !Array.isArray(clear)) {
      return res.status(400).json({ error: "clear 必须是数组" });
    }
    try {
      const bridge = await bridgePool.for(req.auth.userId);
      const args = { docId, ...(sectionId ? { sectionId } : {}), ...(set ? { set } : {}), ...(clear ? { clear } : {}) };
      const { text, isError } = await bridge.callTool("update_doc_config", args);
      if (isError) return res.status(400).json({ error: text });
      res.json(JSON.parse(text));
    } catch (e) {
      res.status(500).json({ error: e.message || "配置写入失败" });
    }
  });

  // 草稿视图块级结构编辑（docs/editable-preview.md §4 P4）：转调 MCP 窄口。
  app.post("/api/docs/:docId/structure", async (req, res) => {
    const { docId } = req.params;
    if (!UUID_RE.test(docId)) return res.status(404).end();
    const { op, anchorId, text } = req.body || {};
    if (typeof op !== "string" || typeof anchorId !== "string") {
      return res.status(400).json({ error: "需要 { op, anchorId }" });
    }
    if (text !== undefined && typeof text !== "string") {
      return res.status(400).json({ error: "text 必须是字符串" });
    }
    try {
      const bridge = await bridgePool.for(req.auth.userId);
      const args = { docId, op, anchorId, ...(text !== undefined ? { text } : {}) };
      const { text: out, isError } = await bridge.callTool("update_draft_structure", args);
      if (isError) return res.status(400).json({ error: out });
      res.json(JSON.parse(out));
    } catch (e) {
      res.status(500).json({ error: e.message || "结构编辑失败" });
    }
  });

  // 草稿视图的「重新渲染」：用户在草稿里改完文字，版式视图的 PNG 就过期了。
  // 不由每次失焦自动触发——渲染要过 LibreOffice（约 5-10 秒），得由用户显式点。
  // 走和 /api/chat 里同一道并发闸，避免界面按钮绕过排队把 CPU 打满。
  app.post("/api/docs/:docId/render", async (req, res) => {
    const { docId } = req.params;
    if (!UUID_RE.test(docId)) return res.status(404).end();
    try {
      const bridge = await bridgePool.for(req.auth.userId);
      await acquireRender();
      let result;
      try {
        result = await bridge.callTool("render_document", { docId, preview: true });
      } finally {
        releaseRender();
      }
      if (result.isError) return res.status(400).json({ error: result.text });
      const parsed = JSON.parse(result.text);
      if (parsed.ok === false) return res.status(400).json({ error: parsed.message, issues: parsed.issues });
      res.json({ ok: true, warnings: parsed.warnings || [], ...docInfo(userOutputDir(req.auth.userId), docId) });
    } catch (e) {
      res.status(500).json({ error: e.message || "渲染失败" });
    }
  });

  app.get("/api/docs/:docId/inkpaw.:ext", (req, res) => {
    const { docId, ext } = req.params;
    if (!UUID_RE.test(docId) || !["docx", "pdf"].includes(ext)) return res.status(404).end();
    const outputDir = userOutputDir(req.auth.userId);
    const file = ext === "pdf" ? freshPdfPath(outputDir, docId) : path.join(outputDir, `${docId}.docx`);
    if (!file || !fs.existsSync(file)) return res.status(404).end();
    res.set("Cache-Control", "no-store");
    res.download(file, `inkpaw-${docId.slice(0, 8)}.${ext}`);
  });

  return app;
}

// ── 预览图定期清理 ─────────────────────────────────────────────────
// 7 天没动的 *-preview 目录删掉（docx 保留，docId 在 DB 随时可重渲）。
// 扫描范围包含各身份作用域的 data/users/*/output/。
const PREVIEW_TTL_MS = 7 * 24 * 3600 * 1000;
function cleanupPreviews() {
  const roots = [OUTPUT_DIR];
  try {
    for (const u of fs.readdirSync(USERS_ROOT)) roots.push(path.join(USERS_ROOT, u, "output"));
  } catch { /* 还没有用户目录 */ }
  for (const root of roots) {
    let dirs;
    try { dirs = fs.readdirSync(root).filter((f) => f.endsWith("-preview")); } catch { continue; }
    for (const d of dirs) {
      const p = path.join(root, d);
      try {
        if (Date.now() - fs.statSync(p).mtimeMs > PREVIEW_TTL_MS) fs.rmSync(p, { recursive: true, force: true });
      } catch { /* 竞态忽略，下轮再清 */ }
    }
  }
}

// ── 启动 ─────────────────────────────────────────────────────────
async function start() {
  const token = loadMcpToken();
  // 探针连接只为启动即失败 + 报工具数，不带作用域头（只 listTools，不落任何数据）
  const probe = new McpBridge(MCP_URL, token);
  const n = await probe.connect();
  await probe.close();
  const app = createApp({ store: new Store(), bridgePool: new BridgePool(MCP_URL, token) });
  setInterval(cleanupPreviews, 6 * 3600 * 1000).unref();
  cleanupPreviews();
  app.listen(PORT, "127.0.0.1", () => {
    console.log(`[inkpaw-playground] http://127.0.0.1:${PORT}（InkPaw MCP tools: ${n}）`);
  });
}

if (require.main === module) {
  start().catch((e) => {
    console.error("[inkpaw-playground] 启动失败：", e.message);
    process.exit(1);
  });
}

// 历史消息转前端展示形（工具轮次折叠为动作条；内部 role:tool 消息不展示）
function displayMessage(m) {
  if (m.role === "user") return { role: "user", content: m.content };
  if (m.role === "assistant") {
    return {
      role: "assistant",
      content: m.content && m.content.trim() ? m.content : null,
      toolCalls: (m.tool_calls || []).map((t) => t.function.name),
    };
  }
  return null;
}

module.exports = { createApp, cleanupPreviews };
