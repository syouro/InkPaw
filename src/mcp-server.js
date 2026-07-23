/**
 * mcp-server.js — MCP 工具注册（协议层，传输无关）
 *
 * createMcpServer(service) 返回注册好全部工具的 McpServer。
 * stdio 模式整个进程一个实例；HTTP 无状态模式每请求新建一个
 * （SDK 的 stateless 约定），service 共享同一份。
 */
const { z } = require("zod");
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");

const jsonResult = (obj) => ({ content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] });
const wrap = (fn) => async (args) => {
  try {
    return jsonResult(await fn(args));
  } catch (e) {
    return { isError: true, content: [{ type: "text", text: `错误: ${e.message}` }] };
  }
};

const docIdSchema = z.string().uuid().describe("文档 UUID");
const templateIdSchema = z.string().uuid().describe("模板 UUID");
const nodeIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/)
  .describe("节点 id（1-128 字符，仅字母、数字、点、下划线、冒号和连字符）");
const titleSchema = z.string().trim().min(1).max(200);
const presetSchema = z.string().trim().min(1).max(80).regex(/^[A-Za-z0-9._-]+$/);
const pathSchema = z.string().min(1).max(4096);
const nodeSchema = z.record(z.string(), z.any());
const nodesSchema = z.array(nodeSchema).min(1).max(5000);

const defSchema = z.object({
  meta: z.record(z.string(), z.any()).optional().describe("文档级配置（headerText/imagesDir/autoNumber…），能不写就不写，样式交给 preset。target:\"word\" 表示收件人确定用 Word 打开——查看器相关特性走 Word 最优解（如 toc 出原生域带页码）；默认 universal 兼容一切查看器。autoNumber:\"native\" 出 Word 原生多级编号（标题编号绑样式，收件人要在 Word 里继续增删章节维护才用；默认 true 服务端文本编号，视觉相同）"),
  contexts: z.array(nodeSchema).min(1).max(5000).describe("节点数组（1-5000 项），类型：text/heading/table/image/toc/checklist/math/sectionBreak/newPage/blank，规范见 docs/docxUtil-spec.md + docs/architecture.md。checklist 是任务清单（原生复选框，Word 可点击）；math 是块级公式（latex 子集：frac/sqrt/求和积分连乘及上下限/上下标/希腊字母/装饰符/矩阵环境/函数名/\\left\\right；行内公式用 textOptions.math，但只放简单符号——分式/上下限/矩阵等高结构行内会被行距截断，一律用块级 math 节点）；sectionBreak 另起一节（横向页、分栏、独立页眉页脚、重启页码/编号）；image.float 出浮动图（绕排+定位，默认 inline，明确要版式定位才用）；textOptions.comment 出评论批注（审阅用）。toc 默认静态展开（立即可见、可跳转、无页码），{native:true} 出 Word 原生目录域（有页码，打开需更新域，WPS/LibreOffice 显示空白）"),
});

