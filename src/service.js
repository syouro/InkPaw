/**
 * service.js — 服务层核心逻辑（docs/architecture.md）
 *
 * MCP 工具的实际实现，server.js 只做协议封装。独立于 MCP，可直接
 * require 做测试/脚本调用。依赖注入 dbPath/outputDir/profilePath，
 * 测试时用临时目录。
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);
const DOCX2PNG = path.join(__dirname, "..", "scripts", "docx2png.sh");
const { openStore } = require("./store");
const { fillNodeIds } = require("./ids");
const { normalizeNodes, normalizeNode } = require("./normalize");
const { validate, hasErrors, collectRefs, markerFingerprint } = require("./validator");
const { transform, buildNumberIndex } = require("./transform");
const { renderHtml, EDITOR_CSS } = require("./htmlUtil");
const { readPath, writePath, formatPath } = require("./nodePath");
const { resolveDocConfig, listPresets, loadPreset, loadStyleProfile } = require("./presets");
const { markdownToDef } = require("./markdown");
const { fetchUrlImagesInDef } = require("./fetch-images");
const { EXAMPLES } = require("./examples");
const { saveReport, contentWidthOf, normalizeColumns, sectionConfigOf } = require("./docxUtil");
const { extractSlots, inspectTemplate, renderTemplate, SLOT_NODE_TYPES } = require("./template");

const BRIEF_LEN = 30;

// ── 页眉页脚配置通道（docs/editable-preview.md §3.5）──────────────
// 类型化白名单：这批字段是布尔和对象，套不进 nodePath 那个只认字符串叶子的解析器，
// 所以走独立通道。样式与版式参数（headerSize/font/margins/landscape/columns）不开放
// ——它们属 preset 职责；headerImage/footerImage 的 src 是文件路径，开放等于给
// 编辑器开一条路径注入面，要先接图片上传通道再单独设计。
const DOC_CONFIG_FIELDS = {
  headerText: { type: "string", scopes: ["document", "section"] },
  pageNumber: { type: "boolean", scopes: ["document", "section"] },
  titlePage: { type: "boolean", scopes: ["document", "section"] },
  // 这两个不继承：仅节点显式给才生效（docxUtil.js sectionConfigOf），所以没有文档级
  pageNumberStart: { type: "integer", scopes: ["section"], min: 1 },
  pageNumberFormat: { type: "string", scopes: ["section"], enum: ["decimal", "lowerRoman", "upperRoman"] },
};

const assertConfigField = (field, scope) => {
  const spec = DOC_CONFIG_FIELDS[field];
  if (!spec) {
    throw new Error(`不可配置的字段: ${field}（允许: ${Object.keys(DOC_CONFIG_FIELDS).join(", ")}）`);
  }
  if (!spec.scopes.includes(scope)) {
    throw new Error(`${field} 不支持${scope === "document" ? "文档级" : "节级"}设置（仅 ${spec.scopes.join("/")}）`);
  }
  return spec;
};

const assertConfigValue = (field, spec, value) => {
  if (value === null) throw new Error(`${field} 不接受 null——要恢复继承请用 clear`);
  if (spec.type === "string" && typeof value !== "string") throw new Error(`${field} 必须是字符串`);
  if (spec.type === "boolean" && typeof value !== "boolean") throw new Error(`${field} 必须是布尔`);
  if (spec.type === "integer" && (!Number.isInteger(value) || value < (spec.min ?? 0))) {
    throw new Error(`${field} 必须是不小于 ${spec.min ?? 0} 的整数`);
  }
  if (spec.enum && !spec.enum.includes(value)) {
    throw new Error(`${field} 非法："${value}"（允许：${spec.enum.join(", ")}）`);
  }
};

/** 只挑出白名单里显式设过的字段——用于告诉 UI「这一层覆盖了什么」 */
const explicitConfigOf = (obj, scope) => {
  const out = {};
  for (const [field, spec] of Object.entries(DOC_CONFIG_FIELDS)) {
    if (spec.scopes.includes(scope) && obj && obj[field] !== undefined) out[field] = obj[field];
  }
  return out;
};

/** 有效值只取白名单内的部分：sectionConfigOf 还带版式字段，不该泄进配置面板 */
const effectiveConfigOf = (meta, breakNode, isFirst) => {
  const cfg = sectionConfigOf(meta, breakNode, isFirst);
  const out = {};
  for (const field of Object.keys(DOC_CONFIG_FIELDS)) out[field] = cfg[field];
  return out;
};

// profile 是全局配置，写错静默无效很难查——未知键直接打回
const PROFILE_KEYS = new Set(["preset", "overrides"]);
const OVERRIDE_KEYS = new Set(["meta", "autoNumber", "captionStyle", "markdown", "target", "headingNumbering"]);

const assertProfileShape = (profile) => {
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) {
    throw new Error("profile 必须是 { preset?, overrides? } 对象（或 null 清除）");
  }
  const badKeys = Object.keys(profile).filter((k) => !PROFILE_KEYS.has(k));
  if (badKeys.length > 0) throw new Error(`profile 未知键: ${badKeys.join(", ")}（允许: preset, overrides）`);
  if (profile.overrides !== undefined) {
    if (typeof profile.overrides !== "object" || Array.isArray(profile.overrides)) {
      throw new Error("profile.overrides 必须是对象");
    }
    const badOver = Object.keys(profile.overrides).filter((k) => !OVERRIDE_KEYS.has(k));
    if (badOver.length > 0) {
      throw new Error(`overrides 未知键: ${badOver.join(", ")}（允许: ${[...OVERRIDE_KEYS].join(", ")}）`);
    }
  }
};

