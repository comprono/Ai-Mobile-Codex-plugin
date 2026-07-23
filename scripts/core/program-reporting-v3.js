"use strict";

const crypto = require("node:crypto");
const path = require("node:path");
const { readMaterialEvents } = require("./material-events");
const { jobDirectory, taskDirectory } = require("./state-store");
const { bounded, readJson, utcNow } = require("./utils");
const TERMINAL_JOB_STATES = new Set(["completed", "failed", "cancelled", "rejected"]);
const ACTIVE_WORK_PACKAGE_STATES = new Set(["ready", "dispatched", "running"]);
const ACTIVE_JOB_STATES = new Set(["queued", "running"]);
const SUCCESSFUL_RECEIPT_STATES = new Set(["completed", "succeeded"]);

function hash(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value || {})).digest("hex");
}

function currentMilestone(plan = {}) {
  const milestones = Array.isArray(plan.milestones) ? plan.milestones : [];
  return milestones.find((row) => !["completed", "accepted"].includes(row.state)) || milestones.at(-1) || null;
}

function compactBudget(budget = {}, input = {}) {
  const allocations = Array.isArray(budget.allocations) ? budget.allocations : [];
  const workPackages = Array.isArray(input.workPackages) ? input.workPackages : [];
  const receipts = Array.isArray(input.executionReceipts)
    ? input.executionReceipts
    : Array.isArray(budget.executionReceipts) ? budget.executionReceipts : [];
  const byWorkPackage = new Map(workPackages.map((row) => [row.workPackageId, row]));
  const byAllocation = new Map(workPackages
    .filter((row) => row.allocationId)
    .map((row) => [row.allocationId, row]));
  const allocationStates = allocations.map((allocation) => {
    const workPackage = byWorkPackage.get(allocation.workPackageId) || byAllocation.get(allocation.allocationId) || null;
    const workPackageState = workPackage?.state || workPackage?.recordedState || "allocated";
    const jobState = workPackage?.jobState || "";
    const active = ACTIVE_WORK_PACKAGE_STATES.has(workPackageState) || ACTIVE_JOB_STATES.has(jobState);
    return {
      allocationId: allocation.allocationId || "",
      workPackageId: allocation.workPackageId || workPackage?.workPackageId || "",
      provider: allocation.provider || workPackage?.provider || "",
      model: allocation.model || workPackage?.model || "",
      workPackageState,
      jobState,
      active,
    };
  });
  const successfulReceipts = receipts.filter((row) => (
    SUCCESSFUL_RECEIPT_STATES.has(String(row.state || row.status || "").toLowerCase())
    || row.evidenceAccepted === true
  ));
  const completedKeys = new Set(successfulReceipts
    .map((row) => row.workPackageId || row.receiptId || row.id)
    .filter(Boolean));
  const deferred = Array.isArray(budget.deferred)
    ? budget.deferred
    : Array.isArray(budget.unallocatable) ? budget.unallocatable : [];
  return {
    revision: Number(budget.revision || budget.budgetRevision || 0),
    horizon: budget.horizon || null,
    allocations: allocations.length,
    activeAllocations: allocationStates.filter((row) => row.active).length,
    completedAllocations: completedKeys.size,
    allocationStates,
    successfulReceipts: successfulReceipts.slice(-12).map((row) => ({
      receiptId: row.receiptId || row.id || "",
      workPackageId: row.workPackageId || "",
      state: row.state || row.status || "",
      provider: row.provider || "",
      model: row.model || "",
    })),
    reserves: budget.reserves || {},
    limits: budget.limits || {},
    deferred: deferred.slice(0, 8),
    unallocatable: deferred.slice(0, 8),
  };
}

function compactEvidence(program = {}, task = {}) {
  const accepted = [];
  for (const requirement of task.requirements || []) {
    for (const row of requirement.evidence || []) {
      if (["activity", "process-health"].includes(String(row.level || "").toLowerCase())) continue;
      if (row.accepted === false || row.passed === false) continue;
      if (requirement.status !== "passing" && row.passed !== true) continue;
      accepted.push({
        requirementId: requirement.id || row.requirementId || "",
        level: row.level || "",
        ref: bounded(row.ref, 500),
        summary: bounded(row.summary, 500),
        accepted: true,
        passed: true,
      });
    }
  }
  const entries = [...(program.evidenceLedger?.entries || []), ...(task.evidence || [])];
  accepted.push(...entries.filter((row) => (
    !["activity", "process-health"].includes(String(row.level || "").toLowerCase())
    && row.accepted === true
    && (row.passed === true || row.status === "passing")
  )).map((row) => ({
    requirementId: row.requirementId || row.id || "",
    level: row.level || "",
    ref: bounded(row.ref, 500),
    summary: bounded(row.summary, 500),
    accepted: true,
    passed: true,
  })));
  const deduplicated = new Map();
  for (const row of accepted) {
    const key = [row.requirementId, row.level, row.ref].join("\u0000");
    if (!deduplicated.has(key)) deduplicated.set(key, row);
  }
  return [...deduplicated.values()].slice(-12);
}

