"use strict";
// Playground 层测试：身份/会话存储 + HTTP API 鉴权面 + MCP 桥连真实 HTTP 服务的集成。
// 桥不 mock——起一个临时 InkPaw MCP 子进程，走与外部客户端相同的协议路径。

const test = require("node:test");
const assert = require("node:assert");
const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Database = require("better-sqlite3");

const { Store } = require("../playground/store");
const { McpBridge } = require("../playground/mcp-bridge");
const { createApp } = require("../playground/server");
const {
  isOfficialDeepSeekEndpoint,
  thinkingParams,
  buildAssistantMessage,
} = require("../playground/agent");

const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");

test("DeepSeek：识别官方 endpoint，不把普通 OpenAI 兼容地址误判为 DeepSeek", () => {
  assert.equal(isOfficialDeepSeekEndpoint("https://api.deepseek.com"), true);
  assert.equal(isOfficialDeepSeekEndpoint("https://api.deepseek.com/beta"), true);
  assert.equal(isOfficialDeepSeekEndpoint("https://example.com/v1"), false);
  assert.equal(isOfficialDeepSeekEndpoint("not-a-url"), false);
});

test("DeepSeek：官方 endpoint 显式发送 thinking enabled/disabled，通用端点保持 opt-in", () => {
  assert.deepEqual(
    thinkingParams({ baseURL: "https://api.deepseek.com", thinking: true }),
    { thinking: { type: "enabled" } },
  );
  assert.deepEqual(
    thinkingParams({ baseURL: "https://api.deepseek.com", thinking: false }),
    { thinking: { type: "disabled" } },
  );
  assert.deepEqual(thinkingParams({ baseURL: "https://example.com/v1", thinking: false }), {});
  assert.deepEqual(
    thinkingParams({ baseURL: "https://example.com/v1", thinking: true }),
    { thinking: { type: "enabled" } },
  );
});

test("DeepSeek：工具调用 assistant 消息保留 reasoning_content 供下一轮回传", () => {
  const toolCalls = [{ id: "call_1", name: "render_document", args: '{"docId":"d1"}' }];
  const message = buildAssistantMessage({
    content: "",
    reasoning: "需要先渲染文档。",
    toolCalls,
    llm: { baseURL: "https://api.deepseek.com", thinking: false },
  });
  assert.equal(message.reasoning_content, "需要先渲染文档。");
  assert.equal(message.tool_calls[0].function.name, "render_document");
  assert.equal(message.tool_calls[0].function.arguments, '{"docId":"d1"}');

  const generic = buildAssistantMessage({
    content: "",
    reasoning: "provider-private reasoning",
    toolCalls,
    llm: { baseURL: "https://example.com/v1", thinking: false },
  });
  assert.equal("reasoning_content" in generic, false);
});

const makeStore = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "playground-store-"));
  const store = new Store(path.join(dir, "t.db"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { store, dir };
};

// ── Store：身份 ───────────────────────────────────────────────────

test("Store：身份创建/验证——DB 只存哈希不存明文，未知码返回 null", (t) => {
  const { store, dir } = makeStore(t);

  const { userId, recoveryCode } = store.createIdentity();
  assert.match(recoveryCode, /^ink_[A-Za-z0-9_-]{40,}$/);

  // DB 里只有哈希：任何列都不含恢复码明文
  const rows = new Database(path.join(dir, "t.db"), { readonly: true })
    .prepare("SELECT * FROM identities").all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].recovery_hash, sha256(recoveryCode));
  assert.ok(!JSON.stringify(rows).includes(recoveryCode));

  assert.equal(store.verifyIdentity(recoveryCode).userId, userId);
  assert.equal(store.verifyIdentity("ink_wrong"), null);
  assert.equal(store.verifyIdentity(""), null);
  assert.equal(store.verifyIdentity(null), null);
});

test("Store：会话按 userId 归属——别人的 id 查不到，消息 JSON 原样往返", (t) => {
  const { store } = makeStore(t);
  const a = store.createIdentity();
  const b = store.createIdentity();

  const { id } = store.createSession(a.userId, "第一个会话");
  assert.equal(store.getSession(id, a.userId).title, "第一个会话");
  assert.equal(store.getSession(id, b.userId), undefined); // 跨用户即不存在

  // 消息按插入序返回，OpenAI 格式字段（tool_calls 等嵌套结构）原样往返
  const msgs = [
    { role: "user", content: "你好" },
    { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "create_document", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "c1", content: "ok" },
  ];
  for (const m of msgs) store.appendMessage(id, m);
  assert.deepEqual(store.getMessages(id), msgs);

  store.touchSession(id, { docId: "d0c1d0c1-0000-4000-8000-000000000000" });
  assert.equal(store.getSession(id, a.userId).doc_id, "d0c1d0c1-0000-4000-8000-000000000000");

  store.createSession(b.userId, "b 的会话");
  assert.equal(store.listSessions(a.userId).length, 1);
  assert.equal(store.listSessions(b.userId).length, 1);
  assert.equal(store.listSessions(b.userId)[0].title, "b 的会话");

  store.deleteSession(id);
  assert.equal(store.getSession(id, a.userId), undefined);
  assert.deepEqual(store.getMessages(id), []);
});

