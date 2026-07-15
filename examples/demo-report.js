// demo-report.js — docxUtil 的标准样本，LLM 生成 report def 时以此为参照
// 渲染: node src/docxUtil.js render examples/demo-report.js
// 覆盖特性：封面、页眉页脚、标题层级、normalParagraph、多 run 段落、
//           rowSpan 表格、格内多行、图片（含缺失占位）
const { docx } = require("../src/docxUtil");
const { AlignmentType } = docx;

const center = { alignment: AlignmentType.CENTER };
const cellText = { font: "宋体", size: 20 };

module.exports = {
  meta: {
    headerText: "InkPaw 演示报告 报告编号：IP-2026-001",
    imagesDir: "images", // 相对 report 文件所在目录
  },
  contexts: [
    // ---- 封面：blank 撑位 + 居中大字 + newPage
    { type: "blank" }, { type: "blank" }, { type: "blank" }, { type: "blank" },
    { type: "text", text: "docxUtil 演示报告", textOptions: { size: 52, bold: true, font: "宋体" }, paragraphOptions: center },
    { type: "blank" },
    { type: "text", text: "报告编号：IP-2026-001", textOptions: { size: 24, font: "宋体" }, paragraphOptions: center },
    { type: "blank" }, { type: "blank" }, { type: "blank" },
    { type: "text", text: "2026年07月", textOptions: { size: 24, font: "楷体" }, paragraphOptions: center },
    { type: "newPage" },
    // ---- 正文
    { type: "heading", level: 1, text: "1 概述" },
    { type: "text", text: "正文段落统一使用 normalParagraph 样式：宋体小四、首行缩进、两端对齐、1.5 倍行距，不手写这些参数。", paragraphOptions: { style: "normalParagraph" } },
    { type: "text",
      text: ["同一段落可以混排样式：", "这部分加粗强调，", "然后恢复正常。"],
      textOptions: [{ font: "宋体", size: 24 }, { font: "宋体", size: 24, bold: true }, { font: "宋体", size: 24 }],
      paragraphOptions: { style: "normalParagraph" } },
    { type: "heading", level: 2, text: "1.1 表格" },
    { type: "table",
      columnWidths: [2000, 3000, 3336],
      data: [
        { texts: ["类别", "项目", "说明"], textOptions: { ...cellText, bold: true }, paragraphOptions: center },
        { texts: ["环境", "温湿度", ["格内第一行：箱外温度", "格内第二行：箱内温度"]], textOptions: cellText, paragraphOptions: center },
        // 第 0 列被上一行 rowSpan 覆盖，这一行省略该格
        { texts: ["结构温度", "主梁关键截面 50 点"], textOptions: cellText, paragraphOptions: center },
        { texts: ["响应", "应变", "主梁最大 82.69uε"], textOptions: cellText, paragraphOptions: center },
      ],
      tableOptions: {
        span: { "1": { spanType: "rowSpan", spanCounts: 2, cNo: [0] } },
      } },
    { type: "heading", level: 2, text: "1.2 图片" },
    { type: "image", src: "demo.png", width: 200, height: 150, paragraphOptions: center },
    { type: "text", text: "图1 占位图", textOptions: { font: "宋体", size: 20 }, paragraphOptions: center },
    { type: "heading", level: 3, text: "1.2.1 三级标题" },
    { type: "text", text: "结束。", paragraphOptions: { style: "normalParagraph" } },
  ],
};
