"use strict";
// 多用户作用域（docs/architecture.md）：
// scoped service 的路径类参数封锁 + delete_template + HTTP 作用域头的端到端隔离。

const { test } = require("node:test");
const assert = require("node:assert");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Document, Packer, Paragraph, TextRun } = require("docx");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StreamableHTTPClientTransport } = require("@modelcontextprotocol/sdk/client/streamableHttp.js");

const { createService } = require("../src/service");

const makeService = (opts = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "docx-mcp-scoped-"));
  const service = createService({
    dbPath: path.join(dir, "t.db"),
    outputDir: path.join(dir, "output"),
    profilePath: path.join(dir, "style-profile.json"),
    templatesDir: path.join(dir, "templates"),
    ...opts,
  });
  return { service, dir, cleanup: () => { service.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
};

const buildTemplateBase64 = async () => (await Packer.toBuffer(new Document({
  sections: [{ children: [new Paragraph({ children: [new TextRun("标题：{{title}}")] })] }],
}))).toString("base64");

// ── scoped service 的路径封锁 ─────────────────────────────────────

test("scoped：registerTemplate 拒绝 path（任意文件读原语），base64 照常", async (t) => {
  const { service, cleanup } = makeService({ scoped: true });
  t.after(cleanup);

  await assert.rejects(
    service.registerTemplate({ path: "/etc/passwd" }),
    /公网作用域下不支持 path/
  );
  const { templateId, slots } = await service.registerTemplate({
    name: "t", base64: await buildTemplateBase64(),
  });
  assert.ok(templateId);
  assert.deepStrictEqual(slots, ["title"]);
});

test("scoped：renderDocument 拒绝 outPath（越目录写原语），缺省路径照常", async (t) => {
  const { service, dir, cleanup } = makeService({ scoped: true });
  t.after(cleanup);

  const { docId } = service.createDocument({
    title: "t", def: { contexts: [{ type: "text", text: "hello" }] },
  });
  await assert.rejects(
    service.renderDocument({ docId, outPath: "/tmp/escape.docx" }),
    /公网作用域下不支持 outPath/
  );
  const res = await service.renderDocument({ docId });
  assert.equal(res.ok, true);
  assert.ok(res.path.startsWith(path.join(dir, "output")));
});

test("非 scoped：path / outPath 不受影响（本地用法零改动）", async (t) => {
  const { service, dir, cleanup } = makeService();
  t.after(cleanup);

  const tplPath = path.join(dir, "local.docx");
  fs.writeFileSync(tplPath, Buffer.from(await buildTemplateBase64(), "base64"));
  const { templateId } = await service.registerTemplate({ path: tplPath });
  assert.ok(templateId);

  const { docId } = service.createDocument({
    title: "t", def: { contexts: [{ type: "text", text: "hello" }] },
  });
  const out = path.join(dir, "elsewhere", "x.docx");
  const res = await service.renderDocument({ docId, outPath: out });
  assert.equal(res.ok, true);
  assert.equal(res.path, out);
});

// ── delete_template ───────────────────────────────────────────────

test("deleteTemplate：登记与文件都删掉，未知 id 报错", async (t) => {
  const { service, dir, cleanup } = makeService();
  t.after(cleanup);

  const { templateId } = await service.registerTemplate({
    name: "victim", base64: await buildTemplateBase64(),
  });
  const file = path.join(dir, "templates", `${templateId}.docx`);
  assert.ok(fs.existsSync(file));

  const res = service.deleteTemplate({ templateId });
  assert.equal(res.deleted, templateId);
  assert.ok(!fs.existsSync(file));
  assert.deepStrictEqual(service.listTemplates().templates, []);

  assert.throws(() => service.deleteTemplate({ templateId }), /模板不存在/);
});

// ── 存储粗闸（§7.4）──────────────────────────────────────────────

test("limits：模板数上限——满了报错提示先删，删掉后能再传", async (t) => {
  const { service, cleanup } = makeService({ scoped: true, limits: { maxTemplates: 1 } });
  t.after(cleanup);

  const base64 = await buildTemplateBase64();
  const { templateId } = await service.registerTemplate({ name: "t1", base64 });
  await assert.rejects(service.registerTemplate({ name: "t2", base64 }), /模板数已达上限 1/);
  service.deleteTemplate({ templateId });
  const again = await service.registerTemplate({ name: "t2", base64 });
  assert.ok(again.templateId);
});

test("limits：output 容量粗检——超限拒绝渲染；不传 limits 不受限", async (t) => {
  const { service, dir, cleanup } = makeService({ scoped: true, limits: { maxOutputMB: 1 } });
  t.after(cleanup);

  const { docId } = service.createDocument({
    title: "t", def: { contexts: [{ type: "text", text: "hello" }] },
  });
  // 预塞 2MB 假产物顶爆闸门
  fs.mkdirSync(path.join(dir, "output"), { recursive: true });
  fs.writeFileSync(path.join(dir, "output", "big.bin"), Buffer.alloc(2 * 1024 * 1024));
  await assert.rejects(service.renderDocument({ docId }), /渲染产物空间已超 1MB/);

  // 同样体量在无 limits 的 service 上照常渲染
  const free = makeService();
  t.after(free.cleanup);
  const created = free.service.createDocument({
    title: "t", def: { contexts: [{ type: "text", text: "hello" }] },
  });
  fs.mkdirSync(path.join(free.dir, "output"), { recursive: true });
  fs.writeFileSync(path.join(free.dir, "output", "big.bin"), Buffer.alloc(2 * 1024 * 1024));
  const res = await free.service.renderDocument({ docId: created.docId });
  assert.equal(res.ok, true);
});

// ── HTTP 作用域头端到端 ───────────────────────────────────────────

const TOKEN = "test-token-scoped";
let portSeq = 0;

const startServer = async (dir) => {
  const port = 21000 + ((process.pid * 13 + portSeq++) % 2000);
  const child = spawn(process.execPath, [path.join(__dirname, "..", "src", "server.js"), "--http"], {
    env: {
      ...process.env,
      DOCX_MCP_DB: path.join(dir, "global.db"),
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
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("docx-mcp 子进程 10s 未就绪")), 10000);
    child.stderr.on("data", (d) => {
      if (String(d).includes("已启动")) { clearTimeout(timer); resolve(); }
    });
    child.on("exit", (code) => { clearTimeout(timer); reject(new Error(`子进程提前退出 code=${code}`)); });
  });
  return { child, url: `http://127.0.0.1:${port}/mcp` };
};