test("Store：旧 clientId 库迁移——UUID 客户端当 legacy 恢复码，非 UUID 不发码，幂等", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "playground-migrate-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const dbPath = path.join(dir, "t.db");

  // 手工造旧 schema（上线前的 client_id 结构）
  const old = new Database(dbPath);
  old.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, client_id TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '新对话', doc_id TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL,
      json TEXT NOT NULL, created_at INTEGER NOT NULL);
  `);
  const legacyClient = crypto.randomUUID();
  old.prepare("INSERT INTO sessions VALUES ('s1', ?, '旧会话', NULL, 1, 1)").run(legacyClient);
  old.prepare("INSERT INTO sessions VALUES ('s2', 'hand-edited-junk', '异常会话', NULL, 1, 1)").run();
  old.prepare("INSERT INTO messages (session_id, json, created_at) VALUES ('s1', '{\"role\":\"user\",\"content\":\"hi\"}', 1)").run();
  old.close();

  const store = new Store(dbPath);
  // UUID clientId 本身就是 legacy 恢复码：能验证，且找回自己的会话
  const auth = store.verifyIdentity(legacyClient);
  assert.ok(auth, "legacy clientId 应可当恢复码验证");
  const sessions = store.listSessions(auth.userId);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].title, "旧会话");
  assert.deepEqual(store.getMessages("s1"), [{ role: "user", content: "hi" }]);

  // 非 UUID 的异常 clientId：不发 legacy 恢复码（哈希不可反查=管理员作用域）
  assert.equal(store.verifyIdentity("hand-edited-junk"), null);

  // 幂等：重开不重复建身份
  const before = new Database(dbPath, { readonly: true }).prepare("SELECT COUNT(*) n FROM identities").get().n;
  new Store(dbPath);
  const after = new Database(dbPath, { readonly: true }).prepare("SELECT COUNT(*) n FROM identities").get().n;
  assert.equal(after, before);
  assert.equal(before, 2);

  // 回归：迁移后的库必须能新建会话——老 client_id 列带
  // NOT NULL，迁移若只加列不重建表，这里就撞约束
  const { id: fresh } = store.createSession(auth.userId, "迁移后新会话");
  assert.equal(store.getSession(fresh, auth.userId).title, "迁移后新会话");
  const migratedCols = new Database(dbPath, { readonly: true })
    .prepare("SELECT name FROM pragma_table_info('sessions')").all().map((c) => c.name);
  assert.ok(!migratedCols.includes("client_id"), "client_id 列应在迁移中被重建掉");
});

test("Store：半迁移库（旧版只加列没重建表）重入——复用已有身份并完成重建", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "playground-halfmig-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const dbPath = path.join(dir, "t.db");

  // 构造半迁移状态：user_id 已填、identities 已建，但 client_id NOT NULL 还在。
  const old = new Database(dbPath);
  old.exec(`
    CREATE TABLE identities (
      user_id TEXT PRIMARY KEY, recovery_hash TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL);
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, client_id TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '新对话', doc_id TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, user_id TEXT);
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL,
      json TEXT NOT NULL, created_at INTEGER NOT NULL);
  `);
  const clientId = crypto.randomUUID();
  const userId = crypto.randomUUID();
  old.prepare("INSERT INTO identities VALUES (?, ?, 1)").run(userId, sha256(clientId));
  old.prepare("INSERT INTO sessions VALUES ('s1', ?, '老会话', NULL, 1, 1, ?)").run(clientId, userId);
  old.close();

  const store = new Store(dbPath);
  // 身份不重复建、归属不变、能新建会话
  assert.equal(store.verifyIdentity(clientId).userId, userId);
  assert.equal(new Database(dbPath, { readonly: true }).prepare("SELECT COUNT(*) n FROM identities").get().n, 1);
  assert.equal(store.listSessions(userId)[0].title, "老会话");
  const { id } = store.createSession(userId, "新会话");
  assert.ok(store.getSession(id, userId));
});

// ── HTTP API 鉴权面（stub 桥，express 起在随机端口）────────────────

const stubBridge = { openaiTools: [], callTool: async () => ({ text: "", isError: false }) };
const stubPool = { for: async () => stubBridge };

const startApp = (t, store, opts = {}) => new Promise((resolve) => {
  const app = createApp({ store, bridgePool: stubPool, systemPrompt: "test", ...opts });
  const server = app.listen(0, "127.0.0.1", () => {
    t.after(() => server.close());
    resolve(`http://127.0.0.1:${server.address().port}`);
  });
});