const textBrief = (t) => {
  const s = Array.isArray(t) ? t.join("") : String(t ?? "");
  return s.length > BRIEF_LEN ? s.slice(0, BRIEF_LEN) + "…" : s;
};

const nodeBrief = (node) => {
  switch (node.type) {
    case "heading":
    case "text":
      return textBrief(node.text);
    case "table": {
      const rows = Array.isArray(node.data) ? node.data.length : 0;
      const widths = node.columnWidths || node.columnsWith;
      const firstRow = Array.isArray(node.data) && node.data[0] && node.data[0].texts;
      const cols = Array.isArray(widths) ? widths.length
        : Array.isArray(firstRow) ? firstRow.length : "?";
      const span = node.tableOptions && node.tableOptions.span
        && Object.keys(node.tableOptions.span).length > 0;
      return `${rows}行${cols}列${span ? "/有合并" : ""}${node.caption ? ` 表题:${node.caption}` : ""}`;
    }
    case "image": {
      const one = (s) => (typeof s === "string" && s.startsWith("data:") ? "[base64 图片]" : s);
      const src = Array.isArray(node.src) ? node.src.map(one).join(",") : one(node.src);
      return `${src}${node.caption ? ` 图题:${node.caption}` : ""}`;
    }
    case "toc":
      return node.native ? "目录（Word 原生域，打开需更新）" : "目录（静态展开）";
    case "checklist": {
      const items = Array.isArray(node.items) ? node.items : [];
      const done = items.filter((it) => it && typeof it === "object" && it.checked).length;
      return `${items.length} 项待办（${done} 已勾）`;
    }
    case "math":
      return `公式 ${textBrief(node.latex)}`;
    case "sectionBreak": {
      const parts = [];
      if (node.landscape) parts.push("横向");
      const cols = normalizeColumns(node.columns);
      if (cols) parts.push(`${cols.count}栏${cols.separator ? "(分隔线)" : ""}`);
      if (node.pageNumberStart) parts.push("重启页码");
      if (node.restartNumbering === true) parts.push("重启编号");
      if (node.headerText === "") parts.push("清页眉");
      if (node.breakType && node.breakType !== "nextPage") parts.push(node.breakType);
      return `分节${parts.length ? "：" + parts.join(",") : ""}`;
    }
    default:
      return "";
  }
};

// 模板槽位值的轻校验：槽位没有 ref/id 体系，不走 def 全量校验器
const TEMPLATE_BASE64_LIMIT = 5 * 1024 * 1024;

const validateTemplateSlots = (rawSlots, templateSlots) => {
  if (!rawSlots || typeof rawSlots !== "object" || Array.isArray(rawSlots)) {
    throw new Error("slots 必须是 { 槽名: 字符串 | 节点数组 } 对象");
  }
  const issues = [];
  const normalized = {};
  const tplSet = new Set(templateSlots);
  for (const [key, value] of Object.entries(rawSlots)) {
    if (!tplSet.has(key)) {
      issues.push({ level: "warn", rule: "template-slot-unknown",
        message: `槽位 "${key}" 不在模板里（模板槽位: ${templateSlots.join(", ") || "无"}），将被忽略` });
    }
    if (typeof value === "string") {
      normalized[key] = value;
      continue;
    }
    if (!Array.isArray(value)) {
      issues.push({ level: "error", rule: "slot-value-invalid",
        message: `槽位 "${key}" 的值必须是字符串（段内替换）或节点数组（整段块级替换）` });
      continue;
    }
    const nodes = normalizeNodes(value);
    nodes.forEach((n, i) => {
      const loc = `槽位 "${key}" 第 ${i} 个节点`;
      if (!n || typeof n !== "object" || !SLOT_NODE_TYPES.includes(n.type)) {
        issues.push({ level: "error", rule: "slot-node-type",
          message: `${loc} 类型 "${n && n.type}" 不支持（槽位支持: ${SLOT_NODE_TYPES.join("/")}；toc/checklist/sectionBreak 依赖全文档上下文，槽位里不成立）` });
        return;
      }
      const missing = (n.type === "text" || n.type === "heading") && n.text == null ? "text"
        : n.type === "table" && !Array.isArray(n.data) ? "data"
        : n.type === "image" && n.src == null ? "src"
        : n.type === "math" && typeof n.latex !== "string" ? "latex" : null;
      if (missing) {
        issues.push({ level: "error", rule: "slot-node-invalid", message: `${loc} 缺字段 ${missing}` });
        return;
      }
      const opts = Array.isArray(n.textOptions) ? n.textOptions : [n.textOptions];
      if (opts.some((o) => o && (o.footnote !== undefined || o.comment !== undefined))) {
        issues.push({ level: "warn", rule: "slot-node-feature",
          message: `${loc} 带 footnote/comment——脚注和批注依赖全文档编号，槽位里不支持，渲染将忽略` });
      }
      const srcs = n.type === "image" ? (Array.isArray(n.src) ? n.src : [n.src]) : [];
      if (srcs.some((s) => /^https?:\/\//i.test(s))) {
        issues.push({ level: "warn", rule: "slot-node-feature",
          message: `${loc} 是 URL 图片——槽位不走 fetchUrlImages 抓取，渲染将输出占位文字（用本地路径或 base64）` });
      }
    });
    normalized[key] = nodes;
  }
  for (const t of templateSlots) {
    if (!(t in rawSlots)) {
      issues.push({ level: "warn", rule: "template-slot-missing",
        message: `模板槽位 "${t}" 未提供值，渲染时 {{${t}}} 原样留下` });
    }
  }
  return { normalized, issues };
};

// 存储粗闸用的目录体积粗算：递归求和，公网单用户体量小，不做缓存
const dirSizeBytes = (dir) => {
  let total = 0;
  const stack = [dir];
  while (stack.length > 0) {
    let entries;
    const cur = stack.pop();
    try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile()) { try { total += fs.statSync(p).size; } catch { /* 竞态忽略 */ } }
    }
  }
  return total;
};