function compactWorkPackages(program = {}, runtime = {}) {
  const jobStates = runtime.jobStates || {};
  const coordinatorTerminal = ["stopped", "failed", "interrupted"].includes(runtime.coordinator?.state);
  return (program.workPackages || []).slice(-12).map((row) => {
    const recordedState = row.state || "pending";
    const job = row.jobId ? jobStates[row.jobId] : null;
    const jobState = job?.state || "";
    const staleOwnership = recordedState === "running"
      && coordinatorTerminal
      && TERMINAL_JOB_STATES.has(jobState);
    const inferredBlocker = staleOwnership
      ? "Worker job " + row.jobId + " is terminal (" + jobState + ") but the package retained running ownership after the coordinator stopped."
      : "";
    return {
      workPackageId: row.workPackageId || "",
      roundId: row.roundId || job?.roundId || "",
      owner: typeof row.owner === "string" ? row.owner : row.owner?.id || row.ownerRole || job?.owner || "",
      executorKind: row.executorKind || row.type || "",
      deliverableKind: row.deliverableKind || "",
      state: staleOwnership ? "blocked" : recordedState,
      recordedState,
      jobId: row.jobId || "",
      jobState,
      staleOwnership,
      allocationId: row.allocation?.allocationId || "",
      budgetRevision: Number(row.budgetRevision || 0),
      provider: row.allocation?.provider || row.provider || job?.provider || "",
      model: row.allocation?.model || row.model || job?.model || "",
      blocker: bounded(staleOwnership ? inferredBlocker : row.blocker || row.lastFailure?.blocker, 500),
    };
  });
}

function compactCoordinator(value) {
  if (!value || typeof value !== "object") return null;
  return {
    executionId: value.executionId || "",
    state: value.state || "",
    stopReason: value.stopReason || "",
    roundsStarted: Number(value.roundsStarted || 0),
    finishedAt: value.finishedAt || null,
  };
}

function finiteNumberOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function compactNumericMap(value) {
  if (!value || typeof value !== "object") return {};
  return Object.fromEntries(Object.entries(value)
    .slice(0, 20)
    .map(([key, amount]) => [key, finiteNumberOrNull(amount)])
    .filter(([, amount]) => amount !== null));
}

function compactProgramLimits(value) {
  const source = value && typeof value === "object" ? value : {};
  return Object.fromEntries([
    "noProgressLimit",
    "maxEvents",
    "maxTokens",
    "maxDurationMs",
    "maxAttempts",
    "maxArtifacts",
    "maxArtifactBytes",
    "maxWorkers",
    "maxGlobalWorkers",
    "maxCampaigns",
  ].map((key) => [key, finiteNumberOrNull(source[key])]).filter(([, amount]) => amount !== null));
}

function compactLimitSource(value) {
  if (!value || typeof value !== "object") return null;
  return {
    kind: value.kind || "",
    budgetId: value.budgetId || "",
    revision: Number(value.revision || 0),
    fingerprint: bounded(value.fingerprint, 200),
    planId: value.planId || "",
    planRevision: Number(value.planRevision || 0),
    inventoryFingerprint: bounded(value.inventoryFingerprint, 200),
    forecastFingerprint: bounded(value.forecastFingerprint, 200),
    reserves: compactNumericMap(value.reserves),
  };
}

function compactLimitBaseline(value) {
  if (!value || typeof value !== "object") return null;
  const fundedAllocationIds = Array.isArray(value.fundedAllocationIds) ? value.fundedAllocationIds : [];
  return {
    sourceBudgetId: value.sourceBudgetId || "",
    sourceBudgetRevision: Number(value.sourceBudgetRevision || 0),
    sourceBudgetFingerprint: bounded(value.sourceBudgetFingerprint, 200),
    resourceSnapshotFingerprint: bounded(value.resourceSnapshotFingerprint, 200),
    fundedAllocationCount: fundedAllocationIds.length,
    fundedAllocationIds: fundedAllocationIds.slice(-20),
    historicalCommitted: compactNumericMap(value.historicalCommitted),
    historicalExposure: compactNumericMap(value.historicalExposure),
    fundedExposure: compactNumericMap(value.fundedExposure),
    acceptedRemainingBudget: compactNumericMap(value.acceptedRemainingBudget),
    derivedCumulativeCeiling: compactNumericMap(value.derivedCumulativeCeiling),
    recordedAt: value.recordedAt || null,
  };
}

