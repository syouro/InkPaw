# DeepSeek 集成指南

[English](deepseek.md) | 简体中文

InkPaw Playground 支持通用 OpenAI 兼容模型接口，并针对 DeepSeek 思考模式下的工具调用做了显式适配。

## 推荐配置

启动本地 Playground：

```bash
npm install
npm run playground
```

打开 `http://127.0.0.1:8766`。首次进入时会预填：

| 设置 | 推荐值 |
|---|---|
| API 接口地址 | `https://api.deepseek.com` |
| 模型 | `deepseek-v4-flash` |
| 深度思考 | 开启 |
| API Key | 你自己的 DeepSeek API Key |

InkPaw 推荐使用 `deepseek-v4-flash` 作为交互式文档工作的起点。接口和模型仍可编辑，也可以改用 `deepseek-v4-pro` 或其他兼容服务商。

## InkPaw 做了哪些适配

Playground Agent Loop 以 OpenAI Chat Completions 数据结构为基础，并增加了以下 DeepSeek 处理：

1. 对官方 `api.deepseek.com` 接口，InkPaw 始终显式发送 `thinking.type` 为 `enabled` 或 `disabled`，不依赖服务端默认值。
2. 将流式 `delta.reasoning_content` 与最终 `content` 分开收集，并在网页推理区域独立展示。
3. 按 call index 聚合流式返回的工具调用参数片段，再执行完整工具调用。
4. 思考模式产生工具调用时，将完整 `reasoning_content` 保存在 assistant 消息中，并随工具结果一起回传。DeepSeek 的续轮协议要求保留这段上下文，缺失时可能返回 HTTP 400。
5. 每条用户消息最多执行 20 次模型/工具往返，防止 Agent Loop 失控。

这些逻辑位于 `playground/agent.js`。浏览器通过 SSE 接收归一化后的 reasoning、content、tool-start、tool-end、usage 和 preview 事件。

## 深度思考开关

对于 DeepSeek 官方接口，Playground 复选框具有明确语义：

- 勾选 → `{"thinking":{"type":"enabled"}}`；
- 不勾选 → `{"thinking":{"type":"disabled"}}`。

对于其他 OpenAI 兼容接口，DeepSeek 扩展参数仍保持按需发送，因为部分服务商会拒绝未知字段。如果第三方网关暴露了 DeepSeek 原生请求与响应字段，请勾选深度思考，并确认网关在工具调用期间不会丢弃 `reasoning_content`。

## 工具调用要求

所选模型必须支持 function/tool calling。InkPaw 会将 MCP 工具 Schema 转换为 OpenAI function 定义，并使用对应的 `tool_call_id` 回传每次工具结果。

系统提示会要求模型：

- 不确定文档节点写法时先查询示例；
- 将编号与排版交给 InkPaw；
- 渲染前清除校验错误；
- 续聊修改时使用稳定节点 ID；
- 创建或修改完成后执行渲染，让 Playground 展示预览。

## 常见问题

### 工具调用后返回 HTTP 400

优先使用官方接口并保持深度思考开启。如果代理服务从 assistant 工具调用消息中删除了 `reasoning_content`，就无法正确延续 DeepSeek 思考模式的 Agent Loop。

### 模型没有调用工具

确认所选模型支持工具调用，并确认 API 网关会原样转发 `tools` 和 `tool_calls` 字段。

### 推理区域没有内容

确认已经开启深度思考，并确认服务商会流式返回 `reasoning_content`。最终回答文本位于独立的 `content` 字段。

### 文档已生成但没有逐页预览

这通常与模型接口无关。安装 LibreOffice Writer/Math 和 poppler-utils，然后重新启动 Playground。

## 安全说明

DeepSeek API Key 保存在浏览器 `localStorage`，并发送给本机 Playground 服务做内存转发。InkPaw 不会将其写入 SQLite 或日志。不要把实验性 Playground 未经加固直接暴露到公网。

## 参考资料

- [DeepSeek API：首次调用](https://api-docs.deepseek.com/)
- [DeepSeek API：思考模式](https://api-docs.deepseek.com/guides/thinking_mode)
- [DeepSeek API：工具调用](https://api-docs.deepseek.com/guides/tool_calls)
