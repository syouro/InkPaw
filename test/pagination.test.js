// pagination.test.js — 分页关键 XML 断言（todo P2 质量保障）：
// keepNext / cantSplit / caption 样式必须真实落进 document.xml，
// def 层变换正确不等于渲染层没丢（这里补的就是这层安全网）。
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const JSZip = require("jszip");
const { createService } = require("../src/service");

const IMAGES_DIR = path.join(__dirname, "..", "examples", "images"); // demo.png 40x30

const makeService = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "docx-mcp-pg-"));
  const service = createService({
    dbPath: path.join(dir, "t.db"),
    outputDir: path.join(dir, "output"),
    profilePath: path.join(dir, "style-profile.json"),
  });
  return { service, dir, cleanup: () => { service.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
};

// 取包含指定文本的那个 <w:p>…</w:p> 段（w:t 里的文本）
const paragraphOf = (doc, text) => {
  const re = new RegExp(`<w:p\\b[^>]*>(?:(?!<w:p\\b|</w:p>).)*${text}(?:(?!</w:p>).)*</w:p>`, "s");
  const m = doc.match(re);
  assert.ok(m, `找不到含「${text}」的段落`);
  return m[0];
};

const renderXml = async (service, def) => {
  const { docId, issues } = service.createDocument({ title: "pagination", def });
  assert.deepStrictEqual(issues.filter((i) => i.level === "error"), []);
  const res = await service.renderDocument({ docId });
  assert.strictEqual(res.ok, true);
  const zip = await JSZip.loadAsync(fs.readFileSync(res.path));
  return zip.file("word/document.xml").async("string");
};

test("标题段落带 keepNext，不落页底", async () => {
  const { service, cleanup } = makeService();
  try {
    const doc = await renderXml(service, {
      contexts: [
        { type: "heading", level: 1, text: "概述" },
        { type: "text", text: "正文一段。" },
      ],
    });
    assert.ok(paragraphOf(doc, "1 概述").includes("<w:keepNext/>"), "heading 默认 keepNext");
    assert.ok(!paragraphOf(doc, "正文一段。").includes("<w:keepNext/>"), "普通正文不带 keepNext");
  } finally {
    cleanup();
  }
});

test("表题在表上方且 keepNext 粘住表格；表格行默认 cantSplit", async () => {
  const { service, cleanup } = makeService();
  try {
    const doc = await renderXml(service, {
      contexts: [
        { type: "table", caption: "参数表", columnWidths: [2000, 2000],
          data: [{ texts: ["名称", "值"] }, { texts: ["a", "1"] }, { texts: ["b", "2"] }] },
      ],
    });
    const captionP = paragraphOf(doc, "表1 参数表");
    assert.ok(captionP.includes("<w:keepNext/>"), "表题 keepNext 粘住下方表格");
    assert.ok(doc.indexOf("表1 参数表") < doc.indexOf("<w:tbl>"), "表题在表格上方");
    const trPrs = [...doc.matchAll(/<w:trPr>(?:(?!<\/w:trPr>).)*<\/w:trPr>/gs)];
    assert.strictEqual(trPrs.length, 3, "每行都有 trPr");
    assert.ok(trPrs.every((m) => m[0].includes("<w:cantSplit/>")), "所有行默认 cantSplit");
  } finally {
    cleanup();
  }
});

test("tableOptions.rOptions.cantSplit:false 可关掉整表的行约束", async () => {
  const { service, cleanup } = makeService();
  try {
    const doc = await renderXml(service, {
      contexts: [
        { type: "table", columnWidths: [2000], tableOptions: { rOptions: { cantSplit: false } },
          data: [{ texts: ["行一"] }, { texts: ["行二"] }] },
      ],
    });
    assert.strictEqual((doc.match(/<w:cantSplit\/>/g) || []).length, 0, "覆盖后所有行都不带 cantSplit");
  } finally {
    cleanup();
  }
});

test("图片段落 keepNext 粘住下方图题；caption 样式来自 preset 不写死", async () => {
  const { service, cleanup } = makeService();
  try {
    const doc = await renderXml(service, {
      meta: { imagesDir: IMAGES_DIR },
      contexts: [
        { type: "image", src: "demo.png", caption: "架构图" },
        { type: "text", text: "后续正文。" },
      ],
    });
    // 图题在图下方：靠图片段落 keepNext 粘住图题，图题本身不需要 keepNext
    const imgP = doc.match(/<w:p\b[^>]*>(?:(?!<\/w:p>).)*<w:drawing>(?:(?!<\/w:p>).)*<\/w:p>/s);
    assert.ok(imgP, "找到图片段落");
    assert.ok(imgP[0].includes("<w:keepNext/>"), "图片段落 keepNext 粘住图题");
    const captionP = paragraphOf(doc, "图1 架构图");
    assert.ok(!captionP.includes("<w:keepNext/>"), "图题不粘后续正文");
    assert.ok(doc.indexOf("<w:drawing>") < doc.indexOf("图1 架构图"), "图题在图片下方");
    // plain preset：captionStyle.paragraphOptions.alignment=center
    assert.ok(captionP.includes('<w:jc w:val="center"/>'), "图题居中来自 preset captionStyle");
  } finally {
    cleanup();
  }
});

test("monthly-report preset：caption 的 textOptions（字体/字号）落进 run 属性", async () => {
  const { service, cleanup } = makeService();
  try {
    const { docId, issues } = service.createDocument({
      title: "pagination", preset: "monthly-report",
      def: { contexts: [
        { type: "table", caption: "汇总表", columnWidths: [2000], data: [{ texts: ["x"] }] },
      ] },
    });
    assert.deepStrictEqual(issues.filter((i) => i.level === "error"), []);
    const res = await service.renderDocument({ docId });
    assert.strictEqual(res.ok, true);
    const zip = await JSZip.loadAsync(fs.readFileSync(res.path));
    const doc = await zip.file("word/document.xml").async("string");
    const captionP = paragraphOf(doc, "表1 汇总表");
    // monthly-report captionStyle: { textOptions: { font: 宋体, size: 20 }, paragraphOptions: { alignment: center } }
    assert.ok(captionP.includes('w:ascii="宋体"') || captionP.includes('w:eastAsia="宋体"'), "caption 字体来自 preset");
    assert.ok(captionP.includes('<w:sz w:val="20"/>'), "caption 字号来自 preset");
    assert.ok(captionP.includes('<w:jc w:val="center"/>'), "caption 居中来自 preset");
  } finally {
    cleanup();
  }
});

test("meta.h1PageBreak：XML 里一级标题带 w:pageBreakBefore，首章和二级标题不带", async () => {
  const { service, cleanup } = makeService();
  try {
    const doc = await renderXml(service, {
      meta: { h1PageBreak: true },
      contexts: [
        { type: "heading", level: 1, text: "概述" },
        { type: "text", text: "正文内容。" },
        { type: "heading", level: 1, text: "数据分析" },
        { type: "heading", level: 2, text: "数据来源" },
      ],
    });
    assert.ok(!paragraphOf(doc, "概述").includes("<w:pageBreakBefore/>"), "首章在文档开头，不该另起一页");
    assert.ok(paragraphOf(doc, "数据分析").includes("<w:pageBreakBefore/>"), "第二章应带 pageBreakBefore");
    assert.ok(!paragraphOf(doc, "数据来源").includes("<w:pageBreakBefore/>"), "二级标题不换页");
  } finally {
    cleanup();
  }
});
