// validator.test.js — docs/architecture.md 校验规则逐条覆盖
const { test } = require("node:test");
const assert = require("node:assert");
const path = require("path");
const { validate, hasErrors } = require("../src/validator");

const rules = (issues) => issues.map((i) => i.rule);

test("合法 def 无 issue", () => {
  const def = {
    contexts: [
      { id: "h-1", type: "heading", level: 1, text: "概述" },
      { id: "p-1", type: "text", text: "正文，见 {{ref:h-1}}。" },
      { type: "newPage" },
      { type: "blank" },
    ],
  };
  assert.deepStrictEqual(validate(def), []);
});

test("def 形状不对 → error", () => {
  assert.ok(hasErrors(validate(null)));
  assert.ok(hasErrors(validate({})));
  assert.ok(hasErrors(validate({ contexts: "not-array" })));
});

test("未知节点类型 → error", () => {
  const issues = validate({ contexts: [{ type: "chart" }] });
  assert.ok(rules(issues).includes("unknown-type"));
});

test("缺必填字段 → error", () => {
  const issues = validate({
    contexts: [
      { type: "text" },                 // 缺 text
      { type: "heading", level: 1 },    // 缺 text
      { type: "image" },                // 缺 src
      { type: "table" },                // 缺 data
    ],
  });
  assert.strictEqual(issues.filter((i) => i.rule === "missing-field").length, 4);
});

test("id 重复 → error；id 非法 → error", () => {
  const dup = validate({ contexts: [
    { id: "p-1", type: "blank" },
    { id: "p-1", type: "blank" },
  ] });
  assert.ok(rules(dup).includes("id-duplicate"));
  const bad = validate({ contexts: [{ id: "", type: "blank" }] });
  assert.ok(rules(bad).includes("id-invalid"));
});

test("无 span 表格：行格数 ≠ 列数 → error，报错带坐标和修复建议", () => {
  const issues = validate({ contexts: [{
    type: "table",
    columnWidths: [1000, 1000, 1000],
    data: [
      { texts: ["a", "b", "c"] },
      { texts: ["a", "b"] }, // 少一格
    ],
  }] });
  const hit = issues.find((i) => i.rule === "table-col-mismatch");
  assert.ok(hit);
  assert.match(hit.message, /第 1 行/);
  assert.match(hit.message, /改为 3 格（少 1 格）/, "带修复后的 texts 长度");
});

test("单元格类型非法 → error，精确到行列坐标", () => {
  const issues = validate({ contexts: [{
    type: "table",
    columnWidths: [1000, 1000],
    data: [
      { texts: ["a", { bad: true }] },       // 对象格非法
      { texts: [["多", "段"], null] },        // string[] 与 null 合法
    ],
  }] });
  const cellIssues = issues.filter((i) => i.rule === "table-cell-type");
  assert.strictEqual(cellIssues.length, 1);
  assert.match(cellIssues[0].message, /第 0 行第 1 格/);
});

test("无 columnWidths 表格：行间格数不齐 → warn（列宽按最宽行等分）", () => {
  const issues = validate({ contexts: [{
    type: "table",
    data: [
      { texts: ["a", "b", "c"] },
      { texts: ["a"] },
    ],
  }] });
  const hit = issues.find((i) => i.rule === "table-col-inconsistent");
  assert.ok(hit);
  assert.strictEqual(hit.level, "warn");
  assert.match(hit.message, /第 1 行.*改为 3 格（少 2 格）/s);
  // 行数一致则不报
  const ok = validate({ contexts: [{ type: "table", data: [{ texts: ["a", "b"] }, { texts: ["c", "d"] }] }] });
  assert.deepStrictEqual(ok, []);
});

