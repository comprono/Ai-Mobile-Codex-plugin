#!/usr/bin/env node
"use strict";

const { spawn } = require("node:child_process");
const { pluginVersion } = require("../lib/version");

const command = process.argv[2];
if (!command) process.exit(2);
const child = spawn(command, ["app-server", "--stdio"], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
let buffer = "";
let stderr = "";
const replies = {};
let initialized = false;
let finished = false;

function send(value) { child.stdin.write(`${JSON.stringify(value)}\n`); }
function finish() {
  if (finished) return;
  finished = true;
  try { child.stdin.end(); } catch { /* no-op */ }
  try { child.kill(); } catch { /* no-op */ }
  child.unref();
  const threads = Array.isArray(replies.threads?.data) ? replies.threads.data : [];
  const activeThreads = threads.filter((thread) => thread?.status?.type === "active");
  // Thread titles, previews, ids, turns, and prompt text deliberately stay out
  // of inventory and its on-disk cache. This signal is sufficient for routing.
  const threadSignal = replies.threads === undefined ? { supported: false } : {
    supported: true,
    activeCount: activeThreads.length,
    recentCount: threads.length,
    activeWorkspaceCount: activeThreads.filter((thread) => Boolean(thread?.cwd)).length,
  };
  process.stdout.write(`${JSON.stringify({ ok: Boolean(replies.rateLimits || replies.models), ...replies, threadSignal, diagnostic: stderr.slice(0, 500) })}\n`);
  setTimeout(() => process.exit(0), 20);
}
const timer = setTimeout(finish, 6000);

child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
child.stdout.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  const lines = buffer.split(/\r?\n/); buffer = lines.pop() || "";
  for (const line of lines) {
    if (!line.trim().startsWith("{")) continue;
    let message; try { message = JSON.parse(line); } catch { continue; }
    if (message.id === 1 && !initialized) {
      initialized = true;
      send({ method: "initialized", params: {} });
      send({ id: 2, method: "account/rateLimits/read", params: {} });
      send({ id: 3, method: "model/list", params: { limit: 100, includeHidden: false } });
      send({ id: 4, method: "account/usage/read", params: {} });
      send({ id: 5, method: "thread/list", params: { limit: 20, useStateDbOnly: true, sortKey: "recency_at", sortDirection: "desc" } });
    }
    if (message.id === 2) replies.rateLimits = message.result || null;
    if (message.id === 3) replies.models = message.result || null;
    if (message.id === 4) replies.usage = message.result || null;
    if (message.id === 5) replies.threads = message.result || null;
    if (replies.rateLimits && replies.models && replies.usage && replies.threads !== undefined) { clearTimeout(timer); finish(); }
  }
});
child.on("error", (error) => { stderr += error.message; clearTimeout(timer); finish(); });
send({ id: 1, method: "initialize", params: { clientInfo: { name: "ai-mobile", version: pluginVersion() }, capabilities: { experimentalApi: true } } });
