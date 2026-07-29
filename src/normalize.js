/**
 * normalize.js — 入口归一化（docs/architecture.md）
 *
 * LLM 写 def 时允许的简写在这里落成规范形，存储层永远只有一种形态，
 * 校验器/渲染层/outline 不用各自兼容。与 fillNodeIds 同为入口净化步骤。
 *
 * 规则一：table.data 的行允许直接写数组（二维数组简写），
 * ["a", "b"] → { texts: ["a", "b"] }；单元格里的 number/boolean 转成
 * 字符串（渲染层 TextRun 只吃 string），完整形行的 texts 同样处理——
 * 两种行形对单元格类型的宽容度一致。
 *
 * 规则二：剥离外部传入的 _src。_src 是编辑视图的溯源信息（见
 * docs/editable-preview.md §3.1），只允许由 transform 在渲染时产出。
 * validator 不拒绝未知字段，不在入口剥掉的话客户端就能伪造写回目标。
 */

const normalizeCell = (cell) => {
  if (typeof cell === "number" || typeof cell === "boolean") return String(cell);
  if (Array.isArray(cell)) return cell.map(normalizeCell);
  if (cell && typeof cell === "object" && cell.text !== undefined) {
    return { ...cell, text: normalizeCell(cell.text) }; // 单格级样式的对象格
  }
  return cell;
};

const normalizeRow = (row) => {
  if (Array.isArray(row)) return { texts: row.map(normalizeCell) };
  if (row && typeof row === "object" && Array.isArray(row.texts)) {
    return { ...row, texts: row.texts.map(normalizeCell) };
  }
  return row;
};

const normalizeNode = (node) => {
  if (!node || typeof node !== "object") return node;
  const stripped = "_src" in node ? (({ _src, ...rest }) => rest)(node) : node;
  if (stripped.type !== "table" || !Array.isArray(stripped.data)) return stripped;
  return { ...stripped, data: stripped.data.map(normalizeRow) };
};

/** 原对象不动，返回归一化后的新 contexts 数组 */
const normalizeNodes = (contexts) => contexts.map(normalizeNode);

module.exports = { normalizeNodes, normalizeNode };