test("rowSpan 铺网格：正确的省略 → 通过", () => {
  const issues = validate({ contexts: [{
    type: "table",
    columnWidths: [1000, 1000, 1000],
    data: [
      { texts: ["类别", "项目", "说明"] },
      { texts: ["环境", "温湿度", "x"] },
      { texts: ["结构温度", "y"] }, // 第 0 格被上一行 rowSpan 覆盖，省略
      { texts: ["响应", "应变", "z"] },
    ],
    tableOptions: { span: { "1": { spanType: "rowSpan", spanCounts: 2, cNo: [0] } } },
  }] });
  assert.deepStrictEqual(issues, []);
});

test("rowSpan 铺网格：被覆盖行没省略格子 → error", () => {
  const issues = validate({ contexts: [{
    type: "table",
    columnWidths: [1000, 1000, 1000],
    data: [
      { texts: ["a", "b", "c"] },
      { texts: ["合并", "x", "y"] },
      { texts: ["没省略", "x", "y"] }, // 应省略第 0 格却给了 3 格
    ],
    tableOptions: { span: { "1": { spanType: "rowSpan", spanCounts: 2, cNo: [0] } } },
  }] });
  assert.ok(rules(issues).includes("table-span-mismatch"));
});

test("rowSpan 超出剩余行数 → error", () => {
  const issues = validate({ contexts: [{
    type: "table",
    columnWidths: [1000, 1000],
    data: [
      { texts: ["合并", "x"] },
      { texts: ["y"] },
    ],
    tableOptions: { span: { "0": { spanType: "rowSpan", spanCounts: 5, cNo: [0] } } },
  }] });
  assert.ok(rules(issues).includes("table-span-mismatch"));
});

test("columnSpan：占多列后行格数按吃掉的列数缩减", () => {
  const ok = validate({ contexts: [{
    type: "table",
    columnWidths: [1000, 1000, 1000],
    data: [
      { texts: ["跨两列", "c"] }, // columnSpan=2 吃掉 1 格
      { texts: ["a", "b", "c"] },
    ],
    tableOptions: { span: { "0": { spanType: "columnSpan", spanCounts: 2, cNo: [0] } } },
  }] });
  assert.deepStrictEqual(ok, []);
});

test("ref 悬空 → warn；存在则不报", () => {
  const issues = validate({ contexts: [
    { id: "h-1", type: "heading", level: 1, text: "概述" },
    { id: "p-1", type: "text", text: "见 {{ref:h-1}} 和 {{ref:h-none}}" },
  ] });
  const dangling = issues.filter((i) => i.rule === "ref-dangling");
  assert.strictEqual(dangling.length, 1);
  assert.strictEqual(dangling[0].level, "warn");
});

test("多 run text 里的 ref 也能查到", () => {
  const issues = validate({ contexts: [
    { id: "p-1", type: "text", text: ["前半，", "见 {{ref:ghost}}"] },
  ] });
  assert.ok(rules(issues).includes("ref-dangling"));
});

test("图片文件不存在 → warn（给了 imagesBaseDir 才查）", () => {
  const def = { contexts: [{ type: "image", src: "no-such.png", width: 10, height: 10 }] };
  assert.deepStrictEqual(validate(def), []); // 不给 baseDir 不查
  const issues = validate(def, { imagesBaseDir: path.join(__dirname, "..") });
  assert.ok(rules(issues).includes("image-missing"));
  assert.strictEqual(issues[0].level, "warn");
});

test("autoNumber 开启 + heading 手写编号 → warn；关闭则不报", () => {
  const def = { contexts: [{ type: "heading", level: 1, text: "1 概述" }] };
  const on = validate(def, { autoNumber: true });
  assert.ok(rules(on).includes("heading-manual-number"));
  assert.deepStrictEqual(validate(def, { autoNumber: false }), []);
  // meta.autoNumber 也认
  const viaMeta = validate({ meta: { autoNumber: true }, contexts: def.contexts });
  assert.ok(rules(viaMeta).includes("heading-manual-number"));
});

