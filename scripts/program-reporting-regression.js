#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { buildProgramReport, reportTransition } = require("./core/program-reporting-v3");

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

const base = {
  outcome: "Produce verified outcome evidence",
  state: "active",
  requirements: [
    {
      id: "REQ-001",
      required: true,
      status: "passing",
      evidence: [
        { level: "end-to-end", ref: "receipt-1", summary: "Verified externally" },
        { level: "activity", ref: "worker-running", accepted: true, passed: true, summary: "Activity is not evidence." },
        { level: "process-health", ref: "service-running", accepted: true, passed: true, summary: "Process health is not outcome evidence." },
        { level: "integration", ref: "rejected-proof", accepted: false, passed: true, summary: "Explicitly rejected evidence." },
      ],
    },
    {
      id: "REQ-002",
      required: true,
      status: "blocked",
      evidence: [],
      blocker: { owner: "runtime", reason: "Invariant failed", recoveryAction: "Repair and verify" },
    },
  ],
  program: {
    mission: { missionId: "mission-reporting", outcome: "Produce verified outcome evidence", state: "active" },
    evidenceLedger: {
      entries: [{ requirementId: "REQ-002", level: "activity", ref: "worker-started", summary: "Not outcome evidence" }],
    },
    workPackages: [],
    runtime: {
      budget: {
        budgetRevision: 1,
        allocations: [],
        reserves: { emergencyTokens: 100 },
        limits: { maxTokens: 10000 },
        deferred: [],
      },
    },
    nextAction: "Repair the failed invariant",
  },
};

const initial = buildProgramReport(base, { coordinator: { state: "running", executionId: "execution-1" }, events: [], generatedAt: "2026-07-21T00:00:00Z" });
assert.equal(initial.progress.passing, 1);
assert.equal(initial.progress.required, 2);
assert.equal(initial.acceptedEvidence.length, 1);
assert.equal(initial.acceptedEvidence[0].passed, true);
assert.equal(initial.acceptedEvidence.some((row) => row.level === "activity"), false);
assert.equal(initial.acceptedEvidence.some((row) => row.level === "process-health"), false);
let transition = reportTransition({}, initial);
assert.equal(transition.emit, true);
assert.equal(transition.reason, "initial");
const processHealthOnlyTask = clone(base);
processHealthOnlyTask.requirements[0].evidence.push({ level: "process-health", ref: "another-healthy-process", accepted: true, passed: true });
const processHealthOnly = buildProgramReport(processHealthOnlyTask, { coordinator: { state: "running", executionId: "execution-1" }, events: [], generatedAt: "2026-07-21T00:00:01Z" });
assert.equal(processHealthOnly.acceptedEvidence.some((row) => row.level === "process-health"), false);
assert.equal(processHealthOnly.fingerprint, initial.fingerprint, "Process-health evidence must not change the outcome report fingerprint.");
assert.equal(reportTransition(transition.cursor, processHealthOnly).emit, false);

const ledgerOnlyTask = clone(base);
ledgerOnlyTask.requirements = ledgerOnlyTask.requirements.map((row) => ({ ...row, status: "blocked", evidence: [] }));
ledgerOnlyTask.program.evidenceLedger.entries = [
  { requirementId: "REQ-001", level: "activity", ref: "worker-launched", accepted: true, passed: true },
  { requirementId: "REQ-001", level: "process-health", ref: "service-healthy", accepted: true, passed: true },
  { requirementId: "REQ-001", level: "focused-test", ref: "accepted-but-not-passing", accepted: true, passed: false },
  { requirementId: "REQ-001", level: "integration", ref: "passing-but-rejected", accepted: false, passed: true },
  { requirementId: "REQ-001", level: "end-to-end", ref: "accepted-and-passing", accepted: true, passed: true },
];
const ledgerOnly = buildProgramReport(ledgerOnlyTask, { coordinator: { state: "running", executionId: "execution-ledger" }, events: [] });
assert.deepEqual(ledgerOnly.acceptedEvidence.map((row) => row.ref), ["accepted-and-passing"]);
assert.equal(ledgerOnly.acceptedEvidence.every((row) => row.accepted && row.passed && !["activity", "process-health"].includes(row.level)), true);