const authed = (code) => ({ Authorization: `Bearer ${code}` });

test("API：身份创建/验证 + 未鉴权 401 全面", async (t) => {
  const { store } = makeStore(t);
  const base = await startApp(t, store);

  // 创建身份：唯一不要鉴权的业务端点
  const created = await (await fetch(`${base}/api/identity`, { method: "POST" })).json();
  assert.match(created.recoveryCode, /^ink_/);

  // 验证面
  const ok = await fetch(`${base}/api/identity`, { headers: authed(created.recoveryCode) });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).ok, true);

  // 401 面：无头 / 坏格式 / 未知码，且错误信息不回显恢复码
  for (const headers of [{}, { Authorization: "Basic abc" }, authed("ink_unknown")]) {
    const r = await fetch(`${base}/api/sessions`, { headers });
    assert.equal(r.status, 401);
    assert.ok(!(await r.text()).includes("ink_unknown"));
  }

  // clientId 查询参数彻底废除：带上也无效（鉴权头才算数）
  const legacy = await fetch(`${base}/api/sessions?clientId=whatever`);
  assert.equal(legacy.status, 401);
});

test("API：A/B 会话隔离——列表只见自己，跨用户读/删/续聊 404", async (t) => {
  const { store } = makeStore(t);
  const base = await startApp(t, store);

  const a = await (await fetch(`${base}/api/identity`, { method: "POST" })).json();
  const b = await (await fetch(`${base}/api/identity`, { method: "POST" })).json();
  const aUser = store.verifyIdentity(a.recoveryCode).userId;
  const { id: aSession } = store.createSession(aUser, "A 的会话");

  const aList = await (await fetch(`${base}/api/sessions`, { headers: authed(a.recoveryCode) })).json();
  assert.equal(aList.length, 1);
  const bList = await (await fetch(`${base}/api/sessions`, { headers: authed(b.recoveryCode) })).json();
  assert.deepEqual(bList, []);

  // B 用 A 的 sessionId：读消息、删除、续聊全部 404
  const read = await fetch(`${base}/api/sessions/${aSession}/messages`, { headers: authed(b.recoveryCode) });
  assert.equal(read.status, 404);
  const del = await fetch(`${base}/api/sessions/${aSession}`, { method: "DELETE", headers: authed(b.recoveryCode) });
  assert.equal(del.status, 404);
  const chat = await fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authed(b.recoveryCode) },
    body: JSON.stringify({ sessionId: aSession, message: "hi", llm: { baseURL: "http://x", apiKey: "k", model: "m" } }),
  });
  assert.equal(chat.status, 404);

  // A 自己一切正常
  const mine = await fetch(`${base}/api/sessions/${aSession}/messages`, { headers: authed(a.recoveryCode) });
  assert.equal(mine.status, 200);
});

test("API：预览/下载按用户目录归属——自己 200，别人 404，未鉴权 401", async (t) => {
  const { store, dir } = makeStore(t);
  const usersRoot = path.join(dir, "users");
  const base = await startApp(t, store, { usersRoot });

  const a = await (await fetch(`${base}/api/identity`, { method: "POST" })).json();
  const b = await (await fetch(`${base}/api/identity`, { method: "POST" })).json();
  const aUser = store.verifyIdentity(a.recoveryCode).userId;

  // 在 A 的用户目录里造产物（docx + 预览页）
  const docId = crypto.randomUUID();
  const outDir = path.join(usersRoot, aUser, "output");
  fs.mkdirSync(path.join(outDir, `${docId}-preview`), { recursive: true });
  fs.writeFileSync(path.join(outDir, `${docId}.docx`), "fake-docx");
  fs.writeFileSync(path.join(outDir, `${docId}-preview`, `${docId}-1.png`), "fake-png");

  const previewUrl = `${base}/api/docs/${docId}/preview/${docId}-1.png`;
  const docxUrl = `${base}/api/docs/${docId}/inkpaw.docx`;

  for (const url of [previewUrl, docxUrl]) {
    assert.equal((await fetch(url, { headers: authed(a.recoveryCode) })).status, 200, `A 应能取 ${url}`);
    assert.equal((await fetch(url, { headers: authed(b.recoveryCode) })).status, 404, `B 不该取到 ${url}`);
    assert.equal((await fetch(url)).status, 401, "未鉴权应 401");
  }

  // 路径注入面：坏 docId / 坏文件名一律 404
  assert.equal((await fetch(`${base}/api/docs/../secret/inkpaw.docx`, { headers: authed(a.recoveryCode) })).status, 404);
  assert.equal((await fetch(`${base}/api/docs/${docId}/preview/..%2F..%2Fsecret.png`, { headers: authed(a.recoveryCode) })).status, 404);
});

