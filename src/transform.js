/**
 * transform.js — def v2 → v1 变换（docs/architecture.md）
 *
 * 服务层的独立变换步骤：autoNumber 编号、caption 展开、{{ref:id}} 替换
 * 都在这里完成，渲染层 docxUtil.js 保持 v1 行为不动。
 * 纯函数，不依赖存储/MCP。
 *
 * transform(def, opts) → { def: v1def, warnings: [] }
 * buildNumberIndex(contexts) → { byId, order }（get_outline 复用同一套编号树）
 */
const { REF_RE } = require("./validator");

const MAX_HEADING_LEVEL = 6;

// ---------------------------------------------------------------- provenance
/**
 * _src 溯源（docs/editable-preview.md §3.1）：让富文本编辑视图能把渲染出来的
 * 一处文字映射回 def 里的字符串叶子。纯加法，渲染层忽略未知字段。
 *
 * 原位节点（text/heading/table/image）走恒等默认：只有被本层改写过的叶子才进
 * overrides，其余按「渲染值 === def 原值」处理——否则一张大表会被溯源撑爆。
 * 派生节点（图题/表题/checklist 展开项）在 def 里没有对应节点，输出形态与 def
 * 形态不同构，必须逐叶子显式给 at/path，恒等默认对它们不成立。
 */
const srcOf = (id, overrides) => {
  if (!id) return undefined; // 无 id 就没有写回目标；无 _src 即只读
  return overrides && overrides.length ? { id, overrides } : { id };
};

/** 派生节点：输出位置固定在 ["text"]，def 位置由调用方给出 */
const derivedSrc = (id, path, raw, prefix) => {
  if (!id) return undefined;
  const o = { at: ["text"], path };
  if (raw !== undefined) o.raw = raw;
  if (prefix) o.prefix = prefix;
  return { id, overrides: [o] };
};

/** 逐 run 比对 ref 替换前后，只为真正变了的叶子生成 override */
const refOverrides = (before, after) => {
  if (Array.isArray(before)) {
    const out = [];
    before.forEach((b, i) => {
      if (typeof b === "string" && b !== after[i]) out.push({ path: ["text", i], raw: b });
    });
    return out;
  }
  if (typeof before === "string" && before !== after) return [{ path: ["text"], raw: before }];
  return [];
};

/**
 * 走一遍 contexts，算出每个带 id 节点的编号与 sectionPath。
 * sectionPath 一律按 heading 树位置计算（§4.1）：autoNumber 关闭时它只是
 * 内部定位坐标，不渲染进文档。封面/首个 heading 之前的节点 sectionPath 为 ""。
 */
const buildNumberIndex = (contexts) => {
  const counters = new Array(MAX_HEADING_LEVEL).fill(0);
  let imageN = 0;
  let tableN = 0;
  let currentSection = "";
  const byId = {};
  const order = [];

  contexts.forEach((node, i) => {
    if (!node || typeof node !== "object") return;
    const entry = { index: i, type: node.type };
    // 编号按节重启（opt-in）：章号与图/表计数器清零。跨节 {{ref:}} 仍按
    // 目标节点自己的标签解析——重启后不同节会出现重复标签（两个「图1」），
    // 引用文本无歧义但阅读上需要节上下文，examples 里有场景提示
    if (node.type === "sectionBreak" && node.restartNumbering === true) {
      counters.fill(0);
      imageN = 0;
      tableN = 0;
      currentSection = "";
    }
    if (node.type === "heading" && typeof node.level === "number") {
      const level = Math.min(Math.max(1, node.level), MAX_HEADING_LEVEL);
      counters[level - 1]++;
      for (let l = level; l < MAX_HEADING_LEVEL; l++) counters[l] = 0;
      const number = counters.slice(0, level).join(".");
      entry.kind = "heading";
      entry.number = number;
      entry.label = number;
      currentSection = number;
      entry.sectionPath = number;
    } else {
      entry.sectionPath = currentSection;
      if (node.type === "image") {
        entry.kind = "image";
        // 浮动图不占图号：它脱离正文流，编上号会把后续图题挤错位；
        // {{ref:}} 指向它时按「不可编号节点」报 warn
        if (!node.float) {
          imageN++;
          entry.number = imageN;
          entry.label = `图${imageN}`;
        }
      } else if (node.type === "table") {
        tableN++;
        entry.kind = "table";
        entry.number = tableN;
        entry.label = `表${tableN}`;
      }
    }
    if (node.id) byId[node.id] = entry;
    order.push(entry);
  });

  return { byId, order };
};

