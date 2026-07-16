#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-mobile-v1-storage-"));
process.env.AI_MOBILE_DATA_ROOT = path.join(root, "state");
process.env.LOCALAPPDATA = path.join(root, "local");
const workspace = path.join(root, "workspace");
fs.mkdirSync(workspace, { recursive: true });
fs.writeFileSync(path.join(workspace, "tracked.txt"), "primary\n", "utf8");

function git(args) {
  const result = spawnSync("git", args, { cwd: workspace, encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}
git(["init"]);
git(["config", "user.email", "ai-mobile@example.invalid"]);
git(["config", "user.name", "AI Mobile Test"]);
git(["add", "."]);
git(["commit", "-m", "fixture"]);

const { readJson, writeJson } = require("./core/utils");
const { stateRoot } = require("./core/state-store");
const { cleanupAbandonedWorktrees, metadataFile, prepareIsolatedWorkspace, storageStatus, worktreeRoot } = require("./core/workspace-isolation");

const profile = { worktreeDiskQuotaMb: 64, worktreeMinFreeMb: 1, worktreeMaxAgeHours: 1 };
function status(taskId, jobId, value) {
  writeJson(path.join(stateRoot(), "tasks", taskId, "jobs", jobId, "status.json"), value);
}

try {
  const readOnly = prepareIsolatedWorkspace(workspace, "task-readonly-0001", "job-readonly-0001", true, profile);
  assert.equal(readOnly.mode, "shared-read-only");
  assert.equal(fs.existsSync(metadataFile("job-readonly-0001")), false);

  const crashTask = "task-crash-00000001";
  const crashJob = "job-crash-00000001";
  const crashed = prepareIsolatedWorkspace(workspace, crashTask, crashJob, false, profile);
  assert.equal(fs.existsSync(crashed.executionWorkspace), true);
  status(crashTask, crashJob, { state: "running", pid: 2147483647 });
  const crashCleanup = cleanupAbandonedWorktrees(profile);
  assert.equal(crashCleanup.reasons["lost-worker"], 1);
  assert.equal(fs.existsSync(crashed.executionWorkspace), false);

  const ageTask = "task-aged-000000001";
  const ageJob = "job-aged-000000001";
  const aged = prepareIsolatedWorkspace(workspace, ageTask, ageJob, false, profile);
  status(ageTask, ageJob, { state: "running", pid: process.pid });
  const agedMeta = readJson(metadataFile(ageJob), {});
  writeJson(metadataFile(ageJob), { ...agedMeta, createdAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString() });
  const ageCleanup = cleanupAbandonedWorktrees(profile);
  assert.equal(ageCleanup.reasons["maximum-age"], 1);
  assert.equal(fs.existsSync(aged.executionWorkspace), false);

  assert.throws(() => prepareIsolatedWorkspace(workspace, "task-quota-00000001", "job-quota-00000001", false, { ...profile, worktreeDiskQuotaMb: 0.0001 }), /violate storage limits|storage quota/i);
  assert.throws(() => prepareIsolatedWorkspace(workspace, "task-space-00000001", "job-space-00000001", false, { ...profile, worktreeMinFreeMb: Number.MAX_SAFE_INTEGER }), /Disk free space/i);

  const finalStorage = storageStatus(profile);
  assert.equal(finalStorage.withinQuota, true);
  assert.equal(fs.existsSync(worktreeRoot()) ? fs.readdirSync(worktreeRoot(), { recursive: true }).some((entry) => String(entry).includes("job-")) : false, false);
  assert.equal(fs.readFileSync(path.join(workspace, "tracked.txt"), "utf8"), "primary\n");

  process.stdout.write(`${JSON.stringify({ ok: true, readOnlyWorktrees: 0, crashCleanup: true, maximumAgeCleanup: true, quotaEnforced: true, minimumFreeSpaceEnforced: true, primaryWorktreeUntouched: true, storageUsedMb: finalStorage.usedMb }, null, 2)}\n`);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
