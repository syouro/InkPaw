# docxUtil 节点规范（LLM 生成 report.js 用）

> 配套 `scripts/docxUtil.js`（docxUtil1/2 合并修正版）。
> LLM 的任务：生成一个 `{ meta, contexts }` 数据结构（即 report.js），排版由 docxUtil 接管。
> 本文档的每个节点类型可以直接改写成一个 function call 定义（tool schema）。

## 用法

```js
const { saveReport, docx } = require("./docxUtil");
const { AlignmentType } = docx; // 不用单独 require docx

const def = { meta: {...}, contexts: [...] };
await saveReport(def, "out.docx");            // 写盘
// 或 report(def) 拿 Document 对象自己 Packer
```

## meta（全部可选）

| 字段 | 类型 | 默认 | 说明 |
|------|------|------|------|
| headerText | string | "" | 页眉右对齐文字，空则整份无页眉 |
| pageNumber | bool | true | 页脚"第x页 共x页" |
| titlePage | bool | true | 首页（封面）不显示页眉页脚 |
| landscape | bool | false | 页面横向 |
| margins | object | 2.54/3.17cm | `{top,right,bottom,left}`，接受 `"2.54cm"` 这类字符串 |
| imagesDir | string | "." | 图片根目录，image 节点的相对 src 基于它解析 |
| font | string | 宋体 | 默认字体 |
| styles | object | — | 覆盖/追加样式，`{default:{heading1:...}, paragraphStyles:[...], characterStyles:[...]}` 按 id 替换；缺 name 自动补 `name: id`（LibreOffice/WPS 按 name 映射样式，缺了作废）；样式里长度写 twips 数值，别用 "0.75cm" 字符串 |
| numbering | object | — | `{config:[...]}` 追加编号定义（内置 `default-numbering` 三级：`1.` `(2)` `3)`） |

## contexts 节点类型

尺寸单位约定：字号是半磅值（`24` = 12pt 小四，`20` = 10pt，`30` = 15pt）；表格列宽是 DXA（1cm ≈ 567）；图片宽高是像素。

### text — 段落
```js
{ type: "text", text: "内容", textOptions: {...}, paragraphOptions: {...} }
// 多 run（同一段落内混排样式）：text 和 textOptions 都给数组，按下标对应
{ type: "text",
  text: ["前半句，", "这半句加粗。"],
  textOptions: [{ size: 24 }, { size: 24, bold: true }],
  paragraphOptions: { style: "normalParagraph" } }
```
- `textOptions`：透传 docx TextRun（`font/size/bold/italics/color/underline`…）
- `paragraphOptions`：透传 docx Paragraph（`alignment/style/indent/spacing/numbering/pageBreakBefore`…）
- 正文段落**优先用 `style: "normalParagraph"`**（宋体小四、首行缩进 0.75cm、两端对齐、1.5 倍行距），别手写这几项
- 封面主标题可用 `style: "ParagraphTitle"`（方正小标宋简体）

### heading — 标题（自动进目录层级）
```js
{ type: "heading", level: 1, text: "1 概述" }
```
- level 1~3 有默认样式（宋体加粗 15/14/12pt）；编号自己写进 text，工具不自动编号
- 默认 `keepNext`（不落页底），paragraphOptions 传 `keepNext: false` 可关

### table — 表格
```js
{ type: "table",
  columnWidths: [2000, 3000, 3336],          // DXA，旧拼写 columnsWith 也认
  data: [
    { texts: ["列1", "列2", "列3"], textOptions: { size: 20, bold: true }, paragraphOptions: { alignment: AlignmentType.CENTER } },
    { texts: ["环境", "温湿度", ["格内第一行", "格内第二行"]], textOptions: { size: 20 } },
    { texts: ["结构温度", "50 点"] },          // ← 被 rowSpan 覆盖的行省略第 0 格
  ],
  tableOptions: {
    span: { "1": { spanType: "rowSpan", spanCounts: 2, cNo: [0] } },
    // 行号(字符串) → 合并定义（或数组）：spanType rowSpan|columnSpan，cNo 是列号数组
    images: { "2": [{ type: "image", cNo: [1], src: "x.png", width: 100, height: 80 }] },
    // 往指定行/列的格子追加图片或文字，cNo 必给
    rOptions: {...}, tOptions: {...},          // 透传 TableRow / Table
  } }
```
- 格子值：string 或 string[]（格内多段）；`texts` 里 undefined 会生成空格子
- **rowSpan 规则**：被合并覆盖的后续行，直接省略那个格子（不是填空字符串）
- 行内 `textOptions`/`paragraphOptions` 可以是数组，按格子下标对应
- 有 span 的表格不给格子单独设宽，宽度只由 columnWidths 控制
- 不给 columnWidths 时按版心宽度（A4 − 边距）等分补真实列宽（列数取最宽行）
- 行默认 `cantSplit`（跨页整行下移不劈开），`rOptions: { cantSplit: false }` 可关
- `cellOptions`: `{ bordersColumns: 列号, borders: {...}, options: {透传 TableCell} }`

### image — 图片段落
```js
{ type: "image", src: "fig1.png", width: 400, height: 300,
  paragraphOptions: { alignment: AlignmentType.CENTER } }
// 同段多图：src 给数组；otherChildren: {left:{text}, center:{text}} 在图旁插文字
```
- 相对 src 基于 meta.imagesDir；文件缺失 → 输出 `[图片缺失: xxx]` 占位并 warn，不中断
- 图题另起一个 text 节点（居中、size 20）放图片下方

### newPage — 分页
```js
{ type: "newPage" }
```

### blank — 空白行（封面排版用）
```js
{ type: "blank" }
```

### 封面写法（约定，非节点）
封面 = 若干 blank + 居中 text（大字号标题、编号、单位、日期）+ newPage。
`meta.titlePage: true`（默认）保证封面页无页眉无页码。

## 异常行为

| 情况 | 处理 |
|------|------|
| 未知 type | 跳过 + warn |
| 图片缺失 | 占位文字 + warn |
| heading level 越界 | 按 1 级处理 + warn |

## 给 LLM 的生成原则（从 llm-word-gen-proposal v2 继承）

1. 正文能用 `normalParagraph` 就不手写字号缩进
2. 表格合并用 span 时，先在心里画出网格再写 cNo/spanCounts，被覆盖的格子必须省略
3. 不发明规范外的节点类型和字段
4. 图片 src 只写相对路径，根目录由 meta.imagesDir 统一管
