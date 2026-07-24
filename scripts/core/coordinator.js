"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { runtimeFingerprint } = require("../lib/runtime-identity");
const { inventory } = require("./capacity");
const {
  capacityRequirementSatisfied,
  capacityWaitDescriptor,
  capacityWaitSummary,
  isRecoverableCapacityWait,
  targetedQuotaFingerprint,
} = require("./capacity-wait");
const { createJob, statusFor, TERMINAL_STATES } = require("./job-store");
const { campaignExpired, evidenceFingerprint, finishCampaign, recordCampaignWake } = require("./campaign-engine");
const { appendMaterialEvent, readMaterialEvents, target } = require("./material-events");
const { buildProgramResourceSnapshot } = require("./program-resource-snapshot");
const { providerHistory } = require("./provider-history");
const {
  collectRound,
  completeTask,
  dispatchRound,
  integrateRound,
  taskSummary,
} = require("./task-orchestrator");
const { prepareProgramDispatch, repairDirectorLegacyRounds } = require("./director-cfo-orchestrator");
const {
  jobDirectory,
  readPortfolio,
  readPortfolioRound,
  readRound,
  readTask,
  updateTask,
} = require("./state-store");
const { bounded, processAlive, readJson, utcNow, withDirectoryLock, writeJson } = require("./utils");

const COORDINATOR_TERMINAL_STATES = new Set(["completed", "stopped", "failed", "cancelled", "interrupted", "superseded"]);
const SUPERVISED_SLICE_STOP_REASONS = new Set(["worker-deadline", "time-limit", "round-limit", "no-dependency-ready-unit", "no-eligible-worker", "capacity-wait", "resource-budget-refreshed"]);
const SUPERVISOR_ACTIVE_STATES = new Set(["running", "slice-stopped", "waiting"]);

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(minimum, Math.min(maximum, Math.floor(parsed))) : fallback;
}

function coordinatorFile(input) {
  return path.join(target(input).root, "coordinator.json");
}

function coordinatorPayloadFile(input) {
  return path.join(target(input).root, "coordinator-input.json");
}

function readCoordinator(input) {
  return readJson(coordinatorFile(input), null);
}

function coordinatorConfig(input = {}) {
  const campaignSupervisor = input.campaignSupervisor === true;
  return {
    maxRounds: boundedInteger(input.maxRounds, 20, 1, 50),
    maxMinutes: boundedInteger(input.maxMinutes, 300, 1, 300),
    noProgressLimit: boundedInteger(input.noProgressLimit, 2, 1, 5),
    horizonHours: boundedInteger(input.horizonHours, 5, 1, campaignSupervisor ? 168 : 24),
    capacityBackoffSeconds: boundedInteger(input.capacityBackoffSeconds, 5, 1, 300),
    capacityMaxBackoffSeconds: boundedInteger(input.capacityMaxBackoffSeconds, 60, 1, 900),
    capacityWaitChecks: boundedInteger(input.capacityWaitChecks, 60, 1, 300),
    ...(campaignSupervisor ? {
      programMaxEvents: boundedInteger(input.programMaxEvents, 0, 0, 5000),
      programMaxTokens: boundedInteger(input.programMaxTokens, 0, 0, 1_000_000_000),
      programMaxDurationMs: boundedInteger(input.programMaxDurationMs, 0, 0, 30_000_000_000),
      programMaxAttempts: boundedInteger(input.programMaxAttempts, 0, 0, 5000),
      programMaxArtifacts: boundedInteger(input.programMaxArtifacts, 0, 0, 25000),
      programMaxArtifactBytes: boundedInteger(input.programMaxArtifactBytes, 0, 0, 2 * 1024 * 1024 * 1024),
      programMaxWorkers: boundedInteger(input.programMaxWorkers, 0, 0, 20),
      programMaxGlobalWorkers: boundedInteger(input.programMaxGlobalWorkers, 0, 0, 100),
      programMaxCampaigns: boundedInteger(input.programMaxCampaigns, 0, 0, 5000),
    } : {}),
  };
}

async function waitForCapacityRecovery(input, descriptor, deadline, inventoryFn, config, dependencies = {}) {
  const sleep = dependencies.capacitySleep || ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const readState = dependencies.readCoordinator || readCoordinator;
  let checks = 0;
  let backoffMs = Math.max(1000, Number(config.capacityBackoffSeconds || descriptor.backoffSeconds || 5) * 1000);
  const maxBackoffMs = Math.max(backoffMs, Number(config.capacityMaxBackoffSeconds || descriptor.maxBackoffSeconds || 60) * 1000);
  const maximumChecks = Math.max(1, Number(config.capacityWaitChecks || descriptor.maximumChecks || 60));
  while (Date.now() < deadline && checks < maximumChecks) {
    const current = readState(input);
    if (current?.executionId !== input.executionId) return { recovered: false, stopReason: "superseded", checks };
    if (current?.state === "cancel-requested") return { recovered: false, stopReason: "cancelled", checks };
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    await sleep(Math.min(backoffMs, remainingMs));
    const afterWait = readState(input);
    if (afterWait?.executionId !== input.executionId) return { recovered: false, stopReason: "superseded", checks };
    if (afterWait?.state === "cancel-requested") return { recovered: false, stopReason: "cancelled", checks };
    const resources = await inventoryFn({ refresh: false, forDispatch: false, horizonHours: config.horizonHours });
    checks += 1;
    if (capacityRequirementSatisfied(descriptor, resources)) return { recovered: true, resources, checks };
    backoffMs = Math.min(maxBackoffMs, backoffMs * 2);
  }
  return { recovered: false, stopReason: "capacity-wait", checks };
}

function targetArgs(input = {}) {
  const descriptor = target(input);
  return descriptor.type === "portfolio" ? { portfolioId: descriptor.portfolioId } : { taskId: descriptor.taskId };
}

function executionId() {
  return `execution-${Date.now().toString(36)}-${crypto.randomBytes(6).toString("hex")}`;
}

function material(input, execution, value) {
  return appendMaterialEvent(input, { executionId: execution.executionId, ...value });
}

function compactCoordinator(input, state = readCoordinator(input)) {
  if (!state) return { state: "not-started", active: false };
  const active = SUPERVISOR_ACTIVE_STATES.has(state.state) && processAlive(state.pid);
  return {
    executionId: state.executionId,
    state: active ? state.state : SUPERVISOR_ACTIVE_STATES.has(state.state) ? "interrupted" : state.state,
    active,
    pid: active ? state.pid : null,
    startedAt: state.startedAt || null,
    finishedAt: state.finishedAt || null,
    roundsStarted: Number(state.roundsStarted || 0),
    stopReason: state.stopReason || "",
    lastMaterialEvent: readMaterialEvents({ ...targetArgs(input), maxEvents: 1 }).lastEvent,
    config: state.config || null,
    campaignSupervisor: state.campaignSupervisor === true,
    campaignSlices: Number(state.campaignSlices || 0),
    programSupervisorId: state.programSupervisorId || null,
    programSupervisorDeadlineAt: state.programSupervisorDeadlineAt || null,
    programNoProgressCount: Number(state.programNoProgressCount || 0),
    programWakeCount: Number(state.programWakeCount || 0),
    nextWakeAt: state.nextWakeAt || null,
  };
}

function writeCoordinator(input, patch) {
  const file = coordinatorFile(input);
  return withDirectoryLock(`${file}.lock`, () => {
    const current = readJson(file, {});
    const effective = { ...patch };
    const currentExecution = String(current.executionId || "");
    const incomingExecution = String(effective.executionId || currentExecution);
    if (currentExecution && effective.executionId && currentExecution !== effective.executionId && effective.state !== "launching") {
      return current;
    }
    const sameExecution = !currentExecution || !incomingExecution || currentExecution === incomingExecution;
    if (!sameExecution && current.state === "cancel-requested" && effective.state === "launching") return current;
    if (sameExecution && current.state === "cancel-requested" && effective.state && effective.state !== "cancel-requested") {
      if (COORDINATOR_TERMINAL_STATES.has(effective.state)) {
        effective.state = "cancelled";
        effective.stopReason = "cancelled";
      } else {
        delete effective.state;
        delete effective.pid;
      }
    } else if (sameExecution && COORDINATOR_TERMINAL_STATES.has(current.state) && effective.state && effective.state !== current.state) {
      delete effective.state;
      delete effective.pid;
      delete effective.startedAt;
      delete effective.finishedAt;
      delete effective.stopReason;
      delete effective.blocker;
    }
    const next = { schemaVersion: 1, ...current, ...effective, revision: Number(current.revision || 0) + 1, updatedAt: utcNow() };
    writeJson(file, next);
    return next;
  });
}

function startCoordinator(input = {}, entrypoint) {
  const args = targetArgs(input);
  if (args.taskId) repairDirectorLegacyRounds(args.taskId);
  const summary = taskSummary(args);
  if (summary.state === "completed") return { ...args, state: "completed", active: false, completionAllowed: true, noDesktopUiLaunched: true };
  let durableSupervisor = args.taskId && input.campaignSupervisor === true
    ? readProgramSupervisor(readTask(args.taskId))
    : null;
  if (durableSupervisor) {
    durableSupervisor = ensureProgramSupervisor(args.taskId, input) || durableSupervisor;
  }
  if (durableSupervisor && ["stopped", "completed", "cancelled"].includes(durableSupervisor.state)) {
    return {
      ...args,
      state: durableSupervisor.state,
      active: false,
      stopReason: durableSupervisor.stopReason || "program-supervisor-not-active",
      programSupervisorId: durableSupervisor.supervisorId,
      programSupervisorDeadlineAt: durableSupervisor.deadlineAt,
      noDesktopUiLaunched: true,
    };
  }
  const existing = readCoordinator(args);
  if (SUPERVISOR_ACTIVE_STATES.has(existing?.state) && processAlive(existing.pid)) {
    return { ...args, ...compactCoordinator(args, existing), reused: true, noDesktopUiLaunched: true };
  }
  if (SUPERVISOR_ACTIVE_STATES.has(existing?.state) && !processAlive(existing.pid)) {
    writeCoordinator(args, { executionId: existing.executionId, state: "interrupted", pid: null, finishedAt: utcNow(), stopReason: "coordinator-process-lost" });
    appendMaterialEvent(args, {
      type: "coordinator.interrupted",
      state: "interrupted",
      executionId: existing.executionId,
      summary: "The deterministic coordinator process ended before a terminal record; durable task and worker state will be reconciled once.",
      blocker: "coordinator-process-lost",
      nextAction: "Resume from authoritative task and worker state without duplicating completed collection or integration.",
    });
  }
  let config = coordinatorConfig(input);
  if (durableSupervisor && ["active", "waiting"].includes(durableSupervisor.state)) {
    config = { ...config, horizonHours: Number(durableSupervisor.horizonHours || config.horizonHours) };
  }
  const id = executionId();
  const createdAt = utcNow();
  const payload = {
    ...args,
    executionId: id,
    config,
    createdAt,
    campaignSupervisor: input.campaignSupervisor === true,
    campaignStartedAt: durableSupervisor?.startedAt || createdAt,
  };
  const payloadFile = coordinatorPayloadFile(args);
  writeJson(payloadFile, payload);
  writeCoordinator(args, {
    executionId: id,
    state: "launching",
    pid: null,
    startedAt: payload.createdAt,
    finishedAt: null,
    stopReason: "",
    roundsStarted: 0,
    lastRoundId: null,
    config,
    campaignSupervisor: payload.campaignSupervisor,
    campaignStartedAt: payload.campaignStartedAt,
    campaignSlices: 0,
    nextWakeAt: null,
    programSupervisorId: durableSupervisor?.supervisorId || null,
    programSupervisorDeadlineAt: durableSupervisor?.deadlineAt || null,
    programNoProgressCount: Number(durableSupervisor?.noProgressCount || 0),
    programWakeCount: Number(durableSupervisor?.wakeCount || 0),
  });
  let child;
  try {
    child = spawn(process.execPath, [entrypoint, payload.campaignSupervisor ? "campaign-supervisor" : "coordinator", "--json-file", payloadFile], {
      cwd: path.dirname(entrypoint),
      windowsHide: true,
      detached: true,
      stdio: "ignore",
    });
    child.unref();
  } catch (error) {
    writeCoordinator(args, { executionId: id, state: "failed", pid: null, finishedAt: utcNow(), stopReason: "coordinator-launch-failed", blocker: bounded(error.message, 800) });
    throw error;
  }
  const state = writeCoordinator(args, { executionId: id, state: "running", pid: child.pid });
  if (state.state === "running" && processAlive(state.pid)) {
    material(args, state, {
      type: "coordinator.started",
      state: "running",
      summary: "A finite event-driven coordinator started; the visible task owns no project files.",
      nextAction: "Wait for a material worker, integration, blocker, or acceptance transition.",
      data: { maxRounds: config.maxRounds, maxMinutes: config.maxMinutes, noProgressLimit: config.noProgressLimit },
    });
  }
  return { ...args, ...compactCoordinator(args, state), reused: false, noDesktopUiLaunched: true };
}

function roundRecord(args, roundId) {
  return args.portfolioId ? readPortfolioRound(args.portfolioId, roundId) : readRound(args.taskId, roundId);
}

function roundStatuses(args, round) {
  return (round.jobs || []).map((job) => {
    const taskId = job.taskId || args.taskId;
    try { return { ...job, taskId, status: statusFor(taskId, job.jobId) }; }
    catch (error) { return { ...job, taskId, status: { state: "failed", blocker: `worker-record-missing: ${bounded(error.message, 400)}` } }; }
  });
}

function waitForRoundTerminal(args, round, deadline) {
  const initial = roundStatuses(args, round);
  if (!initial.length || initial.every((row) => TERMINAL_STATES.has(row.status.state))) return Promise.resolve({ terminal: true, rows: initial });
  return new Promise((resolve) => {
    const watchers = [];
    let timer = null;
    let fallback = null;
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      for (const watcher of watchers) {
        try { watcher.close(); } catch { /* already closed */ }
      }
      if (timer) clearTimeout(timer);
      if (fallback) clearInterval(fallback);
      resolve(value);
    };
    const inspect = () => {
      let rows;
      try { rows = roundStatuses(args, round); }
      catch { return; }
      if (rows.every((row) => TERMINAL_STATES.has(row.status.state))) finish({ terminal: true, rows });
    };
    for (const row of initial) {
      if (TERMINAL_STATES.has(row.status.state)) continue;
      try {
        const watcher = fs.watch(path.dirname(path.join(target({ taskId: row.taskId }).root, "jobs", row.jobId, "status.json")), { persistent: true }, inspect);
        watcher.on("error", () => { /* bounded deterministic reconciliation below remains authoritative */ });
        watchers.push(watcher);
      } catch { /* bounded deterministic reconciliation below remains authoritative */ }
    }
    fallback = setInterval(inspect, 1000);
    const waitMs = Math.max(1, deadline - Date.now());
    timer = setTimeout(() => {
      const rows = roundStatuses(args, round);
      finish({ terminal: rows.every((row) => TERMINAL_STATES.has(row.status.state)), rows, deadlineReached: true });
    }, waitMs);
  });
}

function progressSignature(summary) {
  if (summary.portfolioId) {
    return JSON.stringify((summary.projects || []).map((project) => ({
      taskId: project.taskId,
      state: project.state,
      passing: project.progress?.passing || 0,
      graph: (project.workGraph || []).map((node) => [node.id, node.state]),
      evidence: (project.requirements || []).reduce((total, row) => total + Number(row.evidenceCount || 0), 0),
    })));
  }
  if (summary.program?.mode === "director-cfo") {
    return JSON.stringify({
      completed: summary.state === "completed",
      passing: summary.progress?.passing || 0,
      acceptedEvidence: (summary.program.report?.acceptedEvidence || [])
        .filter((row) => row.passed === true)
        .map((row) => [row.requirementId, row.level, row.ref]),
    });
  }
  return JSON.stringify({
    state: summary.state,
    passing: summary.progress?.passing || 0,
    graph: (summary.workGraph || []).map((node) => [node.id, node.state]),
    evidence: (summary.requirements || []).reduce((total, row) => total + Number(row.evidenceCount || 0), 0),
  });
}

function completedEnough(summary) {
  if (summary.state === "completed") return true;
  if (summary.portfolioId) {
    const projectsReady = (summary.projects || []).length > 0 && (summary.projects || []).every((project) => project.state === "completed" || (project.progress?.required > 0 && project.progress.passing === project.progress.required));
    const portfolioRequirementsReady = (summary.portfolioRequirements || []).every((row) => row.status === "passing");
    return summary.completionAllowed === true || (projectsReady && portfolioRequirementsReady);
  }
  return summary.progress?.required > 0 && summary.progress.passing === summary.progress.required;
}

function completionReady(summary) {
  if (!summary.portfolioId) return completedEnough(summary);
  if (completedEnough(summary)) return true;
  return (summary.projects || []).some((project) => project.state !== "completed"
    && Number(project.progress?.required || 0) > 0
    && project.progress.passing === project.progress.required);
}

function workerDetails(results = []) {
  return results.map((row) => ({
    jobId: row.jobId,
    projectId: row.projectId || null,
    provider: row.provider,
    model: row.model,
    state: row.state,
    blocker: bounded(row.blocker, 600),
  }));
}

function campaignStateFingerprint(task = {}) {
  const program = task.program || {};
  return crypto.createHash("sha256").update(JSON.stringify({
    taskState: task.state || "",
    phase: program.phase || "",
    contextRevision: Number(program.contextDossier?.contextRevision || program.contextDossier?.revision || 0),
    contextFingerprint: program.contextDossier?.contextFingerprint || program.contextDossier?.fingerprint || "",
    planRevision: Number(program.masterPlan?.planRevision || program.masterPlan?.revision || 0),
    planFingerprint: program.masterPlan?.planFingerprint || program.masterPlan?.fingerprint || "",
    budgetRevision: Number(program.runtime?.budget?.budgetRevision || program.resourceBudget?.revision || 0),
    budgetFingerprint: program.resourceBudget?.inventoryFingerprint || program.resourceBudget?.fingerprint || "",
    requirements: (task.requirements || []).map((row) => [row.id, row.status, (row.evidence || []).length]),
    workPackages: (program.workPackages || []).map((row) => [row.workPackageId, row.state, row.jobId || "", row.executionReceiptId || ""]),
    evidence: (program.evidenceLedger?.entries || []).map((row) => [row.requirementId || row.id || "", row.level || "", row.ref || "", row.passed === true || row.accepted === true]),
  })).digest("hex");
}

const CAMPAIGN_EVIDENCE_RANK = Object.freeze({
  activity: 0,
  "process-health": 1,
  "focused-test": 2,
  integration: 3,
  "end-to-end": 4,
  "user-visible": 5,
});

