// presets.test.js — 三层合并（preset ← profile ← doc meta）覆盖
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { listPresets, loadPreset, resolveDocConfig, DEFAULT_PRESET } = require("../src/presets");

test("内置 preset 齐全且可加载", () => {
  const names = listPresets().map((p) => p.name).sort();
  assert.deepStrictEqual(names, ["monthly-report", "plain"]);
  const mr = loadPreset("monthly-report");
  assert.strictEqual(mr.autoNumber, true);
  assert.strictEqual(mr.meta.font, "宋体");
});

test("不存在的 preset → 报错并列出可用项", () => {
  assert.throws(() => loadPreset("nope"), /不存在.*monthly-report/);
});

test("默认 preset 是 monthly-report", () => {
  const cfg = resolveDocConfig({});
  assert.strictEqual(cfg.preset, DEFAULT_PRESET);
  assert.strictEqual(cfg.autoNumber, true);
  assert.strictEqual(cfg.meta.margins.right, "3.17cm");
  assert.deepStrictEqual(cfg.captionStyle.textOptions, { font: "宋体", size: 20 });
});

test("doc meta 覆盖 preset；margins 深并不丢边", () => {
  const cfg = resolveDocConfig({
    presetName: "monthly-report",
    docMeta: { font: "仿宋", margins: { top: "3cm" }, autoNumber: false },
  });
  assert.strictEqual(cfg.meta.font, "仿宋");
  assert.strictEqual(cfg.meta.margins.top, "3cm");
  assert.strictEqual(cfg.meta.margins.left, "3.17cm"); // 其余边距保留
  assert.strictEqual(cfg.autoNumber, false);
  assert.strictEqual(cfg.meta.autoNumber, undefined); // v2 字段不进渲染层 meta
});

test("style profile 夹在中间：盖过 preset、被 doc meta 盖过；缺省文件不崩", () => {
  const profilePath = path.join(os.tmpdir(), `docx-mcp-profile-${process.pid}.json`);
  fs.writeFileSync(profilePath, JSON.stringify({
    preset: "plain",
    overrides: { meta: { font: "仿宋", headerSize: 21 } },
  }));
  try {
    // profile 指定基础 preset
    const cfg = resolveDocConfig({ profilePath, docMeta: { font: "楷体" } });
    assert.strictEqual(cfg.preset, "plain");
    assert.strictEqual(cfg.meta.font, "楷体");      // doc meta 赢
    assert.strictEqual(cfg.meta.headerSize, 21);    // profile 赢过 preset
    // 显式 presetName 赢过 profile.preset
    const cfg2 = resolveDocConfig({ profilePath, presetName: "monthly-report" });
    assert.strictEqual(cfg2.preset, "monthly-report");
  } finally {
    fs.unlinkSync(profilePath);
  }
  // 文件不存在 → 当没有 profile
  const cfg3 = resolveDocConfig({ profilePath: "/no/such/profile.json" });
  assert.strictEqual(cfg3.preset, DEFAULT_PRESET);
});

test("plain preset：无页码无封面页，autoNumber 默认开", () => {
  const cfg = resolveDocConfig({ presetName: "plain" });
  assert.strictEqual(cfg.meta.pageNumber, false);
  assert.strictEqual(cfg.meta.titlePage, false);
  assert.strictEqual(cfg.autoNumber, true);
});

test("meta.target：三层合并有默认值，非法值直接爆", () => {
  assert.strictEqual(resolveDocConfig({ presetName: "plain", docMeta: {} }).target, "universal");
  const cfg = resolveDocConfig({ presetName: "plain", docMeta: { target: "word" } });
  assert.strictEqual(cfg.target, "word");
  assert.strictEqual(cfg.meta.target, undefined, "target 不进渲染层 meta");
  assert.throws(() => resolveDocConfig({ presetName: "plain", docMeta: { target: "wps" } }), /无效/);
});

// ---- 数组按条目就近覆盖（2026-07-13 定，CSS 层叠语义）

test("doc meta 只重定义 md-bullet：preset 的 md-ordered 与其余编号保留", () => {
  const cfg = resolveDocConfig({ presetName: "monthly-report", docMeta: {
    numbering: { config: [
      { reference: "md-bullet", levels: [{ level: 0, format: "bullet", text: "–", alignment: "left" }] },
    ] },
  } });
  const refs = cfg.meta.numbering.config.map((c) => c.reference);
  assert.ok(refs.includes("md-ordered"), "md-ordered 不能丢");
  const bullet = cfg.meta.numbering.config.find((c) => c.reference === "md-bullet");
  assert.strictEqual(bullet.levels[0].text, "–"); // 同 reference 整条替换
  assert.strictEqual(bullet.levels.length, 1);
  assert.strictEqual(refs.filter((r) => r === "md-bullet").length, 1); // 不重复追加
});

test("doc meta 覆盖单个段落样式：同 id 字段级深并，其余样式保留", () => {
  const cfg = resolveDocConfig({ presetName: "monthly-report", docMeta: {
    styles: { paragraphStyles: [
      { id: "mdList", paragraph: { alignment: "both" } },
      { id: "myStyle", run: { size: 28 } },
    ] },
  } });
  const byId = new Map(cfg.meta.styles.paragraphStyles.map((s) => [s.id, s]));
  assert.ok(byId.has("mdCode"), "preset 其余段落样式不能丢");
  const mdList = byId.get("mdList");
  assert.strictEqual(mdList.paragraph.alignment, "both");   // 覆盖生效
  assert.strictEqual(mdList.run.font, "宋体");              // 未覆盖字段保留
  assert.ok(mdList.paragraph.spacing, "paragraph 深并一层，spacing 保留");
  assert.ok(byId.has("myStyle"), "新样式追加");
});

test("三层都动同一条样式：profile 盖 preset、doc meta 盖 profile（字段级）", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "preset-merge-"));
  const profilePath = path.join(dir, "profile.json");
  fs.writeFileSync(profilePath, JSON.stringify({ overrides: { meta: {
    styles: { paragraphStyles: [{ id: "mdList", run: { size: 21 }, paragraph: { alignment: "center" } }] },
  } } }));
  try {
    const cfg = resolveDocConfig({ presetName: "monthly-report", profilePath, docMeta: {
      styles: { paragraphStyles: [{ id: "mdList", paragraph: { alignment: "left" } }] },
    } });
    const mdList = cfg.meta.styles.paragraphStyles.find((s) => s.id === "mdList");
    assert.strictEqual(mdList.paragraph.alignment, "left"); // doc meta 最近
    assert.strictEqual(mdList.run.size, 21);                // profile 的字段透下来
    assert.strictEqual(mdList.run.font, "宋体");            // preset 的字段透下来
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
