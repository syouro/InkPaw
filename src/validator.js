/**
 * validator.js — def 校验器（docs/architecture.md）
 *
 * validate(def, opts) → issues[]，issue = { level: 'error'|'warn', rule, nodeId?, message }
 * 这是本项目的核心安全网：LLM 传入的 def 全部过这里，error 级不清零不渲染。
 * 纯函数，不依赖存储/MCP。
 */
const fs = require("fs");
const path = require("path");
const { parseLatex } = require("./math-latex");
const { contentWidthOf, sectionConfigOf, toTwips, PAGEREF_RE } = require("./docxUtil");

const NODE_TYPES = new Set(["text", "heading", "table", "image", "newPage", "blank", "toc", "checklist", "math", "sectionBreak"]);

// 各类型必填字段（id 单独查，因为服务端可代填）
const REQUIRED_FIELDS = {
  text: ["text"],
  heading: ["level", "text"],
  table: ["data"],
  image: ["src"],
  newPage: [],
  blank: [],
  toc: [],
  checklist: ["items"],
  math: ["latex"],
  sectionBreak: [], // 全部字段可选：空 sectionBreak = 回到 meta 基准另起一节
};

const BREAK_TYPES = new Set(["nextPage", "continuous", "evenPage", "oddPage"]);
const PAGE_NUMBER_FORMATS = new Set(["decimal", "lowerRoman", "upperRoman"]);

const issue = (level, rule, message, nodeId) => ({
  level, rule, message, ...(nodeId ? { nodeId } : {}),
});

// 报错和权威示例串起来：LLM 看到 error 直接知道查 get_examples 哪个主题，
// 不用自己猜写法。主题名与 src/examples.js 的键一致（examples.test.js 兜底）。
const RULE_TOPIC = {
  "table-row-shape": "table",
  "table-col-mismatch": "table",
  "table-col-inconsistent": "table",
  "table-cell-type": "table",
  "table-header-rows": "table",
  "table-keep-together": "table",
  "table-width-overflow": "table",
  "table-span-shape": "table-span",
  "table-span-mismatch": "table-span",
  "table-span-no-widths": "table-span",
  "link-invalid": "link",
  "link-unsafe": "link",
  "link-dangling": "link",
  "link-target-not-heading": "link",
  "footnote-invalid": "footnote",
  "comment-invalid": "comment",
  "checklist-item-invalid": "checklist",
  "math-invalid": "math",
  "math-syntax": "math",
  "math-run-invalid": "math",
  "heading-manual-number": "heading",
  "heading-skip": "heading",
  "ref-dangling": "ref",
  "pageref-dangling": "ref",
  "pageref-target-invalid": "ref",
  "pageref-viewer": "ref",
  "image-missing": "image",
  "image-base64-invalid": "image",
  "image-float-invalid": "image",
  "image-base64-too-large": "image",
  "image-url-not-enabled": "image",
  "meta-image-invalid": "meta",
  "section-invalid": "section",
  "section-continuous-conflict": "section",
  "section-empty-first": "section",
  "native-number-restart": "section",
};

// missing-field 的主题跟着节点类型走
const TYPE_TOPIC = {
  text: "text", heading: "heading", table: "table", image: "image",
  toc: "toc", checklist: "checklist", math: "math",
};

const withExampleHint = (it, topic) => {
  const t = topic || RULE_TOPIC[it.rule];
  return t ? { ...it, message: `${it.message}｜写法示例：get_examples topic "${t}"` } : it;
};

const REF_RE = /\{\{ref:([^}]+)\}\}/g;
// 两种引用标记合起来扫一遍，保留它们在原文里的交错顺序——按类型分开收集会丢掉
// 相对次序。草稿视图的值编辑用它做标记一致性校验（docs/editable-preview.md §3.3）
const MARKER_RE = /\{\{(ref|pageRef):([^}]+)\}\}/g;

/** 一段文本里全部引用标记的指纹：类型:id 的有序序列，不含位置（改文字不该影响它） */
const markerFingerprint = (s) =>
  (typeof s === "string" ? [...s.matchAll(MARKER_RE)].map((m) => `${m[1]}:${m[2]}`) : []).join(",");

const collectByRe = (node, re) => {
  const texts = Array.isArray(node.text) ? node.text : [node.text];
  const ids = [];
  for (const t of texts) {
    if (typeof t !== "string") continue;
    for (const m of t.matchAll(re)) ids.push(m[1]);
  }
  return ids;
};

/** 收集一个 text 节点里所有 {{ref:id}} 引用的 id */
const collectRefs = (node) => collectByRe(node, REF_RE);

/** 收集一个 text 节点里所有 {{pageRef:id}} 引用的 id */
const collectPageRefs = (node) => collectByRe(node, PAGEREF_RE);

