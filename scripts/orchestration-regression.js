#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-mobile-v1-orchestration-"));
process.env.AI_MOBILE_DATA_ROOT = path.join(root, "state");
process.env.LOCALAPPDATA = path.join(root, "local");
const workspace = path.join(root, "workspace");
fs.mkdirSync(path.join(workspace, "src", "api"), { recursive: true });
fs.mkdirSync(path.join(workspace, "src", "ui"), { recursive: true });
fs.mkdirSync(path.join(workspace, "tests"), { recursive: true });

const { startTask, dispatchRound } = require("./core/task-orchestrator");

const resources = { generatedAt: new Date().toISOString(), providers: {
  codex: { available: true, authenticated: true, authMode: "chatgpt", models: [{ id: "gpt-fixture", description: "balanced capable model" }], capacity: { effectiveRemainingPercent: 70 }, quotaPools: [] },
  claude: { available: true, authenticated: true, authMode: "subscription", models: [{ id: "sonnet" }], capacity: { remainingPercent: 80 }, quotaPools: [] },
  antigravity: { available: true, authenticated: true, authMode: "cli-session", models: [{ id: "gemini-flash", displayName: "Gemini Flash" }], capacity: { remainingPercent: 90 }, quotaPools: [] },
  cursor: { available: false, authenticated: false, reason: "not installed", models: [], quotaPools: [] },
} };

let sequence = 0;
function fakeCreate(contract) { sequence += 1; return { taskId: contract.taskId, jobId: `job-fixture-${sequence.toString().padStart(4, "0")}`, state: "running", provider: contract.provider, model: contract.model || "", isolation: contract.readOnly ? "shared-read-only" : "isolated-git-worktree" }; }

try {
  const task = startTask({ workspace, outcome: "Ship the feature", acceptanceEvidence: ["End-to-end fixture passes"] }, resources);
  const round = dispatchRound({
    taskId: task.taskId,
    workUnits: [
      { goal: "Review UI accessibility and return exact findings", independenceReason: "UI inspection does not touch API implementation", relevantFiles: ["src/ui"], readOnly: true, complexity: "large", taskKind: "review", estimatedDirectTokens: 12000, integrationAction: "Apply confirmed UI fixes" },
      { goal: "Design independent test cases for user workflows", independenceReason: "Test design is separate from API implementation and UI review", relevantFiles: ["tests"], readOnly: true, complexity: "large", taskKind: "tests", estimatedDirectTokens: 12000, integrationAction: "Add accepted test cases" },
    ],
  }, resources, {}, fakeCreate);
  assert.equal(round.workers.length, 2);
  assert.equal(round.state, "running");
  assert.equal(round.currentCodex.role, "project-console");
  assert.deepEqual(round.currentCodex.files, []);
  assert.equal(round.execution.status, "workers-running");

  const directTask = startTask({ workspace, outcome: "Fix one typo", acceptanceEvidence: ["Typo is corrected"] }, resources);
  const direct = dispatchRound({ taskId: directTask.taskId, workUnits: [{ goal: "Review the README typo", independenceReason: "The console owns no project files", relevantFiles: ["README.md"], readOnly: true, complexity: "small", taskKind: "review", estimatedDirectTokens: 500 }] }, resources, {}, fakeCreate);
  assert.equal(direct.workers.length, 1);
  assert.equal(direct.state, "running");
  assert.equal(direct.rejected.length, 0);
  assert.equal(fs.existsSync(path.join(workspace, ".ai-mobile")), false);
  process.stdout.write(`${JSON.stringify({ ok: true, parallelWorkers: round.workers.length, smallTaskWorkers: direct.workers.length, consoleLightweight: true }, null, 2)}\n`);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
