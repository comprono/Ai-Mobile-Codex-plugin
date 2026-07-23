#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-mobile-resource-enforcement-"));
process.env.AI_MOBILE_DATA_ROOT = path.join(root, "state");

const {
  allocationAttemptDescriptor,
  allocationClaimFile,
  claimAllocationAttempt,
  setStatus,
} = require("./core/job-store");
const {
  directorAllocationLimits,
  directorModelIdentityBlocker,
  enforceDirectorAllocation,
  normalizeWorkerUsage,
  parseStructuredValue,
  resourceFailureOutcome,
  salvageTypedReadOnlyArtifact,
} = require("./core/worker");
const {
  classifyFailure,
  recoveryPolicy,
} = require("./core/failure-reconciler");
const {
  buildClaudeArgs,
  codexInvocationModelUsage,
  normalizeClaudeUsage,
  providerExecutionAccess,
} = require("./providers");
const {
  allocationAccountingBasis,
  normalizeProvider,
} = require("./core/resource-ledger");const { createDirectorWorkerContract } = require("./core/director-worker-contract");
const { createTaskRecord, jobDirectory, updateTask } = require("./core/state-store");
const { writeJson } = require("./core/utils");

function workerContractFor(boundAllocation, options = {}) {
  return createDirectorWorkerContract({
    workPackageId: boundAllocation.workPackageId,
    allocation: boundAllocation,
    executorKind: options.executorKind || "context-scout",
    deliverableKind: options.deliverableKind || "context-dossier",
  });
}

const allocation = {
  allocationId: "budget-8:context-retry:claude",
  workPackageId: "context-retry",
  provider: "claude",
  candidateId: "context-retry:claude:opus",
  model: "opus",
  tokenLimit: 30000,
  durationLimitMs: 1200000,
  maxAttempts: 1,
};
const directorWorkerContract = workerContractFor(allocation);

const fullContract = {
  directorProgram: { programId: "program-fixture", workPackageId: allocation.workPackageId, phase: "context" },
  directorWorkerContract,
  allocation,
  model: "opus",
  provider: "claude",
  providerAuthMode: "subscription",
  executorKind: "context-scout",
  deliverableKind: "context-dossier",
  readOnly: true,
  complexity: "large",
  minimumCapabilityTier: "frontier",
  effort: "low",
  effortProvided: false,
  timeoutSeconds: 3600,
  estimatedDirectTokens: 90000,
  maxWorkerOutputTokens: 4000,
};

const enforced = enforceDirectorAllocation(fullContract);
assert.equal(enforced.timeoutSeconds, 1200);
assert.equal(enforced.estimatedDirectTokens, 30000);
assert.equal(enforced.maxWorkerOutputTokens, 4000);
assert.equal(enforced.effort, "high", "A strong Director context worker must not inherit the generic read-only low effort.");
assert.equal(enforceDirectorAllocation({ ...fullContract, effort: "ultra", effortProvided: true }).effort, "ultra");
assert.equal(directorAllocationLimits(fullContract).allocationId, allocation.allocationId);
assert.throws(() => directorAllocationLimits({ ...fullContract, allocation: { ...allocation, allocationId: "" } }), /director-allocation-id-missing/);
assert.throws(() => directorAllocationLimits({
  ...fullContract,
  allocation: { ...allocation, allocationId: "different-allocation" },
}), /director-allocation-contract-mismatch/);
assert.throws(() => enforceDirectorAllocation({ ...fullContract, allocationAttempt: 2 }), /allocation-attempt-limit-exceeded/);
const strategistContract = {
  ...fullContract,
  executorKind: "strategist",
  deliverableKind: "master-plan",
  directorProgram: { ...fullContract.directorProgram, phase: "strategy" },
  directorWorkerContract: workerContractFor(allocation, { executorKind: "strategist", deliverableKind: "master-plan" }),
};
assert.equal(directorAllocationLimits(strategistContract).model, "opus");
const reboundAllocation = {
  ...allocation,
  provider: "codex",
  candidateId: "context-retry:codex:gpt-5.3-codex-spark",
  model: "gpt-5.3-codex-spark",
};
const reboundStrategistContract = {
  ...strategistContract,
  allocation: reboundAllocation,
  provider: "codex",
  model: "gpt-5.3-codex-spark",
};
assert.throws(() => directorAllocationLimits(reboundStrategistContract), /director-allocation-contract-mismatch/);
assert.throws(() => allocationAttemptDescriptor(reboundStrategistContract), /director-allocation-contract-mismatch/);

