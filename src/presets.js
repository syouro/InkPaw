/**
 * presets.js — 样式三层合并（docs/architecture.md）
 *
 *   ① 内置 preset（presets/*.json）
 *     ← ② 用户 style profile（data/style-profile.json，可缺省，get/set_style_profile 工具读写）
 *       ← ③ 文档 meta（def.meta）
 *
 * resolveDocConfig 输出渲染前所需的全部配置：合并后的 meta、autoNumber 开关、
 * captionStyle。样式参数全部活在 JSON 里，代码只做合并。
 */
const fs = require("fs");
const path = require("path");

const PRESETS_DIR = path.join(__dirname, "..", "presets");
const DEFAULT_PRESET = "monthly-report";

const listPresets = () => {
  return fs.readdirSync(PRESETS_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      const p = JSON.parse(fs.readFileSync(path.join(PRESETS_DIR, f), "utf8"));
      return { name: p.name || path.basename(f, ".json"), description: p.description || "" };
    });
};

const loadPreset = (name) => {
  const file = path.join(PRESETS_DIR, `${name}.json`);
  if (!fs.existsSync(file)) {
    throw new Error(`preset "${name}" 不存在，可用：${listPresets().map((p) => p.name).join(", ")}`);
  }
  return JSON.parse(fs.readFileSync(file, "utf8"));
};

/** 读用户 style profile，文件不存在返回 null（缺省配置不崩溃） */
const loadStyleProfile = (profilePath) => {
  if (!profilePath || !fs.existsSync(profilePath)) return null;
  return JSON.parse(fs.readFileSync(profilePath, "utf8"));
};

// 样式条目合并：同 id 的段落/字符样式，近层字段盖远层字段——run/paragraph
// 各深并一层（只改 alignment 不丢字体），再深的嵌套（indent/spacing 内部）整体替换
const mergeStyleEntry = (base, over) => {
  const out = { ...base, ...over };
  if (base.run && over.run) out.run = { ...base.run, ...over.run };
  if (base.paragraph && over.paragraph) out.paragraph = { ...base.paragraph, ...over.paragraph };
  return out;
};

// 数组按 key 就近覆盖：over 里同 key 的条目盖 base 的（merge 定义如何盖），
// base 独有的保留，over 新增的追加——覆盖一条不再丢整组
const mergeByKey = (baseArr, overArr, key, merge) => {
  if (!Array.isArray(baseArr)) return overArr;
  if (!Array.isArray(overArr)) return baseArr;
  const out = [...baseArr];
  for (const item of overArr) {
    const idx = item ? out.findIndex((b) => b && b[key] === item[key]) : -1;
    if (idx >= 0) out[idx] = merge(out[idx], item);
    else out.push(item);
  }
  return out;
};

// meta 浅合并，margins 这类一层嵌套对象单独深并，避免只改 top 就丢掉其余边距。
// styles/numbering 里的数组按条目 id/reference 就近覆盖（2026-07-13 定，CSS 层叠
// 语义）：doc meta 只重定义 md-bullet 时，preset 的 md-ordered 与其余段落样式保留
const mergeMeta = (base, over) => {
  if (!over) return { ...base };
  const out = { ...base, ...over };
  if (base.margins && over.margins) out.margins = { ...base.margins, ...over.margins };
  if (base.styles && over.styles) {
    out.styles = { ...base.styles, ...over.styles };
    out.styles.paragraphStyles = mergeByKey(
      base.styles.paragraphStyles, over.styles.paragraphStyles, "id", mergeStyleEntry);
    out.styles.characterStyles = mergeByKey(
      base.styles.characterStyles, over.styles.characterStyles, "id", mergeStyleEntry);
  }
  if (base.numbering && over.numbering) {
    out.numbering = { ...base.numbering, ...over.numbering };
    // 编号定义整条替换不深并：levels 是位置性定义，半新半旧没有意义
    out.numbering.config = mergeByKey(
      base.numbering.config, over.numbering.config, "reference", (b, o) => o);
  }
  if (base.tableStyle && over.tableStyle) out.tableStyle = { ...base.tableStyle, ...over.tableStyle };
  if (base.docProps && over.docProps) out.docProps = { ...base.docProps, ...over.docProps };
  return out;
};

const pick = (...vals) => vals.find((v) => v !== undefined);

/**
 * 三层合并出文档最终配置。
 * presetName 优先级：显式指定 > profile.preset > DEFAULT_PRESET
 * profile 结构：{ preset?, overrides?: { meta?, autoNumber?, captionStyle? } }
 */
const resolveDocConfig = ({ presetName, docMeta = {}, profilePath } = {}) => {
  const profile = loadStyleProfile(profilePath);
  const name = presetName || (profile && profile.preset) || DEFAULT_PRESET;
  const preset = loadPreset(name);
  const over = (profile && profile.overrides) || {};

  const meta = mergeMeta(mergeMeta(preset.meta || {}, over.meta), docMeta);
  // autoNumber 三态：false 关 / true 服务端文本编号（默认哲学）/ "native" Word 原生
  // 多级编号（标题样式挂 numPr，用户在 Word 里增删章节自动重排——实验开关）
  const autoNumber = pick(docMeta.autoNumber, over.autoNumber, preset.autoNumber, false);
  if (autoNumber !== true && autoNumber !== false && autoNumber !== "native") {
    throw new Error(`meta.autoNumber "${autoNumber}" 无效，可用：true（服务端文本编号）/ false（关闭）/ "native"（Word 原生多级编号，实验特性）`);
  }
  const headingNumbering = pick(docMeta.headingNumbering, over.headingNumbering, preset.headingNumbering);
  const captionStyle = pick(docMeta.captionStyle, over.captionStyle, preset.captionStyle, {});
  const markdown = pick(docMeta.markdown, over.markdown, preset.markdown, {});
  // target：目标查看器。"universal"（默认）兼容一切；"word" 时查看器相关
  // 特性走 Word 最优解（toc 出原生域带页码等）。用户说意图，代码选实现。
  const target = pick(docMeta.target, over.target, preset.target, "universal");
  if (target !== "universal" && target !== "word") {
    throw new Error(`meta.target "${target}" 无效，可用：universal（兼容一切查看器）/ word（收件人用 Word）`);
  }

  // autoNumber/captionStyle/markdown/target 是服务层配置，不进渲染层 meta
  delete meta.autoNumber;
  delete meta.captionStyle;
  delete meta.markdown;
  delete meta.target;
  // headingNumbering 只在 native 模式进渲染层 meta：非 native 时剥掉，
  // 否则标题会同时吃文本编号和样式 numPr，双重编号
  delete meta.headingNumbering;
  if (autoNumber === "native") {
    if (!headingNumbering || !Array.isArray(headingNumbering.levels) || !headingNumbering.levels.length) {
      throw new Error(`autoNumber:"native" 需要 headingNumbering 编号定义（preset "${name}" 未提供且 meta 未覆盖）`);
    }
    meta.headingNumbering = headingNumbering;
  }
  return { preset: name, meta, autoNumber, captionStyle, markdown, target };
};

module.exports = { listPresets, loadPreset, loadStyleProfile, resolveDocConfig, DEFAULT_PRESET };