/** 把一段字符串里的 {{ref:id}} 换成实际编号标签 */
const resolveRefsInString = (str, byId, autoNumber, warnings) => {
  return str.replace(REF_RE, (_, refId) => {
    const target = byId[refId];
    if (!target || !target.label) {
      warnings.push(`ref 悬空：{{ref:${refId}}} 指向不存在或不可编号的节点，渲染为占位`);
      return `[引用缺失:${refId}]`;
    }
    if (!autoNumber) {
      warnings.push(`autoNumber 关闭，{{ref:${refId}}} 无法解析编号，渲染为占位`);
      return `[引用未解析:${refId}]`;
    }
    return target.label;
  });
};

const resolveRefsInText = (text, byId, autoNumber, warnings) => {
  if (Array.isArray(text)) {
    return text.map((t) => (typeof t === "string" ? resolveRefsInString(t, byId, autoNumber, warnings) : t));
  }
  if (typeof text === "string") return resolveRefsInString(text, byId, autoNumber, warnings);
  return text;
};

/**
 * def v2 → v1。
 * opts.autoNumber：覆盖 meta.autoNumber（服务层合并 preset 后传入）
 * opts.captionStyle：图题表题样式 { textOptions, paragraphOptions }，来自 preset——
 *                    样式参数不写死在代码里，这里只负责结构展开
 * opts.target：目标查看器（"universal"|"word"），查看器相关特性的默认策略由它定
 * opts.h1PageBreak：每个一级标题自动另起一页（服务层按三层合并后 meta 传入）——
 *                   「每章起新页」是语义声明，逐章补分页是机械活，归本层
 */
