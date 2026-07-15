/**
 * docxUtil.js — docx 报告生成器（docxUtil1 / docxUtil2 合并修正版）
 *
 * 输入一个 report 定义对象 { meta, contexts }，输出 .docx 文件。
 * contexts 节点规范见 docxUtil-spec.md，该规范设计为可直接作为
 * LLM function call 的 schema 使用：LLM 只负责生成 { meta, contexts }
 * 这个纯数据结构（即 report.js），排版细节由本文件接管。
 *
 * 相对旧版的修正：
 * - 页眉文字/编号不再硬编码，从 meta.headerText 传入
 * - 页眉页脚每次构建时新建，不再改全局变量（旧版 isDay 会永久杀掉页眉）
 * - 图片路径不再拼死 pId/monthDate，节点直接给 src，基于 meta.imagesDir 解析
 * - 图片缺失时输出占位文字并 warn，不再静默吞掉
 * - 表格 cell 内嵌图片/文字支持 cNo 指定列（旧版会往整行每个格子里塞）
 * - columnWidths / columnsWith（旧版拼写）均接受
 * - 修掉 paragraphSpacing 重复 key、'3.17 cm' 带空格等笔误
 */
const fs = require("fs");
const path = require("path");
const docx = require("docx");

const {
  AlignmentType,
  Document,
  HeadingLevel,
  LevelFormat,
  Packer,
  Paragraph,
  TextRun,
  PageBreak,
  VerticalAlign,
  ImageRun,
  Table, TableCell, TableRow, WidthType, TableLayoutType,
  LevelSuffix,
  PageOrientation,
  PageNumber,
  NumberFormat,
  Header,
  Footer,
  Tab, TabStopType,
  ExternalHyperlink, InternalHyperlink, BookmarkStart, BookmarkEnd,
  TableOfContents,
  FootnoteReferenceRun,
  CheckBox,
  CommentRangeStart, CommentRangeEnd, CommentReference,
  Math: DocxMath, MathRun, MathFraction, MathRadical, MathSum,
  MathSuperScript, MathSubScript, MathSubSuperScript,
  PageReference,
  ImportedXmlComponent,
  HorizontalPositionRelativeFrom, VerticalPositionRelativeFrom,
  TextWrappingType, TextWrappingSide,
} = docx;

// {{pageRef:id}} 页码引用占位。transform 原样透传（页码只有排版后才知道），
// 渲染层拆成 PAGEREF 域；validator 用同一正则查悬空/目标类型
const PAGEREF_RE = /\{\{pageRef:([^}]+)\}\}/g;
const { parseLatex } = require("./math-latex");

const DEFAULT_SPACING = { line: 360, after: 0 };

// A4 页宽（twips）；渲染层不设纸张尺寸时 docx 库默认就是 A4
const A4_WIDTH = 11906;
const A4_HEIGHT = 16838;

