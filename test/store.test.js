// store.test.js — 存储层 + 补 id
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { openStore } = require("../src/store");
const { fillNodeIds } = require("../src/ids");

const tmpDb = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "docx-mcp-test-")), "t.db");

test("fillNodeIds：按类型补前缀，已有 id 保留，无重复", () => {
  const contexts = [
    { type: "heading", level: 1, text: "a" },
    { id: "p-mine", type: "text", text: "b" },
    { type: "table", data: [] },
    { type: "image", src: "x.png" },
    { type: "blank" },
    { type: "newPage" },
  ];
  const filled = fillNodeIds(contexts);
  assert.match(filled[0].id, /^h-/);
  assert.strictEqual(filled[1].id, "p-mine");
  assert.match(filled[2].id, /^tbl-/);
  assert.match(filled[3].id, /^img-/);
  assert.match(filled[4].id, /^p-/);
  assert.match(filled[5].id, /^p-/);
  assert.strictEqual(new Set(filled.map((n) => n.id)).size, 6);
  assert.strictEqual(contexts[0].id, undefined); // 不改原数组
});

test("documents 表 CRUD：uuid、整 def 覆写、updated_at 变化", async () => {
  const dbPath = tmpDb();
  const store = openStore(dbPath);
  try {
    const def = { meta: {}, contexts: [{ id: "h-1", type: "heading", level: 1, text: "概述" }] };
    const doc = store.createDocument({ title: "测试", preset: "plain", def });
    assert.match(doc.id, /^[0-9a-f-]{36}$/);
    assert.strictEqual(doc.preset, "plain");
    assert.deepStrictEqual(store.getDocument(doc.id).def, def);

    const def2 = { ...def, contexts: [...def.contexts, { id: "p-1", type: "text", text: "x" }] };
    await new Promise((r) => setTimeout(r, 5)); // 保证时间戳可区分
    const updated = store.updateDef(doc.id, def2);
    assert.strictEqual(updated.def.contexts.length, 2);
    assert.notStrictEqual(updated.updatedAt, doc.createdAt);

    assert.strictEqual(store.getDocument("no-such-id"), null);
    assert.throws(() => store.updateDef("no-such-id", def), /文档不存在/);
    assert.strictEqual(store.deleteDocument(doc.id), true);
    assert.strictEqual(store.getDocument(doc.id), null);
  } finally {
    store.close();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  }
});
