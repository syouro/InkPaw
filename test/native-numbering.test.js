// native-numbering.test.js — autoNumber:"native" 原生多级编号（实验开关）：
// 编号从「transform 拼文本」换成「标题样式挂 numPr」，三处都要盯——
// 三层合并的注入/剥离、transform 不再拼前缀、渲染层 styles/numbering.xml 真实落 XML。
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const JSZip = require("jszip");
const { createService } = require("../src/service");
const { resolveDocConfig } = require("../src/presets");
const { transform } = require("../src/transform");
const { validate } = require("../src/validator");

const makeService = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "docx-mcp-nn-"));
  const service = createService({
    dbPath: path.join(dir, "t.db"),
    outputDir: path.join(dir, "output"),
    profilePath: path.join(dir, "style-profile.json"),
  });
  return { service, dir, cleanup: () => { service.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
};

const HEADING_DEF = (meta) => ({
  meta,
  contexts: [
    { id: "h1", type: "heading", level: 1, text: "概述" },
    { id: "h2", type: "heading", level: 2, text: "背景" },
    { type: "heading", level: 1, text: "方案" },
  ],
});

const renderZip = async (service, def) => {
  const { docId, issues } = service.createDocument({ title: "native-num", def });
  assert.deepStrictEqual(issues.filter((i) => i.level === "error"), []);
  const res = await service.renderDocument({ docId });
  assert.strictEqual(res.ok, true);
  return JSZip.loadAsync(fs.readFileSync(res.path));
};

// ---------------------------------------------------------------- 三层合并

test("resolveDocConfig：native 时把 preset 的 headingNumbering 注入渲染 meta", () => {
  const cfg = resolveDocConfig({ presetName: "plain", docMeta: { autoNumber: "native" } });
  assert.strictEqual(cfg.autoNumber, "native");
  assert.strictEqual(cfg.meta.headingNumbering.reference, "heading-num");
  assert.strictEqual(cfg.meta.headingNumbering.levels.length, 6);
  assert.strictEqual(cfg.meta.headingNumbering.levels[1].text, "%1.%2");
});

test("resolveDocConfig：非 native 时 headingNumbering 不进渲染 meta（防双重编号）", () => {
  for (const autoNumber of [true, false]) {
    const cfg = resolveDocConfig({ presetName: "plain", docMeta: { autoNumber } });
    assert.strictEqual(cfg.meta.headingNumbering, undefined);
  }
});

test("resolveDocConfig：autoNumber 非法值直接报错", () => {
  assert.throws(() => resolveDocConfig({ presetName: "plain", docMeta: { autoNumber: "yes" } }),
    /autoNumber "yes" 无效/);
});

test("resolveDocConfig：native 但 headingNumbering 缺失时报错点名 preset", () => {
  assert.throws(() => resolveDocConfig({
    presetName: "plain",
    docMeta: { autoNumber: "native", headingNumbering: null },
  }), /headingNumbering/);
});

// ---------------------------------------------------------------- transform

test("transform native：标题不拼文本编号，ref/caption 仍按编号索引解析", () => {
  const def = {
    contexts: [
      { id: "h1", type: "heading", level: 1, text: "概述" },
      { type: "text", text: "见 {{ref:t1}} 与 {{ref:h2}}" },
      { id: "h2", type: "heading", level: 2, text: "背景" },
      { id: "t1", type: "table", caption: "统计", data: [{ texts: ["A"] }] },
    ],
  };
  const { def: v1, warnings } = transform(def, { autoNumber: "native" });
  assert.deepStrictEqual(warnings, []);
  assert.deepStrictEqual(v1.contexts.filter((n) => n.type === "heading").map((n) => n.text),
    ["概述", "背景"]);
  assert.strictEqual(v1.contexts[1].text, "见 表1 与 1.1");
  assert.ok(v1.contexts.some((n) => n.type === "text" && n.text === "表1 统计"));
});

test("transform native：静态 toc 条目仍带编号（渲染时刻与原生编号一致）", () => {
  const def = {
    contexts: [
      { type: "toc" },
      { id: "h1", type: "heading", level: 1, text: "概述" },
    ],
  };
  const { def: v1 } = transform(def, { autoNumber: "native" });
  assert.ok(v1.contexts.some((n) => n.type === "text" && n.text === "1 概述"));
});

// ---------------------------------------------------------------- validator

test("validator：native 与 restartNumbering 冲突 warn，纯文本编号不 warn", () => {
  const def = {
    contexts: [
      { type: "heading", level: 1, text: "上篇" },
      { type: "sectionBreak", restartNumbering: true },
      { type: "heading", level: 1, text: "下篇" },
    ],
  };
  const nativeIssues = validate(def, { autoNumber: "native" });
  const hit = nativeIssues.filter((i) => i.rule === "native-number-restart");
  assert.strictEqual(hit.length, 1);
  assert.strictEqual(hit[0].level, "warn");
  assert.deepStrictEqual(
    validate(def, { autoNumber: true }).filter((i) => i.rule === "native-number-restart"), []);
});

// ---------------------------------------------------------------- 渲染 XML

test("渲染 native：标题样式挂 numPr、numbering.xml 有多级定义、正文无文本编号", async () => {
  const { service, cleanup } = makeService();
  try {
    const zip = await renderZip(service, HEADING_DEF({ autoNumber: "native" }));
    const styles = await zip.file("word/styles.xml").async("string");
    const numbering = await zip.file("word/numbering.xml").async("string");
    const doc = await zip.file("word/document.xml").async("string");

    // Heading1~3 都要挂 numPr，且指向同一 numId（同一棵多级编号树）
    const numIds = [];
    for (const [style, ilvl] of [["Heading1", 0], ["Heading2", 1], ["Heading3", 2]]) {
      const frag = styles.match(new RegExp(`<w:style [^>]*w:styleId="${style}".*?</w:style>`, "s"));
      assert.ok(frag, `styles.xml 缺 ${style}`);
      const m = frag[0].match(new RegExp(`<w:numPr><w:ilvl w:val="${ilvl}"/><w:numId w:val="(\\d+)"/></w:numPr>`));
      assert.ok(m, `${style} 缺 numPr（ilvl=${ilvl}）`);
      numIds.push(m[1]);
    }
    assert.strictEqual(new Set(numIds).size, 1, `Heading1~3 应指向同一 numId，实际 ${numIds}`);
    assert.ok(numbering.includes('w:lvlText w:val="%1.%2"'), "numbering.xml 缺多级 lvlText");
    // 标题段落文本是裸标题，编号不再由 transform 拼进 w:t
    assert.ok(doc.includes("<w:t>概述</w:t>") || doc.includes('<w:t xml:space="preserve">概述</w:t>'),
      "标题 w:t 应为裸文本「概述」");
    assert.ok(!/<w:t[^>]*>1 概述<\/w:t>/.test(doc), "native 下不应再有文本编号前缀");
  } finally { cleanup(); }
});

test("渲染默认 autoNumber:true：行为不变（无 numPr，文本编号照拼）", async () => {
  const { service, cleanup } = makeService();
  try {
    const zip = await renderZip(service, HEADING_DEF({ autoNumber: true }));
    const styles = await zip.file("word/styles.xml").async("string");
    const doc = await zip.file("word/document.xml").async("string");
    const h1 = styles.match(/<w:style [^>]*w:styleId="Heading1".*?<\/w:style>/s);
    assert.ok(h1 && !h1[0].includes("<w:numPr>"), "非 native 下 Heading1 不应挂 numPr");
    assert.ok(/<w:t[^>]*>1 概述<\/w:t>/.test(doc), "文本编号应照拼");
  } finally { cleanup(); }
});
