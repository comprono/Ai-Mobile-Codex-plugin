#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { preflightAllocation } = require("./core/permission-preflight");
const { normalizeReceipt, validateTypedDeliverable } = require("./core/typed-deliverables");
const { createFailurePacket, recoveryPolicy, validateReconciliationDecision } = require("./core/failure-reconciler");
const { campaignContinuation, createCampaign, recordCampaignWake, startCampaign } = require("./core/campaign-engine");
const { buildProgramReport, reportTransition } = require("./core/program-reporting");
const { dependencyReadyPackages, planWorkPackages } = require("./core/team-compiler");

const plan = {
  planRevision: 3,
  workstreams: [
    {
      id: "ops",
      outcome: "Repair the database and restart the service safely",
      workType: "operation",
      milestoneIds: ["M1"],
      dependsOn: [],
      teamRoleIds: ["lead", "verifier"],
      permissionIds: ["ops-permission"],
      evidenceRequirementIds: ["E1"],
      resourceEstimateId: "B1",
      execution: {
        requiredPermissions: ["run-command", "database", "service-control"],
        preconditions: [{ name: "backup exists" }],
        postconditions: [{ name: "service healthy" }],
        rollback: { available: true },
        commands: [{ name: "preflight", command: "node", args: ["preflight.js"], timeoutSeconds: 30 }],
      },
    },
    {
      id: "verify",
      outcome: "Verify the real receipt flow",
      workType: "verification",
      milestoneIds: ["M2"],
      dependsOn: ["ops"],
      teamRoleIds: ["verifier"],
      permissionIds: ["read-permission"],
      evidenceRequirementIds: ["E2"],
      resourceEstimateId: "B2",
    },
  ],
  team: { roles: [
    { id: "lead", title: "Operations lead", modelClass: "strong", capabilities: ["service-control"], responsibilities: ["Safe repair"] },
    { id: "verifier", title: "Verifier", modelClass: "medium", capabilities: ["tests"], responsibilities: ["Independent proof"] },
  ] },
  permissions: [
    { id: "ops-permission", capability: "service database", mode: "execute" },
    { id: "read-permission", capability: "acceptance", mode: "read" },
  ],
  evidenceRequirements: [
    { id: "E1", description: "Operation receipt passes", level: "integration" },
    { id: "E2", description: "End-to-end receipt flow passes", level: "end-to-end" },
  ],
  resourceEstimates: [
    { id: "B1", inputTokens: 8000, outputTokens: 2000, wallClockMinutes: 40, ramMb: 512, diskMb: 256 },
    { id: "B2", inputTokens: 4000, outputTokens: 1000, wallClockMinutes: 20, ramMb: 256, diskMb: 64 },
  ],
};

const packages = planWorkPackages({
  masterPlan: plan,
  mission: { id: "mission-sample-project" },
  contextDossier: { contextRevision: 2, contextFingerprint: "context-fingerprint" },
});
assert.equal(packages.length, 2);
const legacyProjectToolsPlan = structuredClone(plan);
legacyProjectToolsPlan.workstreams[0].execution.requiredCapabilities = ["project-tools"];
const legacyProjectToolsPackages = planWorkPackages({
  masterPlan: legacyProjectToolsPlan,
  mission: { id: "mission-sample-project" },
  contextDossier: { contextRevision: 2, contextFingerprint: "context-fingerprint" },
});
assert.ok(legacyProjectToolsPackages[0].requiredCapabilities.includes("command"), "Legacy project-tools declarations must migrate to the callable command capability.");
assert.equal(legacyProjectToolsPackages[0].requiredCapabilities.includes("project-tools"), false, "The impossible project-tools pseudo-capability must not survive team compilation.");
assert.equal(packages[0].executorKind, "operational-transaction");
assert.equal(packages[0].deliverableKind, "operation-receipt");
assert.equal(packages[0].mutatesExternalState, false, "A local operational transaction must remain a disposable local mutation, not an external write.");
assert(packages[0].requiredPermissions.includes("database"));
assert.deepEqual(dependencyReadyPackages(packages).map((row) => row.workPackageId), [packages[0].workPackageId]);
assert.match(packages[0].workPackageId, /^wp-[a-f0-9]{10}-[a-f0-9]{12}$/);
const revisedPackages = planWorkPackages({
  masterPlan: { ...plan, planRevision: 4 },
  mission: { id: "mission-sample-project" },
  contextDossier: { contextRevision: 2, contextFingerprint: "context-fingerprint" },
});
assert.notEqual(revisedPackages[0].workPackageId, packages[0].workPackageId);
assert.deepEqual(revisedPackages[1].dependencies, [revisedPackages[0].workPackageId]);

const allocation = { permissionGrant: packages[0].requiredPermissions };
const authorization = packages[0].requiredPermissions;
const denied = preflightAllocation({
  workPackage: packages[0],
  allocation,
  authorizedPermissions: authorization,
  provider: {
    available: true,
    authenticated: true,
    headless: true,
    surfaces: { source: true, "local-files": true },
    permissions: { "run-command": false, database: false, "service-control": false },
  },
});
assert.equal(denied.ok, false);
assert(denied.missingProviderPermissions.includes("run-command"));
const allowed = preflightAllocation({
  workPackage: packages[0],
  allocation,
  authorizedPermissions: authorization,
  provider: {
    available: true,
    authenticated: true,
    headless: true,
    surfaces: { source: true, "local-files": true, tests: true, "service-control": true },
    permissions: { "run-command": true, database: true, "service-control": true },
  },
});
assert.equal(allowed.ok, true, allowed.blocker);
const allowedProviderCapabilityAlias = preflightAllocation({
  workPackage: packages[0],
  allocation,
  authorizedPermissions: authorization,
  provider: {
    available: true,
    authenticated: true,
    headless: true,
    surfaces: { source: true, "local-files": true, tests: true },
    permissions: { command: true, database: true, "service-control": true },
  },
});
assert.equal(allowedProviderCapabilityAlias.ok, true, allowedProviderCapabilityAlias.blocker);
const explicitPermissionDenialWins = preflightAllocation({
  workPackage: packages[0],
  allocation,
  authorizedPermissions: authorization,
  provider: {
    available: true,
    authenticated: true,
    headless: true,
    surfaces: { source: true, "local-files": true, tests: true },
    permissions: { command: true, "run-command": false, database: true, "service-control": true },
  },
});
assert.equal(explicitPermissionDenialWins.ok, false);
assert(explicitPermissionDenialWins.missingProviderPermissions.includes("run-command"));

