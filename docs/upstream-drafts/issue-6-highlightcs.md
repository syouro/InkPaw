# [draft] `highlight` also emits `<w:highlightCs>`, which is not a valid `CT_RPr` child (fails XSD validation)

> 目标仓库：dolanmiu/docx · 建议标签：bug
> 2026-07-11 借重跑复现新发现，八/九系列均受影响。

## Describe the bug

Setting `highlight` on a run emits **both** `<w:highlight>` and `<w:highlightCs>`:

```xml
<w:rPr><w:highlight w:val="yellow"/><w:highlightCs w:val="yellow"/></w:rPr>
```

`w:highlightCs` does not exist in ECMA-376. `CT_RPr` defines complex-script variants only where the spec provides them (`bCs`, `iCs`, `szCs`, …) — there is no CS variant of `highlight`. Validation against the transitional `wml.xsd`:

```
element highlightCs: Schemas validity error : Element
'{http://schemas.openxmlformats.org/wordprocessingml/2006/main}highlightCs':
This element is not expected. Expected is ( ...rPrChange ).
```

Because `highlightComplexScript` **defaults to mirroring `highlight`** (`run/properties.ts`):

```ts
const highlightCs =
    options.highlightComplexScript === undefined || options.highlightComplexScript === true
        ? options.highlight
        : options.highlightComplexScript;
if (highlightCs) {
    this.push(new HighlightComplexScript(highlightCs));
}
```

every document that uses `highlight` at all produces schema-invalid XML unless the caller knows to pass `highlightComplexScript: false`.

## Reproduction (docx@9.7.1)

```js
const { Document, Packer, Paragraph, TextRun } = require("docx");

const doc = new Document({
  sections: [{ children: [new Paragraph({ children: [
    new TextRun({ text: "h", highlight: "yellow" }),
  ] })] }],
});
Packer.toBuffer(doc).then((b) => require("fs").writeFileSync("out.docx", b));
// word/document.xml → <w:highlightCs w:val="yellow"/> → not in ECMA-376
```

## Suggested fix

Drop the `w:highlightCs` element (and the `highlightComplexScript` option, or keep it as a no-op for compat). If some consumer depends on it, at least flip the default so `highlight` alone produces valid XML.

## Environment

- docx 9.7.1 (also 8.5.0; emission logic present on current master)
