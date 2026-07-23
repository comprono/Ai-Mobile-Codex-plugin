"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { appendJsonl, bounded, processAlive, readJson, readText, terminateTree, utcNow, withDirectoryLock, writeJson } = require("./utils");
const { boundariesOverlap, goalOverlap } = require("./lane-policy");
const { jobDirectory, listJobIds, listTaskIds, newId, readTask, safeId, taskDirectory } = require("./state-store");
const { acquireResourceLease, bindLeasePid, releaseResourceLease } = require("./resource-leases");
const { cleanupIsolatedWorkspace, prepareWorkspaceForContract } = require("./workspace-isolation");
const { normalizeModelId } = require("./trusted-models");
const { assertDirectorAllocationBinding } = require("./director-worker-contract");
const { buildProgramResourceSnapshot } = require("./program-resource-snapshot");

const TERMINAL_STATES = new Set(["completed", "failed", "cancelled", "rejected"]);
const QUEUED_SPAWN_GRACE_MS = 60000;
const DISPOSABLE_CANARY_PHASES = new Set(["context", "strategy", "reconciliation", "execution", "verification"]);
const DISPOSABLE_CANARY_READ_ONLY_EXECUTORS = new Set([
  "context-scout",
  "strategist",
  "reconciliation",
  "evidence-observer",
  "verification",
]);

function pathInside(rootValue, candidateValue) {
  const root = path.resolve(String(rootValue || ""));
  const candidate = path.resolve(String(candidateValue || ""));
  const relative = path.relative(root, candidate);
  return Boolean(rootValue) && Boolean(candidateValue)
    && (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative)));
}

function disposableCanaryDecision(
  contract,
  policyValue = process.env.AI_MOBILE_CANARY_POLICY,
  workspaceRootValue = process.env.AI_MOBILE_CANARY_WORKSPACE_ROOT,
) {
  const policy = String(policyValue || "").trim();
  if (!policy) return { allowed: true, policy: "none" };
  if (policy !== "disposable-project") {
    return { allowed: false, reason: `release-canary-policy-unknown:${policy}` };
  }
  if (!pathInside(workspaceRootValue, contract?.workspace)) {
    return { allowed: false, reason: "release-canary-workspace-denied:contract-workspace-is-not-disposable" };
  }
  const phase = String(contract?.directorProgram?.phase || "").trim();
  if (!DISPOSABLE_CANARY_PHASES.has(phase)) {
    return { allowed: false, reason: `release-canary-phase-denied:${phase || "missing"}` };
  }
  const executor = String(contract?.executorKind || contract?.kind || "").trim();
  if (DISPOSABLE_CANARY_READ_ONLY_EXECUTORS.has(executor)) {
    return contract?.readOnly === true
      ? { allowed: true, policy, executor, phase }
      : { allowed: false, reason: `release-canary-read-only-required:${executor}` };
  }
  if (executor === "code-change") {
    if (String(contract?.deliverableKind || "") !== "patch") {
      return { allowed: false, reason: "release-canary-code-deliverable-denied:patch-required" };
    }
    if (contract?.readOnly === true || contract?.mutatesExternalState === true) {
      return { allowed: false, reason: "release-canary-code-boundary-denied:isolated-project-write-only" };
    }
    if (!(contract?.expectedFiles || []).length || !(contract?.verificationCommands || []).length) {
      return { allowed: false, reason: "release-canary-code-contract-incomplete" };
    }
    return { allowed: true, policy, executor, phase };
  }
  if (executor === "operational-transaction") {
    if (phase !== "execution" || String(contract?.deliverableKind || "") !== "operation-receipt") {
      return { allowed: false, reason: "release-canary-operation-contract-denied:execution-receipt-required" };
    }
    if (contract?.readOnly === true || contract?.mutatesExternalState === true) {
      return { allowed: false, reason: "release-canary-operation-boundary-denied:local-disposable-mutation-only" };
    }
    if (!(contract?.commands || []).length
      || !(contract?.relevantFiles || []).length
      || !(contract?.verificationCommands || []).length
      || !(contract?.preconditions || []).length
      || !(contract?.postconditions || []).length
      || !String(contract?.sideEffectKey || "").trim()
      || !String(contract?.observedStateFingerprint || "").trim()
      || !String(contract?.userAuthorizationRef || "").trim()
      || (!contract?.rollback && !String(contract?.recoveryAction || "").trim())) {
      return { allowed: false, reason: "release-canary-operation-contract-incomplete" };
    }
    return { allowed: true, policy, executor, phase };
  }
  return { allowed: false, reason: `release-canary-executor-denied:${executor || "missing"}:disposable-project-policy` };
}

