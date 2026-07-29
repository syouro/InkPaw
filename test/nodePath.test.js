// nodePath.test.js — 可编辑叶子白名单与路径读写（docs/editable-preview.md §3.2）
const { test } = require("node:test");
const assert = require("node:assert");
const { editableLeaves, isEditable, readPath, writePath, formatPath } = require("../src/nodePath");

const leaves = (node) => editableLeaves(node).map(formatPath);

// ---------------------------------------------------------------- 展示形

test("formatPath 生成 data[0].texts[2][1] 形式", () => {
  assert.strictEqual(formatPath(["data", 0, "texts", 2, 1]), "data[0].texts[2][1]");
  assert.strictEqual(formatPath(["text"]), "text");
  assert.strictEqual(formatPath(["textOptions", 1, "footnote"]), "textOptions[1].footnote");
});

// ---------------------------------------------------------------- text / heading

test("text 单 run：正文一条叶子", () => {
  assert.deepStrictEqual(leaves({ type: "text", text: "正文" }), ["text"]);
});

test("text 多 run：逐 run 一条叶子", () => {
  const node = { type: "text", text: ["前", "中", "后"] };
  assert.deepStrictEqual(leaves(node), ["text[0]", "text[1]", "text[2]"]);
});

test("textOptions 对象形：footnote/comment 可编辑，样式字段只读", () => {
  const node = {
    type: "text", text: "正文",
    textOptions: { bold: true, size: 24, footnote: "脚注内容", comment: "批注内容" },
  };
  assert.deepStrictEqual(leaves(node), ["text", "textOptions.footnote", "textOptions.comment"]);
  assert.strictEqual(isEditable(node, ["textOptions", "bold"]), false);
  assert.strictEqual(isEditable(node, ["textOptions", "size"]), false);
});

test("textOptions 数组形：run 级 footnote/comment 带下标", () => {
  const node = {
    type: "text",
    text: ["前", "中", "后"],
    textOptions: [{ bold: true }, { footnote: "见附录" }, { comment: "待核" }],
  };
  assert.deepStrictEqual(leaves(node),
    ["text[0]", "text[1]", "text[2]", "textOptions[1].footnote", "textOptions[2].comment"]);
});

test("heading：正文可编辑，level 只读", () => {
  const node = { type: "heading", level: 2, text: "概述" };
  assert.deepStrictEqual(leaves(node), ["text"]);
  assert.strictEqual(isEditable(node, ["level"]), false);
});

// ---------------------------------------------------------------- image

test("image：只有 caption 可编辑，src/float 只读", () => {
  const node = { type: "image", src: "a.png", float: true, caption: "现场照片" };
  assert.deepStrictEqual(leaves(node), ["caption"]);
  assert.strictEqual(isEditable(node, ["src"]), false);
  assert.strictEqual(isEditable(node, ["float"]), false);
});

test("image 无 caption：无可编辑叶子", () => {
  assert.deepStrictEqual(leaves({ type: "image", src: "a.png" }), []);
});

// ---------------------------------------------------------------- table 三种单元格形态

test("table 单元格三形态全覆盖：字符串 / 数组（格内多行）/ 对象（格级样式）", () => {
  const node = {
    type: "table",
    caption: "实测数据",
    columnWidths: [2000, 3000],
    data: [
      { texts: ["纯字符串", ["格内第一行", "格内第二行"]] },
      { texts: [{ text: "对象格", bold: true }, { text: ["对象格多行A", "对象格多行B"] }] },
    ],
  };
  assert.deepStrictEqual(leaves(node), [
    "caption",
    "data[0].texts[0]",
    "data[0].texts[1][0]",
    "data[0].texts[1][1]",
    "data[1].texts[0].text",
    "data[1].texts[1].text[0]",
    "data[1].texts[1].text[1]",
  ]);
  assert.strictEqual(isEditable(node, ["columnWidths", 0]), false);
  assert.strictEqual(isEditable(node, ["data", 1, "texts", 0, "bold"]), false);
});

test("table：span 覆盖导致的缺位格不占下标，路径按实际 texts 数组走", () => {
  // examples/demo-report.js 的场景：第 0 列被上一行 rowSpan 覆盖，这一行省略该格
  const node = { type: "table", data: [{ texts: ["环境", "温湿度", "说明"] }, { texts: ["结构温度", "50 点"] }] };
  assert.deepStrictEqual(leaves(node), [
    "data[0].texts[0]", "data[0].texts[1]", "data[0].texts[2]",
    "data[1].texts[0]", "data[1].texts[1]",
  ]);
  assert.strictEqual(isEditable(node, ["data", 1, "texts", 2]), false);
});

// ---------------------------------------------------------------- checklist

test("checklist 两种条目形态：字符串与对象", () => {
  const node = { type: "checklist", items: ["第一项", { text: "第二项", checked: true }] };
  assert.deepStrictEqual(leaves(node), ["items[0]", "items[1].text"]);
  assert.strictEqual(isEditable(node, ["items", 1, "checked"]), false);
});

// ---------------------------------------------------------------- 默认只读

