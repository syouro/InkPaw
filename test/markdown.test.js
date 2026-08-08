// markdown.test.js — Markdown 输入链路：markdownToDef 单测 + create_document_from_markdown 集成
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const JSZip = require("jszip");
const { markdownToDef } = require("../src/markdown");
const { createService } = require("../src/service");

const IMAGES_DIR = path.join(__dirname, "..", "examples", "images"); // demo.png 40x30

const makeService = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "docx-mcp-md-"));
  const service = createService({
    dbPath: path.join(dir, "t.db"),
    outputDir: path.join(dir, "output"),
    profilePath: path.join(dir, "style-profile.json"),
  });
  return { service, dir, cleanup: () => { service.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
};

// ---------------------------------------------------------------- 单测：块级

test("标题：level 对应、行内样式拍平成纯文本", () => {
  const { contexts } = markdownToDef("# 一级\n\n### 带 **粗** 和 `码` 的三级\n");
  assert.deepStrictEqual(contexts[0], { type: "heading", level: 1, text: "一级" });
  assert.strictEqual(contexts[1].level, 3);
  assert.strictEqual(contexts[1].text, "带 粗 和 码 的三级");
});

test("标题手写编号：autoNumber 开启时剥掉交给服务端，聚合 warn；关闭时原样保留", () => {
  const md = "# 1. 概述\n\n## 1.1 背景\n\n## 2、方法\n\n# 2026 年度报告\n\n# 3.5倍速时代\n";
  const on = markdownToDef(md, { autoNumber: true });
  assert.deepStrictEqual(on.contexts.map((n) => n.text),
    ["概述", "背景", "方法", "2026 年度报告", "3.5倍速时代"],
    "1./1.1/2、剥掉；年份、小数开头不误伤");
  const warns = on.issues.filter((i) => i.rule === "md-heading-number");
  assert.strictEqual(warns.length, 1, "聚合成一条 warn");
  assert.ok(warns[0].message.includes("3 处") && warns[0].message.includes("1. 概述"));

  const off = markdownToDef(md, { autoNumber: false });
  assert.strictEqual(off.contexts[0].text, "1. 概述", "autoNumber 关闭不剥");
  assert.ok(!off.issues.some((i) => i.rule === "md-heading-number"));
});

test("[toc] 独占一段 → toc 节点；混在文字里不触发", () => {
  const { contexts } = markdownToDef("# 章\n\n[TOC]\n\n正文提到 [toc] 不算。\n");
  assert.deepStrictEqual(contexts[1], { type: "toc" });
  assert.strictEqual(contexts.filter((n) => n.type === "toc").length, 1);
});

test("段落行内混排：bold/italic/行内代码 → 多 run + textOptions 数组", () => {
  const { contexts } = markdownToDef("前，**粗**后*斜*加 `code` 收。\n");
  const [p] = contexts;
  assert.strictEqual(p.type, "text");
  assert.strictEqual(p.paragraphOptions.style, "normalParagraph");
  assert.deepStrictEqual(p.text, ["前，", "粗", "后", "斜", "加 ", "code", " 收。"]);
  assert.deepStrictEqual(p.textOptions[1], { bold: true });
  assert.deepStrictEqual(p.textOptions[3], { italics: true });
  assert.deepStrictEqual(p.textOptions[5], { style: "mdCodeChar" });
});

test("软换行：中文之间无缝拼接，英文之间补空格；硬换行拆成两个段落", () => {
  const cjk = markdownToDef("中文换行\n接着写。\n").contexts;
  assert.deepStrictEqual(cjk[0].text, ["中文换行", "接着写。"]);
  const latin = markdownToDef("hello\nworld\n").contexts;
  assert.deepStrictEqual(latin[0].text, ["hello", " ", "world"]);
  const hard = markdownToDef("上半段  \n下半段\n").contexts;
  assert.strictEqual(hard.length, 2);
  assert.strictEqual(hard[0].text, "上半段");
  assert.strictEqual(hard[1].text, "下半段");
});

test("链接：http(s)/mailto 转原生 link run；其他协议保持文字展开 + warn", () => {
  const { contexts } = markdownToDef("见 [设计文档](https://example.com/d) 和 <https://example.com/d>。\n");
  const [p] = contexts;
  const linkRuns = p.textOptions.map((o, i) => ({ text: p.text[i], ...o })).filter((r) => r.link);
  assert.deepStrictEqual(linkRuns, [
    { text: "设计文档", link: "https://example.com/d" },
    { text: "https://example.com/d", link: "https://example.com/d" },
  ], "链接文字不再展开 url，autolink 文字即 url");

  const rel = markdownToDef("看 [本地文件](./a.md) 吧。\n");
  const joined = rel.contexts[0].text.join("");
  assert.ok(joined.includes("本地文件（./a.md）"), "相对路径降级为文字展开");
  assert.ok(!JSON.stringify(rel.contexts[0].textOptions || {}).includes('"link"'));
  assert.ok(rel.issues.some((i) => i.rule === "md-link-unsupported"));

  const mail = markdownToDef("联系 [我](mailto:a@b.c)。\n").contexts[0];
  assert.ok(mail.textOptions.some((o) => o.link === "mailto:a@b.c"));
});

test("链接：链接内的加粗样式与 link 共存", () => {
  const { contexts } = markdownToDef("[**重点**链接](https://x.com)\n");
  const [p] = contexts;
  assert.deepStrictEqual(p.textOptions[0], { bold: true, link: "https://x.com" });
  assert.deepStrictEqual(p.textOptions[1], { link: "https://x.com" });
});

// ---------------------------------------------------------------- 单测：列表

test("有序列表：原生 numbering、每个顶层列表独立 instance（编号重启）", () => {
  const md = "1. 甲\n2. 乙\n\n段落隔开。\n\n1. 丙\n";
  const { contexts } = markdownToDef(md);
  const items = contexts.filter((n) => n.paragraphOptions && n.paragraphOptions.numbering);
  assert.strictEqual(items.length, 3);
  const [a, b, c] = items.map((n) => n.paragraphOptions.numbering);
  assert.strictEqual(a.reference, "md-ordered");
  assert.strictEqual(a.instance, b.instance, "同一列表共享 instance");
  assert.notStrictEqual(a.instance, c.instance, "第二个列表独立 instance，从 1 重计");
  assert.ok(items.every((n) => n.paragraphOptions.style === "mdList"));
});

test("嵌套列表：level 递增；有序嵌在有序里继承 instance；无序走 md-bullet 编号", () => {
  const md = "1. 甲\n   1. 甲一\n2. 乙\n\n- 点一\n  - 点二\n";
  const { contexts } = markdownToDef(md);
  const byRef = (ref) => contexts.filter(
    (n) => n.paragraphOptions && n.paragraphOptions.numbering && n.paragraphOptions.numbering.reference === ref);
  const ordered = byRef("md-ordered");
  assert.deepStrictEqual(ordered.map((n) => n.paragraphOptions.numbering.level), [0, 1, 0]);
  assert.strictEqual(new Set(ordered.map((n) => n.paragraphOptions.numbering.instance)).size, 1);
  // 无序不走 docx 的 bullet 选项（库会追加 ListParagraph pStyle，和 mdList 撞成重复 pStyle）
  const bullets = byRef("md-bullet");
  assert.deepStrictEqual(bullets.map((n) => n.paragraphOptions.numbering.level), [0, 1]);
  assert.ok(contexts.every((n) => !n.paragraphOptions || !n.paragraphOptions.bullet));
});

test("有序列表起始编号非 1：warn 并从 1 重排", () => {
  const { issues } = markdownToDef("3. 从三开始\n4. 继续\n");
  assert.ok(issues.some((i) => i.rule === "md-list-start"));
});

test("任务列表：- [ ] / - [x] 转 checkbox run，剥前缀、不出 bullet 编号", () => {
  const { contexts } = markdownToDef("- [ ] 整理数据\n- [x] 复核 **口径**\n- 普通项\n");
  assert.strictEqual(contexts[0].text, " 整理数据");
  assert.deepStrictEqual(contexts[0].textOptions, { checkbox: true });
  assert.strictEqual(contexts[0].paragraphOptions.style, "checklistItem");
  assert.strictEqual(contexts[0].paragraphOptions.numbering, undefined, "任务项不带 bullet 编号");
  assert.deepStrictEqual(contexts[1].textOptions[0], { checkbox: { checked: true } });
  assert.deepStrictEqual(contexts[1].text, [" 复核 ", "口径"]);
  assert.strictEqual(contexts[2].paragraphOptions.style, "mdList", "普通项照旧走 bullet");
  assert.ok(contexts[2].paragraphOptions.numbering, "普通项保留 bullet 编号");
});

// ---------------------------------------------------------------- 单测：表格/代码/引用/hr

test("表格：表头标记 headerRows（样式交给 preset tableStyle），各行列数一致", () => {
  const md = "| 列A | 列B |\n|---|---|\n| 1 | 2 |\n| 只有一格 |\n";
  const { contexts } = markdownToDef(md);
  const [tbl] = contexts;
  assert.strictEqual(tbl.type, "table");
  assert.strictEqual(tbl.columnWidths, undefined, "不给列宽，渲染层铺满版心");
  assert.deepStrictEqual(tbl.tableOptions, { headerRows: 1 }, "表头行数标记，跨页重复+preset 样式作用范围");
  assert.strictEqual(tbl.data[0].textOptions, undefined, "bold/居中不再写死在转换器");
  assert.ok(tbl.data.every((r) => r.texts.length === 2), "短行补齐空单元格");
});

test("代码块：逐行 mdCode 段落，缩进空格保留；行内 HTML 丢弃并 warn", () => {
  const { contexts, issues } = markdownToDef("```js\nif (a) {\n  b();\n}\n```\n");
  const lines = contexts.map((n) => n.text);
  assert.deepStrictEqual(lines, ["if (a) {", "  b();", "}"]);
  assert.ok(contexts.every((n) => n.paragraphOptions.style === "mdCode"));
  assert.deepStrictEqual(issues, []);
});

test("引用块与分隔线：mdQuote 样式；hr → thematicBreak", () => {
  const { contexts } = markdownToDef("> 引用第一段\n>\n> 第二段\n\n---\n");
  assert.strictEqual(contexts[0].paragraphOptions.style, "mdQuote");
  assert.strictEqual(contexts[1].paragraphOptions.style, "mdQuote");
  assert.deepStrictEqual(contexts[2].paragraphOptions, { thematicBreak: true });
});

// ---------------------------------------------------------------- 单测：图片

test("图片：存在的图按 imageMaxWidth 等比缩放，alt 进 caption", () => {
  const { contexts } = markdownToDef("![架构图](demo.png)\n", { imagesAbsDir: IMAGES_DIR, imageMaxWidth: 20 });
  const [img] = contexts;
  assert.strictEqual(img.type, "image");
  assert.strictEqual(img.caption, "架构图");
  assert.deepStrictEqual([img.width, img.height], [20, 15], "40x30 按 maxWidth 20 缩到 20x15");
});

test("图片：文件缺失不给尺寸（渲染层占位）；URL 图 warn；行内混排图降级占位", () => {
  const missing = markdownToDef("![占位](nope.png)\n", { imagesAbsDir: IMAGES_DIR });
  assert.strictEqual(missing.contexts[0].width, undefined);
  const url = markdownToDef("![远程](https://x.com/a.png)\n", { imagesAbsDir: IMAGES_DIR });
  assert.ok(url.issues.some((i) => i.rule === "md-image-url"));
  const inline = markdownToDef("文字和![图](demo.png)混排。\n", { imagesAbsDir: IMAGES_DIR });
  assert.strictEqual(inline.contexts[0].type, "text");
  assert.ok(inline.issues.some((i) => i.rule === "md-inline-image"));
});

// ---------------------------------------------------------------- 集成：服务层 + docx XML

test("行内公式：$...$ → math:true run；美元金额与转义 \\$ 不误伤", () => {
  const { contexts } = markdownToDef("均值 $\\mu$ 已知，花 $5 和 $6，转义 \\$10。\n");
  const [node] = contexts;
  assert.deepStrictEqual(node.text, ["均值 ", "\\mu", " 已知，花 $5 和 $6，转义 $10。"]);
  assert.deepStrictEqual(node.textOptions[1], { math: true });
  assert.deepStrictEqual(node.textOptions[2], {});
});

test("展示公式：$$ 独占一段 → 块级 math 节点（可跨行）；混排 $$ 按行内 run", () => {
  const { contexts } = markdownToDef("$$\nE = mc^2\n$$\n\n嵌在文中 $$a+b$$ 也能用。\n");
  assert.deepStrictEqual(contexts[0], { type: "math", latex: "E = mc^2" });
  assert.strictEqual(contexts[1].type, "text");
  assert.deepStrictEqual(contexts[1].textOptions[1], { math: true });
  assert.strictEqual(contexts[1].text[1], "a+b");
});

test("标题/表格里的公式退化为 LaTeX 纯文本", () => {
  const { contexts } = markdownToDef("# 关于 $\\sigma$ 的讨论\n\n| 指标 $x$ |\n|---|\n| 值 |\n");
  assert.strictEqual(contexts[0].text, "关于 \\sigma 的讨论");
  assert.strictEqual(contexts[1].data[0].texts[0], "指标 x");
});

test("脚注：[^1] → 空文本 run 挂 footnote，定义块不进正文；重复引用 warn", () => {
  const { contexts, issues } = markdownToDef([
    "结论[^1]，另见[^n]。再引[^1]。", "",
    "[^1]: 来源甲。", "",
    "[^n]: 来源乙，含 $t$ 检验。", "",
  ].join("\n"));
  assert.strictEqual(contexts.length, 1, "定义块被吃掉，只剩正文一段");
  const node = contexts[0];
  const fnRuns = node.textOptions.filter((o) => o.footnote);
  assert.deepStrictEqual(fnRuns.map((o) => o.footnote), ["来源甲。", "来源乙，含 t 检验。", "来源甲。"]);
  fnRuns.forEach((o, i) => assert.strictEqual(node.text[node.textOptions.indexOf(o, i)], ""));
  assert.ok(!node.text.join("").includes("[^1]"), "引用标记不留在正文");
  assert.strictEqual(issues.filter((i) => i.rule === "md-footnote-ref-duplicate").length, 1);
});

test("脚注：无定义的 [^x] 保持字面量；多段定义并成一句", () => {
  const { contexts } = markdownToDef("悬空[^x]。\n\n有定义[^a]。\n\n[^a]: 第一段。\n\n    第二段。\n");
  assert.ok(contexts[0].text.includes("[^x]"), "无定义引用保持原文");
  const fn = contexts[1].textOptions.find((o) => o && o.footnote);
  assert.strictEqual(fn.footnote, "第一段。 第二段。");
});

test("集成：markdown 公式+脚注 → 渲染出行内 oMath 与 footnotes.xml", async () => {
  const { service, cleanup } = makeService();
  try {
    const md = [
      "# 统计", "",
      "方差 $\\sigma^2$ 衡量离散[^1]。", "",
      "$$", "s^2 = \\frac{1}{n-1}\\sum_{i=1}^{n}(x_i-\\mu)^2", "$$", "",
      "[^1]: 见《统计方法》。", "",
    ].join("\n");
    const { docId, issues } = service.createDocumentFromMarkdown({ title: "md-math-fn", markdown: md });
    assert.deepStrictEqual(issues.filter((i) => i.level === "error"), []);
    const res = await service.renderDocument({ docId });
    assert.strictEqual(res.ok, true);
    const zip = await JSZip.loadAsync(fs.readFileSync(res.path));
    const doc = await zip.file("word/document.xml").async("string");
    assert.strictEqual((doc.match(/<m:oMath>/g) || []).length, 2, "行内 + 块级各一处 OMML");
    assert.ok(/衡量离散<\/w:t><\/w:r>(?:(?!<\/w:p>).)*footnoteReference/s.test(doc), "脚注标记跟在正文 run 后");
    const fnXml = await zip.file("word/footnotes.xml").async("string");
    assert.ok(fnXml.includes("见《统计方法》。"), "脚注内容进 footnotes.xml");
  } finally {
    cleanup();
  }
});

test("集成：markdown 建档 → 校验零 error → 渲染，XML 结构正确", async () => {
  const { service, cleanup } = makeService();
  try {
    const md = [
      "# 概述", "",
      "正文含 **重点** 和 `code`。", "",
      "1. 第一", "2. 第二", "",
      "又一个列表：", "",
      "1. 重新计数", "",
      "- 圆点", "",
      "| 表头 | 说明 |", "|---|---|", "| a | b |", "",
      "> 引用", "",
      "---", "",
      "![架构](demo.png)", "",
    ].join("\n");
    const { docId, issues } = service.createDocumentFromMarkdown({
      title: "md-e2e", markdown: md, baseDir: IMAGES_DIR,
    });
    assert.deepStrictEqual(issues.filter((i) => i.level === "error"), []);

    const outline = service.getOutline({ docId });
    assert.strictEqual(outline[0].type, "heading");
    assert.ok(outline.every((n) => n.id), "服务端补齐节点 id");

    const res = await service.renderDocument({ docId });
    assert.strictEqual(res.ok, true);
    const zip = await JSZip.loadAsync(fs.readFileSync(res.path));
    const doc = await zip.file("word/document.xml").async("string");
    const numbering = await zip.file("word/numbering.xml").async("string");
    const styles = await zip.file("word/styles.xml").async("string");

    assert.ok(doc.includes("1 概述"), "autoNumber 给 heading 编号");
    assert.ok(doc.includes("<w:numPr>"), "列表用原生编号，不是文本前缀");
    assert.ok(!doc.includes(">- 圆点<"), "无序项没有渲染成 '- xxx' 文本");
    const numIds = [...doc.matchAll(/<w:numId w:val="(\d+)"\/>/g)].map((m) => m[1]);
    assert.ok(new Set(numIds).size >= 3, `两个有序列表 + bullet 至少 3 个 numId 实例，实际 ${[...new Set(numIds)]}`);
    assert.ok(numbering.match(/<w:num /g).length >= 3, "numbering.xml 有对应 ConcreteNumbering");
    assert.ok(styles.includes('w:styleId="mdCodeChar"'), "行内代码字符样式注入");
    assert.ok(styles.includes('w:styleId="mdCode"') && styles.includes('w:styleId="mdQuote"'), "preset 段落样式注入");
    assert.ok(doc.includes("<w:pBdr>"), "hr 生成 thematicBreak 底边框");
    assert.ok(doc.includes("图1 架构"), "图片 alt 走 caption，autoNumber 展开为图题");
    assert.ok(doc.includes("w:blipFill") || doc.includes("<pic:pic"), "图片真实嵌入");
  } finally {
    cleanup();
  }
});

test("集成：meta 透传——autoNumber:false 时手写编号标题不 warn、渲染无双重编号", async () => {
  const { service, cleanup } = makeService();
  try {
    const md = "# 1. 概述\n\n正文段落。\n\n## 1.1 背景\n\n背景内容。\n";
    const { docId, issues } = service.createDocumentFromMarkdown({
      markdown: md, meta: { autoNumber: false },
    });
    assert.ok(!issues.some((i) => i.rule === "heading-manual-number"), "autoNumber 关闭后不再报手写编号 warn");
    const res = await service.renderDocument({ docId });
    assert.strictEqual(res.ok, true);
    const zip = await JSZip.loadAsync(fs.readFileSync(res.path));
    const doc = await zip.file("word/document.xml").async("string");
    assert.ok(doc.includes(">1. 概述<"), "标题保留手写编号原文");
    assert.ok(!doc.includes("1 1. 概述"), "没有叠加自动编号");
  } finally {
    cleanup();
  }
});

test("集成：默认 autoNumber 开——手写编号剥掉，编号由服务端接管，无双重编号", async () => {
  const { service, cleanup } = makeService();
  try {
    const md = "# 1. 概述\n\n正文。\n\n## 1.1 背景\n\n背景内容。\n";
    const { docId, issues } = service.createDocumentFromMarkdown({ markdown: md });
    assert.ok(issues.some((i) => i.rule === "md-heading-number"), "转换器告知已剥编号");
    assert.ok(!issues.some((i) => i.rule === "heading-manual-number"),
      "剥掉后校验器不再报疑似手写编号");
    const res = await service.renderDocument({ docId });
    assert.strictEqual(res.ok, true);
    const zip = await JSZip.loadAsync(fs.readFileSync(res.path));
    const doc = await zip.file("word/document.xml").async("string");
    assert.ok(doc.includes(">1 概述<") && doc.includes(">1.1 背景<"), "服务端编号接管");
    assert.ok(!doc.includes("1 1. 概述") && !doc.includes("1.1 1.1 背景"), "无双重编号");
  } finally {
    cleanup();
  }
});

test("集成：空 markdown 报错；imagesDir 相对 baseDir 解析", () => {
  const { service, cleanup } = makeService();
  try {
    assert.throws(() => service.createDocumentFromMarkdown({ markdown: "  " }), /非空/);
    const { issues } = service.createDocumentFromMarkdown({
      markdown: "![图](demo.png)\n",
      baseDir: path.join(__dirname, ".."),
      imagesDir: path.join("examples", "images"),
    });
    assert.ok(!issues.some((i) => i.rule === "image-missing"), "相对 imagesDir 正确解析到图片");
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------- titleFromH1

test("titleFromH1：首个 H1 转标题段并返回 docTitle，后续标题上移一级", () => {
  const md = "# 技术方案\n\n摘要段落。\n\n[toc]\n\n## 概述\n\n### 背景\n\n正文。\n\n## 架构\n";
  const { contexts, docTitle } = markdownToDef(md, { titleFromH1: true, autoNumber: true });
  assert.strictEqual(docTitle, "技术方案");
  assert.deepStrictEqual(contexts[0], {
    type: "text", text: "技术方案",
    paragraphOptions: { style: "ParagraphTitle", alignment: "center" },
  });
  const headings = contexts.filter((n) => n.type === "heading");
  assert.deepStrictEqual(headings.map((n) => [n.level, n.text]),
    [[1, "概述"], [2, "背景"], [1, "架构"]], "## → 1 级、### → 2 级");
});

test("titleFromH1 关闭（默认）：H1 仍是一级标题，不返回 docTitle", () => {
  const { contexts, docTitle } = markdownToDef("# 技术方案\n\n## 概述\n");
  assert.strictEqual(docTitle, undefined);
  assert.deepStrictEqual(contexts[0], { type: "heading", level: 1, text: "技术方案" });
  assert.strictEqual(contexts[1].level, 2);
});

test("titleFromH1：首个 heading 不是 H1 时不生效；正文再现 H1 → warn", () => {
  const noH1 = markdownToDef("## 直接二级开头\n", { titleFromH1: true });
  assert.deepStrictEqual(noH1.contexts[0], { type: "heading", level: 2, text: "直接二级开头" });

  const dup = markdownToDef("# 标题\n\n## 章一\n\n# 又一个一级\n", { titleFromH1: true });
  assert.ok(dup.issues.some((i) => i.rule === "md-title-multiple-h1"));
  const hs = dup.contexts.filter((n) => n.type === "heading");
  assert.deepStrictEqual(hs.map((n) => n.level), [1, 1], "上移后的章和残留 H1 同级");
});

test("titleFromH1 集成：建档标题缺省用 docTitle，标题段不进 toc 不吃编号", async () => {
  const { service, cleanup } = makeService();
  try {
    const md = "# 巡检系统方案\n\n[toc]\n\n## 概述\n\n正文。\n";
    const { docId } = service.createDocumentFromMarkdown({ markdown: md, titleFromH1: true });
    const outline = service.getOutline({ docId });
    const h = outline.find((n) => n.type === "heading");
    assert.strictEqual(h.sectionPath, "1", "概述是第 1 章");
    const res = await service.renderDocument({ docId });
    assert.strictEqual(res.ok, true);
    const zip = await JSZip.loadAsync(fs.readFileSync(res.path));
    const doc = await zip.file("word/document.xml").async("string");
    assert.ok(!doc.includes("1 巡检系统方案"), "标题没被编号");
    assert.match(doc, /ParagraphTitle/);
  } finally {
    cleanup();
  }
});