const activityOnlyTask = clone(base);
const activeAllocation = {
  allocationId: "allocation-context-1",
  workPackageId: "context-1",
  provider: "claude",
  model: "sonnet",
};
const completedAllocation = {
  allocationId: "allocation-completed-1",
  workPackageId: "completed-1",
  provider: "codex",
  model: "gpt-5.6-sol",
};
activityOnlyTask.program.workPackages.push({
  workPackageId: "context-1",
  executorKind: "context-scout",
  deliverableKind: "context-dossier",
  state: "running",
  jobId: "job-context-1",
  allocation: activeAllocation,
});
activityOnlyTask.program.workPackages.push({
  workPackageId: "completed-1",
  executorKind: "verification",
  deliverableKind: "verification-result",
  state: "completed",
  jobId: "job-completed-1",
  allocation: completedAllocation,
});
activityOnlyTask.program.runtime = {
  budget: {
    budgetRevision: 1,
    allocations: [activeAllocation, completedAllocation],
    reserves: { emergencyTokens: 100 },
    limits: { maxTokens: 10000 },
    deferred: [],
  },
};
activityOnlyTask.program.executionReceipts = [{
  receiptId: "receipt-completed-1",
  workPackageId: "completed-1",
  state: "succeeded",
  provider: "codex",
  model: "gpt-5.6-sol",
}];
const assignmentEvent = {
  eventId: "event-assignment-1",
  fingerprint: "fingerprint-assignment-1",
  type: "round.dispatched",
  state: "running",
  summary: "Assigned one dependency-ready worker.",
  at: "2026-07-21T00:00:30Z",
};
const runningRuntime = {
  coordinator: { state: "running", executionId: "execution-2", roundsStarted: 1 },
  events: [assignmentEvent],
  jobStates: {
    "job-context-1": { state: "running" },
    "job-completed-1": { state: "completed" },
  },
};
const activityOnly = buildProgramReport(activityOnlyTask, { ...runningRuntime, generatedAt: "2026-07-21T00:01:00Z" });
assert.notEqual(activityOnly.fingerprint, initial.fingerprint);
const activityTransition = reportTransition(transition.cursor, activityOnly);
assert.equal(activityTransition.emit, true, "A worker assignment is material even though it is not outcome progress.");
assert.equal(activityTransition.reason, "active-work");
assert.equal(activityTransition.report.delta.outcomeProgress, false);
assert.equal(activityOnly.progress.passing, initial.progress.passing);
assert.equal(activityOnly.acceptedEvidence.length, initial.acceptedEvidence.length);
assert.equal(activityOnly.budget.activeAllocations, 1, "Active allocations must come from the running work package or job.");
assert.equal(activityOnly.budget.completedAllocations, 1, "Successful receipts must come from program.executionReceipts.");
assert.equal(activityOnly.budget.allocationStates.find((row) => row.workPackageId === "context-1").workPackageState, "running");
assert.equal(activityOnly.sections.outcomeEvidence.acceptedEvidence.length, 1);
assert.equal(activityOnly.sections.activeWorkResources.activePackages.length, 1);
assert.equal(activityOnly.sections.activeWorkResources.activeAssignments.length, 1);
assert.equal(activityOnly.sections.blocker.active, true);
assert.equal(activityOnly.sections.recovery.required, true);
assert.equal(activityOnly.sections.nextOwnedAction.owner, "coordinator");

const unchangedActivity = buildProgramReport(activityOnlyTask, { ...runningRuntime, generatedAt: "2026-07-21T00:01:30Z" });
assert.equal(reportTransition(activityTransition.cursor, unchangedActivity).emit, false, "Generated-at changes must not defeat snapshot deduplication.");

const resourceTask = clone(activityOnlyTask);
resourceTask.program.runtime.budget.reserves.emergencyTokens = 200;
const resourceReport = buildProgramReport(resourceTask, { ...runningRuntime, generatedAt: "2026-07-21T00:01:31Z" });
const resourceTransition = reportTransition(activityTransition.cursor, resourceReport);
assert.equal(resourceTransition.emit, true);
assert.equal(resourceTransition.reason, "resource-change");
assert.equal(resourceTransition.report.delta.outcomeProgress, false);

const nextActionTask = clone(activityOnlyTask);
nextActionTask.program.nextAction = "Integrate the completed context dossier exactly once.";
const nextActionReport = buildProgramReport(nextActionTask, { ...runningRuntime, generatedAt: "2026-07-21T00:01:32Z" });
const nextActionTransition = reportTransition(activityTransition.cursor, nextActionReport);
assert.equal(nextActionTransition.emit, true);
assert.equal(nextActionTransition.reason, "next-action");
assert.equal(nextActionTransition.report.delta.outcomeProgress, false);
assert.match(nextActionReport.sections.nextOwnedAction.action, /Integrate the completed context dossier/);

const campaignTask = clone(activityOnlyTask);
campaignTask.program.activeCampaign = { campaignId: "campaign-reporting", epoch: 1, state: "active" };
const campaignActive = buildProgramReport(campaignTask, { ...runningRuntime, generatedAt: "2026-07-21T00:01:33Z" });
const campaignStarted = reportTransition(activityTransition.cursor, campaignActive);
assert.equal(campaignStarted.emit, true);
assert.equal(campaignStarted.reason, "campaign-transition");
assert.equal(campaignStarted.report.delta.outcomeProgress, false);