function compactLimitHistoryEntry(value) {
  if (!value || typeof value !== "object") return null;
  return {
    at: value.at || null,
    sourceBudgetId: value.sourceBudgetId || "",
    sourceBudgetRevision: Number(value.sourceBudgetRevision || 0),
    sourceBudgetFingerprint: bounded(value.sourceBudgetFingerprint, 200),
    sourcePlanId: value.sourcePlanId || "",
    sourcePlanRevision: Number(value.sourcePlanRevision || 0),
    priorLimits: compactProgramLimits(value.priorLimits),
    newLimits: compactProgramLimits(value.newLimits),
    baseline: compactLimitBaseline(value.baseline),
    reason: bounded(value.reason, 500),
  };
}

function compactResourceMetric(value) {
  const metric = value && typeof value === "object" ? value : {};
  return {
    known: finiteNumberOrNull(metric.known),
    committed: finiteNumberOrNull(metric.committed),
  };
}

function compactResourceBlocker(row) {
  return {
    code: row?.code || "",
    provider: row?.provider || "",
    poolKey: row?.poolKey || "",
    jobId: row?.jobId || "",
    allocationId: row?.allocationId || "",
    metric: row?.metric || "",
    hard: row?.hard === true,
    committed: finiteNumberOrNull(row?.committed),
    authorized: finiteNumberOrNull(row?.authorized),
    limit: finiteNumberOrNull(row?.limit),
    reason: bounded(row?.reason, 500),
  };
}

function compactProgramResourceSnapshot(value) {
  if (!value || typeof value !== "object") return null;
  const totals = {};
  for (const metric of ["attempts", "tokens", "durationMs", "artifacts", "durableBytes", "durableFiles"]) {
    totals[metric] = compactResourceMetric(value.totals?.[metric]);
  }
  const authorizationTotals = value.authorization?.totals || {};
  const byProvider = Object.fromEntries(Object.entries(value.concurrency?.byProvider || {})
    .slice(0, 20)
    .map(([provider, count]) => [provider, Number(count || 0)]));
  const quotaBlockers = (value.quota?.providerBlockers || []).slice(0, 20).map(compactResourceBlocker);
  const accountingBlockers = (value.blockers || [])
    .filter((row) => row?.code !== "quota-capacity-unknown")
    .slice(0, 20).map(compactResourceBlocker);
  const capBlockers = (value.capCheck?.blockers || []).slice(0, 20).map(compactResourceBlocker);
  const exhaustedBlockers = (value.capCheck?.exhausted || []).slice(0, 20).map(compactResourceBlocker);
  const safe = value.safe === true;
  const hardCapBreach = capBlockers.length > 0;
  const consumptionExhausted = value.consumptionExhausted === true || exhaustedBlockers.length > 0;
  const recoverableCapacity = value.recoverableCapacity === true && !hardCapBreach && !consumptionExhausted;
  const state = hardCapBreach
    ? "hard-cap-breach"
    : consumptionExhausted
      ? "at-limit-drain-only"
      : safe
        ? "safe"
        : recoverableCapacity ? "recoverable-quota-wait" : "accounting-unsafe";
  const summary = state === "safe"
    ? "Program resources are within the cumulative limits and new bounded consumption remains authorized."
    : state === "at-limit-drain-only"
      ? "The cumulative resource budget is at its limit; no new consumption is authorized, and only already-running work may drain."
      : state === "recoverable-quota-wait"
        ? "Provider quota capacity is temporarily unavailable; the supervisor is waiting within its bounded horizon."
        : state === "hard-cap-breach"
          ? "A cumulative program resource cap was exceeded; further work requires the recorded recovery budget."
          : "Program-wide resource accounting is unsafe; the supervisor must reconcile it before dispatch.";
  return {
    state,
    summary,
    safe,
    newConsumptionAuthorized: state === "safe",
    recoverableCapacity,
    consumptionExhausted,
    fingerprint: bounded(value.fingerprint, 200),
    campaignCount: Number(value.campaignCount || value.campaign?.count || 0),
    totals,
    authorization: {
      totals: {
        tokens: finiteNumberOrNull(authorizationTotals.tokens),
        durationMs: finiteNumberOrNull(authorizationTotals.durationMs),
        attempts: finiteNumberOrNull(authorizationTotals.attempts),
      },
      complete: value.authorization?.complete === true,
    },
    concurrency: {
      programActive: Number(value.concurrency?.programActive || 0),
      globalActive: Number(value.concurrency?.globalActive || 0),
      byProvider,
    },
    quotaBlockers,
    accountingBlockers,
    capBlockers,
    exhaustedBlockers,
  };
}

