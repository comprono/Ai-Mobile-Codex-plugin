"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { boundaryAllows, statusPaths } = require("./git-evidence");
const { setStatus, statusFor } = require("./job-store");
const { jobDirectory, safeId } = require("./state-store");
const { runVerification } = require("./verification");
const { commandResult, readJson, utcNow, writeJson } = require("./utils");
const { rollbackPrimaryWorkspace } = require("./workspace-isolation");

function failure(taskId, jobId, reason, extra = {}) {
  const value = { taskId, jobId, integrated: false, blocker: reason, ...extra };
  const dir = jobDirectory(taskId, jobId);
  writeJson(path.join(dir, "integration-evidence.json"), { ...value, generatedAt: utcNow() });
  return value;
}

function reversePatch(workspace, patchPath) {
  const check = commandResult("git", ["-C", workspace, "apply", "--reverse", "--check", "--whitespace=nowarn", patchPath], { timeout: 30000, maxBuffer: 1024 * 1024 });
  if (check.status !== 0) return { rolledBack: false, error: String(check.stderr || check.stdout).trim().slice(0, 500) };
  const result = commandResult("git", ["-C", workspace, "apply", "--reverse", "--whitespace=nowarn", patchPath], { timeout: 30000, maxBuffer: 1024 * 1024 });
  return { rolledBack: result.status === 0, error: result.status === 0 ? "" : String(result.stderr || result.stdout).trim().slice(0, 500) };
}

function hookFailure(taskId, jobId, stage, error, rollback = null) {
  const message = String(error?.message || error || "integration hook failed").slice(0, 1000);
  const rollbackResult = typeof rollback === "function"
    ? (() => {
      try { return rollback(); }
      catch (rollbackError) { return { rolledBack: false, error: String(rollbackError.message || rollbackError).slice(0, 500) }; }
    })()
    : null;
  const rollbackIncomplete = rollbackResult && rollbackResult.rolledBack !== true;
  const blocker = rollbackIncomplete ? `${stage}-rollback-incomplete: ${message}` : `${stage}: ${message}`;
  const recoveryAction = rollbackIncomplete
    ? "Stop automatic integration. Inspect the bounded changed files and restore the rejected patch before any retry."
    : "";
  setStatus(taskId, jobId, {
    integratedAt: null,
    integrationState: rollbackIncomplete ? "rollback-incomplete" : "failed",
    integrationBlocker: blocker,
    ...(recoveryAction ? { recoveryAction } : {}),
  });
  return failure(taskId, jobId, blocker, rollbackResult ? { rollback: rollbackResult, ...(recoveryAction ? { recoveryAction } : {}) } : {});
}

function runHook(options, name, candidate) {
  if (typeof options?.[name] !== "function") return null;
  options[name](candidate);
  return true;
}

function preservedVerificationRecovery(status, handoff, priorVerification, options = {}) {
  const recovery = options.preservedVerificationRecovery;
  if (!recovery || typeof recovery !== "object") return null;
  const changedFiles = Array.isArray(handoff.changedFiles) ? handoff.changedFiles : [];
  const failedChecks = (priorVerification?.checks || []).filter((check) => check?.passed === false);
  const fingerprintsChanged = (
    String(recovery.priorRuntimeFingerprint || "").trim()
    && String(recovery.repairedRuntimeFingerprint || "").trim()
    && recovery.priorRuntimeFingerprint !== recovery.repairedRuntimeFingerprint
  );
  const eligible = (
    status.state === "failed"
    && Number(status.exitCode) === 0
    && handoff.state === "failed"
    && handoff.patchAvailable === true
    && changedFiles.length > 0
    && /^Verification failed:/i.test(String(status.blocker || handoff.blocker || ""))
    && failedChecks.length === 1
    && /spawnSync pytest(?:\.exe)? ENOENT/i.test(String(failedChecks[0].stderr || failedChecks[0].error || ""))
    && fingerprintsChanged
    && Array.isArray(recovery.evidence)
    && recovery.evidence.length > 0
  );
  return eligible ? {
    priorRuntimeFingerprint: recovery.priorRuntimeFingerprint,
    repairedRuntimeFingerprint: recovery.repairedRuntimeFingerprint,
    evidence: recovery.evidence,
  } : null;
}