const supervisorLimitSource = {
  kind: "accepted-resource-budget",
  budgetId: "budget-reporting-2",
  revision: 2,
  fingerprint: "budget-fingerprint-2",
  planId: "plan-reporting",
  planRevision: 3,
  inventoryFingerprint: "inventory-reporting",
  forecastFingerprint: "forecast-reporting",
  reserves: { emergencyTokens: 100 },
};
const supervisorLimitBaseline = {
  sourceBudgetId: "budget-reporting-2",
  sourceBudgetRevision: 2,
  sourceBudgetFingerprint: "budget-fingerprint-2",
  resourceSnapshotFingerprint: "resource-snapshot-baseline",
  fundedAllocationIds: ["allocation-context-1", "allocation-completed-1"],
  historicalCommitted: { tokens: 400, durationMs: 1000, attempts: 1 },
  historicalExposure: { tokens: 500, durationMs: 2000, attempts: 1 },
  fundedExposure: { tokens: 2400, durationMs: 13000, attempts: 3 },
  acceptedRemainingBudget: { tokens: 2500, durationMs: 18000, attempts: 9 },
  derivedCumulativeCeiling: { tokens: 3000, durationMs: 20000, attempts: 10 },
  recordedAt: "2026-07-21T00:00:01Z",
};


const supervisorTask = clone(campaignTask);
supervisorTask.program.runtime.programSupervisor = {
  schemaVersion: 1,
  supervisorId: "program-supervisor-reporting",
  missionId: "mission-reporting",
  state: "waiting",
  startedAt: "2026-07-21T00:00:00Z",
  deadlineAt: "2026-07-23T00:00:00Z",
  horizonHours: 48,
  limits: {
    noProgressLimit: 3,
    maxEvents: 500,
    maxTokens: 3000,
    maxDurationMs: 20000,
    maxAttempts: 10,
    maxArtifacts: 100,
    maxArtifactBytes: 104857600,
    maxWorkers: 2,
    maxGlobalWorkers: 4,
    maxCampaigns: 20,
  },
  limitRevision: 2,
  limitSource: supervisorLimitSource,
  limitBaseline: supervisorLimitBaseline,
  limitHistory: [{
    at: "2026-07-21T00:00:02Z",
    sourceBudgetId: "budget-reporting-2",
    sourceBudgetRevision: 2,
    sourceBudgetFingerprint: "budget-fingerprint-2",
    sourcePlanId: "plan-reporting",
    sourcePlanRevision: 3,
    priorLimits: { maxTokens: 2000, maxDurationMs: 15000, maxAttempts: 8 },
    newLimits: { maxTokens: 3000, maxDurationMs: 20000, maxAttempts: 10 },
    baseline: supervisorLimitBaseline,
    reason: "accepted-plan-resource-budget-revision",
  }],
  cadence: { backoffMs: 5000, maxBackoffMs: 60000 },
  noProgressCount: 1,
  wakeCount: 4,
  wakeCursor: "wake-cursor-4",
  wakeHistory: [],
  lastAcceptanceFingerprint: "accepted-evidence-1",
  foundationTransitions: [],
  campaignIds: ["campaign-reporting"],
  campaignCount: 2,
  resourceSnapshot: {
    schemaVersion: "director-cfo/program-resource-snapshot@1",
    fingerprint: "resource-snapshot-1",
    safe: false,
    recoverableCapacity: true,
    campaignCount: 2,
    totals: {
      attempts: { known: 3, committed: 3, complete: true },
      tokens: { known: 200, committed: 1600, complete: false, committedComplete: true },
      durationMs: { known: 1000, committed: 13000, complete: false, committedComplete: true },
      artifacts: { known: 4, committed: 4, complete: true },
      durableBytes: { known: 3638, committed: 3638, complete: true },
      durableFiles: { known: 8, committed: 8, complete: true },
    },
    authorization: {
      totals: { tokens: 2400, durationMs: 13000, attempts: 3 },
      complete: true,
    },
    concurrency: {
      programActive: 1,
      globalActive: 2,
      byProvider: { antigravity: 1 },
      activeJobIds: ["job-context-1"],
    },
    quota: {
      providerBlockers: [{
        code: "quota-capacity-unknown",
        provider: "antigravity",
        poolKey: "ag-primary",
        hard: true,
        reason: "Live provider quota is unavailable.",
      }],
    },
    blockers: [{
      code: "quota-capacity-unknown",
      provider: "antigravity",
      poolKey: "ag-primary",
      metric: "quota",
      hard: true,
      reason: "Live provider quota is unavailable.",
    }],
    capCheck: {
      safe: true,
      blockers: [],
    },
  },
  nextWakeAt: "2026-07-21T00:05:00Z",
  recovery: {
    owner: "director",
    trigger: "campaign-material-state-change",
    action: "Start the next finite campaign slice after the persisted wake.",
    recordedAt: "2026-07-21T00:01:33Z",
  },
  stopReason: "",
  finishedAt: null,
  updatedAt: "2026-07-21T00:01:33Z",
};
const supervisorReport = buildProgramReport(supervisorTask, { ...runningRuntime, generatedAt: "2026-07-21T00:01:33Z" });
const supervisorTransition = reportTransition(campaignStarted.cursor, supervisorReport);
assert.equal(supervisorTransition.emit, true);
assert.equal(supervisorTransition.reason, "program-supervisor-transition");
assert.equal(supervisorTransition.report.delta.outcomeProgress, false);
assert.equal(supervisorTransition.report.delta.changedScopes.includes("outcome"), false);
assert.equal(supervisorReport.progress.passing, campaignActive.progress.passing);
assert.deepEqual(supervisorReport.acceptedEvidence, campaignActive.acceptedEvidence);
assert.equal(supervisorReport.programSupervisor.state, "waiting");
assert.deepEqual(supervisorReport.programSupervisor.overallHorizon, {
  startedAt: "2026-07-21T00:00:00Z",
  deadlineAt: "2026-07-23T00:00:00Z",
  hours: 48,
});
assert.equal(supervisorReport.programSupervisor.noProgressCount, 1);
assert.equal(supervisorReport.programSupervisor.noProgressLimit, 3);
assert.equal(supervisorReport.programSupervisor.currentEpoch, 1);
assert.equal(supervisorReport.programSupervisor.activeCampaignId, "campaign-reporting");
assert.equal(supervisorReport.programSupervisor.nextWakeAt, "2026-07-21T00:05:00Z");
assert.equal(supervisorReport.programSupervisor.recoveryOwner, "director");
assert.equal(supervisorReport.programSupervisor.campaignCount, 2);
assert.deepEqual(supervisorReport.programSupervisor.limits, {
  noProgressLimit: 3,
  maxEvents: 500,
  maxTokens: 3000,
  maxDurationMs: 20000,
  maxAttempts: 10,
  maxArtifacts: 100,
  maxArtifactBytes: 104857600,
  maxWorkers: 2,
  maxGlobalWorkers: 4,
  maxCampaigns: 20,
});
assert.equal(supervisorReport.programSupervisor.limitRevision, 2);
assert.deepEqual(supervisorReport.programSupervisor.limitSource, supervisorLimitSource);
assert.deepEqual(supervisorReport.programSupervisor.limitBaseline, {
  sourceBudgetId: "budget-reporting-2",
  sourceBudgetRevision: 2,
  sourceBudgetFingerprint: "budget-fingerprint-2",
  resourceSnapshotFingerprint: "resource-snapshot-baseline",
  fundedAllocationCount: 2,
  fundedAllocationIds: ["allocation-context-1", "allocation-completed-1"],
  historicalCommitted: { tokens: 400, durationMs: 1000, attempts: 1 },
  historicalExposure: { tokens: 500, durationMs: 2000, attempts: 1 },
  fundedExposure: { tokens: 2400, durationMs: 13000, attempts: 3 },
  acceptedRemainingBudget: { tokens: 2500, durationMs: 18000, attempts: 9 },
  derivedCumulativeCeiling: { tokens: 3000, durationMs: 20000, attempts: 10 },
  recordedAt: "2026-07-21T00:00:01Z",
});
assert.deepEqual(supervisorReport.programSupervisor.latestLimitHistory, {
  at: "2026-07-21T00:00:02Z",
  sourceBudgetId: "budget-reporting-2",
  sourceBudgetRevision: 2,
  sourceBudgetFingerprint: "budget-fingerprint-2",
  sourcePlanId: "plan-reporting",
  sourcePlanRevision: 3,
  priorLimits: { maxTokens: 2000, maxDurationMs: 15000, maxAttempts: 8 },
  newLimits: { maxTokens: 3000, maxDurationMs: 20000, maxAttempts: 10 },
  baseline: supervisorReport.programSupervisor.limitBaseline,
  reason: "accepted-plan-resource-budget-revision",
});
const recoverableSnapshot = supervisorReport.programSupervisor.resourceSnapshot;
assert.equal(recoverableSnapshot.state, "recoverable-quota-wait");
assert.match(recoverableSnapshot.summary, /temporarily unavailable/);
assert.equal(recoverableSnapshot.safe, false);
assert.equal(recoverableSnapshot.recoverableCapacity, true);
assert.equal(recoverableSnapshot.fingerprint, "resource-snapshot-1");
assert.equal(recoverableSnapshot.campaignCount, 2);
assert.deepEqual(recoverableSnapshot.totals, {
  attempts: { known: 3, committed: 3 },
  tokens: { known: 200, committed: 1600 },
  durationMs: { known: 1000, committed: 13000 },
  artifacts: { known: 4, committed: 4 },
  durableBytes: { known: 3638, committed: 3638 },
  durableFiles: { known: 8, committed: 8 },
});
assert.deepEqual(recoverableSnapshot.authorization, {
  totals: { tokens: 2400, durationMs: 13000, attempts: 3 },
  complete: true,
});
assert.deepEqual(recoverableSnapshot.concurrency, { programActive: 1, globalActive: 2, byProvider: { antigravity: 1 } });
assert.equal(recoverableSnapshot.quotaBlockers.length, 1);
assert.equal(recoverableSnapshot.quotaBlockers[0].code, "quota-capacity-unknown");
assert.equal(recoverableSnapshot.quotaBlockers[0].hard, true);
assert.deepEqual(recoverableSnapshot.accountingBlockers, [], "Recoverable quota must not also appear as generic accounting failure.");
assert.deepEqual(recoverableSnapshot.capBlockers, []);
assert.deepEqual(supervisorReport.sections.programSupervisor, supervisorReport.programSupervisor);

