#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { decideIntake } = require("./core/intake-gate");
const { createSourceCatalog } = require("./core/source-catalog");
const {
  createContextScoutWorkPackage,
  decideContextRefresh,
  fingerprintSourceSnapshots,
  normalizeContextScoutArtifact,
} = require("./core/context-dossier");
const { adaptContextDossierV1 } = require("./core/program-contracts");
const { assessMasterPlan, createStrategyWorkPackage, normalizeMasterPlan } = require("./core/plan-assurance");
const { canonicalDirectorArtifact } = require("./core/worker");

const direct = decideIntake({ request: "Check the football score", expectedDurationSeconds: 25 });
assert.equal(direct.mode, "direct");
assert.equal(direct.orchestrationRequired, false);
const program = decideIntake({ request: "Read all project chats, build the architecture, then implement it over several days" });
assert.equal(program.mode, "program");
assert(program.complexSignals.includes("long-horizon"));
assert.equal(decideIntake({ request: "Build the project", override: "direct" }).mode, "direct");
assert.equal(decideIntake({ request: "Check the score", forceProgram: true }).mode, "program");

const catalog = createSourceCatalog({
  missionId: "mission-1",
  authorization: {
    projectContract: true,
    allowedTypes: ["chat", "file", "git", "log", "database", "service", "browser", "external"],
    authorizedBy: "fixture-user",
  },
  projectContract: true,
  chats: [{ id: "chat-1", threadId: "thread-passed-by-host", required: true }],
  files: [{ id: "source-code", path: "scripts/core", required: true }],
  git: [{ id: "git-state", locator: "workspace-git", access: "metadata" }],
  logs: [{ id: "runtime-log", path: "service.log" }],
  databases: [{ id: "project-db", connectionName: "sample-project", access: "metadata" }],
  services: [{ id: "project-service", serviceName: "sample-project-service", access: "observe" }],
  browsers: [{ id: "browser-session", sessionId: "existing-session", access: "observe" }],
  external: [{ id: "receipt-store", uri: "external://receipts", access: "read" }],
});
assert.equal(catalog.sources.length, 10);
assert.equal(catalog.sources.find((row) => row.id === "chat-1").collectionPolicy, "passed-descriptor-only");
const deniedCatalog = createSourceCatalog({ missionId: "mission-1", chats: [{ id: "secret-chat", threadId: "not-authorized" }] });
assert.equal(deniedCatalog.sources.length, 0);
assert.equal(deniedCatalog.rejectedSources[0].reason, "source-type-not-authorized");

const projectDbSnapshotHash = "a".repeat(64);
const projectDbReceiptFingerprint = "b".repeat(64);
const databaseObservationReceipts = {
  "project-db": {
    receiptFingerprint: projectDbReceiptFingerprint,
    snapshotContentHash: projectDbSnapshotHash,
  },
};
const receiptValidation = { databaseObservationReceipts };