function campaignAcceptedEvidenceFingerprint(task = {}) {
  const required = new Map((task.requirements || [])
    .filter((row) => row.required !== false)
    .map((row) => [String(row.id || ""), row]));
  const passingRows = [...required.values()]
    .filter((row) => row.status === "passing")
    .map((row) => ({ requirementId: String(row.id || ""), level: "requirement-status", ref: "passing", passed: true }));
  const requirementEvidence = [...required.values()].flatMap((row) => (row.evidence || []).map((evidence) => ({
    ...evidence,
    requirementId: row.id,
  })));
  const candidates = [
    ...requirementEvidence,
    ...(task.evidence || []),
    ...(task.program?.evidenceLedger?.entries || []),
  ];
  const acceptedRows = candidates.flatMap((row) => {
    const requirementId = String(row.requirementId || row.id || "");
    const requirement = required.get(requirementId);
    const level = String(row.level || "").toLowerCase();
    const ref = String(row.ref || row.proofRef || "");
    if (!requirement || !ref || ["activity", "process-health"].includes(level)) return [];
    if (row.accepted === false || !(row.accepted === true || row.status === "passing" || row.passed === true)) return [];
    const minimumLevel = String(requirement.minimumEvidenceLevel || "focused-test").toLowerCase();
    if (Number(CAMPAIGN_EVIDENCE_RANK[level] ?? -1) < Number(CAMPAIGN_EVIDENCE_RANK[minimumLevel] ?? 2)) return [];
    return [{ requirementId, level, ref, passed: true }];
  });
  const canonical = [...new Map([...passingRows, ...acceptedRows]
    .map((row) => [`${row.requirementId}\u0000${row.level}\u0000${row.ref}`, row])).values()]
    .sort((left, right) => `${left.requirementId}\u0000${left.level}\u0000${left.ref}`.localeCompare(`${right.requirementId}\u0000${right.level}\u0000${right.ref}`));
  return evidenceFingerprint(canonical);
}
const FOUNDATION_PHASE_RANK = new Map([
  ["bootstrap", 0],
  ["context", 1],
  ["strategy", 2],
  ["planning", 2],
  ["budget", 3],
  ["execution", 4],
  ["integration", 5],
  ["verification", 6],
  ["reconciliation", 6],
  ["acceptance", 7],
  ["completed", 8],
]);

function campaignFoundationState(task = {}) {
  const program = task.program || {};
  const phase = String(program.phase || "").toLowerCase();
  const state = {
    phase,
    phaseRank: FOUNDATION_PHASE_RANK.has(phase) ? FOUNDATION_PHASE_RANK.get(phase) : -1,
    contextRevision: Number(program.contextDossier?.contextRevision || program.contextDossier?.revision || 0),
    contextFingerprint: program.contextDossier?.contextFingerprint || program.contextDossier?.fingerprint || "",
    planRevision: Number(program.masterPlan?.planRevision || program.masterPlan?.revision || 0),
    planFingerprint: program.masterPlan?.planFingerprint || program.masterPlan?.fingerprint || "",
    budgetRevision: Number(program.runtime?.budget?.budgetRevision || program.resourceBudget?.revision || 0),
    reconciliationTransitions: [...new Set((program.workPackages || [])
      .filter((row) => row.executorKind === "reconciliation" && row.state === "completed" && row.jobId)
      .map((row) => String(row.failurePacket?.failureFingerprint || row.materialDeltaRequired?.failureFingerprint || "").trim())
      .filter(Boolean))].sort(),
  };
  return {
    ...state,
    fingerprint: crypto.createHash("sha256").update(JSON.stringify(state)).digest("hex"),
  };
}


function campaignFoundationTransition(before = {}, after = {}, campaign = {}) {
  const candidates = [];
  if (Number(after.phaseRank) > Number(before.phaseRank)) candidates.push(`phase:${after.phaseRank}`);
  if (Number(after.contextRevision) > Number(before.contextRevision)) candidates.push("context");
  if (Number(after.planRevision) > Number(before.planRevision)) candidates.push("plan");
  if (Number(after.budgetRevision) > Number(before.budgetRevision)) candidates.push("budget");
  const priorReconciliations = new Set(before.reconciliationTransitions || []);
  for (const failureFingerprint of after.reconciliationTransitions || []) {
    if (!priorReconciliations.has(failureFingerprint)) candidates.push(`reconciliation:${failureFingerprint}`);
  }
  const consumed = new Set(campaign.foundationTransitions || campaign.supervisorContinuation?.foundationTransitions || []);
  const keys = [...new Set(candidates)].filter((key) => !consumed.has(key));
  return {
    changed: after.fingerprint !== before.fingerprint,
    eligible: keys.length > 0,
    keys,
  };
}
const PROGRAM_WAKE_REASONS = new Set([
  "worker-terminal",
  "dependency-change",
  "evidence-change",
  "quota-reset",
  "scheduled-observation",
  "retry-eligible",
  "cancel",
  "user-correction",
]);

function readProgramSupervisor(task = {}) {
  return task.program?.runtime?.programSupervisor || null;
}