/** 长度 → twips：数字原样，"2.54cm"/"25mm"/"1in" 换算，认不出返回 null */
const toTwips = (v) => {
  if (typeof v === "number") return v;
  if (typeof v !== "string") return null;
  const m = v.trim().match(/^([\d.]+)\s*(cm|mm|in)$/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  return Math.round(n * { cm: 567, mm: 56.7, in: 1440 }[m[2]]);
};

const DEFAULT_META = {
  headerText: "",      // 页眉右侧文字，空字符串则整份文档无页眉
  headerSize: 18,      // 页眉字号（半磅值，18 = 9pt）
  headerImage: null,   // 页眉 logo：{ src, width?, height? }（px）——logo 靠左，headerText 靠右
  footerImage: null,   // 页脚图片：{ src, width?, height? }（px）——图靠左，页码靠右
  pageNumber: true,    // 页脚"第x页 共x页"
  titlePage: true,     // 首页（封面）不显示页眉页脚
  landscape: false,    // 页面横向
  margins: { top: "2.54cm", right: "3.17cm", bottom: "2.54cm", left: "3.17cm" },
  imagesDir: ".",      // 图片根目录，节点里的相对 src 基于它解析
  font: "宋体",
};

// meta.docProps 白名单：docx 文件属性（Word「文件-信息」面板可见）
const DOC_PROPS_KEYS = ["title", "subject", "creator", "keywords", "description", "lastModifiedBy"];

const warn = (msg) => console.warn(`[docxUtil] ${msg}`);

// 分栏默认栏间距（twips）：Word 默认 720，preset/meta 未给时兜底
const DEFAULT_COLUMN_SPACE = 720;

/** columns: N | { count, space?, separator? } → 归一 { count, space, separator } | null（count<=1 视为单栏 null） */
const normalizeColumns = (c) => {
  if (c === undefined || c === null) return null;
  if (typeof c === "number") return c > 1 ? { count: c, space: DEFAULT_COLUMN_SPACE, separator: false } : null;
  if (typeof c === "object" && typeof c.count === "number" && c.count > 1) {
    return { count: c.count, space: toTwips(c.space) ?? DEFAULT_COLUMN_SPACE, separator: c.separator === true };
  }
  return null;
};

/**
 * 版心宽度（twips）：页宽减左右边距，多栏时再除成栏宽（内容按栏排）。
 * 校验器/服务层复用同一口径查表格超宽、算图片缩放上限。
 * 接受 meta 或某一节的有效 config（都带 landscape/margins，config 另带 columns）。
 */
const contentWidthOf = (cfg = {}) => {
  const pageWidth = cfg.landscape ? A4_HEIGHT : A4_WIDTH;
  const inner = pageWidth
    - (toTwips(cfg.margins && cfg.margins.left) ?? toTwips(DEFAULT_META.margins.left))
    - (toTwips(cfg.margins && cfg.margins.right) ?? toTwips(DEFAULT_META.margins.right));
  const cols = normalizeColumns(cfg.columns);
  if (cols) return Math.floor((inner - cols.space * (cols.count - 1)) / cols.count);
  return inner;
};

// 页码格式白名单：def 字符串 → docx NumberFormat（非法值校验层已报，渲染兜底忽略）
const PAGE_NUMBER_FORMATS = {
  decimal: NumberFormat.DECIMAL,
  lowerRoman: NumberFormat.LOWER_ROMAN,
  upperRoman: NumberFormat.UPPER_ROMAN,
};

// 分节继承模型（非累积）：每节有效配置 = doc meta（三层合并后）+ 本 sectionBreak
// 自身字段覆盖。空 sectionBreak 即回到文档基准，不延续上一节的覆盖——声明式，
// 渲染层每节据此显式落 header/footer，不靠 OOXML 缺省继承。
// isFirst：首节（首个 sectionBreak 之前的内容）titlePage 走 meta（封面语义只作用第一节）；
// 后续节 titlePage 默认 false（否则每节首页页眉被吞），sectionBreak 显式给才生效。
const sectionConfigOf = (meta, breakNode, isFirst) => {
  const b = breakNode || {};
  const pick = (k) => (b[k] !== undefined ? b[k] : meta[k]);
  return {
    landscape: pick("landscape"),
    margins: b.margins || meta.margins,
    columns: b.columns, // 只从节点取：meta 无分栏语义（首节 b={} → 单栏）
    headerText: pick("headerText"),
    headerImage: pick("headerImage"),
    footerImage: pick("footerImage"),
    pageNumber: pick("pageNumber"),
    pageNumberStart: b.pageNumberStart, // 仅节点显式给才重启，不继承
    pageNumberFormat: b.pageNumberFormat,
    breakType: b.breakType || "nextPage",
    titlePage: b.titlePage !== undefined ? b.titlePage : (isFirst ? meta.titlePage : false),
    // 样式参数不做节级覆盖，统一走 meta/preset
    headerSize: meta.headerSize,
    font: meta.font,
  };
};

// ---------------------------------------------------------------- styles

// 样式必须带 name：docx 库不给 name 就不写 <w:name>，Word 容忍，
// LibreOffice/WPS 按 name 映射样式，缺了整条样式作废（pStyle 悬空还会
// 触发表格/编号布局崩坏）
const namedStyle = (s) => ({ name: s.id, ...s });

const buildStyles = (meta) => {
  const font = meta.font;
  const styles = {
    default: {
      heading1: {
        run: { size: 30, bold: true, font },
        paragraph: { spacing: { before: 156, after: 312 } },
      },
      heading2: {
        run: { size: 28, bold: true, font },
        paragraph: { spacing: { before: 120, after: 120 } },
      },
      heading3: {
        run: { size: 24, bold: true, font },
        paragraph: { spacing: { before: 120, after: 120 } },
      },
    },
    paragraphStyles: [{
      // 正文：小四宋体、首行缩进、两端对齐、1.5 倍行距
      id: "normalParagraph",
      basedOn: "Normal",
      next: "Normal",
      run: { color: "000000", font, size: 24 },
      paragraph: {
        // 425 twips = 0.75cm。样式里的 universal measure 字符串（"0.75cm"）
        // Word 认、LibreOffice/WPS 不认，一律写数值
        indent: { firstLine: 425 },
        spacing: DEFAULT_SPACING,
        alignment: AlignmentType.JUSTIFIED,
      },
    }, {
      // 封面主标题用
      id: "ParagraphTitle",
      basedOn: "Normal",
      next: "Normal",
      run: { color: "000000", font: "方正小标宋简体", size: 30 },
      paragraph: { spacing: { line: 360 } },
    }],
  };
  if (meta.styles) {
    if (meta.styles.default) Object.assign(styles.default, meta.styles.default);
    if (Array.isArray(meta.styles.paragraphStyles)) {
      for (const ps of meta.styles.paragraphStyles) {
        const idx = styles.paragraphStyles.findIndex((d) => d.id === ps.id);
        if (idx >= 0) styles.paragraphStyles[idx] = ps;
        else styles.paragraphStyles.push(ps);
      }
    }
    // 字符样式（行内代码等 run 级样式引用）没有内置项，直接透传
    if (Array.isArray(meta.styles.characterStyles)) {
      styles.characterStyles = meta.styles.characterStyles.map(namedStyle);
    }
  }
  // 原生多级编号：标题样式挂 numPr（样式级绑定——Word 里新打的 Heading 段落
  // 自动续号）。放在 meta.styles 合并之后，用户覆盖标题字体不会洗掉编号
  if (meta.headingNumbering && Array.isArray(meta.headingNumbering.levels)) {
    const ref = meta.headingNumbering.reference || "heading-num";
    meta.headingNumbering.levels.slice(0, 6).forEach((lvl, i) => {
      const key = `heading${i + 1}`;
      const cur = styles.default[key] || {};
      styles.default[key] = {
        ...cur,
        paragraph: { ...(cur.paragraph || {}), numbering: { reference: ref, level: i } },
      };
    });
  }
  styles.paragraphStyles = styles.paragraphStyles.map(namedStyle);
  return styles;
};

// ---------------------------------------------------------------- 页眉页脚

// cfg：某一节的有效配置（sectionConfigOf 产物）或整份 meta（单节路径）。
// contentWidth：该节版心宽（多节时按节算），右制表位与页眉页脚图缩放上限都用它。
// forceExplicit：多节文档里每节都要显式落 header/footer reference，否则 Word 沿用上一节
//（缺省继承违背「每节 = meta + 自身覆盖」的非累积语义）——无内容时落空页眉页脚顶掉继承。
const buildHeaderFooter = (cfg, imagesDir = ".", contentWidth = null, forceExplicit = false) => {
  const imgCfg = (v) => (v && typeof v === "object" && typeof v.src === "string" && v.src ? v : null);
  const headerImage = imgCfg(cfg.headerImage);
  const footerImage = imgCfg(cfg.footerImage);
  if (contentWidth == null) contentWidth = contentWidthOf(cfg);
  const emptyHeader = () => new Header({ children: [new Paragraph({ children: [new TextRun("")] })] });
  const emptyFooter = () => new Footer({ children: [new Paragraph({ children: [new TextRun("")] })] });
  // 页眉页脚图读取失败跳过图片、保留文字，不让 logo 缺失毁掉整份渲染
  const imageRunOf = (icfg, slot) => {
    try {
      const { buf } = readImageSource(icfg.src, imagesDir);
      const { w, h } = scaleImage(buf, icfg.width, icfg.height, Math.floor(contentWidth / 15)); // 1px = 15 twips
      return new ImageRun({ data: buf, transformation: { width: w, height: h } });
    } catch (error) {
      warn(`${slot}图片读取失败: ${icfg.src} (${error.message})，已跳过`);
      return null;
    }
  };
  // 图 + 文字同段共存：图靠左，文字/页码经右制表位靠右
  const rightTab = { tabStops: [{ type: TabStopType.RIGHT, position: contentWidth }] };
  // 页码文本：常规节「第x页 共x页」（NUMPAGES 到处都渲染）。重启页码的节去掉「共x页」，
  // 只留「第x页」——SECTIONPAGES（节内总页）在 LibreOffice/WPS 不渲染（探针实测空白，
  // universal 不安全），而 NUMPAGES 文档总页对重启节是错觉（「第1页 共58页」）；前置页
  // （i/ii/iii）本就几乎不标总页，去掉反而更合排版惯例。
  const pageNumberRuns = (leadTab) => {
    const lead = leadTab ? [new Tab()] : [];
    if (cfg.pageNumberStart) {
      return [new TextRun({ children: [...lead, "第", PageNumber.CURRENT, "页"], size: cfg.headerSize, font: cfg.font })];
    }
    return [
      new TextRun({ children: [...lead, "第", PageNumber.CURRENT, "页 "], size: cfg.headerSize, font: cfg.font }),
      new TextRun({ children: ["共", PageNumber.TOTAL_PAGES, "页"], size: cfg.headerSize, font: cfg.font }),
    ];
  };
  const result = {};
  const headerLogo = headerImage ? imageRunOf(headerImage, "页眉") : null;
  if (cfg.headerText || headerLogo) {
    const children = [];
    if (headerLogo) children.push(headerLogo);
    if (cfg.headerText) {
      children.push(new TextRun({
        children: headerLogo ? [new Tab(), cfg.headerText] : [cfg.headerText],
        size: cfg.headerSize, font: cfg.font,
      }));
    }
    result.headers = {
      default: new Header({
        children: [new Paragraph({
          ...(headerLogo && cfg.headerText ? rightTab : { alignment: headerLogo ? AlignmentType.LEFT : AlignmentType.RIGHT }),
          children,
        })],
      }),
      first: emptyHeader(),
    };
  } else if (forceExplicit) {
    result.headers = { default: emptyHeader(), first: emptyHeader() };
  }
  const footerLogo = footerImage ? imageRunOf(footerImage, "页脚") : null;
  if (cfg.pageNumber || footerLogo) {
    const children = [];
    if (footerLogo) children.push(footerLogo);
    if (cfg.pageNumber) {
      children.push(...pageNumberRuns(!!footerLogo));
    }
    result.footers = {
      default: new Footer({
        children: [new Paragraph({
          ...(footerLogo && cfg.pageNumber ? rightTab : { alignment: footerLogo ? AlignmentType.LEFT : AlignmentType.RIGHT }),
          children,
        })],
      }),
      first: emptyFooter(),
    };
  } else if (forceExplicit) {
    result.footers = { default: emptyFooter(), first: emptyFooter() };
  }
  return result;
};

// ---------------------------------------------------------------- 编号

// 默认提供一套三级编号（1. / (2 / 3)），meta.numbering 里的 config 会追加进来
const buildNumbering = (meta) => {
  const config = [{
    reference: "default-numbering",
    levels: [
      { level: 0, format: LevelFormat.DECIMAL, text: "%1.", alignment: AlignmentType.LEFT },
      { level: 1, format: LevelFormat.DECIMAL, text: "(%2)", alignment: AlignmentType.LEFT },
      { level: 2, format: LevelFormat.DECIMAL, text: "%3)", alignment: AlignmentType.LEFT, suffix: LevelSuffix.NOTHING },
    ],
  }];
  if (meta.numbering && Array.isArray(meta.numbering.config)) {
    config.push(...meta.numbering.config);
  }
  // 原生多级编号的层级定义（buildStyles 把它挂到标题样式的 numPr 上）
  if (meta.headingNumbering && Array.isArray(meta.headingNumbering.levels)) {
    config.push({
      reference: meta.headingNumbering.reference || "heading-num",
      levels: meta.headingNumbering.levels,
    });
  }
  return { config };
};

// ---------------------------------------------------------------- 节点构建

/**
 * 文本段落。text 为数组时，每个元素是同一段落里的一个 run；
 * textOptions 也可以是数组，按下标与 text 对应。
 * textOptions.link：外链（http(s)/mailto）或内链（"#节点id"，跳到对应书签）；
 * 未显式给 style 时自动用 Hyperlink 字符样式——裸链接渲染成纯黑文字，看不出可点。
 * textOptions.footnote：脚注内容字符串，引用标记（上标编号）跟在该 run 末尾；
 * 编号由 fnAlloc 按出现顺序分配（report 传入；单独调 customText 时无脚注能力）。
 * textOptions.checkbox：true（未勾）| { checked: true }，在该 run 前插一个
 * w14:checkbox sdt——Word 里可点击勾选，LibreOffice/WPS 显示为符号（探针验证过）。
 * textOptions.comment：批注内容字符串，批注范围是该 run；id 由 cmAlloc 分配。
 * textOptions.math：true 时该 run 的 text 按 LaTeX 子集解析，渲染为行内 OMML
 *（与块级 math 节点同一解析器）；行内公式随文字排，不居中不独占段。
 * 文本里的 {{pageRef:节点id}} 拆成 PAGEREF 域（目标书签所在页码，可点跳转）；
 * 域无缓存内容，靠 features.updateFields 让 Word 打开时更新——WPS/LO 不理会
 * 显示空白，所以 pageRef 只在 meta.target:"word" 场景有意义（校验器把关）。
 * link / math run 里的 pageRef 不解析（超链接内嵌域、公式内嵌域都不成立）。
 */
const customText = (text, options = {}, paragraphOptions = {}, fnAlloc, cmAlloc) => {
  const paragraph = { children: [], spacing: DEFAULT_SPACING };
  const pushRun = (t, opt) => {
    const { link, footnote, checkbox, comment, math, ...rest } = opt || {};
    if (checkbox !== undefined && checkbox !== false) {
      paragraph.children.push(new CheckBox({ checked: !!(checkbox && checkbox.checked) }));
    }
    const commentId = comment !== undefined && cmAlloc ? cmAlloc(comment) : null;
    if (comment !== undefined && !cmAlloc) {
      warn("customText 独立调用不支持 comment，已忽略（走 report/saveReport 才有批注能力）");
    }
    if (commentId !== null) paragraph.children.push(new CommentRangeStart(commentId));
    if (math) {
      // OMML run 不吃 TextRun 样式选项；link 等其余字段忽略
      const { ast, warnings } = parseLatex(String(t));
      warnings.forEach((w) => warn(`math: ${w}`));
      paragraph.children.push(new DocxMath({ children: astToMath(ast) }));
    } else if (!link) {
      const parts = String(t).split(PAGEREF_RE); // 捕获组：奇数下标是目标节点 id
      if (parts.length === 1) {
        paragraph.children.push(new TextRun({ text: t, ...rest }));
      } else {
        parts.forEach((p, pi) => {
          if (pi % 2 === 1) paragraph.children.push(new PageReference(p, { hyperlink: true }));
          else if (p !== "") paragraph.children.push(new TextRun({ text: p, ...rest }));
        });
      }
    } else {
      const run = new TextRun({ text: t, style: "Hyperlink", ...rest });
      paragraph.children.push(String(link).startsWith("#")
        ? new InternalHyperlink({ anchor: String(link).slice(1), children: [run] })
        : new ExternalHyperlink({ link, children: [run] }));
    }
    if (commentId !== null) {
      paragraph.children.push(new CommentRangeEnd(commentId));
      paragraph.children.push(new TextRun({ children: [new CommentReference(commentId)] }));
    }
    if (footnote !== undefined) {
      if (fnAlloc) paragraph.children.push(new FootnoteReferenceRun(fnAlloc(footnote)));
      else warn("customText 独立调用不支持 footnote，已忽略（走 report/saveReport 才有脚注能力）");
    }
  };
  if (Array.isArray(text)) {
    text.forEach((t, i) => {
      const opt = Array.isArray(options) ? (options[i] || {}) : options;
      pushRun(t, opt);
    });
  } else {
    pushRun(text, Array.isArray(options) ? (options[0] || {}) : options);
  }
  Object.assign(paragraph, paragraphOptions);
  return new Paragraph(paragraph);
};

/**
 * 标题。level 1~3 有默认样式（见 buildStyles）。默认 keepNext，避免标题落在页底。
 * bookmarkId：以节点 id 打书签，正文 textOptions.link:"#id" 的内链靠它跳转。
 */
let standaloneBookmarkNumericId = 0;

const customHeading = (text, level = 1, paragraphOptions = {}, bookmarkId, bookmarkNumericId) => {
  const headingKey = `HEADING_${level}`;
  if (!HeadingLevel[headingKey]) {
    warn(`heading level ${level} 不存在，按 1 级处理`);
  }
  const run = new TextRun(String(text));
  const linkId = bookmarkNumericId || ++standaloneBookmarkNumericId;
  const children = bookmarkId
    ? [new BookmarkStart(bookmarkId, linkId), run, new BookmarkEnd(linkId)]
    : [run];
  return new Paragraph({
    heading: HeadingLevel[headingKey] || HeadingLevel.HEADING_1,
    children,
    keepNext: true,
    ...paragraphOptions,
  });
};

// base64 图片直传上限：不落盘、直接进 docx 包，超限占位 + warn
const BASE64_IMAGE_LIMIT = 5 * 1024 * 1024;

/** 图片来源统一读取：data:base64 直传或本地路径（相对 imagesDir） */
const readImageSource = (src, imagesDir) => {
  if (/^https?:\/\//i.test(src)) {
    // URL 抓取在服务层（meta.fetchUrlImages opt-in），渲染层保持离线
    throw new Error("URL 图片未抓取（meta.fetchUrlImages:true 渲染时抓取转 base64）");
  }
  if (/^data:image\/[a-z+]+;base64,/i.test(src)) {
    const buf = Buffer.from(src.slice(src.indexOf(",") + 1), "base64");
    if (buf.length > BASE64_IMAGE_LIMIT) throw new Error(`base64 图片超过 ${BASE64_IMAGE_LIMIT / 1024 / 1024}MB 上限`);
    return { buf, label: "base64 图片" };
  }
  const filePath = path.isAbsolute(src) ? src : path.resolve(imagesDir, src);
  return { buf: fs.readFileSync(filePath), label: filePath };
};

/**
 * 图片显示尺寸（px）：width/height 可省略——读原图等比缩放，超 maxWidthPx
 * 缩到 maxWidthPx；只给一边按原图比例补另一边
 */
const scaleImage = (buf, width, height, maxWidthPx) => {
  let w = width;
  let h = height;
  if (!w || !h) {
    const dim = require("image-size").imageSize(buf);
    const ratio = dim.width / dim.height;
    if (w && !h) h = Math.round(w / ratio);
    else if (h && !w) w = Math.round(h * ratio);
    else {
      w = dim.width;
      h = dim.height;
      if (maxWidthPx && w > maxWidthPx) {
        h = Math.round((h * maxWidthPx) / w);
        w = maxWidthPx;
      }
    }
  }
  return { w, h };
};

/**
 * 图片段落。src 可以是单个路径、data:image/...;base64 直传，或数组（同一段落排多张）。
 * 相对路径基于 imagesDir 解析；文件缺失输出占位文字，不中断。
 * width/height 可省略：读原图尺寸等比缩放，超版心宽缩到版心（maxWidthPx）；
 * 只给一边则按原图比例补另一边。
 * otherChildren: { left: {text}, center: {text} } 在图片左侧/两图之间插文字。
 */
const normalImage = (srcList, width, height, imagesDir, otherChildren, paragraphOptions = {}, maxWidthPx = null) => {
  const children = [];
  const pushImage = (src) => {
    let label = src;
    try {
      const read = readImageSource(src, imagesDir);
      label = read.label;
      const { w, h } = scaleImage(read.buf, width, height, maxWidthPx);
      children.push(new ImageRun({ data: read.buf, transformation: { width: w, height: h } }));
    } catch (error) {
      warn(`图片读取失败: ${label} (${error.message})`);
      children.push(new TextRun({ text: `[图片缺失: ${typeof src === "string" && src.startsWith("data:") ? "base64 图片" : src}]` }));
    }
  };
  if (otherChildren && otherChildren.left) {
    children.push(new TextRun({ text: otherChildren.left.text }));
  }
  pushImage(srcList[0]);
  if (srcList.length > 1) {
    if (otherChildren && otherChildren.center) {
      children.push(new TextRun({ text: otherChildren.center.text }));
    }
    for (let i = 1; i < srcList.length; i++) pushImage(srcList[i]);
  }
  // 图片段落不设行距：LibreOffice/WPS 把 w:line 当固定行高，比行高高的
  // 图会被裁成一条（2026-07-07 实测）；Word 虽按 auto 撑开但也没必要带
  return new Paragraph({ children, ...paragraphOptions });
};

// ---------------------------------------------------------------- 浮动图片

const PX_TO_EMU = 9525; // 96dpi：1px = 9525 EMU（浮动定位/间距用 EMU，与 transformation 的 px 不同）
const FLOAT_WRAPS = {
  square: { type: TextWrappingType.SQUARE, side: TextWrappingSide.BOTH_SIDES },
  tight: { type: TextWrappingType.TIGHT, side: TextWrappingSide.BOTH_SIDES },
  topAndBottom: { type: TextWrappingType.TOP_AND_BOTTOM },
  behind: { type: TextWrappingType.NONE },
  inFront: { type: TextWrappingType.NONE },
};
const FLOAT_H_REL = {
  margin: HorizontalPositionRelativeFrom.MARGIN,
  page: HorizontalPositionRelativeFrom.PAGE,
  column: HorizontalPositionRelativeFrom.COLUMN,
};
const FLOAT_V_REL = {
  margin: VerticalPositionRelativeFrom.MARGIN,
  page: VerticalPositionRelativeFrom.PAGE,
  paragraph: VerticalPositionRelativeFrom.PARAGRAPH,
};

/** image.float → docx IFloating。非法枚举回退默认（校验层已 warn，这里兜底不炸） */
const buildFloating = (f) => {
  const wrapKey = FLOAT_WRAPS[f.wrap] ? f.wrap : "square";
  const h = f.horizontal !== undefined ? f.horizontal : "right";
  const v = f.vertical !== undefined ? f.vertical : { offset: 0, relative: "paragraph" };
  const horizontalPosition = typeof h === "string"
    ? { relative: HorizontalPositionRelativeFrom.MARGIN, align: ["left", "center", "right"].includes(h) ? h : "right" }
    : { relative: FLOAT_H_REL[h.relative] || HorizontalPositionRelativeFrom.MARGIN,
        offset: Math.round((typeof h.offset === "number" ? h.offset : 0) * PX_TO_EMU) };
  const verticalPosition = typeof v === "string"
    ? { relative: VerticalPositionRelativeFrom.MARGIN, align: ["top", "center", "bottom"].includes(v) ? v : "top" }
    : { relative: FLOAT_V_REL[v.relative] || VerticalPositionRelativeFrom.PARAGRAPH,
        offset: Math.round((typeof v.offset === "number" ? v.offset : 0) * PX_TO_EMU) };
  const dist = Math.round((typeof f.distance === "number" && f.distance >= 0 ? f.distance : 12) * PX_TO_EMU);
  return {
    horizontalPosition,
    verticalPosition,
    wrap: { ...FLOAT_WRAPS[wrapKey], margins: { distT: dist, distB: dist, distL: dist, distR: dist } },
    margins: { top: dist, bottom: dist, left: dist, right: dist },
    ...(wrapKey === "behind" ? { behindDocument: true } : {}),
  };
};

/**
 * 浮动图片段落：图片锚定在一个空段落上，正文按 wrap 方式绕排。
 * 只支持单图；paragraphOptions 作用于锚点段落本身（一般不需要）。
 */
const floatImage = (src, width, height, imagesDir, float, maxWidthPx = null, paragraphOptions = {}) => {
  try {
    const read = readImageSource(src, imagesDir);
    const { w, h } = scaleImage(read.buf, width, height, maxWidthPx);
    return new Paragraph({
      children: [new ImageRun({
        data: read.buf,
        transformation: { width: w, height: h },
        floating: buildFloating(float),
      })],
      ...paragraphOptions,
    });
  } catch (error) {
    warn(`浮动图片读取失败: ${typeof src === "string" && !src.startsWith("data:") ? src : "base64 图片"} (${error.message})`);
    return new Paragraph({ children: [new TextRun({ text: `[图片缺失: ${typeof src === "string" && !src.startsWith("data:") ? src : "base64 图片"}]` })], ...paragraphOptions });
  }
};

// ---------------------------------------------------------------- 数学公式

// docx@8.5 没有 m:acc/m:bar/m:nary(通用)/m:m 组件（见 docs/upstream-issues.md），
// 用 ImportedXmlComponent 自拼：mathEl 建带子组件的元素（子组件可以是 MathRun
// 等正常组件，嵌套照常工作），mathRawEl 解析属性型叶子片段（fromXmlString 返回
// 的是包了一层的容器，root[0] 才是目标元素）。xmlns:m 由 document 根声明，不重复带
const mathEl = (tag, ...children) => {
  const el = new ImportedXmlComponent(tag);
  for (const c of children) el.push(c);
  return el;
};
const mathRawEl = (xml) => ImportedXmlComponent.fromXmlString(xml).root[0];

/** 公式 AST（math-latex.js）→ docx Math 组件数组。相邻文本合并成一个 run */
const astToMath = (nodes) => {
  const out = [];
  let buf = "";
  const flush = () => { if (buf) { out.push(new MathRun(buf)); buf = ""; } };
  for (const n of nodes || []) {
    switch (n.t) {
      case "run": buf += n.text; break;
      case "group": flush(); out.push(...astToMath(n.body)); break;
      case "frac": flush(); out.push(new MathFraction({ numerator: astToMath(n.num), denominator: astToMath(n.den) })); break;
      case "sqrt": flush(); out.push(new MathRadical({ children: astToMath(n.body), ...(n.degree ? { degree: astToMath(n.degree) } : {}) })); break;
      case "sum": flush(); out.push(new MathSum({
        children: astToMath(n.body),
        ...(n.sub ? { subScript: astToMath(n.sub) } : {}),
        ...(n.sup ? { superScript: astToMath(n.sup) } : {}),
      })); break;
      case "nary": flush(); out.push(mathEl("m:nary",
        // CT_NaryPr 顺序：chr → limLoc → subHide/supHide；缺上下限时置 hide，
        // 否则 Word 渲染空占位框
        mathRawEl(`<m:naryPr><m:chr m:val="${n.chr}"/><m:limLoc m:val="${n.limLoc}"/>`
          + (n.sub ? "" : '<m:subHide m:val="1"/>')
          + (n.sup ? "" : '<m:supHide m:val="1"/>')
          + "</m:naryPr>"),
        ...(n.sub ? [mathEl("m:sub", ...astToMath(n.sub))] : []),
        ...(n.sup ? [mathEl("m:sup", ...astToMath(n.sup))] : []),
        mathEl("m:e", ...astToMath(n.body)),
      )); break;
      case "acc": flush(); out.push(mathEl("m:acc",
        mathRawEl(`<m:accPr><m:chr m:val="${n.chr}"/></m:accPr>`),
        mathEl("m:e", ...astToMath(n.body)),
      )); break;
      case "bar": flush(); out.push(mathEl("m:bar",
        mathRawEl(`<m:barPr><m:pos m:val="${n.pos}"/></m:barPr>`),
        mathEl("m:e", ...astToMath(n.body)),
      )); break;
      case "matrix": {
        flush();
        const mm = mathEl("m:m",
          ...n.rows.map((r) => mathEl("m:mr", ...r.map((c) => mathEl("m:e", ...astToMath(c))))));
        // 带定界符的环境包一层 m:d（定界符随矩阵高度拉伸）
        out.push(n.delim
          ? mathEl("m:d",
              mathRawEl(`<m:dPr><m:begChr m:val="${n.delim[0]}"/><m:endChr m:val="${n.delim[1]}"/></m:dPr>`),
              mathEl("m:e", mm))
          : mm);
        break;
      }
      case "sup": flush(); out.push(new MathSuperScript({ children: astToMath(n.base), superScript: astToMath(n.script) })); break;
      case "sub": flush(); out.push(new MathSubScript({ children: astToMath(n.base), subScript: astToMath(n.script) })); break;
      case "subsup": flush(); out.push(new MathSubSuperScript({ children: astToMath(n.base), subScript: astToMath(n.sub), superScript: astToMath(n.sup) })); break;
      default: break;
    }
  }
  flush();
  return out;
};

/** 块级公式段落。中文排版惯例居中，paragraphOptions 可覆盖 */
const customMath = (latex, paragraphOptions = {}) => {
  const { ast, warnings } = parseLatex(latex);
  warnings.forEach((w) => warn(`math: ${w}`));
  return new Paragraph({
    children: [new DocxMath({ children: astToMath(ast) })],
    alignment: AlignmentType.CENTER,
    spacing: DEFAULT_SPACING,
    ...paragraphOptions,
  });
};

const newPage = () => new Paragraph({ children: [new PageBreak()] });

const blankLine = (paragraphOptions = {}) =>
  new Paragraph({ children: [new TextRun("")], spacing: DEFAULT_SPACING, ...paragraphOptions });

/**
 * 表格。
 * data: [{ texts, textOptions, paragraphOptions, cellOptions }]
 *   - texts 里的元素是 string（单行）、string[]（格内多段），或对象
 *     { text, textOptions?, paragraphOptions? }——单格级样式，盖过行级
 *   - 使用 rowSpan 时，被合并覆盖的行直接省略对应格子（docx 的规则）
 * tableOptions:
 *   - span: { 行号: {spanType:'rowSpan'|'columnSpan', spanCounts, cNo:[列号]} | [...] }
 *   - images: { 行号: [{ type:'image'|'text', cNo:[列号], ... }] } 往指定格子追加内容
 *   - headerRows: 前 N 行是表头——跨页时重复显示（w:tblHeader），
 *     且作为 tableStyle 表头样式（headerTextOptions/headerFill 等）的作用范围
 *   - keepTogether: 小表整体不拆页（除末行外全部段落打 keepNext；
 *     表格高过一页时查看器自动放弃约束照常拆）
 *   - rOptions / tOptions: 透传给 TableRow / Table
 * tableStyle（meta.tableStyle，参数活在 preset）：
 *   { headerTextOptions, headerParagraphOptions, headerFill,
 *     cellMargins, rowHeight, borders }——行/节点级选项优先于它
 * 注意：表内有 span 时不给 cell 单独设宽（宽度交给 columnWidths），
 *       否则被合并省略的行会导致列宽错位——沿用 docxUtil2 的处理。
 */
const customTable = (tableData, columnWidths, tableOptions = {}, imagesDir = ".", contentWidth = null, tableStyle = {}) => {
  // 不给列宽时按版心宽度等分补真实列宽。曾试过 pct 100% 方案：docx 库会写出
  // gridCol=100twips 的假网格，单元格一旦带 pStyle，LibreOffice/WPS 按假网格
  // 硬排，表格塌成细缝——必须给真实 DXA 网格
  if (!Array.isArray(columnWidths) && contentWidth) {
    const colCount = Math.max(0, ...tableData.map((r) => (r && Array.isArray(r.texts) ? r.texts.length : 0)));
    if (colCount > 0) columnWidths = new Array(colCount).fill(Math.floor(contentWidth / colCount));
  }
  const span = tableOptions.span || {};
  const images = tableOptions.images || {};
  const headerRows = tableOptions.headerRows || 0;
  const { rOptions, tOptions } = tableOptions;
  const hasSpan = Object.keys(span).length > 0;
  // 表头默认样式打底、行级选项盖上（数组形态逐项合并）
  const mergeOpt = (base, opt) => {
    if (!base) return opt;
    if (Array.isArray(opt)) return opt.map((o) => ({ ...base, ...(o || {}) }));
    return { ...base, ...(opt || {}) };
  };
  const rows = [];
  for (let i = 0; i < tableData.length; i++) {
    const rowD = tableData[i];
    const isHeader = i < headerRows;
    const textOptions = isHeader ? mergeOpt(tableStyle.headerTextOptions, rowD.textOptions) : rowD.textOptions;
    let paragraphOptions = isHeader
      ? mergeOpt(tableStyle.headerParagraphOptions, rowD.paragraphOptions) : rowD.paragraphOptions;
    // keepTogether：表格本身没有整体 keep 属性，惯例是给除末行外所有行的
    // 段落打 keepNext——小表整体粘住不拆页；表格高过一页时 Word/LO 自动
    // 放弃 keep 约束照常拆，"大表"由 caption keepNext + headerRows 兜底
    if (tableOptions.keepTogether && i < tableData.length - 1) {
      paragraphOptions = mergeOpt({ keepNext: true }, paragraphOptions);
    }
    const rowChildren = [];
    for (let j = 0; j < rowD.texts.length; j++) {
      let cellD = rowD.texts[j];
      // 单格级样式：对象格拆出 text，样式在行级（含表头打底）之上再盖一层
      let cellTO = textOptions;
      let cellPO = paragraphOptions;
      if (cellD && typeof cellD === "object" && !Array.isArray(cellD)) {
        if (cellD.textOptions) cellTO = mergeOpt(Array.isArray(cellTO) ? undefined : cellTO, cellD.textOptions);
        if (cellD.paragraphOptions) cellPO = mergeOpt(Array.isArray(cellPO) ? undefined : cellPO, cellD.paragraphOptions);
        cellD = cellD.text;
      }
      const tbCell = { children: [], verticalAlign: VerticalAlign.CENTER, borders: {} };
      if (isHeader && tableStyle.headerFill) tbCell.shading = { fill: tableStyle.headerFill };
      if (tableStyle.cellMargins) tbCell.margins = { ...tableStyle.cellMargins };
      if (cellD !== undefined && cellD !== null) {
        if (Array.isArray(cellD)) {
          cellD.forEach((d, di) => {
            const to = Array.isArray(cellTO) ? cellTO[di] : cellTO;
            const po = Array.isArray(cellPO) ? cellPO[di] : cellPO;
            tbCell.children.push(customText(d, to, po));
          });
        } else {
          tbCell.children.push(customText(cellD, cellTO, cellPO));
        }
      } else if (tableOptions.keepTogether && i < tableData.length - 1) {
        // 空格子默认由 docx 库补无属性空段——keepTogether 下会留下没有
        // keepNext 的洞，允许在该行后断页，这里补显式空段堵上
        tbCell.children.push(customText("", cellTO, cellPO));
      }
      if (Object.prototype.hasOwnProperty.call(span, i)) {
        const spanDefs = Array.isArray(span[i]) ? span[i] : [span[i]];
        spanDefs.forEach((d) => {
          if (d.cNo.indexOf(j) !== -1) tbCell[d.spanType] = d.spanCounts;
        });
      }
      if (Object.prototype.hasOwnProperty.call(images, i)) {
        images[i].forEach((d) => {
          // cNo 指定追加到哪些列，不给则整行每格都加（兼容旧数据，不推荐）
          if (Array.isArray(d.cNo) && d.cNo.indexOf(j) === -1) return;
          if (d.type === "image") {
            const srcs = Array.isArray(d.src) ? d.src : [d.src];
            tbCell.children.push(normalImage(srcs, d.width, d.height, imagesDir, d.otherChildren));
          } else if (d.type === "text") {
            tbCell.children.push(customText(d.text, d.textOptions, d.paragraphOptions));
          }
        });
      }
      if (rowD.cellOptions) {
        if (rowD.cellOptions.bordersColumns === j) tbCell.borders = rowD.cellOptions.borders;
        if (rowD.cellOptions.options) Object.assign(tbCell, rowD.cellOptions.options);
      }
      if (!hasSpan && Array.isArray(columnWidths)) {
        tbCell.width = { size: columnWidths[j], type: WidthType.DXA };
      }
      rowChildren.push(new TableCell(tbCell));
    }
    // 行默认 cantSplit：跨页时整行挪到下一页，不在行中间劈开（rOptions 可覆盖）
    rows.push(new TableRow({
      children: rowChildren,
      cantSplit: true,
      ...(isHeader ? { tableHeader: true } : {}),
      ...(tableStyle.rowHeight ? { height: { ...tableStyle.rowHeight } } : {}),
      ...rOptions,
    }));
  }
  const styleTableOpts = tableStyle.borders ? { borders: tableStyle.borders } : {};
  // tableOptions.alignment：表格窄于版心时的水平位置（"center" 等）
  const alignOpts = tableOptions.alignment ? { alignment: tableOptions.alignment } : {};
  if (Array.isArray(columnWidths)) {
    // 总宽必须显式给 + fixed 布局：docx 库默认 tblW auto，无 span 的表靠
    // 单元格 tcW 撑住侥幸正常；有 span 的表单元格不设宽（防合并行列宽
    // 错位），auto 布局下被 Word/LO 压缩挤成一团（2026-07-07 用户实测）
    const total = columnWidths.reduce((s, w) => s + w, 0);
    return new Table({
      columnWidths, rows,
      width: { size: total, type: WidthType.DXA },
      layout: TableLayoutType.FIXED,
      ...styleTableOpts, ...alignOpts, ...tOptions,
    });
  }
  // 走到这里说明既没有列宽也没有版心宽度可推（不该发生），保底 pct 铺满
  return new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows, ...styleTableOpts, ...alignOpts, ...tOptions });
};