function assertCanaryExecutorAllowed(
  contract,
  value = process.env.AI_MOBILE_CANARY_EXECUTOR_ALLOWLIST,
  phaseValue = process.env.AI_MOBILE_CANARY_PHASE_ALLOWLIST,
  policyValue = process.env.AI_MOBILE_CANARY_POLICY,
  workspaceRootValue = process.env.AI_MOBILE_CANARY_WORKSPACE_ROOT,
) {
  const configured = String(value || "").split(",").map((row) => row.trim()).filter(Boolean);
  const configuredPhases = String(phaseValue || "").split(",").map((row) => row.trim()).filter(Boolean);
  const executor = String(contract?.executorKind || contract?.kind || "").trim();
  if (configured.length && !configured.includes(executor)) {
    throw new Error(`release-canary-executor-denied:${executor || "missing"}:allowed=${configured.join(",")}`);
  }
  const phase = String(contract?.directorProgram?.phase || "").trim();
  if (configuredPhases.length && !configuredPhases.includes(phase)) {
    throw new Error(`release-canary-phase-denied:${phase || "missing"}:allowed=${configuredPhases.join(",")}`);
  }
  const decision = disposableCanaryDecision(contract, policyValue, workspaceRootValue);
  if (!decision.allowed) throw new Error(decision.reason);
  return true;
}

function allocationAttemptDescriptor(contract = {}) {
  if (!contract.directorProgram) return null;
  const binding = assertDirectorAllocationBinding(contract);
  const allocation = binding.allocation;
  if (!allocation || typeof allocation !== "object") throw new Error("director-allocation-missing");
  const allocationId = String(allocation.allocationId || "").trim();
  const workPackageId = String(allocation.workPackageId || "").trim();
  const expectedWorkPackageId = String(contract.directorProgram.workPackageId || "").trim();
  const maxAttempts = Math.floor(Number(allocation.maxAttempts || 0));
  const tokenLimit = Math.floor(Number(allocation.tokenLimit || 0));
  const durationLimitMs = Math.floor(Number(allocation.durationLimitMs || 0));
  const boundAllocationId = String(contract.directorWorkerContract?.executionEnvelope?.revisions?.allocationId || "").trim();
  const candidateId = String(allocation.candidateId || "").trim();
  const allocationProvider = String(allocation.provider || "").trim().toLowerCase();
  const contractProvider = String(contract.provider || "").trim().toLowerCase();
  const allocationModel = normalizeModelId(allocation.model);
  const contractModel = normalizeModelId(contract.model);
  if (!allocationId) throw new Error("director-allocation-id-missing");
  if (!candidateId) throw new Error("director-allocation-candidate-missing");
  if (!allocationProvider || !contractProvider || allocationProvider !== contractProvider) {
    throw new Error("director-allocation-provider-mismatch");
  }
  if (!allocationModel || !contractModel || allocationModel !== contractModel) {
    throw new Error("director-allocation-model-mismatch");
  }
  if (!workPackageId || workPackageId !== expectedWorkPackageId) throw new Error("director-allocation-work-package-mismatch");
  if (boundAllocationId && boundAllocationId !== allocationId) throw new Error("director-allocation-contract-mismatch");
  if (!Number.isFinite(maxAttempts) || maxAttempts < 1
    || !Number.isFinite(tokenLimit) || tokenLimit < 1
    || !Number.isFinite(durationLimitMs) || durationLimitMs < 1) throw new Error("director-allocation-limits-invalid");
  return { allocationId, workPackageId, maxAttempts, tokenLimit, durationLimitMs, candidateId, provider: allocationProvider, model: allocationModel };
}