test("heading 层级跳跃 → warn；逐级递进不报", () => {
  const jump = validate({ contexts: [
    { type: "heading", level: 1, text: "一" },
    { type: "heading", level: 3, text: "三" },
  ] });
  assert.ok(rules(jump).includes("heading-skip"));
  const ok = validate({ contexts: [
    { type: "heading", level: 1, text: "一" },
    { type: "heading", level: 2, text: "二" },
    { type: "heading", level: 1, text: "回到一" },
  ] });
  assert.deepStrictEqual(ok, []);
});

test("link 校验：协议白名单，危险协议 error；内链悬空/非标题 warn", () => {
  const issues = validate({ contexts: [
    { id: "h-1", type: "heading", level: 1, text: "章" },
    { id: "p-ok", type: "text", text: ["官网", "邮箱", "跳章"],
      textOptions: [{ link: "https://x.com" }, { link: "mailto:a@b.c" }, { link: "#h-1" }] },
    { id: "p-bad", type: "text", text: "坏", textOptions: { link: "javascript:alert(1)" } },
    { id: "p-dangling", type: "text", text: "悬", textOptions: [{ link: "#nope" }] },
    { id: "p-not-heading", type: "text", text: "非标题", textOptions: { link: "#p-ok" } },
    { id: "p-empty", type: "text", text: "空", textOptions: { link: "" } },
  ] });
  const byRule = (r) => issues.filter((i) => i.rule === r);
  assert.strictEqual(byRule("link-unsafe").length, 1);
  assert.strictEqual(byRule("link-unsafe")[0].nodeId, "p-bad");
  assert.strictEqual(byRule("link-unsafe")[0].level, "error");
  assert.strictEqual(byRule("link-dangling")[0].nodeId, "p-dangling");
  assert.strictEqual(byRule("link-target-not-heading")[0].nodeId, "p-not-heading");
  assert.strictEqual(byRule("link-invalid")[0].nodeId, "p-empty");
  assert.ok(!issues.some((i) => i.nodeId === "p-ok"), "合法链接不报");
});

test("toc 节点：合法类型，无必填字段", () => {
  assert.deepStrictEqual(validate({ contexts: [{ type: "toc" }] }), []);
});

