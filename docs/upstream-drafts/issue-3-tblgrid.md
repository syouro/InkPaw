# [draft] Omitted `columnWidths` writes a bogus 100-twip `<w:tblGrid>`; percentage table width cannot recover in grid-strict renderers

> 目标仓库：dolanmiu/docx · 建议标签：bug

## Describe the bug

A `Table` created without `columnWidths` but with `width: { size: 100, type: WidthType.PERCENTAGE }` emits a grid of 100-twip columns (100 twips ≈ 1.8 mm):

```xml
<w:tblW w:type="pct" w:w="100%"/>
<w:tblGrid>
  <w:gridCol w:w="100"/><w:gridCol w:w="100"/><w:gridCol w:w="100"/>
</w:tblGrid>
```

Word rescues the layout via autofit, so the defect stays invisible there. Renderers that honor `tblGrid` strictly (we reproduced with LibreOffice 24.8 when cell paragraphs carry a `pStyle`; WPS Office behaves the same) lay the table out at the literal grid widths: the whole table collapses into slivers and the overflowing text piles up at the left page edge.

The `100` here is not a real measurement — it's a hardcoded default:

```ts
// src/file/table/table.ts
columnWidths = Array<number>(Math.max(...rows.map((row) => row.CellCount))).fill(100)
...
this.root.push(new TableGrid(columnWidths));
```

## Reproduction (docx@9.7.1)

```js
const { Document, Packer, Paragraph, Table, TableRow, TableCell, WidthType } = require("docx");

const cell = (t) => new TableCell({ children: [new Paragraph(t)] });
const doc = new Document({
  sections: [{ children: [new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },   // no columnWidths
    rows: [new TableRow({ children: [cell("a"), cell("b"), cell("c")] })],
  })] }],
});
Packer.toBuffer(doc).then((b) => require("fs").writeFileSync("out.docx", b));
// word/document.xml → <w:gridCol w:w="100"/> ×3
```

## Suggested fix

When `columnWidths` is omitted and the table width is percentage-based, either:

1. emit `<w:gridCol/>` without the optional `w:w` attribute and add `<w:tblLayout w:type="autofit"/>`, or
2. derive real column widths proportionally from the page/content width.

Failing that, the docs should warn that tables without `columnWidths` collapse outside Word.

## Environment

- docx 9.7.1 (same in 8.5.0 and on current master)
- Breaks: LibreOffice 24.8 (with cell `pStyle`), WPS Office; Word rescues via autofit
