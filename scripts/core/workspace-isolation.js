"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { commandResult, processAlive, readJson, safeWorkspace, utcNow, writeJson } = require("./utils");
const { stateRoot } = require("./state-store");
const { readProfile } = require("../lib/orchestrator-profile");
const { boundaryAllows } = require("./git-evidence");

const { trustedPrimaryDecision } = require("./trusted-models");
const TRANSIENT_PATHS = [
  "node_modules", ".pnpm-store", ".yarn", ".cache", ".pytest_cache", ".mypy_cache", ".ruff_cache",
  "__pycache__", ".venv", "venv", "env", "logs", "log", "coverage", ".coverage", "dist", "build",
  ".next", ".nuxt", "target", "tmp", "temp",
];

function normalized(value) {
  let resolved = path.resolve(String(value || ""));
  try {
    resolved = (fs.realpathSync.native || fs.realpathSync)(resolved);
  } catch { /* compare the resolved input when the path does not exist yet */ }
  return resolved.replace(/\\/g, "/").replace(/\/$/, "").toLowerCase();
}

function worktreeRoot() { return path.join(stateRoot(), "worktrees"); }
function metadataRoot() { return path.join(stateRoot(), "worktree-metadata"); }
function metadataFile(jobId) { return path.join(metadataRoot(), `${jobId}.json`); }

function directoryBytes(root) {
  if (!fs.existsSync(root)) return 0;
  let total = 0;
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) {
        try { total += fs.statSync(full).size; } catch { /* raced cleanup */ }
      }
    }
  }
  return total;
}

function storageStatus(profileValue) {
  const profile = profileValue || readProfile();
  fs.mkdirSync(stateRoot(), { recursive: true });
  const bytes = directoryBytes(worktreeRoot());
  let freeBytes = Number.POSITIVE_INFINITY;
  try {
    const stats = fs.statfsSync(stateRoot());
    freeBytes = Number(stats.bavail) * Number(stats.bsize);
  } catch { /* old Node versions retain quota enforcement only */ }
  return {
    bytes,
    usedMb: Math.ceil(bytes / (1024 * 1024)),
    freeMb: Number.isFinite(freeBytes) ? Math.floor(freeBytes / (1024 * 1024)) : null,
    quotaMb: profile.worktreeDiskQuotaMb,
    minimumFreeMb: profile.worktreeMinFreeMb,
    withinQuota: bytes <= profile.worktreeDiskQuotaMb * 1024 * 1024,
    hasMinimumFree: !Number.isFinite(freeBytes) || freeBytes >= profile.worktreeMinFreeMb * 1024 * 1024,
  };
}

function assertStorageAvailable(profile) {
  const status = storageStatus(profile);
  if (!status.withinQuota || status.usedMb >= profile.worktreeDiskQuotaMb) {
    throw new Error(`Worktree storage quota (${profile.worktreeDiskQuotaMb} MB) is exhausted; collect or clean existing worker worktrees first.`);
  }
  if (!status.hasMinimumFree) {
    throw new Error(`Disk free space (${status.freeMb} MB) is below the configured ${profile.worktreeMinFreeMb} MB worktree floor.`);
  }
  return status;
}

function preparePrimaryWorkspace(workspaceValue, contract, profileValue) {
  const workspace = safeWorkspace(workspaceValue);
  const profile = profileValue || readProfile();
  const decision = trustedPrimaryDecision(contract, profile);
  if (!decision.trusted) throw new Error(`Trusted primary workspace denied: ${decision.reason}.`);

  const rootProbe = commandResult("git", ["-C", workspace, "rev-parse", "--show-toplevel"], { timeout: 5000 });
  const root = String(rootProbe.stdout || "").trim();
  if (rootProbe.status !== 0 || normalized(root) !== normalized(workspace)) {
    throw new Error("Trusted primary writing requires the declared workspace to be a Git repository root.");
  }
  const ownedPaths = Array.isArray(contract.expectedFiles) ? contract.expectedFiles : [];
  if (!ownedPaths.length) throw new Error("Trusted primary writing requires explicit expectedFiles boundaries.");
  const dirty = commandResult("git", ["-C", workspace, "status", "--porcelain=v1", "--untracked-files=all"], { timeout: 10000, maxBuffer: 1024 * 1024 });
  if (dirty.status !== 0) throw new Error("Unable to verify trusted primary file ownership.");
  if (String(dirty.stdout || "").trim()) {
    throw new Error("Trusted primary writing requires a completely clean repository; use an isolated worktree or finish existing owners first.");
  }
  const head = commandResult("git", ["-C", workspace, "rev-parse", "HEAD"], { timeout: 5000 });
  return {
    mode: "trusted-primary-workspace",
    executionWorkspace: workspace,
    sourceWorkspace: workspace,
    cleanupRequired: false,
    trustedModel: decision.model,
    skipModelReview: true,
    baselineHead: String(head.stdout || "").trim(),
    ownedPaths,
    createdAt: utcNow(),
  };
}