test("API：模板上传/列表/删除按用户隔离（真桥池 + 真实 InkPaw MCP 子进程）", async (t) => {
  const { Document, Packer, Paragraph, TextRun } = require("docx");
  const { BridgePool } = require("../playground/mcp-bridge");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "playground-tpl-api-"));
  const { child, url } = await startMcpServer(dir);
  const { store } = makeStore(t);
  const pool = new BridgePool(url, TOKEN);
  t.after(async () => { await pool.closeAll(); child.kill(); fs.rmSync(dir, { recursive: true, force: true }); });
  const base = await startApp(t, store, { bridgePool: pool });

  const a = await (await fetch(`${base}/api/identity`, { method: "POST" })).json();
  const b = await (await fetch(`${base}/api/identity`, { method: "POST" })).json();
  const jsonHeaders = (code) => ({ "Content-Type": "application/json", ...authed(code) });

  const tplBase64 = (await Packer.toBuffer(new Document({
    sections: [{ children: [new Paragraph({ children: [new TextRun("标题：{{title}}")] })] }],
  }))).toString("base64");

  // A 上传：返回槽位；A 列表可见，B 列表为空
  const up = await fetch(`${base}/api/templates`, {
    method: "POST", headers: jsonHeaders(a.recoveryCode),
    body: JSON.stringify({ name: "A 的模板", base64: tplBase64 }),
  });
  assert.equal(up.status, 200);
  const tpl = await up.json();
  assert.deepEqual(tpl.slots, ["title"]);
  const aList = await (await fetch(`${base}/api/templates`, { headers: authed(a.recoveryCode) })).json();
  assert.equal(aList.templates.length, 1);
  const bList = await (await fetch(`${base}/api/templates`, { headers: authed(b.recoveryCode) })).json();
  assert.deepEqual(bList.templates, []);

  // B 删 A 的模板：404；A 自删 ok
  const steal = await fetch(`${base}/api/templates/${tpl.templateId}`, { method: "DELETE", headers: authed(b.recoveryCode) });
  assert.equal(steal.status, 404);
  // 选定别人的模板续聊：验归属 404（在任何模型调用之前打回）
  const chat = await fetch(`${base}/api/chat`, {
    method: "POST", headers: jsonHeaders(b.recoveryCode),
    body: JSON.stringify({ message: "hi", llm: { baseURL: "http://x", apiKey: "k", model: "m" }, selectedTemplateId: tpl.templateId }),
  });
  assert.equal(chat.status, 404);
  const del = await fetch(`${base}/api/templates/${tpl.templateId}`, { method: "DELETE", headers: authed(a.recoveryCode) });
  assert.equal(del.status, 200);

  // 坏 base64 由服务层校验打回 400；超 5MB 413
  const bad = await fetch(`${base}/api/templates`, {
    method: "POST", headers: jsonHeaders(a.recoveryCode),
    body: JSON.stringify({ base64: "not-a-zip" }),
  });
  assert.equal(bad.status, 400);
  const huge = await fetch(`${base}/api/templates`, {
    method: "POST", headers: jsonHeaders(a.recoveryCode),
    body: JSON.stringify({ base64: "A".repeat(7 * 1024 * 1024) }),
  });
  assert.equal(huge.status, 413);
});