function positiveLimit(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

function observedProgramCampaignCount(task = {}, supervisor = {}) {
  const rows = [
    ...(task.program?.campaigns || []),
    task.program?.activeCampaign,
    task.program?.contracts?.campaign,
  ].filter(Boolean);
  const maximumEpoch = rows.reduce((maximum, row) => Math.max(maximum, positiveLimit(row.epoch)), 0);
  const observedIds = new Set(rows.map((row) => String(row.campaignId || "")).filter(Boolean));
  return Math.max(Number(supervisor.campaignCount || 0), maximumEpoch, observedIds.size);
}

function explicitProgramLimitCeilings(payload = {}) {
  const config = payload.config || payload || {};
  const mappings = {
    maxEvents: "programMaxEvents",
    maxTokens: "programMaxTokens",
    maxDurationMs: "programMaxDurationMs",
    maxAttempts: "programMaxAttempts",
    maxArtifacts: "programMaxArtifacts",
    maxArtifactBytes: "programMaxArtifactBytes",
    maxWorkers: "programMaxWorkers",
    maxGlobalWorkers: "programMaxGlobalWorkers",
    maxCampaigns: "programMaxCampaigns",
  };
  return Object.fromEntries(Object.entries(mappings)
    .map(([limitKey, configKey]) => [limitKey, positiveLimit(config[configKey])])
    .filter(([, value]) => value > 0));
}

function mergeProgramHardCeilings(existing = {}, incoming = {}) {
  const keys = new Set([...Object.keys(existing || {}), ...Object.keys(incoming || {})]);
  const merged = {};
  for (const key of keys) {
    const prior = positiveLimit(existing?.[key]);
    const next = positiveLimit(incoming?.[key]);
    const ceiling = prior && next ? Math.min(prior, next) : prior || next;
    if (ceiling) merged[key] = ceiling;
  }
  return merged;
}

function clampProgramLimits(limits = {}, hardCeilings = {}) {
  const clamped = { ...(limits || {}) };
  for (const [key, rawCeiling] of Object.entries(hardCeilings || {})) {
    const ceiling = positiveLimit(rawCeiling);
    if (!ceiling) continue;
    const current = positiveLimit(clamped[key]);
    clamped[key] = current ? Math.min(current, ceiling) : ceiling;
  }
  return clamped;
}
function acceptedProgramBudgetLimitSource(task = {}) {
  const contracts = task.program?.contracts || {};
  const plan = contracts.masterPlan || null;
  const budget = contracts.resourceBudget || null;
  if (!plan || !budget || plan.state !== "approved" || budget.state !== "active") return null;
  if (!plan.approval || !budget.budgetId || !budget.inventoryFingerprint || !budget.forecastFingerprint) return null;
  if (String(budget.planId || "") !== String(plan.planId || "")) return null;
  if (Number(budget.planRevision || 0) !== Number(plan.revision || 0)) return null;
  const sourceFingerprint = String(budget.fingerprint || crypto.createHash("sha256").update(JSON.stringify({
    budgetId: budget.budgetId,
    revision: budget.revision,
    planId: budget.planId,
    planRevision: budget.planRevision,
    inventoryFingerprint: budget.inventoryFingerprint,
    forecastFingerprint: budget.forecastFingerprint,
    limits: budget.limits || {},
    reserves: budget.reserves || {},
  })).digest("hex"));
  return {
    kind: "accepted-resource-budget",
    budgetId: String(budget.budgetId),
    revision: Number(budget.revision || 0),
    fingerprint: sourceFingerprint,
    planId: String(plan.planId || ""),
    planRevision: Number(plan.revision || 0),
    inventoryFingerprint: String(budget.inventoryFingerprint || ""),
    forecastFingerprint: String(budget.forecastFingerprint || ""),
    reserves: budget.reserves || {},
  };
}

function budgetSourceRecord(budget = {}) {
  return {
    budgetId: String(budget.budgetId || ""),
    revision: Number(budget.revision || budget.budgetRevision || 0),
    missionId: String(budget.missionId || ""),
    planId: String(budget.planId || ""),
    planRevision: Number(budget.planRevision || 0),
    inventoryFingerprint: String(budget.inventoryFingerprint || ""),
    forecastFingerprint: String(budget.forecastFingerprint || ""),
    limits: budget.limits || {},
    reserves: budget.reserves || {},
    allocations: (budget.allocations || []).map((row) => ({
      allocationId: String(row.allocationId || ""),
      workPackageId: String(row.workPackageId || ""),
      provider: String(row.provider || ""),
      model: String(row.model || ""),
      tokenLimit: Number(row.tokenLimit || 0),
      durationLimitMs: Number(row.durationLimitMs || 0),
      maxAttempts: Number(row.maxAttempts || 0),
    })).sort((left, right) => left.allocationId.localeCompare(right.allocationId)),
  };
}

function bootstrapResourceBudgetEnvelope(task = {}) {
  const program = task.program || {};
  const approvedContractPlan = program.contracts?.masterPlan?.state === "approved"
    ? program.contracts.masterPlan
    : null;
  const recoveryBudget = Boolean(approvedContractPlan && !program.masterPlan);
  if (approvedContractPlan && !recoveryBudget) return null;
  const durableBudget = program.resourceBudget && typeof program.resourceBudget === "object" ? program.resourceBudget : null;
  const runtimeBudget = program.runtime?.budget && typeof program.runtime.budget === "object" ? program.runtime.budget : null;
  if (!durableBudget && !runtimeBudget) return null;
  const budget = durableBudget || runtimeBudget;
  const record = budgetSourceRecord(budget);
  if (!["draft", "active"].includes(String(budget.state || ""))) return null;
  if (!record.budgetId || record.revision <= 0 || !record.inventoryFingerprint || !record.forecastFingerprint) return null;
  if (record.missionId && program.mission?.missionId && record.missionId !== String(program.mission.missionId)) return null;
  const boundedDimensions = [
    record.limits.maxTokens,
    record.limits.maxDurationMs,
    record.limits.maxAttempts,
    record.limits.maxConcurrentWorkers,
    record.limits.maxConcurrent,
  ].map(positiveLimit).filter(Boolean);
  if (!boundedDimensions.length) return null;
  if (durableBudget && runtimeBudget) {
    const durableRecord = budgetSourceRecord(durableBudget);
    const runtimeRecord = budgetSourceRecord(runtimeBudget);
    const durableFingerprint = crypto.createHash("sha256").update(JSON.stringify(durableRecord)).digest("hex");
    const runtimeFingerprint = crypto.createHash("sha256").update(JSON.stringify(runtimeRecord)).digest("hex");
    if (durableFingerprint !== runtimeFingerprint) return null;
  }
  if (recoveryBudget) {
    const packages = new Map((program.workPackages || []).map((row) => [String(row.workPackageId || ""), row]));
    const recoveryKinds = new Set(["context-scout", "strategist", "reconciliation"]);
    const mutatingPermissions = new Set([
      "write-files", "write-project", "command", "run-command", "execute-commands", "service-control",
      "browser", "external-write", "database-write", "git-write",
    ]);
    const allocations = record.allocations || [];
    const eligible = allocations.length > 0 && allocations.every((allocation) => {
      const workPackage = packages.get(allocation.workPackageId);
      if (!workPackage || !["pending", "ready"].includes(String(workPackage.state || ""))) return false;
      if (workPackage.readOnly !== true || !recoveryKinds.has(String(workPackage.executorKind || ""))) return false;
      if (Number(workPackage.budgetRevision || 0) !== Number(record.revision || 0)) return false;
      if (String(workPackage.allocation?.allocationId || "") !== allocation.allocationId) return false;
      const permissions = [
        ...(workPackage.requiredPermissions || []),
        ...(workPackage.permissionGrant || []),
        ...((budget.allocations || []).find((row) => String(row.allocationId || "") === allocation.allocationId)?.permissions || []),
      ].map((value) => String(value || "").trim());
      return permissions.every((permission) => !mutatingPermissions.has(permission));
    });
    if (!eligible) return null;
  }
  const sourceFingerprint = crypto.createHash("sha256").update(JSON.stringify(record)).digest("hex");
  return {
    budget,
    source: {
      kind: recoveryBudget ? "recovery-resource-budget" : "bootstrap-resource-budget",
      budgetId: record.budgetId,
      revision: record.revision,
      fingerprint: sourceFingerprint,
      planId: recoveryBudget ? String(approvedContractPlan.planId || "") : record.planId,
      planRevision: recoveryBudget ? Number(approvedContractPlan.revision || 0) : record.planRevision,
      inventoryFingerprint: record.inventoryFingerprint,
      forecastFingerprint: record.forecastFingerprint,
      reserves: budget.reserves || {},
    },
  };
}

function programBudgetLimitEnvelope(task = {}) {
  const acceptedSource = acceptedProgramBudgetLimitSource(task);
  const acceptedEnvelope = acceptedSource
    ? { source: acceptedSource, budget: task.program?.contracts?.resourceBudget || null }
    : null;
  const provisionalEnvelope = bootstrapResourceBudgetEnvelope(task);
  if (!acceptedEnvelope) return provisionalEnvelope;
  if (!provisionalEnvelope) return acceptedEnvelope;
  return programBudgetSourceIsNewer(acceptedEnvelope.source, provisionalEnvelope.source)
    ? provisionalEnvelope
    : acceptedEnvelope;
}

function bootstrapProgramLimitSource(limits = {}) {
  return {
    kind: "bootstrap",
    budgetId: "",
    revision: 0,
    fingerprint: crypto.createHash("sha256").update(JSON.stringify(limits)).digest("hex"),
    planId: "",
    planRevision: 0,
    inventoryFingerprint: "",
    forecastFingerprint: "",
    reserves: {},
  };
}

const CONSERVATIVE_PROGRAM_BOOTSTRAP_LIMITS = Object.freeze({
  maxEvents: 50,
  maxTokens: 50_000,
  maxDurationMs: 30 * 60 * 1000,
  maxAttempts: 4,
  maxArtifacts: 250,
  maxArtifactBytes: 100 * 1024 * 1024,
  maxCampaigns: 50,
});
function programSupervisorLimits(task = {}, payload = {}, horizonHours = 5, currentLimits = {}, exposure = null) {
  const config = payload.config || payload || {};
  const budgetEnvelope = programBudgetLimitEnvelope(task);
  const budgetSource = budgetEnvelope?.source || null;
  const sourceBudget = budgetEnvelope?.budget || null;
  const acceptedCampaign = budgetSource?.kind === "accepted-resource-budget"
    ? task.program?.contracts?.campaign || null
    : null;
  const budgetLimits = sourceBudget?.limits || {};
  const campaignCap = acceptedCampaign?.resourceCap || {};
  const campaignLimits = task.program?.activeCampaign?.limits || {};
  const committed = exposure?.totals || {};
  const authorized = exposure?.authorization?.totals || {};
  const exposureValue = (metric) => Math.max(
    positiveLimit(committed?.[metric]?.committed),
    positiveLimit(authorized?.[metric]),
  );
  const acceptedCeiling = (...values) => {
    const rows = values.map(positiveLimit).filter(Boolean);
    return rows.length ? Math.min(...rows) : 0;
  };
  const fixed = (key, requestedKey, fallback, minimum, maximum, exposureFloor = 0, coverObservedWhenBudgetMissing = false, ...acceptedValues) => {
    const existing = positiveLimit(currentLimits[key]);
    if (existing) return boundedInteger(existing, existing, minimum, maximum);
    const requested = positiveLimit(config[requestedKey]);
    const accepted = acceptedCeiling(...acceptedValues);
    const selected = accepted
      ? Math.min(accepted, requested || accepted)
      : requested || fallback;
    const effective = !requested && coverObservedWhenBudgetMissing && sourceBudget && !accepted
      ? Math.max(selected, positiveLimit(exposureFloor))
      : selected;
    return boundedInteger(effective, fallback, minimum, maximum);
  };
  const policyWorkers = positiveLimit(task.program?.policy?.maxWorkers) || 2;
  const acceptedWorkers = positiveLimit(budgetLimits.maxConcurrentWorkers)
    || positiveLimit(budgetLimits.maxConcurrent)
    || acceptedCeiling(campaignCap.maxConcurrentWorkers, campaignLimits.maxWorkers);
  const maxWorkers = fixed(
    "maxWorkers",
    "programMaxWorkers",
    policyWorkers,
    1,
    20,
    positiveLimit(exposure?.concurrency?.programActive),
    true,
    acceptedWorkers,
  );
  const defaultEvents = CONSERVATIVE_PROGRAM_BOOTSTRAP_LIMITS.maxEvents;
  const maxEvents = fixed("maxEvents", "programMaxEvents", defaultEvents, 20, 5000, 0);
  const limits = {
    noProgressLimit: boundedInteger(positiveLimit(currentLimits.noProgressLimit) || task.program?.policy?.noProgressLimit || config.noProgressLimit, 2, 1, 5),
    maxEvents,
    maxTokens: fixed(
      "maxTokens",
      "programMaxTokens",
      CONSERVATIVE_PROGRAM_BOOTSTRAP_LIMITS.maxTokens,
      1,
      1_000_000_000,
      exposureValue("tokens"),
      true,
      positiveLimit(budgetLimits.maxTokens) || campaignCap.maxTokens,
    ),
    maxDurationMs: fixed(
      "maxDurationMs",
      "programMaxDurationMs",
      CONSERVATIVE_PROGRAM_BOOTSTRAP_LIMITS.maxDurationMs,
      1000,
      30_000_000_000,
      exposureValue("durationMs"),
      true,
      positiveLimit(budgetLimits.maxDurationMs) || campaignCap.maxDurationMs,
    ),
    maxAttempts: fixed(
      "maxAttempts",
      "programMaxAttempts",
      CONSERVATIVE_PROGRAM_BOOTSTRAP_LIMITS.maxAttempts,
      1,
      5000,
      exposureValue("attempts"),
      true,
      positiveLimit(budgetLimits.maxAttempts) || campaignCap.maxAttempts,
    ),
    maxArtifacts: fixed(
      "maxArtifacts",
      "programMaxArtifacts",
      CONSERVATIVE_PROGRAM_BOOTSTRAP_LIMITS.maxArtifacts,
      10,
      25000,
      positiveLimit(committed?.artifacts?.committed),
      false,
      campaignLimits.maxArtifacts,
    ),
    maxArtifactBytes: fixed(
      "maxArtifactBytes",
      "programMaxArtifactBytes",
      CONSERVATIVE_PROGRAM_BOOTSTRAP_LIMITS.maxArtifactBytes,
      1024 * 1024,
      2 * 1024 * 1024 * 1024,
      positiveLimit(committed?.durableBytes?.committed),
      false,
      campaignLimits.maxArtifactBytes,
    ),
    maxWorkers,
    maxCampaigns: fixed(
      "maxCampaigns",
      "programMaxCampaigns",
      CONSERVATIVE_PROGRAM_BOOTSTRAP_LIMITS.maxCampaigns,
      1,
      5000,
      observedProgramCampaignCount(task, task.program?.runtime?.programSupervisor || {}),
      false,
    ),
  };
  const existingGlobal = positiveLimit(currentLimits.maxGlobalWorkers);
  const requestedGlobal = positiveLimit(config.programMaxGlobalWorkers);
  const acceptedGlobal = acceptedCeiling(task.program?.runtime?.ledger?.limits?.maxGlobalConcurrency);
  if (existingGlobal || requestedGlobal || acceptedGlobal) {
    limits.maxGlobalWorkers = existingGlobal
      || (acceptedGlobal ? Math.min(acceptedGlobal, requestedGlobal || acceptedGlobal) : requestedGlobal);
  }
  return limits;
}
function programBudgetCumulativeLimits(task = {}, payload = {}, candidateLimits = {}, exposure = null, hardCeilings = {}) {
  const envelope = programBudgetLimitEnvelope(task);
  const source = envelope?.source || null;
  const budget = envelope?.budget || null;
  if (!source || !budget || !exposure) return { limits: candidateLimits, baseline: null };
  const fundedAllocationIds = new Set((budget.allocations || []).map((row) => String(row.allocationId || "")).filter(Boolean));
  const allocationRows = exposure.authorization?.allocations || [];
  const metricExposure = (row, metric) => Math.max(
    Number(row.capacity?.[metric] ?? row.authorized?.[metric] ?? 0),
    Number(row.committed?.[metric] || 0),
  );
  const totalExposure = (metric) => Math.max(
    Number(exposure.authorization?.capacityTotals?.[metric] ?? exposure.authorization?.totals?.[metric] ?? 0),
    Number(exposure.totals?.[metric]?.committed || 0),
  );
  const sameBudgetExposure = (metric) => allocationRows
    .filter((row) => fundedAllocationIds.has(String(row.allocationId || "")))
    .reduce((sum, row) => sum + metricExposure(row, metric), 0);
  const sameBudgetCommitted = (metric) => allocationRows
    .filter((row) => fundedAllocationIds.has(String(row.allocationId || "")))
    .reduce((sum, row) => sum + Number(row.committed?.[metric] || 0), 0);
  const config = payload.config || payload || {};
  const metricRows = [
    { metric: "tokens", limitKey: "maxTokens", configKey: "programMaxTokens", budgetValue: budget.limits?.maxTokens },
    { metric: "durationMs", limitKey: "maxDurationMs", configKey: "programMaxDurationMs", budgetValue: budget.limits?.maxDurationMs },
    { metric: "attempts", limitKey: "maxAttempts", configKey: "programMaxAttempts", budgetValue: budget.limits?.maxAttempts },
  ];
  const limits = { ...candidateLimits };
  const historicalExposure = {};
  const historicalCommitted = {};
  const fundedExposure = {};
  const acceptedRemainingBudget = {};
  const derivedCumulativeCeiling = {};
  for (const row of metricRows) {
    const total = totalExposure(row.metric);
    const funded = sameBudgetExposure(row.metric);
    const committed = Number(exposure.totals?.[row.metric]?.committed || 0);
    const fundedCommitted = sameBudgetCommitted(row.metric);
    const historical = Math.max(0, total - funded);
    const historicalSpent = Math.max(0, committed - fundedCommitted);
    const accepted = positiveLimit(row.budgetValue);
    if (!accepted) continue;
    const derived = historical + Math.max(accepted, funded);
    const explicitCeiling = positiveLimit(hardCeilings[row.limitKey]) || positiveLimit(config[row.configKey]);
    limits[row.limitKey] = explicitCeiling ? Math.min(derived, explicitCeiling) : derived;
    historicalExposure[row.metric] = historical;
    historicalCommitted[row.metric] = historicalSpent;
    fundedExposure[row.metric] = funded;
    acceptedRemainingBudget[row.metric] = accepted;
    derivedCumulativeCeiling[row.metric] = limits[row.limitKey];
  }
  return {
    limits,
    baseline: {
      sourceKind: source.kind,
      sourceBudgetId: source.budgetId,
      sourceBudgetRevision: source.revision,
      sourceBudgetFingerprint: source.fingerprint,
      resourceSnapshotFingerprint: exposure.fingerprint || "",
      fundedAllocationIds: [...fundedAllocationIds].sort().slice(0, 1000),
      historicalCommitted,
      historicalExposure,
      fundedExposure,
      acceptedRemainingBudget,
      sourceRemainingBudget: acceptedRemainingBudget,
      derivedCumulativeCeiling,
      recordedAt: utcNow(),
    },
  };
}

function programBudgetSourceIsNewer(current = {}, next = {}) {
  if (!next?.fingerprint || current?.fingerprint === next.fingerprint) return false;
  const rank = {
    bootstrap: 0,
    "bootstrap-resource-budget": 1,
    "accepted-resource-budget": 2,
    "recovery-resource-budget": 2,
  };
  const currentRank = Number(rank[current?.kind] ?? -1);
  const nextRank = Number(rank[next?.kind] ?? -1);
  if (nextRank > currentRank) return true;
  if (nextRank < currentRank || nextRank < 1) return false;
  if (next.kind === "bootstrap-resource-budget") {
    return Number(next.revision || 0) > Number(current.revision || 0);
  }
  if (Number(next.planRevision || 0) > Number(current.planRevision || 0)) return true;
  return Number(next.planRevision || 0) === Number(current.planRevision || 0)
    && Number(next.revision || 0) > Number(current.revision || 0);
}

function maybeReviseProgramSupervisorLimits(taskId, task, payload, supervisor) {
  const envelope = programBudgetLimitEnvelope(task);
  const source = envelope?.source || null;
  if (!source || !supervisor || !["active", "waiting"].includes(supervisor.state)) return supervisor;
  const currentSource = supervisor.limitSource || bootstrapProgramLimitSource(supervisor.limits || {});
  if (!programBudgetSourceIsNewer(currentSource, source)) return supervisor;
  let exposure = null;
  try {
    exposure = buildProgramResourceSnapshot({ taskId, task, campaignCount: supervisor.campaignCount });
  } catch {
    return supervisor;
  }
  const hardCeilings = mergeProgramHardCeilings(supervisor.hardCeilings || {}, explicitProgramLimitCeilings(payload));
  const candidateEnvelope = programBudgetCumulativeLimits(
    task,
    payload,
    programSupervisorLimits(task, payload, supervisor.horizonHours, {}, exposure),
    exposure,
    hardCeilings,
  );
  const candidate = { ...candidateEnvelope.limits };
  for (const [key, ceiling] of Object.entries(hardCeilings)) {
    if (positiveLimit(candidate[key])) candidate[key] = Math.min(candidate[key], ceiling);
  }
  const revisedLimits = { ...(supervisor.limits || {}) };
  for (const key of ["maxTokens", "maxDurationMs", "maxAttempts", "maxArtifacts", "maxArtifactBytes", "maxWorkers", "maxGlobalWorkers"]) {
    if (positiveLimit(candidate[key])) revisedLimits[key] = candidate[key];
  }
  let result = supervisor;
  updateTask(taskId, (currentTask) => {
    const currentSupervisor = readProgramSupervisor(currentTask);
    const currentEnvelope = programBudgetLimitEnvelope(currentTask);
    const currentLimitSource = currentEnvelope?.source || null;
    if (!currentSupervisor || !currentLimitSource || !["active", "waiting"].includes(currentSupervisor.state)) return currentTask;
    if (currentLimitSource.fingerprint !== source.fingerprint) return currentTask;
    const persistedSource = currentSupervisor.limitSource || bootstrapProgramLimitSource(currentSupervisor.limits || {});
    if (!programBudgetSourceIsNewer(persistedSource, currentLimitSource)) {
      result = currentSupervisor;
      return currentTask;
    }
    result = {
      ...currentSupervisor,
      limits: revisedLimits,
      limitRevision: Number(currentSupervisor.limitRevision || 1) + 1,
      limitSource: currentLimitSource,
      hardCeilings,
      limitBaseline: candidateEnvelope.baseline,
      limitHistory: [...(currentSupervisor.limitHistory || []), {
        at: utcNow(),
        sourceKind: currentLimitSource.kind,
        sourceBudgetId: currentLimitSource.budgetId,
        sourceBudgetRevision: currentLimitSource.revision,
        sourceBudgetFingerprint: currentLimitSource.fingerprint,
        sourcePlanId: currentLimitSource.planId,
        sourcePlanRevision: currentLimitSource.planRevision,
        priorLimits: currentSupervisor.limits || {},
        newLimits: revisedLimits,
        baseline: candidateEnvelope.baseline,
        reason: currentLimitSource.kind === "accepted-resource-budget"
          ? "accepted-plan-resource-budget-revision"
          : currentLimitSource.kind === "recovery-resource-budget"
            ? "recovery-resource-budget-revision"
            : "bootstrap-resource-budget-revision",
      }].slice(-50),
      updatedAt: utcNow(),
    };
    currentTask.program = {
      ...currentTask.program,
      runtime: { ...(currentTask.program?.runtime || {}), programSupervisor: result },
      updatedAt: utcNow(),
    };
    return currentTask;
  });
  return result;
}
function compactProgramResourceSnapshot(snapshot = {}) {
  return {
    schemaVersion: snapshot.schemaVersion || "director-cfo/program-resource-snapshot@1",
    fingerprint: snapshot.fingerprint || "",
    safe: snapshot.safe === true,
    campaignCount: Number(snapshot.campaign?.count || 0),
    totals: snapshot.totals || {},
    authorization: {
      totals: snapshot.authorization?.totals || {},
      complete: snapshot.authorization?.complete === true,
    },
    concurrency: snapshot.concurrency || {},
    quota: { providerBlockers: snapshot.quota?.providerBlockers || [] },
    blockers: (snapshot.blockers || []).slice(0, 20),
    capCheck: snapshot.capCheck || { safe: true, blockers: [] },
    observedAt: utcNow(),
  };
}

function persistProgramResourceSnapshot(taskId, task, safety = {}) {
  const snapshot = safety.snapshot;
  if (!snapshot) return readProgramSupervisor(task);
  const initial = readProgramSupervisor(task);
  if (!initial) return null;
  const initialCampaignCount = Math.max(Number(initial.campaignCount || 0), Number(snapshot.campaign?.count || 0));
  const initialLastCampaignId = String(task.program?.activeCampaign?.campaignId || snapshot.campaign?.observedIds?.slice(-1)[0] || initial.lastCampaignId || "");
  const initialAllocationIds = [...new Set([
    ...(initial.allocationIds || []),
    ...(snapshot.authorization?.allocations || []).map((row) => row.allocationId),
    ...(task.program?.workPackages || []).map((row) => row.allocation?.allocationId),
  ].filter(Boolean))].slice(-1000);
  if (initial.resourceSnapshot?.fingerprint === snapshot.fingerprint
    && Number(initial.campaignCount || 0) === initialCampaignCount
    && String(initial.lastCampaignId || "") === initialLastCampaignId
    && JSON.stringify(initial.allocationIds || []) === JSON.stringify(initialAllocationIds)) return initial;
  let result = initial;
  updateTask(taskId, (currentTask) => {
    const supervisor = readProgramSupervisor(currentTask);
    if (!supervisor) return currentTask;
    const campaignCount = Math.max(Number(supervisor.campaignCount || 0), Number(snapshot.campaign?.count || 0), observedProgramCampaignCount(currentTask, supervisor));
    const lastCampaignId = String(currentTask.program?.activeCampaign?.campaignId || snapshot.campaign?.observedIds?.slice(-1)[0] || supervisor.lastCampaignId || "");
    const allocationIds = [...new Set([
      ...(supervisor.allocationIds || []),
      ...(snapshot.authorization?.allocations || []).map((row) => row.allocationId),
      ...(currentTask.program?.workPackages || []).map((row) => row.allocation?.allocationId),
    ].filter(Boolean))].slice(-1000);
    result = {
      ...supervisor,
      campaignCount,
      lastCampaignId,
      allocationIds,
      resourceSnapshot: {
        ...compactProgramResourceSnapshot(snapshot),
        recoverableCapacity: safety.recoverableCapacity === true,
        consumptionBlocked: safety.consumptionBlocked === true,
        consumptionExhausted: safety.consumptionExhausted === true,
        transientCapacityExhausted: safety.transientCapacityExhausted === true,
        exhaustedBlockers: (safety.exhaustedBlockers || []).slice(0, 20),
      },
      quotaGuardKey: snapshot.safe ? "" : supervisor.quotaGuardKey || "",
      updatedAt: utcNow(),
    };
    currentTask.program = {
      ...currentTask.program,
      runtime: { ...(currentTask.program?.runtime || {}), programSupervisor: result },
      updatedAt: utcNow(),
    };
    return currentTask;
  });
  return result;
}

const RECOVERY_ADMISSION_POLICY_VERSION = 1;
const RECOVERY_ADMISSION_STOP_REASONS = new Set(["no-acceptance-progress", "no-progress-limit", "resource-cap-exceeded"]);
const RECOVERY_MUTATING_PERMISSIONS = new Set([
  "write-files", "write-project", "command", "run-command", "service-control", "browser", "external-write", "database-write", "git-write",
]);

function programRecoveryAdmission(task = {}, supervisor = {}, exposure = null, recoveryInvocationId = "") {
  if (supervisor.state !== "stopped" || !RECOVERY_ADMISSION_STOP_REASONS.has(String(supervisor.stopReason || ""))) return null;
  if (!exposure || Number(exposure.concurrency?.programActive || 0) > 0) return null;
  if ((exposure.jobs || []).some((row) => !TERMINAL_STATES.has(String(row.state || "")))) return null;
  const invocationId = String(recoveryInvocationId || "").trim();
  if (invocationId && (supervisor.recoveryAdmissionHistory || []).some((row) => row.recoveryInvocationId === invocationId)) return null;
  const candidates = (task.program?.workPackages || []).filter((row) => (
    row.executorKind === "reconciliation"
    && ["pending", "ready"].includes(String(row.state || ""))
    && !String(row.jobId || "")
    && row.readOnly === true
  ));
  if (candidates.length !== 1) return null;
  const workPackage = candidates[0];
  const permissions = [...new Set([
    ...(workPackage.requiredPermissions || []),
    ...(workPackage.permissionGrant || []),
  ].map((value) => String(value || "").trim()).filter(Boolean))].sort();
  if (permissions.some((permission) => RECOVERY_MUTATING_PERMISSIONS.has(permission))) return null;
  const failureFingerprint = String(workPackage.failurePacket?.failureFingerprint || workPackage.materialDeltaRequired?.failureFingerprint || "").trim();
  if (!failureFingerprint) return null;
  const failedWorkPackage = (task.program?.workPackages || []).find((row) => row.workPackageId === workPackage.failedWorkPackageId);
  if (!failedWorkPackage || !["failed", "cancelled", "superseded", "rejected"].includes(String(failedWorkPackage.state || ""))) return null;
  const identity = {
    schemaVersion: RECOVERY_ADMISSION_POLICY_VERSION,
    taskId: String(task.taskId || ""),
    programId: String(task.program?.programId || ""),
    missionId: String(task.program?.mission?.missionId || ""),
    workPackageId: String(workPackage.workPackageId || ""),
    failedWorkPackageId: String(workPackage.failedWorkPackageId || ""),
    failureFingerprint,
    permissions,
  };
  const admissionKey = crypto.createHash("sha256").update(JSON.stringify(identity)).digest("hex");
  if ((supervisor.recoveryAdmissionHistory || []).some((row) => row.admissionKey === admissionKey)) return null;
  const estimatedTokens = positiveLimit(workPackage.resourceEstimate?.tokens || workPackage.estimatedDirectTokens) || 100000;
  const estimatedDurationMs = positiveLimit(Number(workPackage.resourceEstimate?.wallTimeSeconds || workPackage.timeoutSeconds || 900) * 1000) || 900000;
  return {
    schemaVersion: RECOVERY_ADMISSION_POLICY_VERSION,
    admissionKey,
    recoveryInvocationId: invocationId,
    ...identity,
    priorSupervisorId: String(supervisor.supervisorId || ""),
    grant: {
      maxTokens: Math.min(150000, estimatedTokens),
      maxDurationMs: Math.min(1200000, estimatedDurationMs),
      maxAttempts: 1,
      maxWorkers: 1,
      permissions,
      externalWritesAllowed: false,
    },
  };
}

function recoveryAdmissionLimits(currentLimits = {}, exposure = {}, admission = null, hardCeilings = {}) {
  if (!admission) return { allowed: false, limits: currentLimits };
  const capacity = exposure.authorization?.capacityTotals || exposure.authorization?.totals || {};
  const committed = exposure.totals || {};
  const baseline = (metric) => Math.max(
    Number(capacity?.[metric] || 0),
    Number(committed?.[metric]?.committed || 0),
  );
  const required = {
    maxTokens: baseline("tokens") + Number(admission.grant.maxTokens || 0),
    maxDurationMs: baseline("durationMs") + Number(admission.grant.maxDurationMs || 0),
    maxAttempts: baseline("attempts") + Number(admission.grant.maxAttempts || 0),
  };
  for (const [key, value] of Object.entries(required)) {
    const ceiling = positiveLimit(hardCeilings[key]);
    if (ceiling && value > ceiling) return { allowed: false, limits: currentLimits, blocker: `${key}-hard-ceiling` };
  }
  return {
    allowed: true,
    limits: {
      ...currentLimits,
      maxTokens: Math.max(positiveLimit(currentLimits.maxTokens), required.maxTokens),
      maxDurationMs: Math.max(positiveLimit(currentLimits.maxDurationMs), required.maxDurationMs),
      maxAttempts: Math.max(positiveLimit(currentLimits.maxAttempts), required.maxAttempts),
      maxWorkers: Math.min(Math.max(1, positiveLimit(currentLimits.maxWorkers)), admission.grant.maxWorkers),
    },
    required,
  };
}

function admitInSupervisorRecovery(taskId, payload = {}, stoppedSupervisor = null) {
  if (stoppedSupervisor?.state !== "stopped") return null;
  const task = readTask(taskId);
  let exposure = null;
  try {
    exposure = buildProgramResourceSnapshot({ taskId, task, campaignCount: stoppedSupervisor.campaignCount });
  } catch {
    return null;
  }
  const recoveryInvocationId = payload.campaignSupervisorExecutionId || payload.executionId;
  if (!programRecoveryAdmission(task, stoppedSupervisor, exposure, recoveryInvocationId)) return null;
  const renewed = ensureProgramSupervisor(taskId, payload);
  if (!["active", "waiting"].includes(String(renewed?.state || ""))) return null;
  if (!renewed.activeRecoveryAdmission?.admissionKey) return null;
  if (String(renewed.supervisorId || "") === String(stoppedSupervisor.supervisorId || "")) return null;
  if (Number(renewed.supervisorEpoch || 0) <= Number(stoppedSupervisor.supervisorEpoch || 0)) return null;
  return renewed;
}

function programRecoveryFence(task = {}) {
  const program = task.program || {};
  const mission = program.mission || program.contracts?.mission || {};
  const context = program.contextDossier || program.contracts?.contextDossier || {};
  const plan = program.masterPlan || program.contracts?.masterPlan || {};
  const budget = program.resourceBudget || program.contracts?.resourceBudget || program.runtime?.budget || {};
  const value = {
    runtimeBuildFingerprint: runtimeFingerprint(),
    contractVersion: Number(task.contractVersion || 0),
    missionId: String(mission.missionId || ""),
    missionRevision: Number(mission.revision || mission.missionRevision || 0),
    missionFingerprint: String(mission.fingerprint || ""),
    latestUserRequestFingerprint: crypto.createHash("sha256").update(String(task.latestUserRequest || mission.latestUserRequest || "")).digest("hex"),
    contextRevision: Number(context.contextRevision || context.revision || 0),
    contextFingerprint: String(context.contextFingerprint || context.fingerprint || ""),
    planId: String(plan.planId || ""),
    planRevision: Number(plan.planRevision || plan.revision || 0),
    planFingerprint: String(plan.fingerprint || ""),
    budgetId: String(budget.budgetId || ""),
    budgetRevision: Number(budget.budgetRevision || budget.revision || 0),
    budgetFingerprint: String(budget.fingerprint || ""),
    acceptanceFingerprint: campaignAcceptedEvidenceFingerprint(task),
    recoveryAdmissionRevision: Number(program.runtime?.recoveryAdmissionRevision || 0),
  };
  return {
    ...value,
    fingerprint: crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex"),
  };
}

function programRecoveryFenceAdvanced(prior = null, current = null) {
  if (!prior?.fingerprint || !current?.fingerprint || prior.fingerprint === current.fingerprint) return false;
  if (current.missionId && prior.missionId && current.missionId !== prior.missionId) return false;
  return Number(current.missionRevision || 0) > Number(prior.missionRevision || 0)
    || String(current.runtimeBuildFingerprint || "") !== String(prior.runtimeBuildFingerprint || "")
    || Number(current.contextRevision || 0) > Number(prior.contextRevision || 0)
    || Number(current.planRevision || 0) > Number(prior.planRevision || 0)
    || Number(current.budgetRevision || 0) > Number(prior.budgetRevision || 0)
    || (String(current.budgetId || "") !== String(prior.budgetId || "") && Number(current.budgetRevision || 0) > 0)
    || (Number(current.contractVersion || 0) > Number(prior.contractVersion || 0)
      && (current.latestUserRequestFingerprint !== prior.latestUserRequestFingerprint || current.missionFingerprint !== prior.missionFingerprint))
    || Number(current.recoveryAdmissionRevision || 0) > Number(prior.recoveryAdmissionRevision || 0)
    || current.acceptanceFingerprint !== prior.acceptanceFingerprint;
}

function persistIncomingProgramHardCeilings(taskId, payload = {}) {
  const incoming = explicitProgramLimitCeilings(payload);
  if (!Object.keys(incoming).length) return readProgramSupervisor(readTask(taskId));
  let result = null;
  updateTask(taskId, (task) => {
    const supervisor = readProgramSupervisor(task);
    if (!supervisor) return task;
    const hardCeilings = mergeProgramHardCeilings(supervisor.hardCeilings || {}, incoming);
    const limits = clampProgramLimits(supervisor.limits || {}, hardCeilings);
    if (JSON.stringify(hardCeilings) === JSON.stringify(supervisor.hardCeilings || {})
      && JSON.stringify(limits) === JSON.stringify(supervisor.limits || {})) {
      result = supervisor;
      return task;
    }
    result = {
      ...supervisor,
      hardCeilings,
      limits,
      hardCeilingRevision: Number(supervisor.hardCeilingRevision || 0) + 1,
      hardCeilingUpdatedAt: utcNow(),
      updatedAt: utcNow(),
    };
    task.program = {
      ...task.program,
      runtime: { ...(task.program?.runtime || {}), programSupervisor: result },
      updatedAt: utcNow(),
    };
    return task;
  });
  return result;
}

function ensureProgramSupervisor(taskId, payload = {}) {
  let result = null;
  updateTask(taskId, (task) => {
    const current = readProgramSupervisor(task);
    let exposure = null;
    try {
      exposure = buildProgramResourceSnapshot({ taskId, task, campaignCount: current?.campaignCount });
    } catch {
      exposure = null;
    }
    if (current) {
      const hardCeilings = mergeProgramHardCeilings(current.hardCeilings || {}, explicitProgramLimitCeilings(payload));
      const baseLimits = clampProgramLimits(
        programSupervisorLimits(task, payload, current.horizonHours, current.limits || {}, exposure),
        hardCeilings,
      );
      const recoveryInvocationId = payload.campaignSupervisorExecutionId || payload.executionId;
      const candidateAdmission = programRecoveryAdmission(task, current, exposure, recoveryInvocationId);
      const admissionEnvelope = recoveryAdmissionLimits(baseLimits, exposure || {}, candidateAdmission, hardCeilings);
      const recoveryAdmission = admissionEnvelope.allowed ? candidateAdmission : null;
      const limits = recoveryAdmission ? clampProgramLimits(admissionEnvelope.limits, hardCeilings) : baseLimits;
      const activeCampaignId = String(task.program?.activeCampaign?.campaignId || current.lastCampaignId || "");
      const recoveryFence = programRecoveryFence(task);
      const recoveryAdmissionRevision = Number(task.program?.runtime?.recoveryAdmissionRevision || 0) + (recoveryAdmission ? 1 : 0);
      const admittedRecoveryFence = recoveryAdmission
        ? (() => {
          const value = { ...recoveryFence, recoveryAdmissionRevision, recoveryAdmissionKey: recoveryAdmission.admissionKey };
          delete value.fingerprint;
          return { ...value, fingerprint: crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex") };
        })()
        : recoveryFence;
      const renewable = current.state === "stopped" && (
        programRecoveryFenceAdvanced(current.recoveryFence, recoveryFence)
        || Boolean(recoveryAdmission)
      );
      const renewedAt = renewable ? utcNow() : null;
      const preserveRecoveryHorizon = Boolean(recoveryAdmission);
      const supervisorEpoch = Math.max(1, Number(current.supervisorEpoch || 1)) + (renewable ? 1 : 0);
      result = {
        ...current,
        schemaVersion: Math.max(2, Number(current.schemaVersion || 1)),
        supervisorEpoch,
        limits,
        limitRevision: Number(current.limitRevision || 1),
        limitSource: current.limitSource || bootstrapProgramLimitSource(current.limits || limits),
        hardCeilings,
        limitHistory: current.limitHistory || [],
        campaignCount: observedProgramCampaignCount(task, current),
        lastCampaignId: activeCampaignId,
        allocationIds: [...new Set([
          ...(current.allocationIds || []),
          ...(exposure?.authorization?.allocations || []).map((row) => row.allocationId),
          ...(task.program?.workPackages || []).map((row) => row.allocation?.allocationId),
        ].filter(Boolean))].slice(-1000),
        recoveryFence: current.recoveryFence || recoveryFence,
        recoveryAdmissionHistory: current.recoveryAdmissionHistory || [],
        ...(renewable ? {
          supervisorId: `program-supervisor-${crypto.createHash("sha256").update(`${taskId}:${renewedAt}:${supervisorEpoch}:${current.supervisorId}`).digest("hex").slice(0, 20)}`,
          priorSupervisorId: current.supervisorId,
          state: "active",
          startedAt: preserveRecoveryHorizon ? current.startedAt : renewedAt,
          deadlineAt: preserveRecoveryHorizon
            ? current.deadlineAt
            : new Date(Date.parse(renewedAt) + Number(current.horizonHours || 5) * 60 * 60 * 1000).toISOString(),
          noProgressCount: 0,
          lifetimeWakeCount: Number(current.lifetimeWakeCount || 0) + Number(current.wakeCount || 0),
          wakeCount: 0,
          wakeCursor: "",
          lastAcceptanceFingerprint: campaignAcceptedEvidenceFingerprint(task),
          nextWakeAt: null,
          recovery: null,
          recoveryFence: admittedRecoveryFence,
          activeRecoveryAdmission: recoveryAdmission || null,
          recoveryAdmissionHistory: recoveryAdmission
            ? [...(current.recoveryAdmissionHistory || []), { ...recoveryAdmission, admittedAt: renewedAt, supervisorEpoch }].slice(-50)
            : (current.recoveryAdmissionHistory || []),
          stopReason: "",
          finishedAt: null,
          renewalHistory: [...(current.renewalHistory || []), {
            priorSupervisorId: current.supervisorId,
            priorSupervisorEpoch: Number(current.supervisorEpoch || 1),
            priorStopReason: current.stopReason || "",
            priorRecoveryFence: current.recoveryFence || null,
            recoveryFence: admittedRecoveryFence,
            recoveryAdmissionKey: recoveryAdmission?.admissionKey || "",
            renewedAt,
          }].slice(-50),
        } : {}),
        updatedAt: utcNow(),
      };
      task.program = {
        ...task.program,
        runtime: { ...(task.program?.runtime || {}), recoveryAdmissionRevision, programSupervisor: result },
        updatedAt: utcNow(),
      };
      return task;
    }
    const requestedStart = payload.campaignStartedAt || payload.createdAt || utcNow();
    const parsedStart = Date.parse(requestedStart);
    const startedAt = Number.isFinite(parsedStart) ? new Date(parsedStart).toISOString() : utcNow();
    const horizonHours = boundedInteger(payload.config?.horizonHours || payload.horizonHours, 5, 1, 168);
    const initialBudgetEnvelope = programBudgetLimitEnvelope(task);
    const hardCeilings = explicitProgramLimitCeilings(payload);
    const initialLimitEnvelope = programBudgetCumulativeLimits(
      task,
      payload,
      programSupervisorLimits(task, payload, horizonHours, {}, exposure),
      exposure,
      hardCeilings,
    );
    const limits = clampProgramLimits(initialLimitEnvelope.limits, hardCeilings);
    const activeCampaignId = String(task.program?.activeCampaign?.campaignId || "");
    result = {
      schemaVersion: 2,
      supervisorId: `program-supervisor-${crypto.createHash("sha256").update(`${taskId}:${startedAt}`).digest("hex").slice(0, 20)}`,
      supervisorEpoch: 1,
      missionId: task.program?.mission?.missionId || "",
      state: "active",
      startedAt,
      deadlineAt: new Date(Date.parse(startedAt) + horizonHours * 60 * 60 * 1000).toISOString(),
      horizonHours,
      limits,
      limitRevision: 1,
      limitSource: initialBudgetEnvelope?.source || bootstrapProgramLimitSource(limits),
      hardCeilings,
      limitBaseline: initialLimitEnvelope.baseline,
      limitHistory: [],
      cadence: {
        backoffMs: Math.max(1000, Number(payload.config?.capacityBackoffSeconds || 5) * 1000),
        maxBackoffMs: Math.max(1000, Number(payload.config?.capacityMaxBackoffSeconds || 60) * 1000),
      },
      noProgressCount: 0,
      wakeCount: 0,
      wakeCursor: "",
      wakeHistory: [],
      lastAcceptanceFingerprint: campaignAcceptedEvidenceFingerprint(task),
      foundationTransitions: [],
      campaignIds: activeCampaignId ? [activeCampaignId] : [],
      campaignCount: observedProgramCampaignCount(task),
      lastCampaignId: activeCampaignId,
      allocationIds: [...new Set([
        ...(exposure?.authorization?.allocations || []).map((row) => row.allocationId),
        ...(task.program?.workPackages || []).map((row) => row.allocation?.allocationId),
      ].filter(Boolean))].slice(-1000),
      resourceSnapshot: null,
      nextWakeAt: null,
      recovery: null,
      recoveryFence: programRecoveryFence(task),
      stopReason: "",
      finishedAt: null,
      updatedAt: utcNow(),
    };
    task.program = {
      ...task.program,
      runtime: { ...(task.program?.runtime || {}), programSupervisor: result },
      updatedAt: utcNow(),
    };
    return task;
  });
  return result;
}

function programSupervisorExpired(supervisor, now = Date.now()) {
  const deadline = Date.parse(supervisor?.deadlineAt || "");
  return Number.isFinite(deadline) && now >= deadline;
}

function persistProgramSupervisorWait(taskId, nextWakeAt, recovery = null) {
  let result = null;
  updateTask(taskId, (task) => {
    const supervisor = readProgramSupervisor(task);
    if (!supervisor || !["active", "waiting"].includes(supervisor.state)) {
      result = supervisor;
      return task;
    }
    result = {
      ...supervisor,
      state: "waiting",
      nextWakeAt,
      recovery: recovery || supervisor.recovery || null,
      updatedAt: utcNow(),
    };
    task.program = {
      ...task.program,
      runtime: { ...(task.program.runtime || {}), programSupervisor: result },
      updatedAt: utcNow(),
    };
    return task;
  });
  return result;
}

function persistProgramSupervisorWake(taskId, input = {}) {
  let result = { supervisor: null, campaign: null, changed: false, reason: "supervisor-missing", acceptedProgress: false, foundationalNeutral: false, capacityChanged: false };
  updateTask(taskId, (task) => {
    const supervisor = readProgramSupervisor(task);
    if (!supervisor || !["active", "waiting"].includes(supervisor.state)) {
      result.supervisor = supervisor;
      result.reason = "supervisor-not-wakeable";
      return task;
    }
    if ((input.expectedSupervisorId && String(supervisor.supervisorId || "") !== String(input.expectedSupervisorId))
      || (input.expectedSupervisorEpoch && Number(supervisor.supervisorEpoch || 1) !== Number(input.expectedSupervisorEpoch))) {
      result.supervisor = supervisor;
      result.reason = "stale-supervisor-epoch";
      return task;
    }
    const reason = String(input.reason || "").toLowerCase();
    if (!PROGRAM_WAKE_REASONS.has(reason)) {
      result.supervisor = supervisor;
      result.reason = "unknown-wake-reason";
      return task;
    }
    const stateFingerprint = bounded(input.stateFingerprint, 240);
    const cursor = crypto.createHash("sha256").update(JSON.stringify({
      supervisorId: supervisor.supervisorId,
      reason,
      stateFingerprint,
      at: input.scheduledKey || "",
    })).digest("hex");
    if (cursor === supervisor.wakeCursor) {
      result.supervisor = supervisor;
      result.reason = "duplicate-wake";
      return task;
    }
    const evidence = input.evidenceFingerprint || supervisor.lastAcceptanceFingerprint;
    const acceptedProgress = input.acceptanceImproved === true && evidence !== supervisor.lastAcceptanceFingerprint;
    const consumed = new Set(supervisor.foundationTransitions || []);
    const foundationTransitionKeys = [...new Set((input.foundationTransitionKeys || []).filter((key) => key && !consumed.has(key)))];
    const foundationalNeutral = input.foundationalNeutral === true && foundationTransitionKeys.length > 0;
    const capacityChanged = input.capacityChanged === true;
    const countForNoProgress = !(acceptedProgress || foundationalNeutral || capacityChanged);
    const noProgressCount = acceptedProgress
      ? 0
      : Number(supervisor.noProgressCount || 0) + (countForNoProgress ? 1 : 0);
    const wakeCount = Number(supervisor.wakeCount || 0) + 1;
    let state = reason === "cancel" ? "cancelled" : "active";
    let stopReason = reason === "cancel" ? "cancelled" : "";
    let finishedAt = reason === "cancel" ? (input.at || utcNow()) : null;
    if (reason !== "cancel" && input.drainOnly !== true && wakeCount >= Number(supervisor.limits?.maxEvents || 1000)) {
      state = "stopped";
      stopReason = "program-event-cap-exceeded";
      finishedAt = input.at || utcNow();
    } else if (reason !== "cancel" && input.drainOnly !== true && noProgressCount >= Number(supervisor.limits?.noProgressLimit || 2)) {
      state = "stopped";
      stopReason = "no-acceptance-progress";
      finishedAt = input.at || utcNow();
    }
    const activeCampaignId = task.program?.activeCampaign?.campaignId || "";
    const campaignIds = activeCampaignId
      ? [...new Set([...(supervisor.campaignIds || []), activeCampaignId])].slice(-100)
      : supervisor.campaignIds || [];
    const next = {
      ...supervisor,
      state,
      wakeCursor: cursor,
      wakeCount,
      wakeHistory: [...(supervisor.wakeHistory || []), {
        reason,
        stateFingerprint,
        acceptanceImproved: acceptedProgress,
        foundationalNeutral,
        capacityChanged,
        at: input.at || utcNow(),
      }].slice(-50),
      lastAcceptanceFingerprint: evidence,
      foundationTransitions: [...consumed, ...foundationTransitionKeys].slice(-20),
      campaignIds,
      campaignCount: observedProgramCampaignCount(task, supervisor),
      lastCampaignId: activeCampaignId || supervisor.lastCampaignId || "",
      allocationIds: [...new Set([
        ...(supervisor.allocationIds || []),
        ...(task.program?.workPackages || []).map((row) => row.allocation?.allocationId),
      ].filter(Boolean))].slice(-1000),
      noProgressCount,
      quotaGuardKey: capacityChanged ? "" : supervisor.quotaGuardKey || "",
      nextWakeAt: null,
      stopReason,
      finishedAt,
      updatedAt: utcNow(),
    };
    let program = {
      ...task.program,
      runtime: { ...(task.program.runtime || {}), programSupervisor: next },
      updatedAt: utcNow(),
    };
    const campaign = task.program?.activeCampaign || null;
    if (campaign && ["active", "waiting"].includes(campaign.state)) {
      const campaignWake = recordCampaignWake(campaign, {
        reason,
        stateFingerprint,
        evidenceFingerprint: evidence,
        acceptanceImproved: acceptedProgress,
        countForNoProgress: false,
        scheduledKey: input.scheduledKey,
        at: input.at,
      });
      if (campaignWake.changed) {
        const updatedCampaign = foundationTransitionKeys.length
          ? {
              ...campaignWake.campaign,
              supervisorContinuation: {
                ...(campaignWake.campaign.supervisorContinuation || {}),
                foundationTransitions: [...new Set([
                  ...(campaignWake.campaign.supervisorContinuation?.foundationTransitions || []),
                  ...foundationTransitionKeys,
                ])].slice(-12),
              },
            }
          : campaignWake.campaign;
        program = replaceActiveCampaign(program, updatedCampaign);
        result.campaign = updatedCampaign;
      }
    }
    task.program = program;
    result = {
      supervisor: next,
      campaign: result.campaign,
      changed: true,
      reason,
      acceptedProgress,
      foundationalNeutral,
      capacityChanged,
    };
    return task;
  });
  return result;
}

function persistProgramSupervisorStop(taskId, stopReason, recovery, options = {}) {
  let result = null;
  updateTask(taskId, (task) => {
    const supervisor = readProgramSupervisor(task);
    if (!supervisor) return task;
    if (options.expectedSupervisorId && String(supervisor.supervisorId || "") !== String(options.expectedSupervisorId)) {
      result = supervisor;
      return task;
    }
    if (options.expectedSupervisorEpoch && Number(supervisor.supervisorEpoch || 1) !== Number(options.expectedSupervisorEpoch)) {
      result = supervisor;
      return task;
    }
    if (["completed", "cancelled"].includes(supervisor.state)) {
      result = supervisor;
      return task;
    }
    const state = options.cancelled === true ? "cancelled" : options.completed === true ? "completed" : "stopped";
    const effectiveStopReason = options.cancelled === true
      ? "cancelled"
      : supervisor.state === "stopped" && supervisor.stopReason
        ? supervisor.stopReason
        : stopReason;
    result = {
      ...supervisor,
      state,
      finishedAt: options.finishedAt || utcNow(),
      stopReason: effectiveStopReason,
      nextWakeAt: null,
      recovery: recovery || null,
      recoveryFence: programRecoveryFence(task),
      updatedAt: utcNow(),
    };
    let program = {
      ...task.program,
      runtime: { ...(task.program.runtime || {}), programSupervisor: result },
      updatedAt: utcNow(),
    };
    const campaign = task.program?.activeCampaign || null;
    if (campaign && ["active", "waiting"].includes(campaign.state)) {
      program = replaceActiveCampaign(program, finishCampaign(campaign, {
        completed: options.completed === true,
        cancelled: options.cancelled === true,
        stopReason: effectiveStopReason,
      }));
    }
    task.program = program;
    return task;
  });
  return result;
}

function rolloverExpiredCampaignEpoch(taskId) {
  let result = { rolled: false, blockedByRunningWork: false, campaignId: "" };
  updateTask(taskId, (task) => {
    const campaign = task.program?.activeCampaign || null;
    if (!campaign || !["active", "waiting"].includes(campaign.state) || !campaignExpired(campaign)) return task;
    const allocationIds = new Set(campaign.allocationIds || []);
    const owned = (task.program.workPackages || []).filter((row) => allocationIds.has(row.allocation?.allocationId));
    if (owned.some((row) => row.state === "running")) {
      result = { rolled: false, blockedByRunningWork: true, campaignId: campaign.campaignId };
      return task;
    }
    const finished = finishCampaign(campaign, { stopReason: "campaign-epoch-horizon" });
    const supervisor = readProgramSupervisor(task);
    const nextSupervisor = supervisor
      ? {
          ...supervisor,
          campaignIds: [...new Set([...(supervisor.campaignIds || []), campaign.campaignId])].slice(-100),
          campaignCount: Math.max(observedProgramCampaignCount(task, supervisor), Number(campaign.epoch || 0)),
          lastCampaignId: campaign.campaignId || supervisor.lastCampaignId || "",
          allocationIds: [...new Set([...(supervisor.allocationIds || []), ...(campaign.allocationIds || [])])].slice(-1000),
          updatedAt: utcNow(),
        }
      : supervisor;
    task.program = {
      ...replaceActiveCampaign(task.program, finished),
      activeCampaign: null,
      workPackages: (task.program.workPackages || []).map((row) => allocationIds.has(row.allocation?.allocationId) && row.state !== "completed"
        ? {
            ...row,
            state: "pending",
            allocation: null,
            permissionPreflight: null,
            revisionFence: null,
            canonicalContract: null,
          }
        : row),
      runtime: {
        ...(task.program.runtime || {}),
        budget: null,
        programSupervisor: nextSupervisor,
      },
      nextAction: "The prior budget campaign reached its epoch horizon; refresh resources and fund the remaining dependency-ready work in a new campaign epoch.",
      updatedAt: utcNow(),
    };
    task.workGraph = (task.workGraph || []).map((node) => owned.some((row) => row.workPackageId === node.id) && node.state !== "completed"
      ? { ...node, state: "pending", owner: null }
      : node);
    result = { rolled: true, blockedByRunningWork: false, campaignId: campaign.campaignId };
    return task;
  });
  return result;
}
function programSupervisorResourceSafety(task = {}, supervisor = {}) {
  const taskId = String(task.taskId || "").trim();
  if (!taskId) return { safe: false, reason: "program-resource-task-id-missing", snapshot: null };
  let snapshot;
  try {
    snapshot = buildProgramResourceSnapshot({
      taskId,
      task,
      campaignCount: supervisor.campaignCount,
      limits: supervisor.limits || {},
    });
  } catch (error) {
    return {
      safe: false,
      reason: "program-resource-accounting-failed",
      blocker: bounded(error.message || error, 800),
      snapshot: null,
    };
  }
  if (Number(supervisor.wakeCount || 0) >= Number(supervisor.limits?.maxEvents || 1000)) {
    const blocker = {
      code: "program-event-cap-exhausted",
      metric: "events",
      committed: Number(supervisor.wakeCount || 0),
      limit: Number(supervisor.limits?.maxEvents || 1000),
      reason: "The supervisor event cap is exhausted; only deterministic drain/integration of already-owned work is allowed.",
    };
    return {
      safe: false,
      consumptionBlocked: true,
      consumptionExhausted: true,
      eventCapExhausted: true,
      exhaustedBlockers: [blocker],
      reason: blocker.code,
      blocker,
      snapshot,
    };
  }
  const exhaustedBlockers = snapshot.capCheck?.exhausted || [];
  const transientExhaustedBlockers = exhaustedBlockers.filter((row) => ["activeWorkers", "globalActiveWorkers"].includes(row.metric));
  const consumptiveExhaustedBlockers = exhaustedBlockers.filter((row) => !["activeWorkers", "globalActiveWorkers"].includes(row.metric));
  if (!snapshot.safe) {
    const capBlockers = snapshot.capCheck?.blockers || [];
    const accountingBlockers = snapshot.blockers || [];
    const recoverableCapacity = capBlockers.length === 0
      && accountingBlockers.length > 0
      && accountingBlockers.every((row) => row.code === "quota-capacity-unknown");
    const consumptionBlocked = capBlockers.length > 0 && accountingBlockers.every((row) => row.code === "quota-capacity-unknown");
    const blocker = capBlockers[0] || accountingBlockers[0] || null;
    return {
      safe: false,
      recoverableCapacity,
      consumptionBlocked,
      transientCapacityExhausted: transientExhaustedBlockers.length > 0,
      consumptionExhausted: consumptiveExhaustedBlockers.length > 0 || consumptionBlocked,
      exhaustedBlockers: consumptionBlocked ? [...capBlockers, ...consumptiveExhaustedBlockers] : consumptiveExhaustedBlockers,
      reason: blocker?.code || exhaustedBlockers[0]?.code || "program-resource-accounting-unsafe",
      blocker,
      snapshot,
    };
  }
  if (consumptiveExhaustedBlockers.length) {
    return {
      safe: true,
      consumptionExhausted: true,
      transientCapacityExhausted: transientExhaustedBlockers.length > 0,
      exhaustedBlockers: consumptiveExhaustedBlockers,
      reason: consumptiveExhaustedBlockers[0].code,
      blocker: consumptiveExhaustedBlockers[0],
      snapshot,
    };
  }
  if (transientExhaustedBlockers.length) {
    return {
      safe: true,
      consumptionExhausted: false,
      transientCapacityExhausted: true,
      exhaustedBlockers: [],
      reason: transientExhaustedBlockers[0].code,
      blocker: transientExhaustedBlockers[0],
      snapshot,
    };
  }
  return { safe: true, consumptionExhausted: false, exhaustedBlockers: [], reason: "program-resource-caps-safe", snapshot };
}
function programHasDrainableWork(task = {}, summary = {}, safety = {}) {
  if ((safety.snapshot?.jobs || []).some((row) => !TERMINAL_STATES.has(String(row.state || "")))) return true;
  if (["running", "ready-for-integration", "needs-correction"].includes(String(summary.latestRound?.state || ""))) return true;
  if ((summary.workPlane?.recommendedWorkUnits || []).length > 0) return true;
  return false;
}

function programBudgetAuthorityFingerprint(task = {}) {
  const program = task.program || {};
  const envelope = programBudgetLimitEnvelope(task);
  const durableBudget = program.resourceBudget && typeof program.resourceBudget === "object"
    ? budgetSourceRecord(program.resourceBudget)
    : null;
  const runtimeBudget = program.runtime?.budget && typeof program.runtime.budget === "object"
    ? budgetSourceRecord(program.runtime.budget)
    : null;
  const contractBudget = program.contracts?.resourceBudget && typeof program.contracts.resourceBudget === "object"
    ? budgetSourceRecord(program.contracts.resourceBudget)
    : null;
  return crypto.createHash("sha256").update(JSON.stringify({
    source: envelope?.source || null,
    durableBudget,
    runtimeBudget,
    contractBudget,
    activeCampaign: program.activeCampaign ? {
      campaignId: program.activeCampaign.campaignId || "",
      epoch: Number(program.activeCampaign.epoch || 0),
      revisions: program.activeCampaign.revisions || {},
      allocationIds: [...(program.activeCampaign.allocationIds || [])].sort(),
    } : null,
    allocatedReadyPackages: (program.workPackages || [])
      .filter((row) => row.state === "ready" && row.allocation)
      .map((row) => [row.workPackageId || "", row.allocation.allocationId || "", Number(row.budgetRevision || 0)])
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
  })).digest("hex");
}

function programConsumptionEnvelope(task = {}, supervisor = {}, safety = {}) {
  if (!safety.consumptionExhausted) return null;
  const snapshot = safety.snapshot || {};
  const limits = supervisor.limits || {};
  const exhausted = safety.exhaustedBlockers || [];
  const artifactAuthorityExhausted = exhausted.some((row) => ["artifacts", "durableBytes"].includes(row.metric));
  const campaignAuthorityExhausted = exhausted.some((row) => row.metric === "campaigns");
  const hardCeilingByMetric = {
    tokens: "maxTokens",
    durationMs: "maxDurationMs",
    attempts: "maxAttempts",
    artifacts: "maxArtifacts",
    durableBytes: "maxArtifactBytes",
    campaigns: "maxCampaigns",
    events: "maxEvents",
  };
  const hardCeilingExhausted = exhausted.some((row) => {
    const key = hardCeilingByMetric[row.metric];
    const ceiling = positiveLimit(supervisor.hardCeilings?.[key]);
    return ceiling > 0 && Number(row.committed || 0) >= ceiling;
  });
  const observed = new Set((snapshot.authorization?.allocations || []).map((row) => String(row.allocationId || "")).filter(Boolean));
  const activeCampaignAllocations = new Set((task.program?.activeCampaign?.allocationIds || []).map(String));
  const totals = {
    tokens: Number(snapshot.authorization?.capacityTotals?.tokens ?? snapshot.authorization?.totals?.tokens ?? 0),
    durationMs: Number(snapshot.authorization?.capacityTotals?.durationMs ?? snapshot.authorization?.totals?.durationMs ?? 0),
    attempts: Number(snapshot.authorization?.capacityTotals?.attempts ?? snapshot.authorization?.totals?.attempts ?? 0),
  };
  const allowedAllocationIds = [];
  if (safety.consumptionBlocked !== true && !artifactAuthorityExhausted) {
    const rows = (task.program?.workPackages || [])
      .filter((row) => row.allocation?.allocationId)
      .slice()
      .sort((left, right) => String(left.allocation.allocationId).localeCompare(String(right.allocation.allocationId)));
    for (const row of rows) {
      const allocation = row.allocation;
      const allocationId = String(allocation.allocationId || "");
      if (observed.has(allocationId)) {
        allowedAllocationIds.push(allocationId);
        continue;
      }
      if (!activeCampaignAllocations.has(allocationId)) continue;
      const projected = {
        tokens: totals.tokens + Number(allocation.tokenLimit || 0) * Number(allocation.maxAttempts || 0),
        durationMs: totals.durationMs + Number(allocation.durationLimitMs || 0) * Number(allocation.maxAttempts || 0),
        attempts: totals.attempts + Number(allocation.maxAttempts || 0),
      };
      const within = [["maxTokens", "tokens"], ["maxDurationMs", "durationMs"], ["maxAttempts", "attempts"]]
        .every(([limitKey, metric]) => !positiveLimit(limits[limitKey]) || projected[metric] <= positiveLimit(limits[limitKey]));
      if (!within) continue;
      allowedAllocationIds.push(allocationId);
      Object.assign(totals, projected);
    }
  }
  return {
    allowNewConsumption: false,
    allowBudgetRefresh: safety.safe === true && !artifactAuthorityExhausted && !campaignAuthorityExhausted && !hardCeilingExhausted && safety.eventCapExhausted !== true,
    allowCreateCampaign: !campaignAuthorityExhausted,
    allowedAllocationIds: [...new Set(allowedAllocationIds)],
    supervisorId: String(supervisor.supervisorId || ""),
    resourceFingerprint: String(snapshot.fingerprint || ""),
    limits,
    exhausted,
    blocker: exhausted[0]?.code || safety.reason || "program-resource-cap-exhausted",
  };
}
function programQuotaGuardKey(task = {}, supervisor = {}, safety = {}) {
  const blockers = (safety.snapshot?.blockers || [])
    .filter((row) => row.code === "quota-capacity-unknown")
    .map((row) => [row.provider || "", row.poolKey || ""])
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  const providers = new Set(blockers.map((row) => String(row[0] || "").toLowerCase()));
  const packages = (task.program?.workPackages || [])
    .filter((row) => providers.has(String(row.allocation?.provider || row.assignee?.provider || "").toLowerCase()))
    .map((row) => [
      row.workPackageId || "",
      row.state || "",
      row.jobId || "",
      row.allocation?.allocationId || "",
      row.allocation?.provider || row.assignee?.provider || "",
      row.allocation?.quotaPool || row.allocation?.quotaPoolId || "",
    ])
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  return crypto.createHash("sha256").update(JSON.stringify({ blockers, packages })).digest("hex");
}
function persistProgramQuotaGuard(taskId, guardKey) {
  let result = null;
  updateTask(taskId, (task) => {
    const supervisor = readProgramSupervisor(task);
    if (!supervisor || !["active", "waiting"].includes(supervisor.state)) {
      result = supervisor;
      return task;
    }
    result = { ...supervisor, quotaGuardKey: guardKey, updatedAt: utcNow() };
    task.program = {
      ...task.program,
      runtime: { ...(task.program?.runtime || {}), programSupervisor: result },
      updatedAt: utcNow(),
    };
    return task;
  });
  return result;
}

function programQuotaCapacityDescriptor(task = {}, safety = {}, resources = {}, config = {}) {
  const targeted = (task.program?.workPackages || []).filter((row) => ["ready", "dispatched", "running"].includes(String(row.state || "")));
  const rejected = (safety.snapshot?.blockers || [])
    .filter((row) => row.code === "quota-capacity-unknown")
    .map((row) => ({
      workPackageId: targeted.find((item) => String(item.allocation?.provider || item.assignee?.provider || "").toLowerCase() === String(row.provider || "").toLowerCase())?.workPackageId || "",
      reason: `quota-capacity-unknown:${row.provider || "unknown"}:${row.poolKey || "unknown"}`,
    }));
  const descriptor = capacityWaitDescriptor(task, { rejected }, resources, config);
  const targetedQuota = (safety.snapshot?.blockers || [])
    .filter((row) => row.code === "quota-capacity-unknown")
    .map((row) => ({ provider: String(row.provider || "").toLowerCase(), poolKey: String(row.poolKey || "") }))
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  return {
    ...descriptor,
    targetedQuota,
    targetedQuotaInitialFingerprint: targetedQuotaFingerprint(resources, targetedQuota),
  };
}

function replaceActiveCampaign(program = {}, campaign) {
  const campaignId = String(campaign?.campaignId || "");
  return {
    ...program,
    activeCampaign: campaign,
    campaigns: (program.campaigns || []).map((row) => row.campaignId === campaignId ? campaign : row),
    updatedAt: utcNow(),
  };
}

function mutateActiveCampaign(taskId, mutator) {
  let outcome = null;
  updateTask(taskId, (task) => {
    const campaign = task.program?.activeCampaign || null;
    if (!campaign) return task;
    const next = mutator(campaign, task);
    if (!next) return task;
    outcome = next;
    task.program = replaceActiveCampaign(task.program, next);
    return task;
  });
  return outcome;
}

function persistCampaignWait(taskId, nextWakeAt, recovery = null) {
  const campaign = mutateActiveCampaign(taskId, (current) => {
    if (!["active", "waiting"].includes(current.state)) return current;
    return { ...current, state: "waiting", nextWakeAt, recovery: recovery || current.recovery || null };
  });
  const supervisor = persistProgramSupervisorWait(taskId, nextWakeAt, recovery);
  return { campaign, supervisor };
}

function persistSupervisorWake(taskId, wake = {}) {
  const supervisor = readProgramSupervisor(readTask(taskId));
  const acceptedProgress = wake.acceptanceImproved === true
    && Boolean(wake.acceptanceFingerprint)
    && wake.acceptanceFingerprint !== supervisor?.lastAcceptanceFingerprint;
  const consumed = new Set(supervisor?.foundationTransitions || []);
  const foundationTransitionKeys = [...new Set((wake.foundationTransitionKeys || []).filter((key) => key && !consumed.has(key)))];
  return persistProgramSupervisorWake(taskId, {
    reason: wake.reason,
    stateFingerprint: wake.fingerprint,
    evidenceFingerprint: wake.acceptanceFingerprint,
    scheduledKey: wake.scheduledKey,
    acceptanceImproved: acceptedProgress,
    foundationalNeutral: wake.foundationalNeutral === true && foundationTransitionKeys.length > 0,
    foundationTransitionKeys,
    capacityChanged: wake.capacityChanged === true,
    drainOnly: wake.drainOnly === true,
    expectedSupervisorId: supervisor?.supervisorId,
    expectedSupervisorEpoch: supervisor?.supervisorEpoch,
  });
}
function campaignWorkRemaining(task = {}, summary = {}) {
  if (task.state === "completed" || summary.state === "completed") return false;
  const unfinished = (task.program?.workPackages || []).some((row) => !["completed", "cancelled", "superseded"].includes(row.state));
  const recommended = (summary.workPlane?.recommendedWorkUnits || []).length > 0;
  return unfinished || recommended || summary.latestRound?.state === "running";
}

function campaignWorkerObservation(args, summary) {
  const latest = summary?.latestRound;
  if (!latest?.roundId || latest.state !== "running") return { active: false, terminal: false, fingerprint: "" };
  const round = roundRecord(args, latest.roundId);
  const rows = roundStatuses(args, round);
  return {
    active: rows.some((row) => !TERMINAL_STATES.has(row.status.state)),
    terminal: rows.length > 0 && rows.every((row) => TERMINAL_STATES.has(row.status.state)),
    fingerprint: crypto.createHash("sha256").update(JSON.stringify(rows.map((row) => [row.jobId, row.status.state, row.status.finishedAt || "", row.status.blocker || ""]))).digest("hex"),
  };
}

function campaignBackoff(campaign, config, attempt) {
  const cadence = campaign?.cadence || {};
  const base = Math.max(1000, Number(cadence.backoffMs || config.capacityBackoffSeconds * 1000 || 30000));
  const maximum = Math.max(base, Number(cadence.maxBackoffMs || config.capacityMaxBackoffSeconds * 1000 || 900000));
  return Math.min(maximum, base * (2 ** Math.max(0, attempt)));
}

function supervisorRecovery(reason, nextAction, owner = "director") {
  return {
    owner,
    trigger: reason,
    action: nextAction,
    recordedAt: utcNow(),
  };
}

async function runCoordinator(payload, entrypoint, dependencies = {}) {
  const args = targetArgs(payload);
  const programResourceEnvelope = payload.programResourceEnvelope || null;
  const current = readCoordinator(args);
  if (current?.executionId && current.executionId !== payload.executionId) return { ...args, state: "superseded", executionId: payload.executionId };
  if (current?.executionId === payload.executionId && COORDINATOR_TERMINAL_STATES.has(current.state)) {
    return {
      ...args,
      executionId: payload.executionId,
      state: current.state,
      active: false,
      stopReason: current.stopReason || "terminal-execution",
      roundsStarted: Number(current.roundsStarted || 0),
      completionAllowed: current.state === "completed",
      terminalExecutionReplayRefused: true,
    };
  }
  if (args.taskId) repairDirectorLegacyRounds(args.taskId);
  const config = coordinatorConfig({ ...(payload.config || payload), campaignSupervisor: payload.campaignSupervisor === true });
  const deadline = Date.now() + config.maxMinutes * 60 * 1000;
  const inventoryFn = dependencies.inventory || inventory;
  const historyFn = dependencies.providerHistory || providerHistory;
  const createJobFn = dependencies.createJob || ((contract) => createJob(contract, entrypoint));
  let state = writeCoordinator(args, { executionId: payload.executionId, state: "running", pid: process.pid, config, startedAt: current?.startedAt || utcNow() });
  let roundsStarted = Number(state.roundsStarted || 0);
  let noProgress = 0;
  const executionRoundIds = new Set(
    current?.executionId === payload.executionId && current.lastRoundId ? [current.lastRoundId] : [],
  );
  let summary = taskSummary(args);
  let signature = progressSignature(summary);
  const failedProviders = new Set();
  let recoveredCapacityResources = null;
  let stopReason = "time-limit";

  try {
    while (Date.now() < deadline) {
      let programAllowedAllocationIds = null;
      const liveState = readCoordinator(args);
      if (liveState?.executionId !== payload.executionId) { stopReason = "superseded"; break; }
      if (liveState?.state === "cancel-requested") { stopReason = "cancelled"; break; }
      summary = taskSummary(args);
      if (completionReady(summary)) {
        const completion = completeTask(args);
        summary = taskSummary(args);
        if (completion.completionAllowed === true) {
          material(args, state, {
            type: "acceptance.completed",
            state: "completed",
            summary: "All required acceptance evidence passed for this target.",
            evidenceRefs: summary.portfolioId
              ? (summary.projects || []).flatMap((project) => (project.requirements || []).flatMap((row) => row.evidenceCount ? [`${project.taskId}:${row.id}`] : [])).slice(0, 12)
              : (summary.requirements || []).filter((row) => row.evidenceCount).map((row) => row.id).slice(0, 12),
          });
          stopReason = "acceptance-complete";
          break;
        }
      }

      const latest = summary.latestRound;
      if (latest && ["running", "ready-for-integration", "needs-correction"].includes(latest.state)) {
        const round = roundRecord(args, latest.roundId);
        if (latest.state === "running") {
          const waited = await waitForRoundTerminal(args, round, deadline);
          if (!waited.terminal) {
            stopReason = "worker-deadline";
            material(args, state, {
              type: "coordinator.stopped",
              state: "blocked",
              roundId: round.roundId,
              summary: "The finite coordinator deadline arrived while a worker still owned the action.",
              blocker: "worker-deadline",
              nextAction: "Reconcile the same durable task after the worker reaches a terminal state; do not duplicate the worker.",
            });
            break;
          }
        }
        let collected;
        try {
          collected = collectRound({ ...args, roundId: latest.roundId, waitSeconds: 0, detail: "full" });
        } catch (error) {
          const refreshedRound = roundRecord(args, latest.roundId);
          const invalidated = refreshedRound?.state === "invalidated"
            && /invalidated by a (?:task|project) contract revision/i.test(String(error.message || ""));
          if (!invalidated) throw error;
          material(args, state, {
            type: "round.invalidated",
            state: "superseded",
            roundId: latest.roundId,
            summary: "Discarded one stale round after the authoritative task contract changed.",
            nextAction: "Continue from the revised mission and dispatch only its dependency-ready package.",
          });
          summary = taskSummary(args);
          signature = progressSignature(summary);
          continue;
        }
        const belongsToCurrentExecution = executionRoundIds.has(latest.roundId);
        const terminal = (collected.results || []).filter((row) => row.terminal);
        material(args, state, {
          type: "round.collected",
          state: collected.state,
          roundId: latest.roundId,
          summary: `Collected ${terminal.length} terminal worker result(s) exactly once.`,
          data: { workers: workerDetails(terminal) },
        });
        if (belongsToCurrentExecution) {
          for (const row of terminal.filter((item) => item.state !== "completed")) failedProviders.add(String(row.provider || "").toLowerCase());
        }

        const completed = terminal.filter((row) => row.state === "completed");
        const directorTerminalFailure = summary.program?.mode === "director-cfo" && terminal.length > 0;
        if (completed.length || directorTerminalFailure) {
          const integrated = integrateRound({ ...args, roundId: latest.roundId });
          const managerTransitions = (integrated.integrations || []).filter((row) => row.managerTransition === true);
          const failed = (integrated.integrations || []).filter((row) => row.integrated !== true && row.managerTransition !== true);
          if (belongsToCurrentExecution) {
            for (const row of failed.filter((item) => item.reconciled !== true)) {
              const worker = terminal.find((item) => item.jobId === row.jobId);
              failedProviders.add(String(worker?.provider || "").toLowerCase());
            }
          }
          const observations = (integrated.integrations || []).filter((row) => row.observation === true && row.integrated === true);
          const accepted = (integrated.acceptedEvidence || []).length;
          material(args, state, {
            type: "round.integrated",
            state: integrated.state,
            roundId: latest.roundId,
            summary: `Integrated ${Math.max(0, completed.length - observations.length - failed.length - managerTransitions.length)} patch(es), accepted ${observations.length} structured observation(s), recorded ${managerTransitions.length} bounded manager transition(s), and recorded ${accepted} acceptance evidence item(s).`,
            blocker: failed.map((row) => row.blocker).filter(Boolean).join(" | "),
            evidenceRefs: (integrated.acceptedEvidence || []).map((row) => row.ref).filter(Boolean).slice(0, 12),
            data: {
              observations: observations.map((row) => ({ jobId: row.jobId, createdWorkGraphNodeIds: row.createdWorkGraphNodeIds || [] })),
              managerTransitions: managerTransitions.map((row) => ({ jobId: row.jobId, refreshScheduled: row.refreshScheduled === true, blocked: row.blocked === true })),
            },
          });
        }

        summary = taskSummary(args);
        const nextSignature = progressSignature(summary);
        if (nextSignature !== signature) {
          noProgress = 0;
          signature = nextSignature;
        } else if (belongsToCurrentExecution && !(summary.program?.mode === "director-cfo" && ["context", "strategy"].includes(summary.program.phase))) {
          noProgress += 1;
        }
        if (noProgress >= config.noProgressLimit) {
          stopReason = "no-progress-limit";
          material(args, state, {
            type: "coordinator.stopped",
            state: "blocked",
            summary: "The configured no-progress limit was reached without stronger acceptance or work-graph evidence.",
            blocker: "no-progress-limit",
            nextAction: "Inspect the typed failure or blocker before any materially changed retry.",
          });
          break;
        }
      }

      summary = taskSummary(args);
      if (completionReady(summary)) continue;
      const execution = summary.portfolioId
        ? (summary.projects || []).find((project) => project.taskId === summary.currentCodex?.taskId)?.execution
        : summary.execution;
      const recommended = summary.portfolioId
        ? (summary.projects || []).flatMap((project) => project.workPlane?.recommendedWorkUnits || [])
        : (summary.workPlane?.recommendedWorkUnits || []);
      if (execution?.userActionRequired) {
        stopReason = "user-decision-required";
        material(args, state, {
          type: "decision.required",
          state: "blocked",
          requirementId: execution.requirementId,
          summary: "A recorded user-owned decision is required; other dependency-ready work is exhausted.",
          blocker: bounded(execution.reason, 1200),
          nextAction: bounded(execution.action, 1200),
        });
        break;
      }
      if (!recommended.length) {
        stopReason = "no-dependency-ready-unit";
        material(args, state, {
          type: "coordinator.stopped",
          state: "blocked",
          summary: "No dependency-ready bounded unit remains for deterministic dispatch.",
          blocker: "no-dependency-ready-unit",
          nextAction: bounded(execution?.action || "Reconcile the project acceptance graph from authoritative evidence.", 1200),
        });
        break;
      }
      if (roundsStarted >= config.maxRounds) { stopReason = "round-limit"; break; }
      if (summary.program?.mode === "director-cfo" && programResourceEnvelope?.allowNewConsumption === false) {
        const taskForAuthority = readTask(args.taskId);
        const recommendedIds = new Set(recommended.map((row) => String(row.workPackageId || row.workGraphNodeId || "")).filter(Boolean));
        const allowedIds = new Set(programResourceEnvelope.allowedAllocationIds || []);
        const allowedRecommendedAllocations = (taskForAuthority.program?.workPackages || [])
          .filter((row) => recommendedIds.has(String(row.workPackageId || "")) && allowedIds.has(String(row.allocation?.allocationId || "")))
          .map((row) => String(row.allocation.allocationId));
        if (allowedRecommendedAllocations.length) {
          programAllowedAllocationIds = [...new Set(allowedRecommendedAllocations)];
        } else if (programResourceEnvelope.allowBudgetRefresh === true) {
          const beforeBudgetTask = readTask(args.taskId);
          const beforeBudgetFingerprint = programBudgetAuthorityFingerprint(beforeBudgetTask);
          const budgetResources = recoveredCapacityResources
            || await inventoryFn({ refresh: true, forDispatch: true, horizonHours: config.horizonHours });
          recoveredCapacityResources = null;
          const budgetHistories = { ...historyFn() };
          for (const provider of failedProviders) budgetHistories[provider] = { ...(budgetHistories[provider] || {}), cooledDown: true, cooldownReason: "failed-earlier-in-same-execution" };
          const refreshedTask = prepareProgramDispatch(beforeBudgetTask, budgetResources, budgetHistories);
          const afterBudgetFingerprint = programBudgetAuthorityFingerprint(refreshedTask);
          if (afterBudgetFingerprint !== beforeBudgetFingerprint) {
            stopReason = "resource-budget-refreshed";
            material(args, state, {
              type: "resource.budget-refreshed",
              state: "active",
              summary: "Integrated work exposed a new dependency-ready package; its deterministic budget revision was persisted before any new job was claimed.",
              nextAction: "Re-evaluate the revised cumulative authority, then dispatch only if the refreshed budget leaves positive capacity.",
            });
            break;
          }
        }
        if (programAllowedAllocationIds?.length) {
          // Existing campaign allocation or retry authority is already reserved; final claim/lease guards remain authoritative.
        } else {
          stopReason = "resource-cap-exhausted";
          material(args, state, {
          type: "resource.exhausted",
          state: "blocked",
          summary: "Existing authorized work was collected, but the cumulative program envelope has no remaining authority for another job or campaign.",
          blocker: programResourceEnvelope.blocker || "program-resource-cap-exhausted",
            nextAction: "Accept a revision-fenced resource budget before any new consumptive dispatch.",
          });
          break;
        }
      }

      const resources = recoveredCapacityResources
        || await inventoryFn({ refresh: true, forDispatch: true, horizonHours: config.horizonHours });
      recoveredCapacityResources = null;
      const histories = { ...historyFn() };
      for (const provider of failedProviders) histories[provider] = { ...(histories[provider] || {}), cooledDown: true, cooldownReason: "failed-earlier-in-same-execution" };
      const dispatched = dispatchRound({ ...args, horizonHours: config.horizonHours, programAllowedAllocationIds }, resources, histories, (contract) => {
        if (failedProviders.has(String(contract.provider || "").toLowerCase())) throw new Error("provider-failed-earlier-in-same-execution: unchanged invocation is not retried");
        return createJobFn(contract);
      });
      const hasWorkers = (dispatched.workers || []).length > 0;
      const recoverableCapacityWait = !hasWorkers && isRecoverableCapacityWait(dispatched);
      if (dispatched.roundId) {
        roundsStarted += 1;
        executionRoundIds.add(dispatched.roundId);
        state = writeCoordinator(args, { executionId: payload.executionId, roundsStarted, lastRoundId: dispatched.roundId });
      }
      if (!recoverableCapacityWait || dispatched.roundId) {
        material(args, state, {
          type: "round.dispatched",
          state: dispatched.state,
          roundId: dispatched.roundId,
          summary: `Assigned ${(dispatched.workers || []).length} dependency-ready worker(s) after fresh capacity and lease checks.`,
          blocker: (dispatched.rejected || []).map((row) => row.reason).filter(Boolean).join(" | "),
          nextAction: hasWorkers ? "The coordinator is waiting on worker state changes, not polling an LLM." : bounded(dispatched.nextAction, 1200),
          data: { workers: workerDetails(dispatched.workers || []) },
        });
      }
      if (!hasWorkers) {
        if (recoverableCapacityWait) {
          const descriptor = capacityWaitDescriptor(args.taskId ? readTask(args.taskId) : {}, dispatched, resources, config);
          state = writeCoordinator(args, {
            executionId: payload.executionId,
            capacityWait: { ...descriptor, startedAt: utcNow(), nextAction: capacityWaitSummary(descriptor) },
          });
          material(args, state, {
            type: "capacity.waiting",
            state: "waiting",
            summary: "The next package is ready, but a protected resource boundary is temporarily unavailable.",
            blocker: bounded(descriptor.reasons.join(" | "), 1600),
            nextAction: capacityWaitSummary(descriptor),
            data: {
              workPackageIds: descriptor.workPackageIds,
              observedFreeRamMb: descriptor.observedFreeRamMb,
              requiredFreeRamMb: descriptor.requiredFreeRamMb,
              observedFreeDiskMb: descriptor.observedFreeDiskMb,
              requiredFreeDiskMb: descriptor.requiredFreeDiskMb,
              backoffSeconds: descriptor.backoffSeconds,
              maxBackoffSeconds: descriptor.maxBackoffSeconds,
            },
          });
          const recovery = await waitForCapacityRecovery(
            { ...args, executionId: payload.executionId },
            descriptor,
            deadline,
            inventoryFn,
            config,
            dependencies,
          );
          if (recovery.recovered) {
            recoveredCapacityResources = recovery.resources;
            state = writeCoordinator(args, { executionId: payload.executionId, capacityWait: null });
            material(args, state, {
              type: "capacity.available",
              state: "ready",
              summary: "A protected capacity threshold changed enough to make the next package eligible for a fresh dispatch decision.",
              nextAction: "Refresh full provider capacity and dispatch the package exactly once.",
              data: { checks: recovery.checks },
            });
            continue;
          }
          stopReason = recovery.stopReason || "capacity-wait";
          if (stopReason === "capacity-wait") {
            material(args, state, {
              type: "coordinator.stopped",
              state: "blocked",
              summary: "The finite coordinator reached its bounded capacity-wait limit without crossing the required resource threshold.",
              blocker: bounded(descriptor.reasons.join(" | "), 1600),
              nextAction: capacityWaitSummary(descriptor),
              data: { checks: recovery.checks },
            });
          }
          break;
        }
        const rejectionText = (dispatched.rejected || []).map((row) => row.reason).filter(Boolean).join(" | ");
        if (/missing callable capabilities|visible UI is required|not authorized|authentication-required|not authenticated/i.test(rejectionText)) {
          stopReason = "capability-decision-required";
          material(args, state, {
            type: "decision.required",
            state: "blocked",
            summary: "No authorized callable headless surface satisfies the next unit's capability contract.",
            blocker: bounded(rejectionText, 1600),
            nextAction: "Authorize or connect the named capability once, or revise the unit to a genuinely callable headless surface; AI Mobile will not fake the capability or auto-launch a UI.",
          });
        } else {
          stopReason = "no-eligible-worker";
        }
        break;
      }
    }
  } catch (error) {
    stopReason = "coordinator-failed";
    material(args, state, {
      type: "coordinator.failed",
      state: "failed",
      summary: "The deterministic coordinator stopped on an unexpected invariant violation.",
      blocker: bounded(error.stack || error.message, 1600),
      nextAction: "Repair the recorded invariant before resuming this same durable target.",
    });
  }

  summary = taskSummary(args);
  const supervisedSliceStop = payload.supervisedSlice === true && SUPERVISED_SLICE_STOP_REASONS.has(stopReason);
  const finalState = stopReason === "acceptance-complete"
    ? "completed"
    : stopReason === "cancelled"
      ? "cancelled"
      : stopReason === "coordinator-failed"
        ? "failed"
        : supervisedSliceStop ? "slice-stopped" : "stopped";
  state = writeCoordinator(args, {
    executionId: payload.executionId,
    state: finalState,
    pid: supervisedSliceStop ? process.pid : null,
    finishedAt: supervisedSliceStop ? null : utcNow(),
    stopReason,
    roundsStarted,
  });
  if (supervisedSliceStop) {
    material(args, state, {
      type: "coordinator.slice-stopped",
      state: "waiting",
      summary: `A bounded coordinator slice stopped at ${stopReason}; the campaign supervisor owns the next wake.`,
      nextAction: "Persist the next eligible wake and resume only after a material state transition or bounded retry eligibility.",
      data: { stopReason, roundsStarted },
    });
  } else if (!["acceptance-complete", "coordinator-failed", "no-progress-limit", "no-dependency-ready-unit", "user-decision-required", "capability-decision-required", "worker-deadline", "capacity-wait"].includes(stopReason)) {
    material(args, state, {
      type: "coordinator.stopped",
      state: finalState,
      summary: `The finite coordinator stopped: ${stopReason}.`,
      blocker: stopReason,
      nextAction: "Resume this same durable target only when capacity, dependency, or project evidence changes.",
    });
  }
  return { ...args, executionId: payload.executionId, state: finalState, stopReason, roundsStarted, progress: summary.progress, completionAllowed: summary.completionAllowed === true };
}

function supervisorStop(args, execution, reason, recovery, campaignSlices, extra = {}) {
  const completed = reason === "acceptance-complete";
  const cancelled = reason === "cancelled";
  const finalState = completed ? "completed" : cancelled ? "cancelled" : "stopped";
  if (args.taskId) persistProgramSupervisorStop(args.taskId, reason, recovery, { completed, cancelled, expectedSupervisorId: execution?.programSupervisorId || readCoordinator(args)?.programSupervisorId });
  const current = readCoordinator(args) || execution || {};
  const state = writeCoordinator(args, {
    executionId: current.executionId,
    state: finalState,
    pid: null,
    finishedAt: utcNow(),
    stopReason: reason,
    campaignSlices,
    nextWakeAt: null,
  });
  material(args, state, {
    type: completed ? "acceptance.completed" : "coordinator.stopped",
    state: finalState,
    summary: extra.summary || (completed
      ? "The durable campaign completed with authoritative acceptance evidence."
      : `The durable campaign supervisor stopped: ${reason}.`),
    blocker: completed ? "" : (extra.blocker || reason),
    nextAction: recovery.action,
    data: { owner: recovery.owner, recoveryTrigger: recovery.trigger, campaignSlices },
  });
  return { ...args, executionId: state.executionId, state: finalState, stopReason: reason, campaignSlices, recovery, ...extra.result };
}

async function waitForCampaignWake(args, payload, baseline, dependencies = {}) {
  const summaryFn = dependencies.campaignSummary || taskSummary;
  const inventoryFn = dependencies.inventory || inventory;
  const sleep = dependencies.campaignSleep || ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const capacityDescriptor = baseline.capacityWait || null;
  let attempt = 0;
  let unchangedObservationEligible = false;
  let previousWorkerFingerprint = baseline.workerFingerprint || "";
  while (true) {
    const coordinator = readCoordinator(args);
    if (coordinator?.state === "cancel-requested") return { stopReason: "cancelled" };
    let task = readTask(args.taskId);
    let supervisor = readProgramSupervisor(task);
    if (!supervisor) return { stopReason: "no-progress-limit", blocker: "program-supervisor-missing" };
    if (supervisor.state === "cancelled") return { stopReason: "cancelled" };
    if (["stopped", "completed"].includes(supervisor.state)) {
      return { stopReason: supervisor.state === "completed" ? "acceptance-complete" : "no-progress-limit", blocker: supervisor.stopReason };
    }
    if (programSupervisorExpired(supervisor)) return { stopReason: "campaign-horizon" };
    supervisor = maybeReviseProgramSupervisorLimits(args.taskId, task, payload, supervisor) || supervisor;
    task = readTask(args.taskId);
    const summary = summaryFn(args);
    if (summary.state === "completed" || task.state === "completed") return { stopReason: "acceptance-complete" };
    if (summary.execution?.userActionRequired) return { stopReason: "user-decision-required" };
    const resourceCaps = programSupervisorResourceSafety(task, supervisor);
    persistProgramResourceSnapshot(args.taskId, task, resourceCaps);
    const resourceCapsDrainable = resourceCaps.consumptionBlocked === true && programHasDrainableWork(task, summary, resourceCaps);
    const eventCapDrain = resourceCaps.eventCapExhausted === true && resourceCapsDrainable;
    if (!resourceCaps.safe && !resourceCaps.recoverableCapacity && !resourceCapsDrainable) return { stopReason: "resource-cap-exceeded", blocker: resourceCaps.reason };
    const fingerprint = campaignStateFingerprint(task);
    const acceptanceFingerprint = campaignAcceptedEvidenceFingerprint(task);
    const foundationState = campaignFoundationState(task);
    const foundationTransition = campaignFoundationTransition(baseline.foundationState, foundationState, supervisor);
    const acceptanceImproved = acceptanceFingerprint !== baseline.acceptanceFingerprint;
    const foundationalNeutral = foundationTransition.eligible;
    const worker = campaignWorkerObservation(args, summary);
    if (fingerprint !== baseline.stateFingerprint) {
      return {
        reason: acceptanceImproved ? "evidence-change" : "dependency-change",
        fingerprint,
        acceptanceFingerprint,
        acceptanceImproved,
        foundationalNeutral,
        foundationTransitionKeys: foundationTransition.keys,
        materialStateChanged: true,
        drainOnly: eventCapDrain,
        worker,
        summary,
        task,
        supervisor,
      };
    }
    if (worker.terminal && worker.fingerprint !== previousWorkerFingerprint) {
      return {
        reason: "worker-terminal",
        fingerprint: worker.fingerprint,
        acceptanceFingerprint,
        acceptanceImproved,
        foundationalNeutral,
        foundationTransitionKeys: foundationTransition.keys,
        materialStateChanged: true,
        drainOnly: eventCapDrain,
        worker,
        summary,
        task,
        supervisor,
      };
    }
    previousWorkerFingerprint = worker.fingerprint || previousWorkerFingerprint;
    if (capacityDescriptor) {
      const resources = await inventoryFn({ refresh: false, forDispatch: false, horizonHours: supervisor.horizonHours });
      if (capacityRequirementSatisfied(capacityDescriptor, resources)) {
        return {
          reason: "quota-reset",
          fingerprint: crypto.createHash("sha256").update(JSON.stringify({ machine: resources.machine || null, worktreeStorage: resources.worktreeStorage || null, providers: resources.providers || {} })).digest("hex"),
          acceptanceFingerprint,
          acceptanceImproved: false,
          foundationalNeutral: false,
          foundationTransitionKeys: [],
          materialStateChanged: true,
          capacityChanged: true,
          worker,
          summary,
          task,
          supervisor,
        };
      }
    }
    if (!campaignWorkRemaining(task, summary)) return { stopReason: "no-progress-limit", blocker: "no-dependency-ready-unit" };
    if (unchangedObservationEligible && !worker.active && !capacityDescriptor) {
      const scheduledKey = `scheduled-${supervisor.supervisorId}-${attempt}`;
      const wake = persistProgramSupervisorWake(args.taskId, {
        reason: "scheduled-observation",
        stateFingerprint: fingerprint,
        evidenceFingerprint: acceptanceFingerprint,
        scheduledKey,
        acceptanceImproved: false,
        expectedSupervisorId: supervisor.supervisorId,
        expectedSupervisorEpoch: supervisor.supervisorEpoch,
      });
      if (wake.supervisor?.state === "stopped") return { stopReason: "no-progress-limit", blocker: wake.supervisor.stopReason };
      unchangedObservationEligible = false;
    }
    const activeCampaign = task.program?.activeCampaign || null;
    const backoffMs = campaignBackoff(activeCampaign || supervisor, payload.config || {}, attempt);
    const deadline = Date.parse(supervisor.deadlineAt || "");
    const nextWakeAt = new Date(Math.min(Number.isFinite(deadline) ? deadline : Date.now() + backoffMs, Date.now() + backoffMs)).toISOString();
    const recovery = capacityDescriptor
      ? supervisorRecovery("protected-capacity-state-change", "Refresh capacity at the persisted wake and resume only after the recorded threshold changes.", "coordinator")
      : supervisorRecovery("program-material-state-change", "Resume the next finite slice after a worker terminal, dependency, evidence, or bounded retry transition.", "coordinator");
    persistCampaignWait(args.taskId, nextWakeAt, recovery);
    const waiting = writeCoordinator(args, {
      executionId: coordinator?.executionId || payload.executionId,
      state: "waiting",
      pid: process.pid,
      nextWakeAt,
      campaignSupervisor: true,
      campaignStartedAt: supervisor.startedAt,
      programSupervisorId: supervisor.supervisorId,
      programSupervisorDeadlineAt: supervisor.deadlineAt,
      programNoProgressCount: supervisor.noProgressCount,
      programWakeCount: supervisor.wakeCount,
    });
    if (attempt === 0) {
      material(args, waiting, {
        type: "campaign.waiting",
        state: "waiting",
        summary: "The durable program supervisor persisted the next eligible wake after a bounded coordinator slice.",
        nextAction: recovery.action,
        data: { nextWakeAt, backoffMs, owner: recovery.owner, capacityWait: Boolean(capacityDescriptor), supervisorId: supervisor.supervisorId },
      });
    }
    await sleep(backoffMs, { taskId: args.taskId, nextWakeAt, attempt, supervisorId: supervisor.supervisorId, capacityWait: Boolean(capacityDescriptor) });
    unchangedObservationEligible = true;
    attempt += 1;
  }
}
function nextCampaignSlice(args, payload, summary, campaignSlices) {
  if (readCoordinator(args)?.state === "cancel-requested") return null;
  const supervisor = readProgramSupervisor(readTask(args.taskId));
  if (!supervisor || !["active", "waiting"].includes(supervisor.state) || programSupervisorExpired(supervisor)) return null;
  const id = executionId();
  const createdAt = utcNow();
  const next = {
    ...payload,
    ...args,
    executionId: id,
    createdAt,
    campaignSupervisor: true,
    supervisedSlice: true,
    campaignStartedAt: supervisor.startedAt,
  };
  writeJson(coordinatorPayloadFile(args), next);
  const state = writeCoordinator(args, {
    executionId: id,
    state: "launching",
    pid: process.pid,
    startedAt: createdAt,
    finishedAt: null,
    stopReason: "",
    roundsStarted: 0,
    lastRoundId: summary?.latestRound?.roundId || null,
    config: next.config,
    campaignSupervisor: true,
    campaignStartedAt: next.campaignStartedAt,
    campaignSlices,
    nextWakeAt: null,
    programSupervisorId: supervisor.supervisorId,
    programSupervisorDeadlineAt: supervisor.deadlineAt,
    programNoProgressCount: supervisor.noProgressCount,
    programWakeCount: supervisor.wakeCount,
  });
  if (state.executionId !== id || state.state === "cancel-requested") return null;
  material(args, state, {
    type: "campaign.woke",
    state: "running",
    summary: "A persisted campaign wake started the next finite coordinator slice.",
    nextAction: "Collect or integrate the authoritative prior round before any new dispatch.",
    data: { campaignSlices },
  });
  return next;
}

async function runCampaignSupervisor(payload, entrypoint, dependencies = {}) {
  const args = targetArgs(payload);
  if (!args.taskId) throw new Error("run-program-campaign requires a Director-CFO taskId.");
  const runSlice = dependencies.runSlice || ((slicePayload) => runCoordinator(slicePayload, entrypoint, dependencies));
  const summaryFn = dependencies.campaignSummary || taskSummary;
  const inventoryFn = dependencies.inventory || inventory;
  const initialTask = readTask(args.taskId);
  if (initialTask.program?.mode !== "director-cfo") throw new Error("campaign-supervisor requires a Director-CFO task.");
  let programSupervisor = ensureProgramSupervisor(args.taskId, payload);
  if (!["active", "waiting"].includes(programSupervisor?.state)) {
    return {
      ...args,
      executionId: payload.executionId,
      state: programSupervisor?.state || "stopped",
      stopReason: programSupervisor?.stopReason || "program-supervisor-not-active",
      campaignSlices: 0,
      programSupervisor,
    };
  }
  if (programSupervisorExpired(programSupervisor)) {
    const recovery = supervisorRecovery("fresh-program-horizon", "Start a new bounded program supervisor only after an explicit continuation with a fresh resource budget.", "director");
    return supervisorStop(args, readCoordinator(args), "campaign-horizon", recovery, 0);
  }
  const campaignStartedAt = programSupervisor.startedAt;
  const supervisorConfig = {
    ...(payload.config || {}),
    horizonHours: Number(programSupervisor.horizonHours || payload.config?.horizonHours || 5),
  };
  let slicePayload = {
    ...payload,
    config: supervisorConfig,
    campaignSupervisor: true,
    supervisedSlice: true,
    campaignStartedAt,
    campaignSupervisorExecutionId: payload.campaignSupervisorExecutionId || payload.executionId,
  };
  let campaignSlices = 0;
  writeCoordinator(args, {
    executionId: payload.executionId,
    campaignStartedAt,
    campaignSupervisor: true,
    programSupervisorId: programSupervisor.supervisorId,
    programSupervisorDeadlineAt: programSupervisor.deadlineAt,
    programNoProgressCount: programSupervisor.noProgressCount,
    programWakeCount: programSupervisor.wakeCount,
  });

  while (true) {
    let beforeTask = readTask(args.taskId);
    const preSliceEpoch = rolloverExpiredCampaignEpoch(args.taskId);
    if (preSliceEpoch.rolled) beforeTask = readTask(args.taskId);
    programSupervisor = readProgramSupervisor(beforeTask);
    if (!programSupervisor || !["active", "waiting"].includes(programSupervisor.state)) {
      const reason = programSupervisor?.state === "cancelled" ? "cancelled" : programSupervisor?.state === "completed" ? "acceptance-complete" : "no-progress-limit";
      const recovery = supervisorRecovery(reason === "cancelled" ? "user-resume" : "material-plan-or-evidence-change", reason === "cancelled" ? "Resume only after a new explicit user instruction." : "Start a new bounded supervisor only after a material correction or fresh accepted evidence.", reason === "cancelled" ? "user" : "director");
      return supervisorStop(args, readCoordinator(args), reason, recovery, campaignSlices);
    }
    if (readCoordinator(args)?.state === "cancel-requested") {
      persistProgramSupervisorWake(args.taskId, {
        reason: "cancel",
        stateFingerprint: campaignStateFingerprint(beforeTask),
        evidenceFingerprint: campaignAcceptedEvidenceFingerprint(beforeTask),
        expectedSupervisorId: programSupervisor?.supervisorId,
        expectedSupervisorEpoch: programSupervisor?.supervisorEpoch,
      });
      const recovery = supervisorRecovery("user-resume", "Resume only after a new explicit user instruction.", "user");
      return supervisorStop(args, readCoordinator(args), "cancelled", recovery, campaignSlices);
    }
    if (programSupervisorExpired(programSupervisor)) {
      const recovery = supervisorRecovery("fresh-program-horizon", "Start a new bounded program supervisor only after an explicit continuation with a fresh resource budget.", "director");
      return supervisorStop(args, readCoordinator(args), "campaign-horizon", recovery, campaignSlices);
    }
    programSupervisor = maybeReviseProgramSupervisorLimits(args.taskId, beforeTask, slicePayload, programSupervisor) || programSupervisor;
    beforeTask = readTask(args.taskId);
    const preSliceResourceSafety = programSupervisorResourceSafety(beforeTask, programSupervisor);
    programSupervisor = persistProgramResourceSnapshot(args.taskId, beforeTask, preSliceResourceSafety) || programSupervisor;
    const beforeSummary = summaryFn(args);
    const drainableWork = programHasDrainableWork(beforeTask, beforeSummary, preSliceResourceSafety);
    if (preSliceResourceSafety.consumptionExhausted && !drainableWork) {
      const recovery = supervisorRecovery("fresh-resource-budget", "Resume only after a revision-fenced budget restores a positive cumulative resource envelope.", "director");
      return supervisorStop(args, readCoordinator(args), "resource-cap-exceeded", recovery, campaignSlices, {
        blocker: preSliceResourceSafety.reason,
        result: { blocker: preSliceResourceSafety.reason },
      });
    }
    if (!preSliceResourceSafety.safe && !preSliceResourceSafety.recoverableCapacity && !preSliceResourceSafety.consumptionBlocked) {
      const recovery = supervisorRecovery("fresh-resource-budget", "Resume only after the recorded program-wide resource blocker is corrected under a fresh bounded budget.", "director");
      return supervisorStop(args, readCoordinator(args), "resource-cap-exceeded", recovery, campaignSlices, {
        blocker: preSliceResourceSafety.reason,
        result: { blocker: preSliceResourceSafety.reason },
      });
    }
    slicePayload = {
      ...slicePayload,
      programResourceEnvelope: programConsumptionEnvelope(beforeTask, programSupervisor, preSliceResourceSafety),
    };

    const beforeWorker = campaignWorkerObservation(args, beforeSummary);
    const baseline = {
      stateFingerprint: campaignStateFingerprint(beforeTask),
      acceptanceFingerprint: campaignAcceptedEvidenceFingerprint(beforeTask),
      foundationState: campaignFoundationState(beforeTask),
      workerFingerprint: beforeWorker.fingerprint,
      capacityWait: null,
      supervisor: programSupervisor,
    };
    if (preSliceResourceSafety.recoverableCapacity && !preSliceResourceSafety.consumptionExhausted) {
      const guardKey = programQuotaGuardKey(beforeTask, programSupervisor, preSliceResourceSafety);
      if (programSupervisor.quotaGuardKey === guardKey) {
        const resources = await inventoryFn({ refresh: false, forDispatch: false, horizonHours: programSupervisor.horizonHours });
        baseline.capacityWait = programQuotaCapacityDescriptor(beforeTask, preSliceResourceSafety, resources, slicePayload.config || {});
        const guardedWake = await waitForCampaignWake(args, slicePayload, baseline, dependencies);
        if (guardedWake.stopReason) {
          if (guardedWake.stopReason === "acceptance-complete") {
            const recovery = supervisorRecovery("none", "No further program action is required.", "director");
            return supervisorStop(args, readCoordinator(args), "acceptance-complete", recovery, campaignSlices);
          }
          if (guardedWake.stopReason === "cancelled") {
            const recovery = supervisorRecovery("user-resume", "Resume only after a new explicit user instruction.", "user");
            return supervisorStop(args, readCoordinator(args), "cancelled", recovery, campaignSlices);
          }
          const guardedReason = ["campaign-horizon", "user-decision-required", "resource-cap-exceeded"].includes(guardedWake.stopReason)
            ? guardedWake.stopReason
            : "no-progress-limit";
          const recovery = guardedReason === "campaign-horizon"
            ? supervisorRecovery("fresh-program-horizon", "Start a new bounded program supervisor only after an explicit continuation with a fresh resource budget.", "director")
            : guardedReason === "user-decision-required"
              ? supervisorRecovery("user-decision", "Resume after the named decision or authorization is supplied.", "user")
              : guardedReason === "resource-cap-exceeded"
                ? supervisorRecovery("fresh-resource-budget", "Resume only after the recorded program-wide resource blocker is corrected under a fresh bounded budget.", "director")
                : supervisorRecovery("material-plan-or-evidence-change", "Reconcile the recorded blocker before any materially changed retry.", "director");
          return supervisorStop(args, readCoordinator(args), guardedReason, recovery, campaignSlices, { blocker: guardedWake.blocker });
        }
        const guardedWakeResult = persistSupervisorWake(args.taskId, guardedWake);
        if (!guardedWakeResult.changed || guardedWakeResult.supervisor?.state === "stopped") {
          const recovery = supervisorRecovery("material-plan-or-evidence-change", "Reconcile the recorded blocker before any materially changed retry.", "director");
          return supervisorStop(args, readCoordinator(args), "no-progress-limit", recovery, campaignSlices);
        }
        continue;
      }
      programSupervisor = persistProgramQuotaGuard(args.taskId, guardKey) || programSupervisor;
      baseline.supervisor = programSupervisor;
    }
    const result = await runSlice(slicePayload, entrypoint, dependencies);
    campaignSlices += 1;
    if (!SUPERVISED_SLICE_STOP_REASONS.has(result.stopReason)) {
      if (["resource-cap-exhausted", "resource-cap-exceeded"].includes(result.stopReason)) {
        const recovery = supervisorRecovery("fresh-resource-budget", "Resume only after a revision-fenced budget restores a positive cumulative resource envelope.", "director");
        return supervisorStop(args, readCoordinator(args), "resource-cap-exceeded", recovery, campaignSlices, {
          blocker: result.blocker || slicePayload.programResourceEnvelope?.blocker || "program-resource-cap-exhausted",
        });
      }
      if (result.stopReason === "acceptance-complete") {
        const recovery = supervisorRecovery("none", "No further program action is required.", "director");
        return supervisorStop(args, readCoordinator(args), "acceptance-complete", recovery, campaignSlices);
      }
      if (result.stopReason === "cancelled") {
        const currentTask = readTask(args.taskId);
        persistProgramSupervisorWake(args.taskId, {
          reason: "cancel",
          stateFingerprint: campaignStateFingerprint(currentTask),
          evidenceFingerprint: campaignAcceptedEvidenceFingerprint(currentTask),
          expectedSupervisorId: readProgramSupervisor(currentTask)?.supervisorId,
          expectedSupervisorEpoch: readProgramSupervisor(currentTask)?.supervisorEpoch,
        });
        const recovery = supervisorRecovery("user-resume", "Resume only after a new explicit user instruction.", "user");
        return supervisorStop(args, readCoordinator(args), "cancelled", recovery, campaignSlices);
      }
      if (result.stopReason === "user-decision-required" || result.stopReason === "capability-decision-required") {
        const recovery = supervisorRecovery("user-decision", "Resume after the named decision or authorization is supplied.", "user");
        return supervisorStop(args, readCoordinator(args), "user-decision-required", recovery, campaignSlices, { blocker: result.blocker });
      }
      if (result.stopReason === "no-progress-limit") {
        const recovery = supervisorRecovery("material-plan-or-evidence-change", "Reconcile the recorded blocker, then start a materially changed bounded supervisor epoch.", "director");
        return supervisorStop(args, readCoordinator(args), "no-progress-limit", recovery, campaignSlices);
      }
      const recovery = supervisorRecovery("material-runtime-repair", "Repair the recorded terminal coordinator failure before a new bounded supervisor epoch.", "director");
      persistProgramSupervisorStop(args.taskId, result.stopReason || "coordinator-failed", recovery);
      return { ...result, campaignSlices, programSupervisor: readProgramSupervisor(readTask(args.taskId)) };
    }

    let afterTask = readTask(args.taskId);
    const postSliceEpoch = rolloverExpiredCampaignEpoch(args.taskId);
    if (postSliceEpoch.rolled) afterTask = readTask(args.taskId);
    const afterSummary = summaryFn(args);
    programSupervisor = readProgramSupervisor(afterTask);
    if (!programSupervisor) {
      const recovery = supervisorRecovery("program-supervisor-repair", "Repair the missing durable program supervisor before another finite slice.", "director");
      return supervisorStop(args, readCoordinator(args), "no-progress-limit", recovery, campaignSlices);
    }
    if (programSupervisorExpired(programSupervisor)) {
      const recovery = supervisorRecovery("fresh-program-horizon", "Start a new bounded program supervisor only after an explicit continuation with a fresh resource budget.", "director");
      return supervisorStop(args, readCoordinator(args), "campaign-horizon", recovery, campaignSlices);
    }
    programSupervisor = maybeReviseProgramSupervisorLimits(args.taskId, afterTask, slicePayload, programSupervisor) || programSupervisor;
    afterTask = readTask(args.taskId);
    const resourceSafety = programSupervisorResourceSafety(afterTask, programSupervisor);
    programSupervisor = persistProgramResourceSnapshot(args.taskId, afterTask, resourceSafety) || programSupervisor;
    const postSliceDrainable = resourceSafety.consumptionBlocked === true && programHasDrainableWork(afterTask, afterSummary, resourceSafety);
    if (!resourceSafety.safe && !resourceSafety.recoverableCapacity && !postSliceDrainable) {
      const recovery = supervisorRecovery("fresh-resource-budget", "Start another bounded supervisor only after a fresh budget proves the recorded hard resource cap is safe.", "director");
      return supervisorStop(args, readCoordinator(args), "resource-cap-exceeded", recovery, campaignSlices, {
        blocker: resourceSafety.reason,
        result: { blocker: resourceSafety.reason },
      });
    }

    const coordinatorAfterSlice = readCoordinator(args);
    baseline.capacityWait = result.stopReason === "capacity-wait"
      ? (coordinatorAfterSlice?.capacityWait || result.capacityWait || null)
      : null;
    if (resourceSafety.recoverableCapacity) {
      const resources = await inventoryFn({ refresh: false, forDispatch: false, horizonHours: programSupervisor.horizonHours });
      baseline.capacityWait = programQuotaCapacityDescriptor(afterTask, resourceSafety, resources, slicePayload.config || {});
    }
    if (result.stopReason === "capacity-wait" && !baseline.capacityWait) {
      const recovery = supervisorRecovery("capacity-descriptor-repair", "Repair the missing protected-capacity threshold before starting another bounded supervisor.", "director");
      return supervisorStop(args, coordinatorAfterSlice, "capacity-wait", recovery, campaignSlices, {
        blocker: "capacity-wait-descriptor-missing",
        result: { blocker: "capacity-wait-descriptor-missing" },
      });
    }

    const afterFingerprint = campaignStateFingerprint(afterTask);
    const afterAcceptanceFingerprint = campaignAcceptedEvidenceFingerprint(afterTask);
    const afterFoundationState = campaignFoundationState(afterTask);
    const foundationTransition = campaignFoundationTransition(baseline.foundationState, afterFoundationState, programSupervisor);
    const afterWorker = campaignWorkerObservation(args, afterSummary);
    const stateChanged = afterFingerprint !== baseline.stateFingerprint;
    const workerChanged = !stateChanged && afterWorker.terminal && afterWorker.fingerprint !== baseline.workerFingerprint;
    let wake = {
      reason: afterAcceptanceFingerprint !== baseline.acceptanceFingerprint
        ? "evidence-change"
        : stateChanged ? "dependency-change" : workerChanged ? "worker-terminal" : "",
      fingerprint: workerChanged ? afterWorker.fingerprint : afterFingerprint,
      acceptanceFingerprint: afterAcceptanceFingerprint,
      acceptanceImproved: afterAcceptanceFingerprint !== baseline.acceptanceFingerprint,
      foundationalNeutral: foundationTransition.eligible,
      foundationTransitionKeys: foundationTransition.keys,
      materialStateChanged: stateChanged || workerChanged,
      summary: afterSummary,
      task: afterTask,
      supervisor: programSupervisor,
      worker: afterWorker,
    };

    if (baseline.capacityWait) {
      if (wake.reason) {
        const immediateWake = persistSupervisorWake(args.taskId, wake);
        if (immediateWake.supervisor?.state === "stopped") {
          const recovery = supervisorRecovery("material-plan-or-evidence-change", "Reconcile the recorded blocker before any materially changed retry.", "director");
          return supervisorStop(args, readCoordinator(args), "no-progress-limit", recovery, campaignSlices);
        }
      }
      const capacityBaselineTask = readTask(args.taskId);
      baseline.stateFingerprint = campaignStateFingerprint(capacityBaselineTask);
      baseline.acceptanceFingerprint = campaignAcceptedEvidenceFingerprint(capacityBaselineTask);
      baseline.foundationState = campaignFoundationState(capacityBaselineTask);
      baseline.workerFingerprint = campaignWorkerObservation(args, summaryFn(args)).fingerprint;
      baseline.supervisor = readProgramSupervisor(capacityBaselineTask);
      wake = await waitForCampaignWake(args, slicePayload, baseline, dependencies);
    } else if (!wake.reason) {
      wake = await waitForCampaignWake(args, slicePayload, baseline, dependencies);
    }

    if (wake.stopReason) {
      if (wake.stopReason === "acceptance-complete") {
        const recovery = supervisorRecovery("none", "No further program action is required.", "director");
        return supervisorStop(args, readCoordinator(args), "acceptance-complete", recovery, campaignSlices);
      }
      if (wake.stopReason === "cancelled") {
        const currentTask = readTask(args.taskId);
        persistProgramSupervisorWake(args.taskId, {
          reason: "cancel",
          stateFingerprint: campaignStateFingerprint(currentTask),
          evidenceFingerprint: campaignAcceptedEvidenceFingerprint(currentTask),
          expectedSupervisorId: readProgramSupervisor(currentTask)?.supervisorId,
          expectedSupervisorEpoch: readProgramSupervisor(currentTask)?.supervisorEpoch,
        });
        const recovery = supervisorRecovery("user-resume", "Resume only after a new explicit user instruction.", "user");
        return supervisorStop(args, readCoordinator(args), "cancelled", recovery, campaignSlices);
      }
      const reason = ["campaign-horizon", "user-decision-required", "resource-cap-exceeded"].includes(wake.stopReason)
        ? wake.stopReason
        : "no-progress-limit";
      const recovery = reason === "user-decision-required"
        ? supervisorRecovery("user-decision", "Resume after the named decision or authorization is supplied.", "user")
        : reason === "campaign-horizon"
          ? supervisorRecovery("fresh-program-horizon", "Start a new bounded program supervisor only after an explicit continuation with a fresh resource budget.", "director")
          : reason === "resource-cap-exceeded"
            ? supervisorRecovery("fresh-resource-budget", "Start another bounded supervisor only after a fresh budget proves the recorded hard resource cap is safe.", "director")
            : supervisorRecovery("material-plan-or-evidence-change", "Reconcile the recorded blocker before any materially changed retry.", "director");
      return supervisorStop(args, readCoordinator(args), reason, recovery, campaignSlices, { blocker: wake.blocker });
    }

    let wakeResult = persistSupervisorWake(args.taskId, wake);
    if (wakeResult.supervisor?.state === "stopped") {
      const stoppedSupervisor = wakeResult.supervisor;
      const renewed = stoppedSupervisor.stopReason === "no-acceptance-progress"
        ? admitInSupervisorRecovery(args.taskId, slicePayload, stoppedSupervisor)
        : null;
      if (renewed) {
        wakeResult = {
          ...wakeResult,
          changed: true,
          supervisor: renewed,
          recoveryAdmitted: true,
        };
        material(args, readCoordinator(args), {
          type: "campaign.recovery-admitted",
          state: "running",
          summary: "The durable supervisor admitted one protected read-only reconciliation without another host invocation.",
          nextAction: "Run the admitted reconciliation once, then integrate its material decision before any retry.",
          data: {
            supervisorId: renewed.supervisorId,
            supervisorEpoch: renewed.supervisorEpoch,
            workPackageId: renewed.activeRecoveryAdmission.workPackageId,
            admissionKey: renewed.activeRecoveryAdmission.admissionKey,
          },
        });
      } else {
        const reason = stoppedSupervisor.stopReason === "program-event-cap-exceeded" ? "resource-cap-exceeded" : "no-progress-limit";
        const recovery = reason === "resource-cap-exceeded"
          ? supervisorRecovery("fresh-resource-budget", "Start another bounded supervisor only after a fresh event budget is authorized.", "director")
          : supervisorRecovery("material-plan-or-evidence-change", "Reconcile the recorded blocker before any materially changed retry.", "director");
        return supervisorStop(args, readCoordinator(args), reason, recovery, campaignSlices);
      }
    }
    if (!wakeResult.changed) {
      const recovery = supervisorRecovery("new-material-state", "Resume only after a new durable worker, dependency, capacity, or accepted-evidence fingerprint.", "coordinator");
      return supervisorStop(args, readCoordinator(args), "no-progress-limit", recovery, campaignSlices);
    }

    let latestTask = readTask(args.taskId);
    let latestSupervisor = readProgramSupervisor(latestTask);
    latestSupervisor = maybeReviseProgramSupervisorLimits(args.taskId, latestTask, slicePayload, latestSupervisor) || latestSupervisor;
    latestTask = readTask(args.taskId);
    const latestSummary = summaryFn(args);
    const remainingWork = campaignWorkRemaining(latestTask, latestSummary);
    const continuationResourceSafety = programSupervisorResourceSafety(latestTask, latestSupervisor);
    latestSupervisor = persistProgramResourceSnapshot(args.taskId, latestTask, continuationResourceSafety) || latestSupervisor;
    const continuationDrainable = continuationResourceSafety.consumptionBlocked === true
      && programHasDrainableWork(latestTask, latestSummary, continuationResourceSafety);
    if (!continuationResourceSafety.safe && !continuationResourceSafety.recoverableCapacity && !continuationDrainable) {
      const recovery = supervisorRecovery("fresh-resource-budget", "Resume only after the recorded program-wide resource blocker is corrected under a fresh bounded budget.", "director");
      return supervisorStop(args, readCoordinator(args), "resource-cap-exceeded", recovery, campaignSlices, {
        blocker: continuationResourceSafety.reason,
        result: { blocker: continuationResourceSafety.reason },
      });
    }
    const reserveSafe = true;
    const userDecisionRequired = latestSummary.execution?.userActionRequired === true;
    const acceptedContinuation = wakeResult.acceptedProgress === true
      && latestSupervisor?.state === "active"
      && remainingWork
      && !userDecisionRequired
      && reserveSafe;
    const boundedMaterialContinuation = wake.materialStateChanged === true
      && latestSupervisor?.state === "active"
      && remainingWork
      && !userDecisionRequired
      && reserveSafe;
    if (!acceptedContinuation && !boundedMaterialContinuation) {
      const recovery = supervisorRecovery("material-plan-or-evidence-change", "Reconcile the recorded blocker before any materially changed retry.", "director");
      return supervisorStop(args, readCoordinator(args), "no-progress-limit", recovery, campaignSlices);
    }

    if (readCoordinator(args)?.state === "cancel-requested") {
      persistProgramSupervisorWake(args.taskId, {
        reason: "cancel",
        stateFingerprint: campaignStateFingerprint(latestTask),
        evidenceFingerprint: campaignAcceptedEvidenceFingerprint(latestTask),
        expectedSupervisorId: latestSupervisor?.supervisorId,
        expectedSupervisorEpoch: latestSupervisor?.supervisorEpoch,
      });
      const recovery = supervisorRecovery("user-resume", "Resume only after a new explicit user instruction.", "user");
      return supervisorStop(args, readCoordinator(args), "cancelled", recovery, campaignSlices);
    }
    const next = nextCampaignSlice(args, slicePayload, latestSummary, campaignSlices);
    if (!next) {
      const currentSupervisor = readProgramSupervisor(readTask(args.taskId));
      const reason = programSupervisorExpired(currentSupervisor) ? "campaign-horizon" : readCoordinator(args)?.state === "cancel-requested" ? "cancelled" : "no-progress-limit";
      const recovery = reason === "cancelled"
        ? supervisorRecovery("user-resume", "Resume only after a new explicit user instruction.", "user")
        : reason === "campaign-horizon"
          ? supervisorRecovery("fresh-program-horizon", "Start a new bounded program supervisor only after an explicit continuation with a fresh resource budget.", "director")
          : supervisorRecovery("program-supervisor-repair", "Repair the durable supervisor state before another finite slice.", "director");
      return supervisorStop(args, readCoordinator(args), reason, recovery, campaignSlices);
    }
    slicePayload = next;
  }
}
function rawWorker(taskId, job) {
  const status = readJson(path.join(jobDirectory(taskId, job.jobId), "status.json"), {});
  return {
    jobId: job.jobId,
    projectId: job.projectId || null,
    provider: job.provider || status.provider || "",
    model: job.model || status.model || "",
    state: status.state || "unknown",
    goal: bounded(job.goal, 600),
    blocker: bounded(status.blocker, 600),
    startedAt: status.startedAt || null,
    finishedAt: status.finishedAt || null,
  };
}

function dependencyReadyNode(task) {
  const completed = new Set((task.workGraph || []).filter((node) => node.state === "completed").map((node) => node.id));
  return [...(task.workGraph || [])]
    .filter((node) => node.state === "pending" && (node.dependsOn || []).every((id) => completed.has(id)))
    .sort((left, right) => Number(right.priority || 50) - Number(left.priority || 50))[0] || null;
}

function taskMaterialView(task, workers = []) {
  const required = (task.requirements || []).filter((row) => row.required !== false);
  const blocked = required.filter((row) => row.status === "blocked").map((row) => ({ id: row.id, reason: row.blocker?.reason || row.description, owner: row.blocker?.owner || "coordinator", recoveryAction: row.blocker?.recoveryAction || "" }));
  const active = workers.filter((row) => ["queued", "running"].includes(row.state));
  const ready = dependencyReadyNode(task);
  const lastEvidence = (task.evidence || []).at(-1) || null;
  return {
    taskId: task.taskId,
    projectId: task.projectId || null,
    outcome: task.outcome,
    state: task.state,
    progress: { passing: required.filter((row) => row.status === "passing").length, required: required.length },
    workers,
    blocked,
    lastEvidence,
    next: active.length
      ? "Wait for the assigned worker state change; the coordinator owns collection and integration."
      : ready
        ? ready.goal
        : blocked[0]?.recoveryAction || "No dependency-ready unit is recorded.",
    capacitySnapshot: task.capacitySnapshot || null,
  };
}

function materialView(input) {
  if (input.portfolioId) {
    const portfolio = readPortfolio(input.portfolioId);
    const latestRef = (portfolio.rounds || []).at(-1);
    const round = latestRef ? readPortfolioRound(portfolio.portfolioId, latestRef.roundId) : null;
    const projects = (portfolio.projects || []).map((project) => {
      const task = readTask(project.taskId);
      const workers = (round?.jobs || []).filter((job) => job.taskId === task.taskId).map((job) => rawWorker(task.taskId, job));
      return taskMaterialView(task, workers);
    });
    return {
      outcome: portfolio.outcome,
      state: portfolio.state,
      progress: { completedProjects: projects.filter((project) => project.state === "completed").length, requiredProjects: projects.length },
      projects,
      blocked: projects.flatMap((project) => project.blocked.map((blocker) => ({ projectId: project.projectId, ...blocker }))),
      resources: portfolio.capacitySnapshot || null,
      next: projects.filter((project) => project.state !== "completed").sort((left, right) => {
        const leftPriority = Number(portfolio.projects.find((row) => row.taskId === left.taskId)?.priority || 50);
        const rightPriority = Number(portfolio.projects.find((row) => row.taskId === right.taskId)?.priority || 50);
        return rightPriority - leftPriority;
      })[0]?.next || "No unfinished project remains.",
    };
  }
  const task = readTask(input.taskId);
  const latestRef = (task.rounds || []).at(-1);
  const round = latestRef ? readRound(task.taskId, latestRef.roundId) : null;
  const workers = (round?.jobs || []).map((job) => rawWorker(task.taskId, job));
  const view = taskMaterialView(task, workers);
  return { ...view, resources: view.capacitySnapshot };
}

function requestCoordinatorCancel(input = {}) {
  const args = targetArgs(input);
  const current = readCoordinator(args);
  if (!current || !SUPERVISOR_ACTIVE_STATES.has(current.state)) return { requested: false, state: current?.state || "not-started" };
  const next = writeCoordinator(args, { state: "cancel-requested", cancelRequestedAt: utcNow() });
  appendMaterialEvent(args, {
    type: "coordinator.cancel-requested",
    state: "cancel-requested",
    executionId: next.executionId,
    summary: "Cancellation was requested; active finite workers are being cancelled by the task lifecycle.",
  });
  return { requested: true, executionId: next.executionId, state: next.state };
}

function coordinatorStatus(input = {}) {
  const args = targetArgs(input);
  return {
    ...args,
    execution: compactCoordinator(args),
    status: materialView(args),
    material: readMaterialEvents({ ...args, maxEvents: input.maxEvents || 8 }),
    passive: true,
    noProviderProbe: true,
    noProjectScan: true,
  };
}

module.exports = {
  compactCoordinator,
  coordinatorConfig,
  coordinatorStatus,
  materialView,
  readCoordinator,
  requestCoordinatorCancel,
  runCampaignSupervisor,
  runCoordinator,
  startCoordinator,
  waitForCapacityRecovery,
  waitForRoundTerminal,
  __test: {
    campaignFoundationState,
    campaignFoundationTransition,
    ensureProgramSupervisor,
    persistProgramSupervisorStop,
    persistProgramSupervisorWake,
    programConsumptionEnvelope,
    programRecoveryAdmission,
    programRecoveryFence,
    recoveryAdmissionLimits,
    programSupervisorResourceSafety,
  },
};
