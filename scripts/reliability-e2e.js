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
fs.mkdirSync(path.join(workspace, ".codex"), { recursive: true });
fs.writeFileSync(path.join(workspace, ".codex", "PROJECT_OUTCOME.md"), [
  "# Project Outcome", "", "## North Star", "", "Ship the verified portable MCP outcome.", "",
].join("\n"), "utf8");
fs.writeFileSync(path.join(workspace, ".codex", "ACCEPTANCE.json"), JSON.stringify({
  schema_version: 1,
  project_state: "active",
  current_slice_requirement_id: "A1",
  requirements: [{ id: "A1", description: "MCP lifecycle completes", required: true, status: "failing", minimum_evidence_level: "end-to-end", evidence: [] }],
}, null, 2) + "\n", "utf8");
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
  assert.equal(listed.result.tools.length, 18);
  const started = toolValue(await call("tools/call", { name: "start-task", arguments: { workspace, outcome: "Perform a bounded architecture review.", userRequest: "Fix and ship the verified portable MCP outcome." } }));
  assert.match(started.taskId, /^task-/);
  assert.equal(started.outcome, "Ship the verified portable MCP outcome.");
  assert.equal(started.outcomeReconciliation.changed, true);
  assert.equal(started.workPlane.plan.requirementId, "A1");
  assert.equal(started.currentCodex.role, "project-console");
  const reconciled = toolValue(await call("tools/call", { name: "reconcile-task", arguments: { taskId: started.taskId, userRequest: "Fix and ship the verified portable MCP outcome.", refreshProjectContext: true } }));
  assert.equal(reconciled.reconciliationAllowed, true);
  assert.equal(reconciled.contractVersion, 2);
  const summary = toolValue(await call("tools/call", { name: "task-summary", arguments: { taskId: started.taskId } }));
  assert.equal(summary.progress.passing, 0);
  const refused = toolValue(await call("tools/call", { name: "complete-task", arguments: { taskId: started.taskId } }));
  assert.equal(refused.completionAllowed, false);
  const evidenced = toolValue(await call("tools/call", { name: "record-evidence", arguments: { taskId: started.taskId, evidence: [{ requirementId: "A1", level: "end-to-end", ref: "portable-mcp", summary: "stdio lifecycle verified", passed: true }] } }));
  assert.equal(evidenced.progress.passing, 1);
  const completed = toolValue(await call("tools/call", { name: "complete-task", arguments: { taskId: started.taskId } }));
  assert.equal(completed.completionAllowed, true);
  process.stdout.write(`${JSON.stringify({ ok: true, tools: 18, taskId: started.taskId, outcomeRecoveredThroughMcp: true, noProviderProcessRequired: true }, null, 2)}\n`);
})().catch((error) => { process.stderr.write(`${error.stack || error.message}\n`); process.exitCode = 1; }).finally(() => {
  try { child.kill(); } catch { /* no-op */ }
  fs.rmSync(root, { recursive: true, force: true });
});
