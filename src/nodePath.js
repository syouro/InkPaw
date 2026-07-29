/**
 * nodePath.js — 可编辑叶子的路径寻址（docs/editable-preview.md §3.2）
 *
 * 富文本编辑视图要把「用户在页面上改的一处文字」映射回 def 节点里的某个
 * 字符串叶子。路径的规范形是**段数组**（["data",0,"texts",2,1]），不是点分
 * 字符串：字符串路径需要解析器和转义规则，是这类实现的经典 bug 源。
 * formatPath 只生成展示形（日志/测试快照），不提供反向解析。
 *
 * 白名单制：editableLeaves 遍历节点**实际形态**枚举出全部可编辑叶子，
 * isEditable/writePath 都以它为唯一判据。新增节点类型时默认只读，
 * 不会因为忘了加黑名单而变成可写。
 *
 * 输入必须是归一化后的节点（normalize.js 的产物）：table.data 的行统一为
 * { texts: [...] } 形，这里不再兼容二维数组简写。
 *
 * editableLeaves(node) → Segment[][]
 * isEditable(node, path) → boolean
 * readPath(node, path) → { ok, value } | { ok:false, code }
 * writePath(node, path, value) → { ok, node } | { ok:false, code, message }
 * formatPath(path) → string（单向展示形）
 */

// 原型污染防护：这三个键即使出现在数据里也一律拒绝（§3.2.3 规则 5）
const FORBIDDEN_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);

// run 级附注：正文之外、由模型/用户撰写的内容，挂在 textOptions 上而非 text 里
const RUN_NOTE_KEYS = ["footnote", "comment"];

const isStr = (v) => typeof v === "string";
const isIndex = (v) => typeof v === "number" && Number.isInteger(v) && v >= 0;

/** 段类型合法性：只允许对象键（string）与数组下标（非负整数） */
const isValidSegment = (s) => (isStr(s) && !FORBIDDEN_SEGMENTS.has(s)) || isIndex(s);

/**
 * 展示形：data[0].texts[2][1]。仅用于日志与测试快照。
 * 单向——不要写反向解析，那会把段数组的无歧义优势丢掉。
 */
const formatPath = (path) =>
  path.reduce((acc, s, i) => (isIndex(s) ? `${acc}[${s}]` : i === 0 ? String(s) : `${acc}.${s}`), "");

/** 字符串叶子 → 收下该路径；字符串数组 → 逐项收下。其余形态一律跳过（默认只读） */
const pushStringLeaves = (out, base, value) => {
  if (isStr(value)) {
    out.push(base);
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => { if (isStr(v)) out.push([...base, i]); });
  }
};

/** textOptions 的 footnote/comment：对象形（单 run）与数组形（多 run）两种 */
const pushRunNotes = (out, opts) => {
  if (!opts || typeof opts !== "object") return;
  if (Array.isArray(opts)) {
    opts.forEach((o, i) => {
      if (!o || typeof o !== "object") return;
      RUN_NOTE_KEYS.forEach((k) => { if (isStr(o[k])) out.push(["textOptions", i, k]); });
    });
    return;
  }
  RUN_NOTE_KEYS.forEach((k) => { if (isStr(opts[k])) out.push(["textOptions", k]); });
};

/**
 * 单元格三形态（normalize.js 的 normalizeCell 三种都保留，存储层不统一）：
 * 字符串 / 字符串数组（格内多行） / { text } 对象（格级样式）
 */
const pushCellLeaves = (out, base, cell) => {
  if (isStr(cell)) {
    out.push(base);
  } else if (Array.isArray(cell)) {
    cell.forEach((v, i) => { if (isStr(v)) out.push([...base, i]); });
  } else if (cell && typeof cell === "object" && cell.text !== undefined) {
    pushStringLeaves(out, [...base, "text"], cell.text);
  }
};

/**
 * 枚举一个 def 节点里全部可编辑叶子（§3.2.2 白名单）。
 * 未列入的字段——样式、版式、level/type/id/float/src、math 节点整体——一律只读。
 */