function compactProgramSupervisor(value, campaign = null, activeCampaign = null) {
  if (!value || typeof value !== "object") return null;
  const recovery = value.recovery && typeof value.recovery === "object"
    ? {
        owner: value.recovery.owner || "",
        trigger: bounded(value.recovery.trigger, 500),
        action: bounded(value.recovery.action, 1000),
      }
    : null;
  return {
    supervisorId: value.supervisorId || "",
    missionId: value.missionId || "",
    state: value.state || "",
    overallHorizon: {
      startedAt: value.startedAt || null,
      deadlineAt: value.deadlineAt || null,
      hours: Number(value.horizonHours || 0),
    },
    noProgressCount: Number(value.noProgressCount || 0),
    noProgressLimit: Number(value.limits?.noProgressLimit || 0),
    wakeCount: Number(value.wakeCount || 0),
    eventLimit: Number(value.limits?.maxEvents || 0),
    nextWakeAt: value.nextWakeAt || null,
    currentEpoch: Number(campaign?.epoch || 0),
    currentCampaignId: campaign?.campaignId || "",
    activeCampaignId: activeCampaign?.campaignId || "",
    campaignState: campaign?.state || "",
    campaignIds: Array.isArray(value.campaignIds) ? value.campaignIds.slice(-20) : [],
    campaignCount: Number(value.campaignCount || campaign?.epoch || 0),
    limits: compactProgramLimits(value.limits),
    limitRevision: Number(value.limitRevision || 0),
    limitSource: compactLimitSource(value.limitSource),
    limitBaseline: compactLimitBaseline(value.limitBaseline),
    latestLimitHistory: compactLimitHistoryEntry(Array.isArray(value.limitHistory) ? value.limitHistory.at(-1) : null),
    resourceSnapshot: compactProgramResourceSnapshot(value.resourceSnapshot),
    stopReason: value.stopReason || "",
    recoveryOwner: recovery?.owner || "",
    recovery,
    finishedAt: value.finishedAt || null,
  };
}

function runtimeReportState(task, input = {}) {
  if (!task.taskId) {
    return {
      coordinator: input.coordinator || null,
      events: Array.isArray(input.events) ? input.events : [],
      jobStates: input.jobStates && typeof input.jobStates === "object" ? input.jobStates : {},
    };
  }
  let coordinator = input.coordinator;
  if (coordinator === undefined) {
    try {
      coordinator = readJson(path.join(taskDirectory(task.taskId), "coordinator.json"), null);
    } catch {
      coordinator = null;
    }
  }
  let events = input.events;
  if (events === undefined) {
    try {
      events = readMaterialEvents({ taskId: task.taskId, maxEvents: 12 }).events;
    } catch {
      events = [];
    }
  }
  let jobStates = input.jobStates;
  if (!jobStates || typeof jobStates !== "object") jobStates = {};
  if (input.jobStates === undefined) {
    for (const row of (task.program?.workPackages || []).slice(-100)) {
      if (!row.jobId) continue;
      try {
        const directory = jobDirectory(task.taskId, row.jobId);
        const status = readJson(path.join(directory, "status.json"), null);
        const contract = readJson(path.join(directory, "contract.json"), {});
        if (status?.state) {
          jobStates[row.jobId] = {
            ...status,
            roundId: status.roundId || contract.roundId || "",
            workPackageId: status.workPackageId || contract.workPackageId || contract.directorProgram?.workPackageId || "",
            owner: status.owner || contract.owner || contract.directorProgram?.owner || "",
          };
        }
      } catch {
        // Synthetic and partially retained tasks have no durable job directory.
      }
    }
  }
  return { coordinator, events: Array.isArray(events) ? events : [], jobStates };
}

const RUNTIME_SUCCESS_STATES = new Set(["completed", "succeeded", "integrated", "accepted", "resolved", "reconciled", "passed"]);

function identitySet(...values) {
  return new Set(values.flat(3)
    .filter((value) => typeof value === "string" || typeof value === "number")
    .map((value) => String(value || "").trim())
    .filter(Boolean));
}

function runtimeEventIdentity(event = {}) {
  const data = event.data && typeof event.data === "object" ? event.data : {};
  const related = [
    ...(Array.isArray(data.workers) ? data.workers : []),
    ...(Array.isArray(data.integrations) ? data.integrations : []),
    ...(Array.isArray(data.packages) ? data.packages : []),
  ].filter((row) => row && typeof row === "object");
  return {
    eventIds: identitySet(event.eventId, event.fingerprint),
    resolvesEventIds: identitySet(
      event.resolvesEventId,
      event.resolvedEventId,
      data.resolvesEventId,
      data.resolvedEventId,
      data.resolvesEventIds || [],
      data.resolvedEventIds || [],
    ),
    jobIds: identitySet(event.jobId, data.jobId, related.map((row) => row.jobId)),
    workPackageIds: identitySet(event.workPackageId, data.workPackageId, related.map((row) => row.workPackageId)),
    roundIds: identitySet(event.roundId, data.roundId, related.map((row) => row.roundId)),
    owners: identitySet(event.owner, data.owner, related.map((row) => row.owner)),
    executionIds: identitySet(event.executionId, data.executionId),
  };
}

