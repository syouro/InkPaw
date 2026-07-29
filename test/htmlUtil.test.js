// htmlUtil.test.js — def → HTML 草稿视图（docs/editable-preview.md §3.2、§3.3，P1）
const { test } = require("node:test");
const assert = require("node:assert");
const { renderHtml, splitLeaf } = require("../src/htmlUtil");
const { transform } = require("../src/transform");

/** 走真实链路：def → transform（产 _src）→ HTML */
const render = (contexts, meta = { autoNumber: true }, opts) =>
  renderHtml(transform({ meta, contexts }).def, opts || {});

// ---------------------------------------------------------------- splitLeaf

test("splitLeaf 恒等：无 raw 时整条可编辑", () => {
  assert.deepStrictEqual(splitLeaf("普通正文", undefined, ""), [{ type: "text", value: "普通正文" }]);
});

test("splitLeaf 剥前缀：编号不进可编辑区", () => {
  assert.deepStrictEqual(splitLeaf("1 概述", "概述", "1 "), [{ type: "text", value: "概述" }]);
});

test("splitLeaf 切出 ref 标签", () => {
  assert.deepStrictEqual(splitLeaf("如 表1 所示。", "如 {{ref:t1}} 所示。", ""), [
    { type: "text", value: "如 " },
    { type: "ref", id: "t1", label: "表1" },
    { type: "text", value: " 所示。" },
  ]);
});

test("splitLeaf：ref 在首、在尾都能切", () => {
  assert.deepStrictEqual(splitLeaf("表1 是数据", "{{ref:t1}} 是数据", ""), [
    { type: "ref", id: "t1", label: "表1" },
    { type: "text", value: " 是数据" },
  ]);
  assert.deepStrictEqual(splitLeaf("数据见 图2", "数据见 {{ref:i2}}", ""), [
    { type: "text", value: "数据见 " },
    { type: "ref", id: "i2", label: "图2" },
  ]);
});

test("splitLeaf：前缀对不上 → 降级只读（null）", () => {
  assert.strictEqual(splitLeaf("概述", "概述", "1 "), null);
});

test("splitLeaf：连续 ref 边界不可判定 → 降级只读", () => {
  assert.strictEqual(splitLeaf("表1图2 见上", "{{ref:t1}}{{ref:i2}} 见上", ""), null);
});

// ---------------------------------------------------------------- 可编辑标注

test("正文段落：可编辑叶子带 node-id 与 path", () => {
  const { html } = render([{ id: "p1", type: "text", text: "正文内容" }]);
  assert.match(html, /<span class="ip-leaf" contenteditable="true" data-node-id="p1" data-path="text"[^>]*>正文内容<\/span>/);
});

test("标题：编号是只读 chip，落在可编辑容器外", () => {
  const { html } = render([
    { id: "h1", type: "heading", level: 1, text: "概述" },
    { id: "h2", type: "heading", level: 2, text: "背景" },
  ]);
  assert.match(html, /<h1 [^>]*data-node-id="h1"/);
  assert.match(html, /<h2 [^>]*data-node-id="h2"/);
  assert.match(html, /<span class="ip-num" contenteditable="false">1\.1 <\/span>/);
  assert.match(html, /<span class="ip-leaf" contenteditable="true" data-node-id="h2" data-path="text"[^>]*>背景<\/span>/);
  assert.ok(!/ip-leaf[^>]*>1(\.1)? /.test(html), "编号不得落进可编辑区");
});

test("ref 渲染成只读 chip，带 data-ref", () => {
  const { html } = render([
    { id: "t1", type: "table", data: [{ texts: ["a"] }] },
    { id: "p1", type: "text", text: "见 {{ref:t1}} 的数据" },
  ]);
  assert.match(html, /<span class="ip-ref" contenteditable="false" data-ref="t1">表1<\/span>/);
  assert.match(html, /data-node-id="p1" data-path="text"[^>]*>见 <span class="ip-ref"/);
});

test("多 run：每个 run 是独立可编辑容器（编辑孤岛）", () => {
  const { html } = render([{ id: "p1", type: "text", text: ["前言", "强调", "结尾"] }]);
  for (const [i, t] of [[0, "前言"], [1, "强调"], [2, "结尾"]]) {
    assert.match(html, new RegExp(`data-node-id="p1" data-path="text\\[${i}\\]"[^>]*>${t}</span>`));
  }
  assert.strictEqual((html.match(/class="ip-leaf"/g) || []).length, 3);
});