// ---------------------------------------------------------------- 主入口

/**
 * 构建 Document。
 * def: { meta, contexts }，节点规范见 docxUtil-spec.md
 * opts.baseDir: meta.imagesDir 为相对路径时的解析基准，默认 cwd
 */
const report = (def = {}, opts = {}) => {
  const meta = { ...DEFAULT_META, ...(def.meta || {}) };
  const baseDir = opts.baseDir || process.cwd();
  const imagesDir = path.isAbsolute(meta.imagesDir)
    ? meta.imagesDir
    : path.resolve(baseDir, meta.imagesDir);
  const contexts = def.contexts || [];
  // 脚注编号按正文出现顺序分配，LLM 不碰编号（与 autoNumber 同一哲学）
  const footnotes = {};
  let footnoteN = 0;
  const fnAlloc = (content) => {
    footnoteN++;
    footnotes[footnoteN] = { children: [new Paragraph({ children: [new TextRun(String(content))] })] };
    return footnoteN;
  };
  // 批注 id 同样按出现顺序分配；作者统一走 meta.commentAuthor（三层合并可覆盖）
  const comments = [];
  const cmAlloc = (content) => {
    const id = comments.length;
    comments.push({
      id, author: meta.commentAuthor, date: new Date(),
      children: [new Paragraph({ children: [new TextRun(String(content))] })],
    });
    return id;
  };
  // 按 sectionBreak 平铺分隔节点切桶：每桶 = { config, children }。首桶（首个
  // sectionBreak 之前）走 meta 基准；每遇 sectionBreak 开新桶，据 meta + 该节点覆盖
  // 定有效配置（非累积继承）。无 sectionBreak 的旧文档 = 单桶，行为完全不变。
  const buckets = [{ config: sectionConfigOf(meta, null, true), children: [] }];
  let cur = buckets[0];
  let curCW = contentWidthOf(cur.config);
  let bookmarkNumericId = 0;

  for (let i = 0; i < contexts.length; i++) {
    const node = contexts[i];
    if (node.type === "sectionBreak") {
      cur = { config: sectionConfigOf(meta, node, false), children: [] };
      buckets.push(cur);
      curCW = contentWidthOf(cur.config);
      continue;
    }
    // image/table 的书签打在 body 级（bookmarkStart/End 是 EG_RunLevelElts，
    // 块级合法）——内链和 pageRef 靠它定位；heading 的书签在段内（历史实现）
    const pushBookmarked = (element) => {
      if (node.id) {
        bookmarkNumericId++;
        cur.children.push(new BookmarkStart(node.id, bookmarkNumericId));
        cur.children.push(element);
        cur.children.push(new BookmarkEnd(bookmarkNumericId));
      } else {
        cur.children.push(element);
      }
    };
    switch (node.type) {
      case "text":
        cur.children.push(customText(node.text, node.textOptions, node.paragraphOptions, fnAlloc, cmAlloc));
        break;
      case "heading":
        bookmarkNumericId++;
        cur.children.push(customHeading(node.text, node.level, node.paragraphOptions, node.id, bookmarkNumericId));
        break;
      case "image": {
        const srcs = Array.isArray(node.src) ? node.src : [node.src];
        // 版心宽换算 px（docx 的图片 transformation 按 96dpi：1px = 15 twips）
        if (node.float && typeof node.float === "object") {
          // 浮动图只取第一张（多图校验层已 warn）；缩放上限仍按版心兜底
          pushBookmarked(floatImage(srcs[0], node.width, node.height, imagesDir,
            node.float, Math.floor(curCW / 15), node.paragraphOptions));
        } else {
          pushBookmarked(normalImage(srcs, node.width, node.height, imagesDir,
            node.otherChildren, node.paragraphOptions, Math.floor(curCW / 15)));
        }
        break;
      }
      case "table":
        pushBookmarked(customTable(
          node.data,
          node.columnWidths || node.columnsWith, // columnsWith 是旧版拼写
          node.tableOptions || {},
          imagesDir,
          curCW,
          meta.tableStyle || {},
        ));
        break;
      case "math":
        cur.children.push(customMath(node.latex, node.paragraphOptions));
        break;
      case "newPage":
        cur.children.push(newPage());
        break;
      case "toc":
        // Word 原生目录域：无缓存内容，页码靠打开文档时更新域生成
        //（下方 features.updateFields 让 Word 打开即提示；WPS/LibreOffice 不理会，显示空白）
        cur.children.push(new TableOfContents(node.title || "目录", {
          hyperlink: true,
          headingStyleRange: `1-${node.maxLevel || 3}`,
        }));
        break;
      case "blank":
      case "Paragraph": // 旧版别名：空白行
        cur.children.push(blankLine(node.paragraphOptions));
        break;
      default:
        warn(`未知节点类型 "${node.type}"（第 ${i} 个节点），已跳过`);
    }
  }

  // 每桶 → 一个 docx section。首节不设 type（body 级 sectPr）；后续节的 breakType
  // 落在本节 sectPr 的 w:type，控制与前节的衔接方式（默认另起页）。
  const multiSection = buckets.length > 1;
  const sections = buckets.map((bucket, idx) => {
    const cfg = bucket.config;
    // pgMar 必须是整数 twips：ECMA-376 允许 "2.54cm" 这类 universal measure，
    // 但 Word 实现（[MS-OI29500]）不认，直接拒开文件；LibreOffice 能开所以容易漏测
    const margin = {};
    for (const side of ["top", "right", "bottom", "left"]) {
      margin[side] = toTwips(cfg.margins && cfg.margins[side]) ?? toTwips(DEFAULT_META.margins[side]);
    }
    const properties = { titlePage: !!cfg.titlePage, page: { margin } };
    if (cfg.landscape) properties.page.size = { orientation: PageOrientation.LANDSCAPE };
    if (idx > 0) properties.type = cfg.breakType;
    if (cfg.pageNumberStart || cfg.pageNumberFormat) {
      properties.page.pageNumbers = {};
      if (cfg.pageNumberStart) properties.page.pageNumbers.start = cfg.pageNumberStart;
      const fmt = cfg.pageNumberFormat && PAGE_NUMBER_FORMATS[cfg.pageNumberFormat];
      if (fmt) properties.page.pageNumbers.formatType = fmt;
    }
    const cols = normalizeColumns(cfg.columns);
    if (cols) {
      properties.column = { count: cols.count, space: cols.space, ...(cols.separator ? { separate: true } : {}) };
    }
    return {
      properties,
      ...buildHeaderFooter(cfg, imagesDir, contentWidthOf(cfg), multiSection),
      children: bucket.children,
    };
  });

  // 文档属性：白名单键透传（未知键服务层校验时已 warn，这里静默过滤兜底）
  const docProps = {};
  for (const k of DOC_PROPS_KEYS) {
    if (meta.docProps && typeof meta.docProps[k] === "string") docProps[k] = meta.docProps[k];
  }

  const hasToc = contexts.some((n) => n && n.type === "toc");
  const hasPageRef = contexts.some((n) => n && n.type === "text"
    && (Array.isArray(n.text) ? n.text : [n.text])
      .some((t) => typeof t === "string" && t.match(PAGEREF_RE)));
  return new Document({
    ...docProps,
    ...(hasToc || hasPageRef ? { features: { updateFields: true } } : {}),
    ...(footnoteN > 0 ? { footnotes } : {}),
    ...(comments.length > 0 ? { comments: { children: comments } } : {}),
    numbering: buildNumbering(meta),
    styles: buildStyles(meta),
    sections,
  });
};

