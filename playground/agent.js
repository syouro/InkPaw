"use strict";
// agent 循环：OpenAI 兼容流式对话 + 工具调用回传，直到模型不再要工具。
// 事件通过 onEvent 回调外发（SSE 层负责编码）。llm 配置（baseURL/apiKey/model）
// 每次调用由外部传入——BYOK，本模块不持有、不记录 key。

const OpenAI = require("openai");

const MAX_ITERATIONS = 20; // 防失控：一轮用户消息最多 20 次模型往返

// 流式 tool_call 增量累积：id/name 早到，arguments 分片到达，按 index 聚合。
function accumulateToolCallDeltas(acc, deltas) {
  for (const tc of deltas) {
    const idx = tc.index ?? 0;
    const cur = acc.get(idx) || { id: "", name: "", args: "" };
    if (tc.id) cur.id = tc.id;
    if (tc.function && tc.function.name) cur.name = tc.function.name;
    if (tc.function && tc.function.arguments) cur.args += tc.function.arguments;
    acc.set(idx, cur);
  }
}

function safeParseArgs(raw) {
  if (typeof raw !== "string") return raw || {};
  try { return JSON.parse(raw); } catch { return {}; }
}

function isOfficialDeepSeekEndpoint(baseURL) {
  try {
    const host = new URL(baseURL).hostname.toLowerCase();
    return host === "api.deepseek.com";
  } catch {
    return false;
  }
}

// DeepSeek currently defaults thinking mode to enabled, so its official endpoint
// must receive an explicit enabled/disabled value. Other compatible endpoints keep
// the previous opt-in behavior because they may reject this extension parameter.
function thinkingParams(llm) {
  if (isOfficialDeepSeekEndpoint(llm.baseURL)) {
    return { thinking: { type: llm.thinking ? "enabled" : "disabled" } };
  }
  return llm.thinking ? { thinking: { type: "enabled" } } : {};
}

function buildAssistantMessage({ content, reasoning, toolCalls, llm }) {
  const message = { role: "assistant", content: content || null };
  if (toolCalls.length) {
    message.tool_calls = toolCalls.map((t) => ({
      id: t.id,
      type: "function",
      function: { name: t.name, arguments: t.args || "{}" },
    }));
  }
  if (!message.content && !toolCalls.length) message.content = reasoning || " ";
  else if (reasoning && (llm.thinking || isOfficialDeepSeekEndpoint(llm.baseURL))) {
    message.reasoning_content = reasoning;
  }
  return message;
}

/**
 * 跑一轮 agent（一条用户消息到模型收口）。
 * @param {object} opts
 * @param {{baseURL:string, apiKey:string, model:string, thinking?:boolean}} opts.llm
 * @param {string} opts.systemPrompt
 * @param {Array} opts.messages OpenAI 格式历史（不含 system），会被原地追加本轮新消息
 * @param {Array} opts.tools OpenAI function 格式工具清单
 * @param {(name:string, args:object)=>Promise<{text:string,isError:boolean}>} opts.callTool
 * @param {(ev:object)=>void} opts.onEvent
 * @param {AbortSignal} [opts.signal]
 */
async function runAgentTurn({ llm, systemPrompt, messages, tools, callTool, onEvent, signal }) {
  const client = new OpenAI({ baseURL: llm.baseURL, apiKey: llm.apiKey });
  const usage = { inputTokens: 0, outputTokens: 0 };

  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    const params = {
      model: llm.model,
      messages: [{ role: "system", content: systemPrompt }, ...messages],
      stream: true,
      stream_options: { include_usage: true },
      ...(tools.length ? { tools } : {}),
      ...thinkingParams(llm),
    };

    const stream = await client.chat.completions.create(params, { signal });
    const toolAcc = new Map();
    let content = "";
    let reasoning = "";

    for await (const chunk of stream) {
      const delta = chunk.choices && chunk.choices[0] && chunk.choices[0].delta;
      if (delta) {
        if (delta.reasoning_content) {
          reasoning += delta.reasoning_content;
          onEvent({ type: "reasoning", delta: delta.reasoning_content });
        }
        if (delta.content) {
          content += delta.content;
          onEvent({ type: "content", delta: delta.content });
        }
        if (delta.tool_calls) accumulateToolCallDeltas(toolAcc, delta.tool_calls);
      }
      if (chunk.usage) {
        usage.inputTokens += chunk.usage.prompt_tokens || 0;
        usage.outputTokens += chunk.usage.completion_tokens || 0;
      }
    }

    const toolCalls = [...toolAcc.values()].filter((t) => t.id && t.name);

    // 组装 assistant 消息入历史。DeepSeek 约定：assistant 必须有 content 或 tool_calls 之一；
    // 部分 OpenAI 兼容端点要求工具轮次回传 reasoning_content。
    const assistantMsg = buildAssistantMessage({ content, reasoning, toolCalls, llm });
    messages.push(assistantMsg);

    if (!toolCalls.length) break; // 模型收口，本轮结束

    for (const tc of toolCalls) {
      const args = safeParseArgs(tc.args);
      onEvent({ type: "tool_start", id: tc.id, name: tc.name, args });
      let result;
      try {
        result = await callTool(tc.name, args);
      } catch (e) {
        result = { text: `工具执行失败：${e.message}`, isError: true };
      }
      onEvent({ type: "tool_end", id: tc.id, name: tc.name, isError: result.isError });
      messages.push({ role: "tool", tool_call_id: tc.id, content: result.text || "(空结果)" });
    }
  }

  onEvent({ type: "usage", ...usage });
  return usage;
}

module.exports = { runAgentTurn, isOfficialDeepSeekEndpoint, thinkingParams, buildAssistantMessage };