function identitiesOverlap(left = new Set(), right = new Set()) {
  for (const value of left) if (right.has(value)) return true;
  return false;
}

function terminalResolutionEvent(event = {}) {
  if (event.blocker) return false;
  const state = String(event.state || "").toLowerCase();
  if (RUNTIME_SUCCESS_STATES.has(state)) return true;
  return /(?:^|\.)(?:completed|succeeded|accepted|resolved|reconciled|passed)$/.test(String(event.type || "").toLowerCase());
}

function eventResolvesRuntimeFailure(failure = {}, resolution = {}) {
  if (!terminalResolutionEvent(resolution)) return false;
  const failed = runtimeEventIdentity(failure);
  const resolved = runtimeEventIdentity(resolution);
  if (identitiesOverlap(failed.eventIds, resolved.resolvesEventIds)) return true;
  if (identitiesOverlap(failed.jobIds, resolved.jobIds)) return true;
  if (identitiesOverlap(failed.workPackageIds, resolved.workPackageIds)) return true;
  if (identitiesOverlap(failed.roundIds, resolved.roundIds)) return true;
  if (identitiesOverlap(failed.owners, resolved.owners)) return true;
  return String(failure.type || "") === "coordinator.failed"
    && String(resolution.type || "").startsWith("coordinator.")
    && identitiesOverlap(failed.executionIds, resolved.executionIds);
}

function packageResolutionState(workPackage = {}, failureType = "") {
  if (workPackage.staleOwnership) return false;
  if (["completed", "integrated", "accepted"].includes(String(workPackage.state || "").toLowerCase())) return true;
  return failureType === "round.dispatched"
    && String(workPackage.jobState || "").toLowerCase() === "completed";
}

function durableStateResolvesRuntimeFailure(failure = {}, coordinator = null, workPackages = []) {
  const failed = runtimeEventIdentity(failure);
  if (String(failure.type || "") === "coordinator.failed"
    && String(coordinator?.state || "").toLowerCase() === "completed") {
    const currentExecution = identitySet(coordinator?.executionId);
    if (!failed.executionIds.size || identitiesOverlap(failed.executionIds, currentExecution)) return true;
  }
  const identified = workPackages.filter((row) => (
    (failed.jobIds.size && failed.jobIds.has(String(row.jobId || "")))
    || (failed.workPackageIds.size && failed.workPackageIds.has(String(row.workPackageId || "")))
    || (failed.roundIds.size && failed.roundIds.has(String(row.roundId || "")))
  ));
  if (identified.some((row) => packageResolutionState(row, failure.type))) return true;
  if (identified.length || !failed.owners.size) return false;
  const ownerMatches = workPackages.filter((row) => failed.owners.has(String(row.owner || "")));
  return ownerMatches.length === 1 && packageResolutionState(ownerMatches[0], failure.type);
}

function latestUnresolvedRuntimeFailure(events = [], coordinator = null, workPackages = []) {
  const currentExecutionIds = identitySet(coordinator?.executionId);
  const failures = events
    .map((event, index) => ({ event, index }))
    .filter(({ event }) => {
      if (!event?.blocker || !["round.integrated", "round.dispatched", "coordinator.failed"].includes(event.type)) return false;
      const failureExecutionIds = runtimeEventIdentity(event).executionIds;
      return !currentExecutionIds.size || !failureExecutionIds.size || identitiesOverlap(failureExecutionIds, currentExecutionIds);
    });
  return failures.reverse().find(({ event, index }) => (
    !durableStateResolvesRuntimeFailure(event, coordinator, workPackages)
    && !events.slice(index + 1).some((candidate) => eventResolvesRuntimeFailure(event, candidate))
  ))?.event || null;
}


function runtimeBlockers(events = [], coordinator = null, workPackages = [], programSupervisor = null) {
  const rows = [];
  const staleOwnership = workPackages.filter((row) => row.staleOwnership);
  if (staleOwnership.length) {
    return staleOwnership.map((workPackage) => ({
      requirementId: "",
      owner: "Director-CFO",
      reason: bounded(workPackage.blocker, 600),
      recoveryAction: "Integrate or reconcile the terminal worker result exactly once, clear stale package ownership, then resume this same task without duplicate dispatch.",
      eventType: "package.stale-ownership",
    }));
  }
  const recentFailure = latestUnresolvedRuntimeFailure(events, coordinator, workPackages);
  const terminalEvent = [...events].reverse().find((row) => row?.type === "coordinator.stopped");
  if (recentFailure) {
    rows.push({
      requirementId: recentFailure.requirementId || "",
      owner: "Director-CFO",
      reason: bounded(recentFailure.blocker || recentFailure.summary, 600),
      recoveryAction: bounded(recentFailure.nextAction || terminalEvent?.nextAction, 600),
      eventType: recentFailure.type || "",
    });
  }
  if (programSupervisor?.state === "stopped") {
    rows.push({
      requirementId: "",
      owner: programSupervisor.recoveryOwner || "Director-CFO",
      reason: bounded(programSupervisor.stopReason || "program-supervisor-stopped", 600),
      recoveryAction: bounded(programSupervisor.recovery?.action || "Resume only after the recorded program recovery trigger materially changes.", 600),
      eventType: "program-supervisor.stopped",
    });
  }
  if (coordinator && ["stopped", "failed", "interrupted"].includes(coordinator.state) && !programSupervisor) {
    rows.push({
      requirementId: "",
      owner: "Director-CFO coordinator",
      reason: bounded(coordinator.stopReason || "coordinator-stopped", 600),
      recoveryAction: bounded(recentFailure?.nextAction || terminalEvent?.nextAction || "Resume only after the recorded recovery condition materially changes.", 600),
      eventType: `coordinator.${coordinator.state}`,
    });
  }
  return rows;
}