const unchangedSupervisor = buildProgramReport(supervisorTask, { ...runningRuntime, generatedAt: "2026-07-21T00:01:34Z" });
assert.equal(reportTransition(supervisorTransition.cursor, unchangedSupervisor).emit, false);
const resourceSnapshotTask = clone(supervisorTask);
const hardCapSource = resourceSnapshotTask.program.runtime.programSupervisor.resourceSnapshot;
hardCapSource.fingerprint = "resource-snapshot-2";
hardCapSource.recoverableCapacity = false;
hardCapSource.totals.tokens.known = 300;
hardCapSource.totals.tokens.committed = 3100;
hardCapSource.authorization.totals.tokens = 3100;
hardCapSource.concurrency.programActive = 2;
hardCapSource.blockers.push({
  code: "program-allocation-authorization-incomplete",
  jobId: "job-context-1",
  allocationId: "allocation-context-1",
  metric: "allocation",
  reason: "Immutable allocation authorization is incomplete.",
});
hardCapSource.capCheck = {
  safe: false,
  blockers: [{
    code: "program-token-cap-exceeded",
    metric: "tokens",
    committed: 3100,
    limit: 3000,
    reason: "tokens 3100 exceeds program cap 3000",
  }],
};
const resourceSnapshotReport = buildProgramReport(resourceSnapshotTask, { ...runningRuntime, generatedAt: "2026-07-21T00:01:34Z" });
const resourceSnapshotTransition = reportTransition(supervisorTransition.cursor, resourceSnapshotReport);
assert.equal(resourceSnapshotTransition.emit, true, "A durable CFO resource snapshot change must be reported.");
assert.equal(resourceSnapshotTransition.reason, "resource-change");
assert.equal(resourceSnapshotTransition.report.delta.outcomeProgress, false);
assert.deepEqual(resourceSnapshotTransition.report.delta.changedScopes, ["resources"]);
assert.equal(resourceSnapshotReport.progress.passing, supervisorReport.progress.passing);
assert.deepEqual(resourceSnapshotReport.acceptedEvidence, supervisorReport.acceptedEvidence);
const hardCapSnapshot = resourceSnapshotReport.programSupervisor.resourceSnapshot;
assert.equal(hardCapSnapshot.state, "hard-cap-breach");
assert.match(hardCapSnapshot.summary, /cap was exceeded/);
assert.equal(hardCapSnapshot.recoverableCapacity, false);
assert.equal(hardCapSnapshot.totals.tokens.known, 300);
assert.equal(hardCapSnapshot.totals.tokens.committed, 3100);
assert.equal(hardCapSnapshot.accountingBlockers.length, 1);
assert.equal(hardCapSnapshot.accountingBlockers[0].code, "program-allocation-authorization-incomplete");
assert.equal(hardCapSnapshot.capBlockers.length, 1);
assert.equal(hardCapSnapshot.capBlockers[0].code, "program-token-cap-exceeded");

