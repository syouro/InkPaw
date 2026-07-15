#!/usr/bin/env node
"use strict";

// One-command local experience: start the authenticated InkPaw HTTP MCP server,
// wait until it is ready, then start the browser Playground against that server.

const crypto = require("node:crypto");
const path = require("node:path");
const { spawn } = require("node:child_process");

const ROOT = path.join(__dirname, "..");
const mcpPort = String(process.env.DOCX_MCP_PORT || 8765);
const playgroundPort = String(process.env.INKPAW_PLAYGROUND_PORT || 8766);
const token = process.env.DOCX_MCP_TOKEN || `local_${crypto.randomBytes(24).toString("base64url")}`;
const env = {
  ...process.env,
  DOCX_MCP_PORT: mcpPort,
  DOCX_MCP_TOKEN: token,
  DOCX_MCP_URL: process.env.DOCX_MCP_URL || `http://127.0.0.1:${mcpPort}/mcp`,
  INKPAW_PLAYGROUND_PORT: playgroundPort,
};

let mcp;
let playground;
let stopping = false;
let readyTimer;

const child = (file, args, options = {}) => spawn(process.execPath, [path.join(ROOT, file), ...args], {
  cwd: ROOT,
  env,
  stdio: options.stdio || "inherit",
});

const stop = (signal = "SIGTERM", exitCode = 0) => {
  if (stopping) return;
  stopping = true;
  clearTimeout(readyTimer);
  if (playground && !playground.killed) playground.kill(signal);
  if (mcp && !mcp.killed) mcp.kill(signal);
  setTimeout(() => process.exit(exitCode), 500).unref();
};

const startPlayground = () => {
  if (playground || stopping) return;
  clearTimeout(readyTimer);
  playground = child("playground/server.js", []);
  playground.on("exit", (code, signal) => {
    if (!stopping) {
      console.error(`[inkpaw] Playground stopped (${signal || `exit ${code}`}).`);
      stop("SIGTERM", code || 1);
    }
  });
};

mcp = child("src/server.js", ["--http"], { stdio: ["inherit", "inherit", "pipe"] });
mcp.stderr.on("data", (chunk) => {
  process.stderr.write(chunk);
  if (String(chunk).includes("Streamable HTTP 已启动")) startPlayground();
});
mcp.on("exit", (code, signal) => {
  if (!stopping) {
    console.error(`[inkpaw] MCP server stopped (${signal || `exit ${code}`}).`);
    stop("SIGTERM", code || 1);
  }
});

readyTimer = setTimeout(() => {
  console.error("[inkpaw] MCP server did not become ready within 15 seconds.");
  stop("SIGTERM", 1);
}, 15000);

process.on("SIGINT", () => stop("SIGINT", 0));
process.on("SIGTERM", () => stop("SIGTERM", 0));