const workPackage = createContextScoutWorkPackage({
  mission: { id: "mission-1", revision: 1, outcome: "The sample project completes real work reliably" },
  sourceCatalog: catalog,
  sourceSnapshotManifest: {
    schemaVersion: "director-cfo/source-snapshot-manifest@1",
    workspace: "fixture",
    snapshots: catalog.sources.map((source) => ({
      sourceId: source.id,
      state: "available",
      fingerprint: "fp-" + source.id,
      ...(source.type === "database" ? { contentHash: projectDbSnapshotHash } : {}),
    })),
    fingerprint: "fixture-snapshot-manifest",
  },
});
assert(workPackage.prompt.includes("Do not discover"));
assert(workPackage.prompt.includes("thread-passed-by-host"));
const sourceObservations = catalog.sources.map((source) => ({
  sourceId: source.id,
  status: "observed",
  fingerprint: `fp-${source.id}`,
  summary: `Observed ${source.id}`,
  ...(source.type === "database" ? {
    queryReceiptFingerprint: projectDbReceiptFingerprint,
    queryReceiptSnapshotHash: projectDbSnapshotHash,
  } : {}),
}));
const dossier = normalizeContextScoutArtifact({
  kind: "context-scout",
  realGoal: "Complete the sample project with authoritative evidence",
  executiveSummary: "The project requires an operational lane and a code/evidence lane.",
  currentState: [{ text: "Three of five requirements pass.", sourceIds: ["project-acceptance"] }],
  facts: [
    { text: "The service has a recorded failure.", sourceIds: ["runtime-log"] },
    { text: "The database receipt records the current bounded canonical state.", sourceIds: ["project-db"] },
  ],
  decisions: [{ text: "Plugin restart is deferred.", sourceIds: ["chat-1"] }],
  failures: [{ text: "An operational task was treated as a patch task.", sourceIds: ["chat-1", "runtime-log"] }],
  assumptions: [{ text: "The service can be restarted after preflight." }],
  unknowns: [{ text: "Current provider quotas must be refreshed." }],
  constraints: [{ text: "No undeclared source access." }],
  risks: [{ text: "A repeated operation could duplicate side effects." }],
  acceptanceState: [{ text: "Two requirements remain." }],
  sourceObservations,
}, workPackage, receiptValidation);
assert.equal(dossier.contextRevision, 1);
assert.equal(Object.keys(dossier.sourceFingerprints).length, catalog.sources.length);
assert.equal(dossier.sourceObservations.find((row) => row.sourceId === "project-db").queryReceiptFingerprint, projectDbReceiptFingerprint);
const directorBoundReceipt = normalizeContextScoutArtifact({
  ...dossier,
  kind: "context-scout",
  sourceObservations: dossier.sourceObservations.map((row) => row.sourceId === "project-db"
    ? { ...row, queryReceiptFingerprint: "" }
    : row),
}, workPackage, receiptValidation);
assert.equal(directorBoundReceipt.sourceObservations.find((row) => row.sourceId === "project-db").queryReceiptFingerprint, projectDbReceiptFingerprint, "A missing copied receipt fingerprint must bind to the immutable Director receipt only after the source fingerprint and snapshot hash match.");
const canonicalHandoffArtifact = canonicalDirectorArtifact({ deliverableKind: "context-dossier", directorWorkerContract: { bootstrapContract: workPackage }, contextObservationReceiptExpectations: receiptValidation.databaseObservationReceipts }, { ...dossier, kind: "context-scout", sourceObservations: dossier.sourceObservations.map((row) => row.sourceId === "project-db" ? { ...row, queryReceiptFingerprint: "" } : row) });
assert.equal(canonicalHandoffArtifact.sourceObservations.find((row) => row.sourceId === "project-db").queryReceiptFingerprint, projectDbReceiptFingerprint, "The durable worker handoff must persist the same canonical receipt fingerprint integrated by the Director.");
const projectDbDescriptorFingerprint = catalog.sources.find((row) => row.id === "project-db").descriptorFingerprint;
const descriptorAliasReceipt = normalizeContextScoutArtifact({
  ...dossier,
  kind: "context-scout",
  sourceObservations: dossier.sourceObservations.map((row) => row.sourceId === "project-db"
    ? { ...row, queryReceiptFingerprint: projectDbDescriptorFingerprint }
    : row),
}, workPackage, receiptValidation);
assert.equal(descriptorAliasReceipt.sourceObservations.find((row) => row.sourceId === "project-db").queryReceiptFingerprint, projectDbReceiptFingerprint, "The exact immutable source-descriptor fingerprint may be corrected to the Director receipt fingerprint after the source and snapshot hashes match.");
const sourceAliasReceipt = normalizeContextScoutArtifact({ ...dossier, kind: "context-scout", sourceObservations: dossier.sourceObservations.map((row) => row.sourceId === "project-db" ? { ...row, queryReceiptFingerprint: row.fingerprint } : row) }, workPackage, receiptValidation);
assert.equal(sourceAliasReceipt.sourceObservations.find((row) => row.sourceId === "project-db").queryReceiptFingerprint, projectDbReceiptFingerprint, "The exact immutable source snapshot fingerprint may be corrected to the Director receipt fingerprint after the content hash matches.");
assert.throws(() => normalizeContextScoutArtifact({
  ...dossier,
  kind: "context-scout",
  sourceObservations: dossier.sourceObservations.map((row) => row.sourceId === "project-db"
    ? { ...row, queryReceiptFingerprint: "", queryReceiptSnapshotHash: "f".repeat(64) }
    : row),
}, workPackage, receiptValidation), /snapshot hash does not match/);
assert.throws(() => normalizeContextScoutArtifact({
  ...dossier,
  kind: "context-scout",
  sourceObservations: dossier.sourceObservations.map((row) => row.sourceId === "project-db"
    ? { ...row, queryReceiptFingerprint: "c".repeat(64) }
    : row),
}, workPackage, receiptValidation), /query receipt does not match/);
assert.throws(() => normalizeContextScoutArtifact({
  ...dossier,
  kind: "context-scout",
  facts: dossier.facts.filter((row) => !row.sourceIds.includes("project-db")),
}, workPackage, receiptValidation), /query-receipt-backed cited claim/);
assert.throws(() => normalizeContextScoutArtifact({ ...dossier, kind: "context-scout" }, workPackage), /no Director query receipt expectation/);

