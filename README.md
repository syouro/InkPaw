# InkPaw 🐾

> A tiny, meticulous DOCX toolkit for AI agents. Models write; InkPaw keeps the document correct.

InkPaw（墨爪）是一个面向 AI Agent 的 Word 文档生成、修改、校验和渲染工具，同时提供 MCP Server 与可独立使用的渲染层。

核心思路很简单：**模型只处理内容和结构，确定性代码负责编号、样式、引用、OOXML 正确性与输出验证。**

## Why InkPaw?

LLM 能写出很好的内容，但直接让模型操作 Word 排版细节，很容易出现编号断裂、样式漂移、引用失效或文件无法打开。InkPaw 用一个持久化的结构化文档模型（def JSON）把两者分开：

- Agent 创建标题、段落、表格、图片、公式、脚注和分节。
- InkPaw 生成编号、交叉引用、目录、样式与 OOXML。
- 稳定节点 ID 让 Agent 能跨轮次精确查询、更新、移动和删除内容。
- 校验器返回带位置、修复建议和权威示例的结构化问题，便于 Agent 自我修正。

## Features

- 结构化建档与 Markdown 建档。
- 节点级 insert / update / move / delete，SQLite 持久化。
- 服务端自动编号、图表题、交叉引用和静态/原生目录。
- preset → style profile → document 的三层样式合并。
- 表格合并、页眉页脚、脚注、批注、复选框、公式、浮动图和多 section。
- DOCX / PDF / 逐页 PNG 输出。
- OPC 完整性、ECMA-376 Schema 与 Word 兼容陷阱三层校验。
- stdio 与无状态 Streamable HTTP 两种 MCP 传输。
- HTTP Bearer 鉴权与可选的多用户存储作用域。

## Requirements

- Node.js 18+
- npm
- LibreOffice Writer + Math（完整测试套件与 PDF/PNG 预览需要；仅使用核心 DOCX 生成时可不安装）
- 可选：poppler-utils（将 PDF 转成逐页 PNG）
- 可选：xmllint + xsltproc（完整 OOXML Schema 校验）

## Quick start

```bash
git clone https://github.com/syouro/InkPaw.git
cd InkPaw
npm install
npm test
```

### MCP over stdio

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

默认端点为 `http://127.0.0.1:8765/mcp`，并强制 Bearer 鉴权。首次启动会生成 `data/mcp-token`；也可用 `DOCX_MCP_TOKEN` 显式设置。

### Renderer only

渲染层不依赖 MCP 或 SQLite，可单独使用：

```bash
npm run demo
node src/docxUtil.js render examples/demo-report.js
```

## Validation

```bash
npm test
npm run validate -- path/to/file.docx
scripts/docx2png.sh path/to/file.docx
npm run visual
```

`npm run visual` 受 LibreOffice 版本与字体影响，基线只应在人工确认视觉输出后更新。

## Architecture

```text
MCP transport (stdio / HTTP)
            │
            ▼
Service + validator + SQLite store
            │
            ▼
Transform (numbering / refs / captions)
            │
            ▼
Protocol-independent DOCX renderer
            │
            ▼
DOCX / PDF / PNG + validation feedback
```

详见 [docs/architecture.md](docs/architecture.md)。

## Documentation

- [Architecture](docs/architecture.md)
- [Document node specification](docs/docxUtil-spec.md)
- [Viewer compatibility](docs/compatibility.md)
- [Upstream docx issues](docs/upstream-issues.md)
- [Source snapshot and sync rules](SOURCE_SNAPSHOT.md)
- [Open-source release policy](docs/open-source-release-policy.md)
- [Contributing](CONTRIBUTING.md)
- [Security](SECURITY.md)

## Project scope

InkPaw 首个公开版本只包含 DOCX/MCP 核心。不包含私有部署配置、用户数据、历史业务样例或可选 Web Agent 应用。

## License

[MIT](LICENSE) © 2026 syouro. Third-party notices are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