function budgetForReport(program = {}) {
  const canonical = program.resourceBudget && typeof program.resourceBudget === "object"
    ? program.resourceBudget
    : {};
  const runtime = program.runtime?.budget && typeof program.runtime.budget === "object"
    ? program.runtime.budget
    : null;
  if (!runtime) return canonical;
  return {
    ...canonical,
    ...runtime,
    revision: Number(runtime.budgetRevision || runtime.revision || canonical.revision || 0),
    allocations: Array.isArray(runtime.allocations) ? runtime.allocations : canonical.allocations || [],
    reserves: runtime.reserves || canonical.reserves || {},
    limits: runtime.limits || canonical.limits || {},
    deferred: Array.isArray(runtime.deferred)
      ? runtime.deferred
      : canonical.deferred || canonical.unallocatable || [],
  };
}

function compactMaterialEvent(value) {
  if (!value || typeof value !== "object") return null;
  return {
    eventId: value.eventId || "",
    fingerprint: value.fingerprint || "",
    executionId: value.executionId || "",
    roundId: value.roundId || "",
    jobId: value.jobId || "",
    type: value.type || "",
    state: value.state || "",
    summary: bounded(value.summary, 600),
    blocker: bounded(value.blocker, 600),
    nextAction: bounded(value.nextAction, 600),
    at: value.at || null,
  };
}

function reportSnapshot(report = {}) {
  const accepted = (report.acceptedEvidence || []).map((row) => ({
    requirementId: row.requirementId,
    level: row.level,
    ref: row.ref,
  }));
  const workPackages = (report.workPackages || []).map((row) => ({
    workPackageId: row.workPackageId || "",
    roundId: row.roundId || "",
    state: row.state || "",
    recordedState: row.recordedState || "",
    owner: row.owner || "",
    jobId: row.jobId || "",
    jobState: row.jobState || "",
    allocationId: row.allocationId || "",
    provider: row.provider || "",
    model: row.model || "",
    blocker: row.blocker || "",
  }));
  const blockers = (report.blockers || []).map((row) => ({
    requirementId: row.requirementId || "",
    owner: row.owner || "",
    reason: row.reason || "",
    recoveryAction: row.recoveryAction || "",
  }));
  const supervisorTerminal = report.programSupervisor
    && ["stopped", "completed", "cancelled"].includes(report.programSupervisor.state);
  const coordinatorTerminal = !report.programSupervisor
    && report.coordinator && ["stopped", "failed", "interrupted"].includes(report.coordinator.state);
  const terminal = supervisorTerminal
    ? { layer: "program-supervisor", state: report.programSupervisor.state, stopReason: report.programSupervisor.stopReason }
    : coordinatorTerminal ? { layer: "coordinator", state: report.coordinator.state, stopReason: report.coordinator.stopReason } : null;
  const supervisorLifecycle = report.programSupervisor
    ? { ...report.programSupervisor, resourceSnapshot: undefined }
    : null;
  return {
    outcome: hash({ requirements: report.progress?.requirements || [], accepted }),
    program: hash({ mission: report.mission || null, milestone: report.milestone || null, workstreams: report.workstreams || [] }),
    foundation: hash(report.foundation || {}),
    activeWork: hash({ workPackages, coordinator: report.coordinator || null }),
    resources: hash({ budget: report.budget || {}, program: report.programSupervisor?.resourceSnapshot || null }),
    campaign: hash(report.campaign || null),
    materialEvent: hash(report.latestMaterialEvent || null),
    supervisor: hash(supervisorLifecycle),
    blockers: hash(blockers),
    recovery: hash(report.sections?.recovery || {}),
    nextAction: hash(report.sections?.nextOwnedAction || { action: report.nextAction || "" }),
    terminal: hash(terminal),
  };
}

