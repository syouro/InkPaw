# 上游问题记录（dolanmiu/docx）

> 开发 docx-mcp 途中发现的 `docx` npm 包问题。每条尽量给到：现象、根因代码位置、
> 最小复现、建议修复方案，方便日后整理成 GitHub issue / PR 反馈给上游。
> 本地依赖 `docx@8.5.0`；标注「master 已核」的表示 2026-07-06 查过 GitHub master
> 源码（9.7.x 之后）问题仍在。
>
> **2026-07-11 复核**：全部条目在 `docx@9.7.1` 干净环境重跑最小复现——#1~#4 仍在，
> **#5 已修**（rPr 顺序 + start/end 归一化都对了）；另新发现 #6（highlightCs）。
> GitHub 直接可发的英文文稿见 `docs/upstream-drafts/`（含 #1 的 PR 补丁与复现脚本）。
>
> 背景：#1~#3 与 #4A 是 Word 打开正常、LibreOffice/WPS 渲染崩坏的类型——Word 的
> 解析极其宽容，掩盖了生成端的不规范，全部由 `scripts/docx2png.sh`（LibreOffice
> headless）视觉回归抓出，XML 断言测试全程绿灯。#4B 正好相反：LibreOffice 宽容、
> Word 拒开，视觉回归也抓不到，靠 `scripts/docx-validate.js` 的 Word 兼容检查兜底。

---

## 1. `bullet` 与 `style` 同用时生成重复 `w:pStyle`（非法 OOXML）【bug，master 已核】

**现象**：`new Paragraph({ style: "myStyle", bullet: { level: 0 } })` 生成：

```xml
<w:pPr>
  <w:pStyle w:val="ListParagraph"/>
  <w:pStyle w:val="myStyle"/>   <!-- 一个 pPr 两个 pStyle，schema 只允许一个 -->
  ...
```

Word 静默容忍（取其一），LibreOffice 24.8 的导入自此错乱——不仅该段落的项目符号丢失，
还会连带同文档其他部分（表格、编号）布局崩坏。

**根因**：`src/file/paragraph/properties.ts`（8.5.0 build 对应 `index.cjs` ~12455）。
`bullet` 路径无条件注入 `ListParagraph`，而紧邻的 `numbering` 路径有守卫——两处逻辑不对称：

```ts
if (options.bullet) {
    this.push(createParagraphStyle("ListParagraph"));   // ← 无条件
}
if (options.numbering) {
    if (!options.style && !options.heading) {           // ← numbering 却有守卫
        if (!options.numbering.custom) {
            this.push(createParagraphStyle("ListParagraph"));
        }
    }
}
if (options.style) {
    this.push(createParagraphStyle(options.style));     // ← 于是撞出第二个 pStyle
}
```

**最小复现**：

```js
const { Document, Packer, Paragraph } = require("docx");
const doc = new Document({
  styles: { paragraphStyles: [{ id: "myStyle", name: "myStyle", run: { size: 24 } }] },
  sections: [{ children: [new Paragraph({ text: "item", style: "myStyle", bullet: { level: 0 } })] }],
});
// 解包 document.xml：该段 pPr 里有两个 <w:pStyle>
```

**建议修复**：给 `bullet` 路径加与 `numbering` 一致的守卫：

```ts
if (options.bullet && !options.style && !options.heading) {
    this.push(createParagraphStyle("ListParagraph"));
}
```

一行改动，PR 门槛低。

**我们的规避**：无序列表不用 `bullet` 选项，改用自定义 numbering
（preset 里的 `md-bullet`，`format: "bullet"`），见 `src/markdown/list.js`。

---

## 2. 样式缺 `name` 时不写 `<w:name>`，LibreOffice/WPS 整条样式作废【互操作陷阱，master 已核】

**现象**：`paragraphStyles: [{ id: "myStyle", run: {...} }]`（不给 `name`——typings 里
`name` 可选）生成的 `<w:style>` 没有 `<w:name>` 子元素。Word 无所谓；LibreOffice 按
name 做样式映射，缺名的样式直接丢弃。后果分级：

- 普通段落引用它：样式静默失效（字体、缩进全丢）；
- **表格单元格**段落引用它：LO 的表格布局崩坏（实测表格塌成细缝、后续内容被吸进单元格）；
- **带编号（numPr）**的段落引用它：编号/项目符号整个不渲染。

后两种的破坏面远超「一条样式失效」，非常难排查——document.xml、numbering.xml 单看全对。

**根因**：`Style` 序列化只在 `options.name` 存在时写 `<w:name>`（8.5.0 `index.cjs`
~14869 `class Name`，调用处按可选处理）。OOXML schema 里 `w:name` 确实可选，
所以严格说不算 schema 违规，是生成默认值的选择问题。