// CT_RPr 子元素的合法顺序（ECMA-376 §17.3.2 sequence）。docx 库按自身硬编码
// 顺序 push（rFonts 排在 sz 之后、color 排在 u 之后），Word 打开时报「不可读取
// 的内容」要求修复（docs/upstream-issues.md #5），落盘前统一重排兜底
const RPR_CHILD_ORDER = [
  "w:rStyle", "w:rFonts", "w:b", "w:bCs", "w:i", "w:iCs", "w:caps", "w:smallCaps",
  "w:strike", "w:dstrike", "w:outline", "w:shadow", "w:emboss", "w:imprint",
  "w:noProof", "w:snapToGrid", "w:vanish", "w:webHidden", "w:color", "w:spacing",
  "w:w", "w:kern", "w:position", "w:sz", "w:szCs", "w:highlight", "w:u",
  "w:effect", "w:bdr", "w:shd", "w:fitText", "w:vertAlign", "w:rtl", "w:cs",
  "w:em", "w:lang", "w:eastAsianLayout", "w:specVanish", "w:oMath",
];

const reorderRPr = (xml) =>
  xml.replace(/<w:rPr>([\s\S]*?)<\/w:rPr>/g, (whole, inner) => {
    // rPr 子元素都是自闭合或无嵌套同名标签的简单元素，非贪婪逐个切安全
    const children = inner.match(/<w:([a-zA-Z]+)(?:\s[^>]*)?\/>|<w:([a-zA-Z]+)(?:\s[^>]*)?>[\s\S]*?<\/w:\2>/g);
    if (!children || children.join("") !== inner) return whole; // 切分对不上原文就不动，宁可保守
    const rank = (el) => {
      const tag = el.match(/^<(w:[a-zA-Z]+)/)[1];
      const i = RPR_CHILD_ORDER.indexOf(tag);
      return i === -1 ? RPR_CHILD_ORDER.length : i;
    };
    const sorted = children.map((el, i) => [el, i]).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]);
    return `<w:rPr>${sorted.map(([el]) => el).join("")}</w:rPr>`;
  });