// 书签只打在这三类节点上（heading 段内书签 / image·table body 级书签），
// 内链和 pageRef 的合法目标一致
const BOOKMARKABLE_TYPES = new Set(["heading", "image", "table"]);

const ROW_SHAPE_HINT = "行应为 { texts: [...] } 或直接写数组（二维数组简写）";

/**
 * 单元格合法形态：string / string[]（格内多段）/ null（空格）/
 * { text, textOptions?, paragraphOptions? }（单格级样式）。number/boolean 入口已转字符串
 */
const checkCells = (row, i, nodeId, issues) => {
  const okText = (t) => typeof t === "string" || (Array.isArray(t) && t.every((c) => typeof c === "string"));
  row.texts.forEach((cell, j) => {
    if (cell === undefined || cell === null || okText(cell)) return;
    if (cell && typeof cell === "object" && !Array.isArray(cell) && okText(cell.text)) {
      const bad = Object.keys(cell).filter((k) => !["text", "textOptions", "paragraphOptions"].includes(k));
      if (bad.length === 0) return;
      issues.push(issue("error", "table-cell-type",
        `表格第 ${i} 行第 ${j} 格有未知键 ${bad.join(", ")}（对象格允许：text, textOptions, paragraphOptions）`, nodeId));
      return;
    }
    issues.push(issue("error", "table-cell-type",
      `表格第 ${i} 行第 ${j} 格类型非法：应为 string / string[]（格内多段）/ { text, textOptions? }（单格样式），实际 ${JSON.stringify(cell)}`, nodeId));
  });
};

/**
 * 表格网格铺排校验：把 span 声明在内存里铺成网格，
 * 检查每行"自带格子数 + 被上方 rowSpan 覆盖的格子数"是否恰好等于列数。
 * 这是 LLM 最容易静默写错的地方（docs/architecture.md）。报错一律带行列坐标 +
 * 修复后的 texts 长度，模型照着改就能过。
 */
