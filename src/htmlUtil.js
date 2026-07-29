/**
 * htmlUtil.js — def → HTML 草稿视图（docs/editable-preview.md §3.2、§3.3）
 *
 * 与 docxUtil.js 平行的第二个渲染后端：同一份 def，一个出 DOCX，一个出可编辑
 * HTML。和 docxUtil 一样不依赖 MCP / SQLite / LibreOffice。
 *
 * 输入是 transform 的产物（带 _src 溯源）。每个可编辑叶子渲染成一个
 * contenteditable 容器，带 data-node-id + data-path（展示形）；系统算出来的
 * 编号、图表号、{{ref:}} 解析结果渲染成 contenteditable=false 的只读 chip。
 *
 * 定位是草稿视图不是 WYSIWYG（§1）：不分页、不画页眉页脚（§3.5.5），
 * 版式确认交给 PNG 版式视图。
 *
 * renderHtml(def, opts) → { html, warnings }
 *   opts.imageSrc(node) → string|null   图片 URL 解析，缺省不出图只留占位
 */
const { formatPath } = require("./nodePath");

const REF_TOKEN = /\{\{ref:([^}]+)\}\}/g;
// {{pageRef:id}} 不被 transform 解析（页码域由渲染层出），会以字面量停在正文里。
// 不锁住的话它就是可编辑区里一串能被改坏的原文，所以在这里也切成只读 chip。
const PAGEREF_TOKEN = /\{\{pageRef:([^}]+)\}\}/g;

const esc = (s) => String(s === undefined || s === null ? "" : s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const attr = (name, value) => (value ? ` ${name}="${esc(value)}"` : "");

// ---------------------------------------------------------------- 溯源查表

/** 输出侧叶子位置 → override。at 缺省等同 path（§3.1） */
const overrideIndex = (src) => {
  const map = new Map();
  if (!src || !Array.isArray(src.overrides)) return map;
  for (const o of src.overrides) map.set(formatPath(o.at || o.path), o);
  return map;
};

/**
 * 把渲染值拆回「只读 chip + 可编辑文本」。
 *
 * 渲染值 = prefix + resolve(raw)，这里按 raw 里的 {{ref:}} 标记与渲染值做
 * 同步走位，切出每个 ref 实际被替换成的标签文字。
 *
 * 两种情况放弃切分、整条降级为只读：前缀对不上，或两个 ref 紧挨着
 * （"{{ref:a}}{{ref:b}}" → "表1图2" 无从判定边界）。降级只损失可编辑性，
 * 绝不会切错边界写坏 def——安全方向的失败。
 */
const splitLeaf = (rendered, raw, prefix) => {
  const value = String(rendered === undefined || rendered === null ? "" : rendered);
  if (prefix && !value.startsWith(prefix)) return null;
  const body = prefix ? value.slice(prefix.length) : value;
  if (raw === undefined) return [{ type: "text", value: body }];

  // raw 拆成 literal / ref 交替序列
  const parts = [];
  let last = 0;
  for (const m of String(raw).matchAll(REF_TOKEN)) {
    parts.push({ type: "text", value: String(raw).slice(last, m.index) });
    parts.push({ type: "ref", id: m[1] });
    last = m.index + m[0].length;
  }
  parts.push({ type: "text", value: String(raw).slice(last) });
  if (parts.length === 1) return body === raw ? [{ type: "text", value: body }] : null;

  const out = [];
  let pos = 0;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p.type === "text") {
      if (!p.value) continue; // 首尾空 literal 正常；中间空 literal 在下面 ref 分支拦
      if (body.slice(pos, pos + p.value.length) !== p.value) return null;
      out.push({ type: "text", value: p.value });
      pos += p.value.length;
      continue;
    }
    const next = parts[i + 1];
    if (next && next.type === "text" && !next.value && i + 2 < parts.length) return null; // 连续 ref
    let label;
    if (next && next.type === "text" && next.value) {
      const idx = body.indexOf(next.value, pos);
      if (idx < 0) return null;
      label = body.slice(pos, idx);
      pos = idx;
    } else {
      label = body.slice(pos);
      pos = body.length;
    }
    out.push({ type: "ref", id: p.id, label });
  }
  return pos === body.length ? out : null;
};

/** 把已切好的 text 片段里的 {{pageRef:}} 字面量再切一层成只读 chip */
const splitPageRefs = (parts) => {
  if (!parts) return null;
  const out = [];
  for (const p of parts) {
    if (p.type !== "text") { out.push(p); continue; }
    let last = 0;
    for (const m of p.value.matchAll(PAGEREF_TOKEN)) {
      if (m.index > last) out.push({ type: "text", value: p.value.slice(last, m.index) });
      // 页码在渲染时才由 Word 域算出，草稿视图没有页码可显示，用记号占位
      out.push({ type: "pageRef", id: m[1], label: "页码" });
      last = m.index + m[0].length;
    }
    if (last < p.value.length) out.push({ type: "text", value: p.value.slice(last) });
  }
  return out;
};

// ---------------------------------------------------------------- 叶子渲染

const readonlyText = (value) => `<span class="ip-ro">${esc(value)}</span>`;

