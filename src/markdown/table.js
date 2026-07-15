/**
 * table.js — markdown 表格 token → table 节点
 *
 * 列数以全表最大行为准，短行补空单元格并 warn（todo P0：转换前列数规整）。
 * 单元格取纯文本（行内样式在格子里丢弃，渲染层单元格不支持多 run）。
 * 不给 columnWidths，渲染层缺省铺满版心（pct 100%）。
 * 表头行标记 headerRows（跨页重复 + preset tableStyle 的表头样式作用范围），
 * 表头加粗居中不在这里写死——样式活在 preset 的 meta.tableStyle。
 */
const { inlineToPlainText } = require("./inline");

const parseTable = (tokens, start, ctx) => {
  const rows = [];
  let inHeader = false;
  let current = null;
  let i = start;
  for (; i < tokens.length && tokens[i].type !== "table_close"; i++) {
    const tok = tokens[i];
    switch (tok.type) {
      case "thead_open": inHeader = true; break;
      case "thead_close": inHeader = false; break;
      case "tr_open": current = { cells: [], header: inHeader }; break;
      case "tr_close": rows.push(current); current = null; break;
      case "inline":
        if (current) current.cells.push(inlineToPlainText(tok.children));
        break;
      default: break;
    }
  }

  const colCount = Math.max(...rows.map((r) => r.cells.length), 0);
  const ragged = rows.some((r) => r.cells.length !== colCount);
  if (ragged) {
    ctx.addIssue("warn", "md-table-ragged", `表格各行列数不一致，短行已补空单元格（按最宽行 ${colCount} 列规整）`);
  }
  const data = rows.map((r) => {
    const texts = [...r.cells];
    while (texts.length < colCount) texts.push("");
    return { texts, paragraphOptions: { style: "mdTableCell" } };
  });
  const headerRows = rows.filter((r) => r.header).length;

  return {
    node: { type: "table", data, ...(headerRows > 0 ? { tableOptions: { headerRows } } : {}) },
    nextIndex: i,
  };
};

module.exports = { parseTable };
