#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-mobile-v1-mcp-"));
const workspace = path.join(root, "workspace");
const stateRoot = path.join(root, "state");
fs.mkdirSync(workspace, { recursive: true });
fs.mkdirSync(stateRoot, { recursive: true });

const observedAt = new Date().toISOString();
const expiresAt = new Date(Date.now() + 30 * 1000).toISOString();
const providers = Object.fromEntries(["codex", "claude", "antigravity", "cursor"].map((id) => [id, { id, available: false, authenticated: false, confidence: "high", models: [], quotaPools: [], reason: "portable fixture", observedAt, expiresAt }]));
fs.writeFileSync(path.join(stateRoot, "resource-cache.json"), `${JSON.stringify({ schemaVersion: 3, generatedAt: observedAt, providers }, null, 2)}\n`, "utf8");

const entrypoint = path.join(__dirname, "ai-mobile-local-mcp.js");
const child = spawn(process.execPath, [entrypoint, "serve"], { cwd: path.dirname(entrypoint), env: { ...process.env, AI_MOBILE_DATA_ROOT: stateRoot, LOCALAPPDATA: path.join(root, "local") }, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
let buffer = "";
let nextId = 1;
const pending = new Map();
child.stdout.on("data", (chunk) => {
  buffer += chunk.toString();
  let index;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
    if (!line.trim()) continue;
    const message = JSON.parse(line); const resolve = pending.get(message.id); if (resolve) { pending.delete(message.id); resolve(message); }
  }
});

function call(method, params = {}) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`MCP timeout: ${method}`)); }, 10000);
    pending.set(id, (message) => { clearTimeout(timer); resolve(message); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
}
function toolValue(message) { return JSON.parse(message.result.content[0].text); }

(async () => {
  const initialized = await call("initialize", { protocolVersion: "2025-03-26" });
  assert.equal(initialized.result.serverInfo.name, "ai-mobile-local");
  const listed = await call("tools/list");
  assert.equal(listed.result.tools.length, 9);
  const started = toolValue(await call("tools/call", { name: "start-task", arguments: { workspace, outcome: "Verify portable MCP", acceptanceEvidence: ["MCP lifecycle completes"] } }));
  assert.match(started.taskId, /^task-/);
  const summary = toolValue(await call("tools/call", { name: "task-summary", arguments: { taskId: started.taskId } }));
  assert.equal(summary.progress.passing, 0);
  const refused = toolValue(await call("tools/call", { name: "complete-task", arguments: { taskId: started.taskId } }));
  assert.equal(refused.completionAllowed, false);
  const evidenced = toolValue(await call("tools/call", { name: "record-evidence", arguments: { taskId: started.taskId, evidence: [{ requirementId: "A1", level: "end-to-end", ref: "portable-mcp", summary: "stdio lifecycle verified", passed: true }] } }));
  assert.equal(evidenced.progress.passing, 1);
  const completed = toolValue(await call("tools/call", { name: "complete-task", arguments: { taskId: started.taskId } }));
  assert.equal(completed.completionAllowed, true);
  process.stdout.write(`${JSON.stringify({ ok: true, tools: 9, taskId: started.taskId, noProviderProcessRequired: true }, null, 2)}\n`);
})().catch((error) => { process.stderr.write(`${error.stack || error.message}\n`); process.exitCode = 1; }).finally(() => {
  try { child.kill(); } catch { /* no-op */ }
  fs.rmSync(root, { recursive: true, force: true });
});