/** Word 兼容后处理：对包内所有 wml part 做 docx 库产出的顺序修正 */
const fixWordCompat = async (buffer) => {
  const JSZip = require("jszip");
  const zip = await JSZip.loadAsync(buffer);
  const targets = Object.keys(zip.files).filter((n) => /^word\/[^/]+\.xml$/.test(n));
  for (const name of targets) {
    const xml = await zip.file(name).async("string");
    // "start"/"end" 是 strict 枚举，transitional Word 报「不可读取的内容」；
    // 样式包/用户 profile 都是外部输入，可能带进来，出口统一归一化
    const fixed = reorderRPr(xml)
      .replace(/(<w:(?:lvlJc|jc)[^>]* w:val=")start(")/g, "$1left$2")
      .replace(/(<w:(?:lvlJc|jc)[^>]* w:val=")end(")/g, "$1right$2");
    if (fixed !== xml) zip.file(name, fixed);
  }
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
};

/** 构建并写盘，返回 Promise<outPath>。 */
const saveReport = async (def, outPath, opts = {}) => {
  const buffer = await fixWordCompat(await Packer.toBuffer(report(def, opts)));
  fs.writeFileSync(outPath, buffer);
  return outPath;
};

module.exports = {
  report,
  saveReport,
  contentWidthOf, // 服务层校验表格超宽复用同一口径（可传节 config 带 columns）
  sectionConfigOf, // 校验器遍历时按节算有效版心复用
  normalizeColumns, // 分栏归一，校验器复用
  toTwips, // 长度→twips，校验器查 margins 合法性复用同一口径
  DOC_PROPS_KEYS, // 服务层校验 docProps 未知键复用同一份白名单
  RPR_CHILD_ORDER, // scripts/docx-validate.js 复用同一份顺序表
  PAGEREF_RE, // 校验器查 pageRef 悬空/目标类型复用同一正则
  fixWordCompat, // 模板填槽产物同样要过 Word 兼容后处理（template.js 复用）
  Packer,
  docx, // 透出整个命名空间（AlignmentType 等），report.js 不用自己 require docx
  // 单独暴露构建函数，方便以后包成 function call 逐个调用
  customText,
  customHeading,
  customTable,
  customMath,
  normalImage,
  floatImage,
  newPage,
  blankLine,
};

// ---------------------------------------------------------------- CLI
// 用法: node docxUtil.js render <report.js|report.json> [out.docx]
// report.js 需 module.exports 一个 { meta, contexts }，或返回它的函数
if (require.main === module) {
  const [cmd, defPath, outArg] = process.argv.slice(2);
  if (cmd !== "render" || !defPath) {
    console.log("用法: node docxUtil.js render <report.js|report.json> [out.docx]");
    process.exit(1);
  }
  const absDef = path.resolve(defPath);
  let def = require(absDef);
  if (typeof def === "function") def = def();
  const outPath = outArg
    ? path.resolve(outArg)
    : absDef.replace(/\.(js|json)$/, "") + ".docx";
  // 图片相对路径按 report 文件所在目录解析，符合直觉
  saveReport(def, outPath, { baseDir: path.dirname(absDef) })
    .then((p) => console.log(`已生成: ${p}`))
    .catch((e) => { console.error(e); process.exit(1); });
}
