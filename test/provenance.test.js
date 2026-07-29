// provenance.test.js — transform 产出 _src 溯源 + 入口剥离伪造值
// （docs/editable-preview.md §3.1，P0b / P0c）
const { test } = require("node:test");
const assert = require("node:assert");
const { transform } = require("../src/transform");
const { normalizeNode, normalizeNodes } = require("../src/normalize");
const { writePath } = require("../src/nodePath");

const run = (contexts, meta = { autoNumber: true }) => transform({ meta, contexts }).def.contexts;

// ---------------------------------------------------------------- 原位节点：恒等默认

test("heading：编号进 prefix，原文进 raw", () => {
  const [h] = run([{ id: "h1", type: "heading", level: 1, text: "概述" }]);
  assert.strictEqual(h.text, "1 概述");
  assert.deepStrictEqual(h._src, {
    id: "h1",
    overrides: [{ path: ["text"], raw: "概述", prefix: "1 " }],
  });
});

test("heading：autoNumber 关闭时无改写 → 恒等，不产生 overrides", () => {
  const [h] = run([{ id: "h1", type: "heading", level: 1, text: "概述" }], { autoNumber: false });
  assert.deepStrictEqual(h._src, { id: "h1" });
});

test("heading：native 编号不拼文本 → 恒等", () => {
  const [h] = run([{ id: "h1", type: "heading", level: 1, text: "概述" }], { autoNumber: "native" });
  assert.deepStrictEqual(h._src, { id: "h1" });
});

test("text 含 ref：raw 保留未替换的 {{ref:}} 原文", () => {
  const [p] = run([
    { id: "t1", type: "table", data: [{ texts: ["a"] }] },
    { id: "p1", type: "text", text: "见 {{ref:t1}} 的数据。" },
  ]).slice(1);
  assert.strictEqual(p.text, "见 表1 的数据。");
  assert.deepStrictEqual(p._src, {
    id: "p1",
    overrides: [{ path: ["text"], raw: "见 {{ref:t1}} 的数据。" }],
  });
});

test("text 无 ref：恒等默认，不产生 overrides", () => {
  const [p] = run([{ id: "p1", type: "text", text: "普通正文" }]);
  assert.deepStrictEqual(p._src, { id: "p1" });
});

test("多 run：只有含 ref 的那个 run 进 overrides", () => {
  const out = run([
    { id: "t1", type: "table", data: [{ texts: ["a"] }] },
    { id: "p1", type: "text", text: ["前言", "见 {{ref:t1}}", "结尾"] },
  ]);
  const p = out[out.length - 1];
  assert.deepStrictEqual(p.text, ["前言", "见 表1", "结尾"]);
  assert.deepStrictEqual(p._src, {
    id: "p1",
    overrides: [{ path: ["text", 1], raw: "见 {{ref:t1}}" }],
  });
});

test("table 本体：单元格未被改写 → 恒等，不因表大而膨胀", () => {
  const out = run([{
    id: "t1", type: "table", caption: "实测数据",
    data: [{ texts: ["A", "B", "C"] }, { texts: ["D", "E", "F"] }],
  }]);
  const table = out.find((n) => n.type === "table");
  assert.deepStrictEqual(table._src, { id: "t1" });
});

test("无 id 的节点不产生 _src（无写回目标即只读）", () => {
  const [p] = run([{ type: "text", text: "没有 id" }]);
  assert.strictEqual(p._src, undefined);
});

// ---------------------------------------------------------------- 派生节点：显式 at/path

test("表题：at 指输出位置，path 指 def 里的 caption", () => {
  const out = run([{ id: "t1", type: "table", caption: "实测数据", data: [{ texts: ["a"] }] }]);
  const cap = out[0];
  assert.strictEqual(cap.text, "表1 实测数据");
  assert.deepStrictEqual(cap._src, {
    id: "t1",
    overrides: [{ at: ["text"], path: ["caption"], raw: "实测数据", prefix: "表1 " }],
  });
});

test("图题：同样映射回 image 节点的 caption", () => {
  const out = run([{ id: "img1", type: "image", src: "a.png", caption: "现场照片" }]);
  const cap = out[out.length - 1];
  assert.strictEqual(cap.text, "图1 现场照片");
  assert.deepStrictEqual(cap._src, {
    id: "img1",
    overrides: [{ at: ["text"], path: ["caption"], raw: "现场照片", prefix: "图1 " }],
  });
});

