"use strict";
// 证据版复现：让 LibreOffice 的崩坏在截图里一眼可见。
// 每个文件里放「正常对照 + 病灶」两部分，同一份文件即可对照。
const fs = require("fs");
const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, WidthType,
} = require("docx");

const save = async (name, doc) => fs.writeFileSync(name, await Packer.toBuffer(doc));

const NAMED = { id: "body", name: "body", run: { size: 24 }, paragraph: {} };

(async () => {
  // #1：同一列表，前两项裸 bullet（正常），后两项 bullet+style → LO 里项目符号丢失
  await save("e1.docx", new Document({
    styles: { paragraphStyles: [{ id: "myStyle", name: "myStyle", run: { size: 28, color: "336699" } }] },
    sections: [{ children: [
      new Paragraph("Below: 4 bullet items. Items 3-4 also set a paragraph style:"),
      new Paragraph({ text: "plain bullet item 1", bullet: { level: 0 } }),
      new Paragraph({ text: "plain bullet item 2", bullet: { level: 0 } }),
      new Paragraph({ text: "styled bullet item 3 (style + bullet)", style: "myStyle", bullet: { level: 0 } }),
      new Paragraph({ text: "styled bullet item 4 (style + bullet)", style: "myStyle", bullet: { level: 0 } }),
    ] }],
  }));

  // #2：同结构两张表，上表单元格用带 name 的样式（正常），下表用缺 name 的样式 → LO 塌成细缝
  const mkTable = (styleId) => new Table({
    columnWidths: [3000, 3000, 3000],
    rows: [0, 1].map(() => new TableRow({
      children: ["alpha", "beta", "gamma"].map((t) => new TableCell({
        children: [new Paragraph({ text: t, style: styleId })],
      })),
    })),
  });
  await save("e2.docx", new Document({
    styles: { paragraphStyles: [
      { id: "named", name: "named", run: { size: 24 } },
      { id: "noName", run: { size: 24 } },   // 缺 name
    ] },
    sections: [{ children: [
      new Paragraph("Table 1: cells use a style WITH <w:name> (renders fine):"),
      mkTable("named"),
      new Paragraph(""),
      new Paragraph("Table 2: identical, but cell style has NO <w:name>:"),
      mkTable("noName"),
    ] }],
  }));

  // #3：同内容两张 pct 宽表，上表给了 columnWidths（正常），下表缺省 → tblGrid 100 twips 塌缝
  const mkPctTable = (columnWidths) => new Table({
    ...(columnWidths ? { columnWidths } : {}),
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [0, 1].map(() => new TableRow({
      children: ["first column", "second column", "third column"].map((t) => new TableCell({
        children: [new Paragraph({ text: t, style: "body" })],
      })),
    })),
  });
  await save("e3.docx", new Document({
    styles: { paragraphStyles: [NAMED] },
    sections: [{ children: [
      new Paragraph("Table 1: 100% width WITH explicit columnWidths:"),
      mkPctTable([3117, 3117, 3117]),
      new Paragraph(""),
      new Paragraph("Table 2: 100% width, columnWidths omitted (defaults to 100 twips each):"),
      mkPctTable(null),
    ] }],
  }));

  // #4A：两段首行缩进，上段数值 twips（正常），下段 "0.75cm" 字符串 → LO 缩进丢失
  await save("e4a.docx", new Document({
    sections: [{ children: [
      new Paragraph({ children: [new TextRun("Indent as number (425 twips) — first line indents:")] }),
      new Paragraph({ text: "The quick brown fox jumps over the lazy dog.", indent: { firstLine: 425 } }),
      new Paragraph({ children: [new TextRun('Indent as string ("0.75cm") — passed through verbatim:')] }),
      new Paragraph({ text: "The quick brown fox jumps over the lazy dog.", indent: { firstLine: "0.75cm" } }),
    ] }],
  }));

  console.log("ok");
})().catch((e) => { console.error(e); process.exit(1); });