test("BridgePool：按用户作用域头隔离 + 实例复用（连真实 InkPaw MCP 子进程）", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "playground-pool-"));
  const { child, url } = await startMcpServer(dir);
  const { BridgePool } = require("../playground/mcp-bridge");
  const pool = new BridgePool(url, TOKEN);
  t.after(async () => { await pool.closeAll(); child.kill(); fs.rmSync(dir, { recursive: true, force: true }); });

  const userA = crypto.randomUUID();
  const userB = crypto.randomUUID();
  const bridgeA = await pool.for(userA);
  assert.ok(bridgeA.openaiTools.length > 0);
  assert.strictEqual(await pool.for(userA), bridgeA, "同 userId 应复用同一条桥");

  const created = await bridgeA.callTool("create_document", {
    title: "A", def: { contexts: [{ type: "text", text: "hi" }] },
  });
  assert.equal(created.isError, false, created.text);
  const docId = JSON.parse(created.text).docId;

  const bridgeB = await pool.for(userB);
  const stolen = await bridgeB.callTool("get_outline", { docId });
  assert.equal(stolen.isError, true, "B 不该看到 A 的文档");
  const own = await bridgeA.callTool("get_outline", { docId });
  assert.equal(own.isError, false);
});

// ── McpBridge 集成（真实 HTTP 服务 + Bearer 鉴权）──────────────────

const TOKEN = "test-token-playground";

// 每次换端口：上一个子进程 kill 后端口未必立刻释放，复用会 EADDRINUSE
let portSeq = 0;
const startMcpServer = async (dir, fixedPort) => {
  const port = fixedPort || 18000 + ((process.pid * 7 + portSeq++) % 2000);
  const child = spawn(process.execPath, [path.join(__dirname, "..", "src", "server.js"), "--http"], {
    env: {
      ...process.env,
      DOCX_MCP_DB: path.join(dir, "t.db"),
      DOCX_MCP_OUTPUT: path.join(dir, "out"),
      DOCX_MCP_PROFILE: path.join(dir, "profile.json"),
      DOCX_MCP_TEMPLATES: path.join(dir, "tpl"),
      DOCX_MCP_DOWNLOADS: path.join(dir, "dl"),
      DOCX_MCP_USERS: path.join(dir, "users"),
      DOCX_MCP_PORT: String(port),
      DOCX_MCP_TOKEN: TOKEN,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  const url = `http://127.0.0.1:${port}/mcp`;
  // 等启动：stderr 出现启动行或端口可连，最多 10s
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("InkPaw MCP 子进程 10s 未就绪")), 10000);
    child.stderr.on("data", (d) => {
      if (String(d).includes("已启动")) { clearTimeout(timer); resolve(); }
    });
    child.on("exit", (code) => { clearTimeout(timer); reject(new Error(`子进程提前退出 code=${code}`)); });
  });
  return { child, url };
};

test("McpBridge：无 token 401、错 token 连不上、对 token 工具清单与调用全通", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "playground-bridge-"));
  const { child, url } = await startMcpServer(dir);
  t.after(() => { child.kill(); fs.rmSync(dir, { recursive: true, force: true }); });

  const rpcBody = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
  const headers = { "Content-Type": "application/json", "Accept": "application/json, text/event-stream" };

  const noToken = await fetch(url, { method: "POST", headers, body: rpcBody });
  assert.equal(noToken.status, 401);

  await assert.rejects(new McpBridge(url, "wrong-token").connect(), /需要鉴权|401|[Uu]nauthorized/);

  const bridge = new McpBridge(url, TOKEN);
  const n = await bridge.connect();
  assert.ok(n > 0, "应拿到非空工具清单");

  // 工具清单已是 OpenAI function 格式
  const names = bridge.openaiTools.map((x) => x.function.name);
  assert.ok(names.includes("create_document") && names.includes("render_document"), `工具缺失: ${names}`);
  for (const x of bridge.openaiTools) assert.equal(x.type, "function");

  const presets = await bridge.callTool("list_presets", {});
  assert.equal(presets.isError, false);
  assert.match(presets.text, /monthly-report/);

  // isError 透传：故意传坏参数
  const bad = await bridge.callTool("get_outline", { docId: "not-a-uuid" });
  assert.equal(bad.isError, true);
});

test("McpBridge：服务重启后 callTool 自动重连重试", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "playground-bridge-"));
  let { child, url } = await startMcpServer(dir);
  t.after(() => { child.kill(); fs.rmSync(dir, { recursive: true, force: true }); });

  const bridge = new McpBridge(url, TOKEN);
  await bridge.connect();

  // 杀掉再从原端口拉起，模拟核心 MCP 重启（桥的 URL 不变，必须同端口）。
  const port = Number(new URL(url).port);
  child.kill();
  await new Promise((r) => child.on("exit", r));
  ({ child } = await startMcpServer(dir, port));

  const presets = await bridge.callTool("list_presets", {});
  assert.equal(presets.isError, false);
});

