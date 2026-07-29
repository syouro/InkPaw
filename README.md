# InkPaw 🐾

English | [简体中文](README.zh-CN.md)

> A tiny, meticulous DOCX toolkit for AI agents. Models write; InkPaw keeps the document correct.

InkPaw is a Word document generation, editing, validation, and rendering toolkit for AI agents. It provides an MCP server, a protocol-independent renderer, and a local web Playground for trying the complete agent workflow.

The design principle is simple: **the model owns content and structure; deterministic code owns numbering, styles, references, OOXML correctness, and output validation.**

## Try the Playground

The fastest way to experience InkPaw is the local experimental Playground:

```bash
git clone https://github.com/syouro/InkPaw.git
cd InkPaw
npm install
npm run playground
```

Open `http://127.0.0.1:8766`, enter an OpenAI-compatible base URL, model name, and API key, then ask the agent to create a document.

The Playground shows streaming reasoning and tool activity, renders page previews, supports follow-up edits and templates, and provides DOCX/PDF downloads. It binds to localhost by default and is intended for local evaluation—not direct public deployment. Full page preview requires LibreOffice and poppler-utils. See [Playground guide](docs/playground.md).

### DeepSeek support

InkPaw includes explicit compatibility for DeepSeek thinking-mode Agent Loops: it sends the `thinking` control, streams `reasoning_content` into a separate UI panel, and preserves that reasoning across tool-call continuations as required by the DeepSeek API. The recommended starting model for the Playground is **`deepseek-v4-flash`**, which is prefilled with the official `https://api.deepseek.com` endpoint.

See the [DeepSeek integration guide](docs/deepseek.md) for setup, protocol details, and troubleshooting.

## Why InkPaw?

LLMs can write strong content, but asking a model to control Word layout details directly often causes broken numbering, drifting styles, invalid references, or documents that fail to open. InkPaw separates those concerns with a persistent structured document model (`def` JSON):

- Agents create headings, paragraphs, tables, images, equations, footnotes, comments, and sections.
- InkPaw generates numbering, captions, cross-references, tables of contents, styles, and OOXML.
- Stable node IDs allow precise query, update, move, and delete operations across agent turns.
- Structured validation issues include locations, repair guidance, and authoritative examples for self-correction.

## Features

- Structured document creation and Markdown import.
- Node-level insert, update, move, and delete with SQLite persistence.
- Automatic numbering, captions, cross-references, and static or native TOCs.
- Three-layer styling: preset → style profile → document overrides.
- Table spans, headers/footers, footnotes, comments, checkboxes, equations, floating images, and multiple sections.
- DOCX, PDF, and per-page PNG output.
- Three validation layers: OPC integrity, ECMA-376 Schema, and Word compatibility checks.
- MCP over stdio or stateless Streamable HTTP.
- HTTP Bearer authentication and optional per-user storage scopes.
- Local BYOK Playground with streaming Agent Loop, MCP tools, previews, and downloads.

## Requirements

- Node.js 18+
- npm
- LibreOffice Writer + Math for the complete test suite and PDF/PNG previews
- Optional: poppler-utils for per-page PNG conversion
- Optional: xmllint + xsltproc for complete OOXML Schema validation

Core DOCX generation does not require LibreOffice.

## MCP quick start

InkPaw starts with stdio transport by default:

```bash
npm start
```

Example MCP client configuration:

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

The default endpoint is `http://127.0.0.1:8765/mcp` and requires Bearer authentication. On first start, InkPaw creates `data/mcp-token`; you may also set `DOCX_MCP_TOKEN` explicitly.

Do not expose this local compatibility mode directly to the internet. InkPaw also includes OAuth 2.1 authorization code + PKCE, discovery, refresh/revocation, health checks, and reverse-proxy or native TLS support. See the [public HTTPS + OAuth deployment guide](docs/public-oauth-deployment.zh-CN.md).

### Renderer only

The renderer does not depend on MCP or SQLite:

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

Visual baselines depend on LibreOffice and installed fonts. Update them only after manually reviewing the rendered pages.

## Architecture

```text
MCP client or local Playground
              │
              ▼
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

See [Architecture](docs/architecture.md) for the module boundaries and invariants.

## Repository layout

```text
src/          core renderer, MCP server, service, storage, and validation
playground/   experimental local web Agent experience
scripts/      launch, validation, rendering, and visual-regression tools
test/         unit and integration tests
presets/      reusable style presets
schemas/      OOXML validation assets
docs/         architecture, specifications, compatibility, and release policy
```

## Documentation

- [Playground](docs/playground.md)
- [DeepSeek integration](docs/deepseek.md)
- [Architecture](docs/architecture.md)
- [Document node specification](docs/docxUtil-spec.md)
- [Editable preview design](docs/editable-preview.md) (implemented; image insertion out of scope)
- [Viewer compatibility](docs/compatibility.md)
- [Upstream docx issues](docs/upstream-issues.md)
- [Source snapshot and sync rules](SOURCE_SNAPSHOT.md)
- [Open-source release policy](docs/open-source-release-policy.md)
- [Contributing](CONTRIBUTING.md)
- [Security](SECURITY.md)

## Project status

The core DOCX/MCP toolkit is the primary project. The Playground is marked experimental because its API and interface may change and its default security boundary is localhost. It is tested, but it is not a turnkey multi-tenant public SaaS deployment.

## License

[MIT](LICENSE) © 2026 syouro. Third-party notices are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
