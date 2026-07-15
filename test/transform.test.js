// transform.test.js — autoNumber / caption / ref 变换覆盖
const { test } = require("node:test");
const assert = require("node:assert");
const { transform, buildNumberIndex } = require("../src/transform");

const H = (id, level, text) => ({ id, type: "heading", level, text });

test("heading 编号按树位置生成 1 / 1.1 / 1.1.1，层级回退后计数正确", () => {
  const contexts = [
    H("h-1", 1, "概述"),
    H("h-2", 2, "背景"),
    H("h-3", 3, "细节"),
    H("h-4", 2, "目标"),
    H("h-5", 1, "方案"),
  ];
  const { def } = transform({ meta: { autoNumber: true }, contexts });
  assert.deepStrictEqual(def.contexts.map((n) => n.text),
    ["1 概述", "1.1 背景", "1.1.1 细节", "1.2 目标", "2 方案"]);
});

test("autoNumber 关闭：heading text 原样保留", () => {
  const { def } = transform({ meta: { autoNumber: false }, contexts: [H("h-1", 1, "1 概述")] });
  assert.strictEqual(def.contexts[0].text, "1 概述");
});

test("opts.autoNumber 覆盖 meta（preset 合并后的开关）", () => {
  const { def } = transform({ meta: {}, contexts: [H("h-1", 1, "概述")] }, { autoNumber: true });
  assert.strictEqual(def.contexts[0].text, "1 概述");
});

test("image caption 展开为图下方 text 节点，图表计数器独立", () => {
  const contexts = [
    H("h-1", 1, "概述"),
    { id: "tbl-1", type: "table", caption: "参数表", columnWidths: [1], data: [{ texts: ["x"] }] },
    { id: "img-1", type: "image", src: "a.png", caption: "架构图" },
    { id: "img-2", type: "image", src: "b.png", caption: "流程图" },
  ];
  const { def } = transform({ meta: { autoNumber: true }, contexts });
  const texts = def.contexts.map((n) => (n.type === "text" ? n.text : n.type));
  // 表题在表上方，图题在图下方
  assert.deepStrictEqual(texts, ["heading", "表1 参数表", "table", "image", "图1 架构图", "image", "图2 流程图"]);
  // caption 字段不再残留在 table/image 节点上
  assert.ok(def.contexts.filter((n) => n.caption).length === 0);
});

test("caption 样式来自 opts.captionStyle，不写死", () => {
  const contexts = [{ id: "img-1", type: "image", src: "a.png", caption: "图题" }];
  const style = { textOptions: { size: 20 }, paragraphOptions: { alignment: "center" } };
  const { def } = transform({ meta: { autoNumber: true }, contexts }, { captionStyle: style });
  const cap = def.contexts[1];
  assert.deepStrictEqual(cap.textOptions, { size: 20 });
  assert.deepStrictEqual(cap.paragraphOptions, { alignment: "center" });
  // 不给 captionStyle 时不带样式字段（用渲染层默认）
  const bare = transform({ meta: { autoNumber: true }, contexts }).def.contexts[1];
  assert.strictEqual(bare.textOptions, undefined);
});

test("ref 替换：heading → 编号，image/table → 图N/表N，多 run 数组也处理", () => {
  const contexts = [
    H("h-1", 1, "概述"),
    H("h-2", 2, "背景"),
    { id: "img-1", type: "image", src: "a.png", caption: "架构" },
    { id: "tbl-1", type: "table", caption: "参数", columnWidths: [1], data: [{ texts: ["x"] }] },
    { id: "p-1", type: "text", text: "见 {{ref:h-2}}、{{ref:img-1}} 和 {{ref:tbl-1}}。" },
    { id: "p-2", type: "text", text: ["前半 {{ref:h-1}}，", "后半 {{ref:img-1}}"] },
  ];
  const { def, warnings } = transform({ meta: { autoNumber: true }, contexts });
  const p1 = def.contexts.find((n) => n.id === "p-1");
  assert.strictEqual(p1.text, "见 1.1、图1 和 表1。");
  const p2 = def.contexts.find((n) => n.id === "p-2");
  assert.deepStrictEqual(p2.text, ["前半 1，", "后半 图1"]);
  assert.deepStrictEqual(warnings, []);
});

