# [draft] Paragraph with both `style` and `bullet` emits two `<w:pStyle>` elements (invalid OOXML)

> 目标仓库：dolanmiu/docx · 建议标签：bug
> 附 PR：`patch-issue-1.diff`（一行守卫 + 测试）

## Describe the bug

When a `Paragraph` sets both `style` and `bullet`, the generated `<w:pPr>` contains **two** `<w:pStyle>` elements. Per ECMA-376, `CT_PPr` allows at most one `pStyle` (and it must come first), so the output fails XSD validation.

Word silently tolerates this (it picks one), which hides the problem, but stricter consumers misbehave — we originally caught it because LibreOffice 24.8 lost the bullets and corrupted the layout of unrelated tables in the same document after importing such a file.

## Reproduction (docx@9.7.1)

```js
const { Document, Packer, Paragraph } = require("docx");

const doc = new Document({
  styles: { paragraphStyles: [{ id: "myStyle", name: "myStyle", run: { size: 24 } }] },
  sections: [{ children: [
    new Paragraph({ text: "item", style: "myStyle", bullet: { level: 0 } }),
  ] }],
});
Packer.toBuffer(doc).then((b) => require("fs").writeFileSync("out.docx", b));
```

Resulting `word/document.xml`:

```xml
<w:pPr>
  <w:pStyle w:val="ListParagraph"/>
  <w:pStyle w:val="myStyle"/>   <!-- second pStyle: invalid -->
  <w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>
</w:pPr>
```

`xmllint` against the ECMA-376 transitional schema (`wml.xsd`, after MCE preprocessing):

```
element pStyle: Schemas validity error : Element
'{http://schemas.openxmlformats.org/wordprocessingml/2006/main}pStyle':
This element is not expected. Expected is one of ( ...keepNext, keepLines, ... ).
```

## Root cause

`src/file/paragraph/properties.ts` — the `bullet` path pushes `ListParagraph` unconditionally, while the adjacent `numbering` path guards against an explicit `style`/`heading`. The two paths are asymmetric:

```ts
if (options.bullet) {
    this.push(createParagraphStyle("ListParagraph"));   // ← unconditional
}

if (options.numbering) {
    if (!options.style && !options.heading) {            // ← numbering has the guard
        if (!options.numbering.custom) {
            this.push(createParagraphStyle("ListParagraph"));
        }
    }
}

if (options.style) {
    this.push(createParagraphStyle(options.style));      // ← collides → 2nd pStyle
}
```

## Suggested fix

Give `bullet` the same guard as `numbering`:

```ts
if (options.bullet && !options.style && !options.heading) {
    this.push(createParagraphStyle("ListParagraph"));
}
```

Happy to open a PR — patch attached.

## Environment

- docx 9.7.1 (also present in 8.5.0; code unchanged on current master)
- Node.js 24