**建议修复**（任选其一，前者更好）：

1. `name` 缺省时回填 `styleId`：`new Name(options.name ?? options.id)`；
2. 至少在文档/typings 注明「不给 name 的样式在 LibreOffice/WPS 下会被丢弃」。

**我们的规避**：渲染层合并样式时统一补 `name: id`（`src/docxUtil.js` 的 `namedStyle`）。

---

## 3. 缺省 `columnWidths` 时写出 100 twips 假网格，pct 宽度救不回来【bug 倾向，master 已核】

**现象**：不给 `columnWidths`、给 `width: { size: 100, type: WidthType.PERCENTAGE }`
的表格生成：

```xml
<w:tblW w:type="pct" w:w="100%"/>
<w:tblGrid><w:gridCol w:w="100"/><w:gridCol w:w="100"/>...</w:tblGrid>
```

每列 100 twips ≈ 1.8mm。Word 靠 autofit 救回来；LibreOffice/WPS 在单元格段落带
`pStyle` 时按 tblGrid 硬排，整表塌成细缝，溢出文字堆在页面左缘。

**根因**：`src/file/table/table.ts` 构造器默认值，且 TableGrid 无条件写入：

```ts
columnWidths = Array<number>(Math.max(...rows.map((row) => row.CellCount))).fill(100)
...
this.root.push(new TableGrid(columnWidths));
```

**建议修复**：`columnWidths` 缺省且 `width` 为 pct 时，要么写不带 `w:w` 的
`<w:gridCol/>`（属性可选）+ `<w:tblLayout w:type="autofit"/>`，要么按 pct 等比推列宽；
至少文档里说明「不给 columnWidths 的表格在非 Word 渲染器下会塌」。

**我们的规避**：渲染层按版心宽度（A4 − 边距）等分补真实 DXA 列宽
（`src/docxUtil.js` `customTable`）。

---

## 4. universal measure 字符串原样透传：LO 静默丢样式，Word 拒开文件【bug 倾向，升级于 2026-07-07】

**现象 A（样式长度，LO 侧）**：typings 允许 `indent: { firstLine: "0.75cm" }`
（`PositiveUniversalMeasure`），序列化时原样写成 `w:firstLine="0.75cm"`。Word 认这种
写法（ST_TwipsMeasure 允许带单位），LibreOffice 只认纯数字——首行缩进静默丢失。

**现象 B（页边距，Word 侧，2026-07-07 实测）**：`sections[].properties.page.margin`
传 `"2.54cm"` 之类字符串，原样写出 `<w:pgMar w:top="2.54cm" .../>`。ECMA-376 的
ST_(Signed)TwipsMeasure 是 `整数 | universal measure` 的 union，schema 校验全绿，
LibreOffice 正常打开渲染；**但 Word 实现（[MS-OI29500]）不支持 universal measure，
整份文件报「内容有错误」拒开**。这条比现象 A 严重一级：不是样式退化，是文件级不可用，
且视觉回归（docx2png 走 LibreOffice）完全抓不到。

**建议修复**：库里已有 `convertMillimetersToTwip` 等换算工具，序列化时把 universal
measure 统一换算成 twips 数值输出，对 Word 从拒开到正常、对 LO/WPS 从坏到好。

**我们的规避**：长度一律换算成 twips 数值再交给库——样式见 `docs/docxUtil-spec.md`
约定，页边距见 `src/docxUtil.js` `report()` 里的 `toTwips` 换算；`npm run validate --`
（`scripts/docx-validate.js`）把「wml part 里出现任何 universal measure」列为 error 兜底。

---

## 5. rPr 子元素按内部硬编码顺序序列化，违反 CT_RPr sequence，Word 报「不可读取的内容」【bug，2026-07-07 实测；**9.7.1 已修，不再反馈**】

> 2026-07-11 复核：9.7.1 对 rStyle/rFonts/b/i/color/sz/highlight/u 全组合输出顺序
> 已符合 CT_RPr sequence，附带的 start/end 也归一化成 left 了。含义：将来升级到
> docx@9 后，`fixWordCompat` 的 rPr 重排和 start/end 归一化可考虑降级为纯断言
>（`docx-validate.js` 出口检查保留）。

**现象**：`new TextRun({ text, size: 18, font: "宋体" })` 生成
`<w:rPr><w:sz/><w:szCs/><w:rFonts/></w:rPr>`——`rFonts` 排在 `sz` 之后；
`underline` + `color` 同用时 `<w:u>` 排在 `<w:color>` 之前。CT_RPr（ECMA-376
§17.3.2）是 **sequence**，rFonts 必须在最前、color 在 u 之前。Word 打开时弹
「发现不可读取的内容，是否恢复」；OpenXmlValidator（Office2019）对每处报
"unexpected child element"。LibreOffice 不校验顺序，视觉回归全绿，极易漏过。

