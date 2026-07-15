# InkPaw Playground

InkPaw Playground is an experimental, local-first web interface for trying the complete model → Agent Loop → MCP tools → DOCX rendering workflow.

It is included so that a new user can evaluate InkPaw without first configuring a separate MCP client. “Experimental” means the interface and internal HTTP API may change; it does not mean the path is untested.

## Start

Install the project and run one command:

```bash
npm install
npm run playground
```

The launcher starts two localhost-only processes:

- InkPaw MCP HTTP server at `http://127.0.0.1:8765/mcp`;
- Playground at `http://127.0.0.1:8766`.

Open the Playground URL and enter:

1. an OpenAI-compatible API base URL;
2. a model name that supports tool/function calling;
3. your API key.

The API key is stored in that browser's `localStorage`. Each chat request sends it to the local Playground server, which holds it only in memory while forwarding the request to the configured model endpoint. InkPaw does not write the key to its database or logs.

## What to try

- “Create a two-page monthly project report with a summary table.”
- Ask for a follow-up edit after the first preview appears.
- Upload a `.docx`/`.dotx` template containing `{{slotName}}` placeholders and ask the agent to fill it.
- Download the generated DOCX or PDF.

The Playground persists anonymous identities, sessions, messages, templates, and document state under the ignored `data/` directory. A recovery code in the settings dialog is the only credential for reopening that local identity; the database stores only its SHA-256 hash.

## Preview dependencies

DOCX creation works with Node.js alone. PDF and per-page PNG preview additionally require:

- LibreOffice Writer and Math;
- poppler-utils (`pdftoppm`).

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `DOCX_MCP_PORT` | `8765` | Core HTTP MCP port |
| `INKPAW_PLAYGROUND_PORT` | `8766` | Playground web port |
| `DOCX_MCP_TOKEN` | random for the launcher | Shared local MCP Bearer token |
| `DOCX_MCP_URL` | derived from the MCP port | Use an already running InkPaw MCP endpoint |

For advanced use, start the two processes separately:

```bash
npm run start:http
npm run playground:server
```

When started separately, both processes must use the same `DOCX_MCP_TOKEN` or the Playground must be able to read the generated `data/mcp-token`.

## Security boundary

The default server binds only to `127.0.0.1`. Do not expose it directly to the public internet.

A public deployment needs a separate security review and, at minimum, TLS, request/origin controls, rate limits, abuse protection, model-provider allowlists, egress/SSRF controls, secret handling, storage quotas, and an explicit retention policy. The repository intentionally does not include private deployment topology or production credentials.

## Internal flow

```text
Browser
  │  POST /api/chat (SSE response)
  ▼
Playground Agent Loop
  │  OpenAI-compatible model API
  │  MCP Streamable HTTP + per-user scope
  ▼
InkPaw service / store / renderer
  │
  └─ DOCX / PDF / PNG preview
```