test("悬空 ref → [引用缺失:id] + warning", () => {
  const contexts = [{ id: "p-1", type: "text", text: "见 {{ref:ghost}}" }];
  const { def, warnings } = transform({ meta: { autoNumber: true }, contexts });
  assert.strictEqual(def.contexts[0].text, "见 [引用缺失:ghost]");
  assert.strictEqual(warnings.length, 1);
});

test("autoNumber 关闭时 ref → [引用未解析:id] + warning；caption 不带编号", () => {
  const contexts = [
    H("h-1", 1, "1 概述"),
    { id: "img-1", type: "image", src: "a.png", caption: "图1 架构图" },
    { id: "p-1", type: "text", text: "见 {{ref:h-1}}" },
  ];
  const { def, warnings } = transform({ meta: { autoNumber: false }, contexts });
  assert.strictEqual(def.contexts.find((n) => n.id === "p-1").text, "见 [引用未解析:h-1]");
  assert.strictEqual(def.contexts[2].text, "图1 架构图"); // 原样，不加"图N"前缀
  assert.strictEqual(warnings.length, 1);
});

test("buildNumberIndex：sectionPath 按 heading 树位置，封面区为空串", () => {
  const contexts = [
    { id: "p-cover", type: "text", text: "封面标题" },
    H("h-1", 1, "概述"),
    { id: "p-1", type: "text", text: "正文" },
    H("h-2", 2, "背景"),
    { id: "tbl-1", type: "table", columnWidths: [1], data: [{ texts: ["x"] }] },
  ];
  const { byId } = buildNumberIndex(contexts);
  assert.strictEqual(byId["p-cover"].sectionPath, "");
  assert.strictEqual(byId["h-1"].sectionPath, "1");
  assert.strictEqual(byId["p-1"].sectionPath, "1");
  assert.strictEqual(byId["h-2"].sectionPath, "1.1");
  assert.strictEqual(byId["tbl-1"].sectionPath, "1.1");
  assert.strictEqual(byId["tbl-1"].label, "表1");
});

test("toc 静态展开：标题+分级条目带内链，maxLevel 过滤；native 透传", () => {
  const contexts = [
    { id: "toc-1", type: "toc" },
    H("h-1", 1, "概述"),
    H("h-2", 2, "背景"),
    H("h-3", 3, "细节"),
    { id: "p-1", type: "text", text: "正文" },
  ];
  const { def } = transform({ meta: { autoNumber: true }, contexts });
  const [title, e1, e2, e3] = def.contexts;
  assert.deepStrictEqual(title, { type: "text", text: "目录", paragraphOptions: { style: "tocTitle" } });
  assert.deepStrictEqual(e1, {
    type: "text", text: "1 概述",
    textOptions: { link: "#h-1", style: "tocEntry" },
    paragraphOptions: { style: "toc1" },
  });
  assert.strictEqual(e2.paragraphOptions.style, "toc2");
  assert.strictEqual(e3.text, "1.1.1 细节");
  assert.ok(!def.contexts.some((n) => n.type === "toc"), "静态展开后无 toc 节点");

  // maxLevel 只收一级；title 可自定义
  const lv1 = transform({ meta: { autoNumber: true }, contexts: [
    { type: "toc", maxLevel: 1, title: "章节索引" }, ...contexts.slice(1),
  ] }).def.contexts;
  assert.strictEqual(lv1[0].text, "章节索引");
  assert.deepStrictEqual(lv1.filter((n) => n.paragraphOptions && /^toc\d$/.test(n.paragraphOptions.style)).length, 1);

  // autoNumber 关闭：条目无编号
  const off = transform({ meta: { autoNumber: false }, contexts }).def.contexts;
  assert.strictEqual(off[1].text, "概述");

  // native：域节点透传给渲染层，但标题段照样服务端出（域 alias 不是可见标题）
  const nat = transform({ meta: { autoNumber: true }, contexts: [
    { id: "toc-1", type: "toc", native: true, maxLevel: 2 }, ...contexts.slice(1),
  ] }).def.contexts;
  assert.deepStrictEqual(nat[0], { type: "text", text: "目录", paragraphOptions: { style: "tocTitle" } });
  assert.deepStrictEqual(nat[1], { id: "toc-1", type: "toc", native: true, maxLevel: 2 });
});