const validateTable = (node, nodeId, issues, contentWidth) => {
  const columnWidths = node.columnWidths || node.columnsWith;
  const data = node.data;
  if (!Array.isArray(data)) return; // 缺 data 已在必填检查里报过
  // 列宽总和超版心：fixed 布局下表格会伸出右边距
  if (contentWidth && Array.isArray(columnWidths)) {
    const total = columnWidths.reduce((s, w) => s + (typeof w === "number" ? w : 0), 0);
    if (total > contentWidth) {
      issues.push(issue("warn", "table-width-overflow",
        `columnWidths 总和 ${total} 超过版心宽度 ${contentWidth}（twips），表格会伸出页边距——` +
        `等比缩小列宽，或不给 columnWidths 让服务端按版心等分`, nodeId));
    }
  }
  const headerRows = node.tableOptions && node.tableOptions.headerRows;
  if (headerRows !== undefined
      && (!Number.isInteger(headerRows) || headerRows < 0 || headerRows > data.length)) {
    issues.push(issue("warn", "table-header-rows",
      `tableOptions.headerRows 应是 0~行数(${data.length}) 的整数，实际 ${JSON.stringify(headerRows)}`, nodeId));
  }
  const keepTogether = node.tableOptions && node.tableOptions.keepTogether;
  if (keepTogether !== undefined && typeof keepTogether !== "boolean") {
    issues.push(issue("warn", "table-keep-together",
      `tableOptions.keepTogether 应是 boolean，实际 ${JSON.stringify(keepTogether)}`, nodeId));
  }
  const span = (node.tableOptions && node.tableOptions.span) || {};
  const hasSpan = Object.keys(span).length > 0;
  const colCount = Array.isArray(columnWidths) ? columnWidths.length : null;

  if (!hasSpan) {
    // 无列宽：渲染层按最宽行等分列宽，短行会渲染成参差表格——warn 点名短在哪
    const widest = colCount !== null ? colCount
      : Math.max(0, ...data.map((r) => (r && Array.isArray(r.texts) ? r.texts.length : 0)));
    data.forEach((row, i) => {
      if (!row || !Array.isArray(row.texts)) {
        issues.push(issue("error", "table-row-shape", `表格第 ${i} 行缺 texts 数组（${ROW_SHAPE_HINT}）`, nodeId));
        return;
      }
      checkCells(row, i, nodeId, issues);
      if (row.texts.length === widest) return;
      const diff = row.texts.length - widest;
      const fix = `把该行 texts 改为 ${widest} 格（${diff > 0 ? `多 ${diff} 格` : `少 ${-diff} 格`}）`;
      if (colCount !== null) {
        issues.push(issue("error", "table-col-mismatch",
          `表格第 ${i} 行有 ${row.texts.length} 格，columnWidths 声明 ${colCount} 列——${fix}`, nodeId));
      } else if (diff < 0) {
        issues.push(issue("warn", "table-col-inconsistent",
          `表格第 ${i} 行有 ${row.texts.length} 格，最宽行有 ${widest} 格——列宽按最宽行等分，短行渲染参差；${fix}`, nodeId));
      }
    });
    return;
  }

  // 有 span：逐行铺网格。pendingRowSpan[列号] = 该列还要被下方多少行省略
  if (colCount === null) {
    issues.push(issue("error", "table-span-no-widths", "有 span 的表格必须给 columnWidths", nodeId));
    return;
  }
  const pendingRowSpan = new Array(colCount).fill(0);
  for (let i = 0; i < data.length; i++) {
    const row = data[i];
    if (!row || !Array.isArray(row.texts)) {
      issues.push(issue("error", "table-row-shape", `表格第 ${i} 行缺 texts 数组（${ROW_SHAPE_HINT}）`, nodeId));
      return;
    }
    checkCells(row, i, nodeId, issues);
    const coveredCount = pendingRowSpan.filter((n) => n > 0).length;
    // columnSpan 的格子占多列：先算本行声明的 span
    const spanDefs = [].concat(span[i] || span[String(i)] || []);
    let colSpanExtra = 0;
    for (const d of spanDefs) {
      if (!d || !Array.isArray(d.cNo) || typeof d.spanCounts !== "number") {
        issues.push(issue("error", "table-span-shape",
          `表格第 ${i} 行 span 声明缺 cNo 数组或 spanCounts`, nodeId));
        return;
      }
      if (d.spanType === "columnSpan") colSpanExtra += d.cNo.length * (d.spanCounts - 1);
    }
    const expected = colCount - coveredCount - colSpanExtra;
    if (row.texts.length !== expected) {
      issues.push(issue("error", "table-span-mismatch",
        `表格第 ${i} 行有 ${row.texts.length} 格，按 span 铺网格应为 ${expected} 格` +
        `（${colCount} 列，被上方 rowSpan 覆盖 ${coveredCount} 格` +
        (colSpanExtra ? `，columnSpan 吃掉 ${colSpanExtra} 格` : "") +
        `）——把该行 texts 改为 ${expected} 格，或核对 span 定义`, nodeId));
      return; // 网格已铺不平，后续行的推算没有意义
    }
    // 本行消耗上方的覆盖，然后登记本行新声明的 rowSpan
    for (let c = 0; c < colCount; c++) if (pendingRowSpan[c] > 0) pendingRowSpan[c]--;
    for (const d of spanDefs) {
      if (d.spanType === "rowSpan") {
        for (const c of d.cNo) {
          if (c < 0 || c >= colCount) {
            issues.push(issue("error", "table-span-mismatch",
              `表格第 ${i} 行 rowSpan 的 cNo ${c} 超出列范围（共 ${colCount} 列）`, nodeId));
            return;
          }
          pendingRowSpan[c] = d.spanCounts - 1;
        }
      }
    }
  }
  const leftover = pendingRowSpan.filter((n) => n > 0).length;
  if (leftover > 0) {
    issues.push(issue("error", "table-span-mismatch",
      `表格末尾仍有 ${leftover} 处 rowSpan 声明未被后续行消耗（spanCounts 超出剩余行数）`, nodeId));
  }
};

// image.float 的合法值域（渲染层非法回退默认，这里提前 warn 出去）
const FLOAT_KEYS = new Set(["wrap", "horizontal", "vertical", "distance"]);
const FLOAT_WRAPS = new Set(["square", "tight", "topAndBottom", "behind", "inFront"]);
const FLOAT_H = { align: new Set(["left", "center", "right"]), rel: new Set(["margin", "page", "column"]) };
const FLOAT_V = { align: new Set(["top", "center", "bottom"]), rel: new Set(["margin", "page", "paragraph"]) };

