/**
 * math-latex.js — LaTeX 子集 → 公式 AST（docs/architecture.md）
 *
 * 纯函数、零依赖：validator 用它查语法问题，渲染层把 AST 翻成 docx 的
 * Math 组件(OMML）。刻意只支持报告里常用的子集：
 *   分式 \frac{a}{b} / 根式 \sqrt{x}、\sqrt[n]{x} / 求和 \sum_{i=1}^{n}
 *   积分连乘 \int \iint \oint \prod（上下限语义同 \sum）
 *   装饰符 \bar \hat \vec \tilde \dot 等 / \overline \underline
 *   矩阵 \begin{matrix|pmatrix|bmatrix|vmatrix} ... & ... \\ ... \end{...}
 *   上下标 x^2、x_i、x_i^2 / 常用希腊字母与运算符（\alpha、\times…）
 *   \left \right 按纯拉伸提示剥掉；\, \; \: 转空格、\! 丢弃
 * 未识别的命令不炸：原样输出 + warning，公式主体照常渲染。
 *
 * AST 节点：
 *   { t:"run", text } | { t:"group", body:[] } | { t:"frac", num:[], den:[] }
 *   { t:"sqrt", body:[], degree?:[] } | { t:"sum", body:[], sub?:[], sup?:[] }
 *   { t:"nary", name, chr, limLoc, body:[], sub?:[], sup?:[] }
 *   { t:"acc", chr, body:[] } | { t:"bar", pos:"top"|"bot", body:[] }
 *   { t:"matrix", delim:null|[开,闭], rows:[[cellAst,...],...] }
 *   { t:"sup"|"sub", base:[], script:[] } | { t:"subsup", base:[], sub:[], sup:[] }
 */

// 常用符号命令 → Unicode。表驱动，加符号改这里
const SYMBOLS = {
  alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ε", zeta: "ζ",
  eta: "η", theta: "θ", lambda: "λ", mu: "μ", nu: "ν", xi: "ξ", pi: "π",
  rho: "ρ", sigma: "σ", tau: "τ", phi: "φ", chi: "χ", psi: "ψ", omega: "ω",
  Gamma: "Γ", Delta: "Δ", Theta: "Θ", Lambda: "Λ", Xi: "Ξ", Pi: "Π",
  Sigma: "Σ", Phi: "Φ", Psi: "Ψ", Omega: "Ω",
  times: "×", div: "÷", pm: "±", mp: "∓", cdot: "⋅", le: "≤", leq: "≤",
  ge: "≥", geq: "≥", ne: "≠", neq: "≠", approx: "≈", equiv: "≡",
  infty: "∞", partial: "∂", nabla: "∇", in: "∈", notin: "∉", subset: "⊂",
  cup: "∪", cap: "∩", forall: "∀", exists: "∃", rightarrow: "→",
  leftarrow: "←", Rightarrow: "⇒", ldots: "…", cdots: "⋯", dots: "…",
  prime: "′", degree: "°",
  sim: "∼", simeq: "≃", propto: "∝", perp: "⊥", parallel: "∥",
  angle: "∠", circ: "∘", star: "⋆", oplus: "⊕", otimes: "⊗",
  emptyset: "∅", subseteq: "⊆", supset: "⊃", supseteq: "⊇",
  wedge: "∧", vee: "∨", neg: "¬", mid: "∣", langle: "⟨", rangle: "⟩",
};

// 装饰符命令 → Unicode combining 字符（OMML m:acc 的 m:chr）
const ACCENTS = {
  bar: "̅", hat: "̂", tilde: "̃", vec: "⃗",
  dot: "̇", ddot: "̈", check: "̌", breve: "̆",
  acute: "́", grave: "̀",
};

// n 元算子命令。limLoc：积分族惯例上下限在右侧（subSup），连乘同 \sum 上下居中
const NARY = {
  int: { chr: "∫", limLoc: "subSup" },
  iint: { chr: "∬", limLoc: "subSup" },
  iiint: { chr: "∭", limLoc: "subSup" },
  oint: { chr: "∮", limLoc: "subSup" },
  prod: { chr: "∏", limLoc: "undOvr" },
};

// 矩阵环境 → 定界符对。null = 裸矩阵
const MATRIX_ENVS = {
  matrix: null, pmatrix: ["(", ")"], bmatrix: ["[", "]"], vmatrix: ["|", "|"],
};

// LaTeX 间距命令：\, \: \; 转空格、\!（负间距）丢弃。\{ \% 等其余转义原样
const SPACING_ESCAPES = { ",": " ", ":": " ", ";": " ", "!": "" };

// 函数名命令：直译成同名文本（\sin x → sin x）。\lim_{} 的下限会落在右下角
// 而非正下方（OMML limLow 未接），报告场景够用
const FUNCTIONS = new Set([
  "sin", "cos", "tan", "cot", "sec", "csc", "log", "ln", "exp",
  "det", "lim", "max", "min", "arg", "gcd", "sup", "inf", "mod",
]);

