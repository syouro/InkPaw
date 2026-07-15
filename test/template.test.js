// template.test.js — 模板填槽全链路：槽位提取（含跨 run 拆分）→ 注册 →
// 填槽建档 → 渲染，以及 kind 守卫和 dotx 内容类型翻转
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const JSZip = require("jszip");
const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, Header, WidthType,
} = require("docx");
const { extractSlots, renderTemplate } = require("../src/template");
const { createService } = require("../src/service");

const makeService = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "docx-mcp-tpl-"));
  const service = createService({
    dbPath: path.join(dir, "t.db"),
    outputDir: path.join(dir, "output"),
    profilePath: path.join(dir, "style-profile.json"),
    templatesDir: path.join(dir, "templates"),
  });
  return { service, dir, cleanup: () => { service.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
};

// 占位符铺在正文/页眉/表格格三处，覆盖 patchDocument 的扫描面
const buildTemplateBuffer = () => Packer.toBuffer(new Document({
  sections: [{
    headers: { default: new Header({ children: [new Paragraph("{{company}} 内部文件")] }) },
    children: [
      new Paragraph({ children: [new TextRun("标题：{{title}}")] }),
      new Paragraph({ children: [new TextRun("{{body}}")] }),
      new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        rows: [new TableRow({
          children: [
            new TableCell({ children: [new Paragraph("负责人")] }),
            new TableCell({ children: [new Paragraph("{{owner}}")] }),
          ],
        })],
      }),
    ],
  }],
}));

const readEntry = async (buf, name) => {
  const zip = await JSZip.loadAsync(buf);
  return zip.file(name).async("string");
};

test("extractSlots：正文/页眉/表格格的槽位都能提取", async () => {
  const slots = await extractSlots(await buildTemplateBuffer());
  assert.deepStrictEqual([...slots].sort(), ["body", "company", "owner", "title"]);
});

test("extractSlots：Word 手工编辑把槽名拆成多个 run 仍能识别", async () => {
  const zip = await JSZip.loadAsync(await buildTemplateBuffer());
  const xml = await zip.file("word/document.xml").async("string");
  assert.ok(xml.includes("{{body}}"));
  zip.file("word/document.xml", xml.replace(
    /<w:r>(<w:rPr>[\s\S]*?<\/w:rPr>)?<w:t[^>]*>\{\{body\}\}<\/w:t><\/w:r>/,
    '<w:r><w:t xml:space="preserve">{{bo</w:t></w:r><w:r><w:t>dy</w:t></w:r><w:r><w:t>}}</w:t></w:r>'));
  const split = await zip.generateAsync({ type: "nodebuffer" });
  assert.ok(!(await readEntry(split, "word/document.xml")).includes("{{body}}"), "拆分未生效");
  const slots = await extractSlots(split);
  assert.ok(slots.includes("body"), `拆散的槽名没识别出来: ${slots}`);
  // 拆散后照样能填
  const { buffer, leftover } = await renderTemplate(split, { body: "拆分替换成功" });
  assert.ok((await readEntry(buffer, "word/document.xml")).includes("拆分替换成功"));
  assert.ok(!leftover.includes("body"));
});

test("renderTemplate：块级槽末尾是表格时垫空段，避免与模板相邻表格并表", async () => {
  // renderTemplate 是渲染层入口，只吃规范形（二维数组简写由服务层归一）
  const { buffer } = await renderTemplate(await buildTemplateBuffer(), {
    body: [{ type: "table", data: [{ texts: ["k", "v"] }] }],
  });
  const xml = await readEntry(buffer, "word/document.xml");
  // 填进去的表格和模板原有表格之间必须隔着段落，不能出现 </w:tbl><w:tbl>
  assert.ok(!/<\/w:tbl>\s*<w:tbl[ >]/.test(xml), "两个表格背靠背，会被 Word 并成一张");
});

