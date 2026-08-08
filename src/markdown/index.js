/**
 * index.js — Markdown → def contexts 转换入口（todo P0：输入适配层）
 *
 * markdownToDef(markdown, opts) → { contexts, issues }
 * 纯函数，不碰存储/MCP/渲染层；产出的 def 走既有链路
 * （fillNodeIds → validate → transform → docxUtil），Markdown 不进渲染层。
 *
 * opts:
 *   imagesAbsDir  图片相对路径的解析基准（绝对路径）
 *   imageMaxWidth 图片等比缩放上限 px（来自 preset markdown.imageMaxWidth）
 *   orderedRef    有序列表 numbering reference（preset 里定义，默认 md-ordered）
 *   bulletRef     无序列表 numbering reference（preset 里定义，默认 md-bullet）
 *   autoNumber    服务端自动编号开关：开着时剥掉 heading 手写编号（交给 autoNumber，
 *                 避免双重编号）；想保留手写编号走 meta.autoNumber=false
 *   titleFromH1   全文首个 heading 是 H1 时把它当文档标题（居中大字，不编号不进
 *                 toc），后续标题整体上移一级——「# 标题 / ## 章」的常见 Markdown
 *                 写法用它才能得到正确的章编号和 h1PageBreak 行为。返回值附带
 *                 docTitle 供建档标题缺省
 *
 * 样式约定：转换器只发样式引用，参数活在 preset JSON——
 *   正文 normalParagraph / 列表 mdList / 代码块 mdCode / 引用 mdQuote /
 *   行内代码 mdCodeChar（字符样式）/ 表格单元格 mdTableCell
 */
const MarkdownIt = require("markdown-it");
const footnotePlugin = require("markdown-it-footnote");
const { inlineToParagraphs, inlineToPlainText, soleImageToken } = require("./inline");
const { mathPlugin } = require("./math");
const { parseList } = require("./list");
const { parseTable } = require("./table");
const { imageTokenToNode } = require("./image");

const md = new MarkdownIt({ html: false }).use(mathPlugin).use(footnotePlugin);

// heading 手写编号：多级带空格（1.1 目标）/ 顿号（1、背景）/ 句点但非小数（1. 概述）。
// 单个数字+空格（2026 年度报告）和小数（1.5倍速）都不算编号，宁可漏剥不误伤。
const MANUAL_NUM_RE = /^\s*(?:\d+(?:\.\d+)+(?=\s)|\d+(?:\.\d+)*(?:、|\.(?!\d)))\s*/;

const stripManualNumber = (text, ctx) => {
  if (!ctx.opts.autoNumber) return text;
  const stripped = text.replace(MANUAL_NUM_RE, "");
  if (stripped === text || !stripped) return text;
  ctx.strippedHeadings.push(text);
  return stripped;
};

/** 前进到指定 close token（容错，正常结构就是紧邻） */
const skipTo = (tokens, i, closeType) => {
  while (i < tokens.length && tokens[i].type !== closeType) i++;
  return i;
};

/** 段落是否是「独占的展示公式」（唯一 math_display，旁边至多空白文本）→ 块级 math 节点 */
const soleMathDisplay = (children) => {
  let mathTok = null;
  for (const tok of children || []) {
    if (tok.type === "math_display") {
      if (mathTok) return null;
      mathTok = tok;
    } else if (tok.type === "text" && tok.content.trim() === "") continue;
    else if (tok.type === "softbreak" || tok.type === "hardbreak") continue;
    else return null;
  }
  return mathTok;
};

/**
 * 预扫 footnote_tail 挪到文末的定义块，建 id → 纯文本 map。
 * 定义里的多段落并成一句（脚注内容在 def 里是单字符串）；
 * footnote_anchor 回跳标记被 inlineToPlainText 天然忽略。
 */
const collectFootnotes = (tokens) => {
  const map = new Map();
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].type !== "footnote_open") continue;
    const id = tokens[i].meta && tokens[i].meta.id;
    const parts = [];
    while (i < tokens.length && tokens[i].type !== "footnote_close") {
      if (tokens[i].type === "inline") {
        const text = inlineToPlainText(tokens[i].children).trim();
        if (text) parts.push(text);
      }
      i++;
    }
    map.set(id, parts.join(" "));
  }
  return map;
};

/**
 * 处理 tokens[i] 起的一个块级结构，节点经 emit 吐出，返回已消费的最后一个下标。
 * env.paragraphStyle：普通段落的样式引用（blockquote 里换成 mdQuote）。
 */