const exhaustedSnapshotTask = clone(supervisorTask);
const exhaustedSource = exhaustedSnapshotTask.program.runtime.programSupervisor.resourceSnapshot;
exhaustedSource.fingerprint = "resource-snapshot-exhausted";
exhaustedSource.safe = true;
exhaustedSource.recoverableCapacity = false;
exhaustedSource.consumptionExhausted = true;
exhaustedSource.totals.tokens.committed = 3000;
exhaustedSource.authorization.totals.tokens = 3000;
exhaustedSource.quota.providerBlockers = [];
exhaustedSource.blockers = [];
exhaustedSource.capCheck = {
  safe: true,
  blockers: [],
  exhausted: [{
    code: "program-token-cap-exhausted",
    metric: "tokens",
    committed: 3000,
    limit: 3000,
    reason: "tokens 3000 has exhausted program cap 3000; no new consumption is authorized",
  }],
};
const exhaustedReport = buildProgramReport(exhaustedSnapshotTask, { ...runningRuntime, generatedAt: "2026-07-21T00:01:34Z" });
const exhaustedTransition = reportTransition(supervisorTransition.cursor, exhaustedReport);
const exhaustedSnapshot = exhaustedReport.programSupervisor.resourceSnapshot;
assert.equal(exhaustedTransition.reason, "resource-change");
assert.equal(exhaustedTransition.report.delta.outcomeProgress, false);
assert.deepEqual(exhaustedTransition.report.delta.changedScopes, ["resources"]);
assert.equal(exhaustedSnapshot.state, "at-limit-drain-only");
assert.equal(exhaustedSnapshot.safe, true);
assert.equal(exhaustedSnapshot.newConsumptionAuthorized, false);
assert.equal(exhaustedSnapshot.consumptionExhausted, true);
assert.equal(exhaustedSnapshot.recoverableCapacity, false);
assert.equal(exhaustedSnapshot.capBlockers.length, 0);
assert.equal(exhaustedSnapshot.exhaustedBlockers.length, 1);
assert.equal(exhaustedSnapshot.exhaustedBlockers[0].code, "program-token-cap-exhausted");
assert.match(exhaustedSnapshot.summary, /only already-running work may drain/);