function allocationClaimFile(taskId, jobId) {
  return path.join(jobDirectory(taskId, jobId), "allocation-attempt-claim.json");
}

function allocationIdentity(value = {}) {
  const allocation = value?.allocation && typeof value.allocation === "object" ? value.allocation : value;
  return {
    allocationId: String(allocation?.allocationId || "").trim(),
    workPackageId: String(allocation?.workPackageId || "").trim(),
  };
}

function updateAllocationClaim(taskId, jobId, patch = {}) {
  const file = allocationClaimFile(taskId, jobId);
  if (!fs.existsSync(file)) return null;
  return withDirectoryLock(file + ".lock", () => {
    const current = readJson(file, null);
    if (!current) return null;
    const next = { ...current, ...patch, updatedAt: utcNow() };
    writeJson(file, next);
    return next;
  });
}

function enforceProgramSupervisorClaim(taskId, descriptor) {
  let task;
  try { task = readTask(taskId); }
  catch { return; }
  const supervisor = task.program?.runtime?.programSupervisor || null;
  if (!supervisor || !["active", "waiting"].includes(String(supervisor.state || ""))) return;
  const limits = supervisor.limits || {};
  const snapshot = buildProgramResourceSnapshot({
    taskId,
    task,
    campaignCount: supervisor.campaignCount,
    limits,
  });
  const hardBlocker = (snapshot.capCheck?.blockers || [])[0]
    || (snapshot.blockers || []).find((row) => row.code !== "quota-capacity-unknown");
  if (hardBlocker) throw new Error(hardBlocker.code || "program-resource-accounting-unsafe");
  const claimBlockedMetrics = new Set(["artifacts", "durableBytes", "activeWorkers", "globalActiveWorkers"]);
  const exhausted = (snapshot.capCheck?.exhausted || []).find((row) => claimBlockedMetrics.has(row.metric));
  if (exhausted) throw new Error(exhausted.code || "program-resource-cap-exhausted");

  const observedAllocationIds = new Set((snapshot.authorization?.allocations || []).map((row) => row.allocationId));
  const pendingByAllocation = new Map();
  for (const priorJobId of listJobIds(taskId)) {
    const claimFile = allocationClaimFile(taskId, priorJobId);
    const claim = readJson(claimFile, null);
    if (!claim || claim.state === "abandoned" || observedAllocationIds.has(String(claim.allocationId || ""))) continue;
    if (claim.state === "claimed") {
      const ownerPid = Number(claim.childPid || claim.ownerPid || 0);
      if (ownerPid > 0 && !processAlive(ownerPid)) {
        writeJson(claimFile, {
          ...claim,
          state: "abandoned",
          abandonedReason: "claim owner exited before durable contract/status",
          reconciledAt: utcNow(),
          updatedAt: utcNow(),
        });
        continue;
      }
    }
    const allocationId = String(claim.allocationId || "").trim();
    const tokenLimit = Math.floor(Number(claim.tokenLimit || 0));
    const durationLimitMs = Math.floor(Number(claim.durationLimitMs || 0));
    const maxAttempts = Math.floor(Number(claim.maxAttempts || 0));
    if (!allocationId || tokenLimit < 1 || durationLimitMs < 1 || maxAttempts < 1) {
      throw new Error("program-pending-allocation-reservation-incomplete:" + priorJobId);
    }
    const current = pendingByAllocation.get(allocationId);
    const bindingValue = {
      allocationId,
      workPackageId: String(claim.workPackageId || "").trim(),
      candidateId: String(claim.candidateId || "").trim(),
      provider: String(claim.provider || "").trim().toLowerCase(),
      model: normalizeModelId(claim.model),
      tokenLimit,
      durationLimitMs,
      maxAttempts,
    };
    const binding = JSON.stringify(bindingValue);
    if (current && current.binding !== binding) throw new Error("program-pending-allocation-binding-conflict:" + allocationId);
    pendingByAllocation.set(allocationId, { binding, bindingValue, tokenLimit, durationLimitMs, maxAttempts });
  }
  const descriptorBinding = {
    allocationId: descriptor.allocationId,
    workPackageId: descriptor.workPackageId,
    candidateId: descriptor.candidateId,
    provider: descriptor.provider,
    model: descriptor.model,
    tokenLimit: descriptor.tokenLimit,
    durationLimitMs: descriptor.durationLimitMs,
    maxAttempts: descriptor.maxAttempts,
  };
  const observedAllocation = (snapshot.authorization?.allocations || []).find((row) => row.allocationId === descriptor.allocationId);
  if (observedAllocation && JSON.stringify(observedAllocation.binding || {}) !== JSON.stringify(descriptorBinding)) {
    throw new Error("program-allocation-binding-conflict:" + descriptor.allocationId);
  }
  const pendingAllocation = pendingByAllocation.get(descriptor.allocationId);
  if (pendingAllocation && pendingAllocation.binding !== JSON.stringify(descriptorBinding)) {
    throw new Error("program-pending-allocation-binding-conflict:" + descriptor.allocationId);
  }
  if (observedAllocation || pendingAllocation) return;

  const pending = [...pendingByAllocation.values()].reduce((totals, row) => ({
    tokens: totals.tokens + row.tokenLimit * row.maxAttempts,
    durationMs: totals.durationMs + row.durationLimitMs * row.maxAttempts,
    attempts: totals.attempts + row.maxAttempts,
  }), { tokens: 0, durationMs: 0, attempts: 0 });
  const current = {
    tokens: Number(snapshot.authorization?.capacityTotals?.tokens ?? snapshot.authorization?.totals?.tokens ?? 0) + pending.tokens,
    durationMs: Number(snapshot.authorization?.capacityTotals?.durationMs ?? snapshot.authorization?.totals?.durationMs ?? 0) + pending.durationMs,
    attempts: Number(snapshot.authorization?.capacityTotals?.attempts ?? snapshot.authorization?.totals?.attempts ?? 0) + pending.attempts,
  };
  const dimensions = [
    ["maxTokens", "tokens", descriptor.tokenLimit * descriptor.maxAttempts, "program-token-cap"],
    ["maxDurationMs", "durationMs", descriptor.durationLimitMs * descriptor.maxAttempts, "program-duration-cap"],
    ["maxAttempts", "attempts", descriptor.maxAttempts, "program-attempt-cap"],
  ];
  for (const [limitKey, metric, increment, code] of dimensions) {
    const limit = Number(limits[limitKey] || 0);
    if (!Number.isFinite(limit) || limit <= 0) continue;
    if (current[metric] >= limit) throw new Error(`${code}-exhausted:${current[metric]}>=${limit}`);
    if (current[metric] + increment > limit) throw new Error(`${code}-exceeded:${current[metric] + increment}>${limit}`);
  }
}
function claimAllocationAttempt(contract, taskId, jobId) {
  const descriptor = allocationAttemptDescriptor(contract);
  const dir = jobDirectory(taskId, jobId);
  if (!descriptor) {
    fs.mkdirSync(dir, { recursive: true });
    return contract;
  }
  return withDirectoryLock(path.join(taskDirectory(taskId), ".allocation-attempt-lock"), () => {
    const attempts = [];
    for (const priorJobId of listJobIds(taskId).filter((id) => id !== jobId)) {
      const priorDir = jobDirectory(taskId, priorJobId);
      const claimFile = allocationClaimFile(taskId, priorJobId);
      const claim = readJson(claimFile, null);
      const stored = readJson(path.join(priorDir, "contract.json"), null);
      const identity = allocationIdentity(stored || claim || {});
      if (identity.allocationId !== descriptor.allocationId || identity.workPackageId !== descriptor.workPackageId) continue;

      let status = readJson(statusFile(taskId, priorJobId), null);
      if (status && !TERMINAL_STATES.has(status.state)) {
        try { status = statusFor(taskId, priorJobId, true); } catch { /* retain the observed status */ }
      }
      if (status && !TERMINAL_STATES.has(status.state)) {
        throw new Error("allocation-active-claim-conflict:" + priorJobId);
      }
      if (!status && claim && claim.state !== "abandoned") {
        const ownerPid = Number(claim.childPid || claim.ownerPid || 0);
        if (processAlive(ownerPid)) throw new Error("allocation-active-claim-conflict:" + priorJobId);
        if (claim.state === "claimed") {
          writeJson(claimFile, {
            ...claim,
            state: "abandoned",
            abandonedReason: "claim owner exited before durable queued status",
            reconciledAt: utcNow(),
            updatedAt: utcNow(),
          });
          continue;
        }
      }
      if (status || (claim && claim.state !== "abandoned")) attempts.push(priorJobId);
    }
    const attempt = attempts.length + 1;
    if (attempt > descriptor.maxAttempts) {
      throw new Error("allocation-attempt-limit-exceeded:" + attempt + ">" + descriptor.maxAttempts);
    }
    enforceProgramSupervisorClaim(taskId, descriptor);
    fs.mkdirSync(dir, { recursive: true });
    const claimedAt = utcNow();
    writeJson(allocationClaimFile(taskId, jobId), {
      allocationId: descriptor.allocationId,
      workPackageId: descriptor.workPackageId,
      candidateId: descriptor.candidateId,
      provider: descriptor.provider,
      model: descriptor.model,
      tokenLimit: descriptor.tokenLimit,
      durationLimitMs: descriptor.durationLimitMs,
      maxAttempts: descriptor.maxAttempts,
      allocationAttempt: attempt,
      state: "claimed",
      ownerPid: process.pid,
      claimedAt,
      updatedAt: claimedAt,
    });
    return { ...contract, allocationAttempt: attempt };
  });
}