const createMcpServer = (service) => {
  const server = new McpServer({ name: "docx-mcp", version: "0.1.0" });

  server.registerTool("create_document", {
    title: "创建文档",
    description: "收完整 def（{meta?, contexts}），服务端补节点 id、跑校验后保存。issues 非空也会保存（草稿态），但 error 级不清零无法渲染。节点可带 caption（图题/表题）；autoNumber 开启时 heading text 不要写编号，正文用 {{ref:节点id}} 引用编号；textOptions.link 支持超链接（http(s)/mailto 外链，\"#节点id\" 内链跳转到标题）；textOptions.footnote:\"内容\" 出脚注（编号服务端排）；{{pageRef:节点id}} 出页码引用（target:word 场景专用）；纯文本表格 data 直接写二维数组（行需样式再用 {texts:[...]} 完整形）。",
    inputSchema: {
      title: titleSchema.optional().describe("文档标题（1-200 字符，元数据，不进正文）"),
      preset: presetSchema.optional().describe("样式包名，见 list_presets；缺省用 style profile 或 monthly-report"),
      def: defSchema,
    },
  }, wrap((args) => service.createDocument(args)));

  server.registerTool("create_document_from_markdown", {
    title: "从 Markdown 创建文档",
    description: "输入 Markdown 文本，服务端转成结构化 def 后建档（后续可用 get_outline/update_node 按节点修改）。支持标题、段落、有序/无序列表（原生编号）、任务列表 - [ ]（原生复选框）、表格、代码块、引用、图片（相对路径按 baseDir/imagesDir 解析）、分隔线、[toc] 目录、超链接（http(s)/mailto）、脚注 [^1]、公式（$...$ 行内、独占段 $$...$$ 转块级）；行内加粗/斜体/行内代码。图片 alt 文本会成为图题。返回 { docId, issues }。",
    inputSchema: {
      title: titleSchema.optional().describe("文档标题（1-200 字符，元数据，不进正文）"),
      preset: presetSchema.optional().describe("样式包名，见 list_presets；缺省用 style profile 或 monthly-report"),
      markdown: z.string().min(1).max(5 * 1024 * 1024).describe("Markdown 全文（1 字符至 5 MiB）"),
      baseDir: pathSchema.optional().describe("图片相对路径的基准目录，缺省服务进程 cwd"),
      imagesDir: pathSchema.optional().describe("图片子目录（相对 baseDir），缺省 baseDir 本身"),
      meta: z.record(z.string(), z.any()).optional().describe("文档级 meta 覆盖。{autoNumber:false} 保留标题手写编号；{target:\"word\"} 表示收件人确定用 Word（[toc] 出原生目录域带页码），默认 universal 兼容一切查看器"),
    },
  }, wrap((args) => service.createDocumentFromMarkdown(args)));

  server.registerTool("render_document", {
    title: "渲染文档",
    description: "把文档渲染为 .docx 落盘并返回文件路径。存在 error 级 issue 时拒绝渲染并打回 issues。preview:true 额外生成每页 PNG（previewPages），用 Read 读图可直接检查排版。pdf:true 额外导出同名 PDF（pdfPath），交付不怕查看器差异。文档属性（作者/主题/关键词）走 meta.docProps，title 缺省用建档 title。模板填槽文档（create_document_from_template 建的）也走这里渲染，未填槽位会在 warnings 里点名。",
    inputSchema: {
      docId: docIdSchema,
      outPath: pathSchema.optional().describe("输出路径（最多 4096 字符），缺省 data/output/<docId>.docx"),
      preview: z.boolean().optional().describe("渲染后生成每页 PNG 预览（LibreOffice，约 5-10 秒）"),
      pdf: z.boolean().optional().describe("额外导出同名 PDF（LibreOffice 转换，返回 pdfPath）"),
    },
  }, wrap((args) => service.renderDocument(args)));

  server.registerTool("validate_document", {
    title: "校验文档",
    description: "单独跑校验，返回 issues[]（level: error|warn）。",
    inputSchema: { docId: docIdSchema },
  }, wrap((args) => service.validateDocument(args)));

  server.registerTool("get_outline", {
    title: "获取文档骨架",
    description: "返回节点骨架 [{id, type, sectionPath, brief}]，修改前先看这个定位节点。section 参数（如 \"1.1\"）只返回该节内。",
    inputSchema: {
      docId: docIdSchema,
      section: z.string().min(1).max(80).regex(/^\d+(?:\.\d+)*$/).optional().describe("章节号过滤，如 \"1.1\""),
    },
  }, wrap((args) => service.getOutline(args)));

  server.registerTool("get_nodes", {
    title: "获取节点全量",
    description: "按 id 取完整节点 JSON，看细节用（改表格前先拉全量）。不存在的 id 返回 null。",
    inputSchema: { docId: docIdSchema, ids: z.array(nodeIdSchema).min(1).max(1000) },
  }, wrap((args) => service.getNodes(args)));

  server.registerTool("update_node", {
    title: "替换节点",
    description: "整节点替换（id 不变，别的节点对它的 ref 不断）。支持类型改变（如 text 提级为 heading）。返回替换后的全文档校验结果 + 最新 outline（无需再调 get_outline）。",
    inputSchema: {
      docId: docIdSchema,
      id: nodeIdSchema.describe("要替换的节点 id"),
      node: nodeSchema.describe("新节点（不必带 id，带了也以本参数 id 为准）"),
    },
  }, wrap((args) => service.updateNode(args)));

  server.registerTool("insert_nodes", {
    title: "插入节点",
    description: "在锚点节点前/后插入一组节点，服务端补 id 并返回 newIds。节点不必带 id；返回插入后的全文档校验结果 + 最新 outline。",
    inputSchema: {
      docId: docIdSchema,
      anchorId: nodeIdSchema.describe("锚点节点 id（先用 get_outline 定位）"),
      position: z.enum(["before", "after"]).describe("插到锚点之前还是之后"),
      nodes: nodesSchema.describe("要插入的节点数组（1-5000 项），规范同 create_document 的 contexts"),
    },
  }, wrap((args) => service.insertNodes(args)));

  server.registerTool("delete_nodes", {
    title: "删除节点",
    description: "按 id 删除一组节点。若留下的节点 ref 到被删节点，返回 delete-ref-broken warning 点名引用方；返回删除后的全文档校验结果 + 最新 outline。",
    inputSchema: {
      docId: docIdSchema,
      ids: z.array(nodeIdSchema).min(1).max(1000).describe("要删除的节点 id 数组（1-1000 项）"),
    },
  }, wrap((args) => service.deleteNodes(args)));

  server.registerTool("move_nodes", {
    title: "移动节点",
    description: "把一组节点移到锚点前/后（章节重排）。按 ids 给出的顺序落位（可顺便组内重排）；anchorId 不能在 ids 里。返回移动后的全文档校验结果（heading 层级、ref 都会重查）+ 最新 outline。",
    inputSchema: {
      docId: docIdSchema,
      ids: z.array(nodeIdSchema).min(1).max(1000).describe("要移动的节点 id 数组（1-1000 项），落位顺序以此为准"),
      anchorId: nodeIdSchema.describe("锚点节点 id"),
      position: z.enum(["before", "after"]).describe("移到锚点之前还是之后"),
    },
  }, wrap((args) => service.moveNodes(args)));

  server.registerTool("list_presets", {
    title: "列出样式包",
    description: "列出内置 preset（名称+简介）。",
    inputSchema: {},
  }, wrap(() => service.listPresets()));

  server.registerTool("get_examples", {
    title: "查看写法示例",
    description: "各类节点/字段的权威写法示例（示例进测试，与校验器永远同步）。拿不准写法、校验报 error、或上下文太长记不清规则时，先按主题取示例对着写。不带 topic 返回主题清单。",
    inputSchema: {
      topic: z.string().trim().min(1).max(80).regex(/^[A-Za-z0-9._-]+$/).optional().describe("主题名（如 table-span / link / footnote / markdown），缺省列出全部主题"),
    },
  }, wrap((args) => service.getExamples(args || {})));

  server.registerTool("register_template", {
    title: "注册填槽模板",
    description: "登记公司固定版式的 .docx/.dotx 模板，返回 templateId 和自动提取的槽位清单。模板里用 {{槽名}} 写占位符（正文/页眉/页脚/表格单元格都行，Word 手工编辑拆散成多个 run 也能识别）。场景判断：合同、证明、固定版式公文才走模板填槽；自由结构的报告/月报用 create_document（def 流），排版交给 preset。",
    inputSchema: {
      name: z.string().trim().min(1).max(80).optional().describe("模板名（1-80 字符，便于 list_templates 辨认），缺省用文件名"),
      path: pathSchema.optional().describe("服务器本地模板路径（最多 4096 字符，与 base64 二选一）"),
      base64: z.string().min(1).max(7_100_000).optional().describe("模板文件 base64（解码后 ≤5 MiB，远程上传用；本机文件优先走 path 省上下文）"),
    },
  }, wrap((args) => service.registerTemplate(args)));

  server.registerTool("list_templates", {
    title: "列出已注册模板",
    description: "列出全部已注册模板：templateId、名称、槽位清单、注册时间。",
    inputSchema: {},
  }, wrap(() => service.listTemplates()));

  server.registerTool("delete_template", {
    title: "删除模板",
    description: "删除已注册模板（登记记录 + 模板文件）。注意：由该模板创建的填槽文档将无法再渲染。",
    inputSchema: {
      templateId: templateIdSchema.describe("要删除的模板 id（见 list_templates）"),
    },
  }, wrap((args) => service.deleteTemplate(args)));

  server.registerTool("create_document_from_template", {
    title: "从模板填槽建档",
    description: "基于已注册模板创建填槽文档，返回 docId。slots 值两种形态：字符串=段内替换（保留模板原样式，\\n 转软换行）；def 节点数组=整段块级替换（支持 text/heading/table/image/math/newPage/blank，表格可用二维数组简写）。槽位可不填全（渲染时占位符原样留下并 warning）。这类文档没有节点结构：改内容用 update_template_slots，渲染用 render_document（同样支持 preview/pdf）。",
    inputSchema: {
      templateId: templateIdSchema.describe("register_template 返回的模板 id"),
      title: titleSchema.optional().describe("文档标题（1-200 字符，元数据）"),
      slots: z.record(z.string(), z.any()).optional().describe("{ 槽名: 字符串 | 节点数组 }，槽位清单见 register_template/list_templates 返回"),
      imagesDir: pathSchema.optional().describe("槽位里图片相对路径的基准目录，缺省服务进程 cwd"),
    },
  }, wrap((args) => service.createDocumentFromTemplate(args)));

  server.registerTool("update_template_slots", {
    title: "更新模板文档槽位",
    description: "改模板填槽文档的槽位值（浅合并：只动传入的键；值传 null 恢复该槽未填状态）。返回当前已填槽位、模板槽位全集和校验 issues；改完 render_document 重渲染即可。",
    inputSchema: {
      docId: docIdSchema,
      slots: z.record(z.string(), z.any()).describe("{ 槽名: 字符串 | 节点数组 | null }"),
    },
  }, wrap((args) => service.updateTemplateSlots(args)));

  server.registerTool("get_style_profile", {
    title: "读取样式 profile",
    description: "读取用户级 style profile（三层合并的中间层：preset ← profile ← 文档 meta）。未设置返回 { profile: null }。",
    inputSchema: {},
  }, wrap(() => service.getStyleProfile()));

  server.registerTool("set_style_profile", {
    title: "设置样式 profile",
    description: "写入用户级 style profile，之后新建/渲染的文档自动继承（已有文档也按新 profile 重渲染）。结构 { preset?, overrides?: { meta?, autoNumber?, captionStyle?, markdown? } }；传 null 清除恢复缺省。",
    inputSchema: {
      profile: z.record(z.string(), z.any()).nullable()
        .describe('{ preset?: "monthly-report"|…, overrides?: { meta?, autoNumber?, captionStyle?, markdown? } }，null 清除'),
    },
  }, wrap((args) => service.setStyleProfile(args)));

  return server;
};

module.exports = { createMcpServer };