const hO22Usage = normalizeClaudeUsage({
  duration_ms: 109350,
  total_cost_usd: 1.06665375,
  usage: {
    input_tokens: 1609,
    cache_creation_input_tokens: 74746,
    cache_read_input_tokens: 405644,
    output_tokens: 4378,
  },
  modelUsage: {
    "claude-haiku-4-5-20251001": {
      inputTokens: 11073,
      outputTokens: 20,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      costUSD: 0.011173,
    },
    "claude-opus-4-8": {
      inputTokens: 1609,
      outputTokens: 4378,
      cacheReadInputTokens: 405644,
      cacheCreationInputTokens: 74746,
      costUSD: 1.05548075,
    },
  },
}, "opus");
assert.equal(hO22Usage.model, "opus", "The requested principal model alias must remain the immutable allocation identity.");
assert.equal(hO22Usage.actualModel, "claude-opus-4-8", "The authoritative raw provider model must be preserved.");
assert.equal(hO22Usage.inputTokens, 12682);
assert.equal(hO22Usage.cacheCreationInputTokens, 74746);
assert.equal(hO22Usage.cacheReadInputTokens, 405644);
assert.equal(hO22Usage.outputTokens, 4398);
assert.equal(hO22Usage.totalTokens, 497470);
assert.deepEqual(hO22Usage.auxiliaryModels, ["claude-haiku-4-5-20251001"]);

const contextAccounting = normalizeWorkerUsage(enforced, hO22Usage, 109350);
assert.equal(contextAccounting.totalTokens, 497470);
assert.equal(contextAccounting.budgetExceeded, true);
assert.match(contextAccounting.budgetViolationReasons.join(" | "), /tokens 497470>30000/);

const validStrategyAccounting = normalizeWorkerUsage({
  ...enforced,
  executorKind: "strategist",
  deliverableKind: "master-plan",
}, {
  model: "claude-opus-4-8",
  inputTokens: 1592,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
  outputTokens: 17486,
  totalTokens: 19078,
  durationMs: 180000,
}, 180000);
assert.equal(validStrategyAccounting.totalTokens, 19078);
assert.equal(validStrategyAccounting.budgetExceeded, false, "Aggregate provider output above the final-artifact summary cap is not itself an allocation overrun.");

assert.equal(classifyFailure("allocation-budget-exceeded: tokens 497470>30000"), "resource-contract");
assert.equal(recoveryPolicy({ failureClass: "resource-contract", executorKind: "context-scout", stateFingerprint: "fixture" }, []).strongReconciler, true);

const emptyClaudeUsage = normalizeClaudeUsage({}, "opus");
assert.equal(emptyClaudeUsage.totalTokens, null);
assert.equal(emptyClaudeUsage.resourceAccountingComplete, false);
assert.equal(normalizeWorkerUsage(enforced, emptyClaudeUsage, 100).resourceAccountingUnavailable, true);
const partialClaudeUsage = normalizeClaudeUsage({
  modelUsage: {
    "claude-opus-4-8": { inputTokens: 10, outputTokens: 4 },
  },
}, "opus");
assert.equal(partialClaudeUsage.totalTokens, null);
assert.equal(normalizeWorkerUsage(enforced, partialClaudeUsage, 100).resourceAccountingUnavailable, true);

const shortAllocation = { ...allocation, allocationId: "budget-8:duration:claude", durationLimitMs: 5000 };
const durationContract = {
  ...fullContract,
  allocation: shortAllocation,
  directorProgram: { ...fullContract.directorProgram, workPackageId: shortAllocation.workPackageId },
  directorWorkerContract: workerContractFor(shortAllocation),
};
const durationAccounting = normalizeWorkerUsage(durationContract, {
  model: "opus",
  principalModelObserved: true,
  inputTokens: 10,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
  outputTokens: 5,
  durationMs: 1,
}, 6000);
assert.equal(durationAccounting.durationMs, 6000);
assert.match(durationAccounting.budgetViolationReasons.join(" | "), /durationMs 6000>5000/);

