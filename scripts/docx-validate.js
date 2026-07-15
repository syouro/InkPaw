#!/usr/bin/env node
/**
 * docx 校验器：回答「这个文件 Word 能不能打开」。
 *
 * 三层检查，层层递进：
 *   1. OPC 包完整性 —— zip 可解、[Content_Types].xml 覆盖全部 part、
 *      .rels 目标存在、正文里的 r:id/r:embed 都有对应关系
 *   2. OOXML schema —— MCE 预处理（strip-mce.xslt）后用 ECMA-376
 *      Transitional XSD 逐 part 校验（xmllint）
 *   3. Word 兼容陷阱 —— 标准合法但 Word 拒开的写法（[MS-OI29500]），
 *      schema 抓不到，LibreOffice/图片渲染也发现不了，正是最容易漏的一类
 *
 * 用法：node scripts/docx-validate.js <file.docx> [more.docx ...]
 * 退出码：0 全部通过（warn 不算失败），1 有 error，2 用法/环境错误
 * 依赖：xmllint、xsltproc（libxml2 / libxslt）
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const JSZip = require("jszip");
const { RPR_CHILD_ORDER } = require("../src/docxUtil");

const SCHEMA_DIR = path.join(__dirname, "..", "schemas", "ooxml");
const WML_XSD = path.join(SCHEMA_DIR, "wml.xsd");
const STRIP_XSLT = path.join(SCHEMA_DIR, "strip-mce.xslt");
const WML_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

// ---------------------------------------------------------------- 工具

const hasCmd = (cmd) => {
  try {
    execFileSync("which", [cmd], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

/** 正则批量提取属性值（够用：OOXML part 都是机器生成的规整 XML，无注释/CDATA 干扰） */
const attrValues = (xml, attr) =>
  [...xml.matchAll(new RegExp(`${attr}="([^"]*)"`, "g"))].map((m) => m[1]);

/** rels 的相对 Target → 包内路径（相对于宿主 part 所在目录解析） */
const resolveTarget = (relsPath, target) => {
  const baseDir = path.posix.dirname(path.posix.dirname(relsPath)); // word/_rels/x.rels → word
  return path.posix.normalize(path.posix.join(baseDir, target));
};

// ---------------------------------------------------------------- 检查项

/** 层 1：[Content_Types].xml 必须覆盖每个 part（Default 按扩展名或 Override 按路径） */
const checkContentTypes = (parts, files, issues) => {
  const ct = files["[Content_Types].xml"];
  if (!ct) {
    issues.error("[Content_Types].xml 缺失，Word 直接拒开");
    return;
  }
  const defaults = new Set(attrValues(ct, "Extension").map((e) => e.toLowerCase()));
  const overrides = new Set(attrValues(ct, "PartName"));
  for (const name of parts) {
    if (name === "[Content_Types].xml") continue;
    // 不用 extname：".rels" 这类点开头文件会被它当成无扩展名
    const ext = name.split(".").pop().toLowerCase();
    if (!defaults.has(ext) && !overrides.has("/" + name)) {
      issues.error(`part "${name}" 无内容类型声明（既无 Default .${ext} 也无 Override）`);
    }
  }
};

/** 层 1：关系完整性——rels 指向的文件存在；part 引用的 r:id 在自己的 rels 里有定义 */
const checkRelationships = (parts, files, issues) => {
  const partSet = new Set(parts);
  for (const relsPath of parts.filter((p) => p.endsWith(".rels"))) {
    const xml = files[relsPath];
    const rels = [...xml.matchAll(/<Relationship [^>]*>/g)].map((m) => m[0]);
    for (const rel of rels) {
      if (/TargetMode="External"/.test(rel)) continue;
      const target = (rel.match(/Target="([^"]*)"/) || [])[1];
      if (target && !partSet.has(resolveTarget(relsPath, target))) {
        issues.error(`${relsPath} 的 Target "${target}" 在包内不存在`);
      }
    }
  }
  for (const partPath of parts.filter((p) => /^word\/[^/]+\.xml$/.test(p))) {
    const relsPath = `word/_rels/${path.posix.basename(partPath)}.rels`;
    const declared = new Set(files[relsPath] ? attrValues(files[relsPath], "Id") : []);
    const used = new Set([
      ...attrValues(files[partPath], "r:id"),
      ...attrValues(files[partPath], "r:embed"),
    ]);
    for (const id of used) {
      if (!declared.has(id)) {
        issues.error(`${partPath} 引用了 ${id}，但 ${relsPath} 里没有这条关系`);
      }
    }
  }
};

