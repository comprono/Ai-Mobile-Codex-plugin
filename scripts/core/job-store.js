"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { appendJsonl, bounded, processAlive, readJson, readText, terminateTree, utcNow, writeJson } = require("./utils");
const { boundariesOverlap, goalOverlap } = require("./lane-policy");
const { jobDirectory, listJobIds, listTaskIds, newId, readTask, safeId } = require("./state-store");
const { acquireResourceLease, bindLeasePid, releaseResourceLease } = require("./resource-leases");
const { cleanupIsolatedWorkspace, prepareWorkspaceForContract } = require("./workspace-isolation");

const TERMINAL_STATES = new Set(["completed", "failed", "cancelled", "rejected"]);

function event(dir, type, data = {}) {
  appendJsonl(path.join(dir, "events.jsonl"), { at: utcNow(), type, ...data });
}

function statusFile(taskId, jobId) { return path.join(jobDirectory(taskId, jobId), "status.json"); }

function setStatus(taskId, jobId, patch) {
  const file = statusFile(taskId, jobId);
  const current = readJson(file, {});
  const next = { ...current, ...patch, taskId, jobId, updatedAt: utcNow() };
  writeJson(file, next);
  return next;
}

function statusFor(taskId, jobId, reconcile = true) {
  const status = readJson(statusFile(taskId, jobId), null);
  if (!status) throw new Error(`AI Mobile job not found: ${jobId}`);
  if (reconcile && ["queued", "running"].includes(status.state) && status.pid && !processAlive(status.pid)) {
    const next = setStatus(taskId, jobId, {
      state: "failed",
      finishedAt: utcNow(),
      blocker: "worker-process-lost: the finite worker exited without a terminal handoff",
    });
    releaseResourceLease(jobId);
    const contract = readJson(path.join(jobDirectory(taskId, jobId), "contract.json"), {});
    cleanupIsolatedWorkspace(contract.isolation || {});
    return next;
  }
  return status;
}

function allJobsForWorkspace(workspace) {
  const rows = [];
  for (const taskId of listTaskIds()) {
    let task;
    try { task = readTask(taskId); } catch { continue; }
    if (String(task.workspace || "").toLowerCase() !== String(workspace || "").toLowerCase()) continue;
    for (const jobId of listJobIds(taskId)) {
      const dir = jobDirectory(taskId, jobId);
      const status = statusFor(taskId, jobId);
      const contract = readJson(path.join(dir, "contract.json"), {});
      rows.push({ taskId, jobId, dir, status, contract });
    }
  }
  return rows;
}

function activeJobs(workspace) {
  return allJobsForWorkspace(workspace).filter((row) => !TERMINAL_STATES.has(row.status.state));
}

function conflictFor(contract) {
  const requestedFiles = [...(contract.relevantFiles || []), ...(contract.expectedFiles || [])];
  for (const row of activeJobs(contract.workspace)) {
    const existingFiles = [...(row.contract.relevantFiles || []), ...(row.contract.expectedFiles || [])];
    const files = boundariesOverlap(requestedFiles, existingFiles);
    const goals = goalOverlap(contract.goal, row.contract.goal);
    if (files.length || goals.overlaps) {
      return {
        taskId: row.taskId,
        jobId: row.jobId,
        reason: files.length
          ? `Active worker file ownership overlaps: ${files.map((pair) => pair.join(" <-> ")).join(", ")}`
          : `Active worker goal overlaps: ${goals.shared.join(", ")}`,
      };
    }
  }
  return null;
}

function createJob(contract, entrypoint) {
  const taskId = safeId(contract.taskId, "task");
  const jobId = newId("job");
  const conflict = conflictFor(contract);
  if (conflict) throw new Error(`${conflict.reason}; existing job ${conflict.jobId}.`);

  const dir = jobDirectory(taskId, jobId);
  fs.mkdirSync(dir, { recursive: true });
  let lease;
  let isolation;
  try {
    lease = acquireResourceLease({ ...contract, taskId }, jobId);
    isolation = prepareWorkspaceForContract(contract, taskId, jobId);
  } catch (error) {
    if (lease) releaseResourceLease(jobId);
    fs.rmSync(dir, { recursive: true, force: true });
    throw error;
  }

  const stored = {
    ...contract,
    taskId,
    jobId,
    executionWorkspace: isolation.executionWorkspace,
    isolation,
    skipModelReview: isolation.skipModelReview === true,
    lease,
    createdAt: utcNow(),
  };
  writeJson(path.join(dir, "contract.json"), stored);
  writeJson(path.join(dir, "payload.json"), { taskId, jobId });
  setStatus(taskId, jobId, { state: "queued", provider: stored.provider, model: stored.model || "", createdAt: stored.createdAt, pid: null });
  event(dir, "job.created", { provider: stored.provider, model: stored.model || "", isolation: isolation.mode });

  let child;
  try {
    child = spawn(process.execPath, [entrypoint, "worker", "--json-file", path.join(dir, "payload.json")], {
      cwd: path.dirname(entrypoint),
      windowsHide: true,
      detached: false,
      stdio: "ignore",
    });
    child.unref();
    bindLeasePid(jobId, child.pid);
  } catch (error) {
    cleanupIsolatedWorkspace(isolation);
    releaseResourceLease(jobId);
    fs.rmSync(dir, { recursive: true, force: true });
    throw error;
  }
  setStatus(taskId, jobId, { state: "running", pid: child.pid, startedAt: utcNow() });
  return { taskId, jobId, state: "running", provider: stored.provider, model: stored.model || "", isolation: isolation.mode, skipModelReview: stored.skipModelReview };
}