/** image.float 校验：全部 warn 级（渲染层回退默认或按普通图排，不炸） */
const validateImageFloat = (node, issues) => {
  const f = node.float;
  const nodeId = node.id;
  if (f === null || typeof f !== "object" || Array.isArray(f)) {
    issues.push(issue("warn", "image-float-invalid",
      `image.float 应是对象 { wrap?, horizontal?, vertical?, distance? }，实际 ${JSON.stringify(f)}（已按普通图排版）`, nodeId));
    return;
  }
  for (const k of Object.keys(f)) {
    if (!FLOAT_KEYS.has(k)) {
      issues.push(issue("warn", "image-float-invalid",
        `image.float 未知字段 "${k}"（支持：wrap/horizontal/vertical/distance），已忽略`, nodeId));
    }
  }
  if (f.wrap !== undefined && !FLOAT_WRAPS.has(f.wrap)) {
    issues.push(issue("warn", "image-float-invalid",
      `image.float.wrap 非法："${f.wrap}"（允许：${[...FLOAT_WRAPS].join("/")}），回退 square`, nodeId));
  }
  const checkPos = (v, name, spec, relDefault) => {
    if (v === undefined) return;
    if (typeof v === "string") {
      if (!spec.align.has(v)) {
        issues.push(issue("warn", "image-float-invalid",
          `image.float.${name} 非法："${v}"（对齐允许：${[...spec.align].join("/")}，或 { offset: px, relative? }），回退默认`, nodeId));
      }
      return;
    }
    if (v === null || typeof v !== "object" || Array.isArray(v)) {
      issues.push(issue("warn", "image-float-invalid",
        `image.float.${name} 应是对齐关键字或 { offset: px, relative? }，实际 ${JSON.stringify(v)}，回退默认`, nodeId));
      return;
    }
    if (v.offset !== undefined && typeof v.offset !== "number") {
      issues.push(issue("warn", "image-float-invalid",
        `image.float.${name}.offset 应是数字（px），实际 ${JSON.stringify(v.offset)}，按 0 处理`, nodeId));
    }
    if (v.relative !== undefined && !spec.rel.has(v.relative)) {
      issues.push(issue("warn", "image-float-invalid",
        `image.float.${name}.relative 非法："${v.relative}"（允许：${[...spec.rel].join("/")}），回退 ${relDefault}`, nodeId));
    }
  };
  checkPos(f.horizontal, "horizontal", FLOAT_H, "margin");
  checkPos(f.vertical, "vertical", FLOAT_V, "paragraph");
  if (f.distance !== undefined && (typeof f.distance !== "number" || f.distance < 0)) {
    issues.push(issue("warn", "image-float-invalid",
      `image.float.distance 应是 ≥0 的数字（px 图文间距），实际 ${JSON.stringify(f.distance)}，回退默认 12`, nodeId));
  }
  if (Array.isArray(node.src) && node.src.length > 1) {
    issues.push(issue("warn", "image-float-invalid", "浮动图只支持单图，渲染取第一张", nodeId));
  }
  if (node.otherChildren) {
    issues.push(issue("warn", "image-float-invalid", "浮动图不支持 otherChildren（图旁文字由正文绕排承担），已忽略", nodeId));
  }
};

/** sectionBreak 节点自身字段校验（跨节联动 continuous 冲突在主循环里查，需前节配置） */
const validateSectionBreak = (node, nodeId, issues) => {
  // 全局 issues.map(withExampleHint) 会按 RULE_TOPIC 补「get_examples topic」提示，这里只发 issue()
  if (node.breakType !== undefined && !BREAK_TYPES.has(node.breakType)) {
    issues.push(issue("error", "section-invalid",
      `sectionBreak.breakType 非法："${node.breakType}"（允许：${[...BREAK_TYPES].join(", ")}）`, nodeId));
  }
  if (node.pageNumberFormat !== undefined && !PAGE_NUMBER_FORMATS.has(node.pageNumberFormat)) {
    issues.push(issue("error", "section-invalid",
      `sectionBreak.pageNumberFormat 非法："${node.pageNumberFormat}"（允许：${[...PAGE_NUMBER_FORMATS].join(", ")}）`, nodeId));
  }
  if (node.pageNumberStart !== undefined
      && (!Number.isInteger(node.pageNumberStart) || node.pageNumberStart < 1)) {
    issues.push(issue("error", "section-invalid",
      `sectionBreak.pageNumberStart 应是正整数，实际 ${JSON.stringify(node.pageNumberStart)}`, nodeId));
  }
  if (node.restartNumbering !== undefined && typeof node.restartNumbering !== "boolean") {
    issues.push(issue("warn", "section-invalid",
      `sectionBreak.restartNumbering 应是 true/false，实际 ${JSON.stringify(node.restartNumbering)}（已忽略）`, nodeId));
  }
  if (node.columns !== undefined && node.columns !== null) {
    const c = node.columns;
    const count = typeof c === "number" ? c : (c && typeof c === "object" ? c.count : undefined);
    if (c && typeof c === "object" && c.separator !== undefined && typeof c.separator !== "boolean") {
      issues.push(issue("warn", "section-invalid",
        `sectionBreak.columns.separator 应是 true/false（栏间分隔线），实际 ${JSON.stringify(c.separator)}（已忽略）`, nodeId));
    }
    if (!Number.isInteger(count) || count < 1) {
      issues.push(issue("warn", "section-invalid",
        `sectionBreak.columns 应是 ≥2 的整数或 { count, space?, separator? }，实际 ${JSON.stringify(c)}（已按单栏处理）`, nodeId));
    } else if (count === 1) {
      issues.push(issue("warn", "section-invalid", "sectionBreak.columns=1 无分栏效果（单栏是默认），可省略", nodeId));
    } else if (count > 4) {
      issues.push(issue("warn", "section-invalid", `sectionBreak.columns 栏数 ${count} 偏多，版心易塌成细缝，建议 ≤4`, nodeId));
    }
  }
  if (node.margins !== undefined && node.margins !== null) {
    if (typeof node.margins !== "object" || Array.isArray(node.margins)) {
      issues.push(issue("warn", "section-invalid", "sectionBreak.margins 应是 { top?, right?, bottom?, left? }，已忽略", nodeId));
    } else {
      for (const side of ["top", "right", "bottom", "left"]) {
        const v = node.margins[side];
        if (v !== undefined && toTwips(v) === null) {
          issues.push(issue("warn", "section-invalid",
            `sectionBreak.margins.${side} 认不出长度 ${JSON.stringify(v)}（用数字 twips 或 "2.54cm"/"25mm"/"1in"），该边回退默认`, nodeId));
        }
      }
    }
  }
};