function event(dir, type, data = {}) {
  appendJsonl(path.join(dir, "events.jsonl"), { at: utcNow(), type, ...data });
}

function statusFile(taskId, jobId) { return path.join(jobDirectory(taskId, jobId), "status.json"); }

function setStatus(taskId, jobId, patch) {
  const file = statusFile(taskId, jobId);
  return withDirectoryLock(`${file}.lock`, () => {
    const current = readJson(file, {});
    const effective = { ...patch };
    if (TERMINAL_STATES.has(current.state) && effective.state && effective.state !== current.state) {
      delete effective.state;
      delete effective.pid;
      delete effective.startedAt;
      delete effective.finishedAt;
      delete effective.blocker;
    }
    const next = { ...current, ...effective, taskId, jobId, revision: Number(current.revision || 0) + 1, updatedAt: utcNow() };
    writeJson(file, next);
    return next;
  });
}

function statusFor(taskId, jobId, reconcile = true) {
  const status = readJson(statusFile(taskId, jobId), null);
  if (!status) throw new Error(`AI Mobile job not found: ${jobId}`);
  const queuedAgeMs = Date.now() - Date.parse(status.updatedAt || status.createdAt || "");
  if (reconcile && status.state === "queued" && !status.pid && Number.isFinite(queuedAgeMs) && queuedAgeMs > QUEUED_SPAWN_GRACE_MS) {
    const next = setStatus(taskId, jobId, {
      state: "failed",
      pid: null,
      finishedAt: utcNow(),
      blocker: "worker-spawn-lost: queued job never received a worker process",
      recoverable: true,
    });
    releaseResourceLease(jobId);
    const contract = readJson(path.join(jobDirectory(taskId, jobId), "contract.json"), {});
    const workspaceCleanup = cleanupIsolatedWorkspace(contract.isolation || {});
    return setStatus(taskId, jobId, { workspaceCleanup, processLossReconciledAt: utcNow() });
  }
  if (reconcile && ["queued", "running"].includes(status.state) && status.pid && !processAlive(status.pid)) {
    const next = setStatus(taskId, jobId, {
      state: "failed",
      finishedAt: utcNow(),
      blocker: "worker-process-lost: the finite worker exited without a terminal handoff",
    });
    releaseResourceLease(jobId);
    const contract = readJson(path.join(jobDirectory(taskId, jobId), "contract.json"), {});
    const workspaceCleanup = cleanupIsolatedWorkspace(contract.isolation || {});
    return setStatus(taskId, jobId, { workspaceCleanup, processLossReconciledAt: utcNow() });
  }
  return status;
}