const limitRevisionTask = clone(supervisorTask);
limitRevisionTask.program.runtime.programSupervisor.limitRevision = 3;
limitRevisionTask.program.runtime.programSupervisor.limits.maxTokens = 3500;
const limitRevisionReport = buildProgramReport(limitRevisionTask, { ...runningRuntime, generatedAt: "2026-07-21T00:01:34Z" });
const limitRevisionTransition = reportTransition(supervisorTransition.cursor, limitRevisionReport);
assert.equal(limitRevisionTransition.emit, true);
assert.equal(limitRevisionTransition.reason, "program-supervisor-transition");
assert.equal(limitRevisionTransition.report.delta.outcomeProgress, false);
assert.deepEqual(limitRevisionTransition.report.delta.changedScopes, ["supervisor"]);
assert.equal(limitRevisionReport.progress.passing, supervisorReport.progress.passing);


const supervisorAdvancedTask = clone(supervisorTask);
supervisorAdvancedTask.program.runtime.programSupervisor.noProgressCount = 2;
supervisorAdvancedTask.program.runtime.programSupervisor.wakeCount = 5;
supervisorAdvancedTask.program.runtime.programSupervisor.nextWakeAt = "2026-07-21T00:10:00Z";
const supervisorAdvanced = buildProgramReport(supervisorAdvancedTask, { ...runningRuntime, generatedAt: "2026-07-21T00:01:35Z" });
const supervisorAdvancedTransition = reportTransition(supervisorTransition.cursor, supervisorAdvanced);
assert.equal(supervisorAdvancedTransition.reason, "program-supervisor-transition");
assert.equal(supervisorAdvancedTransition.report.delta.outcomeProgress, false);
assert.equal(supervisorAdvanced.progress.passing, supervisorReport.progress.passing);

const finiteSliceBoundary = buildProgramReport(supervisorAdvancedTask, {
  coordinator: { state: "stopped", executionId: "execution-2", stopReason: "campaign-slice-boundary", roundsStarted: 2 },
  events: [{ type: "coordinator.stopped", state: "stopped", summary: "The program supervisor owns the next wake." }],
  jobStates: runningRuntime.jobStates,
  generatedAt: "2026-07-21T00:01:36Z",
});
assert.equal(finiteSliceBoundary.blockers.some((row) => row.eventType === "coordinator.stopped"), false);

const supervisorStoppedTask = clone(supervisorAdvancedTask);
supervisorStoppedTask.program.runtime.programSupervisor.state = "stopped";
supervisorStoppedTask.program.runtime.programSupervisor.noProgressCount = 3;
supervisorStoppedTask.program.runtime.programSupervisor.nextWakeAt = null;
supervisorStoppedTask.program.runtime.programSupervisor.stopReason = "no-acceptance-progress";
supervisorStoppedTask.program.runtime.programSupervisor.recovery = {
  owner: "director",
  trigger: "material-plan-or-evidence-change",
  action: "Reconcile the blocker before starting a materially changed program epoch.",
};
const supervisorStopped = buildProgramReport(supervisorStoppedTask, {
  coordinator: { state: "stopped", executionId: "execution-2", stopReason: "campaign-slice-boundary", roundsStarted: 2 },
  events: [],
  jobStates: runningRuntime.jobStates,
  generatedAt: "2026-07-21T00:01:37Z",
});
const supervisorStoppedTransition = reportTransition(supervisorAdvancedTransition.cursor, supervisorStopped);
assert.equal(supervisorStoppedTransition.reason, "program-supervisor-transition");
assert.equal(supervisorStoppedTransition.report.delta.outcomeProgress, false);
assert.equal(supervisorStopped.blockers.some((row) => row.eventType === "program-supervisor.stopped"), true);
assert.equal(supervisorStopped.sections.nextOwnedAction.owner, "director");
assert.match(supervisorStopped.sections.nextOwnedAction.action, /Reconcile the blocker/);
campaignTask.program.activeCampaign.state = "completed";
campaignTask.program.activeCampaign.stopReason = "milestone-complete";
const campaignCompleted = buildProgramReport(campaignTask, { ...runningRuntime, generatedAt: "2026-07-21T00:01:34Z" });
assert.equal(reportTransition(campaignStarted.cursor, campaignCompleted).reason, "campaign-transition");

