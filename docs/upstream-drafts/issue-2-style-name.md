# [draft] Styles created without `name` omit `<w:name>`; LibreOffice/WPS drop the entire style (tables can collapse)

> 目标仓库：dolanmiu/docx · 建议标签：bug / interop
> 附截图：`evidence/issue2-libreoffice-table-collapse.png`

## Describe the bug

`paragraphStyles` typings mark `name` as optional. When it is omitted, the emitted `<w:style>` has no `<w:name>` child. That is technically schema-valid (`w:name` is optional in `CT_Style`), but LibreOffice and WPS Office map styles by name and **silently discard a style that has none**. The fallout escalates depending on where the style is referenced:

- plain paragraph → the style silently has no effect (font/size/indent lost);
- **table cell** paragraphs → LibreOffice's table layout breaks (in our tests the table collapses into slivers and following content gets pulled into cells — see screenshot);
- numbered paragraphs (`numPr`) → the numbering/bullets don't render at all.

This is very hard to debug: `document.xml`, `styles.xml` and `numbering.xml` each look fine in isolation.

## Reproduction (docx@9.7.1)

```js
const { Document, Packer, Paragraph, Table, TableRow, TableCell } = require("docx");

const mkTable = (styleId) => new Table({
  columnWidths: [3000, 3000, 3000],
  rows: [0, 1].map(() => new TableRow({
    children: ["alpha", "beta", "gamma"].map((t) => new TableCell({
      children: [new Paragraph({ text: t, style: styleId })],
    })),
  })),
});

const doc = new Document({
  styles: { paragraphStyles: [
    { id: "named", name: "named", run: { size: 24 } },
    { id: "noName", run: { size: 24 } },          // ← name omitted
  ] },
  sections: [{ children: [
    new Paragraph("Table 1: cells use a style WITH <w:name> (renders fine):"),
    mkTable("named"),
    new Paragraph(""),
    new Paragraph("Table 2: identical, but cell style has NO <w:name>:"),
    mkTable("noName"),
  ] }],
});
Packer.toBuffer(doc).then((b) => require("fs").writeFileSync("out.docx", b));
```

Emitted `styles.xml` entry:

```xml
<w:style w:type="paragraph" w:styleId="noName">
  <w:rPr><w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr>
</w:style>
```

Opened in LibreOffice (24.2.7 shown; same in 24.8), Table 1 renders normally while Table 2 collapses and its text spills outside the table — screenshot attached. Word renders both fine, which is exactly why this keeps slipping through.

## Suggested fix

Either of (the first is strictly better):

1. Default `name` to the style id at serialization: `new Name(options.name ?? options.id)`;
2. At minimum, document in the typings that styles without `name` are discarded by LibreOffice/WPS.

## Environment

- docx 9.7.1 (same behavior in 8.5.0 and on current master)
- LibreOffice 24.2.7 / 24.8, WPS Office; Word is unaffected