function prepareWorkspaceForContract(contract, taskId, jobId, profileValue) {
  const workspace = safeWorkspace(contract.workspace);
  if (contract.readOnly === true) return { mode: "shared-read-only", executionWorkspace: workspace, cleanupRequired: false };
  const profile = profileValue || readProfile();
  const decision = trustedPrimaryDecision(contract, profile);
  if (decision.trusted) return preparePrimaryWorkspace(workspace, contract, profile);
  return prepareIsolatedWorkspace(workspace, taskId, jobId, false, profile);
}
function rollbackPrimaryWorkspace(isolation = {}, changedPaths = []) {
  if (isolation.mode !== "trusted-primary-workspace") return { rolledBack: false, reason: "not-trusted-primary" };
  const workspace = safeWorkspace(isolation.executionWorkspace);
  const baselineHead = String(isolation.baselineHead || "").trim();
  if (!baselineHead) return { rolledBack: false, reason: "missing-baseline-head" };
  const changed = [...new Set((changedPaths || []).map((item) => String(item || "").replace(/\\/g, "/")).filter(Boolean))];
  const ownedPaths = Array.isArray(isolation.ownedPaths) ? isolation.ownedPaths : [];
  const paths = changed.filter((relative) => boundaryAllows(relative, ownedPaths));
  const outsidePaths = changed.filter((relative) => !boundaryAllows(relative, ownedPaths));
  const failures = [];
  for (const relative of paths) {
    const full = path.resolve(workspace, relative);
    if (!normalized(full).startsWith(`${normalized(workspace)}/`)) {
      failures.push({ path: relative, reason: "outside-workspace" });
      continue;
    }
    const tracked = commandResult("git", ["-C", workspace, "ls-files", "--error-unmatch", "--", relative], { timeout: 5000 });
    if (tracked.status === 0) {
      const restore = commandResult("git", ["-C", workspace, "restore", "--source", baselineHead, "--staged", "--worktree", "--", relative], { timeout: 10000 });
      if (restore.status !== 0) failures.push({ path: relative, reason: String(restore.stderr || restore.stdout).trim().slice(0, 300) });
    } else {
      try { fs.rmSync(full, { recursive: true, force: true }); }
      catch (error) { failures.push({ path: relative, reason: String(error.message).slice(0, 300) }); }
    }
  }
  return { rolledBack: failures.length === 0 && outsidePaths.length === 0, paths, outsidePaths, failures };
}

function prepareIsolatedWorkspace(workspaceValue, taskId, jobId, readOnly, profileValue) {
  const workspace = safeWorkspace(workspaceValue);
  if (readOnly) return { mode: "shared-read-only", executionWorkspace: workspace, cleanupRequired: false };
  const profile = profileValue || readProfile();
  assertStorageAvailable(profile);

  const rootProbe = commandResult("git", ["-C", workspace, "rev-parse", "--show-toplevel"], { timeout: 5000 });
  if (rootProbe.status !== 0) throw new Error("Writer delegation requires a Git repository; use a read-only worker or define a testable isolated writer boundary.");
  const prefixProbe = commandResult("git", ["-C", workspace, "rev-parse", "--show-prefix"], { timeout: 5000 });
  if (prefixProbe.status !== 0 || String(prefixProbe.stdout || "").trim()) {
    throw new Error("Writer delegation requires the task workspace to be the Git repository root.");
  }

  const target = path.join(worktreeRoot(), taskId, jobId);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.rmSync(target, { recursive: true, force: true });
  const result = commandResult("git", ["-C", workspace, "worktree", "add", "--detach", target, "HEAD"], { timeout: 30000, maxBuffer: 2 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`Unable to create isolated writer worktree: ${(result.stderr || result.stdout).trim().slice(0, 500)}`);
  const isolation = {
    mode: "isolated-git-worktree",
    executionWorkspace: target,
    sourceWorkspace: workspace,
    taskId,
    jobId,
    metadataFile: metadataFile(jobId),
    cleanupRequired: true,
    createdAt: utcNow(),
  };
  writeJson(isolation.metadataFile, isolation);
  const after = storageStatus(profile);
  if (!after.withinQuota || !after.hasMinimumFree) {
    cleanupIsolatedWorkspace(isolation);
    throw new Error(`Creating the writer worktree would violate storage limits (${after.usedMb}/${after.quotaMb} MB used, ${after.freeMb ?? "unknown"} MB free).`);
  }
  return isolation;
}

function cleanTransientOutputs(isolation = {}) {
  if (isolation.mode !== "isolated-git-worktree" || !isolation.executionWorkspace) return { cleaned: false, reason: "not-isolated" };
  const workspace = isolation.executionWorkspace;
  commandResult("git", ["-C", workspace, "clean", "-fdX"], { timeout: 30000, maxBuffer: 1024 * 1024 });
  const result = commandResult("git", ["-C", workspace, "clean", "-fd", "--", ...TRANSIENT_PATHS], { timeout: 30000, maxBuffer: 1024 * 1024 });
  const transientNames = new Set(TRANSIENT_PATHS.map((value) => path.basename(value).toLowerCase()));
  const stack = [workspace];
  while (stack.length) {
    const current = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (entry.name === ".git") continue;
      const full = path.join(current, entry.name);
      if (transientNames.has(entry.name.toLowerCase())) fs.rmSync(full, { recursive: true, force: true });
      else if (entry.isDirectory()) stack.push(full);
    }
  }
  return { cleaned: result.status === 0, paths: TRANSIENT_PATHS };
}

