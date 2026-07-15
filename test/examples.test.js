// examples.test.js — get_examples 的示例与真实规则永不漂移：
// 每个 def 示例过校验器（0 issue）+ 渲染层能构建 Document；markdown 示例真转换。
const { test } = require("node:test");
const assert = require("node:assert");
const { EXAMPLES } = require("../src/examples");
const { normalizeNodes } = require("../src/normalize");
const { validate, RULE_TOPIC, TYPE_TOPIC } = require("../src/validator");
const { transform } = require("../src/transform");
const { report } = require("../src/docxUtil");
const { markdownToDef } = require("../src/markdown");
const { createService } = require("../src/service");
const fs = require("fs");
const path = require("path");
const os = require("os");

const defTopics = Object.entries(EXAMPLES).filter(([, e]) => e.example && Array.isArray(e.example.contexts));

test("每个主题结构完整：brief/usage/example/notes", () => {
  for (const [name, e] of Object.entries(EXAMPLES)) {
    assert.ok(e.brief && e.usage && e.example && Array.isArray(e.notes) && e.notes.length > 0,
      `主题 ${name} 缺字段`);
  }
});

// 示例是「LLM 会发什么」，服务入口先归一再校验/渲染——这里走同一条管线
const normalized = ([name, e]) => [name, { ...e.example, contexts: normalizeNodes(e.example.contexts) }];

test("def 示例全部通过校验器（0 issue，warn 也不许有）", () => {
  for (const [name, example] of defTopics.map(normalized)) {
    const issues = validate(example, { autoNumber: true });
    assert.deepStrictEqual(issues, [], `主题 ${name} 的示例有 issue: ${JSON.stringify(issues)}`);
  }
});

test("def 示例全部能过 transform + 渲染层构建 Document", () => {
  for (const [name, example] of defTopics.map(normalized)) {
    const { def } = transform(example, { autoNumber: true, target: "universal" });
    assert.doesNotThrow(() => report(def), `主题 ${name} 渲染层构建失败`);
  }
});

test("校验报错里指向的 get_examples 主题必须真实存在", () => {
  for (const [rule, topic] of [...Object.entries(RULE_TOPIC), ...Object.entries(TYPE_TOPIC)]) {
    assert.ok(EXAMPLES[topic], `${rule} 指向不存在的主题 ${topic}`);
  }
  // 抽查：报错 message 里真的带主题提示
  const issues = validate({ contexts: [{ type: "table", columnWidths: [1000], data: [{ texts: [] }] }] });
  assert.match(issues[0].message, /get_examples topic "table"/);
});

test("markdown 示例真转换无 error，且服务层能建档", () => {
  const md = EXAMPLES.markdown.example;
  const { issues } = markdownToDef(md.markdown, { autoNumber: true });
  assert.ok(!issues.some((i) => i.level === "error"), JSON.stringify(issues));

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "docx-mcp-ex-"));
  const service = createService({
    dbPath: path.join(dir, "t.db"),
    outputDir: path.join(dir, "output"),
    profilePath: path.join(dir, "p.json"),
  });
  try {
    const { docId } = service.createDocumentFromMarkdown({ ...md, baseDir: dir });
    assert.ok(docId);
  } finally {
    service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("get_examples 服务方法：清单 + 按主题取 + 未知主题报错", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "docx-mcp-ex2-"));
  const service = createService({
    dbPath: path.join(dir, "t.db"),
    outputDir: path.join(dir, "output"),
    profilePath: path.join(dir, "p.json"),
  });
  try {
    const { topics } = service.getExamples({});
    assert.ok(topics.length >= 10);
    assert.ok(topics.every((t) => t.name && t.brief));
    const spanEx = service.getExamples({ topic: "table-span" });
    assert.strictEqual(spanEx.topic, "table-span");
    assert.ok(spanEx.example.contexts[0].tableOptions.span);
    assert.throws(() => service.getExamples({ topic: "nope" }), /未知主题.*table-span/s);
  } finally {
    service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