test("内链目标放宽到 image/table（书签随 pageRef 那期补齐），text 目标仍 warn", () => {
  const issues = validate({ contexts: [
    { id: "tbl-1", type: "table", data: [{ texts: ["a"] }] },
    { id: "img-1", type: "image", src: "x.png" },
    { id: "p-1", type: "text", text: "正文" },
    { type: "text", text: ["跳表", "跳图", "跳段"],
      textOptions: [{ link: "#tbl-1" }, { link: "#img-1" }, { link: "#p-1" }] },
  ] });
  const hits = issues.filter((i) => i.rule === "link-target-not-heading");
  assert.strictEqual(hits.length, 1, "只有 text 目标报 warn");
  assert.match(hits[0].message, /#p-1/);
});

test("pageRef 校验：悬空/目标类型 warn；target 非 word 全文档一条 viewer warn", () => {
  const base = [
    { id: "h-1", type: "heading", level: 1, text: "章" },
    { id: "tbl-1", type: "table", data: [{ texts: ["a"] }] },
    { id: "p-txt", type: "text", text: "正文" },
  ];
  const ok = validate({ meta: { target: "word" }, contexts: [
    ...base,
    { type: "text", text: "见第 {{pageRef:h-1}} 页与第 {{pageRef:tbl-1}} 页" },
  ] });
  assert.deepStrictEqual(ok, []);
  const bad = validate({ meta: { target: "word" }, contexts: [
    ...base,
    { id: "p-ref", type: "text", text: ["第 {{pageRef:nope}} 页", "第 {{pageRef:p-txt}} 页"] },
  ] });
  assert.strictEqual(rules(bad).filter((r) => r === "pageref-dangling").length, 1);
  assert.strictEqual(rules(bad).filter((r) => r === "pageref-target-invalid").length, 1);
  assert.ok(!rules(bad).includes("pageref-viewer"), "target=word 不报 viewer");
  // 默认 universal：viewer warn 全文档只报一条（计数在消息里）
  const universal = validate({ contexts: [
    ...base,
    { type: "text", text: "见第 {{pageRef:h-1}} 页" },
    { type: "text", text: "另见第 {{pageRef:tbl-1}} 页" },
  ] });
  const viewer = universal.filter((i) => i.rule === "pageref-viewer");
  assert.strictEqual(viewer.length, 1);
  assert.match(viewer[0].message, /2 处/);
  // opts.target（服务层三层合并结果）优先于 def.meta
  const optsWin = validate({ contexts: [
    ...base, { type: "text", text: "第 {{pageRef:h-1}} 页" },
  ] }, { target: "word" });
  assert.ok(!rules(optsWin).includes("pageref-viewer"));
});

test("checklist 校验：字符串/{text,checked} 合法，非法项报坐标", () => {
  const ok = validate({ contexts: [
    { type: "checklist", items: ["整理数据", { text: "复核", checked: true }] },
  ] });
  assert.deepStrictEqual(ok, []);
  const bad = validate({ contexts: [
    { type: "checklist", items: ["合法项", "", { checked: true }, { text: "口径", checked: "yes" }] },
  ] });
  const hits = bad.filter((i) => i.rule === "checklist-item-invalid");
  assert.strictEqual(hits.length, 3);
  assert.match(hits[0].message, /第 1 项/);
  assert.match(hits[1].message, /第 2 项/);
  assert.match(hits[2].message, /第 3 项/);
  const missing = validate({ contexts: [{ type: "checklist" }] });
  assert.ok(rules(missing).includes("missing-field"));
  const empty = validate({ contexts: [{ type: "checklist", items: [] }] });
  assert.ok(rules(empty).includes("checklist-item-invalid"));
});

test("单格级样式：对象格合法，未知键/坏 text 报坐标", () => {
  const ok = validate({ contexts: [{
    type: "table", columnWidths: [2000, 2000],
    data: [{ texts: ["a", { text: "b", textOptions: { bold: true }, paragraphOptions: { alignment: "center" } }] }],
  }] });
  assert.deepStrictEqual(ok, []);
  const badKey = validate({ contexts: [{
    type: "table", columnWidths: [2000],
    data: [{ texts: [{ text: "x", style: "nope" }] }],
  }] });
  const hit = badKey.find((i) => i.rule === "table-cell-type");
  assert.ok(hit);
  assert.match(hit.message, /未知键 style/);
  const badText = validate({ contexts: [{
    type: "table", columnWidths: [2000],
    data: [{ texts: [{ textOptions: { bold: true } }] }], // 缺 text
  }] });
  assert.ok(rules(badText).includes("table-cell-type"));
});

test("base64 图片校验：合法跳过文件检查，坏格式 error，超大 warn", () => {
  const png1px = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  const ok = validate({ contexts: [{ type: "image", src: png1px }] }, { imagesBaseDir: "/nonexistent" });
  assert.deepStrictEqual(ok, [], "data URI 不查文件系统");
  const bad = validate({ contexts: [{ type: "image", src: "data:text/plain;base64,aGk=" }] });
  assert.ok(rules(bad).includes("image-base64-invalid"));
  const huge = validate({ contexts: [{ type: "image", src: "data:image/png;base64," + "A".repeat(7.5 * 1024 * 1024) }] });
  assert.ok(rules(huge).includes("image-base64-too-large"));
});

test("comment 校验：非空字符串合法，空/非字符串 error", () => {
  const ok = validate({ contexts: [
    { type: "text", text: "数据待核", textOptions: { comment: "来源需要人工核实" } },
  ] });
  assert.deepStrictEqual(ok, []);
  const mk = (comment) => validate({ contexts: [{ type: "text", text: "x", textOptions: { comment } }] });
  assert.ok(rules(mk("")).includes("comment-invalid"));
  assert.ok(rules(mk("  ")).includes("comment-invalid"));
  assert.ok(rules(mk(42)).includes("comment-invalid"));
});

test("footnote 校验：非空字符串合法，空/非字符串 error", () => {
  const ok = validate({ contexts: [
    { type: "text", text: "论断", textOptions: { footnote: "来源说明" } },
  ] });
  assert.deepStrictEqual(ok, []);
  const bad = validate({ contexts: [
    { id: "p-1", type: "text", text: "空", textOptions: { footnote: " " } },
    { id: "p-2", type: "text", text: "数字", textOptions: [{ footnote: 42 }] },
  ] });
  assert.strictEqual(bad.filter((i) => i.rule === "footnote-invalid").length, 2);
});

test("textOptions.math 校验：布尔合法，坏 LaTeX warn，非布尔/空文本 error", () => {
  const ok = validate({ contexts: [
    { type: "text", text: ["方差 ", "\\sigma^2", " 已知"], textOptions: [{}, { math: true }, {}] },
  ] });
  assert.deepStrictEqual(ok, []);
  const badSyntax = validate({ contexts: [
    { id: "m-1", type: "text", text: "\\frac{1}", textOptions: { math: true } },
  ] });
  assert.ok(rules(badSyntax).includes("math-syntax"));
  const bad = validate({ contexts: [
    { id: "m-2", type: "text", text: "x", textOptions: { math: "yes" } },
    { id: "m-3", type: "text", text: "  ", textOptions: { math: true } },
  ] });
  assert.strictEqual(bad.filter((i) => i.rule === "math-run-invalid").length, 2);
  // 单对象 textOptions 作用于全部 run：每个 run 的文本都按 LaTeX 查
  const multi = validate({ contexts: [
    { id: "m-4", type: "text", text: ["a^2", "\\frac{1}"], textOptions: { math: true } },
  ] });
  assert.strictEqual(rules(multi).filter((r) => r === "math-syntax").length, 1);
});

test("keepTogether 非 boolean → warn", () => {
  const mk = (keepTogether) => validate({ contexts: [
    { type: "table", data: [{ texts: ["a"] }], tableOptions: { keepTogether } },
  ] });
  assert.ok(rules(mk("yes")).includes("table-keep-together"));
  assert.ok(rules(mk(1)).includes("table-keep-together"));
  assert.deepStrictEqual(mk(true), []);
  assert.deepStrictEqual(mk(false), []);
});

test("headerRows 越界/非整数 → warn", () => {
  const mk = (headerRows) => validate({ contexts: [
    { type: "table", data: [{ texts: ["a"] }, { texts: ["b"] }], tableOptions: { headerRows } },
  ] });
  assert.ok(rules(mk(3)).includes("table-header-rows"), "超过行数");
  assert.ok(rules(mk(-1)).includes("table-header-rows"));
  assert.ok(rules(mk(1.5)).includes("table-header-rows"));
  assert.deepStrictEqual(mk(2), [], "等于行数合法");
});

// ---- 多 section（sectionBreak）
test("合法 sectionBreak：横向/分栏/重启页码/清页眉 → 无 issue", () => {
  const def = { meta: { headerText: "报告" }, contexts: [
    { id: "p-1", type: "text", text: "首节" },
    { id: "sec-1", type: "sectionBreak", headerText: "", pageNumberStart: 1, pageNumberFormat: "lowerRoman" },
    { id: "p-2", type: "text", text: "前置页" },
    { id: "sec-2", type: "sectionBreak", landscape: true, columns: 2, pageNumberStart: 1, pageNumberFormat: "decimal", breakType: "nextPage" },
    { id: "p-3", type: "text", text: "横向双栏" },
  ] };
  assert.deepStrictEqual(validate(def), []);
});

test("sectionBreak 非法枚举/非正整数 → error section-invalid", () => {
  const r = (node) => rules(validate({ contexts: [node, { type: "text", text: "b" }] }));
  assert.ok(r({ type: "sectionBreak", breakType: "sideways" }).includes("section-invalid"));
  assert.ok(r({ type: "sectionBreak", pageNumberFormat: "hex" }).includes("section-invalid"));
  assert.ok(r({ type: "sectionBreak", pageNumberStart: 0 }).includes("section-invalid"));
  assert.ok(r({ type: "sectionBreak", pageNumberStart: 1.5 }).includes("section-invalid"));
  // 合法枚举不报
  assert.ok(!r({ type: "sectionBreak", breakType: "continuous", pageNumberFormat: "upperRoman", pageNumberStart: 3 }).includes("section-invalid"));
});

test("sectionBreak columns 边界 → warn（1 无意义 / >4 偏多 / 非法形态）", () => {
  const r = (columns) => rules(validate({ contexts: [
    { type: "sectionBreak", columns }, { type: "text", text: "b" },
  ] }));
  assert.ok(r(1).includes("section-invalid"), "1 栏 warn");
  assert.ok(r(9).includes("section-invalid"), ">4 warn");
  assert.ok(r("two").includes("section-invalid"), "非法形态 warn");
  assert.ok(!r(2).includes("section-invalid"), "2 栏合法");
  assert.ok(!r({ count: 3, space: "0.5cm" }).includes("section-invalid"), "对象形合法");
});

test("sectionBreak margins 认不出长度 → warn，回退默认", () => {
  const r = (margins) => rules(validate({ contexts: [
    { type: "sectionBreak", margins }, { type: "text", text: "b" },
  ] }));
  assert.ok(r({ top: "3指" }).includes("section-invalid"));
  assert.ok(!r({ top: "2cm", left: 1440 }).includes("section-invalid"));
});

test("首节点即 sectionBreak → warn section-empty-first", () => {
  const issues = validate({ contexts: [
    { type: "sectionBreak", landscape: true }, { type: "text", text: "b" },
  ] });
  assert.ok(rules(issues).includes("section-empty-first"));
});

test("continuous 但方向/边距变了 → warn section-continuous-conflict", () => {
  const conflict = validate({ contexts: [
    { type: "text", text: "a" },
    { type: "sectionBreak", breakType: "continuous", landscape: true },
    { type: "text", text: "b" },
  ] });
  assert.ok(rules(conflict).includes("section-continuous-conflict"));
  // continuous 只换分栏（方向边距不变）不冲突
  const ok = validate({ contexts: [
    { type: "text", text: "a" },
    { type: "sectionBreak", breakType: "continuous", columns: 2 },
    { type: "text", text: "b" },
  ] });
  assert.ok(!rules(ok).includes("section-continuous-conflict"));
});

test("表格超宽按所在节版心判定（横向节更宽）", () => {
  // 10000 twips 表：纵向默认版心(~8312)超宽，横向版心(~13244)不超
  const tableNode = { type: "table", columnWidths: [5000, 5000], data: [{ texts: ["a", "b"] }] };
  const portrait = validate({ contexts: [tableNode] }, { meta: {} });
  assert.ok(rules(portrait).includes("table-width-overflow"), "纵向节超宽");
  const landscape = validate({ contexts: [
    { type: "sectionBreak", landscape: true }, tableNode,
  ] }, { meta: {} });
  assert.ok(!rules(landscape).includes("table-width-overflow"), "横向节不超宽");
});

test("image.float：非法枚举/未知字段/多图/otherChildren 全 warn 不 error", () => {
  const issues = validate({ contexts: [
    { id: "img-1", type: "image", src: ["a.png", "b.png"],
      otherChildren: { left: { text: "x" } },
      float: { wrap: "zigzag", horizontal: "middle", vertical: { offset: "3" , relative: "cell" }, distance: -1, foo: 1 } },
  ] });
  const floats = issues.filter((i) => i.rule === "image-float-invalid");
  assert.ok(floats.every((i) => i.level === "warn"), "全部 warn 级（渲染回退不炸）");
  const msgs = floats.map((i) => i.message).join("\n");
  assert.match(msgs, /wrap 非法/);
  assert.match(msgs, /horizontal 非法/);
  assert.match(msgs, /offset 应是数字/);
  assert.match(msgs, /relative 非法/);
  assert.match(msgs, /distance 应是/);
  assert.match(msgs, /未知字段 "foo"/);
  assert.match(msgs, /只支持单图/);
  assert.match(msgs, /otherChildren/);
  // 合法 float 零 issue
  assert.deepStrictEqual(validate({ contexts: [
    { id: "img-2", type: "image", src: "a.png",
      float: { wrap: "tight", horizontal: { offset: 100, relative: "page" }, vertical: "top", distance: 8 } },
  ] }).filter((i) => i.rule === "image-float-invalid"), []);
  // float 非对象也是 warn（按普通图排版）
  const bad = validate({ contexts: [{ id: "img-3", type: "image", src: "a.png", float: true }] });
  assert.ok(bad.some((i) => i.rule === "image-float-invalid" && i.level === "warn" && /普通图/.test(i.message)));
});

// ---- numbering reference 白名单（docx@8.5 未注册引用 → w:numId 占位符字面量 → Word 拒开）

test("numbering.reference 未注册 → error", () => {
  const issues = validate({ contexts: [
    { id: "p-1", type: "text", text: "条目",
      paragraphOptions: { numbering: { reference: "md-number", level: 0 } } },
  ] });
  const hit = issues.find((i) => i.rule === "numbering-ref-unknown");
  assert.ok(hit && hit.level === "error");
  assert.match(hit.message, /md-number/);
  assert.match(hit.message, /default-numbering/); // 消息里带可用引用清单
});

test("numbering.reference 已注册（default / meta.numbering.config / headingNumbering）→ 无 issue", () => {
  const meta = {
    numbering: { config: [{ reference: "md-ordered", levels: [] }] },
    headingNumbering: { reference: "heading-num", levels: [] },
  };
  const def = { meta, contexts: [
    { id: "p-1", type: "text", text: "a",
      paragraphOptions: { numbering: { reference: "default-numbering", level: 0 } } },
    { id: "p-2", type: "text", text: "b",
      paragraphOptions: { numbering: { reference: "md-ordered", level: 1, instance: 2 } } },
    { id: "p-3", type: "text", text: "c",
      paragraphOptions: { numbering: { reference: "heading-num", level: 0 } } },
  ] };
  // 服务层传合并后 meta（opts.meta）；直接传 def.meta 等价
  assert.deepStrictEqual(validate(def, { meta }), []);
});

test("numbering 形状非法 → error numbering-invalid", () => {
  const issues = validate({ contexts: [
    { id: "p-1", type: "text", text: "a", paragraphOptions: { numbering: "md-ordered" } },
    { id: "p-2", type: "text", text: "b", paragraphOptions: { numbering: { level: 0 } } },
  ] });
  assert.strictEqual(issues.filter((i) => i.rule === "numbering-invalid" && i.level === "error").length, 2);
});

test("表格行级/格级 numbering 同样受白名单约束", () => {
  const issues = validate({ contexts: [
    { id: "tbl-1", type: "table", data: [
      { texts: ["表头"], paragraphOptions: { numbering: { reference: "nope-row", level: 0 } } },
      { texts: [{ text: "格", paragraphOptions: { numbering: { reference: "nope-cell", level: 0 } } }] },
    ] },
  ] });
  const hits = issues.filter((i) => i.rule === "numbering-ref-unknown");
  assert.strictEqual(hits.length, 2);
  assert.ok(hits.some((i) => /nope-row/.test(i.message) && /第 0 行/.test(i.message)));
  assert.ok(hits.some((i) => /nope-cell/.test(i.message) && /第 1 行第 0 格/.test(i.message)));
});

// ---- 标点全半角（punctStyle）----

test("标点全半角：中文段落里的半角标点 → warn，带位置和建议", () => {
  const issues = validate({ contexts: [
    { id: "p-1", type: "text", text: "结论如下:第一,情况良好!" },
  ] });
  const hit = issues.find((i) => i.rule === "punct-width");
  assert.ok(hit);
  assert.strictEqual(hit.nodeId, "p-1");
  assert.match(hit.message, /3 处/);
  assert.match(hit.message, /建议 "："/);
});

test("标点全半角：纯西文段落里的全角标点 → warn", () => {
  const issues = validate({ contexts: [
    { type: "text", text: "See the docs，then continue。" },
  ] });
  assert.ok(rules(issues).includes("punct-width"));
});

test("标点全半角：数字/标识符/URL/引用标记/行内公式不误报", () => {
  const issues = validate({ contexts: [
    { id: "h-1", type: "heading", level: 1, text: "1. 概述" },
    { type: "text", text: "增长 3.14 倍（约 1,000 条），详见 Node.js 与 https://example.com/a:b?q=1 和 {{ref:h-1}}。" },
    { type: "text", text: ["公式 ", "x_{1,2}=f(a,b)", " 成立。"],
      textOptions: [{}, { math: true }, {}] },
    { type: "text", text: "函数 f(x) 在 16:30 验证。" },
  ] });
  assert.ok(!rules(issues).includes("punct-width"));
});

test("标点全半角：西文为主的混排只查紧邻中文，不动纯西文标点", () => {
  const issues = validate({ contexts: [
    { type: "text", text: "This paragraph mentions 中文 only briefly, and that is fine." },
    { type: "text", text: "The term 术语,appears here." }, // 半角逗号紧贴中文 → 报
  ] });
  assert.strictEqual(issues.filter((i) => i.rule === "punct-width").length, 1);
});

test("punctStyle 显式声明优先于内容推断", () => {
  const issues = validate({ contexts: [
    { type: "text", punctStyle: "half", text: "All good, really." },
    { id: "p-bad", type: "text", punctStyle: "half", text: "Wrong width。" },
    { type: "text", punctStyle: "full", text: "中文口径（正确）。" },
  ] });
  const hits = issues.filter((i) => i.rule === "punct-width");
  assert.strictEqual(hits.length, 1);
  assert.strictEqual(hits[0].nodeId, "p-bad");
});

test("meta.punctStyle 提供全文档默认，节点声明可覆盖", () => {
  const issues = validate({
    meta: { punctStyle: "full" },
    contexts: [
      { id: "p-1", type: "text", text: "结论如下:" },          // 跟 meta 的 full → 报
      { type: "text", punctStyle: "half", text: "English, ok." }, // 节点覆盖 → 不报
    ],
  });
  const hits = issues.filter((i) => i.rule === "punct-width");
  assert.strictEqual(hits.length, 1);
  assert.strictEqual(hits[0].nodeId, "p-1");
});

test("punctStyle 非法值 → warn 并回退 auto", () => {
  const issues = validate({ contexts: [
    { type: "text", punctStyle: "fullwidth", text: "你好。" },
  ] });
  assert.ok(rules(issues).includes("punct-style-invalid"));
  assert.ok(!rules(issues).includes("punct-width"));
});

test("表格单元格与 checklist 项也查标点", () => {
  const issues = validate({ contexts: [
    { id: "t-1", type: "table", columnWidths: [1000, 1000],
      data: [{ texts: ["情况良好,", { text: "正常。" }] }] },
    { id: "c-1", type: "checklist", items: ["检查完毕.", { text: "全角（对）。" }] },
  ] });
  const hits = issues.filter((i) => i.rule === "punct-width");
  assert.deepStrictEqual(hits.map((i) => i.nodeId).sort(), ["c-1", "t-1"]);
});
