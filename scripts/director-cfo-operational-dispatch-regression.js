#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-mobile-operational-dispatch-"));
const workspace = path.join(root, "workspace");
process.env.AI_MOBILE_DATA_ROOT = path.join(root, "state");
process.env.LOCALAPPDATA = path.join(root, "local-app-data");
fs.mkdirSync(workspace, { recursive: true });
fs.writeFileSync(path.join(workspace, "seed.txt"), "bounded fixture\n", "utf8");

const { createDirectorWorkerContract, assertDirectorWorkerContract } = require("./core/director-worker-contract");
const {
  programRecommendedWorkUnits,
  startDirectorProgram,
} = require("./core/director-cfo-orchestrator");
const { route } = require("./core/router");
const { readTask, updateTask } = require("./core/state-store");
const { dispatchRound } = require("./core/task-orchestrator");
const { assessMasterPlan, masterPlanJsonSchema } = require("./core/plan-assurance");
const { CANONICAL_CALLABLE_CAPABILITIES, CANONICAL_PERMISSIONS, planWorkPackages } = require("./core/team-compiler");
const { buildAntigravityArgs, providerExecutionAccess } = require("./providers");


const model = "gemini-3.5-flash";
const provider = {
  id: "antigravity",
  available: true,
  authenticated: true,
  headless: true,
  authMode: "subscription",
  command: process.execPath,
  models: [{ id: model, displayName: model, capabilityTier: "balanced", quota: { status: "available", remainingPercent: 80 } }],
  surfaces: { headless: true, source: true, "local-files": true, command: true, "service-control": true },
  permissions: { command: true, "run-command": true, "service-control": true },
  capacity: { remainingPercent: 80, source: "fixture" },
};
const resources = {
  generatedAt: "2026-07-22T02:00:00.000Z",
  machine: { freeRamMb: 12000, totalRamMb: 16000, logicalCpuCount: 8 },
  worktreeStorage: { freeMb: 20000, minimumFreeMb: 2048, quotaMb: 2048 },
  providers: { antigravity: provider },
};

const evidenceRequirement = {
  id: "EV-003",
  milestoneId: "M-OPS",
  description: "The guarded operation has an authoritative receipt.",
  level: "end-to-end",
  proofType: "operation receipt",
  verifierRoleId: "R-OPS",
  acceptanceRequirementIds: ["REQ-003"],
};
const compiled = planWorkPackages({
  mission: { id: "mission-operational-dispatch" },
  contextDossier: { contextRevision: 2, contextFingerprint: "context-before-operation" },
  masterPlan: {
    planRevision: 3,
    workstreams: [{
      id: "W-OPS",
      outcome: "Apply one guarded service operation.",
      workType: "operation",
      milestoneIds: ["M-OPS"],
      dependsOn: [],
      teamRoleIds: ["R-OPS"],
      permissionIds: ["P-OPS"],
      evidenceRequirementIds: [evidenceRequirement.id],
      resourceEstimateId: "B-OPS",
      execution: {
        executorKind: "operational-transaction",
        deliverableKind: "operation-receipt",
        requiredCapabilities: ["service-operations", "command"],
        requiredPermissions: ["local-exec", "service-control"],
        commands: [{ command: "service-fixture", args: ["restart", "alpha"], timeoutSeconds: 30 }],
        preconditions: ["Observed fingerprint matches."],
        postconditions: ["Service is healthy."],
        rollback: { description: "Restore prior service state." },
        mutatesExternalState: true,
        sideEffectKey: "service-alpha:restart:v1",
        observedStateFingerprint: "service-before",
      },
    }],
    team: { roles: [{ id: "R-OPS", title: "Operator", modelClass: "balanced", capabilities: ["service-control"], responsibilities: ["Operate safely"] }] },
    permissions: [{ id: "P-OPS", capability: "service", mode: "execute" }],
    evidenceRequirements: [evidenceRequirement],
    resourceEstimates: [{ id: "B-OPS", inputTokens: 3000, outputTokens: 1000, wallClockMinutes: 2, attempts: 2 }],
  },
});
assert.equal(compiled.length, 1);
assert.deepEqual(compiled[0].acceptanceIds, ["REQ-003"]);
assert.deepEqual(compiled[0].evidenceRequirementIds, ["EV-003"]);
assert(compiled[0].requiredPermissions.includes("run-command"));
assert.equal(compiled[0].requiredPermissions.includes("local-exec"), false);
assert(compiled[0].requiredCapabilities.includes("service-control"));
assert.equal(compiled[0].requiredCapabilities.includes("service-operations"), false);
assert.throws(() => planWorkPackages({
  mission: { id: "mission-invalid-capability" },
  contextDossier: { contextRevision: 1, contextFingerprint: "fixture" },
  masterPlan: {
    workstreams: [{ id: "invalid", workType: "operation", outcome: "invalid", execution: { requiredCapabilities: ["operational-transaction"] } }],
  },
}), /unsupported callable capability operational-transaction/);
const invalidPlanAssessment = assessMasterPlan({
  workstreams: [{
    id: "invalid-capability",
    workType: "operation",
    execution: { requiredCapabilities: ["operational-transaction"], requiredPermissions: [] },
  }],
});