// docx@8.5 对未注册的 numbering reference 不报错，而是把 "{reference-instance}"
// 占位符字面量写进 w:numId——schema 非法（ST_DecimalNumber），Word 直接拒开，
// 所以引用必须在这里 error 级拦死（2026-07-13 线上产物拒开事故）
const numberingRefsOf = (mergedMeta) => {
  const refs = new Set(["default-numbering"]);
  const cfg = mergedMeta.numbering && Array.isArray(mergedMeta.numbering.config)
    ? mergedMeta.numbering.config : [];
  for (const c of cfg) {
    if (c && typeof c.reference === "string" && c.reference) refs.add(c.reference);
  }
  if (mergedMeta.headingNumbering && Array.isArray(mergedMeta.headingNumbering.levels)) {
    refs.add(mergedMeta.headingNumbering.reference || "heading-num");
  }
  return refs;
};

const checkNumberingRef = (po, validRefs, whereDesc, nodeId, issues) => {
  if (!po || typeof po !== "object" || po.numbering === undefined || po.numbering === null) return;
  const n = po.numbering;
  if (typeof n !== "object" || Array.isArray(n) || typeof n.reference !== "string" || !n.reference) {
    issues.push(issue("error", "numbering-invalid",
      `numbering 必须是 { reference: "已注册引用", level: 数字 }，实际 ${JSON.stringify(n)}（${whereDesc}）`, nodeId));
    return;
  }
  if (!validRefs.has(n.reference)) {
    issues.push(issue("error", "numbering-ref-unknown",
      `numbering.reference "${n.reference}" 未注册（可用：${[...validRefs].join("、")}）——引用未注册编号渲染出的 docx Word 无法打开（${whereDesc}）`, nodeId));
  }
};

/**
 * 校验完整 def。
 * opts.imagesBaseDir: 解析 image src 用（不给则跳过图片存在性检查）
 * opts.autoNumber: 是否开启自动编号（决定"疑似手写编号"warn）
 * opts.contentWidth: 首节版心宽（服务层按合并后 meta 算）；表格超宽按所在节的版心判定
 * opts.meta: 合并后 meta（preset←profile←doc）；有它才能按节重算版心，缺省退回 opts.contentWidth 常量
 */