const snapshottedTypes = new Set(["project-outcome", "acceptance", "chat", "file", "git", "log", "database"]);
const blockingTypes = new Set(["project-outcome", "acceptance", "chat", "file", "git"]);
const realShapeDbSnapshotHash = "d".repeat(64);
const realShapeDbReceiptFingerprint = "e".repeat(64);
const realShapeReceiptValidation = {
  databaseObservationReceipts: {
    "project-db": {
      receiptFingerprint: realShapeDbReceiptFingerprint,
      snapshotContentHash: realShapeDbSnapshotHash,
    },
  },
};
const realShapeSnapshots = catalog.sources
  .filter((source) => snapshottedTypes.has(source.type))
  .map((source) => ({
    sourceId: source.id,
    state: "available",
    fingerprint: source.descriptorFingerprint,
    ...(source.type === "database" ? { contentHash: realShapeDbSnapshotHash } : {}),
  }));
const realShapeWorkPackage = createContextScoutWorkPackage({
  mission: workPackage.mission,
  sourceCatalog: catalog,
  sourceSnapshotManifest: {
    schemaVersion: "director-cfo/source-snapshot-manifest@1",
    workspace: "immutable-fixture",
    snapshots: realShapeSnapshots,
    fingerprint: "real-shaped-snapshot-manifest",
  },
});
const realShapedArtifact = {
  realGoal: "Complete the real project from authoritative context.",
  executiveSummary: "Recovered the exact worker output shape returned by the Job Vibhu clone.",
  currentState: {
    sliceId: "REQ-003",
    status: "blocked",
    summary: "The current acceptance slice is blocked pending stronger evidence.",
    activeBranchOrRevision: "fixture-revision",
    sourcesInspected: realShapeSnapshots.map((row) => row.sourceId),
  },
  sourceObservations: catalog.sources.map((source) => snapshottedTypes.has(source.type) ? {
    sourceId: source.id,
    state: "available",
    fingerprint: source.descriptorFingerprint,
    revision: source.type === "git" ? "fixture-revision" : "",
    observation: `Observed ${source.id} from the immutable Director snapshot.`,
    ...(source.type === "database" ? {
      queryReceiptFingerprint: realShapeDbReceiptFingerprint,
      queryReceiptSnapshotHash: realShapeDbSnapshotHash,
    } : {}),
  } : {
    sourceId: source.id,
    state: "unavailable",
    observation: "Dynamic observation has no typed Director receipt.",
  }),
  facts: [
    { claim: "A canonical receipt already exists.", sourceId: "project-acceptance" },
    { claim: "The database receipt contains a bounded canonical-state sample.", sourceId: "project-db" },
  ],
  assumptions: [{ observation: "The runtime can recover after preflight.", sourceId: "runtime-log" }],
  unknowns: [{ claim: "Current live service health remains unknown.", sourceId: "project-service" }],
  constraints: ["Never invent project facts."],
  decisions: [{ decision: "Repair the earliest acceptance blocker first.", sourceId: "project-outcome" }],
  failures: [{ failure: "The runner failed its startup preflight.", sourceId: "runtime-log" }],
  risks: ["A repeated external action could duplicate side effects."],
  acceptanceState: [{ summary: "Two requirements remain.", sourceId: "project-acceptance" }],
};
const realShapeDossier = normalizeContextScoutArtifact(realShapedArtifact, realShapeWorkPackage, realShapeReceiptValidation);
assert.equal(realShapeDossier.currentState.length, 1);
assert.equal(realShapeDossier.currentState[0].text, realShapedArtifact.currentState.summary);
assert.deepEqual(realShapeDossier.currentState[0].sourceIds, realShapedArtifact.currentState.sourcesInspected);
assert.equal(realShapeDossier.facts[0].text, realShapedArtifact.facts[0].claim);
assert.equal(realShapeDossier.decisions[0].text, realShapedArtifact.decisions[0].decision);
assert.equal(realShapeDossier.failures[0].text, realShapedArtifact.failures[0].failure);
assert.equal(realShapeDossier.assumptions[0].text, realShapedArtifact.assumptions[0].observation);
assert.deepEqual(realShapeDossier.unknowns[0].sourceIds, ["project-service"]);
assert.equal(realShapeDossier.sourceObservations.find((row) => row.sourceId === "project-outcome").status, "observed");
assert.match(realShapeDossier.sourceObservations.find((row) => row.sourceId === "project-outcome").summary, /immutable Director snapshot/);

const requiredBlockingSourceIds = catalog.sources
  .filter((source) => source.required && blockingTypes.has(source.type))
  .map((source) => source.id);
const canonicalRealShape = adaptContextDossierV1(realShapeDossier, {
  missionId: workPackage.mission.id,
  requiredSourceIds: requiredBlockingSourceIds,
});
assert.equal(canonicalRealShape.state, "ready", "Unavailable service, browser, and external observations must not stale the dossier.");
assert.equal(canonicalRealShape.coverageComplete, true);

