#!/usr/bin/env node
// 视觉回归（todo P2 质量保障）：渲染标准样本 → LibreOffice 转 PDF →
// pdftotext 抽每页文本行，与 test/visual-baseline/ 里的 JSON 基线比对
// 「页数 + 每页文本行序」。抓的是分页漂移和内容丢失——XML 断言看不见
// 排版结果，PNG 像素比对又跟字体/LO 版本过敏，页级文本行是两者间的稳定层。
//
// 用法:
//   npm run visual             与基线比对，差异非零退出
//   npm run visual -- --update 重建基线（渲染改动是有意的、人眼确认过再更）
//
// 基线跟 LO 版本/字体环境绑定：换机器先 --update 重建基线再开始改代码。
// 依赖: libreoffice-writer + poppler-utils(pdftotext)
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const BASELINE_DIR = path.join(ROOT, "test", "visual-baseline");
const EXAMPLES = path.join(ROOT, "examples");

const SAMPLES = [
  { name: "demo-report", kind: "def", file: path.join(EXAMPLES, "demo-report.js") },
  { name: "section-sample", kind: "def", file: path.join(EXAMPLES, "section-sample.js") },
  { name: "markdown-sample", kind: "markdown", file: path.join(EXAMPLES, "markdown-sample.md") },
];

// ---------------------------------------------------------------- 渲染

async function renderDefSample(sample, outDir) {
  const { saveReport } = require(path.join(ROOT, "src", "docxUtil.js"));
  let def = require(sample.file);
  if (typeof def === "function") def = def();
  const out = path.join(outDir, `${sample.name}.docx`);
  await saveReport(def, out, { baseDir: path.dirname(sample.file) });
  return out;
}

async function renderMarkdownSample(sample, outDir) {
  const { createService } = require(path.join(ROOT, "src", "service.js"));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "docx-mcp-vr-"));
  const service = createService({
    dbPath: path.join(dir, "t.db"),
    outputDir: path.join(dir, "output"),
    profilePath: path.join(dir, "style-profile.json"),
  });
  try {
    const markdown = fs.readFileSync(sample.file, "utf8");
    const { docId, issues } = service.createDocumentFromMarkdown({
      title: sample.name, markdown, baseDir: path.dirname(sample.file),
    });
    const errors = issues.filter((i) => i.level === "error");
    if (errors.length) throw new Error(`${sample.name} 建档出 error: ${JSON.stringify(errors)}`);
    const res = await service.renderDocument({ docId });
    if (!res.ok) throw new Error(`${sample.name} 渲染失败: ${JSON.stringify(res.issues)}`);
    const out = path.join(outDir, `${sample.name}.docx`);
    fs.copyFileSync(res.path, out);
    return out;
  } finally {
    service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- 快照

function docxToSnapshot(docxPath, workDir) {
  // soffice 并发抢 profile 锁，给独立 UserInstallation（同 docx2png.sh）
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "docx-mcp-lo-"));
  try {
    execFileSync("soffice", [
      "--headless", `-env:UserInstallation=file://${profile}`,
      "--convert-to", "pdf", "--outdir", workDir, docxPath,
    ], { stdio: "pipe" });
  } finally {
    fs.rmSync(profile, { recursive: true, force: true });
  }
  const pdf = path.join(workDir, path.basename(docxPath, ".docx") + ".pdf");
  if (!fs.existsSync(pdf)) throw new Error(`LO 转换失败，没有生成 ${pdf}`);
  const text = execFileSync("pdftotext", ["-layout", pdf, "-"], { encoding: "utf8" });
  // \f 分页；末尾的 \f 会多出一个空 chunk，去掉
  const chunks = text.split("\f");
  if (chunks.length && !chunks[chunks.length - 1].trim()) chunks.pop();
  const pageLines = chunks.map((c) =>
    c.split("\n").map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean)
  );
  return { pages: pageLines.length, pageLines };
}

// ---------------------------------------------------------------- 比对

function diffSnapshots(name, base, cur) {
  const problems = [];
  if (base.pages !== cur.pages) {
    problems.push(`页数变化: 基线 ${base.pages} 页 → 当前 ${cur.pages} 页`);
  }
  const pages = Math.max(base.pages, cur.pages);
  for (let p = 0; p < pages; p++) {
    const b = base.pageLines[p] || [];
    const c = cur.pageLines[p] || [];
    if (JSON.stringify(b) === JSON.stringify(c)) continue;
    const lines = [];
    const n = Math.max(b.length, c.length);
    for (let i = 0; i < n && lines.length < 12; i++) {
      if (b[i] !== c[i]) {
        if (b[i] !== undefined) lines.push(`    - ${b[i]}`);
        if (c[i] !== undefined) lines.push(`    + ${c[i]}`);
      }
    }
    problems.push(`第 ${p + 1} 页文本变化:\n${lines.join("\n")}`);
  }
  return problems;
}

// ---------------------------------------------------------------- 主流程

(async () => {
  const update = process.argv.includes("--update");
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "docx-mcp-visual-"));
  let failed = false;
  try {
    for (const sample of SAMPLES) {
      const docx = sample.kind === "markdown"
        ? await renderMarkdownSample(sample, workDir)
        : await renderDefSample(sample, workDir);
      const snapshot = docxToSnapshot(docx, workDir);
      const baselinePath = path.join(BASELINE_DIR, `${sample.name}.json`);

      if (update) {
        fs.mkdirSync(BASELINE_DIR, { recursive: true });
        fs.writeFileSync(baselinePath, JSON.stringify(snapshot, null, 2) + "\n");
        console.log(`✓ 基线已更新: ${sample.name}（${snapshot.pages} 页）`);
        continue;
      }
      if (!fs.existsSync(baselinePath)) {
        console.error(`✗ ${sample.name}: 缺基线 ${path.relative(ROOT, baselinePath)}，先跑 npm run visual -- --update`);
        failed = true;
        continue;
      }
      const base = JSON.parse(fs.readFileSync(baselinePath, "utf8"));
      const problems = diffSnapshots(sample.name, base, snapshot);
      if (problems.length) {
        console.error(`✗ ${sample.name}:\n  ${problems.join("\n  ")}`);
        failed = true;
      } else {
        console.log(`✓ ${sample.name}（${snapshot.pages} 页，与基线一致）`);
      }
    }
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
  if (failed) {
    console.error("\n视觉回归有差异。改动是有意的且人眼验证过 → npm run visual -- --update 重建基线");
    process.exit(1);
  }
})().catch((e) => { console.error(e); process.exit(1); });