const receipt = normalizeReceipt({
  kind: "operation-receipt",
  state: "applied",
  sideEffectKey: packages[0].sideEffectKey,
  beforeFingerprint: "before-state",
  afterFingerprint: "after-state",
  idempotency: { checked: true, key: packages[0].sideEffectKey, evidence: "No prior receipt existed" },
  preconditions: [{ name: "backup exists", passed: true, evidence: "backup-1" }],
  actions: [{ name: "repair and restart", passed: true, evidence: "operation-1" }],
  postconditions: [{ name: "service healthy", passed: true, evidence: "health-1" }],
  rollback: { available: true, executed: false, evidence: "backup-1" },
  evidence: ["health-1"],
}, "operation-receipt");
const typed = validateTypedDeliverable(packages[0], { deliverable: receipt, patchAvailable: false });
assert.equal(typed.ok, true, typed.blocker);

const failure = createFailurePacket({
  taskId: "task-fixture-12345678",
  missionId: "mission-sample-project",
  campaignId: "campaign-fixture",
  workPackage: packages[0],
  result: { jobId: "job-fixture", blocker: "no-patch-produced: operational work changed no files" },
  revisions: { context: 2, plan: 3, budget: 1, campaign: 1 },
  stateFingerprint: "before-state",
});
assert.equal(failure.failureClass, "director-contract");
assert.equal(recoveryPolicy(failure, []).action, "strong-reconciliation");
assert.equal(recoveryPolicy(failure, [failure]).action, "refresh-context-and-revise-plan");
assert.equal(validateReconciliationDecision({ rootCause: "Wrong executor", evidence: ["contract requested a patch"], retryEligibility: false }, failure).ok, false);
assert.equal(validateReconciliationDecision({
  rootCause: "Operational work was misclassified as code",
  evidence: ["The assignment required database and service operations"],
  changedContract: { executorKind: "operational-transaction", deliverableKind: "operation-receipt" },
  retryEligibility: true,
}, failure).ok, true);

let campaign = startCampaign(createCampaign({
  missionId: "mission-sample-project",
  epoch: 1,
  revisions: { context: 2, plan: 3, budget: 1 },
  evidence: [],
  noProgressLimit: 2,
  allocationIds: ["allocation-1"],
}));
const firstWake = recordCampaignWake(campaign, { reason: "worker-terminal", stateFingerprint: "worker-state-1", countForNoProgress: true });
assert.equal(firstWake.changed, true);
campaign = firstWake.campaign;
const duplicate = recordCampaignWake(campaign, { reason: "worker-terminal", stateFingerprint: "worker-state-1", countForNoProgress: true });
assert.equal(duplicate.changed, false);
assert.equal(campaignContinuation(campaign, { acceptanceImproved: true, reserveSafe: true, remainingWork: true }).allowed, true);
const stopped = recordCampaignWake(campaign, { reason: "dependency-change", stateFingerprint: "dependency-state-2", countForNoProgress: true });
assert.equal(stopped.campaign.state, "stopped");
assert.equal(campaignContinuation(stopped.campaign, { acceptanceImproved: true, reserveSafe: true, remainingWork: true }).allowed, false);
assert.equal(campaignContinuation(stopped.campaign, { acceptanceImproved: true, reserveSafe: true, remainingWork: true }).reason, "campaign-stopped");

const task = {
  taskId: "task-fixture-12345678",
  outcome: "Complete the sample project",
  state: "active",
  requirements: [
    { id: "REQ-003", required: true, status: "passing" },
    { id: "REQ-004", required: true, status: "failing" },
  ],
  program: {
    mission: { missionId: "mission-sample-project", outcome: "Complete the sample project", state: "active" },
    masterPlan: {
      milestones: [{ id: "M2", name: "Verify receipts", state: "active", targetAt: "2026-07-22T00:00:00Z" }],
      workstreams: [{ id: "verify", goal: "Verify receipts", state: "active", ownerRole: "Verifier" }],
    },
    resourceBudget: { revision: 1, allocations: [{ state: "active" }], reserves: { reconciliationPercent: 10 } },
    campaigns: [stopped.campaign],
    evidenceLedger: { entries: [{ requirementId: "REQ-003", level: "integration", ref: "receipt-1", summary: "Operation verified", passed: true }] },
    failureMemory: [failure],
    nextAction: "Run the independent receipt verifier",
  },
};
const report = buildProgramReport(task);
const transition = reportTransition({}, report);
assert.equal(transition.emit, true);
assert.equal(reportTransition(transition.cursor, report).emit, false);

process.stdout.write(JSON.stringify({
  ok: true,
  workPackages: packages.map((row) => row.executorKind),
  permissionPreflight: { denied: denied.failureClass, allowed: allowed.ok },
  receiptWithoutPatch: typed.ok,
  repeatedFailureAction: recoveryPolicy(failure, [failure]).action,
  campaignStop: stopped.campaign.stopReason,
  reportDeduplicated: true,
}, null, 2) + "\n");