const nonBlockingSnapshotsUnavailable = {
  ...realShapeDossier,
  sourceObservations: realShapeDossier.sourceObservations.map((row) => {
    const type = catalog.sources.find((source) => source.id === row.sourceId)?.type;
    return ["log", "database"].includes(type) ? { ...row, status: "unavailable", fingerprint: "" } : row;
  }),
};
assert.equal(adaptContextDossierV1(nonBlockingSnapshotsUnavailable, {
  missionId: workPackage.mission.id,
  requiredSourceIds: requiredBlockingSourceIds,
}).state, "ready", "Log and database availability must not define required context coverage.");

const blockingGitUnavailable = {
  ...realShapeDossier,
  sourceObservations: realShapeDossier.sourceObservations.map((row) => (
    row.sourceId === "git-state" ? { ...row, status: "unavailable", fingerprint: "" } : row
  )),
};
assert.equal(adaptContextDossierV1(blockingGitUnavailable, {
  missionId: workPackage.mission.id,
  requiredSourceIds: requiredBlockingSourceIds,
}).state, "stale", "An unavailable required Git snapshot must keep context stale.");
assert.equal(adaptContextDossierV1(realShapeDossier, {
  missionId: workPackage.mission.id,
  requiredSourceIds: [],
}).state, "ready", "An explicit empty blocking-source set must not fall back to every observation.");

assert.throws(() => normalizeContextScoutArtifact({
  realGoal: "Invent context",
  executiveSummary: "Bad",
  currentState: [{ text: "Claim", sourceIds: ["unknown-chat"] }],
  sourceObservations,
}, workPackage, receiptValidation), /undeclared source/);

const currentFingerprints = fingerprintSourceSnapshots(catalog, catalog.sources.map((source) => ({ sourceId: source.id, contentHash: `hash-${source.id}` })));
const unchangedDossier = { ...dossier, catalogFingerprint: catalog.catalogFingerprint, sourceFingerprints: currentFingerprints };
assert.equal(decideContextRefresh({ sourceCatalog: catalog, previousDossier: unchangedDossier, currentSourceFingerprints: currentFingerprints, missionRevision: 1 }).mode, "none");
const changedFingerprints = { ...currentFingerprints, "runtime-log": "changed" };
const incremental = decideContextRefresh({ sourceCatalog: catalog, previousDossier: unchangedDossier, currentSourceFingerprints: changedFingerprints, missionRevision: 1 });
assert.equal(incremental.mode, "incremental");
assert.deepEqual(incremental.changedSourceIds, ["runtime-log"]);
assert.equal(decideContextRefresh({ sourceCatalog: catalog, previousDossier: unchangedDossier, currentSourceFingerprints: changedFingerprints, missionRevision: 1, repeatedFailureCount: 2 }).mode, "full");