test("未列入白名单的节点类型默认只读", () => {
  assert.deepStrictEqual(leaves({ type: "math", latex: "x^2" }), []);
  assert.deepStrictEqual(leaves({ type: "toc", title: "目录" }), []);
  assert.deepStrictEqual(leaves({ type: "newPage" }), []);
  // sectionBreak 的页眉页脚走独立的类型化配置通道（§3.5），不走字符串叶子解析器
  assert.deepStrictEqual(leaves({ type: "sectionBreak", headerText: "页眉" }), []);
});

test("非对象输入不炸", () => {
  assert.deepStrictEqual(editableLeaves(null), []);
  assert.deepStrictEqual(editableLeaves(undefined), []);
  assert.deepStrictEqual(editableLeaves("字符串"), []);
});

// ---------------------------------------------------------------- 读

test("readPath 命中嵌套叶子", () => {
  const node = { type: "table", data: [{ texts: [["A", "B"]] }] };
  assert.deepStrictEqual(readPath(node, ["data", 0, "texts", 0, 1]), { ok: true, value: "B" });
});

test("readPath 路径不存在返回 NOT_FOUND，不抛异常", () => {
  const node = { type: "text", text: "正文" };
  assert.strictEqual(readPath(node, ["nope"]).code, "NOT_FOUND");
  assert.strictEqual(readPath(node, ["text", 0, "deep"]).code, "NOT_FOUND");
});

test("readPath 空路径与非法段被拒", () => {
  const node = { type: "text", text: "正文" };
  assert.strictEqual(readPath(node, []).code, "BAD_PATH");
  assert.strictEqual(readPath(node, ["text", -1]).code, "BAD_SEGMENT");
  assert.strictEqual(readPath(node, ["text", 1.5]).code, "BAD_SEGMENT");
});

// ---------------------------------------------------------------- 写

test("writePath 替换叶子并返回新节点，原节点不动（不可变更新）", () => {
  const node = { type: "text", text: ["前", "中", "后"] };
  const r = writePath(node, ["text", 1], "改过的");
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.node.text, ["前", "改过的", "后"]);
  assert.deepStrictEqual(node.text, ["前", "中", "后"], "原节点必须未被修改");
  assert.notStrictEqual(r.node.text, node.text, "路径上的容器必须是新对象");
});

test("writePath 深层写入只克隆路径上的容器", () => {
  const node = {
    type: "table",
    data: [{ texts: ["保持不变"] }, { texts: [{ text: ["A", "B"] }] }],
  };
  const r = writePath(node, ["data", 1, "texts", 0, "text", 0], "改过的");
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.node.data[1].texts[0].text[0], "改过的");
  assert.strictEqual(node.data[1].texts[0].text[0], "A", "原节点必须未被修改");
  assert.strictEqual(r.node.data[0], node.data[0], "路径外的分支应共享引用");
});

test("writePath 保留同层的其他字段（格级样式不丢）", () => {
  const node = { type: "table", data: [{ texts: [{ text: "旧", bold: true }] }] };
  const r = writePath(node, ["data", 0, "texts", 0, "text"], "新");
  assert.deepStrictEqual(r.node.data[0].texts[0], { text: "新", bold: true });
});

test("writePath 拒绝非白名单路径（即使该路径确实存在）", () => {
  const node = { type: "text", text: "正文", textOptions: { bold: true } };
  const r = writePath(node, ["textOptions", "bold"], "不该写进来");
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, "NOT_EDITABLE");
});

test("writePath 拒绝非字符串新值", () => {
  const node = { type: "text", text: "正文" };
  assert.strictEqual(writePath(node, ["text"], 42).code, "BAD_VALUE");
  assert.strictEqual(writePath(node, ["text"], null).code, "BAD_VALUE");
  assert.strictEqual(writePath(node, ["text"], ["数组"]).code, "BAD_VALUE");
});

test("writePath 拒绝越界下标", () => {
  const node = { type: "text", text: ["前", "后"] };
  const r = writePath(node, ["text", 5], "越界");
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, "NOT_EDITABLE");
});

test("writePath 不创建中间结构", () => {
  const node = { type: "text", text: "正文" };
  const r = writePath(node, ["meta", "headerText"], "偷偷加字段");
  assert.strictEqual(r.ok, false);
  assert.ok(!("meta" in node));
});

test("writePath 拒绝原型污染路径", () => {
  const node = { type: "text", text: "正文" };
  for (const seg of ["__proto__", "constructor", "prototype"]) {
    const r = writePath(node, [seg, "polluted"], "yes");
    assert.strictEqual(r.ok, false, `${seg} 必须被拒`);
    assert.strictEqual(r.code, "BAD_SEGMENT");
  }
  assert.strictEqual({}.polluted, undefined, "Object.prototype 未被污染");
});

test("writePath 拒绝把子树替换成标量", () => {
  const node = { type: "text", text: ["前", "后"] };
  const r = writePath(node, ["text"], "整个数组换成字符串");
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, "NOT_EDITABLE");
});

test("整次失败不做部分写入", () => {
  const node = { type: "table", data: [{ texts: ["A", "B"] }] };
  const before = JSON.stringify(node);
  writePath(node, ["data", 0, "texts", 9], "越界");
  writePath(node, ["data", 0, "columnWidths"], "非白名单");
  assert.strictEqual(JSON.stringify(node), before);
});