const parseLatex = (input) => {
  const warnings = [];
  // \left \right 是纯拉伸提示，剥掉后裸定界符照常解析；\left. \right. 连点一起剥
  const s = String(input)
    .replace(/\\(left|right)\s*\./g, "")
    .replace(/\\(left|right)(?=\s*[()[\]|])/g, "");
  let pos = 0;

  const peek = () => s[pos];
  const next = () => s[pos++];

  /** \ 后的命令名（字母串），或单个转义字符 */
  const readCommand = () => {
    let name = "";
    while (pos < s.length && /[a-zA-Z]/.test(s[pos])) name += next();
    if (name === "" && pos < s.length) return { escaped: next() }; // \{ \} \% 等
    return { name };
  };

  /** { expr } 整组，或单个 atom（LaTeX 的单字符实参惯例） */
  const readGroup = (ctx) => {
    while (peek() === " ") next();
    if (peek() === "{") {
      next();
      const body = parseExpr("}");
      if (peek() === "}") next();
      else warnings.push(`${ctx}缺右花括号，已按到结尾处理`);
      return body;
    }
    const atom = parseAtom();
    if (atom === null) {
      warnings.push(`${ctx}缺内容`);
      return [{ t: "run", text: "?" }];
    }
    return [atom];
  };

  /** 单个原子。到达终止符/结尾返回 null */
  const parseAtom = () => {
    while (peek() === " ") next();
    const c = peek();
    if (c === undefined || c === "}" || c === ")") return null;
    if (c === "^" || c === "_") return null; // 由 parseExpr 做后缀绑定
    if (c === "{") {
      next();
      const body = parseExpr("}");
      if (peek() === "}") next();
      else warnings.push("花括号未闭合，已按到结尾处理");
      return { t: "group", body };
    }
    if (c === "(") {
      // 圆括号配对成隐式组：(x_i-μ)^2 的 ^2 绑整个括号，\sum 也能整体吸收
      next();
      const body = parseExpr(")");
      if (peek() === ")") next();
      else warnings.push("圆括号未闭合，已按到结尾处理");
      return { t: "group", body: [{ t: "run", text: "(" }, ...body, { t: "run", text: ")" }] };
    }
    if (c === "\\") {
      next();
      const cmd = readCommand();
      if (cmd.escaped !== undefined) {
        if (cmd.escaped in SPACING_ESCAPES) {
          const sp = SPACING_ESCAPES[cmd.escaped];
          return sp ? { t: "run", text: sp } : parseAtom(); // \! 丢弃后取下一个原子
        }
        return { t: "run", text: cmd.escaped };
      }
      const { name } = cmd;
      if (name === "frac") {
        const num = readGroup("\\frac 分子");
        const den = readGroup("\\frac 分母");
        return { t: "frac", num, den };
      }
      if (name === "sqrt") {
        let degree;
        while (peek() === " ") next();
        if (peek() === "[") {
          next();
          degree = parseExpr("]");
          if (peek() === "]") next();
          else warnings.push("\\sqrt 的 [次数] 未闭合");
        }
        const body = readGroup("\\sqrt");
        return { t: "sqrt", body, ...(degree ? { degree } : {}) };
      }
      if (name === "sum") return { t: "sum", body: [] };
      if (NARY[name]) return { t: "nary", name, ...NARY[name], body: [] };
      if (ACCENTS[name]) return { t: "acc", chr: ACCENTS[name], body: readGroup(`\\${name}`) };
      if (name === "overline") return { t: "bar", pos: "top", body: readGroup("\\overline") };
      if (name === "underline") return { t: "bar", pos: "bot", body: readGroup("\\underline") };
      if (name === "begin") return parseEnv();
      if (SYMBOLS[name]) return { t: "run", text: SYMBOLS[name] };
      if (FUNCTIONS.has(name)) return { t: "run", text: name };
      warnings.push(`未识别的命令 \\${name}，按原文输出（支持：frac/sqrt/sum/int/prod/矩阵环境/装饰符/函数名/希腊字母/常用运算符）`);
      return { t: "run", text: `\\${name}` };
    }
    return { t: "run", text: next() };
  };

  /** 读 { 环境名 }（\begin/\end 后面的实参） */
  const readEnvName = () => {
    while (peek() === " ") next();
    let env = "";
    if (peek() === "{") {
      next();
      while (pos < s.length && peek() !== "}") env += next();
      if (peek() === "}") next();
    }
    return env;
  };

  /** \begin{矩阵环境}：& 分列、\\ 分行，直到 \end。\begin 命令本身已消费 */
  const parseEnv = () => {
    const env = readEnvName();
    if (!(env in MATRIX_ENVS)) {
      warnings.push(`未识别的环境 \\begin{${env}}，按原文输出（支持：matrix/pmatrix/bmatrix/vmatrix）`);
      return { t: "run", text: `\\begin{${env}}` };
    }
    const rows = [];
    let row = [];
    let cell = [];
    const endCell = () => { row.push(cell); cell = []; };
    const endRow = () => { endCell(); rows.push(row); row = []; };
    let closed = false;
    while (pos < s.length) {
      while (peek() === " " || peek() === "\n" || peek() === "\t") next();
      if (pos >= s.length) break;
      if (s.startsWith("\\\\", pos)) { pos += 2; endRow(); continue; }
      if (peek() === "&") { next(); endCell(); continue; }
      if (s.startsWith("\\end", pos) && !/[a-zA-Z]/.test(s[pos + 4] || "")) {
        pos += 4;
        const endEnv = readEnvName();
        if (endEnv !== env) warnings.push(`\\end{${endEnv}} 与 \\begin{${env}} 不匹配`);
        closed = true;
        break;
      }
      const item = parseScripted();
      if (item === null) { cell.push({ t: "run", text: next() }); continue; } // 落单 } ) 当普通字符
      cell.push(item);
    }
    if (!closed) warnings.push(`\\begin{${env}} 未闭合（缺 \\end{${env}}）`);
    if (cell.length || row.length) endRow();
    if (!rows.length) {
      warnings.push(`\\begin{${env}} 是空矩阵`);
      rows.push([[{ t: "run", text: "?" }]]);
    }
    // 列数不齐：短行补空单元格（OMML 矩阵每行 m:e 数量必须一致，否则 Word 渲染错位）
    const cols = Math.max(...rows.map((r) => r.length));
    if (rows.some((r) => r.length !== cols)) {
      warnings.push(`\\begin{${env}} 各行列数不一致，短行已补空位（Word 里显示为占位框）`);
      for (const r of rows) while (r.length < cols) r.push([]);
    }
    return { t: "matrix", delim: MATRIX_ENVS[env], rows };
  };

  /** 一个原子 + 它的 ^/_ 绑定（x_i^2 是一个整体） */
  const parseScripted = () => {
    let atom = parseAtom();
    if (atom === null) {
      // 落单的 ^/_：造个空 base 兜住
      if (peek() === "^" || peek() === "_") {
        warnings.push(`${peek()} 前面没有可附着的内容`);
        atom = { t: "run", text: "" };
      } else return null;
    }
    while (peek() === "^" || peek() === "_") {
      const kind = next();
      const script = readGroup(kind === "^" ? "上标" : "下标");
      atom = attachScript(atom, kind, script, warnings);
    }
    return atom;
  };

  /** 表达式：scripted 项序列，直到 stop 字符或结尾 */
  const parseExpr = (stop) => {
    const out = [];
    while (pos < s.length && peek() !== stop) {
      const item = parseScripted();
      if (item === null) {
        if (peek() === "}" && stop !== "}") { // 多余的右花括号：吞掉并提醒
          next();
          warnings.push("多余的右花括号，已忽略");
          continue;
        }
        if (peek() === ")" && stop !== ")") { // 落单右圆括号：当普通字符
          next();
          out.push({ t: "run", text: ")" });
          continue;
        }
        break;
      }
      // \sum/\int/\prod 的算子体：吸收紧随其后的一个 scripted 项（OMML n-ary
      // 的 m:e 空着会渲染成占位方框，探针验证过）。多项内容用 {} 或 () 括起
      if ((item.t === "sum" || item.t === "nary") && item.body.length === 0) {
        const body = parseScripted();
        if (body !== null) item.body = [body];
        else warnings.push(`\\${item.name || "sum"} 后面没有内容，Word 里会显示占位框`);
      }
      out.push(item);
    }
    return out;
  };

  const ast = parseExpr();
  return { ast, warnings };
};

/** 把 ^/_ 绑到 base 上；\sum/\int/\prod 的上下限进节点本体（OMML n-ary 语义） */
const attachScript = (base, kind, script, warnings) => {
  if (base.t === "sum" || base.t === "nary") {
    const key = kind === "^" ? "sup" : "sub";
    if (base[key]) warnings.push(`\\${base.name || "sum"} 的${kind === "^" ? "上" : "下"}限重复，后者生效`);
    return { ...base, [key]: script };
  }
  if (kind === "^" && base.t === "sub") {
    return { t: "subsup", base: base.base, sub: base.script, sup: script };
  }
  if (kind === "_" && base.t === "sup") {
    return { t: "subsup", base: base.base, sub: script, sup: base.script };
  }
  return { t: kind === "^" ? "sup" : "sub", base: [base], script };
};

module.exports = { parseLatex, SYMBOLS, ACCENTS, NARY, MATRIX_ENVS };