/**
 * 渲染一个叶子。src 缺失、标记 readonly、或切分失败 → 只读（§3.1 安全默认）。
 * prefix 落在可编辑容器**外面**：容器内容与 def 里的 raw 一一对应，
 * P3 重建字符串时不必再剔前缀。
 */
const renderLeaf = (src, outPath, rendered, idx) => {
  if (!src || src.readonly || !src.id) return readonlyText(rendered);
  const ov = idx.get(formatPath(outPath));
  const prefix = (ov && ov.prefix) || "";
  const raw = ov ? ov.raw : undefined;
  const parts = splitPageRefs(splitLeaf(rendered, raw, prefix));
  if (!parts) return readonlyText(rendered);

  const inner = parts.map((p) => {
    if (p.type === "ref") {
      return `<span class="ip-ref" contenteditable="false"${attr("data-ref", p.id)}>${esc(p.label)}</span>`;
    }
    if (p.type === "pageRef") {
      return `<span class="ip-ref" contenteditable="false"${attr("data-pageref", p.id)}>${esc(p.label)}</span>`;
    }
    return esc(p.value);
  }).join("");
  const rawPath = (ov && ov.path) || outPath;
  // data-path 是展示形（日志/测试可读），data-path-json 才是回传用的规范形。
  // 展示形单向不可解析（§3.2.1），前端要写回就得拿到段数组本身
  const defPath = formatPath(rawPath);
  const jsonPath = JSON.stringify(rawPath);
  // 纯空白前缀（checklist 的分隔空格）不出可见 chip，否则页面上是一串空灰块。
  // 不出 chip 不影响写回：前缀本来就在可编辑容器外，容器内容与 raw 一一对应
  const head = prefix.trim() ? `<span class="ip-num" contenteditable="false">${esc(prefix)}</span>` : "";
  return `${head}<span class="ip-leaf" contenteditable="true"`
    + `${attr("data-node-id", src.id)}${attr("data-path", defPath)}`
    + `${attr("data-path-json", jsonPath)}>${inner}</span>`;
};

/**
 * run 级附注（footnote/comment）：正文之外、由模型或用户撰写的内容，
 * 挂在 textOptions 上而非 text 里。草稿视图贴在该 run 后面。
 * base 是该 run 的 textOptions 路径前缀：单 run 为 ["textOptions"]，
 * 多 run 为 ["textOptions", i]。
 */
const renderNotes = (src, to, base, idx) => {
  if (!to || typeof to !== "object" || Array.isArray(to)) return "";
  return ["footnote", "comment"]
    .filter((k) => typeof to[k] === "string")
    .map((k) => `<span class="ip-note ip-note-${k}">${renderLeaf(src, [...base, k], to[k], idx)}</span>`)
    .join("");
};

/** text/heading 的正文：单 run 一条叶子，多 run 逐 run 一条（§3.2.4 编辑孤岛） */
const renderRuns = (node, src, idx) => {
  const { text, textOptions } = node;
  if (Array.isArray(text)) {
    return text.map((t, i) => {
      const to = Array.isArray(textOptions) ? textOptions[i] : undefined;
      return `<span class="ip-run">${renderLeaf(src, ["text", i], t, idx)}`
        + `${renderNotes(src, to, ["textOptions", i], idx)}</span>`;
    }).join("");
  }
  return renderLeaf(src, ["text"], text, idx) + renderNotes(src, textOptions, ["textOptions"], idx);
};

// ---------------------------------------------------------------- 表格

/** span[i] 的 cNo 是 texts 的实际下标；被覆盖的格在 def 里缺位——与 HTML 约定一致 */
const spanAttrs = (span, i, j) => {
  if (!Object.prototype.hasOwnProperty.call(span, i)) return "";
  const defs = Array.isArray(span[i]) ? span[i] : [span[i]];
  let out = "";
  for (const d of defs) {
    if (!d || !Array.isArray(d.cNo) || d.cNo.indexOf(j) === -1) continue;
    if (d.spanType === "rowSpan") out += attr("rowspan", d.spanCounts);
    else if (d.spanType === "columnSpan") out += attr("colspan", d.spanCounts);
  }
  return out;
};

const renderCell = (cell, src, base, idx) => {
  if (cell === undefined || cell === null) return "";
  if (Array.isArray(cell)) {
    return cell.map((v, k) => `<p>${renderLeaf(src, [...base, k], v, idx)}</p>`).join("");
  }
  if (typeof cell === "object") {
    if (cell.text === undefined) return "";
    return renderCell(cell.text, src, [...base, "text"], idx);
  }
  return `<p>${renderLeaf(src, base, cell, idx)}</p>`;
};

const renderTable = (node, src, idx) => {
  const data = Array.isArray(node.data) ? node.data : [];
  const to = node.tableOptions || {};
  const span = to.span || {};
  const headerRows = to.headerRows || 0;
  const rows = data.map((row, i) => {
    const texts = row && Array.isArray(row.texts) ? row.texts : [];
    const tag = i < headerRows ? "th" : "td";
    const cells = texts.map((cell, j) =>
      `<${tag}${spanAttrs(span, i, j)}>${renderCell(cell, src, ["data", i, "texts", j], idx)}</${tag}>`).join("");
    return `<tr>${cells}</tr>`;
  }).join("");
  return `<table class="ip-table"${attr("data-node-id", src && src.id)}>${rows}</table>`;
};