const authoritativeRequirements = [
  { id: "REQ-OPS", description: "The guarded operational repair is integrated.", required: true, status: "failing", minimumEvidenceLevel: "integration" },
  { id: "REQ-VISIBLE", description: "The user-visible workflow completes.", required: true, status: "failing", minimumEvidenceLevel: "user-visible" },
];
const availableProjectFiles = [
  ".codex/ACCEPTANCE.json",
  "scripts/sample-project-healthcheck.js",
  "scripts/sample-project-repair.js",
  "scripts/validate-outcome.js",
];
const strategy = createStrategyWorkPackage({ mission: workPackage.mission, contextDossier: dossier, requirements: authoritativeRequirements, availableSourceFiles: availableProjectFiles });
assert.match(strategy.prompt, /never synthesize plausible or placeholder paths/);
assert.equal(
  strategy.artifactContract.jsonSchema.properties.workstreams.items.properties.execution.properties.requiredCapabilities.items.enum.includes("project-tools"),
  false,
  "The strategist schema must not offer the non-callable project-tools pseudo-capability.",
);
assert.ok(
  strategy.artifactContract.jsonSchema.properties.workstreams.items.properties.execution.properties.requiredCapabilities.items.enum.includes("command"),
  "The strategist schema must offer the observed callable command capability.",
);
const expectedPlan = {
  missionId: strategy.mission.id,
  missionRevision: strategy.mission.revision,
  contextRevision: strategy.context.revision,
  contextFingerprint: strategy.context.fingerprint,
  authoritativeRequirements,
  availableSourceFiles: availableProjectFiles,
};
const validPlan = {
  schemaVersion: "director-cfo/master-plan@1",
  planRevision: 1,
  mission: { id: "mission-1", revision: 1, outcome: workPackage.mission.outcome },
  context: { revision: dossier.contextRevision, fingerprint: dossier.contextFingerprint },
  objective: "Complete the remaining sample-project acceptance requirements.",
  timeline: { totalEstimatedMinutes: 120, assumptions: ["Capacity remains available"], windows: [
    { milestoneId: "M1", startAfterMinute: 0, durationMinutes: 60 },
    { milestoneId: "M2", startAfterMinute: 60, durationMinutes: 60 },
  ] },
  milestones: [
    { id: "M1", outcome: "Repair runtime state", dependsOn: [], workstreamIds: ["W1"], evidenceRequirementIds: ["E1"], acceptanceCriteria: ["Service preflight and receipt pass"] },
    { id: "M2", outcome: "Verify durable completion", dependsOn: ["M1"], workstreamIds: ["W2"], evidenceRequirementIds: ["E2"], acceptanceCriteria: ["End-to-end verification passes"] },
  ],
  dependencies: [{ id: "D1", fromMilestoneId: "M1", toMilestoneId: "M2", condition: "Runtime repair evidence E1 is accepted" }],
  workstreams: [
    {
      id: "W1",
      outcome: "Perform guarded operational repair",
      workType: "operation",
      milestoneIds: ["M1"],
      dependsOn: [],
      teamRoleIds: ["R1", "R2"],
      permissionIds: ["P1"],
      evidenceRequirementIds: ["E1"],
      resourceEstimateId: "B1",
      execution: {
        executorKind: "operational-transaction",
        deliverableKind: "operation-receipt",
        relevantFiles: [],
        expectedFiles: [],
        verificationCommands: [{ command: "node", args: ["scripts/sample-project-healthcheck.js"], timeoutSeconds: 120, cwd: "." }],
        requiredCapabilities: ["service-operations", "database"],
        requiredPermissions: ["run-command", "service-control", "database"],
        preconditions: ["The side-effect key has no accepted receipt", "Current service and database state is fingerprinted"],
        postconditions: ["The service health check passes", "The database state matches the repair contract"],
        commands: [{ command: "node", args: ["scripts/sample-project-repair.js"], timeoutSeconds: 300, cwd: "." }],
        rollback: { description: "Restore the pre-operation state snapshot", commands: [] },
        recoveryAction: "",
        mutatesExternalState: false,
        sideEffectKey: "sample-project-runtime-repair-v1",
        observedStateFingerprint: dossier.contextFingerprint,
        userAuthorizationRef: "fixture-user-authorization",
        successProbability: 0.75,
      },
    },
    {
      id: "W2",
      outcome: "Run independent acceptance",
      workType: "verification",
      milestoneIds: ["M2"],
      dependsOn: ["W1"],
      teamRoleIds: ["R2"],
      permissionIds: ["P2"],
      evidenceRequirementIds: ["E2"],
      resourceEstimateId: "B2",
      execution: {
        executorKind: "verification",
        deliverableKind: "verification-result",
        relevantFiles: [".codex/ACCEPTANCE.json"],
        expectedFiles: [],
        verificationCommands: [],
        requiredCapabilities: ["verification"],
        requiredPermissions: ["read-project"],
        preconditions: [],
        postconditions: [],
        commands: [{ command: "node", args: ["scripts/validate-outcome.js"], timeoutSeconds: 120, cwd: "." }],
        rollback: null,
        recoveryAction: "",
        mutatesExternalState: false,
        sideEffectKey: "",
        observedStateFingerprint: "",
        userAuthorizationRef: "",
        successProbability: 0.9,
      },
    },
  ],
  team: { roles: [
    { id: "R1", title: "Operations lead", modelClass: "strong", capabilities: ["service-operations"], responsibilities: ["Repair runtime safely"], workstreamIds: ["W1"], permissionIds: ["P1"] },
    { id: "R2", title: "Verifier", modelClass: "medium", capabilities: ["verification"], responsibilities: ["Verify receipts and acceptance"], workstreamIds: ["W1", "W2"], permissionIds: ["P1", "P2"] },
  ] },
  permissions: [
    { id: "P1", capability: "service-and-database", mode: "execute", scope: "Sample project service and database", reason: "Perform the planned repair", required: true },
    { id: "P2", capability: "acceptance-read", mode: "read", scope: "Acceptance evidence", reason: "Verify completion", required: true },
  ],
  risks: [{ id: "K1", description: "Duplicate operational side effects", likelihood: "medium", impact: "high", ownerRoleId: "R1", trigger: "Operation receipt already exists", mitigation: "Use an idempotency key and preflight" }],
  recovery: [{ id: "REC1", trigger: "Evidence does not improve", failureClasses: ["context", "plan", "permission", "worker"], action: "Reconcile root cause and materially revise the contract", ownerRoleId: "R1", evidenceRequirementId: "E2" }],
  evidenceRequirements: [
    { id: "E1", milestoneId: "M1", description: "Operational receipt and healthy service", level: "integration", proofType: "operation-receipt", verifierRoleId: "R2", acceptanceRequirementIds: ["REQ-OPS"] },
    { id: "E2", milestoneId: "M2", description: "User-visible workflow completes", level: "user-visible", proofType: "acceptance-run", verifierRoleId: "R2", acceptanceRequirementIds: ["REQ-VISIBLE"] },
  ],
  resourceEstimates: [
    { id: "B1", workstreamId: "W1", modelClass: "strong", attempts: 1, inputTokens: 12000, outputTokens: 4000, wallClockMinutes: 60, concurrency: 1, ramMb: 1024, diskMb: 512, includesVerification: true, includesReconciliationReserve: true },
    { id: "B2", workstreamId: "W2", modelClass: "medium", attempts: 1, inputTokens: 6000, outputTokens: 2000, wallClockMinutes: 60, concurrency: 1, ramMb: 512, diskMb: 256, includesVerification: true, includesReconciliationReserve: false },
  ],
};
const assurance = assessMasterPlan(validPlan, expectedPlan);
assert.equal(assurance.valid, true, assurance.errors.join("\n"));
assert(assurance.plan.planFingerprint);
assert.equal(assurance.plan.workstreams[0].execution.executorKind, "operational-transaction");
assert.equal(assurance.plan.workstreams[0].execution.deliverableKind, "operation-receipt");
assert.equal(assurance.plan.workstreams[0].execution.mutatesExternalState, false, "A local operational transaction must not be relabeled as an external mutation.");
const executorBoundExpectedPlan = {
  ...expectedPlan,
  authoritativeRequirements: authoritativeRequirements.map((row) => row.id === "REQ-OPS"
    ? { ...row, requiredExecutorKinds: ["operational-transaction"] }
    : { ...row, requiredExecutorKinds: ["verification"] }),
};
assert.equal(assessMasterPlan(validPlan, executorBoundExpectedPlan).valid, true);
const wrongExecutorRoute = JSON.parse(JSON.stringify(validPlan));
wrongExecutorRoute.workstreams[0].execution.executorKind = "context-scout";
wrongExecutorRoute.workstreams[0].execution.deliverableKind = "context-dossier";
const rejectedExecutorRoute = assessMasterPlan(wrongExecutorRoute, executorBoundExpectedPlan);
assert.equal(rejectedExecutorRoute.valid, false);
assert(rejectedExecutorRoute.errors.some((row) => row.includes("REQ-OPS") && row.includes("operational-transaction")));