const connectClient = async (url, scopeUser) => {
  const client = new Client({ name: "scoped-test", version: "0.0.0" });
  const headers = { Authorization: `Bearer ${TOKEN}` };
  if (scopeUser) headers["X-Docx-Scope-User"] = scopeUser;
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } }));
  return client;
};

const callJson = async (client, name, args) => {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
  return { isError: !!res.isError, text };
};

test("HTTP 作用域：双用户数据互不可见，无头走全局，坏头 400", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "docx-mcp-scope-http-"));
  const { child, url } = await startServer(dir);
  t.after(() => { child.kill(); fs.rmSync(dir, { recursive: true, force: true }); });

  const userA = "aaaaaaaa-1111-4111-8111-111111111111";
  const userB = "bbbbbbbb-2222-4222-8222-222222222222";
  const [a, b, globalC] = await Promise.all([
    connectClient(url, userA), connectClient(url, userB), connectClient(url),
  ]);

  // A 建档：落在 A 的独立库与目录
  const created = await callJson(a, "create_document", {
    title: "A 的文档", def: { contexts: [{ type: "text", text: "属于 A" }] },
  });
  assert.equal(created.isError, false, created.text);
  const docId = JSON.parse(created.text).docId;
  assert.ok(fs.existsSync(path.join(dir, "users", userA, "docx-mcp.db")));

  // A 自己可见
  const mine = await callJson(a, "get_outline", { docId });
  assert.equal(mine.isError, false);

  // B / 全局 都拿不到（跨作用域即「文档不存在」）
  for (const client of [b, globalC]) {
    const other = await callJson(client, "get_outline", { docId });
    assert.equal(other.isError, true);
    assert.match(other.text, /文档不存在/);
  }

  // B 的模板列表是空的；A 注册后也只有 A 可见
  const reg = await callJson(a, "register_template", { name: "a-tpl", base64: await buildTemplateBase64() });
  assert.equal(reg.isError, false, reg.text);
  const bList = await callJson(b, "list_templates", {});
  assert.deepStrictEqual(JSON.parse(bList.text).templates, []);
  const aList = await callJson(a, "list_templates", {});
  assert.equal(JSON.parse(aList.text).templates.length, 1);

  // scoped 连接里 path 注册被封死
  const escape = await callJson(a, "register_template", { path: "/etc/hostname" });
  assert.equal(escape.isError, true);
  assert.match(escape.text, /公网作用域下不支持 path/);

  // 坏作用域头：非 UUID 一律 400
  const bad = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
      "Authorization": `Bearer ${TOKEN}`,
      "X-Docx-Scope-User": "../../etc",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
  assert.equal(bad.status, 400);

  await Promise.all([a.close(), b.close(), globalC.close()]);
});