test("run 级 footnote/comment 可编辑，路径带 run 下标", () => {
  const { html } = render([{
    id: "p1", type: "text", text: ["前", "后"],
    textOptions: [{ footnote: "脚注内容" }, { comment: "批注内容" }],
  }]);
  assert.match(html, /data-node-id="p1" data-path="textOptions\[0\]\.footnote"[^>]*>脚注内容</);
  assert.match(html, /data-node-id="p1" data-path="textOptions\[1\]\.comment"[^>]*>批注内容</);
});

test("单 run 的 footnote 路径不带下标", () => {
  const { html } = render([{ id: "p1", type: "text", text: "正文", textOptions: { footnote: "脚注" } }]);
  assert.match(html, /data-path="textOptions\.footnote"[^>]*>脚注</);
});

// ---------------------------------------------------------------- 派生节点

test("图题：写回路径指向 image 的 caption，不是 text", () => {
  const { html } = render([{ id: "img1", type: "image", src: "a.png", caption: "现场照片" }]);
  assert.match(html, /<span class="ip-num" contenteditable="false">图1 <\/span>/);
  assert.match(html, /data-node-id="img1" data-path="caption"[^>]*>现场照片<\/span>/);
});

test("checklist 两种条目形态的写回路径不同", () => {
  const { html } = render([{
    id: "ck1", type: "checklist", items: ["第一项", { text: "第二项", checked: true }],
  }]);
  assert.match(html, /data-node-id="ck1" data-path="items\[0\]"[^>]*>第一项</);
  assert.match(html, /data-node-id="ck1" data-path="items\[1\]\.text"[^>]*>第二项</);
});

test("checklist：勾选态可见且只读，分隔空格不出可见 chip", () => {
  const { html } = render([{
    id: "ck1", type: "checklist", items: ["未勾", { text: "已勾", checked: true }],
  }]);
  assert.match(html, /<span class="ip-checkbox" contenteditable="false">☐<\/span>/);
  assert.match(html, /<span class="ip-checkbox" contenteditable="false">☑<\/span>/);
  assert.ok(!/<span class="ip-num" contenteditable="false"> <\/span>/.test(html), "纯空白前缀不出可见 chip");
});

// ---------------------------------------------------------------- 表格

test("表格三种单元格形态都可编辑，路径按实际 texts 下标", () => {
  const { html } = render([{
    id: "t1", type: "table",
    data: [
      { texts: ["纯字符串", ["多行A", "多行B"]] },
      { texts: [{ text: "对象格", bold: true }] },
    ],
  }]);
  assert.match(html, /data-path="data\[0\]\.texts\[0\]"[^>]*>纯字符串</);
  assert.match(html, /data-path="data\[0\]\.texts\[1\]\[0\]"[^>]*>多行A</);
  assert.match(html, /data-path="data\[0\]\.texts\[1\]\[1\]"[^>]*>多行B</);
  assert.match(html, /data-path="data\[1\]\.texts\[0\]\.text"[^>]*>对象格</);
});

test("表格 span：cNo 按 texts 下标落到 rowspan/colspan，缺位格不占下标", () => {
  const { html } = render([{
    id: "t1", type: "table",
    data: [
      { texts: ["环境", "温湿度", "说明"] },
      { texts: ["结构温度", "50 点"] }, // 第 0 列被上一行 rowSpan 覆盖，缺位
    ],
    tableOptions: { span: { 0: { spanType: "rowSpan", spanCounts: 2, cNo: [0] } } },
  }]);
  assert.match(html, /<td rowspan="2">/);
  // 第二行只有两个格，且下标从 0 起（视觉上它们在第 2、3 列）
  assert.match(html, /data-path="data\[1\]\.texts\[0\]"[^>]*>结构温度</);
  assert.match(html, /data-path="data\[1\]\.texts\[1\]"[^>]*>50 点</);
});

test("headerRows 渲染成 th 并支持 colspan", () => {
  const { html } = render([{
    id: "t1", type: "table",
    data: [{ texts: ["合并表头", "C"] }, { texts: ["a", "b", "c"] }],
    tableOptions: { headerRows: 1, span: { 0: { spanType: "columnSpan", spanCounts: 2, cNo: [0] } } },
  }]);
  assert.match(html, /<th colspan="2">/);
  assert.match(html, /<td>/);
});

// ---------------------------------------------------------------- 只读与安全默认

test("目录整体只读：无可编辑容器", () => {
  const { html } = render([
    { id: "toc1", type: "toc", title: "目录" },
    { id: "h1", type: "heading", level: 1, text: "概述" },
  ]);
  const toc = html.slice(0, html.indexOf("<h1"));
  assert.ok(!toc.includes('contenteditable="true"'), "目录区不得出现可编辑容器");
  assert.match(toc, /data-readonly="true"/);
});