test("端到端：注册 → 填槽建档 → 渲染，替换落位且 dotx 翻回 document 类型", async (t) => {
  const { service, dir, cleanup } = makeService();
  t.after(cleanup);

  // 造 .dotx：main part 内容类型换成 template
  const zip = await JSZip.loadAsync(await buildTemplateBuffer());
  const TPL_CT = "application/vnd.openxmlformats-officedocument.wordprocessingml.template.main+xml";
  const DOC_CT = "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml";
  const ct = await zip.file("[Content_Types].xml").async("string");
  zip.file("[Content_Types].xml", ct.replace(DOC_CT, TPL_CT));
  const dotxPath = path.join(dir, "contract.dotx");
  fs.writeFileSync(dotxPath, await zip.generateAsync({ type: "nodebuffer" }));

  const reg = await service.registerTemplate({ name: "合同模板", path: dotxPath });
  assert.deepStrictEqual([...reg.slots].sort(), ["body", "company", "owner", "title"]);
  assert.strictEqual(service.listTemplates().templates[0].ext, "dotx");

  const { docId, issues } = service.createDocumentFromTemplate({
    templateId: reg.templateId,
    title: "张三合同",
    slots: {
      company: "砚台科技",
      title: "劳动合同",
      owner: "张三",
      body: [
        { type: "text", text: "第一行\n带软换行" },
        { type: "table", data: [["项目", "金额"], ["基本工资", 18000]] },
      ],
    },
  });
  assert.deepStrictEqual(issues, [], JSON.stringify(issues));

  const res = await service.renderDocument({ docId });
  assert.strictEqual(res.ok, true);
  assert.deepStrictEqual(res.warnings, []);
  const out = fs.readFileSync(res.path);
  const doc = await readEntry(out, "word/document.xml");
  assert.ok(doc.includes("劳动合同") && doc.includes("张三") && doc.includes("18000"));
  assert.ok(!doc.includes("{{"), "还有残留占位符");
  assert.ok((await readEntry(out, "word/header1.xml")).includes("砚台科技"));
  // dotx 产物翻回 document 内容类型——交付的是成品文档
  assert.ok((await readEntry(out, "[Content_Types].xml")).includes(DOC_CT));
});

test("槽位校验：缺槽/多槽 warn、非法节点 error 拒渲染、渲染残留点名", async (t) => {
  const { service, dir, cleanup } = makeService();
  t.after(cleanup);
  const tplPath = path.join(dir, "t.docx");
  fs.writeFileSync(tplPath, await buildTemplateBuffer());
  const { templateId } = await service.registerTemplate({ path: tplPath });

  const { docId, issues } = service.createDocumentFromTemplate({
    templateId,
    slots: { title: "只填一个", nonsense: "模板里没有这个槽" },
  });
  assert.ok(issues.some((i) => i.rule === "template-slot-unknown"));
  assert.ok(issues.filter((i) => i.rule === "template-slot-missing").length === 3);

  const res = await service.renderDocument({ docId });
  assert.strictEqual(res.ok, true);
  assert.ok(res.warnings.some((w) => w.includes("残留占位符") && w.includes("{{body}}")));

  // 不支持的节点类型是 error，拒绝渲染
  const bad = service.createDocumentFromTemplate({
    templateId, slots: { body: [{ type: "toc" }] },
  });
  assert.ok(bad.issues.some((i) => i.level === "error" && i.rule === "slot-node-type"));
  const badRes = await service.renderDocument({ docId: bad.docId });
  assert.strictEqual(badRes.ok, false);
});

test("update_template_slots：浅合并、null 恢复未填；kind 守卫双向拦截", async (t) => {
  const { service, dir, cleanup } = makeService();
  t.after(cleanup);
  const tplPath = path.join(dir, "t.docx");
  fs.writeFileSync(tplPath, await buildTemplateBuffer());
  const { templateId } = await service.registerTemplate({ path: tplPath });
  const { docId } = service.createDocumentFromTemplate({
    templateId, slots: { title: "v1", owner: "张三" },
  });

  const upd = service.updateTemplateSlots({ docId, slots: { title: "v2", owner: null, company: "砚台" } });
  assert.deepStrictEqual([...upd.filled].sort(), ["company", "title"]);
  assert.ok(upd.issues.some((i) => i.rule === "template-slot-missing" && i.message.includes("owner")));
  const res = await service.renderDocument({ docId });
  const doc = await readEntry(fs.readFileSync(res.path), "word/document.xml");
  assert.ok(doc.includes("v2") && doc.includes("{{owner}}"));

  // 模板文档禁节点级工具
  assert.throws(() => service.getOutline({ docId }), /模板填槽文档/);
  assert.throws(() => service.updateNode({ docId, id: "x", node: {} }), /模板填槽文档/);
  // def 文档禁 update_template_slots
  const defDoc = service.createDocument({ def: { contexts: [{ type: "text", text: "普通文档" }] } });
  assert.throws(() => service.updateTemplateSlots({ docId: defDoc.docId, slots: {} }), /不是模板填槽文档/);
});

test("registerTemplate：base64 上传、非 Word 文件打回、无槽位模板提醒", async (t) => {
  const { service, dir, cleanup } = makeService();
  t.after(cleanup);
  const buf = await buildTemplateBuffer();
  const reg = await service.registerTemplate({ name: "b64", base64: buf.toString("base64") });
  assert.strictEqual(reg.slots.length, 4);

  await assert.rejects(service.registerTemplate({ base64: Buffer.from("not a zip").toString("base64") }), /zip/);
  await assert.rejects(service.registerTemplate({}), /二选一/);

  const empty = await Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph("没有槽位")] }] }));
  const noSlot = path.join(dir, "noslot.docx");
  fs.writeFileSync(noSlot, empty);
  const reg2 = await service.registerTemplate({ path: noSlot });
  assert.ok(reg2.warnings.some((w) => w.includes("没有")));
});
