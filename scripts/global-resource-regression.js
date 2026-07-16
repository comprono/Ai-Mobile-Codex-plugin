#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-mobile-v1-global-"));
process.env.AI_MOBILE_DATA_ROOT = path.join(root, "state");
process.env.LOCALAPPDATA = path.join(root, "local");
const workspace = path.join(root, "workspace");
fs.mkdirSync(path.join(workspace, "src"), { recursive: true });
fs.writeFileSync(path.join(workspace, "src", "shared.txt"), "shared\n", "utf8");

function git(args) {
  const result = spawnSync("git", args, { cwd: workspace, encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}
git(["init"]);
git(["config", "user.email", "ai-mobile@example.invalid"]);
git(["config", "user.name", "AI Mobile Test"]);
git(["add", "."]);
git(["commit", "-m", "fixture"]);

const sleeper = path.join(root, "sleeper.js");
fs.writeFileSync(sleeper, 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10000);process.stdout.write("done\\n");', "utf8");
let cursorCommand;
if (process.platform === "win32") {
  cursorCommand = path.join(root, "cursor-agent.cmd");
  fs.writeFileSync(cursorCommand, `@echo off\r\n"${process.execPath}" "${sleeper}" %*\r\n`, "utf8");
} else {
  cursorCommand = path.join(root, "cursor-agent");
  fs.writeFileSync(cursorCommand, `#!/bin/sh\n"${process.execPath}" "${sleeper}" "$@"\n`, "utf8");
  fs.chmodSync(cursorCommand, 0o755);
}

const { createJob, cancelJob } = require("./core/job-store");
const { acquireResourceLease, releaseResourceLease, resourceLeaseSnapshot } = require("./core/resource-leases");
const { createTaskRecord } = require("./core/state-store");
const { writeProfile } = require("./lib/orchestrator-profile");
const entrypoint = path.join(__dirname, "ai-mobile-local-mcp.js");

try {
  writeProfile({ maxGlobalWorkers: 2, maxWorkersPerProvider: 1, minimumFreeRamMb: 128 });
  const contract = (provider, pools, fairnessKey) => ({ taskId: "task-fixture-0001", provider, quotaPoolIds: pools, fairnessKey, workspace, timeoutSeconds: 60 });
  acquireResourceLease(contract("cursor", ["cursor:main"], "portfolio-a:project-a"), "job-lease-0001");
  assert.throws(() => acquireResourceLease(contract("cursor", ["cursor:other"], "portfolio-b:project-b"), "job-lease-0002"), /Provider worker limit/);
  assert.throws(() => acquireResourceLease(contract("claude", ["cursor:main"], "portfolio-b:project-b"), "job-lease-0003"), /Quota pool is already leased/);
  acquireResourceLease(contract("claude", ["claude:main"], "portfolio-b:project-b"), "job-lease-0004");
  assert.throws(() => acquireResourceLease(contract("antigravity", ["antigravity:main"], "portfolio-c:project-c"), "job-lease-0005"), /Machine-wide worker limit/);
  const snapshot = resourceLeaseSnapshot();
  assert.equal(snapshot.active.length, 2);
  assert.ok(snapshot.fairness["portfolio-a:project-a"]);
  assert.ok(snapshot.fairness["portfolio-b:project-b"]);
  releaseResourceLease("job-lease-0001");
  releaseResourceLease("job-lease-0004");

  const firstTask = createTaskRecord({ workspace, outcome: "First project", requirements: [] });
  const secondTask = createTaskRecord({ workspace, outcome: "Second project", requirements: [] });
  const first = createJob({
    taskId: firstTask.taskId, workspace, goal: "Edit shared ownership file for first project", projectGoal: "First project", currentCodexGoal: "Inspect another file", independenceReason: "Fixture",
    provider: "cursor", providerCommand: cursorCommand, providerAuthMode: "cli-session", quotaPoolIds: ["cursor:main"], fairnessKey: "project-one",
    readOnly: false, relevantFiles: ["src/shared.txt"], expectedFiles: ["src/shared.txt"], timeoutSeconds: 30, maxWorkerOutputTokens: 500, maxApiBudgetUsd: 0.1,
  }, entrypoint);
  assert.throws(() => createJob({
    taskId: secondTask.taskId, workspace, goal: "Edit shared ownership file for second project", projectGoal: "Second project", currentCodexGoal: "Inspect another file", independenceReason: "Fixture",
    provider: "antigravity", providerCommand: cursorCommand, providerAuthMode: "cli-session", quotaPoolIds: ["antigravity:main"], fairnessKey: "project-two",
    readOnly: false, relevantFiles: ["src/shared.txt"], expectedFiles: ["src/shared.txt"], timeoutSeconds: 30, maxWorkerOutputTokens: 500, maxApiBudgetUsd: 0.1,
  }, entrypoint), /file ownership overlaps/);
  const cancelled = cancelJob(first.taskId, first.jobId);
  assert.equal(cancelled.state, "cancelled");
  assert.equal(cancelled.workspaceCleanup.cleaned, true);
  assert.equal(resourceLeaseSnapshot().active.length, 0);

  process.stdout.write(`${JSON.stringify({ ok: true, providerConflictPrevented: true, quotaConflictPrevented: true, globalLimitEnforced: true, fileOwnershipConflictPrevented: true, fairnessRecorded: true }, null, 2)}\n`);
} finally {
  try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* Windows may release killed child handles after process exit. */ }
}
