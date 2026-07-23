#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const {
  CONTRACT_SCHEMA_VERSION,
  ContractValidationError,
  StaleRevisionError,
  adaptContextDossierV1,
  assertDispatchFence,
  createRevisionFence,
  fingerprintRecord,
  normalizeCampaign,
  normalizeContextDossier,
  normalizeEvidenceLedger,
  normalizeExecutionReceipt,
  normalizeFailurePacket,
  normalizeMasterPlan,
  normalizeMission,
  normalizeReportCursor,
  normalizeResourceBudget,
  normalizeWorkPackage,
  validateContract,
} = require("./core/program-contracts");
const {
  assertExecutionReceiptIntegrable,
  assertWorkPackageDispatchable,
  createProgramState,
  issueDispatchFence,
  normalizeProgramState,
} = require("./core/program-state");

const SHA = "a".repeat(64);
const SHORT_DIGEST = "b".repeat(24);

function throwsCode(action, Type, code) {
  assert.throws(action, (error) => error instanceof Type && error.code === code, `expected ${code}`);
}

function fixtures() {
  const mission = normalizeMission({
    schemaVersion: 2,
    missionId: "mission-foundation",
    revision: 1,
    state: "active",
    outcome: "Ship the Director-CFO foundation with authoritative evidence.",
    requirements: [{ requirementId: "requirement-contracts", description: "Contract regression passes.", status: "pending" }],
  });
  const contextDossier = normalizeContextDossier({
    schemaVersion: 2,
    dossierId: "dossier-foundation",
    missionId: mission.missionId,
    revision: 1,
    state: "ready",
    realGoal: mission.outcome,
    executiveSummary: "The architecture requires durable typed contracts.",
    sourceFingerprint: SHORT_DIGEST,
    sources: [{ sourceId: "source-chat", type: "chat", ref: "codex:task", fingerprint: SHORT_DIGEST, authority: "authoritative" }],
    facts: ["The latest user request authorizes implementation."],
    coverageComplete: true,
  });
  const masterPlan = normalizeMasterPlan({
    schemaVersion: 2,
    planId: "plan-foundation",
    missionId: mission.missionId,
    dossierId: contextDossier.dossierId,
    revision: 1,
    contextRevision: 1,
    state: "approved",
    objective: mission.outcome,
    strategy: "Build one fenced, evidence-linked vertical slice.",
    milestones: [{ milestoneId: "milestone-contracts", outcome: "Contract foundation works.", evidenceCriteria: ["Regression executable passes."] }],
    workstreams: [{
      workstreamId: "workstream-contracts",
      goal: "Implement and verify contract records.",
      milestoneIds: ["milestone-contracts"],
      capabilities: ["code"],
      permissions: ["workspace-write"],
      evidenceCriteria: ["Regression executable passes."],
      estimatedDemand: { tokens: 6000, durationMinutes: 60, attempts: 2, concurrency: 1 },
    }],
    timeline: [{ milestoneId: "milestone-contracts", durationHours: 1 }],
    risks: [{ riskId: "risk-stale", description: "Stale work could integrate.", probability: "medium", impact: "critical", mitigation: "Use a revision fence." }],
  });
  const resourceBudget = normalizeResourceBudget({
    schemaVersion: 2,
    budgetId: "budget-foundation",
    missionId: mission.missionId,
    dossierId: contextDossier.dossierId,
    planId: masterPlan.planId,
    revision: 1,
    contextRevision: 1,
    planRevision: 1,
    state: "active",
    inventoryFingerprint: SHORT_DIGEST,
    forecastFingerprint: SHORT_DIGEST,
    limits: { maxTokens: 10000, maxDurationMs: 3600000, maxConcurrentWorkers: 1, maxAttempts: 3, maxDiskBytes: 1000000, maxRamMb: 1024 },
    reserves: { verificationTokens: 1000, reconciliationTokens: 1000, emergencyTokens: 500 },
    allocations: [{
      allocationId: "allocation-contracts",
      workstreamId: "workstream-contracts",
      role: "contract builder",
      provider: "codex",
      model: "sol",
      tokenLimit: 7000,
      durationLimitMs: 1800000,
      maxAttempts: 2,
      concurrency: 1,
      permissions: ["workspace-write"],
    }],
  });
  const campaign = normalizeCampaign({
    schemaVersion: 2,
    campaignId: "campaign-foundation",
    missionId: mission.missionId,
    dossierId: contextDossier.dossierId,
    planId: masterPlan.planId,
    budgetId: resourceBudget.budgetId,
    revision: 1,
    contextRevision: 1,
    planRevision: 1,
    budgetRevision: 1,
    state: "running",
    milestoneIds: ["milestone-contracts"],
    workPackageIds: ["workpackage-contracts"],
    acceptanceTargets: ["Regression executable passes."],
    progressSignal: { metric: "accepted evidence", baseline: 0, target: 1, minimumDelta: 1, evidenceLevel: "focused-test" },
    resourceCap: { maxTokens: 7000, maxDurationMs: 1800000, maxConcurrentWorkers: 1, maxAttempts: 2, maxDiskBytes: 1000000, maxRamMb: 1024 },
    reserveFloorTokens: 1000,
    noProgressLimit: 2,
    idempotencyKey: "campaign-foundation-v1",
  });
  return { mission, contextDossier, masterPlan, resourceBudget, campaign };
}