const editableLeaves = (node) => {
  if (!node || typeof node !== "object") return [];
  const out = [];
  switch (node.type) {
    case "text":
      pushStringLeaves(out, ["text"], node.text);
      pushRunNotes(out, node.textOptions);
      break;
    case "heading":
      // 一期不开放 heading 的 run 级附注：白名单只列正文（§3.2.2）
      pushStringLeaves(out, ["text"], node.text);
      break;
    case "image":
      if (isStr(node.caption)) out.push(["caption"]);
      break;
    case "table":
      if (isStr(node.caption)) out.push(["caption"]);
      if (Array.isArray(node.data)) {
        node.data.forEach((row, r) => {
          if (!row || !Array.isArray(row.texts)) return;
          // span 覆盖掉的格在 texts 里是缺位的，所以下标按实际数组走，不按视觉列号
          row.texts.forEach((cell, c) => pushCellLeaves(out, ["data", r, "texts", c], cell));
        });
      }
      break;
    case "checklist":
      if (Array.isArray(node.items)) {
        node.items.forEach((item, i) => {
          if (isStr(item)) out.push(["items", i]);
          else if (item && typeof item === "object" && isStr(item.text)) out.push(["items", i, "text"]);
        });
      }
      break;
    default:
      break; // 未知/生成类节点默认只读
  }
  return out;
};

const isEditable = (node, path) => {
  if (!Array.isArray(path) || !path.every(isValidSegment)) return false;
  const target = formatPath(path);
  return editableLeaves(node).some((p) => formatPath(p) === target);
};

const fail = (code, message) => ({ ok: false, code, message });

/** 逐段下行，任一段不存在即失败——不创建中间结构（§3.2.3 规则 1） */
const descend = (node, path) => {
  let cur = node;
  for (const seg of path) {
    if (cur === null || typeof cur !== "object") return { ok: false, code: "NOT_FOUND" };
    if (Array.isArray(cur)) {
      if (!isIndex(seg) || seg >= cur.length) return { ok: false, code: "NOT_FOUND" };
    } else if (!isStr(seg) || !Object.prototype.hasOwnProperty.call(cur, seg)) {
      return { ok: false, code: "NOT_FOUND" };
    }
    cur = cur[seg];
  }
  return { ok: true, value: cur };
};

const readPath = (node, path) => {
  if (!Array.isArray(path) || path.length === 0) return fail("BAD_PATH", "路径必须是非空段数组");
  if (!path.every(isValidSegment)) return fail("BAD_SEGMENT", `非法路径段：${formatPath(path)}`);
  return descend(node, path);
};

/**
 * 值编辑：定位既有字符串叶子并替换，不创建结构、不改变类型。
 * 走不可变更新（逐层浅拷贝），原节点不动。
 * 任一校验不过即整次失败，不做部分写入（§3.2.3）。
 */
const writePath = (node, path, value) => {
  if (!isStr(value)) return fail("BAD_VALUE", "新值必须是字符串");
  if (!Array.isArray(path) || path.length === 0) return fail("BAD_PATH", "路径必须是非空段数组");
  if (!path.every(isValidSegment)) return fail("BAD_SEGMENT", `非法路径段：${formatPath(path)}`);
  if (!isEditable(node, path)) return fail("NOT_EDITABLE", `路径不可编辑：${formatPath(path)}`);

  const found = descend(node, path);
  if (!found.ok) return fail("NOT_FOUND", `路径不存在：${formatPath(path)}`);
  // isEditable 已保证是字符串叶子，这里是兜底：防止白名单与实际形态失配时写坏子树
  if (!isStr(found.value)) return fail("NOT_STRING_LEAF", `目标不是字符串叶子：${formatPath(path)}`);

  const clone = (v) => (Array.isArray(v) ? [...v] : { ...v });
  const root = clone(node);
  let cur = root;
  for (let i = 0; i < path.length - 1; i++) {
    const next = clone(cur[path[i]]);
    cur[path[i]] = next;
    cur = next;
  }
  cur[path[path.length - 1]] = value;
  return { ok: true, node: root };
};

module.exports = { editableLeaves, isEditable, readPath, writePath, formatPath };