const dispatch = (tokens, i, ctx, emit, env) => {
  const tok = tokens[i];
  switch (tok.type) {
    case "heading_open": {
      const level = Number(tok.tag.slice(1));
      const text = stripManualNumber(inlineToPlainText(tokens[i + 1].children), ctx);
      // titleFromH1：全文首个 heading 是 H1 → 文档标题段（居中大字，不进编号
      // 树也不进 toc），后续标题整体上移一级（## 章 → level 1）。「首个 H1 是
      // 标题还是第一章」只有作者知道，所以由调用方显式声明，不做启发式猜测
      if (ctx.opts.titleFromH1 && !ctx.seenHeading && level === 1) {
        ctx.seenHeading = true;
        ctx.titleShift = true;
        ctx.docTitle = text;
        emit({ type: "text", text, paragraphOptions: { style: "ParagraphTitle", alignment: "center" } });
        return skipTo(tokens, i, "heading_close");
      }
      ctx.seenHeading = true;
      if (ctx.titleShift && level === 1) {
        ctx.addIssue("warn", "md-title-multiple-h1",
          `titleFromH1 已把首个 H1 当作文档标题，但正文又出现 H1「${text}」——它会和上移后的原 H2 同级；章标题请统一用 ##`);
      }
      emit({ type: "heading", level: ctx.titleShift ? Math.max(1, level - 1) : level, text });
      return skipTo(tokens, i, "heading_close");
    }
    case "paragraph_open": {
      const children = tokens[i + 1].children;
      // [toc] 独占一段（MultiMarkdown 惯例）→ toc 节点，默认静态展开
      if (/^\[toc\]$/i.test((tokens[i + 1].content || "").trim())) {
        emit({ type: "toc" });
        return skipTo(tokens, i, "paragraph_close");
      }
      const mathTok = soleMathDisplay(children);
      if (mathTok) {
        emit({ type: "math", latex: mathTok.content });
        return skipTo(tokens, i, "paragraph_close");
      }
      const image = soleImageToken(children);
      if (image) {
        emit(imageTokenToNode(image, ctx));
      } else {
        inlineToParagraphs(children, ctx).forEach((fields) => {
          emit({ type: "text", ...fields, paragraphOptions: { style: env.paragraphStyle } });
        });
      }
      return skipTo(tokens, i, "paragraph_close");
    }
    case "fence":
    case "code_block": {
      const lines = tok.content.replace(/\n$/, "").split("\n");
      lines.forEach((line) => {
        emit({ type: "text", text: line, paragraphOptions: { style: "mdCode" } });
      });
      return i;
    }
    case "blockquote_open": {
      const quoteEnv = { ...env, paragraphStyle: "mdQuote" };
      let j = i + 1;
      while (j < tokens.length && tokens[j].type !== "blockquote_close") {
        j = dispatch(tokens, j, ctx, emit, quoteEnv) + 1;
      }
      return j;
    }
    case "bullet_list_open":
    case "ordered_list_open":
      return parseList(tokens, i, ctx, emit, env, dispatch);
    case "table_open": {
      const { node, nextIndex } = parseTable(tokens, i + 1, ctx);
      emit(node);
      return nextIndex;
    }
    case "hr":
      // docx 原生 thematicBreak：段落底部细线，正好是 markdown hr 的语义
      emit({ type: "text", text: "", paragraphOptions: { thematicBreak: true } });
      return i;
    case "html_block":
      ctx.addIssue("warn", "md-html", `HTML 块不支持，已丢弃：${tok.content.slice(0, 40)}`);
      return i;
    case "footnote_block_open":
      // 定义已在 collectFootnotes 收走、内容随引用进脚注区，文末定义块不进正文
      return skipTo(tokens, i, "footnote_block_close");
    default:
      return i;
  }
};

const markdownToDef = (markdown, opts = {}) => {
  const ctx = {
    issues: [],
    addIssue(level, rule, message) { this.issues.push({ level, rule, message }); },
    opts: { orderedRef: "md-ordered", bulletRef: "md-bullet", ...opts },
    orderedSeq: 0, // 有序列表 instance 分配器：每个顶层列表一个，编号从 1 重计
    strippedHeadings: [],
    footnotes: null, // [^1] 定义 id → 纯文本，parse 后预扫填入
    footnoteRefCounts: new Map(),
    seenHeading: false, // titleFromH1 只认全文首个 heading
    titleShift: false,
    docTitle: null,
  };
  const tokens = md.parse(String(markdown), {});
  ctx.footnotes = collectFootnotes(tokens);
  const contexts = [];
  const emit = (node) => contexts.push(node);
  const env = { paragraphStyle: "normalParagraph" };
  let i = 0;
  while (i < tokens.length) {
    i = dispatch(tokens, i, ctx, emit, env) + 1;
  }
  if (ctx.strippedHeadings.length > 0) {
    const sample = ctx.strippedHeadings.slice(0, 3).map((t) => `「${t}」`).join(" ");
    ctx.addIssue("warn", "md-heading-number",
      `autoNumber 开启，已剥掉 ${ctx.strippedHeadings.length} 处 heading 手写编号（${sample}），编号由服务端接管；要保留原编号请设 meta.autoNumber=false`);
  }
  return { contexts, issues: ctx.issues, ...(ctx.docTitle ? { docTitle: ctx.docTitle } : {}) };
};

module.exports = { markdownToDef };