function buildProgramReport(task = {}, input = {}) {
  const program = task.program || input.program || {};
  const mission = program.mission || {};
  const plan = program.masterPlan || {};
  const milestone = currentMilestone(plan);
  const activeCampaign = program.activeCampaign || null;
  const campaign = activeCampaign || (program.campaigns || []).at(-1) || null;
  const programSupervisor = compactProgramSupervisor(program.runtime?.programSupervisor, campaign, activeCampaign);
  const runtime = runtimeReportState(task, input);
  const coordinator = compactCoordinator(runtime.coordinator);
  const workstreams = (plan.workstreams || []).slice(0, 20).map((row) => ({
    id: row.workstreamId || row.id || "",
    name: bounded(row.name || row.goal, 240),
    state: row.state || "planned",
    ownerRole: row.ownerRole || row.leadRole || "",
  }));
  const failures = (program.failureMemory || []).slice(-5).map((row) => ({
    failureClass: row.failureClass || "",
    blocker: bounded(row.blocker, 500),
    reconciliation: bounded(row.reconciliation?.rootCause || row.recoveryAction, 500),
  }));
  const required = (task.requirements || []).filter((row) => row.required !== false);
  const requirementBlockers = required.filter((row) => row.status === "blocked").map((row) => ({
    requirementId: row.id,
    owner: row.blocker?.owner || "director",
    reason: bounded(row.blocker?.reason || row.description, 600),
    recoveryAction: bounded(row.blocker?.recoveryAction, 600),
  }));
  const workPackages = compactWorkPackages(program, { coordinator, jobStates: runtime.jobStates });
  const directorOwnedBlockers = runtimeBlockers(runtime.events, coordinator, workPackages, programSupervisor);
  const blockers = [...requirementBlockers, ...directorOwnedBlockers].filter((row, index, rows) => (
    rows.findIndex((candidate) => hash(candidate) === hash(row)) === index
  ));
  const latestMaterial = runtime.events.at(-1) || null;
  const latestMaterialEvent = compactMaterialEvent(latestMaterial);
  const acceptedEvidence = compactEvidence(program, task);
  const contextRevision = Number(program.contextDossier?.contextRevision || 0);
  const planRevision = Number(program.masterPlan?.planRevision || 0);
  const budgetRevision = Number(program.runtime?.budget?.budgetRevision || program.resourceBudget?.revision || 0);
  const integratedReconciliations = workPackages.filter((row) => (
    row.executorKind === "reconciliation" && ["completed", "integrated", "accepted"].includes(row.state)
  )).length;
  const coordinatorTerminal = coordinator && ["stopped", "failed", "interrupted"].includes(coordinator.state);
  const programTerminal = programSupervisor && ["stopped", "completed", "cancelled"].includes(programSupervisor.state);
  const terminal = programSupervisor ? programTerminal : coordinatorTerminal;
  const supervisorRecoveryActive = programSupervisor?.recovery
    && ["waiting", "stopped", "cancelled"].includes(programSupervisor.state);
  const supervisorRecoveryAction = supervisorRecoveryActive ? programSupervisor.recovery.action : "";
  const nextAction = supervisorRecoveryAction || (terminal
    ? (directorOwnedBlockers.at(-1)?.recoveryAction || latestMaterial?.nextAction || "")
    : (input.nextAction || program.nextAction || task.nextAction || latestMaterial?.nextAction || ""));
  const executionReceipts = Array.isArray(program.executionReceipts)
    ? program.executionReceipts
    : Array.isArray(program.contracts?.executionReceipts) ? program.contracts.executionReceipts : [];
  const budget = compactBudget(budgetForReport(program), { workPackages, executionReceipts });
  const userDecisionRequired = blockers.some((row) => /user|human/i.test(row.owner))
    || (supervisorRecoveryActive && /user|human/i.test(programSupervisor.recoveryOwner));
  const activePackages = workPackages.filter((row) => (
    ACTIVE_WORK_PACKAGE_STATES.has(row.state) || ACTIVE_JOB_STATES.has(row.jobState)
  ));
  const supervisorRecoveryActions = supervisorRecoveryActive && programSupervisor.recovery?.action
    ? [{
        owner: programSupervisor.recoveryOwner || "Director-CFO",
        trigger: programSupervisor.recovery.trigger || programSupervisor.stopReason || "",
        action: programSupervisor.recovery.action,
        eventType: `program-supervisor.${programSupervisor.state}`,
      }]
    : [];
  const recoveryActions = [...supervisorRecoveryActions, ...blockers
    .filter((row) => row.recoveryAction)
    .map((row) => ({
      owner: row.owner || "Director-CFO",
      trigger: row.reason || "",
      action: row.recoveryAction,
      eventType: row.eventType || "",
    }))].filter((row, index, rows) => (
      rows.findIndex((candidate) => hash(candidate) === hash(row)) === index
    ));
  const nextOwner = userDecisionRequired
    ? "user"
    : supervisorRecoveryActive && ["stopped", "cancelled"].includes(programSupervisor.state)
      ? programSupervisor.recoveryOwner || "Director-CFO"
      : activePackages.length
        ? "coordinator"
        : supervisorRecoveryActive
          ? programSupervisor.recoveryOwner || "Director-CFO"
          : programSupervisor && ["active", "waiting"].includes(programSupervisor.state)
            ? "program supervisor"
            : terminal && directorOwnedBlockers.length
              ? directorOwnedBlockers.at(-1).owner || "Director-CFO"
              : blockers.at(-1)?.owner || "Director-CFO";
  const progress = {
    passing: required.filter((row) => row.status === "passing").length,
    required: required.length,
    acceptedEvidence: acceptedEvidence.length,
    requirements: required.map((row) => ({ id: row.id, status: row.status || "unknown" })),
  };
  const sections = {
    outcomeEvidence: {
      passing: progress.passing,
      required: progress.required,
      requirements: progress.requirements,
      acceptedEvidence,
    },
    programSupervisor,
    activeWorkResources: {
      activePackages,
      activeAssignments: budget.allocationStates.filter((row) => row.active),
      coordinator,
      budget: {
        revision: budget.revision,
        activeAllocations: budget.activeAllocations,
        completedAllocations: budget.completedAllocations,
        reserves: budget.reserves,
        limits: budget.limits,
        deferred: budget.deferred,
      },
    },
    blocker: { active: blockers.length > 0, items: blockers },
    recovery: { required: recoveryActions.length > 0, actions: recoveryActions },
    nextOwnedAction: { owner: nextOwner, action: bounded(nextAction, 1000) },
  };
  const report = {
    schemaVersion: 3,
    taskId: task.taskId || null,
    mission: {
      id: mission.missionId || "",
      outcome: bounded(mission.outcome || task.outcome, 1200),
      state: mission.state || task.state || "active",
    },
    milestone: milestone ? {
      id: milestone.milestoneId || milestone.id || "",
      name: bounded(milestone.name || milestone.outcome || milestone.goal, 500),
      state: milestone.state || "planned",
      targetAt: milestone.targetAt || milestone.endsAt || null,
    } : null,
    campaign: campaign ? {
      id: campaign.campaignId || "",
      epoch: Number(campaign.epoch || 0),
      state: campaign.state || "",
      stopReason: campaign.stopReason || "",
      nextWakeAt: campaign.nextWakeAt || null,
    } : null,
    programSupervisor,
    progress,
    acceptedEvidence,
    foundation: {
      contextRevision,
      contextAccepted: contextRevision > 0,
      planRevision,
      planAccepted: planRevision > 0,
      budgetRevision,
      integratedReconciliations,
    },
    workstreams,
    workPackages,
    coordinator,
    latestMaterialEvent,
    budget,
    failures,
    blockers,
    nextAction: bounded(nextAction, 1000),
    userDecisionRequired,
    sections,
    generatedAt: input.generatedAt || utcNow(),
  };
  report.fingerprint = hash({ ...report, generatedAt: undefined });
  return report;
}