function run() {
  const contracts = fixtures();
  const firstFence = createRevisionFence(contracts, "dispatch");
  assert.equal(firstFence.fingerprint, createRevisionFence(contracts, "dispatch").fingerprint, "fences must be deterministic");
  assert.equal(contracts.mission.fingerprint, fingerprintRecord(contracts.mission));

  const planned = normalizeWorkPackage({
    schemaVersion: 2,
    workPackageId: "workpackage-contracts",
    missionId: contracts.mission.missionId,
    dossierId: contracts.contextDossier.dossierId,
    planId: contracts.masterPlan.planId,
    budgetId: contracts.resourceBudget.budgetId,
    campaignId: contracts.campaign.campaignId,
    revision: 1,
    state: "planned",
    type: "code",
    goal: "Implement the Director-CFO contract foundation.",
    workstreamId: "workstream-contracts",
    milestoneId: "milestone-contracts",
    assignee: { provider: "codex", model: "sol", role: "contract builder" },
    requiredPermissions: ["workspace-write"],
    deliverable: { type: "patch" },
    acceptanceCriteria: ["Regression executable passes."],
    verification: [{ type: "command", instruction: "node scripts/director-cfo-contracts-regression.js", expected: "ok true" }],
    limits: { maxTokens: 7000, maxDurationMs: 1800000, maxConcurrentWorkers: 1, maxAttempts: 2 },
  });
  let state = createProgramState({ ...contracts, workPackages: [planned] });
  const dispatchFence = issueDispatchFence(state);
  const ready = normalizeWorkPackage({ ...planned, fingerprint: undefined, state: "ready", revisionFence: dispatchFence });
  state = createProgramState({ programId: state.programId, ...contracts, workPackages: [ready] });
  assert.equal(assertWorkPackageDispatchable(state, ready).allocation.allocationId, "allocation-contracts");

  const receipt = normalizeExecutionReceipt({
    schemaVersion: 2,
    receiptId: "receipt-contracts",
    missionId: contracts.mission.missionId,
    campaignId: contracts.campaign.campaignId,
    workPackageId: ready.workPackageId,
    attemptId: "attempt-contracts",
    revision: 1,
    state: "succeeded",
    provider: "codex",
    model: "sol",
    deliverableType: "patch",
    summary: "Contract layer implemented and regression passed.",
    artifacts: [{ ref: "scripts/core/program-contracts.js", fingerprint: SHORT_DIGEST, kind: "patch" }],
    evidenceRefs: ["test:director-cfo-contracts-regression"],
    usage: { inputTokens: 1000, cacheCreationInputTokens: 200, cacheReadInputTokens: 100, outputTokens: 1000, totalTokens: 2300, durationMs: 1000, attempts: 2, allocationAttempt: 2 },
    revisionFence: dispatchFence,
  });
  assert.equal(assertExecutionReceiptIntegrable(state, ready, receipt).receipt.state, "succeeded");
  assert.equal(receipt.usage.cacheCreationInputTokens, 200);
  assert.equal(receipt.usage.cacheReadInputTokens, 100);
  assert.equal(receipt.usage.totalTokens, 2300);
  assert.equal(receipt.usage.allocationAttempt, 2);

  const failure = normalizeFailurePacket({
    schemaVersion: 2,
    failureId: "failure-contracts",
    missionId: contracts.mission.missionId,
    campaignId: contracts.campaign.campaignId,
    workPackageId: ready.workPackageId,
    revision: 1,
    state: "replanned",
    phase: "integration",
    classification: "context-stale",
    summary: "The context revision changed before integration.",
    rootCause: "The result was produced against an old dossier.",
    recoveryAction: "Rebuild the package against the current fence.",
    repeatedOutcomeCount: 1,
    revisionFence: dispatchFence,
  });
  const ledger = normalizeEvidenceLedger({
    schemaVersion: 2,
    ledgerId: "ledger-foundation",
    missionId: contracts.mission.missionId,
    revision: 1,
    entries: [{ evidenceId: "evidence-contracts", requirementId: "requirement-contracts", workPackageId: ready.workPackageId, level: "focused-test", state: "accepted", ref: "test:contracts", summary: "Regression passed.", verifier: "node-assert", sourceFingerprint: SHORT_DIGEST, verifiedAt: "2026-07-21T00:00:00.000Z" }],
  });
  const cursor = normalizeReportCursor({ schemaVersion: 2, cursorId: "cursor-codex", missionId: contracts.mission.missionId, revision: 1, channel: "codex", sequence: 1, lastEventId: "event-contracts", lastEventFingerprint: SHORT_DIGEST });
  assert.equal(failure.classification, "context-stale");
  assert.equal(ledger.acceptedCount, 1);
  assert.equal(cursor.sequence, 1);

  const legacyInputs = [
    ["Mission", { taskId: "task-legacy", outcome: "Legacy outcome" }, "draft"],
    ["ContextDossier", { missionId: "mission-legacy", realGoal: "Legacy context" }, "stale"],
    ["MasterPlan", { missionId: "mission-legacy", objective: "Legacy plan" }, "draft"],
    ["ResourceBudget", { missionId: "mission-legacy" }, "draft"],
    ["Campaign", { missionId: "mission-legacy" }, "planned"],
    ["WorkPackage", { goal: "Legacy work" }, "planned"],
    ["ExecutionReceipt", { workPackageId: "workpackage-legacy" }, "pending"],
    ["FailurePacket", { summary: "Legacy failure" }, "unclassified"],
    ["EvidenceLedger", { missionId: "mission-legacy" }, "active"],
    ["ReportCursor", { missionId: "mission-legacy" }, "active"],
  ];
  for (const [kind, value, safeState] of legacyInputs) {
    const result = validateContract(kind, value);
    assert.equal(result.valid, true, `${kind} legacy input must migrate`);
    assert.equal(result.record.schemaVersion, CONTRACT_SCHEMA_VERSION);
    assert.equal(result.record.sourceSchemaVersion, 1);
    assert.equal(result.record.state, safeState);
  }

  const contextLane = adaptContextDossierV1({
    schemaVersion: "director-cfo/context-dossier@1",
    contextRevision: 1,
    mission: { id: contracts.mission.missionId, revision: 1, outcome: contracts.mission.outcome },
    realGoal: contracts.mission.outcome,
    executiveSummary: "Adapted context lane output.",
    sourceObservations: [{ sourceId: "chat-main", status: "observed", fingerprint: SHORT_DIGEST, summary: "Read." }],
    facts: [{ text: "The goal is authoritative.", sourceIds: ["chat-main"] }],
    assumptions: [], unknowns: [], decisions: [], constraints: [], failures: [], risks: [],
    contextFingerprint: SHORT_DIGEST,
  });
  assert.equal(contextLane.state, "ready");
  assert.equal(contextLane.sources[0].fingerprint, SHORT_DIGEST);
  const adaptedState = normalizeProgramState({ schemaVersion: 2, programId: "program-adapter", state: "active", mission: contracts.mission, contextDossier: {
    schemaVersion: "director-cfo/context-dossier@1", contextRevision: 1,
    mission: { id: contracts.mission.missionId, revision: 1, outcome: contracts.mission.outcome },
    realGoal: contracts.mission.outcome, executiveSummary: "Stored through adapter.",
    sourceObservations: [{ sourceId: "chat-main", status: "observed", fingerprint: SHORT_DIGEST }],
    facts: [], assumptions: [], unknowns: [], decisions: [], constraints: [], failures: [], risks: [], contextFingerprint: SHORT_DIGEST,
  } });
  assert.equal(adaptedState.contextDossier.sourceSchemaVersion, 2);

  for (const component of ["contextDossier", "masterPlan", "resourceBudget", "campaign"]) {
    const normalizer = { contextDossier: normalizeContextDossier, masterPlan: normalizeMasterPlan, resourceBudget: normalizeResourceBudget, campaign: normalizeCampaign }[component];
    const changed = normalizer({ ...contracts[component], fingerprint: undefined, revision: contracts[component].revision + 1 });
    const current = { ...contracts, [component]: changed };
    throwsCode(() => assertDispatchFence(dispatchFence, current), StaleRevisionError, "STALE_REVISION_FENCE");
  }

  throwsCode(() => normalizeMission({ ...contracts.mission, fingerprint: "a".repeat(24) }), ContractValidationError, "CONTRACT_INVALID");
  throwsCode(() => normalizeContextDossier({ schemaVersion: 2, dossierId: "dossier-bad", missionId: "mission-bad", state: "ready", realGoal: "Bad context" }), ContractValidationError, "CONTRACT_INVALID");
  throwsCode(() => normalizeResourceBudget({ schemaVersion: 99 }), ContractValidationError, "CONTRACT_INVALID");
  throwsCode(() => normalizeExecutionReceipt({ schemaVersion: 2, receiptId: "receipt-bad", missionId: "mission-bad", campaignId: "campaign-bad", workPackageId: "workpackage-bad", attemptId: "attempt-bad", state: "succeeded", summary: "No proof" }), ContractValidationError, "CONTRACT_INVALID");

  const revisedBudget = normalizeResourceBudget({ ...contracts.resourceBudget, fingerprint: undefined, revision: 2 });
  const revisedCampaign = normalizeCampaign({ ...contracts.campaign, fingerprint: undefined, revision: 2, budgetRevision: 2 });
  const staleState = createProgramState({ ...contracts, resourceBudget: revisedBudget, campaign: revisedCampaign, workPackages: [ready] });
  throwsCode(() => assertExecutionReceiptIntegrable(staleState, ready, receipt), StaleRevisionError, "STALE_REVISION_FENCE");

  process.stdout.write(`${JSON.stringify({
    ok: true,
    contractsValidated: 10,
    legacyContractsMigrated: legacyInputs.length,
    contextLaneAdapter: true,
    deterministicFingerprints: true,
    staleFenceComponentsRejected: ["context", "plan", "budget", "campaign"],
    dispatchFenceValidated: true,
    integrationFenceValidated: true,
    failClosedCases: 5,
  }, null, 2)}\n`);
}

try {
  run();
} catch (error) {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
}
