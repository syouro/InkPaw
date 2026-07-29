// service.test.js — 服务层端到端：create → validate → outline → update → render
// 渲染验证不止"文件生成了"：jszip 解 document.xml 断言编号/图题/vMerge/页眉
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const JSZip = require("jszip");
const { createService } = require("../src/service");

const makeService = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "docx-mcp-svc-"));
  const service = createService({
    dbPath: path.join(dir, "t.db"),
    outputDir: path.join(dir, "output"),
    profilePath: path.join(dir, "style-profile.json"), // 不存在，走缺省
  });
  return { service, dir, cleanup: () => { service.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
};

const sampleDef = () => ({
  contexts: [
    { type: "heading", level: 1, text: "概述" },
    { id: "p-intro", type: "text", text: "监测概况见 {{ref:tbl-overview}}，架构见 {{ref:img-arch}}。", paragraphOptions: { style: "normalParagraph" } },
    { type: "heading", level: 2, text: "监测内容" },
    { id: "tbl-overview", type: "table", caption: "监测项目一览",
      columnWidths: [2000, 3000, 3312],
      data: [
        { texts: ["类别", "项目", "说明"] },
        { texts: ["环境", "温湿度", "箱内外"] },
        { texts: ["结构温度", "50 点"] },
      ],
      tableOptions: { span: { "1": { spanType: "rowSpan", spanCounts: 2, cNo: [0] } } } },
    { id: "img-arch", type: "image", src: "demo.png", width: 200, height: 150, caption: "系统架构",
      paragraphOptions: { alignment: "center" } },
    { type: "heading", level: 1, text: "结论" },
  ],
  meta: { headerText: "docx-mcp 测试报告", imagesDir: path.join(__dirname, "..", "examples", "images") },
});

const readDocXml = async (docxPath) => {
  const zip = await JSZip.loadAsync(fs.readFileSync(docxPath));
  return {
    doc: await zip.file("word/document.xml").async("string"),
    header: await Promise.all(zip.file(/word\/header\d*\.xml/).map((f) => f.async("string"))),
  };
};

test("端到端：create → outline → render，docx 内部结构正确", async () => {
  const { service, cleanup } = makeService();
  try {
    // ---- create：补 id + 校验通过
    const { docId, preset, issues } = service.createDocument({ title: "e2e", def: sampleDef() });
    assert.strictEqual(preset, "monthly-report");
    assert.deepStrictEqual(issues, []);

    // ---- outline：sectionPath 正确、section 过滤、brief 形态
    const outline = service.getOutline({ docId });
    assert.strictEqual(outline.length, 6);
    assert.ok(outline.every((n) => n.id));
    const tbl = outline.find((n) => n.id === "tbl-overview");
    assert.strictEqual(tbl.sectionPath, "1.1");
    assert.match(tbl.brief, /3行3列\/有合并/);
    const sec11 = service.getOutline({ docId, section: "1.1" });
    assert.deepStrictEqual(sec11.map((n) => n.type), ["heading", "table", "image"]);

    // ---- get_nodes：全量 + 不存在返回 null
    const [full, missing] = service.getNodes({ docId, ids: ["tbl-overview", "nope"] });
    assert.strictEqual(full.data.length, 3);
    assert.strictEqual(missing, null);

    // ---- render：成功 + XML 结构断言
    const res = await service.renderDocument({ docId });
    assert.strictEqual(res.ok, true);
    assert.ok(fs.existsSync(res.path));
    const { doc, header } = await readDocXml(res.path);
    assert.ok(doc.includes("1 概述"), "heading 自动编号");
    assert.ok(doc.includes("1.1 监测内容"), "二级编号");
    assert.ok(doc.includes("2 结论"), "同级递增");
    assert.ok(doc.includes("表1 监测项目一览"), "表题在场且带编号");
    assert.ok(doc.includes("图1 系统架构"), "图题在场且带编号");
    assert.ok(doc.includes("监测概况见 表1，架构见 图1。"), "ref 解析进正文");
    assert.ok(doc.includes("vMerge"), "rowSpan 生成 vMerge");
    assert.ok(doc.includes("w:blipFill") || doc.includes("<pic:pic"), "图片真实嵌入");
    assert.ok(header.some((h) => h.includes("docx-mcp 测试报告")), "页眉文字");
    // 表题在表前、图题在图后（位置关系）
    assert.ok(doc.indexOf("表1 监测项目一览") < doc.indexOf("vMerge"), "表题在表上方");
  } finally {
    cleanup();
  }
});

test("error 级 issue：照存草稿，但拒绝渲染", async () => {
  const { service, cleanup } = makeService();
  try {
    const badDef = {
      contexts: [{
        type: "table", columnWidths: [1000, 1000],
        data: [{ texts: ["a", "b", "c"] }], // 3 格 vs 2 列
      }],
    };
    const { docId, issues } = service.createDocument({ def: badDef, preset: "plain" });
    assert.ok(issues.some((i) => i.level === "error"));
    assert.ok(docId, "草稿态仍保存");
    const res = await service.renderDocument({ docId });
    assert.strictEqual(res.ok, false);
    assert.ok(res.issues.some((i) => i.level === "error"));
  } finally {
    cleanup();
  }
});

test("update_node：整节点替换 id 不变，提级后 ref 仍解析；坏改动当场报", async () => {
  const { service, cleanup } = makeService();
  try {
    const { docId } = service.createDocument({ def: sampleDef() });
    // 提级：text 换成 heading，id 不变
    const { issues } = service.updateNode({
      docId, id: "p-intro",
      node: { type: "heading", level: 2, text: "监测概况" },
    });
    // 原 text 里的 ref 没了，但 tbl/img 还在，无新 error；
    assert.ok(!issues.some((i) => i.level === "error"));
    const outline = service.getOutline({ docId });
    const promoted = outline.find((n) => n.id === "p-intro");
    assert.strictEqual(promoted.type, "heading");
    assert.strictEqual(promoted.sectionPath, "1.1"); // 编号树自动级联
    // 改坏一个表格 → 增量校验当场报 error
    const bad = service.updateNode({
      docId, id: "tbl-overview",
      node: { type: "table", columnWidths: [1000], data: [{ texts: ["a", "b"] }] },
    });
    assert.ok(bad.issues.some((i) => i.level === "error"));
    // 不存在的节点/文档
    assert.throws(() => service.updateNode({ docId, id: "ghost", node: { type: "blank" } }), /节点不存在/);
    assert.throws(() => service.getOutline({ docId: "no-doc" }), /文档不存在/);
  } finally {
    cleanup();
  }
});

test("insert_nodes：前/后插入，服务端补 id 返回 newIds；自带 id 撞车由校验器报", () => {
  const { service, cleanup } = makeService();
  try {
    const { docId } = service.createDocument({ def: sampleDef() });
    const { newIds, issues } = service.insertNodes({
      docId, anchorId: "p-intro", position: "after",
      nodes: [{ type: "text", text: "补充说明。" }, { type: "heading", level: 2, text: "新增小节" }],
    });
    assert.strictEqual(newIds.length, 2);
    assert.ok(newIds[0].startsWith("p-") && newIds[1].startsWith("h-"), "按类型前缀补 id");
    assert.ok(!issues.some((i) => i.level === "error"));
    const outline = service.getOutline({ docId });
    const pos = outline.findIndex((n) => n.id === "p-intro");
    assert.deepStrictEqual([outline[pos + 1].id, outline[pos + 2].id], newIds, "插在锚点之后且保序");

    const before = service.insertNodes({
      docId, anchorId: "p-intro", position: "before", nodes: [{ type: "text", text: "导语。" }],
    });
    const outline2 = service.getOutline({ docId });
    assert.strictEqual(outline2[outline2.findIndex((n) => n.id === "p-intro") - 1].id, before.newIds[0]);

    // 自带 id 与存量重复：照插（草稿态），校验器报 error
    const dup = service.insertNodes({
      docId, anchorId: "p-intro", position: "after", nodes: [{ id: "p-intro", type: "text", text: "撞车" }],
    });
    assert.ok(dup.issues.some((i) => i.level === "error"));

    assert.throws(() => service.insertNodes({ docId, anchorId: "ghost", position: "after", nodes: [{ type: "blank" }] }), /锚点节点不存在/);
    assert.throws(() => service.insertNodes({ docId, anchorId: "p-intro", position: "inside", nodes: [{ type: "blank" }] }), /position/);
    assert.throws(() => service.insertNodes({ docId, anchorId: "p-intro", position: "after", nodes: [] }), /非空数组/);
  } finally {
    cleanup();
  }
});

test("delete_nodes：删除前扫描引用方，warning 点名谁引用了被删节点", () => {
  const { service, cleanup } = makeService();
  try {
    const { docId } = service.createDocument({ def: sampleDef() });
    // p-intro 里 {{ref:tbl-overview}} {{ref:img-arch}}，删 tbl → 点名 p-intro
    const { issues } = service.deleteNodes({ docId, ids: ["tbl-overview"] });
    const broken = issues.filter((i) => i.rule === "delete-ref-broken");
    assert.strictEqual(broken.length, 1);
    assert.strictEqual(broken[0].nodeId, "p-intro");
    assert.ok(broken[0].message.includes("tbl-overview"));
    assert.ok(issues.some((i) => i.rule === "ref-dangling"), "删完后常规校验也报悬空");
    assert.ok(!service.getOutline({ docId }).some((n) => n.id === "tbl-overview"), "节点已删除");
    // 引用方连着被引用方一起删 → 不点名（引用方自己也没了）
    const both = service.deleteNodes({ docId, ids: ["p-intro", "img-arch"] });
    assert.ok(!both.issues.some((i) => i.rule === "delete-ref-broken" || i.rule === "ref-dangling"));

    assert.throws(() => service.deleteNodes({ docId, ids: ["ghost"] }), /节点不存在/);
    assert.throws(() => service.deleteNodes({ docId, ids: [] }), /非空数组/);
  } finally {
    cleanup();
  }
});

test("move_nodes：移动后编号树级联更新；层级问题移动完当场报", () => {
  const { service, cleanup } = makeService();
  try {
    const { docId } = service.createDocument({ def: sampleDef() });
    const outline = service.getOutline({ docId });
    const lastHeading = outline[outline.length - 1]; // "结论"（sectionPath 2）
    // 把表格和图移到结论章下
    const { issues } = service.moveNodes({
      docId, ids: ["tbl-overview", "img-arch"], anchorId: lastHeading.id, position: "after",
    });
    assert.ok(!issues.some((i) => i.level === "error"));
    const moved = service.getOutline({ docId, section: "2" });
    assert.deepStrictEqual(moved.map((n) => n.id).slice(1), ["tbl-overview", "img-arch"], "落位在结论章内，按 ids 顺序");
    assert.strictEqual(service.getOutline({ docId, section: "1.1" }).length, 1, "原章只剩小节标题");

    assert.throws(() => service.moveNodes({ docId, ids: ["tbl-overview"], anchorId: "tbl-overview", position: "after" }), /不能在待移动/);
    assert.throws(() => service.moveNodes({ docId, ids: ["tbl-overview", "tbl-overview"], anchorId: "p-intro", position: "after" }), /重复/);
    assert.throws(() => service.moveNodes({ docId, ids: ["ghost"], anchorId: "p-intro", position: "after" }), /节点不存在/);
  } finally {
    cleanup();
  }
});

test("超链接渲染：外链进 rels、内链锚点、heading 自动书签、Hyperlink 样式自动应用", async () => {
  const { service, cleanup } = makeService();
  try {
    const def = {
      contexts: [
        { id: "h-target", type: "heading", level: 1, text: "目标章" },
        { id: "p-links", type: "text",
          text: ["详见", "官网", "和", "目标章"],
          textOptions: [{}, { link: "https://example.com/site" }, {}, { link: "#h-target" }] },
      ],
    };
    const { docId, issues } = service.createDocument({ def, preset: "plain" });
    assert.deepStrictEqual(issues, []);
    const res = await service.renderDocument({ docId });
    assert.strictEqual(res.ok, true);
    const zip = await JSZip.loadAsync(fs.readFileSync(res.path));
    const doc = await zip.file("word/document.xml").async("string");
    const rels = await zip.file("word/_rels/document.xml.rels").async("string");
    const styles = await zip.file("word/styles.xml").async("string");
    assert.ok(rels.includes('Target="https://example.com/site"'), "外链 URL 进 rels");
    assert.match(doc, /<w:hyperlink [^>]*r:id="/, "外链 hyperlink 元素");
    assert.ok(doc.includes('w:anchor="h-target"'), "内链走锚点");
    assert.match(doc, /<w:bookmarkStart [^>]*w:name="h-target"/, "heading 书签名 = 节点 id");
    assert.ok(styles.includes('w:styleId="Hyperlink"'), "Hyperlink 字符样式在 styles.xml");
    assert.match(doc, /<w:rStyle w:val="Hyperlink"\/>/, "link run 自动应用 Hyperlink 样式");
  } finally {
    cleanup();
  }
});

test("toc 渲染：静态展开出黑字内链条目；native 出 TOC 域 + updateFields", async () => {
  const { service, cleanup } = makeService();
  try {
    const mkDef = (tocNode) => ({
      contexts: [
        tocNode,
        { id: "h-1", type: "heading", level: 1, text: "概述" },
        { id: "h-2", type: "heading", level: 2, text: "背景" },
        { type: "text", text: "正文。" },
      ],
    });
    // 静态（默认）
    const a = service.createDocument({ def: mkDef({ type: "toc" }), preset: "plain" });
    assert.deepStrictEqual(a.issues, []);
    const resA = await service.renderDocument({ docId: a.docId });
    const zipA = await JSZip.loadAsync(fs.readFileSync(resA.path));
    const docA = await zipA.file("word/document.xml").async("string");
    const settingsA = await zipA.file("word/settings.xml").async("string");
    const stylesA = await zipA.file("word/styles.xml").async("string");
    assert.ok(docA.includes(">目录<"), "目录标题");
    assert.ok(docA.includes('w:anchor="h-1"') && docA.includes('w:anchor="h-2"'), "条目内链到标题书签");
    const bookmarkIds = [...docA.matchAll(/<w:bookmarkStart [^>]*w:id="(\d+)"/g)].map((m) => m[1]);
    assert.strictEqual(new Set(bookmarkIds).size, bookmarkIds.length, "标题书签内部 id 必须唯一，Word 才能稳定打开");
    assert.match(docA, /<w:rStyle w:val="tocEntry"\/>/, "条目用 tocEntry 黑字盖掉 Hyperlink 蓝");
    assert.ok(stylesA.includes('w:styleId="toc2"'), "分级缩进样式注入");
    assert.ok(!docA.includes("instrText"), "静态目录没有域");
    assert.ok(!settingsA.includes("updateFields"), "静态目录不开 updateFields");

    // native
    const b = service.createDocument({ def: mkDef({ type: "toc", native: true, maxLevel: 2 }), preset: "plain" });
    const resB = await service.renderDocument({ docId: b.docId });
    const zipB = await JSZip.loadAsync(fs.readFileSync(resB.path));
    const docB = await zipB.file("word/document.xml").async("string");
    const settingsB = await zipB.file("word/settings.xml").async("string");
    assert.ok(docB.includes("TOC \\h \\o &quot;1-2&quot;"), "TOC 域指令带层级范围");
    assert.ok(settingsB.includes("<w:updateFields/>"), "Word 打开时提示更新域");

    // meta.target:"word" → toc 节点不写 native 也走原生域
    const defC = mkDef({ type: "toc" });
    defC.meta = { target: "word" };
    const c = service.createDocument({ def: defC, preset: "plain" });
    const resC = await service.renderDocument({ docId: c.docId });
    const zipC = await JSZip.loadAsync(fs.readFileSync(resC.path));
    const docC = await zipC.file("word/document.xml").async("string");
    assert.ok(docC.includes("instrText"), "target=word 时 toc 默认原生域");
  } finally {
    cleanup();
  }
});

test("修改类工具附带最新 outline，与 get_outline 一致；大文档给 outlineNote", () => {
  const { service, cleanup } = makeService();
  try {
    const { docId } = service.createDocument({ def: sampleDef() });
    const upd = service.updateNode({ docId, id: "p-intro", node: { type: "text", text: "改后" } });
    assert.deepStrictEqual(upd.outline, service.getOutline({ docId }));
    const ins = service.insertNodes({ docId, anchorId: "p-intro", position: "after", nodes: [{ type: "text", text: "插入段" }] });
    assert.ok(ins.outline.some((n) => n.id === ins.newIds[0]), "新节点出现在返回的 outline 里");
    const mv = service.moveNodes({ docId, ids: ["p-intro"], anchorId: "img-arch", position: "after" });
    assert.deepStrictEqual(mv.outline, service.getOutline({ docId }));
    const del = service.deleteNodes({ docId, ids: ["p-intro"] });
    assert.ok(!del.outline.some((n) => n.id === "p-intro"));
    // 超过 200 节点不附带，改给 outlineNote 提示按 section 取
    const big = service.createDocument({
      def: { contexts: Array.from({ length: 201 }, (_, i) => ({ type: "text", text: `第${i}段` })) },
      preset: "plain",
    });
    const firstId = service.getOutline({ docId: big.docId })[0].id;
    const bigUpd = service.updateNode({ docId: big.docId, id: firstId, node: { type: "text", text: "改" } });
    assert.strictEqual(bigUpd.outline, undefined);
    assert.match(bigUpd.outlineNote, /get_outline/);
  } finally {
    cleanup();
  }
});

test("preset 不存在 → create 直接报错，不落脏数据", () => {
  const { service, cleanup } = makeService();
  try {
    assert.throws(() => service.createDocument({ def: { contexts: [] }, preset: "nope" }), /不存在/);
  } finally {
    cleanup();
  }
});

test("style profile 工具化：set 后新文档自动继承，meta 仍可覆盖；坏结构/坏 preset 打回；null 清除", () => {
  const { service, cleanup } = makeService();
  try {
    assert.strictEqual(service.getStyleProfile().profile, null, "未设置返回 null");
    service.setStyleProfile({ profile: { preset: "plain", overrides: { autoNumber: false } } });
    assert.deepStrictEqual(service.getStyleProfile().profile, { preset: "plain", overrides: { autoNumber: false } });
    // 继承：不指定 preset → plain；profile 关掉 autoNumber → 手写编号不 warn
    const { preset, issues } = service.createDocument({
      def: { contexts: [{ type: "heading", level: 1, text: "1. 概述" }] },
    });
    assert.strictEqual(preset, "plain");
    assert.ok(!issues.some((i) => i.rule === "heading-manual-number"));
    // 三层合并：文档 meta 仍覆盖 profile
    const withMeta = service.createDocument({
      def: { meta: { autoNumber: true }, contexts: [{ type: "heading", level: 1, text: "1. 概述" }] },
    });
    assert.ok(withMeta.issues.some((i) => i.rule === "heading-manual-number"));
    // 坏写入打回且不落盘
    assert.throws(() => service.setStyleProfile({ profile: { presett: "plain" } }), /未知键/);
    assert.throws(() => service.setStyleProfile({ profile: { overrides: { font: "宋体" } } }), /未知键/);
    assert.throws(() => service.setStyleProfile({ profile: { preset: "nope" } }), /不存在/);
    assert.throws(() => service.setStyleProfile({ profile: [1] }), /对象/);
    assert.deepStrictEqual(service.getStyleProfile().profile, { preset: "plain", overrides: { autoNumber: false } });
    // null 清除，恢复缺省 preset
    service.setStyleProfile({ profile: null });
    assert.strictEqual(service.getStyleProfile().profile, null);
    assert.strictEqual(service.createDocument({ def: { contexts: [] } }).preset, "monthly-report");
  } finally {
    cleanup();
  }
});

test("autoNumber 关闭（doc meta 覆盖）：编号原样、caption 无编号", async () => {
  const { service, cleanup } = makeService();
  try {
    const def = sampleDef();
    def.meta.autoNumber = false;
    def.contexts = def.contexts.filter((n) => n.id !== "p-intro"); // ref 在关闭态会 warn，此处只看编号
    const { docId } = service.createDocument({ def, preset: "plain" });
    const res = await service.renderDocument({ docId });
    assert.strictEqual(res.ok, true);
    const { doc } = await readDocXml(res.path);
    assert.ok(doc.includes(">概述<"), "heading 不加编号");
    assert.ok(doc.includes("监测项目一览") && !doc.includes("表1 监测项目一览"), "表题无编号");
  } finally {
    cleanup();
  }
});

test("分页保护：heading keepNext、表行 cantSplit、表题粘表格、带图题的图粘图题", async () => {
  const { service, cleanup } = makeService();
  try {
    const { docId } = service.createDocument({ title: "分页", def: sampleDef() });
    const res = await service.renderDocument({ docId });
    assert.strictEqual(res.ok, true);
    const { doc } = await readDocXml(res.path);
    assert.ok(doc.includes("<w:cantSplit/>"), "表格行默认 cantSplit");
    // 表题段落（"表1 监测项目一览"）的 pPr 里要有 keepNext
    const capPara = doc.match(/<w:p>(?:(?!<\/w:p>).)*表1 监测项目一览(?:(?!<\/w:p>).)*<\/w:p>/s)[0];
    assert.ok(capPara.includes("<w:keepNext/>"), "表题 keepNext 粘住下方表格");
    // 图片段落（含 drawing）keepNext 粘住下方图题
    const imgPara = doc.match(/<w:p>(?:(?!<\/w:p>).)*<w:drawing>(?:(?!<\/w:p>).)*<\/w:p>/s)[0];
    assert.ok(imgPara.includes("<w:keepNext/>"), "带图题的图片段落 keepNext");
    // 标题段落 keepNext
    const h1Para = doc.match(/<w:p>(?:(?!<\/w:p>).)*1 概述(?:(?!<\/w:p>).)*<\/w:p>/s)[0];
    assert.ok(h1Para.includes("<w:keepNext/>"), "heading 默认 keepNext");
  } finally {
    cleanup();
  }
});

test("render preview 模式：返回每页 PNG 路径", async () => {
  const { service, cleanup } = makeService();
  try {
    const { docId } = service.createDocument({
      def: { contexts: [{ type: "text", text: "预览测试" }] }, preset: "plain",
    });
    const res = await service.renderDocument({ docId, preview: true });
    assert.strictEqual(res.ok, true);
    assert.ok(Array.isArray(res.previewPages) && res.previewPages.length >= 1, "至少一页 PNG");
    assert.ok(res.previewPages.every((p) => fs.existsSync(p) && p.endsWith(".png")));
  } finally {
    cleanup();
  }
});

test("无 columnWidths 的表格：按版心宽度等分真实列宽，brief 仍算得出列数", async () => {
  const { service, cleanup } = makeService();
  try {
    const def = {
      contexts: [{
        id: "tbl-auto", type: "table",
        data: [{ texts: ["a", "b", "c"] }, { texts: ["1", "2", "3"] }],
      }],
    };
    const { docId, issues } = service.createDocument({ def, preset: "plain" });
    assert.deepStrictEqual(issues.filter((i) => i.level === "error"), []);
    const outline = service.getOutline({ docId });
    assert.match(outline[0].brief, /2行3列/);
    const res = await service.renderDocument({ docId });
    assert.strictEqual(res.ok, true);
    const { doc } = await readDocXml(res.path);
    // 曾试过 pct 100%：docx 库仍写 gridCol=100twips 假网格，单元格带 pStyle 时
    // LibreOffice/WPS 按假网格硬排塌成细缝，必须是真实等分 DXA
    const grid = [...doc.matchAll(/<w:gridCol w:w="(\d+)"\/>/g)].map((m) => Number(m[1]));
    assert.strictEqual(grid.length, 3);
    assert.ok(grid.every((w) => w > 2000), `列宽应为版心等分（约 2770），实际 ${grid}`);
  } finally {
    cleanup();
  }
});

test("表格二维数组简写：入口归一成 { texts }，number 转字符串，行形可混用", async () => {
  const { service, cleanup } = makeService();
  try {
    const def = {
      contexts: [{
        id: "tbl-2d", type: "table",
        columnWidths: [2770, 2770, 2772],
        data: [
          ["指标", "数值", "备注"],
          ["良率", 98.5, true],
          { texts: ["产能", 1200, "台/日"], textOptions: { bold: true } },
        ],
        tableOptions: { headerRows: 1 },
      }],
    };
    const { docId, issues } = service.createDocument({ def, preset: "plain" });
    assert.deepStrictEqual(issues, []);
    const [node] = service.getNodes({ docId, ids: ["tbl-2d"] });
    assert.deepStrictEqual(node.data[0], { texts: ["指标", "数值", "备注"] });
    assert.deepStrictEqual(node.data[1], { texts: ["良率", "98.5", "true"] });
    assert.strictEqual(node.data[2].textOptions.bold, true, "完整形行样式保留");
    assert.deepStrictEqual(node.data[2].texts, ["产能", "1200", "台/日"], "完整形行的 number 同样转字符串");
    const res = await service.renderDocument({ docId });
    assert.strictEqual(res.ok, true);
    const { doc } = await readDocXml(res.path);
    assert.ok(doc.includes("98.5") && doc.includes("良率"), "简写单元格渲染进正文");

    // insert_nodes / update_node 入口同样归一
    const ins = service.insertNodes({
      docId, anchorId: "tbl-2d", position: "after",
      nodes: [{ type: "table", columnWidths: [3000, 3000], data: [["k", "v"], ["a", 1]] }],
    });
    assert.deepStrictEqual(ins.issues.filter((i) => i.level === "error"), []);
    const [inserted] = service.getNodes({ docId, ids: ins.newIds });
    assert.deepStrictEqual(inserted.data[1], { texts: ["a", "1"] });
    service.updateNode({ docId, id: "tbl-2d", node: { type: "table", columnWidths: [2000, 2000], data: [["x", "y"]] } });
    const [updated] = service.getNodes({ docId, ids: ["tbl-2d"] });
    assert.deepStrictEqual(updated.data[0], { texts: ["x", "y"] });
  } finally {
    cleanup();
  }
});

test("表格总宽：fixed 布局 + 显式 DXA 总宽（span 表不再被 auto 压扁）；alignment 居中；超版心 warn", async () => {
  const { service, cleanup } = makeService();
  try {
    const def = {
      contexts: [{
        id: "tbl-span-w", type: "table",
        columnWidths: [2770, 2770, 2772],
        data: [
          { texts: ["汇总"] },
          ["环境", "温度", "23℃"],
          ["湿度", "45%"],
        ],
        tableOptions: {
          alignment: "center",
          span: {
            "0": { spanType: "columnSpan", spanCounts: 3, cNo: [0] },
            "1": { spanType: "rowSpan", spanCounts: 2, cNo: [0] },
          },
        },
      }],
    };
    const { docId, issues } = service.createDocument({ def, preset: "plain" });
    assert.deepStrictEqual(issues, []);
    const res = await service.renderDocument({ docId });
    assert.strictEqual(res.ok, true);
    const { doc } = await readDocXml(res.path);
    assert.ok(doc.includes('<w:tblW w:type="dxa" w:w="8312"/>'), "显式 DXA 总宽（曾是 auto，span 表被压扁）");
    assert.ok(doc.includes('<w:tblLayout w:type="fixed"/>'), "fixed 布局让 tblGrid 生效");
    assert.ok(/<w:tblPr>[\s\S]*?<w:jc w:val="center"\/>/.test(doc), "tableOptions.alignment 落到 w:jc");

    // 列宽总和超版心 → warn 且点名数值
    const over = service.createDocument({ def: { contexts: [{
      type: "table", columnWidths: [5000, 5000], data: [["a", "b"]],
    }] }, preset: "plain" });
    const hit = over.issues.find((i) => i.rule === "table-width-overflow");
    assert.ok(hit && hit.level === "warn");
    assert.match(hit.message, /总和 10000 超过版心宽度/);
  } finally {
    cleanup();
  }
});

test("tableOptions.keepTogether：除末行外所有格子段落打 keepNext，空格子补显式空段", async () => {
  const { service, cleanup } = makeService();
  try {
    const def = {
      contexts: [{
        id: "tbl-keep", type: "table",
        columnWidths: [3000, 3000],
        data: [["h1", "h2"], ["a", null], ["x", "y"]],
        tableOptions: { keepTogether: true },
      }],
    };
    const { docId, issues } = service.createDocument({ def, preset: "plain" });
    assert.deepStrictEqual(issues, []);
    const res = await service.renderDocument({ docId });
    assert.strictEqual(res.ok, true);
    const { doc } = await readDocXml(res.path);
    // 行0 两格 + 行1 两格（含空格子的显式空段）= 4，末行不打
    assert.strictEqual((doc.match(/<w:keepNext\/>/g) || []).length, 4);
    // 不开 keepTogether 则一个都没有
    service.updateNode({ docId, id: "tbl-keep", node: {
      type: "table", columnWidths: [3000, 3000], data: [["h1", "h2"], ["x", "y"]],
    } });
    const res2 = await service.renderDocument({ docId });
    const { doc: doc2 } = await readDocXml(res2.path);
    assert.strictEqual((doc2.match(/<w:keepNext\/>/g) || []).length, 0);
  } finally {
    cleanup();
  }
});

test("checklist 渲染：展开为原生复选框段落，勾选状态正确；outline brief 给进度", async () => {
  const { service, cleanup } = makeService();
  try {
    const def = {
      contexts: [{
        id: "chk-1", type: "checklist",
        items: ["整理数据", { text: "复核口径", checked: true }],
      }],
    };
    const { docId, issues } = service.createDocument({ def, preset: "plain" });
    assert.deepStrictEqual(issues, []);
    const outline = service.getOutline({ docId });
    assert.strictEqual(outline[0].brief, "2 项待办（1 已勾）");
    const res = await service.renderDocument({ docId });
    assert.strictEqual(res.ok, true);
    const { doc } = await readDocXml(res.path);
    assert.strictEqual((doc.match(/<w14:checkbox>/g) || []).length, 2, "两个 sdt 复选框");
    assert.strictEqual((doc.match(/<w14:checked w14:val="1"\/>/g) || []).length, 1, "一个已勾");
    assert.ok(doc.includes("整理数据") && doc.includes("复核口径"));
    assert.ok(doc.includes('w:val="checklistItem"'), "清单段落样式来自 preset");
  } finally {
    cleanup();
  }
});

test("comment 渲染：comments.xml 有内容和作者，正文 range 圈住目标 run", async () => {
  const { service, cleanup } = makeService();
  try {
    const def = {
      meta: { commentAuthor: "审阅人甲" },
      contexts: [
        { type: "text", text: ["良率提升 2.3 个百分点", "，其余平稳。"],
          textOptions: [{ comment: "口头汇报数据，需核实。" }, {}] },
        { type: "text", text: "第二段结论", textOptions: { comment: "结论偏乐观。" } },
      ],
    };
    const { docId, issues } = service.createDocument({ def, preset: "plain" });
    assert.deepStrictEqual(issues, []);
    const res = await service.renderDocument({ docId });
    assert.strictEqual(res.ok, true);
    const zip = await JSZip.loadAsync(fs.readFileSync(res.path));
    const doc = await zip.file("word/document.xml").async("string");
    const cm = await zip.file("word/comments.xml").async("string");
    assert.ok(cm.includes("口头汇报数据，需核实。") && cm.includes("结论偏乐观。"), "批注内容落盘");
    assert.strictEqual((cm.match(/w:author="审阅人甲"/g) || []).length, 2, "作者来自 meta.commentAuthor");
    assert.strictEqual((doc.match(/<w:commentRangeStart w:id="0"\/>/g) || []).length, 1);
    assert.ok(doc.indexOf('<w:commentRangeStart w:id="0"/>') < doc.indexOf("良率提升"), "range 圈住目标 run");
    assert.ok(doc.includes('<w:commentReference w:id="1"/>'), "第二条批注按出现顺序编号");
  } finally {
    cleanup();
  }
});

test("表格单格级样式：格级 alignment/font 盖行级，其余格不受影响", async () => {
  const { service, cleanup } = makeService();
  try {
    const def = {
      contexts: [{
        id: "tbl-cell", type: "table",
        columnWidths: [4000, 4000],
        data: [
          { texts: [
            { text: "居中黑体格", textOptions: { font: "黑体" }, paragraphOptions: { alignment: "center" } },
            "普通格",
          ] },
        ],
      }],
    };
    const { docId, issues } = service.createDocument({ def, preset: "plain" });
    assert.deepStrictEqual(issues, []);
    const res = await service.renderDocument({ docId });
    const { doc } = await readDocXml(res.path);
    assert.strictEqual((doc.match(/<w:jc w:val="center"\/>/g) || []).length, 1, "只有对象格居中");
    assert.ok(/黑体/.test(doc), "格级字体生效");
    assert.ok(doc.indexOf("黑体") < doc.indexOf("普通格"), "字体只落在第一格");
  } finally {
    cleanup();
  }
});

test("图片：不给宽高按原图尺寸；只给一边等比补；base64 直传可渲染", async () => {
  const { service, cleanup } = makeService();
  try {
    const imagesDir = path.join(__dirname, "..", "examples", "images"); // demo.png 40x30
    const png1px = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const def = {
      meta: { imagesDir },
      contexts: [
        { id: "img-auto", type: "image", src: "demo.png" },              // 自动：40x30
        { id: "img-w", type: "image", src: "demo.png", width: 80 },      // 等比补高：80x60
        { id: "img-b64", type: "image", src: png1px, width: 10, height: 10 },
      ],
    };
    const { docId, issues } = service.createDocument({ def, preset: "plain" });
    assert.deepStrictEqual(issues, []);
    const res = await service.renderDocument({ docId });
    assert.strictEqual(res.ok, true);
    const { doc } = await readDocXml(res.path);
    // px → EMU：1px = 9525
    assert.ok(doc.includes('cx="381000" cy="285750"'), "40x30 原尺寸");
    assert.ok(doc.includes('cx="762000" cy="571500"'), "只给 width=80 → 等比 80x60");
    assert.ok(doc.includes('cx="95250" cy="95250"'), "base64 图按给定 10x10");
    assert.ok(!doc.includes("图片缺失"), "无占位");
  } finally {
    cleanup();
  }
});

test("docProps 文档属性：进 core.xml，title 缺省用建档 title；未知键 warn", async () => {
  const { service, cleanup } = makeService();
  try {
    const def = {
      meta: { docProps: { creator: "监测中心", keywords: "月报;监测", subject: "季度汇总" } },
      contexts: [{ type: "text", text: "正文" }],
    };
    const { docId, issues } = service.createDocument({ title: "六月月报", def, preset: "plain" });
    assert.deepStrictEqual(issues, []);
    const res = await service.renderDocument({ docId });
    const zip = await JSZip.loadAsync(fs.readFileSync(res.path));
    const core = await zip.file("docProps/core.xml").async("string");
    assert.ok(core.includes("<dc:creator>监测中心</dc:creator>"), "creator 落盘");
    assert.ok(core.includes("月报;监测"), "keywords 落盘");
    assert.ok(core.includes("<dc:title>六月月报</dc:title>"), "title 缺省用建档 title");

    const bad = service.createDocument({ def: {
      meta: { docProps: { author: "写错的键", creator: 42 } },
      contexts: [{ type: "text", text: "x" }],
    }, preset: "plain" });
    assert.ok(bad.issues.some((i) => i.rule === "doc-props-unknown" && /author/.test(i.message)));
    assert.ok(bad.issues.some((i) => i.rule === "doc-props-invalid" && /creator/.test(i.message)));
  } finally {
    cleanup();
  }
});

test("pdf:true：额外导出同名 PDF", async () => {
  const { service, cleanup } = makeService();
  try {
    const { docId } = service.createDocument({
      def: { contexts: [{ type: "heading", level: 1, text: "PDF 导出" }] }, preset: "plain",
    });
    const res = await service.renderDocument({ docId, pdf: true });
    assert.strictEqual(res.ok, true);
    assert.ok(res.pdfPath && res.pdfPath.endsWith(".pdf"));
    const head = fs.readFileSync(res.pdfPath).subarray(0, 5).toString();
    assert.strictEqual(head, "%PDF-", "产出真 PDF");
  } finally {
    cleanup();
  }
});

test("math 渲染：OMML 原生公式，语法问题在校验阶段就报 warn", async () => {
  const { service, cleanup } = makeService();
  try {
    const def = {
      contexts: [
        { id: "eq-1", type: "math", latex: "x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}" },
      ],
    };
    const { docId, issues } = service.createDocument({ def, preset: "plain" });
    assert.deepStrictEqual(issues, []);
    const outline = service.getOutline({ docId });
    assert.match(outline[0].brief, /^公式 x = /);
    const res = await service.renderDocument({ docId });
    assert.strictEqual(res.ok, true);
    const { doc } = await readDocXml(res.path);
    assert.ok(doc.includes("<m:oMath>"), "出 OMML 公式");
    assert.ok(doc.includes("<m:f>") && doc.includes("<m:rad>"), "分式与根式结构");
    assert.ok(doc.includes("±"), "\\pm 映射成符号");

    // 未识别命令 → 建档时就 warn（math-syntax，附 get_examples 指引）
    const bad = service.createDocument({ def: { contexts: [
      { type: "math", latex: "\\foo{x} = 1" },
    ] }, preset: "plain" });
    const hit = bad.issues.find((i) => i.rule === "math-syntax");
    assert.ok(hit && hit.level === "warn");
    assert.match(hit.message, /\\foo/);
    assert.match(hit.message, /get_examples topic "math"/);
    // error 级：空 latex
    const empty = service.createDocument({ def: { contexts: [{ type: "math", latex: " " }] }, preset: "plain" });
    assert.ok(empty.issues.some((i) => i.rule === "math-invalid" && i.level === "error"));
  } finally {
    cleanup();
  }
});

test("pageRef 渲染：PAGEREF 域 + image/table body 级书签 + updateFields", async () => {
  const { service, cleanup } = makeService();
  try {
    const def = {
      meta: { target: "word" },
      contexts: [
        { id: "h-1", type: "heading", level: 1, text: "概述" },
        { type: "text", text: "汇总见第 {{pageRef:tbl-1}} 页，架构见第 {{pageRef:img-1}} 页。" },
        { type: "newPage" },
        { id: "tbl-1", type: "table", data: [{ texts: ["项", "值"] }, { texts: ["a", "1"] }] },
        { type: "newPage" },
        { id: "img-1", type: "image", src: path.join(__dirname, "..", "examples", "images", "demo.png") },
      ],
    };
    const { docId, issues } = service.createDocument({ def, preset: "plain" });
    assert.deepStrictEqual(issues, []);
    const res = await service.renderDocument({ docId });
    assert.strictEqual(res.ok, true);
    const zip = await JSZip.loadAsync(fs.readFileSync(res.path));
    const doc = await zip.file("word/document.xml").async("string");
    const settings = await zip.file("word/settings.xml").async("string");
    assert.ok(doc.includes("PAGEREF tbl-1") && doc.includes("PAGEREF img-1"), "两处 PAGEREF 域");
    assert.ok(/bookmarkStart w:name="tbl-1"[^>]*\/>\s*<w:tbl>/.test(doc.replace(/ w:id="\d+"/g, ""))
      || /<w:bookmarkStart[^>]*w:name="tbl-1"/.test(doc), "表格前有 body 级书签");
    assert.ok(/<w:bookmarkStart[^>]*w:name="img-1"/.test(doc), "图片有书签");
    assert.ok(settings.includes("<w:updateFields"), "开 updateFields，Word 打开提示更新域");
    // 占位文本不残留
    assert.ok(!doc.includes("{{pageRef:"), "pageRef 占位符全部展开");
  } finally {
    cleanup();
  }
});

test("脚注渲染：按出现顺序编号，footnotes.xml 有内容，正文有上标引用", async () => {
  const { service, cleanup } = makeService();
  try {
    const def = {
      contexts: [
        { type: "text", text: ["论断一", "，数据 42%", "。"],
          textOptions: [{ footnote: "第一条：来源说明。" }, { footnote: "第二条：数据截至 2026-06。" }, {}] },
        { type: "text", text: "后面段落再补一条", textOptions: { footnote: "第三条。" } },
      ],
    };
    const { docId, issues } = service.createDocument({ def, preset: "plain" });
    assert.deepStrictEqual(issues, []);
    const res = await service.renderDocument({ docId });
    assert.strictEqual(res.ok, true);
    const zip = await JSZip.loadAsync(fs.readFileSync(res.path));
    const doc = await zip.file("word/document.xml").async("string");
    const fns = await zip.file("word/footnotes.xml").async("string");
    const refs = [...doc.matchAll(/<w:footnoteReference w:id="(\d+)"\/>/g)].map((m) => Number(m[1]));
    assert.deepStrictEqual(refs, [1, 2, 3], "按出现顺序编号");
    assert.ok(fns.includes("第一条：来源说明。") && fns.includes("第三条。"), "脚注内容落在 footnotes.xml");
    // 引用紧跟在所属 run 后面（论断一¹，数据 42%²）
    assert.ok(doc.indexOf("论断一") < doc.indexOf('w:id="1"'), "引用在 run 之后");
  } finally {
    cleanup();
  }
});

test("表格：headerRows 跨页重复 + tableStyle 表头样式（preset 打底、doc meta 可覆盖）", async () => {
  const { service, cleanup } = makeService();
  try {
    const def = {
      meta: { tableStyle: { headerFill: "EEEEEE", cellMargins: { top: 60, bottom: 60, left: 100, right: 100 } } },
      contexts: [{
        id: "tbl-h", type: "table",
        data: [
          { texts: ["指标", "数值"] },
          { texts: ["良率", "98%"] },
          { texts: ["产能", "1200"] },
        ],
        tableOptions: { headerRows: 1 },
      }],
    };
    const { docId, issues } = service.createDocument({ def, preset: "plain" });
    assert.deepStrictEqual(issues, []);
    const res = await service.renderDocument({ docId });
    assert.strictEqual(res.ok, true);
    const { doc } = await readDocXml(res.path);
    assert.strictEqual((doc.match(/<w:tblHeader\/>/g) || []).length, 1, "只有表头行标记跨页重复");
    assert.strictEqual((doc.match(/w:fill="EEEEEE"/g) || []).length, 2, "表头两格有底色（doc meta 覆盖生效）");
    assert.ok(doc.includes('<w:b/>'), "preset headerTextOptions 的 bold 打底仍在（深并未丢）");
    assert.ok(doc.includes("<w:tcMar>"), "cellMargins 生效");
    // 表头行第一个 run 加粗、数据行不加粗
    const boldBefore = doc.indexOf("<w:b/>");
    assert.ok(boldBefore < doc.indexOf("良率"), "bold 只在表头");
  } finally {
    cleanup();
  }
});

test("多 section：sectPr 切分 + 每节方向/页码/分栏 + 显式页眉页脚引用", async () => {
  const { service, cleanup } = makeService();
  try {
    const def = {
      meta: { headerText: "年度报告", pageNumber: true, autoNumber: false },
      contexts: [
        { id: "h-1", type: "heading", level: 1, text: "正文" },
        { id: "p-1", type: "text", text: "纵向单栏正文。" },
        { id: "sec-1", type: "sectionBreak", headerText: "", pageNumberStart: 1, pageNumberFormat: "lowerRoman" },
        { id: "h-2", type: "heading", level: 1, text: "前言" },
        { id: "p-2", type: "text", text: "前置页。" },
        { id: "sec-2", type: "sectionBreak", landscape: true, columns: 2, pageNumberStart: 1, pageNumberFormat: "decimal" },
        { id: "h-3", type: "heading", level: 1, text: "附录" },
        { id: "p-3", type: "text", text: "横向双栏。" },
      ],
    };
    const { docId, issues } = service.createDocument({ title: "multi-section", def });
    assert.deepStrictEqual(issues, []);

    // outline brief 反映分节属性
    const outline = service.getOutline({ docId });
    const s1 = outline.find((n) => n.id === "sec-1");
    const s2 = outline.find((n) => n.id === "sec-2");
    assert.match(s1.brief, /重启页码/);
    assert.match(s1.brief, /清页眉/);
    assert.match(s2.brief, /横向/);
    assert.match(s2.brief, /2栏/);

    const res = await service.renderDocument({ docId });
    assert.strictEqual(res.ok, true);
    const zip = await JSZip.loadAsync(fs.readFileSync(res.path));
    const doc = await zip.file("word/document.xml").async("string");

    // 三个 sectPr（两个内嵌 pPr/sectPr + 末节 body 级）
    const sects = doc.match(/<w:sectPr[\s\S]*?<\/w:sectPr>/g) || [];
    assert.strictEqual(sects.length, 3, "三节三个 sectPr");
    // §2（前言）：nextPage + 罗马页码从 1
    assert.ok(sects[1].includes('w:fmt="lowerRoman"'), "前言小写罗马");
    assert.ok(sects[1].includes('w:start="1"'), "前言页码从 1 重启");
    // §3（附录）：横向 + 双栏 + 十进制重启
    assert.ok(sects[2].includes('w:orient="landscape"'), "附录横向");
    assert.ok(sects[2].includes('w:num="2"'), "附录双栏");
    assert.ok(sects[2].includes('w:fmt="decimal"'), "附录十进制");
    // 每节都显式落 header/footer 引用（多节不靠 OOXML 继承）
    for (let i = 0; i < 3; i++) {
      assert.ok(/<w:headerReference/.test(sects[i]), `§${i} 有 headerReference`);
      assert.ok(/<w:footerReference/.test(sects[i]), `§${i} 有 footerReference`);
    }
    // 重启节页脚只「第x页」无 SECTIONPAGES（NUMPAGES 不落到重启节）
    const footers = await Promise.all(zip.file(/word\/footer\d+\.xml/).map((f) => f.async("string")));
    assert.ok(footers.some((f) => /PAGE \\\* MERGEFORMAT|w:instrText[^>]*>[^<]*PAGE/.test(f)), "页脚有 PAGE 域");
    assert.ok(!footers.some((f) => /SECTIONPAGES/.test(f)), "重启节不用 SECTIONPAGES（LO/WPS 不渲染）");
  } finally {
    cleanup();
  }
});

test("多 section 增强：栏间分隔线落 w:sep + restartNumbering 章号图表号按节重启", async () => {
  const { service, cleanup } = makeService();
  try {
    const def = {
      meta: { autoNumber: true, imagesDir: path.join(__dirname, "..", "examples", "images") },
      contexts: [
        { id: "h-1", type: "heading", level: 1, text: "第一部分" },
        { id: "img-1", type: "image", src: "demo.png", caption: "示意" },
        { id: "sec-1", type: "sectionBreak", columns: { count: 2, separator: true }, restartNumbering: true },
        { id: "h-2", type: "heading", level: 1, text: "第二部分" },
        { id: "img-2", type: "image", src: "demo.png", caption: "流程" },
      ],
    };
    const { docId, issues } = service.createDocument({ title: "section-enh", def });
    assert.deepStrictEqual(issues.filter((i) => i.level === "error"), []);

    const outline = service.getOutline({ docId });
    const sec = outline.find((n) => n.id === "sec-1");
    assert.match(sec.brief, /2栏\(分隔线\)/);
    assert.match(sec.brief, /重启编号/);

    const res = await service.renderDocument({ docId });
    assert.strictEqual(res.ok, true);
    const zip = await JSZip.loadAsync(fs.readFileSync(res.path));
    const doc = await zip.file("word/document.xml").async("string");

    assert.ok(/<w:cols[^>]*w:sep="(1|true)"/.test(doc), "分栏带栏间分隔线 w:sep");
    assert.ok(doc.includes("1 第一部分") && doc.includes("1 第二部分"), "章号按节重启，两节都是 1");
    assert.strictEqual((doc.match(/>图1 /g) || []).length, 2, "图号按节重启，两个图1");
    assert.ok(!doc.includes("2 第二部分") && !doc.includes("图2"), "没有连续编号残留");
  } finally {
    cleanup();
  }
});

test("浮动图片：wp:anchor 锚点 + 对齐/绕排/衬于文字下真实落 XML", async () => {
  const { service, cleanup } = makeService();
  try {
    const imagesDir = path.join(__dirname, "..", "examples", "images");
    const def = {
      meta: { imagesDir },
      contexts: [
        { id: "img-r", type: "image", src: "demo.png", width: 100, float: { horizontal: "right" } },
        { type: "text", text: "正文绕排。" },
        { id: "img-b", type: "image", src: "demo.png", width: 100,
          float: { wrap: "behind", horizontal: { offset: 50, relative: "page" }, vertical: "center" } },
      ],
    };
    const { docId, issues } = service.createDocument({ title: "float", def });
    assert.deepStrictEqual(issues.filter((i) => i.level === "error"), []);
    const res = await service.renderDocument({ docId });
    assert.strictEqual(res.ok, true);
    const zip = await JSZip.loadAsync(fs.readFileSync(res.path));
    const doc = await zip.file("word/document.xml").async("string");

    const anchors = [...doc.matchAll(/<wp:anchor[\s\S]*?<\/wp:anchor>/g)].map((m) => m[0]);
    assert.strictEqual(anchors.length, 2, "两张浮动图都是 wp:anchor（非 wp:inline）");
    assert.ok(anchors[0].includes("<wp:align>right</wp:align>"), "右对齐");
    assert.ok(anchors[0].includes("<wp:wrapSquare"), "默认 square 绕排");
    assert.ok(/behindDoc="1"/.test(anchors[1]), "behind 衬于文字下方");
    assert.ok(anchors[1].includes('relativeFrom="page"'), "页面基准偏移");
    assert.ok(anchors[1].includes(`<wp:posOffset>${50 * 9525}</wp:posOffset>`), "px→EMU 换算");
    assert.ok(anchors[1].includes("<wp:align>center</wp:align>"), "垂直居中");
    // 普通图仍是 inline（无回归）
    const inlineDef = { meta: { imagesDir }, contexts: [{ type: "image", src: "demo.png", width: 100 }] };
    const r2 = await service.renderDocument({ docId: service.createDocument({ title: "inline", def: inlineDef }).docId });
    const doc2 = await (await JSZip.loadAsync(fs.readFileSync(r2.path))).file("word/document.xml").async("string");
    assert.ok(doc2.includes("<wp:inline") && !doc2.includes("<wp:anchor"), "非 float 图保持 inline");
  } finally {
    cleanup();
  }
});

test("无 sectionBreak 文档仍是单节（无回归）", async () => {
  const { service, cleanup } = makeService();
  try {
    const { docId } = service.createDocument({ title: "single", def: sampleDef() });
    const res = await service.renderDocument({ docId });
    const zip = await JSZip.loadAsync(fs.readFileSync(res.path));
    const doc = await zip.file("word/document.xml").async("string");
    const sects = doc.match(/<w:sectPr[\s\S]*?<\/w:sectPr>/g) || [];
    assert.strictEqual(sects.length, 1, "单节文档一个 sectPr");
  } finally {
    cleanup();
  }
});

// ── 草稿视图（docs/editable-preview.md §3，P2）────────────────────

test("getDraftHtml：编号与引用解析和 DOCX 出自同一条 transform", async () => {
  const { service, cleanup } = makeService();
  try {
    const { docId } = service.createDocument({ title: "草稿", def: sampleDef() });
    const { html, css, warnings } = service.getDraftHtml({ docId });

    assert.ok(html.startsWith("<article class=\"ip-doc\">"), "应是 HTML 片段");
    assert.ok(css.includes(".ip-leaf"), "应带草稿视图样式");
    assert.ok(Array.isArray(warnings));

    // 引用解析成与 DOCX 一致的标签，且是只读 chip
    assert.match(html, /<span class="ip-ref" contenteditable="false" data-ref="tbl-overview">表1<\/span>/);
    // 正文可编辑，写回路径指向 def 节点
    assert.match(html, /data-node-id="p-intro" data-path="text"/);
    // 图题写回 caption 而不是 text
    assert.match(html, /data-path="caption"[^>]*>监测项目一览</);
  } finally { cleanup(); }
});

test("getDraftHtml：不落盘、不依赖 LibreOffice，可在未渲染的文档上直接调用", () => {
  const { service, dir, cleanup } = makeService();
  try {
    const { docId } = service.createDocument({ title: "未渲染", def: sampleDef() });
    const { html } = service.getDraftHtml({ docId });
    assert.ok(html.length > 0);
    const outputDir = path.join(dir, "output");
    const produced = fs.existsSync(outputDir) ? fs.readdirSync(outputDir) : [];
    assert.deepStrictEqual(produced, [], "草稿视图不应产生任何落盘文件");
  } finally { cleanup(); }
});

test("getDraftHtml：不存在的 docId 抛错", () => {
  const { service, cleanup } = makeService();
  try {
    assert.throws(() => service.getDraftHtml({ docId: "00000000-0000-4000-8000-000000000000" }));
  } finally { cleanup(); }
});

test("updateNodeValue：改文字落回 def，走既有 update 路径", () => {
  const { service, cleanup } = makeService();
  try {
    const { docId } = service.createDocument({ title: "写回", def: sampleDef() });
    const r = service.updateNodeValue({
      docId, id: "p-intro", path: ["text"],
      value: "监测概况见 {{ref:tbl-overview}}，架构见 {{ref:img-arch}}。峰值 83.1uε。",
    });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.path, "text");
    const [node] = service.getNodes({ docId, ids: ["p-intro"] });
    assert.match(node.text, /83\.1uε/);
    assert.match(node.text, /\{\{ref:tbl-overview\}\}/, "ref 标记必须以原文形态存回 def");
  } finally { cleanup(); }
});

test("updateNodeValue：改表格单元格与图题", () => {
  const { service, cleanup } = makeService();
  try {
    const { docId } = service.createDocument({ title: "写回", def: sampleDef() });
    service.updateNodeValue({ docId, id: "tbl-overview", path: ["data", 1, "texts", 2], value: "改过的说明" });
    service.updateNodeValue({ docId, id: "tbl-overview", path: ["caption"], value: "新表题" });
    const [t] = service.getNodes({ docId, ids: ["tbl-overview"] });
    assert.strictEqual(t.data[1].texts[2], "改过的说明");
    assert.strictEqual(t.caption, "新表题");
    assert.strictEqual(t.data[1].texts[0], "环境", "同行其他格不受影响");
  } finally { cleanup(); }
});

test("updateNodeValue：删改 ref 标记被拒（服务端独立校验，不靠前端）", () => {
  const { service, cleanup } = makeService();
  try {
    const { docId } = service.createDocument({ title: "写回", def: sampleDef() });
    const before = service.getNodes({ docId, ids: ["p-intro"] })[0].text;

    assert.throws(() => service.updateNodeValue({
      docId, id: "p-intro", path: ["text"], value: "把引用删掉的正文",
    }), /引用标记不可增删改/);

    assert.throws(() => service.updateNodeValue({
      docId, id: "p-intro", path: ["text"],
      value: "监测概况见 {{ref:别的目标}}，架构见 {{ref:img-arch}}。",
    }), /引用标记不可增删改/);

    assert.throws(() => service.updateNodeValue({
      docId, id: "p-intro", path: ["text"],
      value: "架构见 {{ref:img-arch}}，监测概况见 {{ref:tbl-overview}}。",
    }), /引用标记不可增删改/, "顺序也不能变");

    assert.strictEqual(service.getNodes({ docId, ids: ["p-intro"] })[0].text, before, "拒绝后 def 不变");
  } finally { cleanup(); }
});

test("updateNodeValue：非白名单路径、越界、不存在的节点全部拒绝", () => {
  const { service, cleanup } = makeService();
  try {
    const { docId } = service.createDocument({ title: "写回", def: sampleDef() });
    assert.throws(() => service.updateNodeValue({
      docId, id: "tbl-overview", path: ["columnWidths", 0], value: "9999",
    }), /不可编辑/);
    assert.throws(() => service.updateNodeValue({
      docId, id: "tbl-overview", path: ["data", 99, "texts", 0], value: "越界",
    }), /路径不存在|不可编辑/);
    assert.throws(() => service.updateNodeValue({
      docId, id: "不存在的节点", path: ["text"], value: "x",
    }), /节点不存在/);
    assert.throws(() => service.updateNodeValue({
      docId, id: "p-intro", path: ["__proto__", "polluted"], value: "x",
    }), /路径不存在|不可编辑/);
    assert.strictEqual({}.polluted, undefined);
  } finally { cleanup(); }
});

test("updateNodeValue：改完草稿视图与渲染保持一致", async () => {
  const { service, cleanup } = makeService();
  try {
    const { docId } = service.createDocument({ title: "一致性", def: sampleDef() });
    service.updateNodeValue({ docId, id: "tbl-overview", path: ["caption"], value: "改过的表题" });
    const { html } = service.getDraftHtml({ docId });
    assert.match(html, /data-path="caption"[^>]*>改过的表题</);
    const rendered = await service.renderDocument({ docId });
    assert.strictEqual(rendered.ok, true, "改完仍可渲染");
  } finally { cleanup(); }
});

// ── 页眉页脚配置（docs/editable-preview.md §3.5，P3b）──────────────

const sectionDef = () => ({
  meta: { headerText: "文档级页眉" },
  contexts: [
    { id: "p1", type: "text", text: "第一节正文" },
    { id: "sec2", type: "sectionBreak", headerText: "第二节页眉" },
    { id: "p2", type: "text", text: "第二节正文" },
    { id: "sec3", type: "sectionBreak" },
    { id: "p3", type: "text", text: "第三节正文" },
  ],
});

test("getDocConfig：同时给出显式设置与有效值，用于区分继承态", () => {
  const { service, cleanup } = makeService();
  try {
    const { docId } = service.createDocument({ title: "配置", def: sectionDef() });
    const cfg = service.getDocConfig({ docId });

    assert.strictEqual(cfg.document.set.headerText, "文档级页眉");
    assert.strictEqual(cfg.document.effective.headerText, "文档级页眉");

    assert.strictEqual(cfg.sections.length, 2);
    assert.strictEqual(cfg.sections[0].id, "sec2");
    assert.strictEqual(cfg.sections[0].set.headerText, "第二节页眉");
    assert.strictEqual(cfg.sections[0].effective.headerText, "第二节页眉");

    // sec3 没设 → set 里没有该键，有效值继承文档级
    assert.ok(!("headerText" in cfg.sections[1].set), "未设置的字段不该出现在 set 里");
    assert.strictEqual(cfg.sections[1].effective.headerText, "文档级页眉");

    // 版式字段不该泄进配置面板
    assert.ok(!("margins" in cfg.document.effective));
    assert.ok(!("landscape" in cfg.document.effective));
    assert.ok(!("headerImage" in cfg.document.effective));
  } finally { cleanup(); }
});

test("配置三态：undefined 继承 / \"\" 显式无页眉 / 有值覆盖，语义各不相同", () => {
  const { service, cleanup } = makeService();
  try {
    const { docId } = service.createDocument({ title: "配置", def: sectionDef() });

    // 显式无页眉：写空字符串
    service.updateDocConfig({ docId, sectionId: "sec3", set: { headerText: "" } });
    let cfg = service.getDocConfig({ docId });
    assert.strictEqual(cfg.sections[1].set.headerText, "");
    assert.strictEqual(cfg.sections[1].effective.headerText, "", "空字符串不继承文档级");

    // 恢复继承：必须删键，不是置空
    service.updateDocConfig({ docId, sectionId: "sec3", clear: ["headerText"] });
    cfg = service.getDocConfig({ docId });
    assert.ok(!("headerText" in cfg.sections[1].set), "clear 必须删除键");
    assert.strictEqual(cfg.sections[1].effective.headerText, "文档级页眉");

    const [node] = service.getNodes({ docId, ids: ["sec3"] });
    assert.ok(!("headerText" in node), "def 里也必须是删除而非置空");
  } finally { cleanup(); }
});

test("配置写入：作用域校验——pageNumberStart 不接受文档级", () => {
  const { service, cleanup } = makeService();
  try {
    const { docId } = service.createDocument({ title: "配置", def: sectionDef() });
    assert.throws(() => service.updateDocConfig({ docId, set: { pageNumberStart: 5 } }),
      /不支持文档级设置/);
    // 节级可以
    service.updateDocConfig({ docId, sectionId: "sec2", set: { pageNumberStart: 5 } });
    assert.strictEqual(service.getDocConfig({ docId }).sections[0].set.pageNumberStart, 5);
  } finally { cleanup(); }
});

test("配置写入：类型与枚举校验，null 被拒", () => {
  const { service, cleanup } = makeService();
  try {
    const { docId } = service.createDocument({ title: "配置", def: sectionDef() });
    assert.throws(() => service.updateDocConfig({ docId, set: { pageNumber: "yes" } }), /必须是布尔/);
    assert.throws(() => service.updateDocConfig({ docId, set: { headerText: 42 } }), /必须是字符串/);
    assert.throws(() => service.updateDocConfig({ docId, set: { headerText: null } }), /不接受 null/);
    assert.throws(() => service.updateDocConfig({ docId, sectionId: "sec2", set: { pageNumberFormat: "roman" } }),
      /非法/);
    assert.throws(() => service.updateDocConfig({ docId, sectionId: "sec2", set: { pageNumberStart: 0 } }),
      /不小于 1/);
  } finally { cleanup(); }
});

test("配置写入：样式与版式字段不开放，图片字段同样不开放", () => {
  const { service, cleanup } = makeService();
  try {
    const { docId } = service.createDocument({ title: "配置", def: sectionDef() });
    for (const field of ["headerSize", "font", "margins", "landscape", "columns", "headerImage", "footerImage"]) {
      assert.throws(() => service.updateDocConfig({ docId, set: { [field]: "x" } }),
        /不可配置的字段/, `${field} 必须被拒`);
    }
  } finally { cleanup(); }
});

test("配置写入：非 sectionBreak 节点与不存在的节点被拒；同字段不能同时 set 和 clear", () => {
  const { service, cleanup } = makeService();
  try {
    const { docId } = service.createDocument({ title: "配置", def: sectionDef() });
    assert.throws(() => service.updateDocConfig({ docId, sectionId: "p1", set: { headerText: "x" } }),
      /只能设在 sectionBreak 上/);
    assert.throws(() => service.updateDocConfig({ docId, sectionId: "没有这个", set: { headerText: "x" } }),
      /节点不存在/);
    assert.throws(() => service.updateDocConfig({
      docId, sectionId: "sec2", set: { headerText: "x" }, clear: ["headerText"],
    }), /不能同时 set 和 clear/);
  } finally { cleanup(); }
});

test("配置改完仍可渲染，且页眉进入产物", async () => {
  const { service, cleanup } = makeService();
  try {
    const { docId } = service.createDocument({ title: "配置", def: sectionDef() });
    service.updateDocConfig({ docId, set: { headerText: "改过的文档级页眉" } });
    const r = await service.renderDocument({ docId });
    assert.strictEqual(r.ok, true);
    const zip = await JSZip.loadAsync(fs.readFileSync(r.path));
    const headers = Object.keys(zip.files).filter((f) => /word\/header\d*\.xml/.test(f));
    const xml = (await Promise.all(headers.map((f) => zip.file(f).async("string")))).join("");
    assert.match(xml, /改过的文档级页眉/);
  } finally { cleanup(); }
});

// ── 块级结构编辑（docs/editable-preview.md §4 P4）──────────────────

const structDef = () => ({
  contexts: [
    { id: "h1", type: "heading", level: 1, text: "概述" },
    { id: "p1", type: "text", text: "第一段" },
    { id: "p2", type: "text", text: "第二段，见 {{ref:h1}}。" },
  ],
});

test("结构编辑：插入段落落在正确位置并分到新 id", () => {
  const { service, cleanup } = makeService();
  try {
    const { docId } = service.createDocument({ title: "结构", def: structDef() });
    const r = service.updateDraftStructure({ docId, op: "insertAfter", anchorId: "p1", text: "插进来的" });
    assert.strictEqual(r.newIds.length, 1);
    const ids = service.getOutline({ docId }).map((n) => n.id);
    assert.deepStrictEqual(ids, ["h1", "p1", r.newIds[0], "p2"]);

    service.updateDraftStructure({ docId, op: "insertBefore", anchorId: "h1", text: "开头" });
    assert.strictEqual(service.getOutline({ docId })[0].type, "text");
  } finally { cleanup(); }
});

test("结构编辑：上下移动，边界给出明确错误", () => {
  const { service, cleanup } = makeService();
  try {
    const { docId } = service.createDocument({ title: "结构", def: structDef() });
    service.updateDraftStructure({ docId, op: "moveDown", anchorId: "p1" });
    assert.deepStrictEqual(service.getOutline({ docId }).map((n) => n.id), ["h1", "p2", "p1"]);
    service.updateDraftStructure({ docId, op: "moveUp", anchorId: "p1" });
    assert.deepStrictEqual(service.getOutline({ docId }).map((n) => n.id), ["h1", "p1", "p2"]);

    assert.throws(() => service.updateDraftStructure({ docId, op: "moveUp", anchorId: "h1" }),
      /已经是第一个/);
    assert.throws(() => service.updateDraftStructure({ docId, op: "moveDown", anchorId: "p2" }),
      /已经是最后一个/);
  } finally { cleanup(); }
});

test("结构编辑：删除节点，引用悬空以 warn 点名而不是静默", () => {
  const { service, cleanup } = makeService();
  try {
    const { docId } = service.createDocument({ title: "结构", def: structDef() });
    const r = service.updateDraftStructure({ docId, op: "delete", anchorId: "h1" });
    assert.ok(r.issues.some((i) => i.rule === "delete-ref-broken"), "必须点名悬空引用");
    assert.deepStrictEqual(service.getOutline({ docId }).map((n) => n.id), ["p1", "p2"]);
  } finally { cleanup(); }
});

test("结构编辑：不认的 op、不存在的节点、删到空文档全部拒绝", () => {
  const { service, cleanup } = makeService();
  try {
    const { docId } = service.createDocument({ title: "结构", def: structDef() });
    assert.throws(() => service.updateDraftStructure({ docId, op: "insertTable", anchorId: "p1" }),
      /未知操作/);
    assert.throws(() => service.updateDraftStructure({ docId, op: "delete", anchorId: "没有这个" }),
      /节点不存在/);

    const solo = service.createDocument({ title: "单节点", def: { contexts: [{ id: "only", type: "text", text: "x" }] } });
    assert.throws(() => service.updateDraftStructure({ docId: solo.docId, op: "delete", anchorId: "only" }),
      /至少要留一个节点/);
  } finally { cleanup(); }
});

test("结构编辑：改完草稿与渲染都跟上", async () => {
  const { service, cleanup } = makeService();
  try {
    const { docId } = service.createDocument({ title: "结构", def: structDef() });
    service.updateDraftStructure({ docId, op: "insertAfter", anchorId: "p1", text: "新插入的段落" });
    const { html } = service.getDraftHtml({ docId });
    assert.match(html, /新插入的段落/);
    const r = await service.renderDocument({ docId });
    assert.strictEqual(r.ok, true);
  } finally { cleanup(); }
});