test("McpBridge：超长工具结果截断保护", async () => {
  const bridge = new McpBridge("http://127.0.0.1:1/mcp", TOKEN);
  // 不真连：直接桩掉 client，验证截断逻辑本身
  const long = "x".repeat(30000);
  bridge.client = { callTool: async () => ({ content: [{ type: "text", text: long }], isError: false }) };
  const { text } = await bridge.callTool("whatever", {});
  assert.ok(text.length < long.length);
  assert.match(text, /已截断/);
});

// ── 草稿视图（docs/editable-preview.md §3，P2）────────────────────

test("McpBridge：UI 专用工具不进模型工具表，但自己调得到", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "playground-draft-"));
  const { child, url } = await startMcpServer(dir);
  t.after(() => { child.kill(); fs.rmSync(dir, { recursive: true, force: true }); });

  const bridge = new McpBridge(url, TOKEN);
  await bridge.connect();
  const names = bridge.openaiTools.map((x) => x.function.name);
  assert.ok(!names.includes("get_draft_html"), "UI 工具不该出现在模型工具表里");

  // 建个文档再取草稿，验证桥仍能直接调用被过滤掉的工具
  const created = await bridge.callTool("create_document", {
    title: "草稿", def: { contexts: [{ id: "p1", type: "text", text: "正文" }] },
  });
  assert.equal(created.isError, false);
  const { docId } = JSON.parse(created.text);

  const draft = await bridge.callTool("get_draft_html", { docId }, { truncate: false });
  assert.equal(draft.isError, false);
  const { html } = JSON.parse(draft.text);
  assert.match(html, /data-node-id="p1" data-path="text"/);
});

test("McpBridge：truncate:false 不截断（草稿 HTML 整篇要完整）", async () => {
  const bridge = new McpBridge("http://127.0.0.1:1/mcp", TOKEN);
  const long = "x".repeat(30000);
  bridge.client = { callTool: async () => ({ content: [{ type: "text", text: long }], isError: false }) };
  const { text } = await bridge.callTool("whatever", {}, { truncate: false });
  assert.equal(text.length, long.length);
  assert.ok(!text.includes("已截断"));
});

test("草稿路由：非法 docId 404，正常 docId 透传 MCP 结果", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "playground-draftapi-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new Store(path.join(dir, "pg.db"));
  t.after(() => store.close && store.close());

  const payload = JSON.stringify({ html: "<article class=\"ip-doc\"></article>", css: ".ip-leaf{}", warnings: [] });
  const pool = { for: async () => ({
    openaiTools: [],
    callTool: async (name, args, opts) => {
      assert.equal(name, "get_draft_html");
      assert.deepEqual(opts, { truncate: false }, "草稿必须走不截断路径");
      return { text: payload, isError: false };
    },
  }) };
  const base = await startApp(t, store, { bridgePool: pool });

  const r0 = await fetch(`${base}/api/identity`, { method: "POST" });
  const { recoveryCode } = await r0.json();

  const bad = await fetch(`${base}/api/docs/not-a-uuid/draft`, { headers: authed(recoveryCode) });
  assert.equal(bad.status, 404);

  const uuid = "00000000-0000-4000-8000-000000000001";
  const ok = await fetch(`${base}/api/docs/${uuid}/draft`, { headers: authed(recoveryCode) });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("cache-control"), "no-store");
  assert.deepEqual(await ok.json(), JSON.parse(payload));
});

test("草稿路由：未鉴权拿不到", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "playground-draftauth-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new Store(path.join(dir, "pg.db"));
  t.after(() => store.close && store.close());
  const base = await startApp(t, store);
  const uuid = "00000000-0000-4000-8000-000000000001";
  const r = await fetch(`${base}/api/docs/${uuid}/draft`);
  assert.equal(r.status, 401);
});