const apiAllocation = {
  ...allocation,
  allocationId: "budget-8:api:claude",
  cost: { apiUsd: { state: "known", unit: "usd", value: 0.25 } },
};
const apiContract = {
  ...fullContract,
  providerAuthMode: "api-key",
  maxApiBudgetUsd: 5,
  allocation: apiAllocation,
  directorWorkerContract: workerContractFor(apiAllocation),
};
assert.equal(enforceDirectorAllocation(apiContract).maxApiBudgetUsd, 0.25);
const apiAccounting = normalizeWorkerUsage(apiContract, {
  model: "opus",
  principalModelObserved: true,
  inputTokens: 10,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
  outputTokens: 5,
  equivalentUsd: 0.3,
}, 100);
assert.match(apiAccounting.budgetViolationReasons.join(" | "), /equivalentUsd 0.3>0.25/);
assert.equal(normalizeWorkerUsage(apiContract, {
  model: "opus",
  principalModelObserved: true,
  inputTokens: 10,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
  outputTokens: 5,
}, 100).resourceAccountingUnavailable, true);
const unknownApiAllocation = { ...apiAllocation, cost: { apiUsd: { state: "unknown", unit: "usd" } } };
assert.throws(() => directorAllocationLimits({
  ...apiContract,
  allocation: unknownApiAllocation,
  directorWorkerContract: workerContractFor(unknownApiAllocation),
}), /resource-accounting-unavailable/);

assert.throws(() => directorAllocationLimits({ ...fullContract, allocation: { ...allocation, candidateId: "" } }), /candidate-missing/);
assert.throws(() => directorAllocationLimits({ ...fullContract, allocation: { ...allocation, provider: "antigravity" } }), /provider-mismatch/);
assert.throws(() => directorAllocationLimits({ ...fullContract, allocation: { ...allocation, model: "sonnet" } }), /model-mismatch/);
assert.equal(classifyFailure("director-allocation-model-unobserved"), "resource-contract");
assert.equal(classifyFailure("resource-accounting-basis-unavailable"), "resource-contract");

const unavailableAgProvider = normalizeProvider("antigravity", {
  available: true,
  authenticated: true,
  headless: true,
  authMode: "cli-session",
  models: [{ id: "gemini-3.5-flash-low" }],
}, {});
assert.equal(unavailableAgProvider.accountingClass, "consumer-quota-session");
assert.equal(allocationAccountingBasis(unavailableAgProvider, [], { durationLimitMs: 60000 }).mode, "unavailable");
const agBaseAllocation = {
  allocationId: "budget-8:strategy:antigravity",
  workPackageId: "strategy",
  provider: "antigravity",
  model: "gemini-3.5-flash-low",
  candidateId: "strategy:antigravity:flash-low",
  tokenLimit: 20000,
  durationLimitMs: 60000,
  maxAttempts: 1,
};
const agBaseContract = {
  directorProgram: { programId: "program-fixture", workPackageId: "strategy", phase: "strategy" },
  provider: "antigravity",
  providerAuthMode: "cli-session",
  model: agBaseAllocation.model,
  allocation: agBaseAllocation,
  directorWorkerContract: workerContractFor(agBaseAllocation, { executorKind: "strategist", deliverableKind: "master-plan" }),
};
assert.throws(() => directorAllocationLimits(agBaseContract), /resource-accounting-unavailable/);

