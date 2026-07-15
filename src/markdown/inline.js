/**
 * inline.js — markdown-it inline token → 渲染层 run 数组
 *
 * 输出 { text, textOptions }（单 run 时退化为 string / 单对象），
 * 供 text 节点直接使用。样式只发引用（mdCodeChar），参数活在 preset。
 * hardbreak 用 BREAK 哨兵标出，由段落层拆成多个 text 节点
 * （渲染层不支持段内换行 run）。
 */

const BREAK = Symbol("hardbreak");

const CJK_RE = /[一-鿿　-〿＀-￯]/;

/** 软换行：中文之间直接相连（加空格会出现夹缝），其余按 CommonMark 补空格 */
const softbreakJoint = (before, after) =>
  CJK_RE.test(before.slice(-1)) && CJK_RE.test(after.charAt(0)) ? "" : " ";

// 能转成原生超链接的协议；其余（相对路径、锚点等）Word 里没意义，降级展开
const NATIVE_LINK_RE = /^(https?:\/\/|mailto:)/i;

/**
 * 把 inline children 走成 run 列表：[{ text, opts }, BREAK, ...]。
 * strong/em 嵌套用计数器；http(s)/mailto 链接转原生超链接 run（textOptions.link），
 * 其余协议保持「文字（url）」展开 + warn。
 */
const walkRuns = (children, ctx) => {
  const runs = [];
  let bold = 0;
  let italics = 0;
  let linkHref = null;
  const linkStack = [];

  const push = (text, extra = {}) => {
    if (text === "") return;
    const opts = {
      ...(bold > 0 ? { bold: true } : {}),
      ...(italics > 0 ? { italics: true } : {}),
      ...(linkHref ? { link: linkHref } : {}),
      ...extra,
    };
    runs.push({ text, opts });
  };

  const toks = children || [];
  for (let ti = 0; ti < toks.length; ti++) {
    const tok = toks[ti];
    switch (tok.type) {
      case "text":
        push(tok.content);
        break;
      case "strong_open": bold++; break;
      case "strong_close": bold--; break;
      case "em_open": italics++; break;
      case "em_close": italics--; break;
      case "code_inline":
        push(tok.content, { style: "mdCodeChar" });
        break;
      case "link_open": {
        const href = tok.attrGet("href") || "";
        linkStack.push({ href, textStart: runs.length });
        if (NATIVE_LINK_RE.test(href)) linkHref = href;
        break;
      }
      case "link_close": {
        const link = linkStack.pop();
        linkHref = null;
        if (!link || !link.href || NATIVE_LINK_RE.test(link.href)) break;
        const linkText = runs.slice(link.textStart).map((r) => (r === BREAK ? "" : r.text)).join("");
        if (linkText !== link.href) push(`（${link.href}）`);
        ctx.addIssue("warn", "md-link-unsupported",
          `链接 "${link.href}" 不是 http(s)/mailto，保持文字展开不转超链接`);
        break;
      }
      case "softbreak": {
        const prev = runs.length ? runs[runs.length - 1] : null;
        const nextTok = toks[ti + 1];
        const before = prev && prev !== BREAK ? prev.text : "";
        const after = nextTok && typeof nextTok.content === "string" ? nextTok.content : "";
        const joint = softbreakJoint(before, after);
        if (joint) push(joint);
        break;
      }
      case "hardbreak":
        runs.push(BREAK);
        break;
      case "math_inline":
      case "math_display":
        // 展示公式混在文字里也按行内 run 处理；独占一段的 $$ 在 index.js 转块级节点
        push(tok.content, { math: true });
        break;
      case "footnote_ref": {
        const id = tok.meta && tok.meta.id;
        const content = ctx.footnotes ? ctx.footnotes.get(id) : undefined;
        if (content === undefined) break; // 插件保证有定义才产 token，防御一下
        // 空文本 run 只挂脚注标记：上标编号紧贴前一个 run 末尾
        runs.push({ text: "", opts: { footnote: content } });
        ctx.footnoteRefCounts.set(id, (ctx.footnoteRefCounts.get(id) || 0) + 1);
        if (ctx.footnoteRefCounts.get(id) === 2) {
          ctx.addIssue("warn", "md-footnote-ref-duplicate",
            `脚注 "${content.slice(0, 20)}" 被引用多次：Word 脚注按出现各生成一条，内容会重复`);
        }
        break;
      }
      case "image":
        // 行内混排图片渲染层做不了（P0 只支持独占一段的图片），降级为占位文字
        push(`[图片: ${tok.content || tok.attrGet("src") || ""}]`);
        ctx.addIssue("warn", "md-inline-image", "行内混排图片暂不支持，已降级为占位文字（独占一段的图片才转 image 节点）");
        break;
      case "html_inline":
        ctx.addIssue("warn", "md-html", `行内 HTML 不支持，已丢弃：${tok.content.slice(0, 30)}`);
        break;
      default:
        if (typeof tok.content === "string" && tok.content) push(tok.content);
        break;
    }
  }
  return runs;
};

/** run 列表 → 渲染层 text 节点字段。单 run 无样式时退化为纯字符串 */
const runsToTextFields = (runs) => {
  if (runs.length === 0) return { text: "" };
  const hasOpts = runs.some((r) => Object.keys(r.opts).length > 0);
  if (runs.length === 1) {
    return hasOpts ? { text: runs[0].text, textOptions: runs[0].opts } : { text: runs[0].text };
  }
  return {
    text: runs.map((r) => r.text),
    ...(hasOpts ? { textOptions: runs.map((r) => r.opts) } : {}),
  };
};

/** inline children → text 节点字段数组（hardbreak 处拆段） */
const inlineToParagraphs = (children, ctx) => {
  const runs = walkRuns(children, ctx);
  const segments = [];
  let current = [];
  for (const r of runs) {
    if (r === BREAK) {
      segments.push(current);
      current = [];
    } else {
      current.push(r);
    }
  }
  segments.push(current);
  return segments.map(runsToTextFields);
};

/** inline children → 纯文本（heading、表格单元格用，行内样式丢弃；
 * 公式退化为 LaTeX 原文，脚注引用标记丢弃——单元格/标题内不支持脚注） */
const inlineToPlainText = (children) => {
  const toks = children || [];
  let out = "";
  for (let i = 0; i < toks.length; i++) {
    const tok = toks[i];
    if (tok.type === "text" || tok.type === "code_inline"
        || tok.type === "math_inline" || tok.type === "math_display") out += tok.content;
    else if (tok.type === "softbreak" || tok.type === "hardbreak") {
      const next = toks[i + 1];
      out += softbreakJoint(out, (next && next.content) || "");
    } else if (tok.type === "image") out += tok.content || "";
  }
  return out;
};

/** 段落是否是「独占的图片」（唯一 image，旁边至多空白文本） */
const soleImageToken = (children) => {
  let image = null;
  for (const tok of children || []) {
    if (tok.type === "image") {
      if (image) return null;
      image = tok;
    } else if (tok.type === "text" && tok.content.trim() === "") {
      continue;
    } else if (tok.type === "softbreak" || tok.type === "hardbreak") {
      continue;
    } else {
      return null;
    }
  }
  return image;
};

module.exports = { inlineToParagraphs, inlineToPlainText, soleImageToken };