// ---------------------------------------------------------------- 节点分发

const renderNode = (node, opts, warnings) => {
  if (!node || typeof node !== "object") return "";
  const src = node._src;
  const idx = overrideIndex(src);
  const ro = src && src.readonly ? ' data-readonly="true"' : "";
  const style = attr("data-style", node.paragraphOptions && node.paragraphOptions.style);

  switch (node.type) {
    case "heading": {
      const lv = Math.min(Math.max(1, Number(node.level) || 1), 6);
      return `<h${lv} class="ip-h"${attr("data-node-id", src && src.id)}${ro}>${renderRuns(node, src, idx)}</h${lv}>`;
    }
    case "text": {
      // checklist 展开后勾选态活在 textOptions.checkbox；草稿视图要看得见，
      // 但它是结构状态不是文字，只读（改勾选属 P4 结构编辑）
      const cb = node.textOptions && !Array.isArray(node.textOptions) ? node.textOptions.checkbox : null;
      const box = cb
        ? `<span class="ip-checkbox" contenteditable="false">${cb.checked ? "☑" : "☐"}</span>`
        : "";
      return `<p class="ip-p"${style}${attr("data-node-id", src && src.id)}${ro}>`
        + `${box}${renderRuns(node, src, idx)}</p>`;
    }
    case "table":
      return renderTable(node, src, idx);
    case "image": {
      const url = opts.imageSrc ? opts.imageSrc(node) : null;
      const body = url
        ? `<img src="${esc(url)}" alt="">`
        : `<span class="ip-img-placeholder">[图片]</span>`;
      if (!url) warnings.push(`图片未提供预览 URL，渲染为占位：${node.src || node.path || "(无 src)"}`);
      return `<figure class="ip-figure"${attr("data-node-id", src && src.id)}>${body}</figure>`;
    }
    case "math":
      // 公式一期整体只读（docs/editable-preview.md §5）
      return `<p class="ip-math" data-readonly="true">${esc(node.latex || node.text || "")}</p>`;
    case "toc":
      // native TOC 域在草稿视图里没有可渲染内容，域由 Word 更新时才展开
      return `<p class="ip-toc-native" data-readonly="true">[目录域]</p>`;
    case "newPage":
      return `<hr class="ip-pagebreak">`;
    case "sectionBreak":
      return `<hr class="ip-sectionbreak">`;
    case "blank":
    case "Paragraph":
      return `<p class="ip-blank"></p>`;
    default:
      warnings.push(`未知节点类型 ${node.type}，草稿视图跳过`);
      return "";
  }
};

/**
 * def（transform 产物）→ HTML 片段。
 * 不渲染页眉页脚：草稿视图没有分页概念，画一条假页眉反而误导（§3.5.5）。
 */
const renderHtml = (def, opts = {}) => {
  const warnings = [];
  const contexts = (def && Array.isArray(def.contexts)) ? def.contexts : [];
  const body = contexts.map((n) => renderNode(n, opts, warnings)).join("\n");
  return { html: `<article class="ip-doc">\n${body}\n</article>`, warnings };
};

/** 草稿视图基础样式：只读 chip 要一眼可辨，可编辑区要有焦点反馈 */
const EDITOR_CSS = `
.ip-doc { max-width: 46em; margin: 0 auto; line-height: 1.7; }
.ip-leaf { outline: none; border-radius: 2px; }
.ip-leaf:focus { background: rgba(80,140,255,.10); box-shadow: 0 0 0 2px rgba(80,140,255,.35); }
.ip-num, .ip-ref { color: #6b7280; background: #eef1f5; border-radius: 3px; padding: 0 3px;
  user-select: none; cursor: default; }
.ip-ro { color: #6b7280; }
.ip-checkbox { margin-right: .35em; user-select: none; cursor: default; }
[data-readonly="true"] { color: #6b7280; }
.ip-note { font-size: .85em; color: #6b7280; margin-left: .3em; }
.ip-note::before { content: "["; } .ip-note::after { content: "]"; }
.ip-table { border-collapse: collapse; width: 100%; }
.ip-table th, .ip-table td { border: 1px solid #d0d5dd; padding: .35em .5em; vertical-align: middle; }
.ip-table p { margin: 0; }
.ip-figure { text-align: center; margin: 1em 0; }
.ip-figure img { max-width: 100%; }
.ip-img-placeholder { display: inline-block; padding: 2em 3em; background: #f3f4f6; color: #6b7280; }
.ip-pagebreak { border: 0; border-top: 1px dashed #c4c9d2; margin: 1.6em 0; }
.ip-sectionbreak { border: 0; border-top: 2px solid #c4c9d2; margin: 1.6em 0; }
.ip-blank { min-height: 1.7em; }
.ip-math { font-family: ui-monospace, monospace; }
`.trim();

module.exports = { renderHtml, EDITOR_CSS, splitLeaf, splitPageRefs };