const collectedEvent = {
  eventId: "event-collected-1",
  fingerprint: "fingerprint-collected-1",
  type: "round.collected",
  state: "ready-for-integration",
  summary: "Collected one terminal worker result.",
  at: "2026-07-21T00:01:35Z",
};
const materialReport = buildProgramReport(activityOnlyTask, {
  ...runningRuntime,
  events: [collectedEvent],
  generatedAt: "2026-07-21T00:01:36Z",
});
const materialTransition = reportTransition(activityTransition.cursor, materialReport);
assert.equal(materialTransition.emit, true);
assert.equal(materialTransition.reason, "material-event");
assert.equal(materialTransition.report.delta.outcomeProgress, false);
assert.equal(materialReport.latestMaterialEvent.eventId, "event-collected-1");
const unchangedMaterial = buildProgramReport(activityOnlyTask, {
  ...runningRuntime,
  events: [collectedEvent],
  generatedAt: "2026-07-21T00:01:37Z",
});
assert.equal(reportTransition(materialTransition.cursor, unchangedMaterial).emit, false);

transition = activityTransition;

const foundationTask = clone(activityOnlyTask);
foundationTask.program.contextDossier = { contextRevision: 1, contextFingerprint: "context-fingerprint" };
const foundation = buildProgramReport(foundationTask, { ...runningRuntime, generatedAt: "2026-07-21T00:02:00Z" });
transition = reportTransition(transition.cursor, foundation);
assert.equal(transition.emit, true);
assert.equal(transition.reason, "foundation-progress");

const outcomeTask = clone(foundationTask);
outcomeTask.requirements[1] = {
  id: "REQ-002",
  required: true,
  status: "passing",
  evidence: [{ level: "integration", ref: "receipt-2", summary: "Invariant verified" }],
};
const outcome = buildProgramReport(outcomeTask, { ...runningRuntime, generatedAt: "2026-07-21T00:03:00Z" });
transition = reportTransition(transition.cursor, outcome);
assert.equal(transition.emit, true);
assert.equal(transition.reason, "outcome-progress");
assert.equal(outcome.progress.passing, 2);
const resolvedEventTask = clone(outcomeTask);
resolvedEventTask.program.workPackages = [];
const resolvedByLaterEvent = buildProgramReport(resolvedEventTask, {
  coordinator: { state: "running", executionId: "execution-resolution" },
  events: [
    {
      eventId: "event-old-job-failure",
      type: "round.integrated",
      state: "needs-correction",
      jobId: "job-resolved-later",
      blocker: "old-job-failure",
      nextAction: "Retry the old job.",
    },
    {
      eventId: "event-job-success",
      type: "job.completed",
      state: "completed",
      jobId: "job-resolved-later",
      summary: "The same job completed successfully.",
    },
  ],
  jobStates: {},
  generatedAt: "2026-07-21T00:03:10Z",
});
assert.equal(resolvedByLaterEvent.blockers.some((row) => row.reason === "old-job-failure"), false);

const durableResolutionTask = clone(outcomeTask);
durableResolutionTask.program.workPackages = [{
  workPackageId: "package-durably-resolved",
  roundId: "round-durably-resolved",
  owner: "verification-owner",
  executorKind: "verification",
  state: "completed",
  jobId: "job-durably-resolved",
}];
const resolvedByDurableState = buildProgramReport(durableResolutionTask, {
  coordinator: { state: "running", executionId: "execution-durable-resolution" },
  events: [{
    eventId: "event-old-package-failure",
    type: "round.integrated",
    state: "needs-correction",
    roundId: "round-durably-resolved",
    workPackageId: "package-durably-resolved",
    blocker: "old-package-failure",
  }],
  jobStates: { "job-durably-resolved": { state: "completed" } },
  generatedAt: "2026-07-21T00:03:11Z",
});
assert.equal(resolvedByDurableState.blockers.some((row) => row.reason === "old-package-failure"), false);
assert.equal(resolvedByDurableState.workPackages[0].roundId, "round-durably-resolved");
assert.equal(resolvedByDurableState.workPackages[0].owner, "verification-owner");

const resolvedByOwner = buildProgramReport(resolvedEventTask, {
  coordinator: { state: "running", executionId: "execution-owner-resolution" },
  events: [
    {
      eventId: "event-old-owner-failure",
      type: "round.integrated",
      state: "needs-correction",
      owner: "reconciliation-owner",
      blocker: "old-owner-failure",
    },
    {
      eventId: "event-owner-resolution",
      type: "reconciliation.resolved",
      state: "resolved",
      owner: "reconciliation-owner",
      summary: "The same owner resolved the recorded failure.",
    },
  ],
  jobStates: {},
  generatedAt: "2026-07-21T00:03:12Z",
});
assert.equal(resolvedByOwner.blockers.some((row) => row.reason === "old-owner-failure"), false);

