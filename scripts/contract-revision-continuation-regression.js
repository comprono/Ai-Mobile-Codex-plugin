#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-mobile-contract-revision-"));
process.env.AI_MOBILE_DATA_ROOT = path.join(root, "state");
process.env.LOCALAPPDATA = path.join(root, "local");
const workspace = path.join(root, "workspace");
fs.mkdirSync(path.join(workspace, ".codex"), { recursive: true });
fs.writeFileSync(path.join(workspace, ".codex", "PROJECT_OUTCOME.md"), "# Project Outcome\n\nState: active\n\n## North Star\n\nContinue after a contract correction.\n", "utf8");
fs.writeFileSync(path.join(workspace, ".codex", "ACCEPTANCE.json"), JSON.stringify({
  schema_version: 1,
  project_state: "active",
  current_slice_requirement_id: "REVISION",
  requirements: [{
    id: "REVISION",
    description: "A stale worker round is discarded and the corrected contract continues.",
    required: true,
    status: "failing",
    minimum_evidence_level: "integration",
    evidence: [],
  }],
}, null, 2) + "\n", "utf8");

const { runCoordinator } = require("./core/coordinator");
const { dispatchRound, reconcileTask, startTask } = require("./core/task-orchestrator");
const { jobDirectory, readRound, taskDirectory } = require("./core/state-store");
const { readMaterialEvents } = require("./core/material-events");
const { writeJson } = require("./core/utils");

const unavailableResources = {
  generatedAt: new Date().toISOString(),
  machine: { freeRamMb: 8000, totalRamMb: 16000, logicalCpuCount: 8 },
  worktreeStorage: { freeMb: 20000, minimumFreeMb: 1, quotaMb: 2048, withinQuota: true, hasMinimumFree: true },
  providers: {
    codex: { id: "codex", available: false, authenticated: true, headless: true, models: [], quotaPools: [] },
    claude: { id: "claude", available: false, authenticated: true, headless: true, models: [], quotaPools: [] },
    antigravity: { id: "antigravity", available: false, authenticated: true, headless: true, models: [], quotaPools: [] },
  },
};
const dispatchResources = {
  ...unavailableResources,
  providers: {
    ...unavailableResources.providers,
    claude: {
      id: "claude",
      available: true,
      authenticated: true,
      headless: true,
      authMode: "subscription",
      command: process.execPath,
      models: [{ id: "sonnet-fixture", displayName: "sonnet-fixture", capabilityTier: "balanced" }],
      surfaces: { headless: true, source: true, "local-files": true },
      permissions: {},
      capacity: { remainingPercent: 80, source: "fixture" },
      quotaPools: [],
    },
  },
};

function runningJob(contract) {
  const jobId = "job-contract-revision-running";
  const dir = jobDirectory(contract.taskId, jobId);
  fs.mkdirSync(dir, { recursive: true });
  writeJson(path.join(dir, "contract.json"), { ...contract, taskId: contract.taskId, jobId });
  writeJson(path.join(dir, "status.json"), {
    taskId: contract.taskId,
    jobId,
    state: "running",
    provider: contract.provider,
    model: contract.model,
    pid: null,
    createdAt: new Date().toISOString(),
  });
  return { taskId: contract.taskId, jobId, state: "queued", provider: contract.provider, model: contract.model, readOnly: true };
}

(async () => {
  try {
    const task = startTask({
      workspace,
      outcome: "Continue the corrected contract without a coordinator crash.",
      acceptanceEvidence: [{
        id: "REVISION",
        description: "A stale worker round is discarded and the corrected contract continues.",
        minimumEvidenceLevel: "integration",
      }],
      outcomeAuthority: "user",
    }, dispatchResources);
    const round = dispatchRound({
      taskId: task.taskId,
      workUnits: [{
        goal: "Read the stale contract fixture.",
        workGraphNodeId: "R-REVISION",
        independenceReason: "Read-only fixture.",
        relevantFiles: [".codex/PROJECT_OUTCOME.md"],
        readOnly: true,
        complexity: "large",
        taskKind: "review",
        estimatedDirectTokens: 12000,
      }],
    }, dispatchResources, {}, runningJob);
    assert.equal(round.workers.length, 1, JSON.stringify(round));

    const executionId = "execution-contract-revision-continuation";
    writeJson(path.join(taskDirectory(task.taskId), "coordinator.json"), {
      schemaVersion: 1,
      executionId,
      state: "running",
      pid: process.pid,
      roundsStarted: 1,
      lastRoundId: round.roundId,
      startedAt: new Date().toISOString(),
    });

    const coordinatorPromise = runCoordinator({
      taskId: task.taskId,
      executionId,
      config: { maxRounds: 1, maxMinutes: 1, noProgressLimit: 1, horizonHours: 1 },
    }, path.join(__dirname, "ai-mobile-local-mcp.js"), {
      inventory: async () => unavailableResources,
      providerHistory: () => ({}),
      createJob: () => { throw new Error("The corrected fixture has no eligible provider."); },
    });

    await new Promise((resolve) => setTimeout(resolve, 100));
    const reconciled = reconcileTask({
      taskId: task.taskId,
      userRequest: "Use the corrected contract and discard stale worker ownership.",
      constraints: ["Do not collect or integrate the stale round."],
      cancelActiveWorkers: true,
    });
    assert.equal(reconciled.reconciliationAllowed, true);
    assert.equal(readRound(task.taskId, round.roundId).state, "invalidated");

    const result = await coordinatorPromise;
    assert.notEqual(result.stopReason, "coordinator-failed", JSON.stringify(result));
    const events = readMaterialEvents({ taskId: task.taskId, maxEvents: 50 }).events
      .filter((event) => event.executionId === executionId);
    assert.ok(events.some((event) => event.type === "round.invalidated" && event.state === "superseded"));
    assert.equal(events.some((event) => event.type === "coordinator.failed"), false);
    process.stdout.write(JSON.stringify({
      ok: true,
      staleRoundDiscarded: true,
      coordinatorCrashAvoided: true,
      stopReason: result.stopReason,
    }, null, 2) + "\n");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch((error) => {
  process.stderr.write((error.stack || error.message) + "\n");
  process.exitCode = 1;
});