function cleanupAbandonedJobs() {
  const result = { inspected: 0, recovered: 0 };
  for (const taskId of listTaskIds()) {
    for (const jobId of listJobIds(taskId)) {
      result.inspected += 1;
      const before = readJson(statusFile(taskId, jobId), null);
      if (!before || TERMINAL_STATES.has(before.state)) continue;
      try {
        const after = statusFor(taskId, jobId, true);
        if (after.state === "failed" && /^worker-(?:spawn|process)-lost:/.test(String(after.blocker || ""))) result.recovered += 1;
      } catch { /* malformed job state remains visible to normal task reconciliation */ }
    }
  }
  return result;
}

function allJobsForWorkspace(workspace) {
  const rows = [];
  for (const taskId of listTaskIds()) {
    let task;
    try { task = readTask(taskId); } catch { continue; }
    if (String(task.workspace || "").toLowerCase() !== String(workspace || "").toLowerCase()) continue;
    for (const jobId of listJobIds(taskId)) {
      const dir = jobDirectory(taskId, jobId);
      const observedStatus = readJson(statusFile(taskId, jobId), null);
      const contract = readJson(path.join(dir, "contract.json"), null);
      if (!observedStatus || !contract) continue;
      const status = statusFor(taskId, jobId);
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

function programResourceLimitsForTask(taskId) {
  const supervisor = readTask(taskId).program?.runtime?.programSupervisor || null;
  return supervisor && ["active", "waiting"].includes(String(supervisor.state || ""))
    ? { ...(supervisor.limits || {}) }
    : null;
}
function createJob(contract, entrypoint) {
  assertCanaryExecutorAllowed(contract);
  const taskId = safeId(contract.taskId, "task");
  const jobId = newId("job");
  const dir = jobDirectory(taskId, jobId);
  const effectiveContract = claimAllocationAttempt(contract, taskId, jobId);
  let lease;
  let isolation;
  try {
    const conflict = conflictFor(effectiveContract);
    if (conflict) throw new Error(`${conflict.reason}; existing job ${conflict.jobId}.`);
    lease = acquireResourceLease({
      ...effectiveContract,
      taskId,
      programResourceLimits: programResourceLimitsForTask(taskId),
    }, jobId);
    isolation = prepareWorkspaceForContract(effectiveContract, taskId, jobId);
  } catch (error) {
    if (lease) releaseResourceLease(jobId);
    fs.rmSync(dir, { recursive: true, force: true });
    throw error;
  }

  const stored = {
    ...effectiveContract,
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
  updateAllocationClaim(taskId, jobId, { state: "queued", queuedAt: utcNow() });

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
  const launchStatus = setStatus(taskId, jobId, { state: "running", pid: child.pid, startedAt: utcNow() });
  updateAllocationClaim(taskId, jobId, { state: "running", childPid: child.pid, launchedAt: utcNow() });
  return { taskId, jobId, state: launchStatus.state, provider: stored.provider, model: stored.model || "", isolation: isolation.mode, skipModelReview: stored.skipModelReview };
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
    readOnly: contract.readOnly === true,
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
      : { required: false, instruction: "Keep the console lightweight. Collect again only at the integration point or after a material provider transition." },
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
  allocationClaimFile,
  TERMINAL_STATES,
  allocationAttemptDescriptor,
  claimAllocationAttempt,
  activeJobs,
  assertCanaryExecutorAllowed,
  disposableCanaryDecision,
  cancelJob,
  cancelTaskJobs,
  cleanupAbandonedJobs,
  conflictFor,
  createJob,
  updateAllocationClaim,
  event,
  readJob,
  setStatus,
  statusFor,
};
