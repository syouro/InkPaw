# [draft] Universal measure strings are serialized verbatim; Word refuses to open files with them in `<w:pgMar>`

> 目标仓库：dolanmiu/docx · 建议标签：bug
> 这条是四条里后果最重的：文件级不可用，且 Word-only。

## Describe the bug

The typings accept universal measure strings (`PositiveUniversalMeasure`, e.g. `"2.54cm"`, `"0.75cm"`) in many places, and the serializer writes them out verbatim. Two escalating consequences:

**A. Style lengths (LibreOffice side).** `indent: { firstLine: "0.75cm" }` produces `w:firstLine="0.75cm"`. Word accepts it; older LibreOffice releases only parse plain numbers there and silently drop the indent (style degradation).

**B. Page margins (Word side — file becomes unopenable).** Passing strings to `sections[].properties.page.margin` produces:

```xml
<w:pgMar w:top="2.54cm" w:right="3.18cm" w:bottom="2.54cm" w:left="3.18cm" .../>
```

ECMA-376's `ST_(Signed)TwipsMeasure` is a union of `unsignedDecimalNumber | universal measure`, so this validates against the XSD — **but Word's implementation does not support the universal-measure branch here ([MS-OI29500]), and refuses to open the whole file** ("the file … contains errors"). LibreOffice opens the same file fine, so LibreOffice-based pipelines (docx→pdf previews, visual regression) never notice; the file only fails at the end user's Word.

## Reproduction (docx@9.7.1)

```js
const { Document, Packer, Paragraph } = require("docx");

const doc = new Document({
  sections: [{
    properties: { page: { margin: { top: "2.54cm", bottom: "2.54cm", left: "3.18cm", right: "3.18cm" } } },
    children: [new Paragraph("margin")],
  }],
});
Packer.toBuffer(doc).then((b) => require("fs").writeFileSync("out.docx", b));
// word/document.xml → <w:pgMar w:top="2.54cm" .../> → Word: "…contains errors" and won't open
```

## Suggested fix

The library already ships conversion helpers (`convertMillimetersToTwip` etc.). Convert universal measures to integer twips at serialization time instead of passing them through. That takes Word from "refuses to open" to correct, and old LibreOffice/WPS from degraded to correct, with no API change.

## Environment

- docx 9.7.1 (same in 8.5.0 and on current master)
- Word (desktop, tested 2026-07 builds): refuses to open case B; LibreOffice: opens fine (which masks it)