test("target=word：toc 默认走原生域；节点显式 native:false 仍以节点为准", () => {
  const contexts = [{ id: "toc-1", type: "toc" }, H("h-1", 1, "概述")];
  const word = transform({ meta: {}, contexts }, { autoNumber: true, target: "word" }).def.contexts;
  assert.strictEqual(word[0].paragraphOptions.style, "tocTitle", "native 前有可见标题段");
  assert.strictEqual(word[1].type, "toc");
  assert.strictEqual(word[1].native, true);
  const forced = transform({ meta: {}, contexts: [
    { id: "toc-1", type: "toc", native: false }, H("h-1", 1, "概述"),
  ] }, { autoNumber: true, target: "word" }).def.contexts;
  assert.ok(forced.every((n) => n.type !== "toc"), "显式 native:false 静态展开");
  const uni = transform({ meta: {}, contexts }, { autoNumber: true, target: "universal" }).def.contexts;
  assert.ok(uni.every((n) => n.type !== "toc"), "universal 静态展开");
});

test("buildNumberIndex：restartNumbering 章号/图表号按节清零，ref 解析按目标自己的标签", () => {
  const contexts = [
    { id: "h-1", type: "heading", level: 1, text: "甲" },
    { id: "tbl-1", type: "table", caption: "一", columnWidths: [1], data: [{ texts: ["x"] }] },
    { id: "sec-1", type: "sectionBreak", restartNumbering: true },
    { id: "h-2", type: "heading", level: 1, text: "乙" },
    { id: "tbl-2", type: "table", caption: "二", columnWidths: [1], data: [{ texts: ["x"] }] },
  ];
  const { byId } = buildNumberIndex(contexts);
  assert.strictEqual(byId["h-1"].number, "1");
  assert.strictEqual(byId["h-2"].number, "1", "章号重启");
  assert.strictEqual(byId["tbl-1"].label, "表1");
  assert.strictEqual(byId["tbl-2"].label, "表1", "表号重启");
  assert.strictEqual(byId["h-2"].sectionPath, "1");
  // 不带 restartNumbering 的 sectionBreak 不影响编号
  const cont = buildNumberIndex(contexts.map((n) => n.id === "sec-1" ? { ...n, restartNumbering: undefined } : n));
  assert.strictEqual(cont.byId["h-2"].number, "2");
  assert.strictEqual(cont.byId["tbl-2"].label, "表2");
  // {{ref:}} 指向重启节里的节点，取的是它自己的标签
  const { def, warnings } = transform({ meta: { autoNumber: true }, contexts: [
    ...contexts,
    { id: "p-ref", type: "text", text: "见{{ref:tbl-2}}。" },
  ] }, { autoNumber: true });
  assert.deepStrictEqual(warnings, []);
  const refText = def.contexts[def.contexts.length - 1].text;
  assert.strictEqual(refText, "见表1。");
});

test("浮动图：不占图号、caption 丢弃 + warn、{{ref:}} 指向它按不可编号处理", () => {
  const contexts = [
    { id: "img-f", type: "image", src: "logo.png", caption: "商标", float: { horizontal: "right" } },
    { id: "img-1", type: "image", src: "a.png", caption: "架构" },
    { id: "p-1", type: "text", text: "见{{ref:img-1}}与{{ref:img-f}}。" },
  ];
  const { byId } = buildNumberIndex(contexts);
  assert.strictEqual(byId["img-f"].label, undefined, "浮动图无图号");
  assert.strictEqual(byId["img-1"].label, "图1", "普通图从 1 起，不被浮动图挤位");
  const { def, warnings } = transform({ meta: { autoNumber: true }, contexts }, { autoNumber: true });
  assert.ok(warnings.some((w) => w.includes("img-f") && w.includes("caption 已忽略")));
  assert.ok(warnings.some((w) => w.includes("ref 悬空") && w.includes("img-f")));
  const floatOut = def.contexts.find((n) => n.id === "img-f");
  assert.ok(floatOut && !floatOut.caption, "float 图节点保留但 caption 剥掉");
  assert.ok(!def.contexts.some((n) => typeof n.text === "string" && n.text.includes("商标")), "没有生成浮动图的图题段");
  const refText = def.contexts.find((n) => n.id === "p-1").text;
  assert.ok(refText.includes("图1") && refText.includes("[引用缺失:img-f]"));
});