function waitForTerminal(taskId, jobId, waitSeconds) {
  const deadline = Date.now() + Math.max(0, Math.min(300, Number(waitSeconds || 0))) * 1000;
  let status = statusFor(taskId, jobId);
  while (!TERMINAL_STATES.has(status.state) && Date.now() < deadline) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(250, deadline - Date.now()));
    status = statusFor(taskId, jobId);
  }
  return status;
}

function readJob(taskIdValue, jobIdValue, detail = "compact", waitSeconds = 0) {
  const taskId = safeId(taskIdValue, "task");
  const jobId = safeId(jobIdValue, "job");
  const dir = jobDirectory(taskId, jobId);
  if (!fs.existsSync(dir)) throw new Error(`AI Mobile job not found: ${jobId}`);
  const status = waitForTerminal(taskId, jobId, waitSeconds);
  const contract = readJson(path.join(dir, "contract.json"), {});
  const terminal = TERMINAL_STATES.has(status.state);
  const alreadyCollected = Boolean(status.collectedAt);

  const result = {
    taskId,
    jobId,
    state: status.state,
    terminal,
    provider: contract.provider || status.provider || "",
    model: contract.model || status.model || "",
    goal: contract.goal || "",
    isolation: contract.isolation?.mode || "",
    skipModelReview: contract.skipModelReview === true,
    workGraphNodeId: contract.workGraphNodeId || null,
    blocker: status.blocker || "",
    alreadyCollected,
    verification: readJson(path.join(dir, "verification-evidence.json"), null),
    usage: readJson(path.join(dir, "usage.json"), null),
    handoff: terminal && (!alreadyCollected || detail === "full")
      ? readJson(path.join(dir, "handoff.json"), null)
      : null,
    integration: terminal
      ? contract.skipModelReview === true && status.state === "completed"
        ? { required: false, alreadyInPrimaryWorkspace: true, action: contract.integrationAction || "", instruction: "Changes are already in the primary workspace and deterministic verification passed. Do not ask another model to re-review them; record acceptance-linked evidence or continue the next dependency." }
        : { required: status.state === "completed" && !alreadyCollected, action: contract.integrationAction || "", instruction: status.state === "completed" ? "Inspect the stored patch/evidence once, integrate only accepted work, then record acceptance evidence." : "Use this typed blocker once; do not retry without changed evidence." }
      : { required: false, instruction: "Continue current Codex work. Collect again only at the integration point or after a material provider transition." },
  };
  if (detail === "full") {
    result.result = readText(path.join(dir, "result.md"), 12000);
    result.patch = readText(path.join(dir, "worker.diff"), 60000);
    result.events = readText(path.join(dir, "events.jsonl"), 12000);
  }
  if (terminal && !alreadyCollected) {
    const cleanup = cleanupIsolatedWorkspace(contract.isolation || {});
    releaseResourceLease(jobId);
    setStatus(taskId, jobId, { collectedAt: utcNow(), workspaceCleanup: cleanup });
    result.workspaceCleanup = cleanup;
  }
  return result;
}

function cancelJob(taskIdValue, jobIdValue) {
  const taskId = safeId(taskIdValue, "task");
  const jobId = safeId(jobIdValue, "job");
  const status = statusFor(taskId, jobId);
  const dir = jobDirectory(taskId, jobId);
  const contract = readJson(path.join(dir, "contract.json"), {});
  if (TERMINAL_STATES.has(status.state)) {
    const cleanup = cleanupIsolatedWorkspace(contract.isolation || {});
    releaseResourceLease(jobId);
    return { taskId, jobId, state: status.state, alreadyTerminal: true, workspaceCleanup: cleanup };
  }
  const stopped = terminateTree(status.pid);
  const stopDeadline = Date.now() + 5000;
  while (status.pid && processAlive(status.pid) && Date.now() < stopDeadline) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
  const next = setStatus(taskId, jobId, { state: "cancelled", finishedAt: utcNow(), blocker: "Cancelled by caller." });
  const cleanup = cleanupIsolatedWorkspace(contract.isolation || {});
  releaseResourceLease(jobId);
  event(dir, "job.cancelled", { stopped, cleanup });
  return { taskId, jobId, state: next.state, stopped, workspaceCleanup: cleanup };
}

function cancelTaskJobs(taskId) {
  return listJobIds(taskId).map((jobId) => {
    try { return cancelJob(taskId, jobId); }
    catch (error) { return { taskId, jobId, error: bounded(error.message, 300) }; }
  });
}

module.exports = {
  TERMINAL_STATES,
  activeJobs,
  cancelJob,
  cancelTaskJobs,
  conflictFor,
  createJob,
  event,
  readJob,
  setStatus,
  statusFor,
};