const transform = (def, opts = {}) => {
  const meta = def.meta || {};
  const autoNumberOpt = opts.autoNumber !== undefined ? opts.autoNumber : meta.autoNumber;
  const autoNumber = !!autoNumberOpt;
  // native：编号由 Word 原生多级编号（标题样式 numPr）渲染，标题不拼文本编号。
  // ref/caption/静态 toc 仍按编号索引解析——渲染时刻数值与原生编号一致，
  // 用户在 Word 里改章节后原生编号重排而静态文本不动（实验开关的已知取舍）
  const nativeHeadings = autoNumberOpt === "native";
  const captionStyle = opts.captionStyle || {};
  const warnings = [];
  const { byId } = buildNumberIndex(def.contexts || []);

  // keepNext：表题要粘住下方的表格（图题在图下方，靠图片段落 keepNext 粘住图题）
  const makeCaptionNode = (label, caption, keepNext = false, srcId = null) => {
    const paragraphOptions = {
      ...(captionStyle.paragraphOptions || {}),
      ...(keepNext ? { keepNext: true } : {}),
    };
    // 图题表题是派生节点：输出在 ["text"]，写回目标是原节点的 ["caption"]
    const src = derivedSrc(srcId, ["caption"], String(caption), autoNumber ? `${label} ` : "");
    return {
      type: "text",
      text: autoNumber ? `${label} ${caption}` : String(caption),
      ...(captionStyle.textOptions ? { textOptions: captionStyle.textOptions } : {}),
      ...(Object.keys(paragraphOptions).length ? { paragraphOptions } : {}),
      ...(src ? { _src: src } : {}),
    };
  };

  const srcContexts = def.contexts || [];
  const contexts = [];
  srcContexts.forEach((node, idx) => {
    if (!node || typeof node !== "object") return;
    const entry = node.id ? byId[node.id] : null;
    switch (node.type) {
      case "heading": {
        const out = { ...node };
        const overrides = [];
        if (autoNumber && !nativeHeadings && entry && typeof out.text === "string") {
          // 编号是系统算的只读前缀，原文进 raw 作为编辑基准
          overrides.push({ path: ["text"], raw: out.text, prefix: `${entry.number} ` });
          out.text = `${entry.number} ${out.text}`;
        }
        if (opts.h1PageBreak && node.level === 1) {
          // 已经在新页上的不再补：文档开头 / 紧跟 newPage 或 sectionBreak（重复
          // 分页会凭空多一张空白页）；显式写了 pageBreakBefore 的尊重原值
          const prev = idx > 0 ? srcContexts[idx - 1] : null;
          const onFreshPage = !prev || prev.type === "newPage"
            || (prev.type === "sectionBreak" && prev.breakType !== "continuous"); // continuous 不换页
          if (!onFreshPage && !(out.paragraphOptions && out.paragraphOptions.pageBreakBefore !== undefined)) {
            out.paragraphOptions = { ...(out.paragraphOptions || {}), pageBreakBefore: true };
          }
        }
        const src = srcOf(node.id, overrides);
        contexts.push(src ? { ...out, _src: src } : out);
        break;
      }
      case "text": {
        const text = resolveRefsInText(node.text, byId, autoNumber, warnings);
        const src = srcOf(node.id, refOverrides(node.text, text));
        contexts.push({ ...node, text, ...(src ? { _src: src } : {}) });
        break;
      }
      case "table": {
        const { caption, ...rest } = node;
        // 表题在表上方（§4.1），keepNext 粘住表格
        if (caption) {
          const label = entry ? entry.label : `表?`;
          contexts.push(makeCaptionNode(label, caption, true, node.id));
        }
        const src = srcOf(node.id, []);
        contexts.push(src ? { ...rest, _src: src } : rest);
        break;
      }
      case "image": {
        const { caption, ...rest } = node;
        const src = srcOf(node.id, []);
        const withSrc = (n) => (src ? { ...n, _src: src } : n);
        // 浮动图不吃 caption：图题跟随正文流贴不住浮动图（也不占图号）
        if (node.float) {
          if (caption) {
            warnings.push(`浮动图${node.id ? ` ${node.id}` : ""} 的 caption 已忽略：图题在正文流里贴不住浮动图；需要图题就别用 float`);
          }
          contexts.push(withSrc(rest));
          break;
        }
        // 图题在图下方（§4.1）：图片段落 keepNext 粘住图题
        if (caption) {
          contexts.push(withSrc({ ...rest, paragraphOptions: { ...(rest.paragraphOptions || {}), keepNext: true } }));
          const label = entry ? entry.label : `图?`;
          contexts.push(makeCaptionNode(label, caption, false, node.id));
        } else {
          contexts.push(withSrc(rest));
        }
        break;
      }
      case "checklist": {
        // 任务清单糖：逐项展开成带 checkbox run 的 text 段落，渲染层保持 v1。
        // checklistItem 段落样式活在 preset（无首行缩进，同 mdList 一族）
        (node.items || []).forEach((item, i) => {
          const it = typeof item === "string" ? { text: item } : item || {};
          // 条目两种形态的写回路径不同：字符串形 items[i]，对象形 items[i].text
          const path = typeof item === "string" ? ["items", i] : ["items", i, "text"];
          const src = derivedSrc(node.id, path, String(it.text), " ");
          contexts.push({
            type: "text",
            text: ` ${it.text}`, // 复选框和文字之间留一格
            textOptions: { checkbox: it.checked ? { checked: true } : true },
            paragraphOptions: { style: "checklistItem", ...(node.paragraphOptions || {}) },
            ...(src ? { _src: src } : {}),
          });
        });
        break;
      }
      case "toc": {
        // native：透传给渲染层出 Word 原生 TOC 域（有页码，但打开要更新域，
        // WPS/LibreOffice 不理 updateFields 会一直空白）。默认静态展开：
        // 服务端用编号树生成目录段落，任何查看器立即可见，内链可跳，无页码。
        // 节点没写 native 时由 target 定：收件人确定用 Word → 原生域。
        const native = node.native !== undefined ? !!node.native : opts.target === "word";
        // 目录整体是生成物：条目文字跟着标题走，改这里等于制造一份和正文对不上的目录
        if (native) {
          // TOC 域的 alias 不是可见标题：更新域后只有条目——标题段照样服务端出
          contexts.push({
            type: "text", text: node.title || "目录",
            paragraphOptions: { style: "tocTitle" }, _src: { readonly: true },
          });
          contexts.push({ ...node, native: true, _src: { readonly: true } });
          break;
        }
        const maxLevel = Math.min(Math.max(1, node.maxLevel || 3), 3);
        contexts.push({
          type: "text", text: node.title || "目录",
          paragraphOptions: { style: "tocTitle" }, _src: { readonly: true },
        });
        (def.contexts || []).forEach((n) => {
          if (!n || n.type !== "heading" || typeof n.level !== "number" || n.level > maxLevel) return;
          const e = n.id ? byId[n.id] : null;
          contexts.push({
            type: "text",
            text: autoNumber && e ? `${e.number} ${n.text}` : String(n.text),
            // tocEntry 字符样式盖掉 Hyperlink 的蓝色下划线：目录条目按惯例是黑字
            textOptions: { ...(n.id ? { link: `#${n.id}` } : {}), style: "tocEntry" },
            paragraphOptions: { style: `toc${Math.min(n.level, 3)}` },
            _src: { readonly: true },
          });
        });
        break;
      }
      default: {
        // math/newPage/blank/sectionBreak 等：editableLeaves 对它们返回空，
        // 带上 id 只是让编辑器能定位节点（页眉页脚走 §3.5 的类型化通道）
        const src = srcOf(node.id, []);
        contexts.push(src ? { ...node, _src: src } : { ...node });
      }
    }
  });

  return { def: { ...def, meta, contexts }, warnings };
};

module.exports = { transform, buildNumberIndex };