test("写回路由：转发 update_node_value，参数校验不合格打回 400", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "playground-wb-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new Store(path.join(dir, "pg.db"));
  t.after(() => store.close && store.close());

  const seen = [];
  const pool = { for: async () => ({
    openaiTools: [],
    callTool: async (name, args) => {
      seen.push({ name, args });
      return { text: JSON.stringify({ ok: true, id: args.id, path: "text", issues: [] }), isError: false };
    },
  }) };
  const base = await startApp(t, store, { bridgePool: pool });
  const { recoveryCode } = await (await fetch(`${base}/api/identity`, { method: "POST" })).json();
  const uuid = "00000000-0000-4000-8000-000000000001";
  const post = (body) => fetch(`${base}/api/docs/${uuid}/draft`, {
    method: "POST",
    headers: { ...authed(recoveryCode), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const ok = await post({ id: "p1", path: ["text"], value: "改过的" });
  assert.equal(ok.status, 200);
  assert.deepEqual(seen[0], {
    name: "update_node_value",
    args: { docId: uuid, id: "p1", path: ["text"], value: "改过的" },
  });

  // path 必须是数组、value 必须是字符串——展示形字符串不该被接受
  assert.equal((await post({ id: "p1", path: "text", value: "x" })).status, 400);
  assert.equal((await post({ id: "p1", path: ["text"], value: 42 })).status, 400);
  assert.equal((await post({ path: ["text"], value: "x" })).status, 400);
  assert.equal(seen.length, 1, "不合格请求不该打到 MCP");
});

test("写回路由：MCP 侧拒绝时透传 400 而不是 500", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "playground-wb2-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new Store(path.join(dir, "pg.db"));
  t.after(() => store.close && store.close());

  const pool = { for: async () => ({
    openaiTools: [],
    callTool: async () => ({ text: "错误: 引用标记不可增删改", isError: true }),
  }) };
  const base = await startApp(t, store, { bridgePool: pool });
  const { recoveryCode } = await (await fetch(`${base}/api/identity`, { method: "POST" })).json();
  const r = await fetch(`${base}/api/docs/00000000-0000-4000-8000-000000000001/draft`, {
    method: "POST",
    headers: { ...authed(recoveryCode), "Content-Type": "application/json" },
    body: JSON.stringify({ id: "p1", path: ["text"], value: "删了引用" }),
  });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /引用标记不可增删改/);
});

test("McpBridge：写回工具同样不进模型工具表", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "playground-wb3-"));
  const { child, url } = await startMcpServer(dir);
  t.after(() => { child.kill(); fs.rmSync(dir, { recursive: true, force: true }); });
  const bridge = new McpBridge(url, TOKEN);
  await bridge.connect();
  const names = bridge.openaiTools.map((x) => x.function.name);
  assert.ok(!names.includes("update_node_value"), "UI 写回工具不该出现在模型工具表里");
  assert.ok(names.includes("update_node"), "模型自己的整节点更新工具照常在");
});

test("配置路由：读写转发 MCP，参数形状不合格打回 400", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "playground-cfg-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new Store(path.join(dir, "pg.db"));
  t.after(() => store.close && store.close());

  const seen = [];
  const pool = { for: async () => ({
    openaiTools: [],
    callTool: async (name, args) => {
      seen.push({ name, args });
      return { text: JSON.stringify({ ok: true, fields: {}, document: {}, sections: [] }), isError: false };
    },
  }) };
  const base = await startApp(t, store, { bridgePool: pool });
  const { recoveryCode } = await (await fetch(`${base}/api/identity`, { method: "POST" })).json();
  const uuid = "00000000-0000-4000-8000-000000000001";

  const got = await fetch(`${base}/api/docs/${uuid}/config`, { headers: authed(recoveryCode) });
  assert.equal(got.status, 200);
  assert.equal(seen[0].name, "get_doc_config");

  const post = (body) => fetch(`${base}/api/docs/${uuid}/config`, {
    method: "POST",
    headers: { ...authed(recoveryCode), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  assert.equal((await post({ set: { headerText: "新页眉" } })).status, 200);
  assert.deepEqual(seen[1], { name: "update_doc_config", args: { docId: uuid, set: { headerText: "新页眉" } } });

  // clear 走数组，sectionId 可选
  assert.equal((await post({ sectionId: "sec2", clear: ["headerText"] })).status, 200);
  assert.deepEqual(seen[2].args, { docId: uuid, sectionId: "sec2", clear: ["headerText"] });

  assert.equal((await post({ set: "不是对象" })).status, 400);
  assert.equal((await post({ clear: "不是数组" })).status, 400);
  assert.equal(seen.length, 3, "形状不合格的请求不该打到 MCP");
});

test("McpBridge：四个 UI 工具全部不进模型工具表", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "playground-uionly-"));
  const { child, url } = await startMcpServer(dir);
  t.after(() => { child.kill(); fs.rmSync(dir, { recursive: true, force: true }); });
  const bridge = new McpBridge(url, TOKEN);
  await bridge.connect();
  const names = bridge.openaiTools.map((x) => x.function.name);
  for (const t2 of ["get_draft_html", "update_node_value", "get_doc_config", "update_doc_config"]) {
    assert.ok(!names.includes(t2), `${t2} 不该出现在模型工具表里`);
  }
  assert.ok(names.includes("update_node") && names.includes("render_document"), "模型自己的工具照常在");
});