const inventedDiscoveryPlan = JSON.parse(JSON.stringify(validPlan));
inventedDiscoveryPlan.workstreams[1].workType = "context";
inventedDiscoveryPlan.workstreams[1].execution.executorKind = "context-scout";
inventedDiscoveryPlan.workstreams[1].execution.deliverableKind = "context-dossier";
inventedDiscoveryPlan.workstreams[1].execution.relevantFiles = ["path/to/placeholder.json"];
inventedDiscoveryPlan.workstreams[1].execution.expectedFiles = ["context_dossier.json"];
const rejectedInventedDiscovery = assessMasterPlan(inventedDiscoveryPlan, expectedPlan);
assert.equal(rejectedInventedDiscovery.valid, false);
assert(rejectedInventedDiscovery.errors.some((row) => row.includes("unavailable or invented project file")));
assert.deepEqual(normalizeMasterPlan(inventedDiscoveryPlan).workstreams[1].execution.expectedFiles, []);

const missingIntermediateEvidence = JSON.parse(JSON.stringify(validPlan));
missingIntermediateEvidence.milestones[0].evidenceRequirementIds = [];
missingIntermediateEvidence.workstreams[0].evidenceRequirementIds = [];
missingIntermediateEvidence.evidenceRequirements[0].milestoneId = "M2";
const preservedIntermediatePlan = assessMasterPlan(missingIntermediateEvidence, expectedPlan);
assert.equal(preservedIntermediatePlan.valid, true, preservedIntermediatePlan.errors.join("\n"));
const syntheticIntermediateEvidence = preservedIntermediatePlan.plan.evidenceRequirements.find((row) => row.milestoneId === "M1");
assert.equal(syntheticIntermediateEvidence.level, "activity", "Only an activity-level requirement may be synthesized for an omitted intermediate evidence link.");
assert.deepEqual(preservedIntermediatePlan.plan.evidenceRequirements.filter((row) => ["E1", "E2"].includes(row.id)).map((row) => row.level), ["integration", "user-visible"], "Deterministic intermediate repair must never upgrade or replace final acceptance evidence floors.");
assert.deepEqual(preservedIntermediatePlan.plan.workstreams[0].evidenceRequirementIds, [syntheticIntermediateEvidence.id]);

