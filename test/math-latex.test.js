// math-latex.test.js — LaTeX 子集解析器：AST 形状逐条 + 容错行为 + OMML 落包断言
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const JSZip = require("jszip");
const { parseLatex } = require("../src/math-latex");
const { createService } = require("../src/service");

test("纯文本与符号命令", () => {
  const { ast, warnings } = parseLatex("2\\pi r \\le d");
  assert.deepStrictEqual(warnings, []);
  assert.deepStrictEqual(ast.map((n) => n.text), ["2", "π", "r", "≤", "d"]);
});

test("分式：\\frac{a}{b}，花括号与单字符实参", () => {
  const { ast, warnings } = parseLatex("\\frac{n+1}{2} + \\frac12");
  assert.deepStrictEqual(warnings, []);
  assert.strictEqual(ast[0].t, "frac");
  assert.deepStrictEqual(ast[0].num.map((n) => n.text), ["n", "+", "1"]);
  assert.strictEqual(ast[2].t, "frac");
  assert.strictEqual(ast[2].num[0].text, "1");
  assert.strictEqual(ast[2].den[0].text, "2");
});

test("上下标：x^2 / x_i / x_i^2 合成 subsup", () => {
  const { ast } = parseLatex("x^2 y_i z_i^2");
  assert.strictEqual(ast[0].t, "sup");
  assert.strictEqual(ast[1].t, "sub");
  assert.strictEqual(ast[2].t, "subsup");
  assert.strictEqual(ast[2].sub[0].text, "i");
  assert.strictEqual(ast[2].sup[0].text, "2");
});

test("根式：\\sqrt{x} 与 \\sqrt[3]{x}", () => {
  const { ast } = parseLatex("\\sqrt{b^2-4ac} \\sqrt[3]{8}");
  assert.strictEqual(ast[0].t, "sqrt");
  assert.strictEqual(ast[0].degree, undefined);
  assert.strictEqual(ast[1].t, "sqrt");
  assert.strictEqual(ast[1].degree[0].text, "3");
});

test("求和：上下限进 sum 节点，吸收紧随的求和体", () => {
  const { ast, warnings } = parseLatex("\\sum_{i=1}^{n} x_i = S");
  assert.deepStrictEqual(warnings, []);
  assert.strictEqual(ast[0].t, "sum");
  assert.deepStrictEqual(ast[0].sub.map((n) => n.text), ["i", "=", "1"]);
  assert.strictEqual(ast[0].sup[0].text, "n");
  assert.strictEqual(ast[0].body[0].t, "sub", "x_i 整体进求和体");
  assert.strictEqual(ast[1].text, "=", "= 不被吸进求和体");
});

test("圆括号配对成隐式组：^ 绑整个括号，\\sum 整体吸收", () => {
  const { ast, warnings } = parseLatex("\\sum_{i=1}^{n} (x_i - \\mu)^2");
  assert.deepStrictEqual(warnings, []);
  const sum = ast[0];
  assert.strictEqual(sum.t, "sum");
  assert.strictEqual(sum.body.length, 1, "带括号的求和体整体吸收");
  assert.strictEqual(sum.body[0].t, "sup", "^2 绑整个括号组");
  assert.strictEqual(sum.body[0].base[0].t, "group");
  const texts = sum.body[0].base[0].body.map((n) => n.t === "run" ? n.text : n.t);
  assert.deepStrictEqual(texts.slice(0, 2), ["(", "sub"]);
  // 落单右括号当普通字符
  const r = parseLatex("f(x))");
  assert.strictEqual(r.ast[r.ast.length - 1].text, ")");
});

test("容错：未识别命令原样输出 + warn；未闭合括号 warn 不炸", () => {
  const r1 = parseLatex("\\foo{x}");
  assert.ok(r1.warnings.some((w) => w.includes("\\foo")));
  assert.strictEqual(r1.ast[0].text, "\\foo");
  const r2 = parseLatex("\\frac{a}{b");
  assert.ok(r2.warnings.some((w) => w.includes("右花括号")));
  assert.strictEqual(r2.ast[0].t, "frac");
  const r3 = parseLatex("^2");
  assert.ok(r3.warnings.some((w) => w.includes("附着")));
  const r4 = parseLatex("a}b");
  assert.ok(r4.warnings.some((w) => w.includes("多余的右花括号")));
  assert.deepStrictEqual(r4.ast.map((n) => n.text), ["a", "b"]);
});