const knownAgProvider = normalizeProvider("antigravity", {
  available: true,
  authenticated: true,
  headless: true,
  authMode: "cli-session",
  models: [{ id: "gemini-3.5-flash-low" }],
  quotaPools: [{ id: "flash-low", remainingPercent: 70, source: "fixture" }],
}, {});
const agReservation = {
  provider: "antigravity",
  poolId: "flash-low",
  poolKey: "antigravity:flash-low",
  exclusive: true,
  measurement: { state: "known", unit: "percent", value: 5 },
  remainingBefore: { state: "known", unit: "percent", value: 70 },
  reserveFloor: 20,
};
const agBasis = allocationAccountingBasis(knownAgProvider, [agReservation], { durationLimitMs: 60000 });
assert.equal(agBasis.mode, "wall-time-and-exclusive-quota-reservation");
const agAllocation = { ...agBaseAllocation, accountingBasis: agBasis, quotaReservations: [agReservation] };
const agContract = {
  ...agBaseContract,
  allocation: agAllocation,
  directorWorkerContract: workerContractFor(agAllocation, { executorKind: "strategist", deliverableKind: "master-plan" }),

};
const agAccounting = normalizeWorkerUsage(agContract, {
  model: agAllocation.model,
  actualModelId: agAllocation.model,
  actualModel: "Gemini 3.5 Flash (Low)",
  principalModelObserved: true,
  inputTokens: null,
  outputTokens: null,
  totalTokens: null,
  resourceAccountingComplete: false,
}, 1200);
assert.equal(agAccounting.resourceAccountingUnavailable, false);
assert.equal(agAccounting.totalTokens, null);
assert.equal(agAccounting.quotaRefreshRequiredBeforeReuse, true);
assert.equal(directorModelIdentityBlocker(agContract, agAccounting), "");
assert.match(directorModelIdentityBlocker(agContract, { model: "unknown" }), /model-unobserved/);
assert.match(directorModelIdentityBlocker(agContract, { model: "gemini-3.5-flash-medium", principalModelObserved: true }), /model-mismatch/);
const codexModelUsage = codexInvocationModelUsage("gpt-5.3-codex-spark", true);
assert.equal(codexModelUsage.principalModelObserved, true);
assert.equal(codexModelUsage.identitySource, "codex-cli-exact-catalog-bound-model-argument");
assert.equal(directorModelIdentityBlocker({
  directorProgram: { programId: "program-fixture" },
  allocation: { model: "gpt-5.3-codex-spark" },
}, codexModelUsage), "");

const operationReceipt = {
  kind: "operation-receipt",
  state: "applied",
  sideEffectKey: "service:restart:v1",
  observedStateFingerprintBefore: "before",
  observedStateFingerprintAfter: "after",
  idempotency: { checked: true, duplicate: false, key: "service:restart:v1", evidence: "No prior receipt." },
  preconditions: [{ name: "ready", passed: true, evidence: "ready" }],
  actions: [{ name: "restart", passed: true, evidence: "submitted once" }],
  postconditions: [{ name: "healthy", passed: true, evidence: "healthy" }],
  evidence: ["authoritative receipt"],
  acceptanceEvidence: [],
  blocker: "",
};
const sideEffectFailure = resourceFailureOutcome({
  executorKind: "operational-transaction",
  deliverableKind: "operation-receipt",
  commands: [{ command: "service", args: ["restart"] }],
  mutatesExternalState: true,
  sideEffectKey: operationReceipt.sideEffectKey,
}, { ok: true, typedBlocker: "" }, operationReceipt, {
  resourceAccountingUnavailable: false,
  resourceLimitBreached: true,
  budgetViolationReasons: ["durationMs 61000>60000"],
});
assert(sideEffectFailure.authoritativeSideEffectReceipt);
assert.equal(sideEffectFailure.retryForbidden, true);
assert.equal(classifyFailure(sideEffectFailure.blocker), "ambiguous-external-write");
assert.equal(recoveryPolicy({ failureClass: "ambiguous-external-write", executorKind: "operational-transaction" }, []).action, "observe-authoritative-state");
const recoveredStructuredValue = parseStructuredValue('status {required:true}\n{\"kind\":\"master-plan\",\"nested\":{\"quoted\":\"} remains data\"}}\ntrailing');
assert.deepEqual(recoveredStructuredValue, { kind: "master-plan", nested: { quoted: "} remains data" } }, "balanced extraction must recover a complete JSON artifact after invalid brace text");
const salvageWorkspace = path.join(root, "read-only-salvage");
fs.mkdirSync(salvageWorkspace, { recursive: true });
const salvageArtifact = { realGoal: "Ship verified progress.", executiveSummary: "Recovered result." };
fs.writeFileSync(path.join(salvageWorkspace, "context-dossier.json"), JSON.stringify(salvageArtifact), "utf8");
const salvageContract = {
  readOnly: true,
  executorKind: "context-scout",
  deliverableKind: "context-dossier",
  artifactContract: { required: ["realGoal", "executiveSummary"] },
};
const salvaged = salvageTypedReadOnlyArtifact(salvageContract, salvageWorkspace, ["context-dossier.json"]);
assert.deepEqual(salvaged.artifact, salvageArtifact, "The one expected typed artifact must survive a disposable read-only snapshot.");
assert.equal(salvaged.relativeFile, "context-dossier.json");
assert.equal(salvageTypedReadOnlyArtifact(salvageContract, salvageWorkspace, ["context-dossier.json", "extra.txt"]), null, "A second mutation must fail closed.");
assert.equal(salvageTypedReadOnlyArtifact(salvageContract, salvageWorkspace, ["unexpected.json"]), null, "An unexpected filename must fail closed.");
fs.writeFileSync(path.join(salvageWorkspace, "context-dossier.json"), JSON.stringify({ executiveSummary: "Missing required key." }), "utf8");
assert.equal(salvageTypedReadOnlyArtifact(salvageContract, salvageWorkspace, ["context-dossier.json"]), null, "A typed artifact missing an immutable required field must fail closed.");

