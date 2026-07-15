/**
 * template.js — 模板填槽（docs/architecture.md）
 *
 * 公司固定版式 .docx/.dotx 模板里写 {{槽名}}，填槽时字符串槽走段内替换
 * （保留模板 run 样式），def 节点数组槽走整段块级替换（复用渲染层构建器）。
 * 与 def 流的边界：模板文档没有节点结构，产物排版由模板本身决定——
 * 这是「强模板需求」的专用通道，不是 def 流的替代。
 *
 * 渲染层同级模块：只依赖 docx/jszip/docxUtil，不碰 MCP/SQLite。
 */
const {
  patchDocument, PatchType, TextRun, Paragraph, Table,
} = require("docx");
const JSZip = require("jszip");
const {
  customText, customHeading, customTable, customMath, normalImage,
  newPage, blankLine, contentWidthOf, fixWordCompat,
} = require("./docxUtil");

// 槽名字符集收紧到「不含花括号」：patchDocument 按 {{key}} 字面量找，
// 宽字符集会把模板里碰巧成对的花括号误认成槽
const SLOT_RE = /\{\{([^{}]+)\}\}/g;

const decodeXml = (s) => s
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'").replace(/&amp;/g, "&");

/**
 * 从模板 buffer 提取槽位清单。逐段拼接 w:t 文本再匹配——Word 手工编辑
 * 会把 {{key}} 按 rsid 拆成多个 run，整段拼接后才看得到完整槽名
 * （patchDocument 内部同样按段落全文定位，口径一致）。
 */
const extractSlots = async (buffer) => {
  const zip = await JSZip.loadAsync(buffer);
  const slots = new Set();
  const parts = Object.keys(zip.files)
    .filter((n) => /^word\/[^/]+\.xml$/.test(n));
  for (const name of parts) {
    const xml = await zip.file(name).async("string");
    for (const para of xml.match(/<w:p[ >][\s\S]*?<\/w:p>/g) || []) {
      const text = (para.match(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g) || [])
        .map((t) => decodeXml(t.replace(/^<w:t(?:\s[^>]*)?>/, "").replace(/<\/w:t>$/, "")))
        .join("");
      for (const m of text.matchAll(SLOT_RE)) slots.add(m[1]);
    }
  }
  return [...slots];
};

const DOC_CT = "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml";
const TPL_CT = "application/vnd.openxmlformats-officedocument.wordprocessingml.template.main+xml";

/** 校验 buffer 是合法的 Word 包，返回 { isDotx } */
const inspectTemplate = async (buffer) => {
  let zip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch {
    throw new Error("模板不是合法的 zip/docx 文件");
  }
  if (!zip.file("word/document.xml")) throw new Error("模板缺少 word/document.xml，不是 Word 文档");
  const ct = await zip.file("[Content_Types].xml").async("string");
  return { isDotx: ct.includes(TPL_CT) };
};

// 槽位块级内容支持的节点类型（def 子集）：脚注/批注/目录/分节这些依赖
// 全文档上下文的能力在槽位里不成立，校验层拦截
const SLOT_NODE_BUILDERS = {
  text: (n) => customText(n.text, n.textOptions, n.paragraphOptions),
  heading: (n) => customHeading(n.text, n.level, n.paragraphOptions),
  table: (n, { imagesDir, contentWidth }) => customTable(
    n.data, n.columnWidths || n.columnsWith, n.tableOptions || {}, imagesDir, contentWidth, {}),
  image: (n, { imagesDir, contentWidth }) => normalImage(
    Array.isArray(n.src) ? n.src : [n.src], n.width, n.height, imagesDir,
    n.otherChildren, n.paragraphOptions, Math.floor(contentWidth / 15)),
  math: (n) => customMath(n.latex, n.paragraphOptions),
  newPage: () => newPage(),
  blank: (n) => blankLine(n.paragraphOptions),
};

const SLOT_NODE_TYPES = Object.keys(SLOT_NODE_BUILDERS);

/**
 * slots 值 → patchDocument 的 patches。
 * 字符串：段内替换（\n 转软换行），模板 run 样式原样保留；
 * 节点数组：整段块级替换，末尾是表格时垫空段——两个 <w:tbl> 背靠背
 * 会被 Word 并成一张表（2026-07-09 实测）。
 */
const buildPatches = (slots, { imagesDir, contentWidth }) => {
  const patches = {};
  for (const [key, value] of Object.entries(slots)) {
    if (typeof value === "string") {
      patches[key] = {
        type: PatchType.PARAGRAPH,
        children: value.split("\n").map((line, i) =>
          new TextRun({ text: line, ...(i > 0 ? { break: 1 } : {}) })),
      };
    } else {
      const children = value.map((n) =>
        SLOT_NODE_BUILDERS[n.type](n, { imagesDir, contentWidth }));
      if (children[children.length - 1] instanceof Table) {
        children.push(new Paragraph({ children: [] }));
      }
      patches[key] = { type: PatchType.DOCUMENT, children };
    }
  }
  return patches;
};

/**
 * 填槽主入口：返回 { buffer, leftover }。leftover 是填完仍残留的槽名
 * （patchDocument 对没配的槽静默留原文，残留检查是我们自己的安全网）。
 * .dotx 输入产物翻回 document 内容类型——交付的是成品文档不是模板。
 */
const renderTemplate = async (templateBuffer, slots, { imagesDir = ".", contentWidth } = {}) => {
  const cw = contentWidth || contentWidthOf({});
  const patched = await patchDocument(templateBuffer, {
    keepOriginalStyles: true,
    patches: buildPatches(slots, { imagesDir, contentWidth: cw }),
  });
  const zip = await JSZip.loadAsync(Buffer.from(patched));
  const ct = await zip.file("[Content_Types].xml").async("string");
  if (ct.includes(TPL_CT)) zip.file("[Content_Types].xml", ct.replace(TPL_CT, DOC_CT));
  const buffer = await fixWordCompat(await zip.generateAsync({ type: "nodebuffer" }));
  return { buffer, leftover: await extractSlots(buffer) };
};

module.exports = { extractSlots, inspectTemplate, renderTemplate, SLOT_NODE_TYPES, SLOT_RE };