**根因**：`RunProperties` 构造器按自身硬编码顺序 push（8.5.0 `index.cjs` ~10039，
b → i → u → color → sz/szCs → rStyle → **font** → highlight...），与 schema
sequence 不一致。凡是同时给 `font` 和 `size`/`bold` 的文档全部中招。

**建议修复**：RunProperties 序列化前按 CT_RPr 声明顺序排序输出（或调整 push 顺序）。

**我们的规避**：落盘前后处理（`src/docxUtil.js` `fixWordCompat`）：解包对所有
wml part 的 `<w:rPr>` 子元素按 CT_RPr 顺序重排；`scripts/docx-validate.js` 同表
（`RPR_CHILD_ORDER`）做出口断言。

**附带发现（值一并反馈）**：`AlignmentType.START/END`（"start"/"end"）是 strict
枚举，transitional Word 不认（ST_Jc 只有 left/right/center/both...），用在
`Level.alignment` 上 `<w:lvlJc w:val="start"/>` 同样触发修复弹窗。typings 不区分
strict/transitional，容易踩。我们出口把 start/end 归一化为 left/right。

---

## 6. `highlight` 附带输出 `w:highlightCs`——ECMA-376 里不存在的元素，schema 校验失败【bug，2026-07-11 发现】

**现象**：`new TextRun({ text, highlight: "yellow" })` 生成
`<w:rPr><w:highlight .../><w:highlightCs .../></w:rPr>`。CT_RPr 只给规范里有 CS
变体的属性配对（bCs/iCs/szCs…），**highlight 没有 CS 变体**，`w:highlightCs`
纯属杜撰——xmllint 过 transitional wml.xsd 直接报 unexpected element。

**根因**：`run/properties.ts`（master 现行）`highlightComplexScript` **缺省镜像
`highlight`**，不显式传 `highlightComplexScript: false` 就必然带出非法元素。
8.5.0 与 9.7.1 行为一致。

**建议修复**：去掉 `w:highlightCs` 输出（选项保留为 no-op），或至少翻转缺省值。

**我们的规避**：本仓 def 规范不暴露 highlight，渲染层不触发；`docx-validate.js`
的 schema 层能兜住（本次即由它抓出）。注意 `RPR_CHILD_ORDER` 白名单里只有
`w:highlight`——将来若暴露高亮功能，须传 `highlightComplexScript: false`。

---

## 7. 段落引用未注册的 numbering reference：不报错，`{reference-instance}` 占位符字面量直出 `w:numId`【bug 倾向，2026-07-13 线上发现】

**现象**：`new Paragraph({ numbering: { reference: "不存在的引用", level: 0 } })`
且 Document 的 numbering config 里没有该 reference 时，构建**不抛错**，产物里是
`<w:numId w:val="{不存在的引用-0}"/>`——`ST_DecimalNumber` 要求十进制数，schema
非法，**Word 直接拒开**（「不可读取的内容」）。8.5.0 实测。

**根因**：docx 用 `{reference-instance}` 字符串做延迟解析占位符，File 收尾时把
已注册 reference 的占位符替换成真实 numId；未注册的引用查不到就**原样漏出**，
既不抛错也不降级。

**建议修复**：收尾替换阶段发现未解析占位符时 throw（引用错误是调用方 bug，
静默产出损坏文件是最坏结局）；或至少剥掉 numPr 降级为普通段落 + console.warn。

**我们的规避**：校验器 error 级规则 `numbering-ref-unknown`（docs/architecture.md）——
reference 白名单 = `default-numbering` + 合并后 meta.numbering.config +
headingNumbering，建档/改节点即报，渲染闸拒绝带 error 的 def。

---

## 反馈前的待办

- [x] 在 `docx@9.x` 干净环境重跑四条的最小复现（2026-07-11，`docx@9.7.1`：#1~#4 全部仍复现，#5 已修出列，新增 #6；脚本入库 `docs/upstream-drafts/repro.js`）
- [x] issue 附 LibreOffice 崩坏截图 + 权威证据（2026-07-11：#2 在 LO 24.2.7 崩坏截图已存 `docs/upstream-drafts/evidence/`；本机 LO 24.2.7 对 #1/#3/#4A 已宽容、截不到崩坏，这三条改用 schema 校验输出 / MS-OI29500 佐证，措辞已在文稿里区分「旧版 LO/WPS 崩坏」）
- [x] #1 可以直接带 PR（补丁 `docs/upstream-drafts/patch-issue-1.diff`，守卫 + 测试）
- [ ] 逐条发到 dolanmiu/docx（英文文稿在 `docs/upstream-drafts/`，发布注意事项见其 README；建议 #4 优先——Word 拒开最重）
