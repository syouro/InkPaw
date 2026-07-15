/**
 * ids.js — 节点 id 补齐（docs/architecture.md）
 *
 * LLM 生成 def 时可以不给 id，create_document 时服务端补齐；
 * 给了则保留（唯一性由 validator 把关）。前缀按类型：
 * heading → h- / table → tbl- / image → img- / checklist → chk- /
 * math → eq- / sectionBreak → sec- / 其余（text/blank/newPage）→ p-
 */
const PREFIX = { heading: "h", table: "tbl", image: "img", checklist: "chk", math: "eq", sectionBreak: "sec" };

const randomSuffix = () => Math.random().toString(36).slice(2, 6).padEnd(4, "0");

/** 原地不动，返回补齐 id 后的新 contexts 数组 */
const fillNodeIds = (contexts) => {
  const used = new Set(contexts.filter((n) => n && n.id).map((n) => n.id));
  return contexts.map((node) => {
    if (!node || typeof node !== "object" || node.id) return node;
    const prefix = PREFIX[node.type] || "p";
    let id;
    do { id = `${prefix}-${randomSuffix()}`; } while (used.has(id));
    used.add(id);
    return { ...node, id };
  });
};

module.exports = { fillNodeIds };
