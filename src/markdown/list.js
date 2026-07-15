/**
 * list.js — markdown 列表 token → 原生编号/项目符号段落
 *
 * 有序列表走 preset 定义的 md-ordered 编号（三级），每个顶层列表分配
 * 独立 numbering instance，从 1 重新计数（docx 按 reference+instance
 * 生成 ConcreteNumbering）；嵌套列表继承父 instance，子级计数由 OOXML
 * 多级编号语义自己管。
 * 无序列表走 preset 定义的 md-bullet（不用 docx 的 bullet 选项：库会自动
 * 追加 ListParagraph pStyle，和我们的 mdList 撞成重复 pStyle——非法 XML，
 * LibreOffice 直接摆烂）。
 * 列表文字样式走 mdList 段落样式（preset 定义字体字号，不写死）。
 */
const { inlineToParagraphs } = require("./inline");

const ORDERED_MAX_LEVEL = 2; // md-ordered / md-bullet 在 preset 里只定义三级
const BULLET_MAX_LEVEL = 2;

// GFM 任务列表：无序列表项以 [ ] / [x] 开头 → 原生复选框段落（不出 bullet 符号）
const TASK_RE = /^\[( |x|X)\] /;

/**
 * 首段命中任务前缀则剥掉，首 run 挂 checkbox，返回新 fields；未命中返回 null。
 * 复选框和文字之间留一格（与 def 层 checklist 节点的展开一致）。
 */
const extractTask = (fields) => {
  const first = Array.isArray(fields.text) ? fields.text[0] : fields.text;
  if (typeof first !== "string") return null;
  const m = first.match(TASK_RE);
  if (!m) return null;
  const checkbox = m[1] === " " ? true : { checked: true };
  const stripped = ` ${first.slice(m[0].length)}`;
  if (!Array.isArray(fields.text)) {
    return { text: stripped, textOptions: { ...(fields.textOptions || {}), checkbox } };
  }
  const opts = fields.textOptions || fields.text.map(() => ({}));
  return {
    text: [stripped, ...fields.text.slice(1)],
    textOptions: [{ ...(opts[0] || {}), checkbox }, ...opts.slice(1)],
  };
};

/**
 * tokens[start] 是 bullet_list_open / ordered_list_open。
 * dispatch 是主分发器（处理列表项里嵌的代码块/引用等），由 index.js 传入避免循环依赖。
 * 返回 list_close 的下标。
 */
const parseList = (tokens, start, ctx, emit, env, dispatch, level = 0, inheritedInstance = null) => {
  const open = tokens[start];
  const ordered = open.type === "ordered_list_open";

  let instance = inheritedInstance;
  let clampedLevel = level;
  if (ordered) {
    if (instance === null) instance = ++ctx.orderedSeq;
    const startAttr = open.attrGet("start");
    if (startAttr && Number(startAttr) !== 1) {
      ctx.addIssue("warn", "md-list-start", `有序列表起始编号 ${startAttr} 不支持，已从 1 重新编号`);
    }
    if (level > ORDERED_MAX_LEVEL) {
      clampedLevel = ORDERED_MAX_LEVEL;
      ctx.addIssue("warn", "md-list-depth", `有序列表嵌套超过 ${ORDERED_MAX_LEVEL + 1} 级，按最深级渲染`);
    }
  } else if (level > BULLET_MAX_LEVEL) {
    clampedLevel = BULLET_MAX_LEVEL;
    ctx.addIssue("warn", "md-list-depth", `无序列表嵌套超过 ${BULLET_MAX_LEVEL + 1} 级，按最深级渲染`);
  }

  const numberingOptions = ordered
    ? { numbering: { reference: ctx.opts.orderedRef, level: clampedLevel, instance } }
    : { numbering: { reference: ctx.opts.bulletRef, level: clampedLevel, instance: 0 } };

  let i = start + 1;
  for (; i < tokens.length && tokens[i].type !== `${ordered ? "ordered_list" : "bullet_list"}_close`; i++) {
    if (tokens[i].type !== "list_item_open") continue;
    let firstParagraphDone = false;
    i++;
    for (; tokens[i].type !== "list_item_close"; i++) {
      const tok = tokens[i];
      if (tok.type === "paragraph_open") {
        const paragraphs = inlineToParagraphs(tokens[i + 1].children, ctx);
        paragraphs.forEach((fields) => {
          const task = !ordered && !firstParagraphDone ? extractTask(fields) : null;
          const opts = task ? { style: "checklistItem" }
            : firstParagraphDone ? { style: "mdList" }
            : { style: "mdList", ...numberingOptions };
          firstParagraphDone = true;
          emit({ type: "text", ...(task || fields), paragraphOptions: opts });
        });
        i += 2; // 跳过 inline + paragraph_close
      } else if (tok.type === "bullet_list_open" || tok.type === "ordered_list_open") {
        i = parseList(tokens, i, ctx, emit, env, dispatch, level + 1, ordered ? instance : null);
      } else {
        i = dispatch(tokens, i, ctx, emit, env);
      }
    }
  }
  return i;
};

module.exports = { parseList };
