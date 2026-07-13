"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { TOOLS, handle } = require("./mcp/server");
const { route } = require("./core/router");
const { runVerification } = require("./core/verification");

function run() {
  const started = Date.now();
  assert.deepEqual(TOOLS.map((tool) => tool.name), ["orchestrator-profile", "resource-inventory", "run-efficient-task", "read-job", "verify-job", "cancel-job"]);
  const inv = { providers: { codex: { available: true, authenticated: true }, claude: { available: true, authenticated: true }, antigravity: { available: true, authenticated: true }, cursor: { available: false } } };
  assert.equal(route({ workspace: process.cwd(), goal: "tiny fix", readOnly: true, complexity: "small" }, inv).action, "direct");
  assert.equal(route({ workspace: process.cwd(), goal: "Review the repository architecture and return a bounded implementation recommendation with exact evidence.", readOnly: true, complexity: "large" }, inv).provider, "claude");
  assert.throws(() => route({ workspace: process.cwd(), goal: "write", readOnly: false }, inv), /expectedFiles/);
  assert.equal(route({ workspace: process.cwd(), goal: "Research this substantial browser workflow and report evidence.", readOnly: true, complexity: "large", preferredProvider: "antigravity" }, inv).action, "direct");
  assert.equal(route({ workspace: process.cwd(), goal: "Research this substantial browser workflow and report evidence.", readOnly: true, complexity: "large", preferredProvider: "antigravity", allowAntigravity: true }, inv).provider, "antigravity");
  const response = handle({ jsonrpc: "2.0", id: 1, method: "tools/list" }, __filename);
  assert.equal(response.result.tools.length, 6);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-mobile-test-"));
  const evidence = runVerification(temp, temp, [{ name: "node-version", command: "node", args: ["--version"] }]);
  assert.equal(evidence.passed, true);
  const source = fs.readFileSync(path.join(__dirname, "mcp", "server.js"), "utf8");
  for (const forbidden of ["run-project-manager", "project-manager-status", "heartbeat", "continuous-cycle"]) assert.equal(source.includes(forbidden), false);
  fs.rmSync(temp, { recursive: true, force: true });
  const assertions = 10;
  return { ok: true, assertions, durationMs: Date.now() - started, tools: TOOLS.length };
}

module.exports = { run };