const validate = (def, opts = {}) => {
  const issues = [];
  if (!def || typeof def !== "object" || !Array.isArray(def.contexts)) {
    issues.push(issue("error", "def-shape", "def 必须是 { meta?, contexts: [...] } 结构"));
    return issues;
  }
  const contexts = def.contexts;
  const meta = def.meta || {};
  const autoNumber = opts.autoNumber !== undefined ? opts.autoNumber : meta.autoNumber;

  // 原生多级编号绑定标题样式，全文档连续——restartNumbering 清不掉它：
  // 标题显示编号照旧连续，而 {{ref:}} 标签按重启后的索引算，两者会对不上
  if (autoNumber === "native" && contexts.some((n) => n && n.type === "sectionBreak" && n.restartNumbering === true)) {
    issues.push(issue("warn", "native-number-restart",
      'autoNumber:"native" 与 restartNumbering 冲突：原生编号是标题样式级绑定、不随节清零，标题引用会与显示编号错位；需要按节重启编号请改用 autoNumber:true'));
  }

  // meta.docProps：写错静默无效难查——未知键/非字符串值都 warn
  if (meta.docProps !== undefined) {
    if (!meta.docProps || typeof meta.docProps !== "object" || Array.isArray(meta.docProps)) {
      issues.push(issue("warn", "doc-props-invalid", "meta.docProps 必须是对象，已忽略"));
    } else {
      const { DOC_PROPS_KEYS } = require("./docxUtil");
      for (const [k, v] of Object.entries(meta.docProps)) {
        if (!DOC_PROPS_KEYS.includes(k)) {
          issues.push(issue("warn", "doc-props-unknown",
            `meta.docProps 未知键 "${k}"（允许：${DOC_PROPS_KEYS.join(", ")}），已忽略`));
        } else if (typeof v !== "string") {
          issues.push(issue("warn", "doc-props-invalid", `meta.docProps.${k} 应是字符串，已忽略`));
        }
      }
    }
  }

  // meta.headerImage / footerImage：{ src, width?, height? }，src 规则同 image 节点
  for (const key of ["headerImage", "footerImage"]) {
    const v = meta[key];
    if (v === undefined || v === null) continue;
    if (typeof v !== "object" || Array.isArray(v) || typeof v.src !== "string" || !v.src) {
      issues.push(issue("warn", "meta-image-invalid", `meta.${key} 必须是 { src, width?, height? }，已忽略`));
      continue;
    }
    if (/^https?:\/\//i.test(v.src)) {
      if (!opts.fetchUrlImages) {
        issues.push(issue("warn", "image-url-not-enabled",
          `URL 图片默认不抓取：${v.src}（meta.${key}，渲染时跳过该图）。设 meta.fetchUrlImages:true 或用本地路径/base64`));
      }
    } else if (!v.src.startsWith("data:") && opts.imagesBaseDir) {
      const p = path.isAbsolute(v.src) ? v.src : path.resolve(opts.imagesBaseDir, v.src);
      if (!fs.existsSync(p)) {
        issues.push(issue("warn", "image-missing", `图片文件不存在: ${v.src}（meta.${key}，渲染时跳过该图）`));
      }
    }
  }

  // ---- id 唯一性 + 类型/必填
  const seenIds = new Set();
  const allIds = new Set();
  const idType = new Map(); // pageRef/内链查目标类型用
  contexts.forEach((node, i) => {
    const where = node && node.id ? node.id : `第 ${i} 个节点`;
    if (!node || typeof node !== "object") {
      issues.push(issue("error", "node-shape", `第 ${i} 个节点不是对象`));
      return;
    }
    if (node.id !== undefined) {
      if (typeof node.id !== "string" || !node.id) {
        issues.push(issue("error", "id-invalid", `第 ${i} 个节点 id 必须是非空字符串`));
      } else if (seenIds.has(node.id)) {
        issues.push(issue("error", "id-duplicate", `节点 id "${node.id}" 重复`, node.id));
      } else {
        seenIds.add(node.id);
        allIds.add(node.id);
        idType.set(node.id, node.type);
      }
    }
    if (!NODE_TYPES.has(node.type)) {
      issues.push(issue("error", "unknown-type", `未知节点类型 "${node.type}"（${where}）`, node.id));
      return;
    }
    for (const f of REQUIRED_FIELDS[node.type]) {
      if (node[f] === undefined || node[f] === null) {
        issues.push(withExampleHint(
          issue("error", "missing-field", `${node.type} 节点缺必填字段 "${f}"（${where}）`, node.id),
          TYPE_TOPIC[node.type]));
      }
    }
  });

  // ---- 逐类型深检查
  // 按节跟踪有效版心：landscape/margins/columns 都改变版心宽，表格超宽按所在节判定。
  // 合并后 meta（服务层传 opts.meta）才能按节重算；缺省退回 opts.contentWidth 常量。
  const mergedMeta = opts.meta || meta;
  const sectionWidth = (breakNode, isFirst) => contentWidthOf(sectionConfigOf(mergedMeta, breakNode, isFirst));
  let curContentWidth = opts.contentWidth != null ? opts.contentWidth : sectionWidth(null, true);
  let prevSectionConfig = sectionConfigOf(mergedMeta, null, true);
  if (contexts[0] && contexts[0].type === "sectionBreak") {
    issues.push(issue("warn", "section-empty-first",
      "首个节点就是 sectionBreak，会留一个空的首节——分节属性直接写进 meta 更简单", contexts[0].id));
  }
  let prevHeadingLevel = null;
  const validNumRefs = numberingRefsOf(mergedMeta);
  contexts.forEach((node, i) => {
    if (!node || typeof node !== "object") return;
    const where = node.id || `第 ${i} 个节点`;
    checkNumberingRef(node.paragraphOptions, validNumRefs, where, node.id, issues);
    switch (node.type) {
      case "sectionBreak": {
        validateSectionBreak(node, node.id, issues);
        const cfg = sectionConfigOf(mergedMeta, node, false);
        if (node.breakType === "continuous") {
          const orientChanged = !!cfg.landscape !== !!prevSectionConfig.landscape;
          const marginsChanged = JSON.stringify(cfg.margins) !== JSON.stringify(prevSectionConfig.margins);
          if (orientChanged || marginsChanged) {
            issues.push(issue("warn", "section-continuous-conflict",
              'breakType:"continuous" 但本节方向/边距与前节不同，Word 会强制另起页（continuous 不生效）', node.id));
          }
        }
        prevSectionConfig = cfg;
        curContentWidth = sectionWidth(node, false);
        break;
      }
      case "table":
        validateTable(node, node.id, issues, curContentWidth);
        if (Array.isArray(node.data)) {
          node.data.forEach((row, r) => {
            if (!row || typeof row !== "object" || Array.isArray(row)) return;
            checkNumberingRef(row.paragraphOptions, validNumRefs, `${where} 第 ${r} 行`, node.id, issues);
            (Array.isArray(row.texts) ? row.texts : []).forEach((cell, c) => {
              if (cell && typeof cell === "object" && !Array.isArray(cell)) {
                checkNumberingRef(cell.paragraphOptions, validNumRefs, `${where} 第 ${r} 行第 ${c} 格`, node.id, issues);
              }
            });
          });
        }
        break;
      case "heading": {
        const level = node.level;
        if (typeof level === "number") {
          if (prevHeadingLevel !== null && level > prevHeadingLevel + 1) {
            issues.push(issue("warn", "heading-skip",
              `heading 层级跳跃：${prevHeadingLevel} 级后直接出现 ${level} 级（${where}）`, node.id));
          }
          prevHeadingLevel = level;
        }
        if (autoNumber && typeof node.text === "string" && /^\s*\d+([.\s]|$)/.test(node.text)) {
          issues.push(issue("warn", "heading-manual-number",
            `autoNumber 开启但 heading text 疑似手写编号："${node.text}"（会双重编号）`, node.id));
        }
        break;
      }
      case "checklist": {
        if (!Array.isArray(node.items) || node.items.length === 0) {
          if (node.items !== undefined && node.items !== null) {
            issues.push(issue("error", "checklist-item-invalid",
              `checklist.items 必须是非空数组（${where}）`, node.id));
          }
          break;
        }
        node.items.forEach((item, j) => {
          if (typeof item === "string" && item.trim()) return;
          if (item && typeof item === "object" && typeof item.text === "string" && item.text.trim()
              && (item.checked === undefined || typeof item.checked === "boolean")) return;
          issues.push(issue("error", "checklist-item-invalid",
            `checklist 第 ${j} 项非法：应为非空字符串或 { text, checked? }，实际 ${JSON.stringify(item)}`, node.id));
        });
        break;
      }
      case "math": {
        if (node.latex === undefined || node.latex === null) break; // missing-field 已报
        if (typeof node.latex !== "string" || !node.latex.trim()) {
          issues.push(issue("error", "math-invalid", `math.latex 必须是非空字符串（${where}）`, node.id));
          break;
        }
        // 解析器与渲染层同一个：这里报的问题就是渲染时会出的问题
        for (const w of parseLatex(node.latex).warnings) {
          issues.push(issue("warn", "math-syntax", `公式 "${node.latex}"：${w}`, node.id));
        }
        break;
      }
      case "image": {
        const srcs = Array.isArray(node.src) ? node.src : [node.src];
        for (const src of srcs) {
          if (typeof src !== "string") continue;
          if (/^https?:\/\//i.test(src)) {
            // 抓取发生在 renderDocument（opt-in），这里只提示未启用的情况；
            // 启用后抓取失败由渲染返回的 warnings 报
            if (!opts.fetchUrlImages) {
              issues.push(issue("warn", "image-url-not-enabled",
                `URL 图片默认不抓取：${src}（渲染占位）。设 meta.fetchUrlImages:true 渲染时抓取（10s 超时/5MB/MIME 白名单），或先下载本地/转 base64`, node.id));
            }
            continue;
          }
          if (src.startsWith("data:")) {
            // base64 直传：查格式和大小（渲染层上限 5MB），不查文件系统
            if (!/^data:image\/[a-z+]+;base64,./i.test(src)) {
              issues.push(issue("error", "image-base64-invalid",
                `base64 图片格式非法：应为 data:image/<类型>;base64,<数据>（${where}）`, node.id));
            } else if (src.length > 7 * 1024 * 1024) { // base64 膨胀约 4/3，7M 字符 ≈ 5MB 二进制
              issues.push(issue("warn", "image-base64-too-large",
                "base64 图片超过 5MB 上限，渲染时占位", node.id));
            }
            continue;
          }
          if (opts.imagesBaseDir) {
            const p = path.isAbsolute(src) ? src : path.resolve(opts.imagesBaseDir, src);
            if (!fs.existsSync(p)) {
              issues.push(issue("warn", "image-missing", `图片文件不存在: ${src}（渲染时占位）`, node.id));
            }
          }
        }
        if (node.float !== undefined) validateImageFloat(node, issues);
        break;
      }
      default:
        break;
    }
  });

  // ---- ref / pageRef 悬空与目标类型
  let pageRefCount = 0;
  contexts.forEach((node) => {
    if (!node || node.type !== "text") return;
    for (const refId of collectRefs(node)) {
      if (!allIds.has(refId)) {
        issues.push(issue("warn", "ref-dangling",
          `ref 悬空：{{ref:${refId}}} 指向不存在的节点 id`, node.id));
      }
    }
    for (const refId of collectPageRefs(node)) {
      pageRefCount++;
      if (!allIds.has(refId)) {
        issues.push(issue("warn", "pageref-dangling",
          `pageRef 悬空：{{pageRef:${refId}}} 指向不存在的节点 id（域会渲染成书签错误）`, node.id));
      } else if (!BOOKMARKABLE_TYPES.has(idType.get(refId))) {
        issues.push(issue("warn", "pageref-target-invalid",
          `{{pageRef:${refId}}} 目标是 ${idType.get(refId)} 节点——书签只打在 heading/image/table 上，域会渲染成书签错误`, node.id));
      }
    }
  });
  // PAGEREF 域无缓存内容：Word 打开时提示更新域后出页码，WPS/LibreOffice 不理会
  // 一直空白——收件人不确定用 Word 就别用 pageRef
  const target = opts.target || mergedMeta.target || "universal";
  if (pageRefCount > 0 && target !== "word") {
    issues.push(issue("warn", "pageref-viewer",
      `文档用了 ${pageRefCount} 处 {{pageRef:}} 但 target 不是 "word"：页码域在 WPS/LibreOffice 显示空白，Word 也要打开时更新域。收件人确定用 Word 请设 meta.target:"word"，否则改用 {{ref:}} 编号引用`));
  }

  // ---- textOptions 逐 run 检查：link 协议白名单（javascript:/data: 等一律
  // 打回）+ 内链目标可跳 + footnote 内容合法
  contexts.forEach((node) => {
    if (!node || node.type !== "text" || node.textOptions === undefined) return;
    const optList = Array.isArray(node.textOptions) ? node.textOptions : [node.textOptions];
    optList.forEach((opt, runIdx) => {
      const math = opt && typeof opt === "object" ? opt.math : undefined;
      if (math !== undefined && typeof math !== "boolean") {
        issues.push(issue("error", "math-run-invalid", "textOptions.math 只接受布尔值", node.id));
      } else if (math === true) {
        // 行内公式：run 文本就是 LaTeX；textOptions 是单对象时作用于全部 run
        const runTexts = Array.isArray(node.text)
          ? (Array.isArray(node.textOptions) ? [node.text[runIdx]] : node.text)
          : [node.text];
        for (const t of runTexts) {
          if (typeof t !== "string" || !t.trim()) {
            issues.push(issue("error", "math-run-invalid", "行内公式 run 的文本必须是非空 LaTeX 字符串", node.id));
            continue;
          }
          for (const w of parseLatex(t).warnings) {
            issues.push(issue("warn", "math-syntax", `行内公式 "${t}"：${w}`, node.id));
          }
        }
      }
      const footnote = opt && typeof opt === "object" ? opt.footnote : undefined;
      if (footnote !== undefined && (typeof footnote !== "string" || !footnote.trim())) {
        issues.push(issue("error", "footnote-invalid", "textOptions.footnote 必须是非空字符串", node.id));
      }
      const comment = opt && typeof opt === "object" ? opt.comment : undefined;
      if (comment !== undefined && (typeof comment !== "string" || !comment.trim())) {
        issues.push(issue("error", "comment-invalid", "textOptions.comment 必须是非空字符串", node.id));
      }
      const link = opt && typeof opt === "object" ? opt.link : undefined;
      if (link === undefined) return;
      if (typeof link !== "string" || link === "") {
        issues.push(issue("error", "link-invalid", "textOptions.link 必须是非空字符串", node.id));
      } else if (link.startsWith("#")) {
        const anchorId = link.slice(1);
        if (!allIds.has(anchorId)) {
          issues.push(issue("warn", "link-dangling", `内链 "${link}" 指向不存在的节点 id`, node.id));
        } else if (!BOOKMARKABLE_TYPES.has(idType.get(anchorId))) {
          issues.push(issue("warn", "link-target-not-heading",
            `内链 "${link}" 目标是 ${idType.get(anchorId)} 节点（书签只打在 heading/image/table 上，跳转无效）`, node.id));
        }
      } else if (!/^(https?:\/\/|mailto:)/i.test(link)) {
        issues.push(issue("error", "link-unsafe",
          `link "${link}" 协议不允许（仅 http(s):// / mailto: / #内链）`, node.id));
      }
    });
  });

  return issues.map((it) => withExampleHint(it));
};

const hasErrors = (issues) => issues.some((it) => it.level === "error");

module.exports = { validate, hasErrors, collectRefs, collectPageRefs, REF_RE, MARKER_RE, markerFingerprint, RULE_TOPIC, TYPE_TOPIC };