/** 层 2：wml 命名空间的 part 逐个过 XSD；其余 part 只查良构 */
const checkSchema = (parts, files, issues, tmpDir) => {
  for (const partPath of parts.filter((p) => p.endsWith(".xml") || p.endsWith(".rels"))) {
    const raw = path.join(tmpDir, partPath.replace(/\//g, "__"));
    fs.writeFileSync(raw, files[partPath]);
    const isWml = files[partPath].includes(`xmlns:w="${WML_NS}"`) && partPath.startsWith("word/") && !partPath.endsWith(".rels");
    try {
      if (isWml) {
        const stripped = raw + ".stripped";
        fs.writeFileSync(stripped, execFileSync("xsltproc", [STRIP_XSLT, raw]));
        execFileSync("xmllint", ["--noout", "--schema", WML_XSD, stripped], { stdio: ["ignore", "ignore", "pipe"] });
      } else {
        execFileSync("xmllint", ["--noout", raw], { stdio: ["ignore", "ignore", "pipe"] });
      }
    } catch (e) {
      const detail = (e.stderr || "").toString().split("\n").filter(Boolean).slice(0, 5).join("\n  ");
      issues.error(`${partPath} ${isWml ? "schema 校验" : "XML 良构检查"}失败：\n  ${detail}`);
    }
  }
};

/**
 * 层 3：Word 兼容陷阱。每条都是「ECMA-376 合法、Word 实测拒开/出错」的写法，
 * 新踩的坑往这里加，并在 docs/upstream-issues.md 记一笔。
 */
const checkWordCompat = (parts, files, issues) => {
  const wmlParts = parts.filter((p) => p.startsWith("word/") && p.endsWith(".xml"));

  for (const partPath of wmlParts) {
    const xml = files[partPath];

    // [MS-OI29500]：Word 的长度属性只认整数 twips，"2.54cm" 这类 universal
    // measure 虽是 ECMA-376 合法值，Word 报「文件损坏」拒开
    for (const m of xml.matchAll(/w:[a-zA-Z]+="-?\d+(?:\.\d+)?(?:mm|cm|in|pt|pc|pi)"/g)) {
      issues.error(`${partPath} 含 universal measure ${m[0]}：标准合法但 Word 只认整数 twips，会拒开`);
    }

    // 书签数字 id 重复：Word 打开时报「内容有问题」
    const bookmarkIds = [...xml.matchAll(/<w:bookmarkStart [^>]*w:id="([^"]*)"/g)].map((m) => m[1]);
    const dup = bookmarkIds.filter((id, i) => bookmarkIds.indexOf(id) !== i);
    if (dup.length) {
      issues.error(`${partPath} 书签数字 id 重复：${[...new Set(dup)].join(", ")}`);
    }

    // lvlJc/jc 的 "start"/"end" 是 strict 枚举，transitional Word 只认 left/right，
    // 报「不可读取的内容」（docx 库 AlignmentType.START 会原样透传）
    for (const m of xml.matchAll(/<w:(lvlJc|jc) w:val="(start|end)"/g)) {
      issues.error(`${partPath} <w:${m[1]}> 用了 strict 枚举 "${m[2]}"：Word transitional 只认 left/right`);
    }

    // rPr 子元素顺序违反 CT_RPr sequence（如 rFonts 排在 sz 后）：Word 报
    // 「不可读取的内容」要求修复；docx 库按自身顺序 push，upstream-issues.md #5
    for (const m of xml.matchAll(/<w:rPr>([\s\S]*?)<\/w:rPr>/g)) {
      const tags = [...m[1].matchAll(/<(w:[a-zA-Z]+)[\s/>]/g)].map((t) => t[1]);
      const ranks = tags.map((t) => RPR_CHILD_ORDER.indexOf(t)).filter((i) => i !== -1);
      if (ranks.some((r, i) => i > 0 && r < ranks[i - 1])) {
        issues.error(`${partPath} rPr 子元素顺序违反 CT_RPr sequence：${tags.join(" → ")}`);
        break; // 同一 part 通常整批同因，报一条定位即可
      }
    }
  }

  const doc = files["word/document.xml"] || "";
  const bookmarks = new Set(attrValues(doc, "w:name"));
  const styles = new Set(files["word/styles.xml"] ? attrValues(files["word/styles.xml"], "w:styleId") : []);
  const numIds = new Set(
    files["word/numbering.xml"] ? [...files["word/numbering.xml"].matchAll(/<w:num w:numId="(\d+)"/g)].map((m) => m[1]) : []
  );

  for (const partPath of wmlParts) {
    const xml = files[partPath];
    // 悬空内链：Word 不拒开但点击报错，属于交付质量问题
    for (const anchor of attrValues(xml, "w:anchor")) {
      if (!bookmarks.has(anchor)) issues.warn(`${partPath} 内链锚点 "${anchor}" 无对应书签`);
    }
    // 悬空样式/编号：Word 静默回退到默认样式，版式悄悄走样比报错更难发现
    for (const m of xml.matchAll(/<w:[rp]Style w:val="([^"]*)"/g)) {
      if (!styles.has(m[1])) issues.warn(`${partPath} 引用了未定义样式 "${m[1]}"`);
    }
    for (const m of xml.matchAll(/<w:numId w:val="(\d+)"/g)) {
      if (m[1] !== "0" && !numIds.has(m[1])) issues.warn(`${partPath} 引用了未定义编号 numId=${m[1]}`);
    }
  }
};

// ---------------------------------------------------------------- 主流程

const validate = async (docxPath) => {
  const errors = [];
  const warnings = [];
  const issues = {
    error: (msg) => errors.push(msg),
    warn: (msg) => warnings.push(msg),
  };

  let zip;
  try {
    zip = await JSZip.loadAsync(fs.readFileSync(docxPath));
  } catch (e) {
    errors.push(`zip 解包失败：${e.message}`);
    return { errors, warnings };
  }

  const parts = Object.keys(zip.files).filter((n) => !zip.files[n].dir);
  const files = {};
  for (const name of parts) {
    if (name.endsWith(".xml") || name.endsWith(".rels")) {
      files[name] = await zip.file(name).async("string");
    }
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "docx-validate-"));
  try {
    checkContentTypes(parts, files, issues);
    checkRelationships(parts, files, issues);
    checkSchema(parts, files, issues, tmpDir);
    checkWordCompat(parts, files, issues);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  return { errors, warnings };
};

const main = async () => {
  const targets = process.argv.slice(2);
  if (!targets.length) {
    console.error("用法：node scripts/docx-validate.js <file.docx> [more.docx ...]");
    process.exit(2);
  }
  for (const cmd of ["xmllint", "xsltproc"]) {
    if (!hasCmd(cmd)) {
      console.error(`缺少依赖 ${cmd}，请安装 libxml2/libxslt`);
      process.exit(2);
    }
  }

  let failed = false;
  for (const target of targets) {
    const { errors, warnings } = await validate(target);
    const tag = errors.length ? "✗" : "✓";
    console.log(`${tag} ${target}  （error ${errors.length} / warn ${warnings.length}）`);
    for (const msg of errors) console.log(`  [error] ${msg}`);
    for (const msg of warnings) console.log(`  [warn]  ${msg}`);
    if (errors.length) failed = true;
  }
  process.exit(failed ? 1 : 0);
};

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