const readOnlyArtifact = { kind: "context-dossier", executiveSummary: "Valid paid reasoning is preserved once." };
const readOnlyOverrun = resourceFailureOutcome({
  readOnly: true,
  executorKind: "context-scout",
  deliverableKind: "context-dossier",
}, { ok: true, typedBlocker: "" }, readOnlyArtifact, {
  resourceAccountingUnavailable: false,
  resourceLimitBreached: true,
  budgetViolationReasons: ["tokens 51490>16000"],
});
assert.equal(readOnlyOverrun.blocker, "", "A measurable overrun must not discard a schema-valid read-only result after the tokens are already spent.");
assert.equal(readOnlyOverrun.preservedReadOnlyResult, true);
assert.equal(readOnlyOverrun.receiptValidation.ok, true);
assert.equal(readOnlyOverrun.retryForbidden, true, "The preserved result must prevent paying for the same read-only reasoning again.");
const preservedMasterPlan = resourceFailureOutcome({
  readOnly: true,
  executorKind: "strategist",
  deliverableKind: "master-plan",
}, { ok: true, typedBlocker: "" }, { kind: "master-plan", milestones: [{ id: "M1" }] }, {
  resourceAccountingUnavailable: false,
  resourceLimitBreached: true,
  budgetViolationReasons: ["tokens 78956>30000"],
});
assert.equal(preservedMasterPlan.blocker, "", "A valid Master Plan must survive a measured strategy allocation overrun.");
assert.equal(preservedMasterPlan.preservedReadOnlyResult, true);
assert.equal(preservedMasterPlan.retryForbidden, true);
const unavailableReadOnlyAccounting = resourceFailureOutcome({ readOnly: true, deliverableKind: "context-dossier" }, { ok: true }, readOnlyArtifact, {
  resourceAccountingUnavailable: true,
  resourceLimitBreached: false,
});
assert.match(unavailableReadOnlyAccounting.blocker, /resource-accounting-unavailable/);

const claimAllocation = { ...allocation, allocationId: "budget-8:claim:claude", maxAttempts: 2 };
const claimContract = {
  ...fullContract,
  allocation: claimAllocation,
  directorWorkerContract: workerContractFor(claimAllocation),
};
assert.equal(allocationAttemptDescriptor(claimContract).maxAttempts, 2);
const taskId = "task-12345678";
const first = claimAllocationAttempt(claimContract, taskId, "job-12345678");
assert.equal(first.allocationAttempt, 1);
assert.throws(() => claimAllocationAttempt(claimContract, taskId, "job-abcdefgh"), /allocation-active-claim-conflict/);
const firstClaimFile = allocationClaimFile(taskId, "job-12345678");
const orphanedClaim = JSON.parse(fs.readFileSync(firstClaimFile, "utf8"));
fs.writeFileSync(firstClaimFile, JSON.stringify({ ...orphanedClaim, ownerPid: 2147483647 }), "utf8");
const second = claimAllocationAttempt(claimContract, taskId, "job-abcdefgh");
assert.equal(second.allocationAttempt, 1);
assert.equal(JSON.parse(fs.readFileSync(firstClaimFile, "utf8")).state, "abandoned");
setStatus(taskId, "job-abcdefgh", { state: "failed", finishedAt: new Date().toISOString() });
const third = claimAllocationAttempt(claimContract, taskId, "job-ijklmnop");
assert.equal(third.allocationAttempt, 2);
setStatus(taskId, "job-ijklmnop", { state: "failed", finishedAt: new Date().toISOString() });
assert.throws(() => claimAllocationAttempt(claimContract, taskId, "job-qrstuvwx"), /allocation-attempt-limit-exceeded:3>2/);

