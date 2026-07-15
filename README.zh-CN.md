# InkPaw 🐾

[English](README.md) | 简体中文

> 一个小巧、严谨的 AI Agent DOCX 工具箱。模型负责写，InkPaw 负责让文档正确。

InkPaw（墨爪）是面向 AI Agent 的 Word 文档生成、修改、校验和渲染工具，同时提供 MCP Server、独立渲染层，以及用于体验完整 Agent 工作流的本地 Web Playground。

核心原则很简单：**模型负责内容和结构；确定性代码负责编号、样式、引用、OOXML 正确性与输出验证。**

## 立即体验 Playground

最快的体验方式是启动本地实验性 Playground：

```bash
git clone https://github.com/syouro/InkPaw.git
cd InkPaw
npm install
npm run playground
```

打开 `http://127.0.0.1:8766`，填写 OpenAI 兼容接口地址、模型名称和 API Key，然后直接让 Agent 创建文档。

Playground 会展示流式推理与工具调用，提供逐页预览、续聊修改、模板填槽和 DOCX/PDF 下载。它默认只监听本机，用于本地体验，不应未经加固直接部署到公网。完整逐页预览需要 LibreOffice 和 poppler-utils。详见 [Playground 使用说明](docs/playground.md)。

## 为什么做 InkPaw？

LLM 很擅长写内容，但直接让模型控制 Word 排版细节，很容易出现编号断裂、样式漂移、引用失效或文件无法打开。InkPaw 使用持久化的结构化文档模型（`def` JSON）拆开这两类职责：

- Agent 创建标题、段落、表格、图片、公式、脚注、批注和分节。
- InkPaw 生成编号、题注、交叉引用、目录、样式与 OOXML。
- 稳定节点 ID 让 Agent 能跨轮次精确查询、更新、移动和删除内容。
- 校验器返回带位置、修复建议和权威示例的结构化问题，便于 Agent 自我修正。

## 功能

- 结构化建档与 Markdown 建档。
- 节点级 insert / update / move / delete，SQLite 持久化。
- 自动编号、图表题、交叉引用和静态/原生目录。
- preset → style profile → document 的三层样式合并。
- 表格合并、页眉页脚、脚注、批注、复选框、公式、浮动图和多 section。
- DOCX、PDF 和逐页 PNG 输出。
- OPC 完整性、ECMA-376 Schema 与 Word 兼容陷阱三层校验。
- stdio 与无状态 Streamable HTTP 两种 MCP 传输。
- HTTP Bearer 鉴权与可选的多用户存储作用域。
- 本地 BYOK Playground：流式 Agent Loop、MCP 工具、预览和下载。

## 环境要求

- Node.js 18+
- npm
- LibreOffice Writer + Math：完整测试套件和 PDF/PNG 预览需要
- 可选：poppler-utils，用于转为逐页 PNG
- 可选：xmllint + xsltproc，用于完整 OOXML Schema 校验

仅使用核心 DOCX 生成功能时不需要 LibreOffice。

## MCP 快速开始

InkPaw 默认以 stdio 启动：

```bash
npm start
```

通用 MCP 客户端配置示例：

```json
{
  "mcpServers": {
    "inkpaw": {
      "command": "node",
      "args": ["/absolute/path/to/InkPaw/src/server.js"]
    }
  }
}
```

### Streamable HTTP

```bash
npm run start:http
```

默认端点为 `http://127.0.0.1:8765/mcp`，并强制 Bearer 鉴权。首次启动会生成 `data/mcp-token`；也可以通过 `DOCX_MCP_TOKEN` 显式设置。

### 只使用渲染层

渲染层不依赖 MCP 或 SQLite：

```bash
npm run demo
node src/docxUtil.js render examples/demo-report.js
```

## 验证

```bash
npm test
npm run validate -- path/to/file.docx
scripts/docx2png.sh path/to/file.docx
npm run visual
```

视觉基线受 LibreOffice 版本和字体影响，只应在人工确认渲染页面后更新。

## 架构

```text
MCP 客户端或本地 Playground
              │
              ▼
MCP 传输层（stdio / HTTP）
              │
              ▼
服务层 + 校验器 + SQLite 存储
              │
              ▼
转换层（编号 / 引用 / 题注）
              │
              ▼
与协议无关的 DOCX 渲染层
              │
              ▼
DOCX / PDF / PNG + 校验反馈
```

模块边界与不变量详见 [架构说明](docs/architecture.md)。

## 仓库结构

```text
src/          核心渲染器、MCP Server、服务、存储与校验
playground/   实验性的本地 Web Agent 体验入口
scripts/      启动、校验、渲染与视觉回归工具
test/         单元与集成测试
presets/      可复用样式预设
schemas/      OOXML 校验资源
docs/         架构、规范、兼容性与发布约束
```

## 文档

- [Playground 使用说明](docs/playground.md)
- [架构](docs/architecture.md)
- [文档节点规范](docs/docxUtil-spec.md)
- [查看器兼容性](docs/compatibility.md)
- [docx 上游问题](docs/upstream-issues.md)
- [来源快照与同步规则](SOURCE_SNAPSHOT.md)
- [开源发布约束](docs/open-source-release-policy.md)
- [贡献指南](CONTRIBUTING.md)
- [安全策略](SECURITY.md)

## 项目状态

DOCX/MCP 核心是项目主体。Playground 标记为 Experimental，是因为它的 API 和界面仍可能调整，默认安全边界也是本机。它有测试，但还不是一个开箱即用的公网多租户 SaaS。

## 许可证

[MIT](LICENSE) © 2026 syouro。第三方声明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
