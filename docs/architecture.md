# Architecture

InkPaw 将“Agent 如何表达文档意图”与“Word 文件如何正确产出”分成独立层。模型面向结构化 def 和 MCP 工具，渲染层面向 DOCX/OOXML。

## Layers

```text
MCP client / direct service caller
                │
                ▼
Transport: stdio or stateless Streamable HTTP
                │
                ▼
MCP tool schemas and tool registration
                │
                ▼
Service: lifecycle, ownership, validation, persistence
                │
       ┌────────┼────────┐
       ▼        ▼        ▼
 SQLite store  Validator  Transform
                         numbering / refs / captions
                │
                ▼
Protocol-independent DOCX renderer
                │
                ▼
DOCX → optional PDF/PNG → validation feedback
```

## Main modules

- `src/server.js`: chooses stdio or HTTP transport and applies HTTP authentication/isolation.
- `src/mcp-server.js`: publishes model-facing tool schemas and delegates to the service.
- `src/service.js`: document lifecycle, validation gates, persistence, templates and render orchestration.
- `src/store.js`: SQLite document and template metadata.
- `src/validator.js`: validates external def input and returns model-actionable issues.
- `src/transform.js`: resolves numbering, captions, references and other semantic sugar into renderer input.
- `src/docxUtil.js`: protocol-independent renderer; it does not depend on MCP or SQLite.
- `src/presets.js`: preset/profile/document style resolution.
- `src/markdown/`: Markdown to native document-node conversion.
- `src/template.js`: registered DOCX template inspection and slot replacement.

## Document lifecycle

1. A caller creates a document from def JSON, Markdown, or a registered template.
2. The service normalizes the input, assigns stable node IDs and validates the result.
3. The normalized document is stored in SQLite so later Agent turns can query or mutate exact nodes.
4. Before rendering, the service resolves preset/profile/document styles and blocks error-level validation issues.
5. The transform layer expands server-owned semantics such as numbering and cross-references.
6. The renderer creates OOXML and applies compatibility fixes for known Word/LibreOffice/WPS differences.
7. Optional preview/PDF steps invoke LibreOffice and poppler.
8. The caller receives paths, an outline and structured validation feedback.

## Design invariants

- Models own content and structural intent; deterministic code owns formatting correctness.
- Every editable node has a stable ID. Cross-references target IDs, not fragile display numbers.
- Style values live in presets/profiles/document metadata, not hard-coded business templates.
- Invalid external input is rejected at boundaries; render output is independently verifiable.
- The renderer stays usable without MCP and without SQLite.
- Destructive or ambiguous model actions should be discoverable and repairable through validation feedback.

## HTTP security and isolation

HTTP mode is stateless. Local compatibility mode requires the shared bearer token supplied through `DOCX_MCP_TOKEN` or generated under `data/mcp-token`.

Public deployments use `DOCX_MCP_AUTH=oauth`. InkPaw then exposes RFC 9728/RFC 8414 discovery, OAuth authorization code with PKCE S256, dynamic client registration, access and rotating refresh tokens, RFC 7009 revocation, and an owner-facing authorization management page. Access tokens are short-lived, bound to the configured MCP resource URL, and mapped to an isolated user scope. See `docs/public-oauth-deployment.zh-CN.md`.

An authenticated, trusted gateway may set `X-Docx-Scope-User: <uuid>`. When present, InkPaw uses an isolated SQLite database, output directory, template directory and style profile under that user scope. The header must never be accepted from an untrusted client before gateway authentication. Direct stdio use and HTTP requests without the scope header use the global local workspace.

Scoped services reject server-path input/output primitives and apply coarse storage limits. This prevents an Agent operating in a user scope from turning template registration or rendering into arbitrary filesystem access.

## Validation strategy

InkPaw uses several complementary checks:

- def/schema validation before persistence and rendering;
- unit/integration tests that inspect unpacked DOCX XML;
- OPC relationship and content-type validation;
- ECMA-376 Transitional XSD validation after MCE preprocessing;
- explicit checks for Word implementation traps not caught by the standard schema;
- LibreOffice-based PDF/PNG rendering for visual review;
- manual Word/WPS checks for viewer-specific behavior that cannot be automated locally.

No single viewer or validator is treated as a complete oracle. See `docs/compatibility.md` and `docs/upstream-issues.md` for the observed differences.
