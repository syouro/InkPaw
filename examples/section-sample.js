// section-sample.js — 多 section 样稿（docs/architecture.md）
// 渲染: node src/docxUtil.js render examples/section-sample.js
// 覆盖：封面首节 → 前置页（清页眉 + 罗马页码重启）→ 横向双栏附录（页码十进制重启）
// 关键点：继承非累积（空/局部 sectionBreak = meta 基准 + 自身覆盖）；titlePage 只作用第一节；
//        重启节页脚只「第x页」不带「共x页」；横向节版心更宽、双栏节内容按栏排
const { docx } = require("../src/docxUtil");
const { AlignmentType } = docx;

const center = { alignment: AlignmentType.CENTER };
const body = { style: "normalParagraph" };

module.exports = {
  meta: {
    headerText: "InkPaw 多分节演示",
    pageNumber: true,
    autoNumber: false, // 样稿手写编号，专注演示分节
  },
  contexts: [
    // ---- 第一节：封面（titlePage 抑制首页页眉页脚，纵向单栏）
    { type: "blank" }, { type: "blank" }, { type: "blank" }, { type: "blank" },
    { type: "text", text: "多分节文档演示", textOptions: { size: 52, bold: true, font: "宋体" }, paragraphOptions: center },
    { type: "blank" },
    { type: "text", text: "横向页 · 分栏 · 页码重启 · 分节页眉", textOptions: { size: 24, font: "楷体" }, paragraphOptions: center },
    { type: "newPage" },
    { type: "heading", level: 1, text: "一、说明" },
    { type: "text", text: "本节纵向单栏，页眉沿用 meta 的「InkPaw 多分节演示」，页码为默认十进制。", paragraphOptions: body },

    // ---- 第二节：前置页——清空页眉、页码用小写罗马从 i 重启
    { type: "sectionBreak", headerText: "", pageNumberStart: 1, pageNumberFormat: "lowerRoman" },
    { type: "heading", level: 1, text: "前言" },
    { type: "text", text: "前置页惯例：页眉留白，页码用小写罗马数字（i、ii、iii…）独立编号。重启节页脚只显示「第 i 页」不带总页数——节内总页在 WPS/LibreOffice 不渲染，去掉更干净。", paragraphOptions: body },
    { type: "text", text: "空 sectionBreak 即回到 meta 基准；这里只覆盖了页眉和页码，方向边距仍是纵向 A4。", paragraphOptions: body },

    // ---- 第三节：横向双栏附录，页码恢复十进制从 1 重启，页眉自动回到 meta
    { type: "sectionBreak", landscape: true, columns: 2, pageNumberStart: 1, pageNumberFormat: "decimal" },
    { type: "heading", level: 1, text: "附录：数据表区" },
    { type: "text", text: "横向双栏适合宽表和并排小节。页眉未在本 sectionBreak 覆盖，非累积继承下自动回到 meta 的「InkPaw 多分节演示」，不会延续前一节的留白。", paragraphOptions: body },
    { type: "text", text: "正文在栏内自动换行，填满左栏后流入右栏。表格超宽判定、图片缩放上限都按本节的横向栏宽计算，与纵向节不同。".repeat(4), paragraphOptions: body },
  ],
};