function createSupervisorTask(label, limits) {
  const workspace = path.join(root, label);
  fs.mkdirSync(workspace, { recursive: true });
  const created = createTaskRecord({
    workspace,
    outcome: `Bound ${label}.`,
    requirements: [{ id: `REQ-${label}`, description: `Bound ${label}.`, required: true, status: "failing", minimumEvidenceLevel: "integration", evidence: [] }],
    currentCodex: { model: "gpt-5.3-codex-spark", effort: "medium", files: [] },
    workGraph: [],
  });
  const now = new Date().toISOString();
  updateTask(created.taskId, (task) => {
    task.program = {
      mode: "director-cfo",
      programId: `program-${label}`,
      mission: { missionId: `mission-${label}`, revision: 1, fingerprint: `mission-fp-${label}` },
      workPackages: [],
      campaigns: [],
      executionReceipts: [],
      runtime: {
        programSupervisor: {
          schemaVersion: 2,
          supervisorId: `supervisor-${label}`,
          supervisorEpoch: 1,
          state: "active",
          startedAt: now,
          deadlineAt: new Date(Date.parse(now) + 3600000).toISOString(),
          horizonHours: 1,
          limits: { maxArtifacts: 100, maxArtifactBytes: 100000000, maxWorkers: 4, maxGlobalWorkers: 8, maxCampaigns: 10, ...limits },
          hardCeilings: {},
          campaignCount: 0,
          allocationIds: [],
          wakeCount: 0,
          noProgressCount: 0,
        },
      },
    };
    return task;
  });
  return created.taskId;
}

const atomicTaskId = createSupervisorTask("atomic-claim", { maxTokens: 100, maxDurationMs: 1000, maxAttempts: 2 });
const atomicAllocationA = { ...allocation, allocationId: "atomic-a", workPackageId: "atomic-a", candidateId: "atomic-a:claude:opus", tokenLimit: 60, durationLimitMs: 600, maxAttempts: 1 };
const atomicAllocationB = { ...allocation, allocationId: "atomic-b", workPackageId: "atomic-b", candidateId: "atomic-b:claude:opus", tokenLimit: 60, durationLimitMs: 600, maxAttempts: 1 };
const atomicContract = (bound) => ({ ...fullContract, directorProgram: { programId: "program-atomic-claim", workPackageId: bound.workPackageId, phase: "execution" }, allocation: bound, directorWorkerContract: workerContractFor(bound) });
assert.equal(claimAllocationAttempt(atomicContract(atomicAllocationA), atomicTaskId, "job-atomic-a").allocationAttempt, 1);
assert.throws(() => claimAllocationAttempt(atomicContract(atomicAllocationB), atomicTaskId, "job-atomic-b"), /program-(?:token|duration)-cap-exceeded/);

