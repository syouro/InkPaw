/**
 * examples.js — get_examples 工具的数据源：各类节点/字段的权威写法示例
 *
 * 用途：LLM 上下文长了记不清写法、或校验报错时，按主题取标准示例对着改。
 * 一致性保证：test/examples.test.js 把每个 def 示例过一遍校验器（0 issue）
 * 和渲染层（能构建 Document），示例错了测试就红——示例永远不和真实规则漂移。
 *
 * 每个主题：{ brief 一句话, usage 规则要点, example 可直接套用的片段, notes 易错点 }
 */

const EXAMPLES = {
  text: {
    brief: "正文段落：单串或多 run（textOptions 按下标对应）",
    usage: "text 为数组时每个元素是同段落里的一个 run，textOptions 也给数组按下标对应；单串则 textOptions 是单个对象。样式引用交给 preset（如 normalParagraph），不要手写字体字号。",
    example: {
      contexts: [
        { type: "text", text: "普通一段话。", paragraphOptions: { style: "normalParagraph" } },
        { type: "text",
          text: ["前半段，", "加粗强调", "，后半段。"],
          textOptions: [{}, { bold: true }, {}],
          paragraphOptions: { style: "normalParagraph" } },
      ],
    },
    notes: [
      "text 数组和 textOptions 数组长度要一致，空样式 run 用 {} 占位",
      "不要在 textOptions 里写死 font/size 调样式——样式活在 preset，正文发样式引用即可",
    ],
  },

  heading: {
    brief: "标题：level 1~3，autoNumber 开启时不要手写编号",
    usage: "autoNumber（preset 默认开）下 heading text 只写标题文字，编号由服务端按树位置生成（1 / 1.1 / 1.1.1）。层级要逐级递进，1 级后面不要直接跳 3 级。",
    example: {
      contexts: [
        { id: "h-overview", type: "heading", level: 1, text: "概述" },
        { id: "h-bg", type: "heading", level: 2, text: "背景" },
      ],
    },
    notes: [
      "错误写法：text: \"1. 概述\"——会双重编号（warn heading-manual-number）",
      "确实要手写编号：meta.autoNumber 设 false",
      "id 可以不给（服务端补），但要被 ref/内链引用时必须自己起（如 h-overview）",
    ],
  },

  table: {
    brief: "基础表格：data 行数组 + headerRows 表头 + 可选 columnWidths / caption",
    usage: "纯文本表格直接写二维数组：data: [[...], [...]]（number/boolean 单元格自动转字符串，服务端归一成行对象）。行需要样式/多段时用完整形 { texts: [...], textOptions?, paragraphOptions? }，两种行形可混用。各行格子数必须等于列数。columnWidths 不给则按版心宽度等分。caption 是表题（表格上方），autoNumber 下自动出「表N」。tableOptions.headerRows: N 标记前 N 行为表头：跨页时自动重复显示，且套用 preset 的表头样式（加粗居中等，meta.tableStyle 可覆盖）。tableOptions.keepTogether: true 让小表整体不拆页（高过一页的表自动放弃约束照常拆，配合 headerRows 跨页仍有表头）。",
    example: {
      contexts: [
        { id: "tbl-env", type: "table", caption: "环境参数",
          columnWidths: [2500, 3000, 2812],
          data: [
            ["类别", "项目", "说明"],
            ["环境", "温湿度", "箱内外"],
            ["结构", "温度", 50],
          ],
          tableOptions: { headerRows: 1 } },
      ],
    },
    notes: [
      "首选二维数组简写，手写 { texts: [...] } 最容易漏格错格",
      "整行样式：行对象的 textOptions（font/size/bold）+ paragraphOptions（alignment）；单格样式：格子写 { text: \"值\", textOptions: {...}, paragraphOptions: { alignment: \"center\" } }，格级盖行级",
      "columnWidths 单位是 twips，总和别超版心（A4 默认边距下约 8312）；拿不准就不给，服务端按版心等分",
      "窄表要居中给 tableOptions.alignment: \"center\"",
      "最常见 error：某行格子数 ≠ columnWidths 数（校验器会给行列坐标）",
      "表头不要手写 bold/居中——给 headerRows，样式由 preset 的 tableStyle 管（headerFill 底色、cellMargins 等也在那配）",
      "表题不要另起 text 节点，用 caption 字段（编号、keepNext 服务端管）",
    ],
  },

  "table-span": {
    brief: "合并单元格：tableOptions.span，被覆盖的格子必须省略",
    usage: "span: { \"行号\": 合并定义或数组 }。行号是字符串、从 0 计。spanType rowSpan（纵向）| columnSpan（横向），spanCounts 合并几格，cNo 该行内起始列号数组。写之前先在心里铺网格：每行「自带格子数 + 被上方 rowSpan 覆盖数」必须恰好等于列数。",
    example: {
      contexts: [
        { id: "tbl-merge", type: "table", caption: "合并示例",
          columnWidths: [2770, 2770, 2772],
          data: [
            { texts: ["汇总标题"], textOptions: { bold: true }, paragraphOptions: { alignment: "center" } },
            { texts: ["环境", "温度", "23℃"] },
            { texts: ["湿度", "45%"] },
          ],
          tableOptions: { span: {
            "0": { spanType: "columnSpan", spanCounts: 3, cNo: [0] },
            "1": { spanType: "rowSpan", spanCounts: 2, cNo: [0] },
          } } },
      ],
    },
    notes: [
      "行 0 横向合并 3 格 → 该行只写 1 个格子；行 1 的第 0 格纵向吞 2 行 → 行 2 只写 2 个格子（省略被覆盖的第 0 格）",
      "铺不平网格是 error（校验器按行报），改 texts 数量或 span 定义",
      "有 span 的表格不要给单格设宽，宽度只由 columnWidths 控制",
    ],
  },

  image: {
    brief: "图片：src 本地路径 / base64 / URL（需 opt-in），宽高可省略自动等比缩放",
    usage: "src 是本地路径（相对 meta.imagesDir 或绝对路径）、data:image/png;base64,...（≤5MB），或 http(s) URL（需 meta.fetchUrlImages:true，渲染时抓取转 base64 回写：10s 超时、≤5MB、MIME 白名单 png/jpeg/gif/bmp）。width/height 像素，**可省略**：读原图尺寸等比缩放，超版心宽自动缩到版心；只给一边按比例补另一边。带 caption 时图题在图下方，编号自动。文件缺失/抓取失败渲染为占位文字 + warn，不中断。可选 float（浮动定位，正文绕排）：{ wrap?: square(默认)/tight/topAndBottom/behind/inFront, horizontal?: left/center/right 或 { offset: px, relative?: margin/page/column }, vertical?: top/center/bottom 或 { offset: px, relative?: margin/page/paragraph（默认锚点段落）}, distance?: 图文间距 px（默认 12）}。",
    example: {
      meta: { imagesDir: "/data/report-images" },
      contexts: [
        { id: "img-arch", type: "image", src: "architecture.png",
          caption: "系统架构", paragraphOptions: { alignment: "center" } },
        { id: "img-side", type: "image", src: "chip.png", width: 160,
          float: { horizontal: "right" } },
        { type: "text", text: "右侧小图配文字的排版：正文自动绕排在浮动图左侧。" },
      ],
    },
    notes: [
      "【何时用 float】默认 inline（随文档流）适合绝大多数报告图。float 只在明确需要版式定位时用：右侧小图配文（产品图+说明）、页面角落 logo、衬底水印（wrap:behind）。普通的架构图/流程图/数据图表一律 inline + caption",
      "浮动图不占图号也不吃 caption（图题贴不住浮动图，{{ref:}} 也别指向它）；只支持单图",
      "不确定尺寸就别写 width/height——自动等比比手算安全（写死宽高比错了会拉伸变形）；浮动图建议显式给 width 控制占位",
      "URL 图默认不抓取（不拉网络），meta.fetchUrlImages:true 显式开启；抓到后 def 里就是 base64，不再拉网络",
    ],
  },

  ref: {
    brief: "交叉引用：{{ref:节点id}} 渲染为实际编号；{{pageRef:节点id}} 渲染为页码域（仅 target=word）",
    usage: "ref 指向 heading → 1.1，指向带 caption 的 table/image → 表2 / 图3。结构调整（插入/移动/提级）后编号级联更新，引用永不过期——所以正文里永远写 ref 不写死编号。pageRef 渲染为 Word 原生 PAGEREF 域（「见第 5 页」的 5，可点跳转），目标限 heading/image/table（书签打在这三类上）。",
    example: {
      meta: { target: "word" },
      contexts: [
        { id: "h-data", type: "heading", level: 1, text: "数据分析" },
        { id: "tbl-result", type: "table", caption: "结果汇总",
          data: [{ texts: ["指标", "数值"] }, { texts: ["良率", "98%"] }] },
        { type: "text", text: "详细数据见第 {{pageRef:tbl-result}} 页的 {{ref:tbl-result}}，分析方法见 {{ref:h-data}}。",
          paragraphOptions: { style: "normalParagraph" } },
      ],
    },
    notes: [
      "【何时用 pageRef】收件人确定用 Word 打开（meta.target:\"word\"）才用：页码是域，Word 打开时提示更新域后才显示，WPS/LibreOffice 一直空白。查看器不确定就只用 ref 编号引用——「见表2」不带页码在任何查看器都成立。",
      "ref 悬空（id 不存在）渲染为 [引用缺失:id] + warn，删节点前看 delete_nodes 返回的引用方警告",
      "autoNumber 关闭时 ref 无编号可解析，会渲染为占位 + warn；pageRef 与 autoNumber 无关（页码不是编号树的一部分）",
    ],
  },

  link: {
    brief: "超链接：textOptions.link——http(s)/mailto 外链，#节点id 内链",
    usage: "内链跳转到 heading/image/table（服务端自动打书签，目标限这三类）。链接自动带蓝色下划线样式，显式给 style 可覆盖。",
    example: {
      contexts: [
        { id: "h-detail", type: "heading", level: 1, text: "详细说明" },
        { type: "text",
          text: ["参考", "官方文档", "，详见", "详细说明", "章。"],
          textOptions: [{}, { link: "https://example.com/docs" }, {}, { link: "#h-detail" }, {}],
          paragraphOptions: { style: "normalParagraph" } },
      ],
    },
    notes: [
      "javascript:/data: 等协议是 error，只允许 http(s)/mailto/#内链",
      "内链目标必须是 heading（image/table 暂没有书签），否则 warn 且点了不跳",
    ],
  },

  footnote: {
    brief: "脚注：textOptions.footnote，上标编号跟在该 run 末尾",
    usage: "编号由服务端按出现顺序分配，插入删除不会错号。内容是纯文本字符串。",
    example: {
      contexts: [
        { type: "text",
          text: ["经测算方案可行", "，预期节约 23%", "。"],
          textOptions: [{ footnote: "测算依据见附录 B。" }, { footnote: "数据截至 2026-06。" }, {}],
          paragraphOptions: { style: "normalParagraph" } },
      ],
    },
    notes: [
      "脚注跟着 run 走：想让标记出现在哪段文字后面，就把 footnote 挂在哪个 run 上",
      "表格单元格内暂不支持脚注",
    ],
  },

  checklist: {
    brief: "任务清单：checklist 节点，items 直接列待办项",
    usage: "items 每项是字符串（未勾选）或 { text, checked }。渲染为 Word 原生复选框（w14:checkbox sdt）：Word 里可点击勾选，WPS/LibreOffice 显示为符号。Markdown 的 - [ ] / - [x] 任务列表自动转。行内要复选框用 textOptions.checkbox（true 未勾 | { checked: true } 已勾）。",
    example: {
      contexts: [
        { id: "chk-todo", type: "checklist", items: [
          "整理季度数据",
          { text: "复核良率口径", checked: true },
          { text: "排期评审会议", checked: false },
        ] },
      ],
    },
    notes: [
      "不要用 ☐/☑ 字符自己拼——checklist 出的是原生复选框，Word 里能点",
      "项内不支持加粗/链接等行内样式，需要就改用 text 节点 + textOptions.checkbox",
    ],
  },

  comment: {
    brief: "评论批注：textOptions.comment，批注范围是所在 run",
    usage: "审阅场景用：给草稿标疑问、标出模型不确定的内容。批注 id 服务端按出现顺序分配，作者统一显示 meta.commentAuthor（默认「AI 审阅」）。Word/WPS 里打开可见批注气泡；导出 PDF 默认不带。",
    example: {
      meta: { commentAuthor: "AI 审阅" },
      contexts: [
        { type: "text",
          text: ["三季度良率提升 2.3 个百分点", "，其余指标平稳。"],
          textOptions: [{ comment: "该数据来自口头汇报，需人工核实。" }, {}],
          paragraphOptions: { style: "normalParagraph" } },
      ],
    },
    notes: [
      "批注跟着 run 走：想圈哪段文字，就把 comment 挂在哪个 run 上",
      "正式交付前删掉批注（update_node 去掉 comment 字段即可）",
    ],
  },

  math: {
    brief: "数学公式：块级 math 节点 / 行内 textOptions.math，latex 写 LaTeX 子集",
    usage: "支持：分式 \\frac{a}{b}、根式 \\sqrt{x} / \\sqrt[3]{x}、求和 \\sum_{i=1}^{n}、积分 \\int_{a}^{b} / \\iint / \\oint、连乘 \\prod、装饰符 \\bar{x} \\hat{y} \\vec{v} \\tilde \\dot 等、\\overline{AB} / \\underline、矩阵 \\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}（matrix/bmatrix/vmatrix 同理）、函数名 \\sin \\cos \\log \\det \\lim、上下标 x^2 / x_i / x_i^2、\\left( \\right) 括号、希腊字母（\\alpha \\sigma \\Delta…）和常用运算符（\\times \\pm \\le \\ne \\infty \\sim \\perp…）。渲染为 Word 原生公式（OMML）。块级 math 节点默认居中独占一段；行内公式在 text 节点的 run 上设 math:true，该 run 的文本按 LaTeX 解析、随文字排。**优先用块级 math 节点，前后用 text 节点承接上下文；行内公式只用于简单符号**（单个希腊字母、x_i 级上下标）——分式、求和/积分上下限、矩阵等高结构嵌进行内会被段落行距截断（见 notes）。",
    example: {
      contexts: [
        { id: "eq-var", type: "math", latex: "\\sigma^2 = \\frac{1}{n} \\sum_{i=1}^{n} (x_i - \\bar{x})^2" },
        { id: "eq-int", type: "math", latex: "F(b) - F(a) = \\int_{a}^{b} f(x) \\, dx" },
        { id: "eq-mat", type: "math", latex: "A = \\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}" },
        { type: "text",
          text: ["其中 ", "\\mu", " 为总体均值，", "n", " 为样本量。"],
          textOptions: [{}, { math: true }, {}, { math: true }, {}] },
      ],
    },
    notes: [
      "只支持列出的子集：多行对齐（align 环境）等暂不支持，未识别命令按原文输出 + warn（math-syntax 会点名）",
      "\\sum/\\int/\\prod 只吸收紧随的一项作为算子体，多项内容用 {} 或 () 括起来整体吸收",
      "矩阵各行列数要一致（不一致会 warn 并补空位，Word 里显示占位框）",
      "行内 math run 不吃 bold/link 等其他 textOptions 字段（公式样式由 OMML 自己管）",
      "Markdown 输入：$...$ 转行内公式、独占一段的 $$...$$ 转块级 math 节点（美元金额如 $5 不会误伤）",
      "查看器差异：\\sum/\\int/\\prod 的上下限在 WPS/LibreOffice 预览里可能缺失（LO 导入缺陷），Word 显示正常",
      "行内公式别放高结构：分式、求和/积分上下限、矩阵在 WPS/LibreOffice 里上下会被截断（w:line 行距被当固定行高，2026-07-11 实测）——这类公式一律用块级 math 节点，排版可控且跨查看器一致",
    ],
  },

  toc: {
    brief: "目录：{ type: \"toc\" } 默认静态展开，native:true 出 Word 原生域",
    usage: "静态展开（默认）：立即可见、条目可点跳转、无页码，任何查看器都正常。native（或 meta.target:\"word\"）：Word 原生目录域带页码，但打开要更新域，WPS/LibreOffice 显示空白。目录要独占一页就在后面放 newPage 节点。",
    example: {
      contexts: [
        { type: "toc", title: "目录", maxLevel: 2 },
        { type: "newPage" },
        { id: "h-1", type: "heading", level: 1, text: "概述" },
        { id: "h-2", type: "heading", level: 2, text: "背景" },
      ],
    },
    notes: [
      "收件人确定用 Word 且要页码：meta.target 设 \"word\"（toc 节点不用改）",
      "maxLevel 默认 3，只收 1~maxLevel 级标题",
    ],
  },

  section: {
    brief: "分节：sectionBreak 节点起新节——横向页 / 分栏 / 换页眉页脚 / 重启页码",
    usage: "sectionBreak 是平铺分隔节点，它之后的内容进入新节，直到下一个 sectionBreak 或文末。继承是非累积的：每节 = 文档 meta + 本 sectionBreak 自身字段，空 { type: \"sectionBreak\" } 就回到 meta 基准（不延续上一节的覆盖）。可选字段：landscape（横向）、columns（分栏，N 或 { count, space?, separator? }——separator:true 加栏间分隔线）、margins、headerText/headerImage/footerImage/pageNumber（页眉页脚，headerText:\"\" 清空）、pageNumberStart（重启页码）、pageNumberFormat（decimal/lowerRoman/upperRoman）、breakType（默认 nextPage，continuous=同页起分栏）、titlePage、restartNumbering（true 时 autoNumber 的章号/图表号在该节从 1 重编）。默认页码是十进制「第x页 共x页」全文连续——pageNumberStart / pageNumberFormat 是少数正式长文档才需要的 opt-in，不确定就别写（见 notes 场景判断）。",
    example: {
      meta: { headerText: "年度报告", pageNumber: true },
      contexts: [
        { id: "h-1", type: "heading", level: 1, text: "正文" },
        { type: "text", text: "纵向单栏正文。" },
        { type: "sectionBreak", headerText: "", pageNumberStart: 1, pageNumberFormat: "lowerRoman" },
        { id: "h-2", type: "heading", level: 1, text: "前言" },
        { type: "text", text: "前置页：页眉清空、罗马页码从 i 起。" },
        { type: "sectionBreak", landscape: true, columns: 2, pageNumberStart: 1, pageNumberFormat: "decimal" },
        { id: "h-3", type: "heading", level: 1, text: "数据附录" },
        { type: "text", text: "横向双栏，页眉回到 meta 的「年度报告」，页码从 1 重启。" },
      ],
    },
    notes: [
      "【何时用重启页码 / 罗马页码】只用于「前置页与正文分开编页码」的正式长文档：学位论文、标书、正式出版物、厚技术手册（目录/摘要/前言用 i·ii·iii，正文从 1 重新编）。普通报告、月报、通知、方案、说明书一律不要用——保持默认十进制全文连续，硬塞罗马页码只会显得奇怪。判断不了就别加，默认就是对的。",
      "【何时用横向 / 分栏】landscape 和 columns 与页码无关、独立按需：出现宽表、宽图、并排小节时给那一节加 landscape:true 或 columns:2 即可，其他节照旧纵向单栏。这类需求常见得多，不像重启页码那么挑场景。",
      "titlePage 不继承：封面语义只作用第一节，后续节默认显示页眉页脚；某节要抑制首页页眉自己写 titlePage:true",
      "重启页码的节页脚只显示「第x页」不带「共x页」——节内总页数（SECTIONPAGES）在 WPS/LibreOffice 不渲染，去掉避免空白",
      "表格超宽/图片缩放按所在节的版心算：横向节和分栏节版心更宽/更窄，同一张表结论可能不同",
      "【何时用 restartNumbering】编号默认文档级连续，不随分节重启。只有「多篇独立文稿装订成一册」的场景（论文集、分册手册、合订附录）才在每篇开头的 sectionBreak 上加 restartNumbering:true；同一篇文档的正文/附录分节不要重启——重启后不同节会出现重复的「图1」，{{ref:}} 引用文本无歧义但读者需要节上下文才能定位",
      "【何时用栏间分隔线】columns.separator 是报纸/期刊排版惯例，正式公文和报告的分栏一般不加；栏距挤（space 小）时加分隔线更易读",
      "Markdown 无分节语法，多节文档走 def（create_document / insert_nodes）",
    ],
  },

  meta: {
    brief: "文档级配置：autoNumber / target / h1PageBreak / headerText / headerImage / imagesDir 等",
    usage: "能不写就不写，样式交给 preset。常用：autoNumber（编号：true 服务端文本编号默认开 / false 关 / \"native\" Word 原生多级编号，实验特性）、target（universal 默认 / word）、h1PageBreak（true = 每个一级标题自动另起一页，正式报告/方案书建议开；服务端会跳过已在新页上的章，不会多出空白页）、headerText（页眉文字，靠右）、headerImage / footerImage（页眉页脚图 { src, width?, height? }，px、可省略等比缩放——图靠左，文字/页码靠右，适合 logo）、imagesDir（图片基准目录）、fetchUrlImages（URL 图抓取开关）、docProps（文档属性：title/subject/creator/keywords/description，Word「文件-信息」可见；title 缺省用建档 title）。",
    example: {
      meta: {
        headerText: "2026 年 6 月监测月报",
        headerImage: { src: "logo.png", height: 24 },
        imagesDir: "/data/report-images",
        target: "word",
        docProps: { creator: "监测中心", keywords: "月报;结构监测" },
      },
      contexts: [
        { id: "h-1", type: "heading", level: 1, text: "概述" },
      ],
    },
    notes: [
      "target: \"word\" = 收件人确定用 Word 打开，查看器相关特性走 Word 最优解（如 toc 出原生域带页码）；默认 universal 保证任何查看器立即可见",
      "autoNumber: \"native\" 只用于「收件人要在 Word 里继续增删章节维护」的文档——编号绑在标题样式上，Word 里新增/删除标题自动重排。一次性交付/预览用默认 true 即可（视觉相同）。native 的取舍：{{ref:}}、图表号、静态目录仍是文本，生成时刻与编号一致，但收件人改章节后它们不跟着变；restartNumbering 对 native 无效（编号全局连续，校验会 warn）",
      "字体字号边距这些不要写进 meta，改 preset 或 style profile",
      "多章节的正式文档（报告/方案/标书）默认挤在连续页面上会显得密不透风：建议 meta.h1PageBreak:true 每章起新页，配合封面（blank+居中标题+newPage）和 toc 目录页。只要「换页」用 h1PageBreak 就够；sectionBreak 留给需要横向页/独立页眉页脚/重启页码的场景",
    ],
  },

  markdown: {
    brief: "create_document_from_markdown：Markdown 直接建档",
    usage: "支持标题/段落/列表/表格/代码块/引用/图片/[toc]/超链接/加粗斜体行内代码/$...$ 公式/[^1] 脚注。手写编号的标题会自动剥掉交给 autoNumber（不想剥就 meta.autoNumber:false）。",
    example: {
      title: "示例文档",
      preset: "monthly-report",
      baseDir: "/data/report",
      imagesDir: "images",
      markdown: [
        "[TOC]",
        "",
        "# 概述",
        "",
        "正文支持 **加粗**、[链接](https://example.com) 和 `行内代码`。",
        "",
        "| 指标 | 数值 |",
        "|---|---|",
        "| 良率 | 98% |",
        "",
        "标准差 $\\sigma$ 在阈值内[^1]。",
        "",
        "$$",
        "\\sigma^2 = \\frac{1}{n} \\sum_{i=1}^{n} (x_i - \\mu)^2",
        "$$",
        "",
        "[^1]: 阈值定义见 Q/XX 001-2026。",
        "",
        "![系统架构](arch.png)",
      ].join("\n"),
    },
    notes: [
      "图片相对路径按 baseDir/imagesDir 解析，alt 文本自动成为图题",
      "列表转 docx 原生编号，不会渲染成「- xxx」纯文本",
      "列表样式可调（就近覆盖，CSS 层叠语义）：bullet 字符/缩进在 meta.numbering.config 里重定义 md-bullet 的 levels（如 text 换 \"–\"），只写要改的那条即可——同 reference 整条替换，preset 其余编号（md-ordered 等）自动保留；也可定义新 reference 再用 meta.markdown.bulletRef / orderedRef 指过去",
      "列表的字号/行距/对齐属 mdList 段落样式：meta.styles.paragraphStyles 写 { id: \"mdList\", paragraph: { alignment: \"left\" } } 即可——同 id 字段级深并（run/paragraph 各一层），没写的字段和其余样式都保留；全局口味请改 style profile 或 preset",
      "$...$ 转行内公式、独占一段的 $$...$$ 转块级公式（美元金额不误伤）；[^1] 转 Word 原生脚注，定义块不进正文",
      "建档后照常用 get_outline / update_node 按节点改，Markdown 只是输入形式",
    ],
  },

  template: {
    brief: "模板填槽：register_template 登记 .docx/.dotx 模板 → create_document_from_template 填 {{槽名}}",
    usage: "场景判断先行：合同、证明、盖章公文这类「版式必须和公司模板一字不差」的文档才走填槽流；自由结构的报告/月报/通知一律用 create_document（def 流），排版交给 preset。模板里写 {{槽名}} 占位（正文/页眉/页脚/表格格都行），注册时自动提取槽位清单。slots 值：字符串=段内替换（保留模板原样式，\\n 转软换行）；节点数组=整段块级替换。",
    example: {
      registerTemplate: { name: "劳动合同模板", path: "/data/templates-src/contract.docx" },
      createDocumentFromTemplate: {
        templateId: "<register_template 返回的 id>",
        title: "张三-劳动合同",
        slots: {
          employeeName: "张三",
          startDate: "2026 年 8 月 1 日",
          salaryDetail: [
            { type: "text", text: "基本工资与绩效构成如下：" },
            { type: "table", data: [["项目", "金额"], ["基本工资", "18000"], ["绩效", "6000"]],
              tableOptions: { headerRows: 1 } },
          ],
        },
      },
    },
    notes: [
      "填槽文档没有节点结构：改内容用 update_template_slots（浅合并，null 恢复未填），渲染照常 render_document（支持 preview/pdf）",
      "槽位支持的块级节点: text/heading/table/image/math/newPage/blank；toc/checklist/sectionBreak/脚注/批注依赖全文档上下文，槽位里不成立",
      "槽位可不填全，渲染时未填的 {{槽名}} 原样留下并 warning——适合分批填",
      "模板是 Word 手工维护的也没关系：占位符被 Word 拆成多个 run 仍能识别",
      "页码引用/交叉引用体系（ref/pageRef）是 def 流的能力，模板流里不要用",
    ],
  },
};

module.exports = { EXAMPLES };