const createService = ({ dbPath, outputDir, profilePath, templatesDir, scoped = false, limits }) => {
  const store = openStore(dbPath);

  // scoped=true：公网多用户作用域（server.js 按 X-Docx-Scope-User 头建实例）。
  // 服务器本地路径类参数一律封死——path 是任意文件读原语，outPath 是越目录写原语，
  // 都不该暴露给公网用户的 LLM 工具面
  const assertNotScoped = (what, hint) => {
    if (scoped) throw new Error(`公网作用域下不支持 ${what}（${hint}）`);
  };

  // 存储粗闸（见 docs/architecture.md）：不是配额系统，只堵「无限身份×无限落盘」
  // 的磁盘耗尽向量。报错文案要让 agent 能把原因转述给用户
  const assertTemplateQuota = () => {
    if (!limits || !limits.maxTemplates) return;
    if (store.listTemplates().length >= limits.maxTemplates) {
      throw new Error(`模板数已达上限 ${limits.maxTemplates} 个——请先用 delete_template 删除不再使用的模板，再上传新模板`);
    }
  };
  const assertOutputQuota = () => {
    if (!limits || !limits.maxOutputMB) return;
    if (dirSizeBytes(outputDir) > limits.maxOutputMB * 1024 * 1024) {
      throw new Error(`渲染产物空间已超 ${limits.maxOutputMB}MB 上限——旧预览会自动过期清理，请稍后再渲染，或联系管理员扩容`);
    }
  };

  const getDocOrThrow = (docId) => {
    const doc = store.getDocument(docId);
    if (!doc) throw new Error(`文档不存在: ${docId}`);
    return doc;
  };

  // 节点级工具只对 def 文档有意义；模板填槽文档改内容走 update_template_slots
  const getDefDocOrThrow = (docId) => {
    const doc = getDocOrThrow(docId);
    if (doc.kind === "template") {
      throw new Error(`文档 ${docId} 是模板填槽文档，没有节点结构——改内容用 update_template_slots，渲染用 render_document`);
    }
    return doc;
  };

  const getTemplateOrThrow = (templateId) => {
    const tpl = store.getTemplate(templateId);
    if (!tpl) throw new Error(`模板不存在: ${templateId}（用 list_templates 查已注册模板）`);
    return tpl;
  };

  const templateFilePath = (tpl) => path.join(templatesDir, `${tpl.id}.${tpl.ext}`);

  // 渲染尾段（def 流和模板流共用）：preview 转每页 PNG、pdf 导出
  const withPreviewPdf = async (result, target, { preview, pdf }) => {
    // 视觉检查模式：转成每页一张 PNG，agent 直接读图看排版（LibreOffice headless）
    if (preview) {
      const previewDir = path.join(path.dirname(target), `${path.basename(target, ".docx")}-preview`);
      try {
        await execFileAsync("bash", [DOCX2PNG, target, previewDir], { timeout: 120000 });
        result.previewPages = fs.readdirSync(previewDir)
          .filter((f) => f.endsWith(".png"))
          .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
          .map((f) => path.join(previewDir, f));
      } catch (e) {
        result.warnings = [...result.warnings, `预览生成失败（docx 本体已渲染成功）: ${e.message}`];
      }
    }
    // PDF 导出：交付不怕查看器差异（LibreOffice 转换，公式/复选框均已栅格化定型）
    if (pdf) {
      try {
        // soffice 并发抢 profile 锁，给独立 UserInstallation（同 docx2png.sh）
        const profile = fs.mkdtempSync(path.join(os.tmpdir(), "docx-mcp-lo-"));
        try {
          await execFileAsync("soffice", [
            "--headless", `-env:UserInstallation=file://${profile}`,
            "--convert-to", "pdf", "--outdir", path.dirname(target), target,
          ], { timeout: 120000 });
        } finally {
          fs.rmSync(profile, { recursive: true, force: true });
        }
        const pdfPath = target.replace(/\.docx$/, ".pdf");
        if (!fs.existsSync(pdfPath)) throw new Error("soffice 未产出 PDF");
        result.pdfPath = pdfPath;
      } catch (e) {
        result.warnings = [...result.warnings, `PDF 导出失败（docx 本体已渲染成功）: ${e.message}`];
      }
    }
    return result;
  };

  const assertPosition = (position) => {
    if (position !== "before" && position !== "after") {
      throw new Error('position 必须是 "before" 或 "after"');
    }
  };

  const findAnchorIndex = (contexts, anchorId) => {
    const idx = contexts.findIndex((n) => n && n.id === anchorId);
    if (idx === -1) throw new Error(`锚点节点不存在: ${anchorId}`);
    return idx;
  };

  const outlineOf = (def, section) => {
    const contexts = def.contexts || [];
    const { byId } = buildNumberIndex(contexts);
    const inSection = (sp) => !section || sp === section || sp.startsWith(`${section}.`);
    return contexts
      .filter((n) => n && n.id && byId[n.id] && inSection(byId[n.id].sectionPath))
      .map((n) => ({
        id: n.id,
        type: n.type,
        ...(n.type === "heading" ? { level: n.level } : {}),
        sectionPath: byId[n.id].sectionPath,
        brief: nodeBrief(n),
      }));
  };

  // 修改类工具附带服务端算好的最新骨架——文档状态一致性由代码接管，
  // 不让 LLM 拿增量去合并自己脑中的旧状态；大文档不附带，避免撑爆返回
  const OUTLINE_LIMIT = 200;
  const withOutline = (result, updated) => {
    const count = (updated.def.contexts || []).length;
    if (count <= OUTLINE_LIMIT) return { ...result, outline: outlineOf(updated.def) };
    return { ...result, outlineNote: `节点数 ${count} 超过 ${OUTLINE_LIMIT}，请用 get_outline 按 section 取骨架` };
  };

  // 校验统一入口：preset 合并后才知道 autoNumber 开关和图片基准目录
  const validateDoc = (doc) => {
    const cfg = resolveDocConfig({ presetName: doc.preset, docMeta: doc.def.meta || {}, profilePath });
    const imagesDir = cfg.meta.imagesDir || ".";
    const imagesBaseDir = path.isAbsolute(imagesDir) ? imagesDir : path.resolve(process.cwd(), imagesDir);
    return { cfg, issues: validate(doc.def, {
      autoNumber: cfg.autoNumber, imagesBaseDir, contentWidth: contentWidthOf(cfg.meta),
      meta: cfg.meta, // 合并后 meta：校验器按节重算版心（多 section 表格超宽）
      fetchUrlImages: cfg.meta.fetchUrlImages === true,
      target: cfg.target, // pageRef 的查看器警告按三层合并后的 target 判
    }) };
  };

  // 具名对象：草稿视图的结构编辑要转调同对象里的 insert/delete/move，需要自引用
  const methods = {
    listPresets: () => listPresets(),

    createDocument: ({ title = "", preset, def }) => {
      if (!def || typeof def !== "object" || !Array.isArray(def.contexts)) {
        throw new Error("def 必须是 { meta?, contexts: [...] } 结构");
      }
      // preset 名合法性在这里就爆掉，不落脏数据
      const cfg = resolveDocConfig({ presetName: preset, docMeta: def.meta || {}, profilePath });
      const filledDef = { ...def, contexts: fillNodeIds(normalizeNodes(def.contexts)) };
      const doc = store.createDocument({ title, preset: cfg.preset, def: filledDef });
      const { issues } = validateDoc(doc);
      return { docId: doc.id, preset: cfg.preset, issues };
    },

    createDocumentFromMarkdown: ({ title = "", preset, markdown, baseDir, imagesDir, meta = {} }) => {
      if (typeof markdown !== "string" || !markdown.trim()) {
        throw new Error("markdown 必须是非空字符串");
      }
      const cfg = resolveDocConfig({ presetName: preset, docMeta: meta, profilePath });
      const base = baseDir ? path.resolve(baseDir) : process.cwd();
      const imgDir = imagesDir || cfg.meta.imagesDir || ".";
      // imagesDir 落成绝对路径存进 def：渲染/校验不再依赖调用时的 cwd
      const imagesAbsDir = path.isAbsolute(imgDir) ? imgDir : path.resolve(base, imgDir);
      const { contexts, issues: mdIssues } = markdownToDef(markdown, {
        imagesAbsDir,
        imageMaxWidth: cfg.markdown && cfg.markdown.imageMaxWidth,
        autoNumber: cfg.autoNumber,
        fetchUrlImages: cfg.meta.fetchUrlImages === true,
      });
      // meta 透传进 def（autoNumber 关闭、headerText 等），imagesDir 以解析结果为准
      const def = { meta: { ...meta, imagesDir: imagesAbsDir }, contexts: fillNodeIds(contexts) };
      const doc = store.createDocument({ title, preset: cfg.preset, def });
      const { issues } = validateDoc(doc);
      return { docId: doc.id, preset: cfg.preset, issues: [...mdIssues, ...issues] };
    },

    validateDocument: ({ docId }) => {
      const doc = getDocOrThrow(docId);
      if (doc.kind === "template") {
        const tpl = getTemplateOrThrow(doc.def.templateId);
        return { issues: validateTemplateSlots(doc.def.slots, tpl.slots).issues };
      }
      return { issues: validateDoc(doc).issues };
    },

    registerTemplate: async ({ name, path: filePath, base64 }) => {
      if ((filePath ? 1 : 0) + (base64 ? 1 : 0) !== 1) {
        throw new Error("path 和 base64 必须二选一（path 是服务器本地路径；base64 用于远程上传）");
      }
      assertTemplateQuota();
      let buffer;
      if (filePath) {
        assertNotScoped("path 注册模板", "服务器本地路径不可访问，用 base64 上传");
        const abs = path.resolve(filePath);
        if (!fs.existsSync(abs)) throw new Error(`模板文件不存在: ${abs}`);
        buffer = fs.readFileSync(abs);
      } else {
        buffer = Buffer.from(base64, "base64");
        if (buffer.length > TEMPLATE_BASE64_LIMIT) {
          throw new Error(`base64 模板超过 ${TEMPLATE_BASE64_LIMIT / 1024 / 1024}MB 上限（大模板放服务器上走 path）`);
        }
      }
      const { isDotx } = await inspectTemplate(buffer);
      const slots = await extractSlots(buffer);
      const warnings = slots.length === 0
        ? ["模板里没有 {{槽名}} 占位符——填槽将不改变任何内容，确认模板里的占位符写法"] : [];
      const tpl = store.createTemplate({
        name: name || (filePath ? path.basename(filePath) : "未命名模板"),
        ext: isDotx ? "dotx" : "docx",
        slots,
      });
      fs.mkdirSync(templatesDir, { recursive: true });
      fs.writeFileSync(templateFilePath(tpl), buffer);
      return { templateId: tpl.id, name: tpl.name, slots, warnings };
    },

    listTemplates: () => ({
      templates: store.listTemplates().map((t) => ({
        templateId: t.id, name: t.name, ext: t.ext, slots: t.slots, createdAt: t.createdAt,
      })),
    }),

    deleteTemplate: ({ templateId }) => {
      const tpl = getTemplateOrThrow(templateId);
      store.deleteTemplate(templateId);
      fs.rmSync(templateFilePath(tpl), { force: true });
      return { deleted: templateId, name: tpl.name,
        note: "由该模板创建的填槽文档将无法再渲染（渲染时报模板不存在）" };
    },

    createDocumentFromTemplate: ({ templateId, title = "", slots = {}, imagesDir }) => {
      const tpl = getTemplateOrThrow(templateId);
      if (!fs.existsSync(templateFilePath(tpl))) {
        throw new Error(`模板文件丢失: ${templateFilePath(tpl)}（模板 ${templateId} 需重新注册）`);
      }
      const { normalized, issues } = validateTemplateSlots(slots, tpl.slots);
      // 槽位图片相对路径的基准落成绝对路径存 def：渲染不依赖调用时 cwd（同 markdown 流）
      const imagesAbsDir = imagesDir
        ? (path.isAbsolute(imagesDir) ? imagesDir : path.resolve(process.cwd(), imagesDir))
        : undefined;
      const doc = store.createDocument({
        title, preset: "", kind: "template",
        def: { templateId, slots: normalized, ...(imagesAbsDir ? { imagesDir: imagesAbsDir } : {}) },
      });
      return { docId: doc.id, templateId, issues };
    },

    updateTemplateSlots: ({ docId, slots }) => {
      const doc = getDocOrThrow(docId);
      if (doc.kind !== "template") {
        throw new Error(`文档 ${docId} 不是模板填槽文档——def 文档改内容用 update_node/insert_nodes`);
      }
      if (!slots || typeof slots !== "object" || Array.isArray(slots)) {
        throw new Error("slots 必须是 { 槽名: 字符串 | 节点数组 | null } 对象（null 删除该槽的已填值）");
      }
      const tpl = getTemplateOrThrow(doc.def.templateId);
      // 浅合并：只动传入的键，null 恢复未填状态（渲染时占位符原样留下）
      const merged = { ...doc.def.slots };
      const patch = {};
      for (const [key, value] of Object.entries(slots)) {
        if (value === null) delete merged[key];
        else patch[key] = value;
      }
      const { normalized, issues } = validateTemplateSlots(patch, tpl.slots);
      Object.assign(merged, normalized);
      // missing/unknown 警告按合并后的完整槽位状态重报，patch 局部校验的会失真
      const finalIssues = [
        ...issues.filter((i) => i.rule !== "template-slot-missing" && i.rule !== "template-slot-unknown"),
        ...validateTemplateSlots(merged, tpl.slots).issues
          .filter((i) => i.rule === "template-slot-missing" || i.rule === "template-slot-unknown"),
      ];
      store.updateDef(docId, { ...doc.def, slots: merged });
      return { filled: Object.keys(merged), templateSlots: tpl.slots, issues: finalIssues };
    },

    renderDocument: async ({ docId, outPath, preview = false, pdf = false }) => {
      if (outPath) assertNotScoped("outPath", "产物固定落用户输出目录，用缺省路径即可");
      assertOutputQuota();
      const doc = getDocOrThrow(docId);
      if (doc.kind === "template") {
        // 模板填槽文档：现场执行 patch，排版由模板本身决定
        const { templateId, slots, imagesDir } = doc.def;
        const tpl = getTemplateOrThrow(templateId);
        const tplPath = templateFilePath(tpl);
        if (!fs.existsSync(tplPath)) throw new Error(`模板文件丢失: ${tplPath}（模板 ${templateId} 需重新注册）`);
        const { normalized, issues: slotIssues } = validateTemplateSlots(slots, tpl.slots);
        if (hasErrors(slotIssues)) {
          return { ok: false, issues: slotIssues, message: "存在 error 级 issue，拒绝渲染" };
        }
        const { buffer, leftover } = await renderTemplate(
          fs.readFileSync(tplPath), normalized, { imagesDir: imagesDir || process.cwd() });
        const target = outPath ? path.resolve(outPath) : path.join(outputDir, `${docId}.docx`);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, buffer);
        const warns = slotIssues.filter((i) => i.level === "warn").map((i) => i.message);
        if (leftover.length > 0) {
          warns.push(`渲染产物仍残留占位符: ${leftover.map((s) => `{{${s}}}`).join(", ")}`);
        }
        return withPreviewPdf({ ok: true, path: target, warnings: warns }, target, { preview, pdf });
      }
      const validated = validateDoc(doc);
      const { issues } = validated;
      let cfg = validated.cfg;
      if (hasErrors(issues)) {
        return { ok: false, issues, message: "存在 error 级 issue，拒绝渲染" };
      }
      // URL 图片 opt-in：渲染前抓下来转 base64 并回写 def——文档自包含，
      // 后续渲染不再拉网络；失败保留 URL（渲染占位），warning 透传
      let workDef = doc.def;
      const urlWarnings = [];
      if (cfg.meta.fetchUrlImages === true) {
        const fetched = await fetchUrlImagesInDef(doc.def);
        urlWarnings.push(...fetched.warnings);
        if (fetched.changed) {
          workDef = store.updateDef(docId, fetched.def).def;
          // meta 里的页眉页脚图也可能被抓取回写，三层合并要重算
          cfg = resolveDocConfig({ presetName: doc.preset, docMeta: workDef.meta || {}, profilePath });
        }
      }
      const { def: v1def, warnings } = transform(workDef, {
        autoNumber: cfg.autoNumber,
        captionStyle: cfg.captionStyle,
        target: cfg.target,
        h1PageBreak: cfg.meta.h1PageBreak === true,
      });
      // 文档属性 title 缺省用建档时的 title（Word「文件-信息」面板可见）
      const docProps = doc.title && !(cfg.meta.docProps && cfg.meta.docProps.title)
        ? { ...(cfg.meta.docProps || {}), title: doc.title } : cfg.meta.docProps;
      const finalDef = { ...v1def, meta: { ...cfg.meta, ...(docProps ? { docProps } : {}) } }; // cfg.meta 已是三层合并结果

      const target = outPath ? path.resolve(outPath) : path.join(outputDir, `${docId}.docx`);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      await saveReport(finalDef, target);
      const warns = [...warnings, ...urlWarnings, ...issues.filter((i) => i.level === "warn").map((i) => i.message)];
      return withPreviewPdf({ ok: true, path: target, warnings: warns }, target, { preview, pdf });
    },

    /**
     * 可编辑草稿视图的 HTML（docs/editable-preview.md §3）。
     * 走和渲染同一条 transform：编号、图表号、{{ref:}} 解析结果必须与 DOCX 一致，
     * 否则客户在草稿里看到的编号和最终文档对不上。
     * 不落盘、不碰 LibreOffice——纯内存，随时可调。
     */
    getDraftHtml: ({ docId }) => {
      const doc = getDefDocOrThrow(docId);
      const cfg = resolveDocConfig({ presetName: doc.preset, docMeta: doc.def.meta || {}, profilePath });
      const { def: v1def, warnings } = transform(doc.def, {
        autoNumber: cfg.autoNumber,
        captionStyle: cfg.captionStyle,
        target: cfg.target,
        h1PageBreak: cfg.meta.h1PageBreak === true,
      });
      const { html, warnings: htmlWarnings } = renderHtml(v1def);
      return { html, css: EDITOR_CSS, warnings: [...warnings, ...htmlWarnings] };
    },

    /**
     * 路径级值编辑（docs/editable-preview.md §3.2.3、§3.3、§3.4）。
     *
     * 草稿视图的写回入口：只替换一个字符串叶子，不动结构。内部解析成完整新节点后
     * 交给和 update_node 同一条路径落库+校验——不新开平行写入口。
     *
     * 标记一致性由服务端独立校验：{{ref:}} / {{pageRef:}} 的 id 与顺序必须原样保留。
     * 前端有 chip 锁定，但那是体验层防线，不能替代这里——绕过前端直接打 API 是常态。
     */
    updateNodeValue: ({ docId, id, path: leafPath, value }) => {
      const doc = getDefDocOrThrow(docId);
      const contexts = doc.def.contexts || [];
      const idx = contexts.findIndex((n) => n && n.id === id);
      if (idx === -1) throw new Error(`节点不存在: ${id}（docId=${docId}）`);

      const current = readPath(contexts[idx], leafPath);
      if (!current.ok) throw new Error(`路径不存在: ${formatPath(leafPath)}（节点 ${id}）`);
      const before = markerFingerprint(current.value);
      const after = markerFingerprint(value);
      if (before !== after) {
        throw new Error(
          `引用标记不可增删改：原 [${before || "无"}]，新 [${after || "无"}]。`
          + `编号与交叉引用由服务端维护，草稿视图只能改文字`,
        );
      }

      const written = writePath(contexts[idx], leafPath, value);
      if (!written.ok) throw new Error(`${written.message}（节点 ${id}）`);

      const newContexts = [...contexts];
      newContexts[idx] = normalizeNode(written.node);
      const updated = store.updateDef(docId, { ...doc.def, contexts: newContexts });
      const { issues } = validateDoc(updated);
      return { ok: true, id, path: formatPath(leafPath), issues };
    },

    /**
     * 页眉页脚配置读取（docs/editable-preview.md §3.5）。
     * 同时给出「这一层显式设了什么」和「合并后的有效值」——UI 要靠这两者区分
     * 继承态和覆盖态，只给有效值的话用户分不清某个值是自己设的还是继承来的。
     */
    getDocConfig: ({ docId }) => {
      const doc = getDefDocOrThrow(docId);
      const cfg = resolveDocConfig({ presetName: doc.preset, docMeta: doc.def.meta || {}, profilePath });
      const contexts = doc.def.contexts || [];
      const sections = contexts
        .map((n, index) => ({ n, index }))
        .filter(({ n }) => n && n.type === "sectionBreak")
        .map(({ n, index }) => ({
          id: n.id || null,
          index,
          brief: nodeBrief(n),
          set: explicitConfigOf(n, "section"),
          effective: effectiveConfigOf(cfg.meta, n, false),
        }));
      return {
        fields: DOC_CONFIG_FIELDS,
        document: {
          set: explicitConfigOf(doc.def.meta || {}, "document"),
          // 首节有效值 = preset/profile 合并后的 meta 基准（封面语义只作用第一节）
          effective: effectiveConfigOf(cfg.meta, null, true),
        },
        sections,
      };
    },

    /**
     * 页眉页脚配置写入（§3.5.4）。
     * set 赋值、clear 恢复继承——**继承必须是删除键，不是置空**：headerText:"" 的语义是
     * 「本节显式无页眉」，与未设置完全不同（sectionConfigOf 用 !== undefined 判定）。
     * 写成空字符串会让页眉静默消失且查不出原因。
     */
    updateDocConfig: ({ docId, sectionId, set = {}, clear = [] }) => {
      const doc = getDefDocOrThrow(docId);
      const scope = sectionId ? "section" : "document";
      for (const [field, value] of Object.entries(set)) {
        assertConfigValue(field, assertConfigField(field, scope), value);
      }
      for (const field of clear) assertConfigField(field, scope);
      const overlap = clear.filter((f) => f in set);
      if (overlap.length) throw new Error(`同一字段不能同时 set 和 clear: ${overlap.join(", ")}`);

      const applyTo = (obj) => {
        const next = { ...obj, ...set };
        for (const field of clear) delete next[field];
        return next;
      };

      let newDef;
      if (scope === "document") {
        newDef = { ...doc.def, meta: applyTo(doc.def.meta || {}) };
      } else {
        const contexts = doc.def.contexts || [];
        const idx = contexts.findIndex((n) => n && n.id === sectionId);
        if (idx === -1) throw new Error(`节点不存在: ${sectionId}（docId=${docId}）`);
        if (contexts[idx].type !== "sectionBreak") {
          throw new Error(`节点 ${sectionId} 是 ${contexts[idx].type}，节级配置只能设在 sectionBreak 上`);
        }
        const newContexts = [...contexts];
        newContexts[idx] = normalizeNode(applyTo(contexts[idx]));
        newDef = { ...doc.def, contexts: newContexts };
      }
      const updated = store.updateDef(docId, newDef);
      const { issues } = validateDoc(updated);
      return { ok: true, scope, sectionId: sectionId || null, issues };
    },

    /**
     * 草稿视图的块级结构编辑（docs/editable-preview.md §4 P4）。
     *
     * 收窄的 UI 通道，转调既有 insertNodes/deleteNodes/moveNodes——不新开平行写路径，
     * 引用悬空告警、id 分配、校验全部沿用原有逻辑。
     *
     * 只做**块级**：整节点的增、删、上下移。段落内 run 的增删不在此列——
     * text 与 textOptions 是按下标一一对应的平行数组（§3.2.5），增删 run 必须同步
     * 维护两者，错一格样式和脚注会整体错位；且页面上没有「这是第几个 run」的自然操作
     * 入口。插图同样不做：src 是文件路径，开放等于给编辑器开一条路径注入面（§3.5.4）。
     */
    updateDraftStructure: ({ docId, op, anchorId, text = "" }) => {
      const doc = getDefDocOrThrow(docId);
      const contexts = doc.def.contexts || [];
      const idx = contexts.findIndex((n) => n && n.id === anchorId);
      if (idx === -1) throw new Error(`节点不存在: ${anchorId}（docId=${docId}）`);

      switch (op) {
        case "insertBefore":
        case "insertAfter":
          // 只允许插普通段落：表格/公式/分节结构复杂，是模型的活
          return methods.insertNodes({
            docId, anchorId,
            position: op === "insertAfter" ? "after" : "before",
            nodes: [{ type: "text", text: String(text) }],
          });
        case "delete":
          if (contexts.length <= 1) throw new Error("文档至少要留一个节点");
          return methods.deleteNodes({ docId, ids: [anchorId] });
        case "moveUp":
        case "moveDown": {
          const step = op === "moveUp" ? -1 : 1;
          const neighbor = contexts[idx + step];
          if (!neighbor || !neighbor.id) {
            throw new Error(op === "moveUp" ? "已经是第一个可移动节点" : "已经是最后一个可移动节点");
          }
          return methods.moveNodes({
            docId, ids: [anchorId], anchorId: neighbor.id,
            position: op === "moveUp" ? "before" : "after",
          });
        }
        default:
          throw new Error(`未知操作: ${op}（允许: insertBefore, insertAfter, delete, moveUp, moveDown）`);
      }
    },

    getOutline: ({ docId, section }) => {
      const doc = getDefDocOrThrow(docId);
      return outlineOf(doc.def, section);
    },

    getNodes: ({ docId, ids }) => {
      const doc = getDefDocOrThrow(docId);
      const byId = new Map((doc.def.contexts || []).map((n) => [n.id, n]));
      return ids.map((id) => byId.get(id) || null);
    },

    updateNode: ({ docId, id, node }) => {
      const doc = getDefDocOrThrow(docId);
      const contexts = doc.def.contexts || [];
      const idx = contexts.findIndex((n) => n && n.id === id);
      if (idx === -1) throw new Error(`节点不存在: ${id}（docId=${docId}）`);
      // id 不变，ref 不断——整节点替换含提级（text 换 heading）
      const newContexts = [...contexts];
      newContexts[idx] = normalizeNode({ ...node, id });
      const newDef = { ...doc.def, contexts: newContexts };
      const updated = store.updateDef(docId, newDef);
      return withOutline({ issues: validateDoc(updated).issues }, updated);
    },

    insertNodes: ({ docId, anchorId, position, nodes }) => {
      const doc = getDefDocOrThrow(docId);
      assertPosition(position);
      if (!Array.isArray(nodes) || nodes.length === 0) throw new Error("nodes 必须是非空数组");
      const contexts = doc.def.contexts || [];
      const idx = findAnchorIndex(contexts, anchorId);
      const at = position === "before" ? idx : idx + 1;
      // 整表过 fillNodeIds：新 id 避开存量；调用方自带 id 撞车由校验器 id-dup 报
      const merged = fillNodeIds([...contexts.slice(0, at), ...normalizeNodes(nodes), ...contexts.slice(at)]);
      const updated = store.updateDef(docId, { ...doc.def, contexts: merged });
      return withOutline({
        newIds: merged.slice(at, at + nodes.length).map((n) => n.id),
        issues: validateDoc(updated).issues,
      }, updated);
    },

    deleteNodes: ({ docId, ids }) => {
      const doc = getDefDocOrThrow(docId);
      if (!Array.isArray(ids) || ids.length === 0) throw new Error("ids 必须是非空数组");
      const contexts = doc.def.contexts || [];
      const have = new Set(contexts.map((n) => n && n.id));
      const missing = ids.filter((id) => !have.has(id));
      if (missing.length > 0) throw new Error(`节点不存在: ${missing.join(", ")}（docId=${docId}）`);
      const del = new Set(ids);
      // 删除前扫描引用方：留下的节点 ref 到被删节点，点名是谁引用了谁
      const refWarnings = [];
      for (const node of contexts) {
        if (!node || del.has(node.id)) continue;
        for (const refId of collectRefs(node)) {
          if (del.has(refId)) {
            refWarnings.push({ level: "warn", rule: "delete-ref-broken",
              message: `节点 ${node.id} 引用了被删除的 ${refId}，{{ref:${refId}}} 将悬空`, nodeId: node.id });
          }
        }
      }
      const updated = store.updateDef(docId, {
        ...doc.def, contexts: contexts.filter((n) => !n || !del.has(n.id)),
      });
      return withOutline({ issues: [...refWarnings, ...validateDoc(updated).issues] }, updated);
    },

    moveNodes: ({ docId, ids, anchorId, position }) => {
      const doc = getDefDocOrThrow(docId);
      assertPosition(position);
      if (!Array.isArray(ids) || ids.length === 0) throw new Error("ids 必须是非空数组");
      if (new Set(ids).size !== ids.length) throw new Error("ids 里有重复");
      if (ids.includes(anchorId)) throw new Error("anchorId 不能在待移动的 ids 里");
      const contexts = doc.def.contexts || [];
      const byId = new Map(contexts.filter((n) => n && n.id).map((n) => [n.id, n]));
      const missing = ids.filter((id) => !byId.has(id));
      if (missing.length > 0) throw new Error(`节点不存在: ${missing.join(", ")}（docId=${docId}）`);
      const moving = new Set(ids);
      const rest = contexts.filter((n) => !n || !moving.has(n.id));
      const anchorIdx = findAnchorIndex(rest, anchorId);
      const at = position === "before" ? anchorIdx : anchorIdx + 1;
      // 按 ids 给出的顺序落位：移动的同时支持组内重排
      const newContexts = [...rest.slice(0, at), ...ids.map((id) => byId.get(id)), ...rest.slice(at)];
      const updated = store.updateDef(docId, { ...doc.def, contexts: newContexts });
      return withOutline({ issues: validateDoc(updated).issues }, updated);
    },

    getExamples: ({ topic } = {}) => {
      if (!topic) {
        return { topics: Object.entries(EXAMPLES).map(([name, e]) => ({ name, brief: e.brief })) };
      }
      const entry = EXAMPLES[topic];
      if (!entry) throw new Error(`未知主题: ${topic}，可用：${Object.keys(EXAMPLES).join(", ")}`);
      return { topic, ...entry };
    },

    getStyleProfile: () => ({ profile: loadStyleProfile(profilePath) }),

    setStyleProfile: ({ profile }) => {
      if (profile === null) {
        fs.rmSync(profilePath, { force: true });
        return { profile: null };
      }
      assertProfileShape(profile);
      if (profile.preset) loadPreset(profile.preset); // preset 名合法性在这里就爆掉
      fs.mkdirSync(path.dirname(profilePath), { recursive: true });
      fs.writeFileSync(profilePath, JSON.stringify(profile, null, 2));
      return { profile };
    },

    _store: store,
    close: () => store.close(),
  };

  return methods;
};

module.exports = { createService };
