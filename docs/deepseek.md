# DeepSeek integration

English | [简体中文](deepseek.zh-CN.md)

InkPaw Playground supports OpenAI-compatible model APIs and includes an explicit adapter for DeepSeek thinking-mode tool calls.

## Recommended configuration

Start the local Playground:

```bash
npm install
npm run playground
```

Open `http://127.0.0.1:8766`. The first-run settings are prefilled with:

| Setting | Recommended value |
|---|---|
| API base URL | `https://api.deepseek.com` |
| Model | `deepseek-v4-flash` |
| Thinking | enabled |
| API key | your own DeepSeek API key |

`deepseek-v4-flash` is InkPaw's recommended starting model for interactive document work. The endpoint and model remain editable, so the Playground can also use `deepseek-v4-pro` or another compatible provider.

## What InkPaw adapts

The Playground Agent Loop is based on the OpenAI Chat Completions shape, with additional DeepSeek handling:

1. For the official `api.deepseek.com` endpoint, InkPaw explicitly sends `thinking.type` as `enabled` or `disabled`. This avoids relying on the provider's default.
2. Streaming `delta.reasoning_content` is collected separately from final `content` and displayed in the reasoning panel.
3. Streaming tool-call fragments are combined by call index before execution.
4. When a thinking response performs a tool call, its complete `reasoning_content` is retained in the assistant message and sent back with the tool result. DeepSeek requires this continuation context and may return HTTP 400 when it is missing.
5. A single user turn is capped at 20 model/tool iterations to prevent an uncontrolled Agent Loop.

These behaviors live in `playground/agent.js`. The browser receives normalized reasoning, content, tool-start, tool-end, usage, and preview events over SSE.

## Thinking toggle

For the official DeepSeek endpoint, the Playground checkbox has explicit semantics:

- checked → `{"thinking":{"type":"enabled"}}`;
- unchecked → `{"thinking":{"type":"disabled"}}`.

For another OpenAI-compatible base URL, the DeepSeek extension remains opt-in because some providers reject unknown request fields. If a third-party gateway exposes DeepSeek's native request and response fields, enable the checkbox and confirm that the gateway preserves `reasoning_content` during tool calls.

## Tool requirements

The selected model must support function/tool calling. InkPaw sends its MCP tool schemas as OpenAI-format function definitions and returns each tool result with the matching `tool_call_id`.

The system prompt asks the model to:

- query examples when it is unsure about a document node;
- let InkPaw own numbering and layout;
- fix validation errors before rendering;
- use stable node IDs for follow-up edits;
- render after creation or modification so the Playground can show a preview.

## Troubleshooting

### HTTP 400 after a tool call

Use the official endpoint directly where possible and keep thinking enabled. A proxy that removes `reasoning_content` from assistant tool-call messages cannot correctly continue DeepSeek thinking-mode Agent Loops.

### No tool calls

Confirm that the selected model supports tool calling and that the API gateway forwards the `tools` and `tool_calls` fields unchanged.

### Reasoning panel is empty

Confirm that thinking is enabled and that the provider streams `reasoning_content`. Final answer text is carried separately in `content`.

### Document exists but no page preview appears

Model compatibility is not the cause. Install LibreOffice Writer/Math and poppler-utils, then restart the Playground.

## Security

The DeepSeek API key is stored in browser `localStorage` and sent to the localhost Playground server for in-memory forwarding. InkPaw does not persist it in SQLite or logs. Do not expose the experimental Playground directly to the public internet.

## References

- [DeepSeek API: first API call](https://api-docs.deepseek.com/)
- [DeepSeek API: thinking mode](https://api-docs.deepseek.com/guides/thinking_mode)
- [DeepSeek API: tool calls](https://api-docs.deepseek.com/guides/tool_calls)