test("转义与空 sum 体", () => {
  const { ast } = parseLatex("\\{a\\}");
  assert.deepStrictEqual(ast.map((n) => n.text), ["{", "a", "}"]);
  const r = parseLatex("\\sum");
  assert.ok(r.warnings.some((w) => w.includes("占位框")));
});

// ---------------------------------------------------------------- 扩展子集（2026-07-10）

test("装饰符：\\bar/\\hat/\\vec 转 acc 节点，\\overline/\\underline 转 bar 节点", () => {
  const { ast, warnings } = parseLatex("\\bar{x} \\hat\\theta \\vec{v} \\overline{AB} \\underline{y}");
  assert.deepStrictEqual(warnings, []);
  assert.strictEqual(ast[0].t, "acc");
  assert.strictEqual(ast[0].chr, "̅");
  assert.strictEqual(ast[0].body[0].text, "x");
  assert.strictEqual(ast[1].t, "acc", "\\hat 单命令实参");
  assert.strictEqual(ast[1].body[0].text, "θ");
  assert.strictEqual(ast[2].chr, "⃗");
  assert.deepStrictEqual(ast[3], { t: "bar", pos: "top", body: [{ t: "run", text: "A" }, { t: "run", text: "B" }] });
  assert.strictEqual(ast[4].pos, "bot");
});

test("积分：上下限 + 吸收被积项；\\prod 上下限居中、\\oint 只有下限", () => {
  const { ast, warnings } = parseLatex("\\int_{0}^{1} x^2 dx");
  assert.deepStrictEqual(warnings, []);
  assert.strictEqual(ast[0].t, "nary");
  assert.strictEqual(ast[0].chr, "∫");
  assert.strictEqual(ast[0].limLoc, "subSup");
  assert.strictEqual(ast[0].sub[0].text, "0");
  assert.strictEqual(ast[0].sup[0].text, "1");
  assert.strictEqual(ast[0].body[0].t, "sup", "x^2 整体进被积项");
  assert.strictEqual(ast[1].text, "d", "dx 不被吸收");

  const prod = parseLatex("\\prod_{i=1}^{n} p_i").ast[0];
  assert.strictEqual(prod.limLoc, "undOvr");
  const oint = parseLatex("\\oint_C f").ast[0];
  assert.strictEqual(oint.chr, "∮");
  assert.strictEqual(oint.sup, undefined);
  // 空算子体 warn（同 \sum）
  assert.ok(parseLatex("\\int").warnings.some((w) => w.includes("\\int")));
});

test("矩阵：pmatrix 定界符 + & 分列 \\\\ 分行；嵌套公式进单元格", () => {
  const { ast, warnings } = parseLatex("\\begin{pmatrix} a & b \\\\ \\frac{1}{2} & d \\end{pmatrix}");
  assert.deepStrictEqual(warnings, []);
  const m = ast[0];
  assert.strictEqual(m.t, "matrix");
  assert.deepStrictEqual(m.delim, ["(", ")"]);
  assert.strictEqual(m.rows.length, 2);
  assert.strictEqual(m.rows[0].length, 2);
  assert.strictEqual(m.rows[0][0][0].text, "a");
  assert.strictEqual(m.rows[1][0][0].t, "frac", "单元格里可以放分式");
  assert.strictEqual(parseLatex("\\begin{vmatrix} 1 \\end{vmatrix}").ast[0].delim[0], "|");
  assert.strictEqual(parseLatex("\\begin{matrix} 1 \\end{matrix}").ast[0].delim, null);
});