const redundantDependencyIdPlan = JSON.parse(JSON.stringify(validPlan));
redundantDependencyIdPlan.milestones[1].dependsOn = ["D1"];
const normalizedDependencyIdPlan = assessMasterPlan(redundantDependencyIdPlan, expectedPlan);
assert.equal(normalizedDependencyIdPlan.valid, true, normalizedDependencyIdPlan.errors.join("\n"));
assert.deepEqual(normalizedDependencyIdPlan.plan.milestones[1].dependsOn, ["M1"], "Redundant dependency IDs must normalize to their predecessor milestone IDs.");
const omittedRedundantDependencyPlan = JSON.parse(JSON.stringify(validPlan));
omittedRedundantDependencyPlan.milestones[1].dependsOn = [];
const completedDependencyPlan = assessMasterPlan(omittedRedundantDependencyPlan, expectedPlan);
assert.equal(completedDependencyPlan.valid, true, completedDependencyPlan.errors.join("\n"));
assert.deepEqual(completedDependencyPlan.plan.milestones[1].dependsOn, ["M1"], "Dependency edges must deterministically complete the redundant milestone link.");

const unboundedCode = JSON.parse(JSON.stringify(validPlan));
unboundedCode.workstreams[1].workType = "code";
unboundedCode.workstreams[1].execution.executorKind = "code-change";
unboundedCode.workstreams[1].execution.deliverableKind = "patch";
unboundedCode.workstreams[1].execution.expectedFiles = [];
unboundedCode.workstreams[1].execution.verificationCommands = [];
const rejectedCode = assessMasterPlan(unboundedCode, expectedPlan);
assert.equal(rejectedCode.valid, false);
assert(rejectedCode.errors.some((row) => row.includes("expectedFiles must bound code output")));
assert(rejectedCode.errors.some((row) => row.includes("deterministic verification")));
assert(rejectedCode.errors.some((row) => row.includes("preconditions must define")));
assert(rejectedCode.errors.some((row) => row.includes("postconditions must define")));

const broadCode = JSON.parse(JSON.stringify(validPlan));
broadCode.workstreams[1].workType = "code";
broadCode.workstreams[1].execution.executorKind = "code-change";
broadCode.workstreams[1].execution.deliverableKind = "patch";
broadCode.workstreams[1].execution.relevantFiles = [".codex/ACCEPTANCE.json"];
broadCode.workstreams[1].execution.expectedFiles = [".codex/ACCEPTANCE.json"];
broadCode.workstreams[1].execution.verificationCommands = [{ command: "node", args: ["scripts/validate-outcome.js"], timeoutSeconds: 120 }];
broadCode.workstreams[1].execution.preconditions = ["The acceptance revision still matches the strategy context."];
broadCode.workstreams[1].execution.postconditions = ["The deterministic outcome validation passes."];
broadCode.workstreams[1].evidenceRequirementIds = ["E1", "E2", "E3"];
broadCode.evidenceRequirements.push({
  id: "E3",
  milestoneId: "M2",
  description: "A third acceptance outcome passes.",
  level: "integration",
  proofType: "test-log",
  verifierRoleId: "R2",
  acceptanceRequirementIds: ["REQ-THREE"],
});
const broadCodeExpected = {
  ...expectedPlan,
  authoritativeRequirements: [
    ...authoritativeRequirements,
    { id: "REQ-THREE", description: "A third acceptance outcome passes.", required: true, status: "failing", minimumEvidenceLevel: "integration" },
  ],
};
const rejectedBroadCode = assessMasterPlan(broadCode, broadCodeExpected);
assert.equal(rejectedBroadCode.valid, false);
assert(rejectedBroadCode.errors.some((row) => row.includes("split code work into bounded slices covering at most 2")));

const inventedCodeTarget = JSON.parse(JSON.stringify(validPlan));
inventedCodeTarget.workstreams[1].workType = "code";
inventedCodeTarget.workstreams[1].execution.executorKind = "code-change";
inventedCodeTarget.workstreams[1].execution.deliverableKind = "patch";
inventedCodeTarget.workstreams[1].execution.relevantFiles = [];
inventedCodeTarget.workstreams[1].execution.expectedFiles = ["parser.py"];
inventedCodeTarget.workstreams[1].execution.verificationCommands = [{ command: "pytest", args: ["tests/test_parser.py"], timeoutSeconds: 30 }];
const rejectedInventedCodeTarget = assessMasterPlan(inventedCodeTarget, expectedPlan);
assert.equal(rejectedInventedCodeTarget.valid, false);
assert(rejectedInventedCodeTarget.errors.some((row) => row.includes("invented output parser.py")));
assert(rejectedInventedCodeTarget.errors.some((row) => row.includes("invented project file tests/test_parser.py")));