test("无 id 的节点不可编辑（无 _src 即只读）", () => {
  const { html } = render([{ type: "text", text: "没有 id" }]);
  assert.ok(!html.includes('contenteditable="true"'));
  assert.match(html, /<span class="ip-ro">没有 id<\/span>/);
});

test("math 一期整体只读", () => {
  const { html } = render([{ id: "m1", type: "math", latex: "x^2" }]);
  assert.match(html, /class="ip-math" data-readonly="true"/);
  assert.ok(!html.includes('contenteditable="true"'));
});

test("不渲染页眉页脚（草稿视图无分页概念）", () => {
  const { html } = render([{ id: "p1", type: "text", text: "正文" }],
    { autoNumber: true, headerText: "机密报告 IP-2026-001", pageNumber: true });
  assert.ok(!html.includes("机密报告"), "页眉文字不得出现在草稿视图");
});

// ---------------------------------------------------------------- 转义

test("HTML 转义：正文里的尖括号引号不破坏结构", () => {
  const { html } = render([{ id: "p1", type: "text", text: '<script>alert("x")</script>' }]);
  assert.ok(!html.includes("<script>"), "不得注入标签");
  assert.match(html, /&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt;/);
});

test("HTML 转义：表格单元格与图题同样转义", () => {
  const { html } = render([
    { id: "t1", type: "table", caption: "<b>题</b>", data: [{ texts: ["<i>格</i>"] }] },
  ]);
  assert.ok(!html.includes("<b>") && !html.includes("<i>"));
});

// ---------------------------------------------------------------- 图片与 warnings

test("图片：给了 imageSrc 出 img，没给出占位并 warn", () => {
  const node = [{ id: "img1", type: "image", src: "a.png" }];
  const withUrl = render(node, { autoNumber: true }, { imageSrc: () => "/api/img/a.png" });
  assert.match(withUrl.html, /<img src="\/api\/img\/a\.png" alt="">/);
  assert.strictEqual(withUrl.warnings.length, 0);

  const noUrl = render(node);
  assert.match(noUrl.html, /ip-img-placeholder/);
  assert.strictEqual(noUrl.warnings.length, 1);
});

// ---------------------------------------------------------------- 结构

test("分页与分节渲染成分隔线，空行保留占位", () => {
  const { html } = render([
    { type: "newPage" }, { type: "blank" }, { id: "s1", type: "sectionBreak" },
  ]);
  assert.match(html, /<hr class="ip-pagebreak">/);
  assert.match(html, /<p class="ip-blank"><\/p>/);
  assert.match(html, /<hr class="ip-sectionbreak">/);
});

test("整份文档包在 ip-doc 里，且不依赖 MCP/SQLite/LibreOffice", () => {
  const { html } = render([{ id: "p1", type: "text", text: "正文" }]);
  assert.match(html, /^<article class="ip-doc">/);
  assert.match(html, /<\/article>$/);
});

// ---------------------------------------------------------------- pageRef

test("{{pageRef:}} 不被 transform 解析，但同样锁成只读 chip", () => {
  const { html } = render([
    { id: "h1", type: "heading", level: 1, text: "概述" },
    { id: "p1", type: "text", text: "详见第 {{pageRef:h1}} 页。" },
  ]);
  assert.match(html, /<span class="ip-ref" contenteditable="false" data-pageref="h1">页码<\/span>/);
  assert.ok(!html.includes("{{pageRef:"), "字面量不得留在可编辑区里");
  // 前后文字仍可编辑
  assert.match(html, /data-path="text"[^>]*>详见第 <span class="ip-ref"/);
});

test("ref 与 pageRef 混排都能切", () => {
  const { html } = render([
    { id: "h1", type: "heading", level: 1, text: "概述" },
    { id: "t1", type: "table", data: [{ texts: ["a"] }] },
    { id: "p1", type: "text", text: "见 {{ref:t1}}（第 {{pageRef:h1}} 页）。" },
  ]);
  assert.match(html, /data-ref="t1">表1</);
  assert.match(html, /data-pageref="h1">页码</);
});

// ---------------------------------------------------------------- 写回用的规范路径

test("data-path 是展示形，data-path-json 是回传用的规范段数组", () => {
  const { html } = render([{
    id: "t1", type: "table", data: [{ texts: [["多行A", "多行B"]] }],
  }]);
  assert.match(html, /data-path="data\[0\]\.texts\[0\]\[1\]"/);
  assert.match(html, /data-path-json="\[&quot;data&quot;,0,&quot;texts&quot;,0,1\]"/);
});
