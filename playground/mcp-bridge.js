"use strict";
// MCP 工具桥：连接 InkPaw 的 Streamable HTTP 端点，把工具清单转成 OpenAI function 格式，
// 并提供 callTool。Playground 不直接依赖服务层代码——走 MCP 协议，和外部客户端同一条路，
// 服务端加工具网页 agent 自动跟上。
// 每个匿名身份使用独立桥连接，传输头带 X-Docx-Scope-User；作用域由 Playground
// 服务端注入，模型的工具参数里不存在这个概念。

const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StreamableHTTPClientTransport } = require("@modelcontextprotocol/sdk/client/streamableHttp.js");

const MAX_RESULT_CHARS = 20000; // 工具结果超长截断，保护模型上下文

// 服务端为人工审阅界面提供的工具：Playground 自己调，但不进模型的工具表。
// 模型没有调它的理由，摆出来只会占上下文并诱发无用调用。
const UI_ONLY_TOOLS = new Set([
  "get_draft_html", "update_node_value", "get_doc_config", "update_doc_config",
  "update_draft_structure",
]);

class McpBridge {
  constructor(url, token, { scopeUser } = {}) {
    this.url = url;
    this.token = token || null;
    this.scopeUser = scopeUser || null;
    this.client = null;
    this.openaiTools = [];
  }

  async connect() {
    const client = new Client({ name: "inkpaw-playground", version: "0.1.0" });
    const headers = {};
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    if (this.scopeUser) headers["X-Docx-Scope-User"] = this.scopeUser;
    const opts = Object.keys(headers).length ? { requestInit: { headers } } : undefined;
    await client.connect(new StreamableHTTPClientTransport(new URL(this.url), opts));
    const { tools } = await client.listTools();
    this.client = client;
    this.openaiTools = tools.filter((t) => !UI_ONLY_TOOLS.has(t.name)).map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description || "",
        parameters: t.inputSchema || { type: "object", properties: {} },
      },
    }));
    return this.openaiTools.length;
  }

  // 返回 { text, isError }；MCP 内容块只取 text 部分拼接。
  // truncate=false 用于 UI 工具（草稿 HTML 整篇要完整，截断了页面就残缺）——
  // 截断是为了保护模型上下文，不进模型的结果不需要它。
  async callTool(name, args, { truncate = true } = {}) {
    if (!this.client) throw new Error("MCP 未连接");
    let res;
    try {
      res = await this.client.callTool({ name, arguments: args || {} });
    } catch (e) {
      // 连接层故障（InkPaw MCP 重启等）：重连一次再试
      await this.connect();
      res = await this.client.callTool({ name, arguments: args || {} });
    }
    let text = (res.content || [])
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n");
    if (truncate && text.length > MAX_RESULT_CHARS) {
      text = text.slice(0, MAX_RESULT_CHARS) + `\n…[结果超长，已截断至 ${MAX_RESULT_CHARS} 字符]`;
    }
    return { text, isError: !!res.isError };
  }

  async close() {
    if (this.client) {
      try { await this.client.close(); } catch { /* 已断无所谓 */ }
      this.client = null;
    }
  }
}

// 按 userId 缓存桥连接：有上限（挤最久未用）+ 闲置关闭，不为每请求无限建连
class BridgePool {
  constructor(url, token, { max = 16, idleMs = 15 * 60 * 1000 } = {}) {
    this.url = url;
    this.token = token;
    this.max = max;
    this.entries = new Map(); // userId -> { bridge, ready, lastUsed }
    this._sweeper = setInterval(() => {
      const now = Date.now();
      for (const [userId, e] of this.entries) {
        if (now - e.lastUsed > idleMs) { this.entries.delete(userId); e.bridge.close(); }
      }
    }, 5 * 60 * 1000);
    this._sweeper.unref();
  }

  async for(userId) {
    let e = this.entries.get(userId);
    if (!e) {
      if (this.entries.size >= this.max) {
        const oldest = [...this.entries.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
        if (oldest) { this.entries.delete(oldest[0]); oldest[1].bridge.close(); }
      }
      e = { bridge: new McpBridge(this.url, this.token, { scopeUser: userId }), ready: null, lastUsed: 0 };
      this.entries.set(userId, e);
    }
    e.lastUsed = Date.now();
    if (!e.ready) e.ready = e.bridge.connect();
    try {
      await e.ready;
    } catch (err) {
      // 连接失败的条目不留在池里，下次调用重试
      this.entries.delete(userId);
      throw err;
    }
    return e.bridge;
  }

  async closeAll() {
    clearInterval(this._sweeper);
    for (const [, e] of this.entries) await e.bridge.close();
    this.entries.clear();
  }
}

module.exports = { McpBridge, BridgePool };