test("结构路由：转发 update_draft_structure，缺参数打回 400", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "playground-struct-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new Store(path.join(dir, "pg.db"));
  t.after(() => store.close && store.close());

  const seen = [];
  const pool = { for: async () => ({
    openaiTools: [],
    callTool: async (name, args) => {
      seen.push({ name, args });
      return { text: JSON.stringify({ newIds: ["n1"], issues: [] }), isError: false };
    },
  }) };
  const base = await startApp(t, store, { bridgePool: pool });
  const { recoveryCode } = await (await fetch(`${base}/api/identity`, { method: "POST" })).json();
  const uuid = "00000000-0000-4000-8000-000000000001";
  const post = (body) => fetch(`${base}/api/docs/${uuid}/structure`, {
    method: "POST",
    headers: { ...authed(recoveryCode), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  assert.equal((await post({ op: "insertAfter", anchorId: "p1", text: "新段" })).status, 200);
  assert.deepEqual(seen[0], {
    name: "update_draft_structure",
    args: { docId: uuid, op: "insertAfter", anchorId: "p1", text: "新段" },
  });
  assert.equal((await post({ op: "delete" })).status, 400);
  assert.equal((await post({ anchorId: "p1" })).status, 400);
  assert.equal((await post({ op: "insertAfter", anchorId: "p1", text: 42 })).status, 400);
  assert.equal(seen.length, 1, "不合格请求不该打到 MCP");
});

test("McpBridge：五个 UI 工具全部不进模型工具表", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "playground-uionly2-"));
  const { child, url } = await startMcpServer(dir);
  t.after(() => { child.kill(); fs.rmSync(dir, { recursive: true, force: true }); });
  const bridge = new McpBridge(url, TOKEN);
  await bridge.connect();
  const names = bridge.openaiTools.map((x) => x.function.name);
  for (const t2 of ["get_draft_html", "update_node_value", "get_doc_config",
    "update_doc_config", "update_draft_structure"]) {
    assert.ok(!names.includes(t2), `${t2} 不该出现在模型工具表里`);
  }
  for (const t2 of ["insert_nodes", "delete_nodes", "move_nodes", "update_node"]) {
    assert.ok(names.includes(t2), `${t2} 是模型自己的工具，必须在`);
  }
});

test("重渲染路由：转发 render_document 并强制 preview，error 级 issue 打回 400", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "playground-rr-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new Store(path.join(dir, "pg.db"));
  t.after(() => store.close && store.close());

  const seen = [];
  let reply = { ok: true, path: "/x.docx", warnings: ["注意事项"] };
  const pool = { for: async () => ({
    openaiTools: [],
    callTool: async (name, args) => {
      seen.push({ name, args });
      return { text: JSON.stringify(reply), isError: false };
    },
  }) };
  const base = await startApp(t, store, { bridgePool: pool });
  const { recoveryCode } = await (await fetch(`${base}/api/identity`, { method: "POST" })).json();
  const uuid = "00000000-0000-4000-8000-000000000001";
  const post = () => fetch(`${base}/api/docs/${uuid}/render`, {
    method: "POST", headers: authed(recoveryCode),
  });

  const ok = await post();
  assert.equal(ok.status, 200);
  assert.deepEqual(seen[0], { name: "render_document", args: { docId: uuid, preview: true } });
  const body = await ok.json();
  assert.deepEqual(body.warnings, ["注意事项"]);
  assert.equal(body.docId, uuid, "应带回产物信息供前端刷新版式视图");

  // 服务端 ok:false（error 级 issue 挡住渲染）不是 HTTP 错误，但对前端应是失败
  reply = { ok: false, message: "存在 error 级 issue，拒绝渲染", issues: [{ level: "error", message: "表格列数不符" }] };
  const bad = await post();
  assert.equal(bad.status, 400);
  const badBody = await bad.json();
  assert.match(badBody.error, /拒绝渲染/);
  assert.equal(badBody.issues.length, 1);

  assert.equal((await fetch(`${base}/api/docs/not-a-uuid/render`, {
    method: "POST", headers: authed(recoveryCode),
  })).status, 404);
});

test("系统提示词：告知模型用户可自行编辑，并划清各自职责", () => {
  const prompt = fs.readFileSync(path.join(__dirname, "..", "playground", "system-prompt.md"), "utf8");
  assert.match(prompt, /用户可以自己改文档/);
  assert.match(prompt, /重新渲染/, "应说明用户能自己重渲");
  assert.match(prompt, /get_outline/, "应要求改动前拉最新状态而非凭记忆");
  // 只读边界必须写进提示词，否则模型会建议用户去改改不动的东西
  for (const kw of ["自动编号", "交叉引用", "目录"]) {
    assert.ok(prompt.includes(kw), `只读边界应点名 ${kw}`);
  }
});