const releasedCapacityTaskId = createSupervisorTask("released-terminal-capacity", { maxTokens: 178000, maxDurationMs: 1417314, maxAttempts: 2 });
const retiredAllocation = { ...allocation, allocationId: "retired-capacity", workPackageId: "retired-work", candidateId: "retired-work:claude:opus", tokenLimit: 150000, durationLimitMs: 2100000, maxAttempts: 1 };
const retiredJobId = "job-retired-capacity";
fs.mkdirSync(jobDirectory(releasedCapacityTaskId, retiredJobId), { recursive: true });
writeJson(path.join(jobDirectory(releasedCapacityTaskId, retiredJobId), "contract.json"), {
  ...fullContract,
  taskId: releasedCapacityTaskId,
  jobId: retiredJobId,
  directorProgram: { programId: "program-released-terminal-capacity", workPackageId: retiredAllocation.workPackageId, phase: "reconciliation" },
  allocation: retiredAllocation,
  directorWorkerContract: workerContractFor(retiredAllocation),
});
setStatus(releasedCapacityTaskId, retiredJobId, { state: "failed", startedAt: new Date(Date.now() - 217314).toISOString(), finishedAt: new Date().toISOString() });
writeJson(path.join(jobDirectory(releasedCapacityTaskId, retiredJobId), "usage.json"), { provider: "claude", totalTokens: 28000, durationMs: 217314, resourceAccountingComplete: true });
updateTask(releasedCapacityTaskId, (task) => {
  task.program.workPackages = [{ workPackageId: retiredAllocation.workPackageId, state: "failed", jobId: retiredJobId, allocation: retiredAllocation }];
  return task;
});
const recoveryAllocation = { ...allocation, allocationId: "bounded-recovery", workPackageId: "bounded-recovery", candidateId: "bounded-recovery:claude:opus", tokenLimit: 150000, durationLimitMs: 1200000, maxAttempts: 1 };
const recoveryContract = { ...fullContract, directorProgram: { programId: "program-released-terminal-capacity", workPackageId: recoveryAllocation.workPackageId, phase: "reconciliation" }, allocation: recoveryAllocation, directorWorkerContract: workerContractFor(recoveryAllocation) };
assert.equal(claimAllocationAttempt(recoveryContract, releasedCapacityTaskId, "job-bounded-recovery").allocationAttempt, 1, "A terminal failed grant must release unused authorization before the next bounded recovery claim.");
const retryTaskId = createSupervisorTask("reserved-retry", { maxTokens: 100, maxDurationMs: 2000, maxAttempts: 2 });
const retryAllocation = { ...allocation, allocationId: "retry-grant", workPackageId: "retry-work", candidateId: "retry-work:claude:opus", tokenLimit: 50, durationLimitMs: 1000, maxAttempts: 2 };
const retryContract = { ...fullContract, directorProgram: { programId: "program-reserved-retry", workPackageId: retryAllocation.workPackageId, phase: "execution" }, allocation: retryAllocation, directorWorkerContract: workerContractFor(retryAllocation) };
const retryFirst = claimAllocationAttempt(retryContract, retryTaskId, "job-retry-one");
assert.equal(retryFirst.allocationAttempt, 1);
writeJson(path.join(jobDirectory(retryTaskId, "job-retry-one"), "contract.json"), { ...retryFirst, taskId: retryTaskId, jobId: "job-retry-one" });
setStatus(retryTaskId, "job-retry-one", { state: "failed", finishedAt: new Date().toISOString() });
const changedRetryAllocation = { ...retryAllocation, tokenLimit: 49 };
const changedRetryContract = { ...retryContract, allocation: changedRetryAllocation, directorWorkerContract: workerContractFor(changedRetryAllocation) };
assert.throws(() => claimAllocationAttempt(changedRetryContract, retryTaskId, "job-retry-changed"), /program-allocation-binding-conflict/);
const retrySecond = claimAllocationAttempt(retryContract, retryTaskId, "job-retry-two");
assert.equal(retrySecond.allocationAttempt, 2, "A retry inside an already-reserved grant remains valid at aggregate equality.");
writeJson(path.join(jobDirectory(retryTaskId, "job-retry-two"), "contract.json"), { ...retrySecond, taskId: retryTaskId, jobId: "job-retry-two" });
setStatus(retryTaskId, "job-retry-two", { state: "failed", finishedAt: new Date().toISOString() });
assert.throws(() => claimAllocationAttempt(retryContract, retryTaskId, "job-retry-three"), /allocation-attempt-limit-exceeded:3>2/);

console.log(JSON.stringify({
  ok: true,
  principalModel: hO22Usage.actualModel || hO22Usage.model,
  hO22TotalTokens: hO22Usage.totalTokens,
  strategistTotalTokens: validStrategyAccounting.totalTokens,
  strongEffort: enforced.effort,
  maxAttemptsEnforced: true,
  immutableAllocationRebindingBlocked: true,
  antigravityUnknownQuotaRejectedBeforeExecution: true,
  antigravityQuotaAccountingAcceptedWhenAuthoritative: true,
  sideEffectRetryForbidden: sideEffectFailure.retryForbidden,
  atomicPendingReservationEnforced: true,
  reservedRetryAtEqualityAllowed: true,
  terminalCapacityReleasedForRecovery: true,
}));