test("图题：autoNumber 关闭时无编号前缀，仍要有 override 才定位得到 caption", () => {
  const out = run([{ id: "img1", type: "image", src: "a.png", caption: "现场照片" }], { autoNumber: false });
  const cap = out[out.length - 1];
  assert.deepStrictEqual(cap._src, {
    id: "img1",
    overrides: [{ at: ["text"], path: ["caption"], raw: "现场照片" }],
  });
});

test("checklist：字符串形与对象形的写回路径不同", () => {
  const out = run([{ id: "ck1", type: "checklist", items: ["第一项", { text: "第二项", checked: true }] }]);
  assert.deepStrictEqual(out[0]._src, {
    id: "ck1",
    overrides: [{ at: ["text"], path: ["items", 0], raw: "第一项", prefix: " " }],
  });
  assert.deepStrictEqual(out[1]._src, {
    id: "ck1",
    overrides: [{ at: ["text"], path: ["items", 1, "text"], raw: "第二项", prefix: " " }],
  });
});

// ---------------------------------------------------------------- 生成物：只读

test("静态 toc：标题段与全部条目都是 readonly", () => {
  const out = run([
    { id: "toc1", type: "toc", title: "目录" },
    { id: "h1", type: "heading", level: 1, text: "概述" },
  ]);
  const generated = out.filter((n) => n._src && n._src.readonly);
  assert.strictEqual(generated.length, 2, "标题段 + 一条目录条目");
  assert.ok(generated.every((n) => !n._src.id), "生成物不应带写回目标");
});

test("native toc：标题段与 TOC 域节点都是 readonly", () => {
  const out = run([{ id: "toc1", type: "toc", title: "目录", native: true }]);
  assert.ok(out.every((n) => n._src && n._src.readonly === true));
});

// ---------------------------------------------------------------- 与 nodePath 串起来

test("溯源能真正驱动写回：按 _src 改图题落回 image.caption", () => {
  const def = { id: "img1", type: "image", src: "a.png", caption: "现场照片" };
  const cap = run([def]).find((n) => n._src && (n._src.overrides || []).some((o) => o.path[0] === "caption"));
  const { path } = cap._src.overrides[0];
  const r = writePath(def, path, "试验现场照片");
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.node.caption, "试验现场照片");
});

test("溯源能真正驱动写回：多 run 段落改的是 raw 那一路", () => {
  const def = { id: "p1", type: "text", text: ["前言", "见 {{ref:t1}}", "结尾"] };
  const out = transform({ meta: { autoNumber: true }, contexts: [
    { id: "t1", type: "table", data: [{ texts: ["a"] }] }, def,
  ] }).def.contexts;
  const p = out[out.length - 1];
  const { path, raw } = p._src.overrides[0];
  assert.strictEqual(raw, "见 {{ref:t1}}");
  const r = writePath(def, path, "见 {{ref:t1}} 的第二列");
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.node.text, ["前言", "见 {{ref:t1}} 的第二列", "结尾"]);
});

// ---------------------------------------------------------------- P0c 入口剥离

test("normalizeNode 剥掉外部传入的 _src", () => {
  const forged = { id: "p1", type: "text", text: "正文", _src: { id: "受害节点", overrides: [] } };
  const out = normalizeNode(forged);
  assert.ok(!("_src" in out), "_src 必须被剥离");
  assert.strictEqual(out.text, "正文");
  assert.ok("_src" in forged, "原对象不动");
});

test("normalizeNodes 批量剥离，且不影响表格归一化", () => {
  const out = normalizeNodes([
    { type: "text", text: "a", _src: { id: "x" } },
    { type: "table", data: [["A", 1]], _src: { id: "y" } },
  ]);
  assert.ok(out.every((n) => !("_src" in n)));
  assert.deepStrictEqual(out[1].data, [{ texts: ["A", "1"] }], "二维数组简写与数字转字符串照常");
});

test("剥离不误伤没有 _src 的节点", () => {
  const node = { type: "text", text: "正文" };
  assert.strictEqual(normalizeNode(node), node, "无 _src 时应原样返回，不做无谓拷贝");
});
