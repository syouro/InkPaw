"use strict";
// docs/upstream-issues.md 五条问题在 docx@9.x 的最小复现：各出一个 docx，
// 由外层脚本解包断言病灶 XML。
const fs = require("fs");
const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  WidthType, LevelFormat, AlignmentType,
} = require("docx");

const save = async (name, doc) => fs.writeFileSync(name, await Packer.toBuffer(doc));

(async () => {
  // #1 bullet + style → 双 w:pStyle
  await save("r1.docx", new Document({
    styles: { paragraphStyles: [{ id: "myStyle", name: "myStyle", run: { size: 24 } }] },
    sections: [{ children: [new Paragraph({ text: "item", style: "myStyle", bullet: { level: 0 } })] }],
  }));

  // #2 样式缺 name → styles.xml 无 w:name
  await save("r2.docx", new Document({
    styles: { paragraphStyles: [{ id: "noName", run: { size: 24 } }] },
    sections: [{ children: [new Paragraph({ text: "hi", style: "noName" })] }],
  }));

  // #3 pct 宽表格缺 columnWidths → tblGrid 全 100 twips
  const cell = (t) => new TableCell({ children: [new Paragraph(t)] });
  await save("r3.docx", new Document({
    sections: [{ children: [new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      rows: [new TableRow({ children: [cell("a"), cell("b"), cell("c")] })],
    })] }],
  }));

  // #4A indent universal measure 原样透传
  await save("r4a.docx", new Document({
    sections: [{ children: [new Paragraph({ text: "indent", indent: { firstLine: "0.75cm" } })] }],
  }));

  // #4B 页边距 universal measure → Word 拒开
  await save("r4b.docx", new Document({
    sections: [{
      properties: { page: { margin: { top: "2.54cm", bottom: "2.54cm", left: "3.18cm", right: "3.18cm" } } },
      children: [new Paragraph("margin")],
    }],
  }));

  // #5 rPr 子元素顺序：font+size（rFonts 应在最前）；underline+color（color 应在 u 前）
  await save("r5.docx", new Document({
    sections: [{ children: [new Paragraph({ children: [
      new TextRun({ text: "order", size: 18, font: "宋体" }),
      new TextRun({ text: "uc", underline: {}, color: "FF0000" }),
    ] })] }],
  }));

  // #5附带 strict 枚举 start 用在 lvlJc
  await save("r5b.docx", new Document({
    numbering: { config: [{ reference: "num1", levels: [
      { level: 0, format: LevelFormat.DECIMAL, text: "%1.", alignment: AlignmentType.START },
    ] }] },
    sections: [{ children: [new Paragraph({ text: "n", numbering: { reference: "num1", level: 0 } })] }],
  }));

  console.log("ok");
})().catch((e) => { console.error(e); process.exit(1); });