function integrateJob(taskIdValue, jobIdValue, options = {}) {
  const taskId = safeId(taskIdValue, "task");
  const jobId = safeId(jobIdValue, "job");
  const dir = jobDirectory(taskId, jobId);
  const status = statusFor(taskId, jobId);
  const contract = readJson(path.join(dir, "contract.json"), null);
  if (!contract) return failure(taskId, jobId, "missing-worker-contract");
  const handoff = readJson(path.join(dir, "handoff.json"), {});
  const priorVerification = readJson(path.join(dir, "verification-evidence.json"), null);
  const preservedRecovery = preservedVerificationRecovery(status, handoff, priorVerification, options);
  if (status.state !== "completed" && !preservedRecovery) return failure(taskId, jobId, "worker-not-completed: " + status.state);

  const existing = readJson(path.join(dir, "integration-evidence.json"), null);
  if (status.integratedAt && existing?.integrated === true) return { ...existing, alreadyIntegrated: true };

  if (contract.skipModelReview === true) {
    const verification = readJson(path.join(dir, "verification-evidence.json"), null);
    if (!verification?.required || verification.passed !== true) return failure(taskId, jobId, "trusted-primary-verification-missing");
    const changedFiles = readJson(path.join(dir, "changed-files.json"), []);
    const result = {
      taskId,
      jobId,
      integrated: true,
      alreadyInPrimaryWorkspace: true,
      changedFiles,
      verification,
      generatedAt: utcNow(),
    };
    try {
      runHook(options, "finalize", result);
    } catch (error) {
      return hookFailure(taskId, jobId, "integration-finalization-failed", error, () => rollbackPrimaryWorkspace(contract.isolation || {}, changedFiles));
    }
    writeJson(path.join(dir, "integration-evidence.json"), result);
    setStatus(taskId, jobId, { integratedAt: result.generatedAt, integrationState: "passed" });
    return result;
  }

  if (contract.readOnly === true) return failure(taskId, jobId, "read-only-worker-result-requires-acceptance-evaluation");
  if (!Array.isArray(contract.verificationCommands) || !contract.verificationCommands.length) {
    return failure(taskId, jobId, "deterministic-verification-required-before-primary-integration");
  }

  const workspace = path.resolve(String(contract.workspace || ""));
  const patchPath = path.join(dir, "worker.diff");
  const changedFiles = readJson(path.join(dir, "changed-files.json"), []);
  if (!changedFiles.length || !fs.existsSync(patchPath) || !fs.statSync(patchPath).size) {
    return failure(taskId, jobId, "completed-writer-produced-no-integratable-patch");
  }
  const expectedFiles = Array.isArray(contract.expectedFiles) ? contract.expectedFiles : [];
  const outside = changedFiles.filter((file) => !boundaryAllows(file, expectedFiles));
  if (outside.length) return failure(taskId, jobId, "worker-boundary-violation", { outside });

  const dirty = statusPaths(workspace);
  if (!dirty.available) return failure(taskId, jobId, "primary-git-status-unavailable");
  const changedKeys = new Set(changedFiles.map((file) => String(file).toLowerCase()));
  const conflicts = dirty.paths.filter((file) => changedKeys.has(String(file).toLowerCase()));
  if (conflicts.length) return failure(taskId, jobId, "primary-files-changed-since-dispatch", { conflicts });

  const check = commandResult("git", ["-C", workspace, "apply", "--check", "--whitespace=nowarn", patchPath], { timeout: 30000, maxBuffer: 1024 * 1024 });
  if (check.status !== 0) return failure(taskId, jobId, "patch-check-failed", { error: String(check.stderr || check.stdout).trim().slice(0, 1000) });
  try {
    runHook(options, "beforeApply", { taskId, jobId, changedFiles, workspace });
  } catch (error) {
    return hookFailure(taskId, jobId, "integration-precondition-failed", error);
  }
  const apply = commandResult("git", ["-C", workspace, "apply", "--whitespace=nowarn", patchPath], { timeout: 30000, maxBuffer: 1024 * 1024 });
  if (apply.status !== 0) return failure(taskId, jobId, "patch-apply-failed", { error: String(apply.stderr || apply.stdout).trim().slice(0, 1000) });

  const integrationDir = path.join(dir, "integration");
  fs.mkdirSync(integrationDir, { recursive: true });
  const verification = runVerification(workspace, integrationDir, contract.verificationCommands);
  if (!verification.required || verification.passed !== true) {
    const rollback = reversePatch(workspace, patchPath);
    return failure(taskId, jobId, "primary-verification-failed", { verification, rollback });
  }

  const result = {
    taskId,
    jobId,
    integrated: true,
    alreadyInPrimaryWorkspace: false,
    changedFiles,
    verification,
    ...(preservedRecovery ? { preservedVerificationRecovery: preservedRecovery } : {}),
    generatedAt: utcNow(),
  };
  try {
    runHook(options, "finalize", result);
  } catch (error) {
    return hookFailure(taskId, jobId, "integration-finalization-failed", error, () => reversePatch(workspace, patchPath));
  }
  writeJson(path.join(dir, "integration-evidence.json"), result);
  setStatus(taskId, jobId, { integratedAt: result.generatedAt, integrationState: "passed" });
  return result;
}

module.exports = { integrateJob, preservedVerificationRecovery };