function reportTransition(cursor = {}, report = {}) {
  if (!report.fingerprint) throw new Error("A fingerprinted program report is required.");
  const snapshot = reportSnapshot(report);
  const previous = cursor.stateSnapshot || null;
  const scopes = [
    ["outcome", "outcome-progress"],
    ["program", "program-structure"],
    ["foundation", "foundation-progress"],
    ["supervisor", "program-supervisor-transition"],
    ["blockers", "actionable-blocker"],
    ["recovery", "recovery-change"],
    ["terminal", "terminal-boundary"],
    ["campaign", "campaign-transition"],
    ["activeWork", "active-work"],
    ["resources", "resource-change"],
    ["materialEvent", "material-event"],
    ["nextAction", "next-action"],
  ];
  const changedScopes = previous
    ? scopes.filter(([scope]) => previous[scope] !== snapshot[scope]).map(([scope]) => scope)
    : scopes.map(([scope]) => scope);
  if (previous && changedScopes.length === 0) {
    return { emit: false, reason: "unchanged", cursor };
  }
  const reason = !previous
    ? "initial"
    : scopes.find(([scope]) => changedScopes.includes(scope))?.[1] || "material-update";
  const next = {
    schemaVersion: 3,
    sequence: Number(cursor.sequence || 0) + 1,
    lastFingerprint: report.fingerprint,
    stateSnapshot: snapshot,
    lastReportedAt: report.generatedAt || utcNow(),
  };
  return {
    emit: true,
    reason,
    cursor: next,
    report: {
      ...report,
      delta: { kind: reason, changedScopes, outcomeProgress: reason === "outcome-progress" },
    },
  };
}

module.exports = {
  buildProgramReport,
  compactBudget,
  compactEvidence,
  compactProgramSupervisor,
  currentMilestone,
  reportSnapshot,
  reportTransition,
};