try {
  const started = startDirectorProgram({
    workspace,
    outcome: "Complete the guarded operational transaction.",
    forceProgram: true,
    authorizedPermissions: ["source", "local-files", "read-project", "read-files", "run-command", "service-control"],
    acceptanceEvidence: [{ id: "REQ-003", description: "A verified operational receipt exists.", minimumEvidenceLevel: "end-to-end" }],
  }, resources);
  const workPackageId = "wp-operational-dispatch";
  const requiredCapabilities = ["source", "local-files", "command", "service-control"];
  const requiredPermissions = ["run-command", "service-control"];
  const allocation = {
    allocationId: "budget-ops:wp-operational-dispatch:antigravity",
    candidateId: "wp-operational-dispatch:antigravity:gemini-3.5-flash",
    workPackageId,
    provider: "antigravity",
    model,
    tokenLimit: 4000,
    durationLimitMs: 60000,
    maxAttempts: 2,
  };
  const permissionPreflight = {
    ok: true,
    blocker: "",
    requiredPermissions,
    permissionGrant: requiredPermissions,
    requiredCapabilities,
    missingCapabilities: [],
    missingAuthorization: [],
    missingGrant: [],
    missingProviderPermissions: [],
    invalidSideEffectContract: [],
  };
  const runtimePackage = {
    ...compiled[0],
    workPackageId,
    state: "ready",
    relevantFiles: ["seed.txt"],
    expectedFiles: [],
    requiredCapabilities,
    requiredPermissions,
    permissionGrant: requiredPermissions,
    permissionPreflight,
    commands: [{ command: "service-fixture", args: ["restart", "alpha"], timeoutSeconds: 30 }],
    preconditions: ["Observed fingerprint matches service-before."],
    postconditions: ["Authoritative service health reports healthy."],
    rollback: { description: "Restore prior service state." },
    recoveryAction: "Restore and reconcile before retrying.",
    mutatesExternalState: true,
    sideEffectKey: "service-alpha:restart:v1",
    observedStateFingerprint: "service-before",
    acceptanceIds: ["REQ-003"],
    evidenceRequirementIds: ["EV-003"],
    evidenceRequirements: [evidenceRequirement],
    acceptanceCriteria: ["A verified operational receipt exists.", evidenceRequirement.description],
    preferredProvider: "antigravity",
    model,
    allocation,
    minimumCapabilityTier: "balanced",
    complexity: "medium",
    taskKind: "live-state",
    timeoutSeconds: 300,
    estimatedDirectTokens: 9000,
    maxWorkerOutputTokens: 6000,
    resourceEstimate: { tokens: 9000, wallTimeSeconds: 300, attempts: 3, ramMb: 256, diskMb: 16, opportunityCostSeconds: 30, apiUsd: 0, quotaDemands: [] },
    revisionFence: null,
  };
  updateTask(started.taskId, (task) => {
    task.program = {
      ...task.program,
      state: "active",
      phase: "execution",
      workPackages: [runtimePackage],
      policy: { ...task.program.policy, maxWorkers: 1 },
      nextAction: "Dispatch the exact guarded operational transaction.",
    };
    task.workGraph = [{
      id: workPackageId,
      goal: runtimePackage.goal,
      dependsOn: [],
      state: "pending",
      owner: null,
      acceptanceRequirementId: "REQ-003",
      acceptanceCriteria: runtimePackage.acceptanceCriteria,
      relevantFiles: ["seed.txt"],
      expectedFiles: [],
    }];
    return task;
  });

  const readyTask = readTask(started.taskId);
  const units = programRecommendedWorkUnits(readyTask);
  assert.equal(units.length, 1);
  assert.equal(units[0].readOnly, false, "A local operational transaction must be able to mutate its explicitly authorized project state.");
  assert.equal(units[0].localFileAccess, "bounded-write");
  assert.equal(units[0].effectKind, "operational-transaction");

  let dispatchedContract = null;
  const dispatched = dispatchRound({ taskId: started.taskId }, resources, {}, (contract) => {
    dispatchedContract = contract;
    return { taskId: started.taskId, jobId: "job-operational-dispatch", state: "running", provider: contract.provider, model: contract.model };
  });
  assert.equal(dispatched.state, "running", JSON.stringify(dispatched.rejected));
  assert.equal(dispatched.workers.length, 1);
  assert.equal(dispatched.rejected.length, 0);
  assert.equal(dispatchedContract.provider, "antigravity");
  assert.equal(dispatchedContract.executorKind, "operational-transaction");
  assert.equal(dispatchedContract.deliverableKind, "operation-receipt");
  assert.equal(dispatchedContract.artifactKind, "operation-receipt");
  assert.equal(dispatchedContract.readOnly, false);
  assert.deepEqual(dispatchedContract.expectedFiles, []);
  assert.equal(dispatchedContract.directorProviderAuthorization, true);
  assert.equal(dispatchedContract.directorEffectAuthorization, true);
  assert.equal(dispatchedContract.timeoutSeconds, 60);
  assert.equal(dispatchedContract.estimatedDirectTokens, 4000);
  assert.equal(dispatchedContract.maxWorkerOutputTokens, 4000);
  assert.equal(dispatchedContract.maxAttempts, 2);
  assert.equal(dispatchedContract.effort, "medium");
  assert.deepEqual(dispatchedContract.acceptanceIds, ["REQ-003"]);
  assert.deepEqual(dispatchedContract.evidenceRequirementIds, ["EV-003"]);
  assert.deepEqual(dispatchedContract.evidenceRequirements, [evidenceRequirement]);
  assert.deepEqual(dispatchedContract.acceptanceCriteria, runtimePackage.acceptanceCriteria);

  const immutable = assertDirectorWorkerContract(dispatchedContract.directorWorkerContract);
  assert.deepEqual(immutable.executionEnvelope.acceptanceIds, ["REQ-003"]);
  assert.deepEqual(immutable.executionEnvelope.evidenceRequirementIds, ["EV-003"]);
  assert.deepEqual(immutable.executionEnvelope.evidenceRequirements, [evidenceRequirement]);
  assert.deepEqual(immutable.executionEnvelope.acceptanceCriteria, runtimePackage.acceptanceCriteria);
  assert.deepEqual(immutable.executionEnvelope.commands, runtimePackage.commands);
  assert.equal(immutable.executionEnvelope.authorization.permissionPreflight.ok, true);
  assert.deepEqual(createDirectorWorkerContract(runtimePackage).executionEnvelope.acceptanceIds, ["REQ-003"]);

  const operationalAccess = providerExecutionAccess(dispatchedContract);
  assert.equal(operationalAccess.directorBound, true);
  assert.equal(operationalAccess.commandToolsEnabled, true);
  assert.equal(operationalAccess.commandMutationEnabled, true);
  assert.equal(buildAntigravityArgs(dispatchedContract, "fixture").includes("--dangerously-skip-permissions"), true);

  const effectTamper = { ...dispatchedContract, postconditions: ["Tampered postcondition."] };
  assert.equal(providerExecutionAccess(effectTamper).directorBound, false);
  assert.equal(buildAntigravityArgs(effectTamper, "fixture").includes("--dangerously-skip-permissions"), false);

  const allocationTamper = {
    ...dispatchedContract,
    provider: "claude",
    model: "claude-opus-4-8",
    allocation: { ...dispatchedContract.allocation, provider: "claude", model: "claude-opus-4-8" },
  };
  assert.equal(providerExecutionAccess(allocationTamper).directorBound, false, "Changing both mutable route and allocation must not bypass the immutable allocation binding.");

  const noCommandPackage = { ...runtimePackage, commands: [] };
  const noCommandContract = { ...dispatchedContract, commands: [], directorWorkerContract: createDirectorWorkerContract(noCommandPackage) };
  assert.equal(providerExecutionAccess(noCommandContract).commandMutationEnabled, false);
  assert.equal(buildAntigravityArgs(noCommandContract, "fixture").includes("--dangerously-skip-permissions"), false);

  const genericDenied = route({
    workspace,
    projectGoal: "Generic read-only command lane",
    goal: "Run an unbound command.",
    independenceReason: "Standalone generic lane.",
    workPlaneRequired: true,
    readOnly: true,
    relevantFiles: ["seed.txt"],
    expectedFiles: [],
    preferredProvider: "antigravity",
    allowAntigravity: true,
    complexity: "medium",
    taskKind: "live-state",
    requiredCapabilities: ["command"],
  }, resources, {});
  assert.equal(genericDenied.action, "direct");
  assert.match(genericDenied.reason, /granular headless permission surface/);

  process.stdout.write(JSON.stringify({
    ok: true,
    operationalTransactionDispatched: true,
  operationalLocalMutationExplicit: true,
    exactDirectorAntigravityAuthorization: true,
    genericCommandLaneStillDenied: true,
    authoritativeAcceptanceIds: dispatchedContract.acceptanceIds,
    evidenceRequirementIds: dispatchedContract.evidenceRequirementIds,
    allocationCaps: {
      timeoutSeconds: dispatchedContract.timeoutSeconds,
      estimatedDirectTokens: dispatchedContract.estimatedDirectTokens,
      maxWorkerOutputTokens: dispatchedContract.maxWorkerOutputTokens,
      maxAttempts: dispatchedContract.maxAttempts,
    },
  }, null, 2) + "\n");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