const unrelatedSuccess = buildProgramReport(resolvedEventTask, {
  coordinator: { state: "running", executionId: "execution-unrelated-success" },
  events: [
    {
      eventId: "event-unresolved-job-failure",
      type: "round.integrated",
      state: "needs-correction",
      jobId: "job-still-failed",
      blocker: "unresolved-job-failure",
    },
    {
      eventId: "event-other-job-success",
      type: "job.completed",
      state: "completed",
      jobId: "job-unrelated-success",
    },
  ],
  jobStates: {},
  generatedAt: "2026-07-21T00:03:13Z",
});
assert.equal(unrelatedSuccess.blockers.some((row) => row.reason === "unresolved-job-failure"), true);



const stopped = buildProgramReport(outcomeTask, {
  coordinator: { state: "stopped", executionId: "execution-2", stopReason: "no-dependency-ready-unit", roundsStarted: 2 },
  events: [
    { type: "round.integrated", state: "needs-correction", blocker: "director-revision-fence-missing", nextAction: "Repair the pre-plan reconciliation fence" },
    { type: "coordinator.stopped", state: "stopped", blocker: "no-dependency-ready-unit", nextAction: "Resume after the Director invariant changes" },
  ],
  generatedAt: "2026-07-21T00:04:00Z",
});
transition = reportTransition(transition.cursor, stopped);
assert.equal(transition.emit, true);
assert.equal(transition.reason, "actionable-blocker");
assert.equal(stopped.blockers.some((row) => row.reason === "director-revision-fence-missing"), true);
assert.equal(stopped.coordinator.stopReason, "no-dependency-ready-unit");
assert.match(stopped.nextAction, /Resume after|Repair the pre-plan/);

const syntheticTask = clone(base);
syntheticTask.taskId = "task-synthetic-not-durable";
assert.doesNotThrow(() => buildProgramReport(syntheticTask), "Synthetic fixture task IDs must not require durable coordinator/event state.");

const staleOwnershipTask = clone(outcomeTask);
staleOwnershipTask.program.workPackages = [{
  workPackageId: "reconcile-stale-owner",
  executorKind: "reconciliation",
  deliverableKind: "reconciliation-decision",
  state: "running",
  jobId: "job-terminal-result",
  allocation: { provider: "claude", model: "fable-5" },
  lastFailure: { blocker: "director-revision-fence-missing" },
}];
const staleOwnership = buildProgramReport(staleOwnershipTask, {
  coordinator: { state: "stopped", executionId: "execution-stale", stopReason: "no-dependency-ready-unit" },
  events: [
    { type: "round.integrated", blocker: "director-revision-fence-missing", nextAction: "Wait for material worker terminals." },
    { type: "coordinator.stopped", nextAction: "Wait for material worker terminals." },
  ],
  jobStates: {
    "job-terminal-result": { state: "completed", provider: "claude", model: "fable-5" },
  },
  generatedAt: "2026-07-21T00:05:00Z",
});
const stalePackage = staleOwnership.workPackages.find((row) => row.workPackageId === "reconcile-stale-owner");
assert.equal(stalePackage.recordedState, "running");
assert.equal(stalePackage.state, "blocked");
assert.equal(stalePackage.jobState, "completed");
assert.equal(stalePackage.staleOwnership, true);
assert.equal(staleOwnership.blockers.length, 1);
assert.equal(staleOwnership.blockers[0].eventType, "package.stale-ownership");
assert.doesNotMatch(staleOwnership.blockers[0].reason, /revision-fence-missing/i);
assert.doesNotMatch(staleOwnership.nextAction, /Wait for material worker/i);
assert.match(staleOwnership.nextAction, /Integrate or reconcile the terminal worker result exactly once/i);

process.stdout.write(JSON.stringify({
  ok: true,
  acceptedEvidence: initial.acceptedEvidence.length,
  activitySuppressed: true,
  assignmentReportedWithoutOutcomeProgress: true,
  resourceTransitionReported: true,
  nextActionTransitionReported: true,
  campaignTransitionReported: true,
  materialEventReported: true,
  programSupervisorReported: true,
  programResourceSnapshotReported: true,
  resourceSnapshotActivityNotOutcomeProgress: true,
  cumulativeProgramLimitsReported: true,
  limitRevisionActivityNotOutcomeProgress: true,
  recoverableQuotaWaitDistinguished: true,
  hardCapBreachDistinguished: true,
  accountingBlockersReported: true,
  capExhaustionDrainOnlyReported: true,
  resolvedFailureEventsSuppressed: true,
  durableResolutionSuppressesOldFailure: true,
  ownerResolutionSuppressesOldFailure: true,
  unrelatedSuccessDoesNotSuppressFailure: true,
  supervisorActivityNotOutcomeProgress: true,
  finiteSliceBoundaryNotProgramBlocker: true,
  supervisorStopRecoveryReported: true,
  unchangedSnapshotDeduplicated: true,
  actualReceiptsReported: true,
  foundationReported: true,
  outcomeReported: true,
  terminalBlockerReported: true,
  syntheticFixtureSafe: true,
  staleTerminalOwnershipCorrected: true,
}, null, 2) + "\n");
