/**
 * math.js — markdown-it 数学定界符插件（零依赖，todo「$...$ 行内公式」接线）
 *
 * 识别 Pandoc 惯例的两种定界符，产出 inline token（content 为去定界符的 LaTeX）：
 *   $...$   → math_inline   行内公式（转 textOptions.math run）
 *   $$...$$ → math_display  展示公式（独占一段时转块级 math 节点）
 *
 * 只做定界符切分，LaTeX 内容不在这里解析——校验器/渲染层用 math-latex.js
 * 统一处理，语法问题在那边 warn。
 *
 * 防误伤（美元金额）规则与 Pandoc 一致：
 *   - 开 $ 后不能是空白；闭 $ 前不能是空白（"$5 和 $6" 不会配对）
 *   - 闭 $ 后不能紧跟数字
 *   - \$ 转义不算定界符
 *   - 行内 $...$ 不跨行；$$...$$ 可跨行（块级公式常见写法）
 */

/** 从 end 起找未被反斜杠转义的 marker，找不到返回 -1 */
const findClosing = (src, from, marker) => {
  let end = from;
  for (;;) {
    end = src.indexOf(marker, end);
    if (end === -1) return -1;
    let bs = 0;
    for (let k = end - 1; k >= 0 && src[k] === "\\"; k--) bs++;
    if (bs % 2 === 0) return end;
    end += 1;
  }
};

const mathRule = (state, silent) => {
  const src = state.src;
  const pos = state.pos;
  if (src[pos] !== "$") return false;

  const display = src[pos + 1] === "$";
  const markerLen = display ? 2 : 1;
  const start = pos + markerLen;

  if (!display) {
    const ch = src[start];
    if (!ch || /\s/.test(ch) || ch === "$") return false;
  }

  const end = findClosing(src, start, display ? "$$" : "$");
  if (end === -1) return false;

  const content = src.slice(start, end);
  if (!content.trim()) return false;
  if (!display) {
    if (/\s$/.test(content)) return false;
    if (content.includes("\n")) return false;
    const after = src[end + 1];
    if (after && /\d/.test(after)) return false;
  }

  if (!silent) {
    const token = state.push(display ? "math_display" : "math_inline", "math", 0);
    token.content = content.trim();
    token.markup = display ? "$$" : "$";
  }
  state.pos = end + markerLen;
  return true;
};

const mathPlugin = (md) => {
  md.inline.ruler.after("escape", "math", mathRule);
};

module.exports = { mathPlugin };