test("矩阵容错：列数不齐补空位、未闭合、未识别环境", () => {
  const r1 = parseLatex("\\begin{bmatrix} x \\\\ y & z \\end{bmatrix}");
  assert.ok(r1.warnings.some((w) => w.includes("列数不一致")));
  assert.strictEqual(r1.ast[0].rows[0].length, 2, "短行补到最宽列数");
  assert.deepStrictEqual(r1.ast[0].rows[0][1], [], "补的是空单元格");
  const r2 = parseLatex("\\begin{pmatrix} a & b");
  assert.ok(r2.warnings.some((w) => w.includes("未闭合")));
  assert.strictEqual(r2.ast[0].t, "matrix", "未闭合仍出矩阵");
  const r3 = parseLatex("\\begin{foo} x \\end{foo}");
  assert.ok(r3.warnings.some((w) => w.includes("\\begin{foo}")));
  assert.strictEqual(r3.ast[0].text, "\\begin{foo}");
});

test("\\left\\right 剥掉、间距命令转空格、函数名直译", () => {
  const r1 = parseLatex("\\left( \\frac{a}{b} \\right)^2");
  assert.deepStrictEqual(r1.warnings, []);
  assert.strictEqual(r1.ast[0].t, "sup", "^2 绑整个括号组（\\left\\right 剥掉后照常配对）");
  assert.strictEqual(r1.ast[0].base[0].t, "group");
  const r2 = parseLatex("f(x)\\,dx \\; y");
  assert.deepStrictEqual(r2.warnings, []);
  assert.ok(r2.ast.some((n) => n.t === "run" && /\s/.test(n.text)), "\\, 转成空格 run");
  const r3 = parseLatex("\\sin x + \\det A");
  assert.deepStrictEqual(r3.warnings, []);
  assert.strictEqual(r3.ast[0].text, "sin");
  assert.ok(r3.ast.some((n) => n.text === "det"));
});

test("OMML 落包：acc/bar/nary(hide 标志)/矩阵结构进 document.xml", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "docx-mcp-omml-"));
  const service = createService({
    dbPath: path.join(dir, "t.db"),
    outputDir: path.join(dir, "output"),
    profilePath: path.join(dir, "style-profile.json"),
  });
  try {
    const { docId, issues } = service.createDocument({ title: "omml", def: { contexts: [
      { type: "math", latex: "\\bar{x} = \\overline{AB}" },
      { type: "math", latex: "\\int_{0}^{1} f dx + \\oint_C g + \\int h" },
      { type: "math", latex: "\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}" },
    ] } });
    assert.deepStrictEqual(issues, []);
    const res = await service.renderDocument({ docId });
    assert.strictEqual(res.ok, true);
    const zip = await JSZip.loadAsync(fs.readFileSync(res.path));
    const doc = await zip.file("word/document.xml").async("string");

    assert.ok(doc.includes('<m:acc><m:accPr><m:chr m:val="̅"/></m:accPr><m:e><m:r><m:t>x</m:t></m:r></m:e></m:acc>'), "\\bar → m:acc");
    assert.ok(doc.includes('<m:bar><m:barPr><m:pos m:val="top"/></m:barPr>'), "\\overline → m:bar");

    const narys = [...doc.matchAll(/<m:naryPr>.*?<\/m:naryPr>/g)].map((m) => m[0]);
    assert.strictEqual(narys.length, 3);
    assert.ok(narys[0].includes('m:chr m:val="∫"') && narys[0].includes('m:limLoc m:val="subSup"'), "定积分：上下限在右侧");
    assert.ok(!narys[0].includes("subHide") && !narys[0].includes("supHide"), "上下限都有，不出 hide");
    assert.ok(narys[1].includes('<m:supHide m:val="1"/>') && !narys[1].includes("subHide"), "\\oint_C 只藏上限");
    assert.ok(narys[2].includes('<m:subHide m:val="1"/>') && narys[2].includes('<m:supHide m:val="1"/>'), "无上下限全藏");

    assert.ok(doc.includes('<m:begChr m:val="("/>') && doc.includes('<m:endChr m:val=")"/>'), "pmatrix 定界符");
    const rows = (doc.match(/<m:mr>/g) || []).length;
    assert.strictEqual(rows, 2, "两行矩阵");
    assert.ok(/<m:m><m:mr><m:e><m:r><m:t>a<\/m:t><\/m:r><\/m:e><m:e><m:r><m:t>b<\/m:t><\/m:r><\/m:e><\/m:mr>/.test(doc), "矩阵行内单元格顺序");
  } finally {
    service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