function cleanupIsolatedWorkspace(isolation = {}) {
  if (!isolation.cleanupRequired || !isolation.executionWorkspace || !isolation.sourceWorkspace) return { cleaned: false, reason: "not-required" };
  const result = commandResult("git", ["-C", isolation.sourceWorkspace, "worktree", "remove", "--force", isolation.executionWorkspace], { timeout: 30000, maxBuffer: 1024 * 1024 });
  if (result.status !== 0) {
    fs.rmSync(isolation.executionWorkspace, { recursive: true, force: true });
    commandResult("git", ["-C", isolation.sourceWorkspace, "worktree", "prune"], { timeout: 10000 });
  }
  try { fs.rmSync(isolation.metadataFile || metadataFile(isolation.jobId), { force: true }); } catch { /* no-op */ }
  return result.status === 0
    ? { cleaned: true }
    : { cleaned: true, warning: String(result.stderr || result.stdout).trim().slice(0, 300) };
}

function jobStatusFor(meta) {
  return readJson(path.join(stateRoot(), "tasks", String(meta.taskId || ""), "jobs", String(meta.jobId || ""), "status.json"), null);
}

function cleanupAbandonedWorktrees(profileValue) {
  const profile = profileValue || readProfile();
  const root = metadataRoot();
  if (!fs.existsSync(root)) return { inspected: 0, cleaned: 0, reasons: {} };
  const files = fs.readdirSync(root).filter((name) => name.endsWith(".json"));
  const result = { inspected: files.length, cleaned: 0, reasons: {} };
  const terminal = new Set(["completed", "failed", "cancelled", "rejected"]);
  const maxAgeMs = profile.worktreeMaxAgeHours * 60 * 60 * 1000;
  for (const name of files) {
    const meta = readJson(path.join(root, name), null);
    if (!meta) { fs.rmSync(path.join(root, name), { force: true }); continue; }
    const status = jobStatusFor(meta);
    const ageMs = Date.now() - Date.parse(meta.createdAt || "");
    let reason = "";
    if (!status) reason = "missing-job";
    else if (terminal.has(status.state)) reason = "terminal-job";
    else if (status.pid && !processAlive(status.pid)) reason = "lost-worker";
    else if (Number.isFinite(ageMs) && ageMs > maxAgeMs) reason = "maximum-age";
    if (!reason) continue;
    cleanupIsolatedWorkspace(meta);
    result.cleaned += 1;
    result.reasons[reason] = (result.reasons[reason] || 0) + 1;
  }
  return result;
}

module.exports = {
  TRANSIENT_PATHS,
  assertStorageAvailable,
  cleanTransientOutputs,
  cleanupAbandonedWorktrees,
  cleanupIsolatedWorkspace,
  directoryBytes,
  metadataFile,
  preparePrimaryWorkspace,
  prepareWorkspaceForContract,
  prepareIsolatedWorkspace,
  rollbackPrimaryWorkspace,
  storageStatus,
  worktreeRoot,
};
