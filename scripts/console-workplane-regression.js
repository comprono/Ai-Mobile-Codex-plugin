#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-mobile-console-workplane-"));
process.env.AI_MOBILE_DATA_ROOT = path.join(root, "state");
process.env.LOCALAPPDATA = path.join(root, "local");
const workspace = path.join(root, "workspace");
fs.mkdirSync(workspace, { recursive: true });
fs.writeFileSync(path.join(workspace, "README.md"), "# Console work-plane fixture\n", "utf8");

const { dispatchRound, startTask } = require("./core/task-orchestrator");

const resources = {
  generatedAt: new Date().toISOString(),
  providers: {
    codex: {
      available: true,
      authenticated: true,
      authMode: "chatgpt",
      command: "codex",
      models: [{ id: "future-codex-frontier", description: "frontier capable model", supportedReasoningEfforts: ["low", "high"] }],
      capacity: { effectiveRemainingPercent: 82, source: "fixture" },
      quotaPools: [],
    },
    claude: {
      available: true,
      authenticated: true,
      authMode: "subscription",
      command: "claude",
      models: [{ id: "future-claude-capable" }],
      capacity: { remainingPercent: 76, source: "fixture" },
      quotaPools: [],
    },
    antigravity: {
      available: true,
      authenticated: true,
      authMode: "cli-session",
      command: "agy",
      models: [{ id: "future-flash", displayName: "Future Flash" }],
      capacity: { remainingPercent: 90, source: "fixture" },
      quotaPools: [],
    },
    cursor: { available: false, authenticated: false, reason: "not installed", models: [], quotaPools: [] },
  },
};

let sequence = 0;
function fakeCreate(contract) {
  sequence += 1;
  return {
    taskId: contract.taskId,
    jobId: "job-console-" + String(sequence).padStart(4, "0"),
    state: "running",
    provider: contract.provider,
    model: contract.model || "",
    isolation: contract.readOnly ? "shared-read-only" : "isolated-git-worktree",
  };
}

try {
  const task = startTask({
    workspace,
    outcome: "Ship one verified feature",
    acceptanceEvidence: [{ description: "The feature passes end to end", minimumEvidenceLevel: "end-to-end" }],
    consoleModel: "gpt-5.6-luna",
    consoleEffort: "low",
    codexReservePercent: 15,
  }, resources);

  assert.equal(task.console.role, "project-console");
  assert.equal(task.console.model, "gpt-5.6-luna");
  assert.equal(task.console.effort, "low");
  assert.equal(task.console.ownsProjectFiles, false);
  assert.deepEqual(task.console.files, []);
  assert.equal(task.execution.mode, "console-workplane");
  assert.equal(task.execution.mustDispatchNow, true);
  assert.equal(task.execution.mustStartNow, false);
  assert.equal(task.workPlane.recommendedWorkUnits.length, 1);
  assert.equal(task.workPlane.recommendedWorkUnits[0].workPlaneRequired, true);
  assert.deepEqual(task.workPlane.recommendedWorkUnits[0].relevantFiles, ["README.md"]);
  assert.equal(task.workPlane.recommendedWorkUnits[0].timeoutSeconds, 600);

  const round = dispatchRound({ taskId: task.taskId }, resources, {}, fakeCreate);
  assert.equal(round.state, "running");
  assert.equal(round.workers.length, 1);
  assert.equal(round.execution.status, "workers-running");
  assert.equal(round.execution.mustStartNow, false);
  assert.equal(round.execution.mustDispatchNow, false);
  assert.equal(round.currentCodex.role, "project-console");
  assert.deepEqual(round.currentCodex.files, []);
  assert.ok(["codex", "claude", "antigravity"].includes(round.workers[0].provider));
  assert.notEqual(round.workers[0].model, "gpt-5.6-luna");
  assert.equal(round.resources.selected[0].actor, "visible-console");
  assert.equal(round.resources.selected[1].actor, "external-worker");

  const second = startTask({
    workspace,
    outcome: "Ship another verified feature",
    acceptanceEvidence: ["The second feature passes end to end"],
    consoleModel: "gpt-5.6-luna",
  }, resources);
  assert.throws(() => dispatchRound({
    taskId: second.taskId,
    currentCodex: { files: ["src"] },
  }, resources, {}, fakeCreate), /console cannot own project files/i);

  const unavailable = {
    generatedAt: new Date().toISOString(),
    providers: Object.fromEntries(Object.keys(resources.providers).map((id) => [id, {
      available: false,
      authenticated: false,
      reason: "fixture unavailable",
      models: [],
      quotaPools: [],
    }])),
  };
  const third = startTask({
    workspace,
    outcome: "Ship a blocked fixture",
    acceptanceEvidence: ["The blocked fixture passes end to end"],
    consoleModel: "gpt-5.6-luna",
  }, unavailable);
  const blocked = dispatchRound({ taskId: third.taskId }, unavailable, {}, fakeCreate);
  assert.equal(blocked.state, "blocked");
  assert.equal(blocked.workers.length, 0);
  assert.equal(blocked.execution.mustStartNow, false);
  assert.equal(blocked.execution.mustDispatchNow, false);
  assert.match(blocked.rejected[0].reason, /No eligible provider/i);

  const skill = fs.readFileSync(path.join(__dirname, "..", "skills", "ai-mobile", "SKILL.md"), "utf8");
  const fix = skill.indexOf("fixes the plugin");
  const noSwitch = skill.indexOf("Do not switch the visible task");
  const closeDesktop = skill.indexOf("closes only OpenAI.Codex");
  const reopen = skill.indexOf("immediately reopens the exact OpenAI.Codex task");
  const verify = skill.indexOf("requires its runtimeVersion");
  const switchAfter = skill.indexOf("Only after that tool evidence");
  assert.ok(fix >= 0 && fix < noSwitch && noSwitch < closeDesktop && closeDesktop < reopen && reopen < verify && verify < switchAfter);
  assert.match(skill, /If nothing changed, emit nothing\./);
  assert.match(skill, /immediately pause that same heartbeat/);
  const server = fs.readFileSync(path.join(__dirname, "mcp", "server.js"), "utf8");
  assert.ok(server.indexOf('name === "prepare-restart-handoff"') < server.indexOf("assertCurrentRuntime();"));

  process.stdout.write(JSON.stringify({
    ok: true,
    consoleOwnsProjectFiles: false,
    workerDispatched: round.workers[0].provider,
    unavailableFailsClosed: true,
    restartSequenceEnforced: true,
    terminalReporterStops: true,
    staleRuntimeCanPrepareRestart: true,
  }, null, 2) + String.fromCharCode(10));
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