const inventedOperationCommand = JSON.parse(JSON.stringify(validPlan));
inventedOperationCommand.workstreams[0].execution.commands = [{ command: "python", args: ["Jobs Harness/repair.py"], timeoutSeconds: 60 }];
const rejectedInventedOperationCommand = assessMasterPlan(inventedOperationCommand, expectedPlan);
assert.equal(rejectedInventedOperationCommand.valid, false);
assert(rejectedInventedOperationCommand.errors.some((row) => row.includes("invented project file Jobs Harness/repair.py")));

const unsafeOperation = JSON.parse(JSON.stringify(validPlan));
unsafeOperation.workstreams[0].execution.preconditions = [];
unsafeOperation.workstreams[0].execution.postconditions = [];
unsafeOperation.workstreams[0].execution.rollback = null;
unsafeOperation.workstreams[0].execution.recoveryAction = "";
unsafeOperation.workstreams[0].execution.sideEffectKey = "";
unsafeOperation.workstreams[0].execution.observedStateFingerprint = "";
const rejectedOperation = assessMasterPlan(unsafeOperation, expectedPlan);
assert.equal(rejectedOperation.valid, false);
assert(rejectedOperation.errors.some((row) => row.includes("preconditions are required")));
assert(rejectedOperation.errors.some((row) => row.includes("rollback or recoveryAction")));
assert(rejectedOperation.errors.some((row) => row.includes("sideEffectKey is required")));

const unauthorizedExternal = JSON.parse(JSON.stringify(validPlan));
unauthorizedExternal.workstreams[0].workType = "external";
unauthorizedExternal.workstreams[0].execution.executorKind = "external-transaction";
unauthorizedExternal.workstreams[0].execution.deliverableKind = "external-transaction-receipt";
unauthorizedExternal.workstreams[0].execution.userAuthorizationRef = "";
const rejectedExternal = assessMasterPlan(unauthorizedExternal, expectedPlan);
assert.equal(rejectedExternal.valid, false);
assert(rejectedExternal.errors.some((row) => row.includes("userAuthorizationRef is required")));

const incompatibleDelivery = JSON.parse(JSON.stringify(validPlan));
incompatibleDelivery.workstreams[1].execution.deliverableKind = "patch";
const rejectedDelivery = assessMasterPlan(incompatibleDelivery, expectedPlan);
assert.equal(rejectedDelivery.valid, false);
assert(rejectedDelivery.errors.some((row) => row.includes("incompatible")));
const invalid = JSON.parse(JSON.stringify(validPlan));
delete invalid.timeline;
invalid.workstreams[0].permissionIds = ["invented-permission"];
invalid.resourceEstimates.forEach((row) => { row.includesReconciliationReserve = false; });
const rejected = assessMasterPlan(invalid, expectedPlan);
assert.equal(rejected.valid, false);
assert(rejected.errors.some((row) => row.includes("timeline")));
assert(rejected.errors.some((row) => row.includes("invented-permission")));
assert(rejected.errors.some((row) => row.includes("reconciliation reserve")));

const inventedRequirement = JSON.parse(JSON.stringify(validPlan));
inventedRequirement.evidenceRequirements[0].acceptanceRequirementIds = ["REQ-INVENTED"];
const rejectedInventedRequirement = assessMasterPlan(inventedRequirement, expectedPlan);
assert.equal(rejectedInventedRequirement.valid, false);
assert(rejectedInventedRequirement.errors.some((row) => row.includes("unknown id REQ-INVENTED")));

const omittedRequirement = JSON.parse(JSON.stringify(validPlan));
omittedRequirement.evidenceRequirements[1].acceptanceRequirementIds = ["REQ-OPS"];
const rejectedOmittedRequirement = assessMasterPlan(omittedRequirement, expectedPlan);
assert.equal(rejectedOmittedRequirement.valid, false);
assert(rejectedOmittedRequirement.errors.some((row) => row.includes("omits authoritative acceptance requirement REQ-VISIBLE")));

process.stdout.write(`${JSON.stringify({
  ok: true,
  intake: { direct: direct.mode, program: program.mode },
  authorizedSources: catalog.sources.length,
  contextFingerprint: dossier.contextFingerprint,
  refresh: { unchanged: "none", changed: incremental.mode, repeatedFailure: "full" },
  planSectionsAssured: 10,
  invalidPlanErrors: rejected.errors.length,
}, null, 2)}\n`);
