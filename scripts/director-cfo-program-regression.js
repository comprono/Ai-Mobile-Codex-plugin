#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  directorProgramSummary,
  emitProgramReport,
  integrateDirectorArtifact,
  integrateDirectorJob,
  prepareProgramDispatch,
  recordProgramFailure,
  startDirectorProgram,
} = require("./core/director-cfo-orchestrator");
const { contextRefreshRequested, validateReconciliationDecision } = require("./core/failure-reconciler");
const { assertIntegrationFence } = require("./core/program-contracts");
const { createDirectorWorkerContract } = require("./core/director-worker-contract");
const { jobDirectory, readTask, updateTask } = require("./core/state-store");
const { collectRound, dispatchRound, integrateRound, reconcileTask, recordEvidence } = require("./core/task-orchestrator");
const { readJson, writeJson } = require("./core/utils");
const { buildAntigravityArgs } = require("./providers");

function provider(id, model, capabilityTier) {
  return {
    id,
    available: true,
    authenticated: true,
    headless: true,
    authMode: id === "antigravity" ? "cli-session" : "subscription",
    command: process.execPath,
    models: [{ id: model, displayName: model, capabilityTier }],
    surfaces: { headless: true, source: true, "local-files": true, git: true, tests: true, command: true, database: true, "service-control": true, browser: id === "antigravity" },
    permissions: { command: true, database: true, "service-control": true, browser: id === "antigravity", "external-write": id === "antigravity" },
    capacity: { remainingPercent: 80, resetAt: "2026-07-22T00:00:00.000Z", source: "fixture" },
  };
}

function resources() {
  return {
    generatedAt: "2026-07-21T01:00:00.000Z",
    machine: { freeRamMb: 12000, totalRamMb: 16000, logicalCpuCount: 8 },
    worktreeStorage: { freeMb: 20000, minimumFreeMb: 2048, quotaMb: 2048 },
    providers: {
      antigravity: provider("antigravity", "gemini-3.5-flash", "efficient"),
      claude: provider("claude", "fable-5", "frontier"),
      codex: provider("codex", "gpt-5.6-terra", "balanced"),
    },
  };
}

function strongRecoveryResources() {
  const inventory = resources();
  inventory.providers.antigravity.models.push({
    id: "claude-opus-4.6",
    displayName: "Claude Opus 4.6",
    capabilityTier: "frontier",
  });
  return inventory;
}

function execution(executorKind, deliverableKind, extra = {}) {
  return {
    executorKind,
    deliverableKind,
    relevantFiles: [".codex/PROJECT_OUTCOME.md", ".codex/ACCEPTANCE.json"],
    expectedFiles: [],
    verificationCommands: [],
    requiredCapabilities: ["source", "local-files"],
    requiredPermissions: ["read-project", "read-files"],
    preconditions: [],
    postconditions: [],
    commands: [],
    rollback: null,
    recoveryAction: "",
    mutatesExternalState: false,
    sideEffectKey: "",
    observedStateFingerprint: "",
    userAuthorizationRef: "",
    successProbability: 0.85,
    ...extra,
  };
}

function masterPlan(mission, dossier, requirements = []) {
  const outstandingIds = requirements.filter((row) => row.required && row.status !== "passing").map((row) => row.id);
  const buildRequirementId = outstandingIds[0];
  const visibleRequirementId = outstandingIds[1] || buildRequirementId;
  return {
    schemaVersion: "director-cfo/master-plan@1",
    planRevision: 1,
    mission: { id: mission.missionId, revision: mission.revision, outcome: mission.outcome },
    context: { revision: dossier.contextRevision, fingerprint: dossier.contextFingerprint },
    objective: "Build and verify the requested feature.",
    timeline: {
      totalEstimatedMinutes: 90,
      assumptions: ["The local test command remains available."],
      windows: [
        { milestoneId: "milestone-build", startAfterMinute: 0, durationMinutes: 60 },
        { milestoneId: "milestone-verify", startAfterMinute: 60, durationMinutes: 30 },
      ],
    },
    milestones: [
      {
        id: "milestone-build",
        outcome: "Feature implementation is integrated.",
        dependsOn: [],
        workstreamIds: ["workstream-build"],
        evidenceRequirementIds: ["evidence-build"],
        acceptanceCriteria: ["The bounded patch passes integration checks."],
      },
      {
        id: "milestone-verify",
        outcome: "User-visible behavior is verified.",
        dependsOn: ["milestone-build"],
        workstreamIds: ["workstream-verify"],
        evidenceRequirementIds: ["evidence-visible"],
        acceptanceCriteria: ["User-visible evidence passes."],
      },
    ],
    dependencies: [{
      id: "dependency-build-verify",
      fromMilestoneId: "milestone-build",
      toMilestoneId: "milestone-verify",
      condition: "Integrated build evidence exists.",
    }],
    workstreams: [
      {
        id: "workstream-build",
        outcome: "Implement the bounded feature.",
        workType: "code",
        milestoneIds: ["milestone-build"],
        dependsOn: [],
        teamRoleIds: ["role-builder"],
        permissionIds: ["permission-write"],
        evidenceRequirementIds: ["evidence-build"],
        resourceEstimateId: "estimate-build",
        execution: execution("code-change", "patch", {
          relevantFiles: ["src/existing.js"],
          expectedFiles: ["src/feature.js"],
          verificationCommands: [{ command: "node", args: ["--check", "src/feature.js"], timeoutSeconds: 30, cwd: "" }],
          requiredCapabilities: ["source", "local-files", "tests"],
          requiredPermissions: ["write-files"],
        }),
      },
      {
        id: "workstream-verify",
        outcome: "Verify the final behavior against both requirements.",
        workType: "verification",
        milestoneIds: ["milestone-verify"],
        dependsOn: ["workstream-build"],
        teamRoleIds: ["role-verifier"],
        permissionIds: ["permission-read"],
        evidenceRequirementIds: ["evidence-visible"],
        resourceEstimateId: "estimate-verify",
        execution: execution("verification", "verification-result", {
          verificationCommands: [{ name: "visible-proof", command: "node", args: ["--check", "src/feature.js"], timeoutSeconds: 30, cwd: "" }],
        }),
      },
    ],
    team: {
      roles: [
        { id: "role-builder", title: "Builder", modelClass: "frontier", capabilities: ["source", "local-files", "tests"], responsibilities: ["Implement bounded code."], workstreamIds: ["workstream-build"], permissionIds: ["permission-write"] },
        { id: "role-verifier", title: "Verifier", modelClass: "balanced", capabilities: ["source", "local-files"], responsibilities: ["Verify acceptance evidence."], workstreamIds: ["workstream-verify"], permissionIds: ["permission-read"] },
      ],
    },
    permissions: [
      { id: "permission-write", capability: "workspace files", mode: "write", scope: "src/feature.js", reason: "Implement the feature.", required: true },
      { id: "permission-read", capability: "project evidence", mode: "read", scope: "project", reason: "Verify the result.", required: true },
    ],
    risks: [{ id: "risk-test", description: "Verification may reveal a regression.", likelihood: "medium", impact: "high", ownerRoleId: "role-verifier", trigger: "A check fails.", mitigation: "Reconcile before retry." }],
    recovery: [{ id: "recovery-test", trigger: "A worker or verification fails.", failureClasses: ["verification", "project-semantic"], action: "Use a strong reconciliation worker and materially revise the contract.", ownerRoleId: "role-verifier", evidenceRequirementId: "evidence-visible" }],
    evidenceRequirements: [
      { id: "evidence-build", milestoneId: "milestone-build", description: "The bounded feature patch is integrated.", level: "integration", proofType: "integration receipt", verifierRoleId: "role-verifier", acceptanceRequirementIds: [buildRequirementId] },
      { id: "evidence-visible", milestoneId: "milestone-verify", description: "The user-visible feature works.", level: "user-visible", proofType: "user-visible receipt", verifierRoleId: "role-verifier", acceptanceRequirementIds: [visibleRequirementId] },
    ],
    resourceEstimates: [
      { id: "estimate-build", workstreamId: "workstream-build", modelClass: "frontier", attempts: 1, inputTokens: 8000, outputTokens: 3000, wallClockMinutes: 45, concurrency: 1, ramMb: 512, diskMb: 64, includesVerification: true, includesReconciliationReserve: false },
      { id: "estimate-verify", workstreamId: "workstream-verify", modelClass: "balanced", attempts: 1, inputTokens: 4000, outputTokens: 1500, wallClockMinutes: 20, concurrency: 1, ramMb: 256, diskMb: 16, includesVerification: true, includesReconciliationReserve: true },
    ],
  };
}

function fixtureDatabaseReceipt(sourceId, snapshotContentHash) {
  return {
    receiptFingerprint: crypto.createHash("sha256").update(`fixture-sqlite-receipt:${sourceId}:${snapshotContentHash}`).digest("hex"),
    snapshotContentHash: String(snapshotContentHash || "").toLowerCase(),
  };
}

function contextArtifact(task) {
  const sources = task.program.sourceCatalog.sources;
  const sourceIds = sources.map((row) => row.id);
  const contextPackage = task.program.workPackages.find((row) => row.executorKind === "context-scout" && ["pending", "ready", "running"].includes(row.state));
  const snapshots = new Map((contextPackage?.bootstrapContract?.sourceSnapshotManifest?.snapshots || []).map((row) => [row.sourceId, row]));
  return {
    kind: "context-dossier",
    realGoal: task.outcome,
    executiveSummary: "The project contract defines a bounded feature and user-visible verification outcome.",
    currentState: [{ text: "The Director-CFO program has not yet executed project work.", sourceIds }],
    facts: [{ text: "Outcome and acceptance contracts are present and authoritative.", sourceIds }],
    decisions: [{ text: "Use a plan-wide budget and typed work packages.", sourceIds }],
    failures: [],
    assumptions: [{ text: "The local Node verification command remains available.", sourceIds: [] }],
    unknowns: [],
    constraints: [{ text: "Only authorized project sources may be used.", sourceIds: [] }],
    risks: [{ text: "Implementation may fail verification and require reconciliation.", sourceIds: [] }],
    acceptanceState: [{ text: "Both requirements are initially failing.", sourceIds }],
    sourceObservations: sources.map((row) => {
      const snapshot = snapshots.get(row.id);
      return snapshot?.state === "available"
        ? {
          sourceId: row.id,
          status: "observed",
          fingerprint: snapshot.fingerprint,
          summary: "Observed authorized " + row.type + " source.",
          ...(row.type === "database" ? {
            queryReceiptFingerprint: fixtureDatabaseReceipt(row.id, snapshot.contentHash).receiptFingerprint,
            queryReceiptSnapshotHash: snapshot.contentHash,
          } : {}),
        }
        : { sourceId: row.id, status: "unavailable", summary: "Authorized " + row.type + " source was unavailable.", error: snapshot?.error || "dynamic source requires a typed collector" };
    }),
  };
}

function onlyReady(task, kind) {
  const rows = task.program.workPackages.filter((row) => row.state === "ready" && (!kind || row.executorKind === kind));
  assert.equal(rows.length, 1, `expected one ready ${kind || "work"} package; phase=${task.program.phase}; deferred=${JSON.stringify(task.program.runtime?.budget?.deferred || [])}`);
  return rows[0];
}

function prepare(taskId) {
  return prepareProgramDispatch(readTask(taskId), resources());
}

function deterministicVerification(workPackage) {
  const checks = (workPackage.verificationCommands || []).map((row) => ({
    name: row.name || "fixture-check",
    command: row.command,
    args: row.args || [],
    expectedExitCode: Number(row.expectedExitCode ?? 0),
    exitCode: Number(row.expectedExitCode ?? 0),
    passed: true,
  }));
  return { version: 2, state: "passed", required: checks.length > 0, passed: checks.length > 0, checks };
}
function routingGuardRegression(workspace) {
  const started = startDirectorProgram({
    workspace,
    outcome: "Build a long-running program whose strategy requires a frontier model.",
    forceProgram: true,
    acceptanceEvidence: [{ id: "REQ-ROUTE", description: "The routed program is delivered.", minimumEvidenceLevel: "integration" }],
  }, resources());
  let task = prepare(started.taskId);
  const context = onlyReady(task, "context-scout");
  integrateDirectorArtifact(task, context.workPackageId, contextArtifact(task), { jobId: "job-route-context" });
  let routedContract = null;
  const dispatched = dispatchRound({ taskId: started.taskId }, resources(), {}, (contract) => {
    routedContract = contract;
    throw new Error("simulated-final-launch-rejection");
  });
  assert.equal(routedContract.model, "fable-5");
  assert.equal(routedContract.allowPremiumModel, true);
  assert.equal(dispatched.state, "blocked");
  task = readTask(started.taskId);
  const strategy = task.program.workPackages.find((row) => row.executorKind === "strategist");
  assert.equal(strategy.state, "pending");
  assert.equal(strategy.allocation, null);
  recordEvidence({
    taskId: started.taskId,
    evidence: [{
      requirementId: "REQ-ROUTE",
      level: "integration",
      ref: "fixture:routing-outcome",
      summary: "The routing guard outcome was independently verified.",
      passed: true,
    }],
  });
  task = readTask(started.taskId);
  assert.equal(task.state, "completed");
  assert.equal(task.program.contracts.state, "completed");
  assert.ok(task.program.workPackages.every((row) => ["completed", "cancelled"].includes(row.state)));
  return true;
}

function staleCorrectionRegression(workspace) {
  const started = startDirectorProgram({
    workspace,
    outcome: "Build a long-running feature and preserve user corrections during integration.",
    forceProgram: true,
    acceptanceEvidence: [{ id: "REQ-STALE", description: "The corrected feature is delivered.", minimumEvidenceLevel: "integration" }],
  }, resources());
  let task = prepare(started.taskId);
  let work = onlyReady(task, "context-scout");
  integrateDirectorArtifact(task, work.workPackageId, contextArtifact(task), { jobId: "job-stale-context" });
  task = prepare(started.taskId);
  work = onlyReady(task, "strategist");
  integrateDirectorArtifact(task, work.workPackageId, masterPlan(task.program.mission, task.program.contextDossier, task.requirements), { jobId: "job-stale-plan" });
  task = prepare(started.taskId);
  work = onlyReady(task, "code-change");
  const jobId = "job-stale-correction-0001";
  updateTask(task.taskId, (current) => {
    current.program.workPackages = current.program.workPackages.map((row) => row.workPackageId === work.workPackageId
      ? { ...row, state: "running", jobId }
      : row);
    return current;
  });
  const dir = jobDirectory(task.taskId, jobId);
  fs.mkdirSync(dir, { recursive: true });
  writeJson(path.join(dir, "contract.json"), {
    taskId: task.taskId,
    jobId,
    provider: "claude",
    model: "fable-5",
    deliverableKind: "patch",
    directorProgram: { workPackageId: work.workPackageId, revisionFence: work.revisionFence },
    revisionFence: work.revisionFence,
  });
  writeJson(path.join(dir, "status.json"), { taskId: task.taskId, jobId, state: "completed" });
  writeJson(path.join(dir, "handoff.json"), { state: "completed", summary: "Old result", deliverable: { kind: "patch" } });
  const missionRevision = task.program.mission.revision;
  const failureCount = task.program.failureMemory.length;
  reconcileTask({
    taskId: task.taskId,
    userRequest: "Change the requested outcome before the old worker result is integrated.",
    outcome: "Build the corrected feature and reject every stale worker result.",
    acceptanceEvidence: [{ id: "REQ-CORRECTED", description: "The corrected feature is delivered.", minimumEvidenceLevel: "integration" }],
  });
  const stale = integrateDirectorJob({
    taskId: task.taskId,
    jobId,
    workPackageId: work.workPackageId,
    baseIntegration: { integrated: true, verification: { required: true, passed: true } },
  });
  const corrected = readTask(task.taskId);
  assert.equal(stale.integrated, false);
  assert.equal(stale.stale, true);
  assert.equal(stale.reconciled, false);
  assert.equal(corrected.program.phase, "context");
  assert.equal(corrected.program.mission.revision, missionRevision + 1);
  assert.equal(corrected.program.failureMemory.length, failureCount);
  return true;
}

function terminalIntegrationFailureRegression(workspace) {
  const started = startDirectorProgram({
    workspace,
    outcome: "Fail closed when a post-plan reconciliation result loses its canonical revision fence.",
    forceProgram: true,
    acceptanceEvidence: [{
      id: "REQ-TERMINAL-INTEGRATION",
      description: "Terminal integration failures clear worker ownership and report a corrective next action.",
      minimumEvidenceLevel: "integration",
    }],
  }, resources());
  let task = prepare(started.taskId);
  let work = onlyReady(task, "context-scout");
  integrateDirectorArtifact(task, work.workPackageId, contextArtifact(task), { jobId: "job-terminal-context" });
  task = prepare(started.taskId);
  work = onlyReady(task, "strategist");
  integrateDirectorArtifact(task, work.workPackageId, masterPlan(task.program.mission, task.program.contextDossier, task.requirements), { jobId: "job-terminal-plan" });
  task = prepare(started.taskId);
  work = onlyReady(task, "code-change");
  recordProgramFailure(task, work, "verification failed: exercise post-plan reconciliation fencing", { jobId: "job-terminal-origin" });
  task = prepare(started.taskId);
  const reconciliation = onlyReady(task, "reconciliation");
  assert.ok(reconciliation.revisionFence?.fingerprint, "Post-plan reconciliation must be fenced before dispatch.");

  const reconciliationJobId = "job-terminal-reconciliation";
  const dispatched = dispatchRound({ taskId: started.taskId }, resources(), {}, (contract) => {
    const dir = jobDirectory(started.taskId, reconciliationJobId);
    fs.mkdirSync(dir, { recursive: true });
    const decision = {
      kind: "reconciliation-decision",
      rootCause: "The verification contract lacked a precise postcondition.",
      evidence: ["The failed work package recorded a verification failure."],
      changedWorkerRequirements: { postconditions: ["The corrected behavior passes deterministic verification."] },
      retryEligibility: true,
      failureFingerprint: reconciliation.failurePacket.failureFingerprint,
    };
    writeJson(path.join(dir, "contract.json"), { ...contract, taskId: started.taskId, jobId: reconciliationJobId });
    writeJson(path.join(dir, "status.json"), {
      taskId: started.taskId,
      jobId: reconciliationJobId,
      state: "completed",
      provider: contract.provider,
      model: contract.model,
    });
    writeJson(path.join(dir, "handoff.json"), {
      state: "completed",
      summary: "A valid reconciliation decision was returned.",
      artifact: decision,
      deliverable: decision,
    });
    return {
      taskId: started.taskId,
      jobId: reconciliationJobId,
      state: "queued",
      provider: contract.provider,
      model: contract.model,
      readOnly: true,
    };
  });
  assert.equal(dispatched.workers.length, 1);
  updateTask(started.taskId, (current) => {
    current.program.workPackages = current.program.workPackages.map((row) => row.workPackageId === reconciliation.workPackageId
      ? { ...row, revisionFence: null, canonicalContract: null }
      : row);
    return current;
  });
  const storedContractPath = path.join(jobDirectory(started.taskId, reconciliationJobId), "contract.json");
  const storedContract = readJson(storedContractPath, {});
  storedContract.revisionFence = null;
  storedContract.directorProgram = { ...storedContract.directorProgram, revisionFence: null };
  writeJson(storedContractPath, storedContract);

  const collected = collectRound({ taskId: started.taskId, roundId: dispatched.roundId, waitSeconds: 0, detail: "full" });
  assert.equal(collected.state, "ready-for-integration");
  const integrated = integrateRound({ taskId: started.taskId, roundId: dispatched.roundId });
  assert.equal(integrated.integrations[0].integrated, false);
  assert.equal(integrated.integrations[0].reconciled, false);
  assert.equal(integrated.integrations[0].stale, undefined);
  assert.match(integrated.integrations[0].blocker, /director-revision-fence-missing/);

  const blocked = readTask(started.taskId);
  const failedReconciliation = blocked.program.workPackages.find((row) => row.workPackageId === reconciliation.workPackageId);
  const graphNode = blocked.workGraph.find((row) => row.id === reconciliation.workPackageId);
  assert.equal(blocked.program.state, "blocked");
  assert.equal(blocked.program.phase, "blocked");
  assert.equal(blocked.program.activeCampaign, null);
  assert.equal(blocked.program.workPackages.some((row) => row.state === "running"), false);
  assert.equal(failedReconciliation.state, "failed");
  assert.equal(graphNode.state, "blocked");
  assert.equal(graphNode.owner, null);
  assert.match(blocked.program.nextAction, /Terminal integration failed closed/);
  assert.doesNotMatch(blocked.program.nextAction, /^Wait for|waiting on .*worker/i);
  assert.ok(blocked.program.campaigns.some((row) => row.stopReason === "terminal-integration-error"));
  return true;
}

function completedContextJob(task, workPackage, jobId, artifact) {
  updateTask(task.taskId, (current) => {
    current.program.workPackages = current.program.workPackages.map((row) => row.workPackageId === workPackage.workPackageId
      ? { ...row, state: "running", jobId }
      : row);
    current.workGraph = current.workGraph.map((node) => node.id === workPackage.workPackageId
      ? { ...node, state: "running", owner: jobId }
      : node);
    return current;
  });
  const dir = jobDirectory(task.taskId, jobId);
  fs.mkdirSync(dir, { recursive: true });
  const snapshots = new Map((workPackage.bootstrapContract?.sourceSnapshotManifest?.snapshots || []).map((row) => [row.sourceId, row]));
  const databaseSources = (workPackage.bootstrapContract?.sourceCatalog?.sources || []).filter((row) => row.type === "database");
  const contextObservationReceiptExpectations = Object.fromEntries(databaseSources.map((source) => {
    const snapshot = snapshots.get(source.id);
    assert.equal(snapshot?.state, "available", "A completed database context fixture requires an available immutable snapshot.");
    return [source.id, fixtureDatabaseReceipt(source.id, snapshot.contentHash)];
  }));
  writeJson(path.join(dir, "contract.json"), {
    taskId: task.taskId,
    jobId,
    provider: "antigravity",
    model: workPackage.model || "gemini-3.5-flash",
    deliverableKind: "context-dossier",
    directorProgram: { workPackageId: workPackage.workPackageId },
    directorWorkerContract: createDirectorWorkerContract(workPackage),
    contextObservationReceiptExpectations,
    contextObservationPreflight: {
      ok: true,
      mode: "immutable-sqlite-receipt",
      databaseSourceIds: Object.keys(contextObservationReceiptExpectations).sort(),
    },
  });
  writeJson(path.join(dir, "status.json"), { taskId: task.taskId, jobId, state: "completed" });
  writeJson(path.join(dir, "handoff.json"), { state: "completed", summary: "Context fixture completed.", artifact, deliverable: artifact });
  writeJson(path.join(dir, "usage.json"), { inputTokens: 100, outputTokens: 50, durationMs: 100 });
}

function contextFreshnessIntegrationRegression(workspace) {
  const runtimeLog = path.join(workspace, "runtime.log");
  const runtimeDatabase = path.join(workspace, "runtime.db");
  fs.writeFileSync(runtimeLog, "tick 1\n", "utf8");
  fs.writeFileSync(runtimeDatabase, "row 1\n", "utf8");
  const dynamicStarted = startDirectorProgram({
    workspace,
    outcome: "Build a long-running program while runtime evidence continues changing.",
    forceProgram: true,
    authorizedPermissions: ["database", "run-command"],
    acceptanceEvidence: [{ id: "REQ-DYNAMIC", description: "Dynamic evidence is handled safely.", minimumEvidenceLevel: "integration" }],
    sourceDescriptors: {
      logs: [{ id: "runtime-log", locator: "runtime.log" }],
      databases: [{ id: "runtime-db", locator: "runtime.db" }],
    },
  }, resources());
  let task = prepare(dynamicStarted.taskId);
  let work = onlyReady(task, "context-scout");
  const dynamicArtifact = contextArtifact(task);
  completedContextJob(task, work, "job-context-dynamic-0001", dynamicArtifact);
  fs.appendFileSync(runtimeLog, "tick 2\n", "utf8");
  fs.appendFileSync(runtimeDatabase, "row 2\n", "utf8");
  const dynamicResult = integrateDirectorJob({ taskId: task.taskId, jobId: "job-context-dynamic-0001", workPackageId: work.workPackageId });
  assert.equal(dynamicResult.integrated, true, "log/database drift must not reject a completed context artifact");
  assert.equal(readTask(task.taskId).program.phase, "strategy");

  const staticStarted = startDirectorProgram({
    workspace,
    outcome: "Build a long-running program with a bounded post-worker context refresh.",
    forceProgram: true,
    acceptanceEvidence: [{ id: "REQ-STATIC", description: "Static context remains coherent.", minimumEvidenceLevel: "integration" }],
  }, resources());
  task = prepare(staticStarted.taskId);
  work = onlyReady(task, "context-scout");
  const firstArtifact = contextArtifact(task);
  completedContextJob(task, work, "job-context-static-0001", firstArtifact);
  fs.appendFileSync(path.join(workspace, ".codex", "PROJECT_OUTCOME.md"), "Static change one.\n", "utf8");
  const firstStale = integrateDirectorJob({ taskId: task.taskId, jobId: "job-context-static-0001", workPackageId: work.workPackageId });
  assert.equal(firstStale.integrated, false);
  assert.equal(firstStale.managerTransition, true);
  assert.equal(firstStale.refreshScheduled, true);
  let refreshed = readTask(task.taskId);
  assert.equal(refreshed.program.runtime.contextFreshness.postWorkerRefreshCount, 1);
  assert.equal(refreshed.program.workPackages.filter((row) => row.executorKind === "context-scout" && row.state === "pending").length, 1);
  assert.equal(refreshed.workGraph.some((row) => row.id === work.workPackageId), false, "a rejected stale context result must not remain as a completed graph node");
  assert.equal(refreshed.workGraph.filter((row) => row.state === "pending" && row.id === firstStale.refreshWorkPackageId).length, 1);

  const repeatedOldResult = integrateDirectorJob({ taskId: task.taskId, jobId: "job-context-static-0001", workPackageId: work.workPackageId });
  assert.equal(repeatedOldResult.stale, true);
  assert.equal(readTask(task.taskId).program.runtime.contextFreshness.postWorkerRefreshCount, 1, "reintegrating the old job must be idempotent");

  task = prepare(task.taskId);
  work = onlyReady(task, "context-scout");
  const secondArtifact = contextArtifact(task);
  completedContextJob(task, work, "job-context-static-0002", secondArtifact);
  fs.appendFileSync(path.join(workspace, ".codex", "ACCEPTANCE.json"), "\n", "utf8");
  const secondStale = integrateDirectorJob({ taskId: task.taskId, jobId: "job-context-static-0002", workPackageId: work.workPackageId });
  assert.equal(secondStale.integrated, false);
  assert.equal(secondStale.managerTransition, true);
  assert.equal(secondStale.blocked, true);
  const blocked = readTask(task.taskId);
  assert.equal(blocked.program.phase, "blocked");
  assert.equal(blocked.program.runtime.contextFreshness.postWorkerRefreshCount, 1);
  assert.equal(blocked.program.workPackages.filter((row) => row.executorKind === "context-scout" && row.state === "pending").length, 0);
  assert.equal(blocked.program.workPackages.filter((row) => row.executorKind === "reconciliation").length, 0);
  return true;
}

function planRevisionRegression(workspace) {
  const started = startDirectorProgram({
    workspace,
    outcome: "Recover from an invalid execution plan without retaining stale workers.",
    forceProgram: true,
    acceptanceEvidence: [
      { id: "REQ-PLAN-REVISION", description: "A materially revised plan replaces the invalid plan.", minimumEvidenceLevel: "integration" },
      { id: "REQ-PLAN-VISIBLE", description: "The revised plan preserves user-visible verification.", minimumEvidenceLevel: "user-visible" },
    ],
  }, resources());
  let task = prepare(started.taskId);
  let work = onlyReady(task, "context-scout");
  integrateDirectorArtifact(task, work.workPackageId, contextArtifact(task), { jobId: "job-plan-revision-context" });

  task = prepare(started.taskId);
  work = onlyReady(task, "strategist");
  const originalStrategyWorkPackageId = work.workPackageId;
  integrateDirectorArtifact(task, work.workPackageId, masterPlan(task.program.mission, task.program.contextDossier, task.requirements), { jobId: "job-plan-revision-original-plan" });

  task = prepare(started.taskId);
  const failedWork = onlyReady(task, "code-change");
  recordProgramFailure(task, failedWork, "plan invalid: the execution dependency graph omitted a required recovery boundary", {
    jobId: "job-plan-revision-origin",
  });
  task = prepare(started.taskId);
  const reconciliation = onlyReady(task, "reconciliation");
  assert.equal(reconciliation.failurePacket.failureClass, "plan-invalid");
  assert.equal(reconciliation.policy.fullContextRefresh, false, "A first plan-invalid result with accepted context must revise strategy directly.");
  assert.match(reconciliation.goal, /Do not spend another context worker/);
  assert.equal(contextRefreshRequested({ required: true, mode: "full" }), true, "Structured reconciler context-refresh requests must normalize to the executable boolean transition.");

  assert.throws(() => integrateDirectorArtifact(task, reconciliation.workPackageId, {
    rootCause: "The resource allocation alone was proposed as the correction.",
    evidence: ["The failed plan must be changed, not merely rebudgeted."],
    budgetRevision: { reason: "Increase the strategy allocation." },
    retryEligibility: true,
    failureFingerprint: reconciliation.failurePacket.failureFingerprint,
  }, { jobId: "job-plan-revision-budget-only" }), /material change/i);
  const mixedBudgetDecision = {
    rootCause: "The dependency graph omitted a required recovery boundary.",
    evidence: ["The plan-invalid failure packet identifies the missing recovery boundary."],
    planRevision: { reason: "Add the missing recovery boundary." },
    budgetRevision: 2,
    retryEligibility: true,
    failureFingerprint: reconciliation.failurePacket.failureFingerprint,
  };
  assert.equal(validateReconciliationDecision(mixedBudgetDecision, reconciliation.failurePacket).ok, true, "Budget metadata must not invalidate an independently actionable plan correction.");

  const unrelated = task.program.workPackages.find((row) => row.executorKind === "verification" && row.workPackageId !== failedWork.workPackageId);
  assert.ok(unrelated, "The fixture requires an unrelated package whose stale ownership can be retired.");
  const unrelatedJobId = "job-plan-revision-unrelated-running";
  const unrelatedJobDir = jobDirectory(task.taskId, unrelatedJobId);
  fs.mkdirSync(unrelatedJobDir, { recursive: true });
  writeJson(path.join(unrelatedJobDir, "contract.json"), {
    taskId: task.taskId,
    jobId: unrelatedJobId,
    workspace,
    executorKind: unrelated.executorKind,
    deliverableKind: unrelated.deliverableKind,
  });
  writeJson(path.join(unrelatedJobDir, "status.json"), {
    taskId: task.taskId,
    jobId: unrelatedJobId,
    state: "queued",
    pid: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  updateTask(task.taskId, (current) => {
    current.program.workPackages = current.program.workPackages.map((row) => row.workPackageId === unrelated.workPackageId
      ? { ...row, state: "running", jobId: unrelatedJobId }
      : row);
    current.workGraph = current.workGraph.map((node) => node.id === unrelated.workPackageId
      ? { ...node, state: "running", owner: unrelatedJobId }
      : node);
    return current;
  });
  task = readTask(task.taskId);

  const structuredUserDecision = {
    required: true,
    asks: [{ question: "Confirm which historical boundary the revised strategy should document." }],
  };
  const requestedStrategyTuning = {
    executorKind: "external-transaction",
    deliverableKind: "external-transaction-receipt",
    minimumCapabilityTier: "frontier",
    timeoutSeconds: 2400,
    maxWorkerOutputTokens: 6500,
    requiredCapabilities: ["browser"],
    requiredPermissions: ["external-write"],
    permissionGrant: ["external-write"],
  };
  integrateDirectorArtifact(task, reconciliation.workPackageId, {
    rootCause: "The dependency graph omitted a required recovery boundary.",
    evidence: ["The plan-invalid failure packet identifies the missing recovery boundary."],
    planRevision: {
      reason: "Replace the invalid plan with a higher revision that adds the missing recovery boundary.",
      requiredChanges: ["Revise the dependency graph and recovery strategy."],
    },
    contextRefresh: { required: true, mode: "full" },
    budgetRevision: { required: false, reason: "No budget-only retry is requested." },
    userDecision: structuredUserDecision,
    retryEligibility: true,
    changedWorkerRequirements: requestedStrategyTuning,
    failureFingerprint: reconciliation.failurePacket.failureFingerprint,
  }, { jobId: "job-plan-revision-decision" });

  task = readTask(task.taskId);
  assert.equal(task.program.phase, "strategy", "A first plan-invalid correction must preserve accepted context and revise strategy directly.");
  assert.equal(task.program.state, "active");
  assert.equal(task.program.contextDossier.contextRevision, 1, "Direct plan revision must not replace the accepted dossier.");
  assert.equal(task.program.workPackages.some((row) => row.executorKind === "context-scout" && row.state === "pending"), false);
  const revisedStrategy = task.program.workPackages.find((row) => row.executorKind === "strategist" && row.state === "pending");
  assert.ok(revisedStrategy, "Plan reconciliation must schedule a replacement strategist.");
  assert.notEqual(revisedStrategy.workPackageId, originalStrategyWorkPackageId, "The replacement strategist must have a unique retry ID.");
  assert.equal(revisedStrategy.retryOfWorkPackageId, failedWork.workPackageId);
  assert.equal(revisedStrategy.reconciliationWorkPackageId, reconciliation.workPackageId);
  assert.ok(revisedStrategy.reconciliationDecisionFingerprint);
  assert.deepEqual(revisedStrategy.reconciliationDirective, revisedStrategy.bootstrapContract.reconciliationDirective);
  assert.equal(revisedStrategy.bootstrapContract.minimumPlanRevision, revisedStrategy.reconciliationDirective.minimumPlanRevision);
  assert.deepEqual(revisedStrategy.reconciliationDirective.userDecision, structuredUserDecision);
  assert.ok(revisedStrategy.bootstrapContract.minimumPlanRevision > 1);
  assert.equal(revisedStrategy.reconciliationDirective.failedWorkPackageId, failedWork.workPackageId);

  assert.equal(revisedStrategy.timeoutSeconds, requestedStrategyTuning.timeoutSeconds);
  assert.equal(revisedStrategy.maxWorkerOutputTokens, requestedStrategyTuning.maxWorkerOutputTokens);
  assert.equal(revisedStrategy.minimumCapabilityTier, requestedStrategyTuning.minimumCapabilityTier);
  assert.equal(revisedStrategy.executorKind, "strategist");
  assert.equal(revisedStrategy.deliverableKind, "master-plan");
  assert.equal(revisedStrategy.readOnly, true);
  assert.deepEqual(revisedStrategy.requiredCapabilities, ["source", "local-files"]);
  assert.deepEqual(revisedStrategy.requiredPermissions, ["read-project", "read-files"]);
  assert.deepEqual(revisedStrategy.permissionGrant, ["read-project", "read-files"]);
  assert.deepEqual(revisedStrategy.reconciliationDirective.requestedPackageChanges.changedWorkerRequirements, requestedStrategyTuning);
  const supersededPackage = task.program.workPackages.find((row) => row.workPackageId === unrelated.workPackageId);
  const supersededGraphNode = task.workGraph.find((row) => row.id === unrelated.workPackageId);
  assert.equal(supersededPackage.state, "superseded");
  assert.equal(supersededPackage.jobId, null);
  assert.equal(supersededPackage.supersededJobId, unrelatedJobId);
  assert.equal(supersededGraphNode.state, "superseded");
  assert.equal(supersededGraphNode.owner, null);
  assert.equal(readJson(path.join(unrelatedJobDir, "status.json"), {}).state, "cancelled");

  task = prepare(task.taskId);
  const readyRevision = onlyReady(task, "strategist");
  assert.equal(readyRevision.workPackageId, revisedStrategy.workPackageId);
  const minimumPlanRevision = readyRevision.bootstrapContract.minimumPlanRevision;
  const stalePlan = masterPlan(task.program.mission, task.program.contextDossier, task.requirements);
  stalePlan.planRevision = minimumPlanRevision - 1;
  assert.throws(() => integrateDirectorArtifact(task, readyRevision.workPackageId, stalePlan, {
    jobId: "job-plan-revision-stale-plan",
  }), new RegExp("planRevision must be an integer at least " + minimumPlanRevision, "i"));
  assert.equal(readTask(task.taskId).program.workPackages.find((row) => row.workPackageId === readyRevision.workPackageId).state, "ready");

  const acceptedPlan = masterPlan(task.program.mission, task.program.contextDossier, task.requirements);
  acceptedPlan.planRevision = minimumPlanRevision;
  integrateDirectorArtifact(task, readyRevision.workPackageId, acceptedPlan, { jobId: "job-plan-revision-accepted-plan" });
  const recovered = readTask(task.taskId);
  assert.equal(recovered.program.phase, "execution");
  assert.equal(recovered.program.masterPlan.planRevision, minimumPlanRevision);
  return true;
}

function userDecisionOnlyRegression(workspace) {
  const started = startDirectorProgram({
    workspace,
    outcome: "Stop only when reconciliation genuinely requires an exact user decision.",
    forceProgram: true,
    acceptanceEvidence: [
      { id: "REQ-001", description: "Previously accepted foundation remains complete.", minimumEvidenceLevel: "integration", status: "passing" },
      { id: "REQ-003", description: "The exact user-owned recovery choice is reported without inventing a retry.", minimumEvidenceLevel: "integration" },
    ],
  }, resources());
  let task = prepare(started.taskId);
  let work = onlyReady(task, "context-scout");
  integrateDirectorArtifact(task, work.workPackageId, contextArtifact(task), { jobId: "job-user-decision-context" });
  task = prepare(started.taskId);
  work = onlyReady(task, "strategist");
  integrateDirectorArtifact(task, work.workPackageId, masterPlan(task.program.mission, task.program.contextDossier, task.requirements), { jobId: "job-user-decision-plan" });
  task = prepare(started.taskId);
  work = onlyReady(task, "code-change");
  const stalePassingRequirementWork = { ...work, acceptanceIds: ["REQ-001"] };
  assert.equal(task.requirements.find((row) => row.id === "REQ-001").status, "passing");
  assert.notEqual(task.requirements.find((row) => row.id === "REQ-003").status, "passing");
  assert.deepEqual(stalePassingRequirementWork.acceptanceIds, ["REQ-001"]);
  recordProgramFailure(task, stalePassingRequirementWork, "plan invalid: recovery requires a genuine project-owner choice", {
    jobId: "job-user-decision-origin",
  });
  task = prepare(started.taskId);
  const reconciliation = onlyReady(task, "reconciliation");
  assert.deepEqual(reconciliation.failurePacket.acceptanceIds, ["REQ-003"]);
  assert.deepEqual(reconciliation.acceptanceIds, ["REQ-003"]);
  const exactQuestion = "Choose whether the revised plan must retain the legacy compatibility boundary.";
  const exactActionIfYes = "Confirm that retaining the compatibility boundary is authorized.";
  const exactNextAction = exactQuestion + " | " + exactActionIfYes;
  integrateDirectorArtifact(task, reconciliation.workPackageId, {
    rootCause: "Two valid recovery paths differ by a genuine compatibility trade-off.",
    evidence: ["The failure packet cannot determine which compatibility outcome the project owner requires."],
    userDecision: {
      required: true,
      asks: [
        { exactQuestion },
        { exactActionIfYes },
      ],
    },
    retryEligibility: false,
    failureFingerprint: reconciliation.failurePacket.failureFingerprint,
  }, { jobId: "job-user-decision-only" });
  const blocked = readTask(task.taskId);
  assert.equal(blocked.program.phase, "blocked");
  assert.equal(blocked.program.state, "blocked");
  assert.equal(blocked.program.nextAction, exactNextAction);
  assert.equal(blocked.program.workPackages.find((row) => row.workPackageId === reconciliation.workPackageId).state, "completed");
  assert.equal(blocked.workGraph.find((row) => row.id === reconciliation.workPackageId).owner, null);
  return true;
}

function executionContextScoutIntegrationRegression(workspace) {
  const started = startDirectorProgram({
    workspace,
    outcome: "Use an execution-phase context scout to produce acceptance-linked research evidence.",
    forceProgram: true,
    acceptanceEvidence: [
      { id: "REQ-SCOUT", description: "Execution-phase research evidence is integrated without replacing canonical bootstrap context.", minimumEvidenceLevel: "integration" },
    ],
  }, resources());
  let task = prepare(started.taskId);
  let work = onlyReady(task, "context-scout");
  integrateDirectorArtifact(task, work.workPackageId, contextArtifact(task), { jobId: "job-execution-scout-bootstrap" });

  task = prepare(started.taskId);
  work = onlyReady(task, "strategist");
  const plan = masterPlan(task.program.mission, task.program.contextDossier, task.requirements);
  plan.objective = "Produce and integrate bounded project research evidence.";
  plan.workstreams[0] = {
    ...plan.workstreams[0],
    outcome: "Produce bounded project research evidence.",
    workType: "context",
    execution: execution("context-scout", "context-dossier", {
      readOnly: true,
      expectedFiles: [],
      verificationCommands: [],
      requiredCapabilities: ["source", "local-files"],
      requiredPermissions: ["read-project", "read-files"],
    }),
  };
  plan.workstreams[1].execution.verificationCommands = [{
    name: "visible-proof",
    command: "node",
    args: ["--check", "src/existing.js"],
    timeoutSeconds: 30,
    cwd: "",
  }];
  integrateDirectorArtifact(task, work.workPackageId, plan, { jobId: "job-execution-scout-plan" });

  task = prepare(started.taskId);
  work = onlyReady(task, "context-scout");
  assert.equal(work.bootstrapContract, undefined, "A plan-derived context scout must not be treated as bootstrap context acquisition.");
  assert.ok(work.revisionFence?.fingerprint);
  const canonicalContextFingerprint = task.program.contextDossier.contextFingerprint;
  const jobId = "job-execution-scout-result";
  updateTask(task.taskId, (current) => {
    current.program.workPackages = current.program.workPackages.map((row) => row.workPackageId === work.workPackageId
      ? { ...row, state: "running", jobId }
      : row);
    return current;
  });
  const dir = jobDirectory(task.taskId, jobId);
  fs.mkdirSync(dir, { recursive: true });
  const directorProgram = { workPackageId: work.workPackageId, revisionFence: work.revisionFence };
  writeJson(path.join(dir, "contract.json"), {
    taskId: task.taskId,
    jobId,
    provider: work.allocation.provider,
    model: work.allocation.model,
    allocation: work.allocation,
    deliverableKind: work.deliverableKind,
    directorProgram,
    revisionFence: work.revisionFence,
    directorWorkerContract: createDirectorWorkerContract(work),
  });
  writeJson(path.join(dir, "status.json"), { taskId: task.taskId, jobId, state: "completed" });
  writeJson(path.join(dir, "handoff.json"), {
    state: "completed",
    summary: "The execution-phase scout produced bounded acceptance-linked research evidence.",
    changedFiles: [],
    deliverable: {
      kind: "context-dossier",
      evidence: ["Execution research fixture."],
      acceptanceEvidence: [{ requirementId: "REQ-SCOUT", level: "integration", ref: "execution-scout:fixture", summary: "Research evidence integrated.", passed: true }],
    },
  });
  writeJson(path.join(dir, "usage.json"), { inputTokens: 300, outputTokens: 120, durationMs: 500 });

  const integrated = integrateDirectorJob({ taskId: task.taskId, jobId, workPackageId: work.workPackageId });
  assert.equal(integrated.integrated, true, JSON.stringify(integrated));
  const completed = readTask(task.taskId);
  assert.equal(completed.program.contextDossier.contextFingerprint, canonicalContextFingerprint, "Execution research must not replace canonical bootstrap context.");
  assert.ok(completed.program.executionReceipts.some((row) => row.workPackageId === work.workPackageId));
  assert.equal(completed.program.failureMemory.length, 0);
  return true;
}
function run() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "director-cfo-program-"));
  const workspace = path.join(temp, "workspace");
  const dataRoot = path.join(temp, "state");
  fs.mkdirSync(path.join(workspace, ".codex"), { recursive: true });
  fs.mkdirSync(path.join(workspace, "src"), { recursive: true });
  fs.writeFileSync(path.join(workspace, ".codex", "PROJECT_OUTCOME.md"), "# Outcome\nBuild and verify the feature.\n");
  fs.writeFileSync(path.join(workspace, ".codex", "ACCEPTANCE.json"), JSON.stringify({ requirements: ["build", "visible"] }));
  fs.writeFileSync(path.join(workspace, "src", "existing.js"), "module.exports = {};\n");
  process.env.AI_MOBILE_DATA_ROOT = dataRoot;

  try {
    const contextFreshness = contextFreshnessIntegrationRegression(workspace);
    const terminalIntegrationFailure = terminalIntegrationFailureRegression(workspace);
    const planRevision = planRevisionRegression(workspace);
    const userDecisionOnly = userDecisionOnlyRegression(workspace);
    const executionContextScout = executionContextScoutIntegrationRegression(workspace);
    const direct = startDirectorProgram({ workspace, outcome: "Close the browser.", expectedDurationSeconds: 30 }, resources());
    assert.equal(direct.mode, "direct");
    assert.equal(direct.orchestrationStarted, false);

    const started = startDirectorProgram({
      workspace,
      outcome: "Build and verify the requested feature across a long-running project.",
      forceProgram: true,
      acceptanceEvidence: [
        { id: "REQ-BUILD", description: "The bounded feature patch is integrated.", minimumEvidenceLevel: "integration" },
        { id: "REQ-VISIBLE", description: "The user-visible feature works.", minimumEvidenceLevel: "user-visible" },
      ],
      maxWorkers: 2,
    }, resources());
    assert.equal(started.mode, "director-cfo");
    const taskId = started.taskId;

    let task = prepare(taskId);
    let work = onlyReady(task, "context-scout");
    assert.equal(work.allocation.model, "gemini-3.5-flash", "Economical context should use measured Antigravity capacity with a bounded CFO reservation.");
    assert.equal(work.allocation.accountingBasis.quotaReservations[0].measurement.value, 2);
    integrateDirectorArtifact(task, work.workPackageId, contextArtifact(task), { jobId: "job-context-0001" });

    task = prepare(taskId);
    work = onlyReady(task, "strategist");
    assert.equal(work.allocation.model, "fable-5");
    assert.equal(work.allocation.tokenLimit, 100000, "strong strategy must budget observed full invocation exposure");
    integrateDirectorArtifact(task, work.workPackageId, masterPlan(task.program.mission, task.program.contextDossier, task.requirements), { jobId: "job-plan-0001" });

    task = prepare(taskId);
    work = onlyReady(task, "code-change");
    assert.ok(work.canonicalContract);
    assert.ok(work.revisionFence?.fingerprint);
    const firstFence = work.revisionFence;
    recordProgramFailure(task, work, "verification failed: generated behavior is incorrect", { jobId: "job-code-fail-0001", assurance: { errors: ["Verification workstream lacked a concrete behavioral postcondition."] } });
    recordProgramFailure(taskId, work, "verification failed: generated behavior is incorrect", { jobId: "job-code-fail-0001", assurance: { errors: ["Verification workstream lacked a concrete behavioral postcondition."] } });
    task = readTask(taskId);
    assert.equal(task.program.failureMemory.length, 1);
    assert.equal(task.program.workPackages.filter((row) => row.executorKind === "reconciliation" && row.state !== "completed").length, 1);
    const pendingReconciliation = task.program.workPackages.find((row) => row.executorKind === "reconciliation" && row.state !== "completed");
    assert.deepEqual(pendingReconciliation.priorAssuranceErrors, ["Verification workstream lacked a concrete behavioral postcondition."]);
    assert.ok(pendingReconciliation.materialDeltaRequired.anyOf.includes("changedWorkerRequirements"));
    assert.deepEqual(pendingReconciliation.policy.priorAssuranceErrors, pendingReconciliation.priorAssuranceErrors);

    task = prepare(taskId);
    const reconciliation = onlyReady(task, "reconciliation");
    assert.equal(reconciliation.allocation.model, "fable-5");
    assert.equal(reconciliation.allocation.tokenLimit, 150000, "strong reconciliation must budget observed full invocation exposure");
    assert.throws(() => integrateDirectorArtifact(task, reconciliation.workPackageId, {
      rootCause: "The worker described a change without returning fields the Director can apply.",
      evidence: ["The proposed delta was narrative-only."],
      contextRefresh: true,
      changedContract: { changed: true, delta: "Use a stronger worker and improve verification." },
      retryEligibility: true,
      failureFingerprint: reconciliation.failurePacket.failureFingerprint,
    }, { jobId: "job-reconcile-narrative-only" }), /machine-actionable work-package delta|requires one applied material delta/i);
    integrateDirectorArtifact(task, reconciliation.workPackageId, {
      rootCause: "The implementation contract omitted a concrete behavioral postcondition.",
      evidence: ["The verification receipt reported the missing behavior."],
      changedWorkerRequirements: { postconditions: ["The exported feature returns the expected value."] },
      retryEligibility: true,
      failureFingerprint: reconciliation.failurePacket.failureFingerprint,
    }, { jobId: "job-reconcile-0001" });

    task = prepare(taskId);
    work = onlyReady(task, "code-change");
    assert.notEqual(work.revisionFence.fingerprint, firstFence.fingerprint);
    assert.deepEqual(work.postconditions, ["The exported feature returns the expected value."]);
    assert.throws(() => integrateDirectorArtifact(task, work.workPackageId, { kind: "patch" }, {
      jobId: "job-code-unverified",
    }), /verified-patch-integration-receipt/i);
    integrateDirectorArtifact(task, work.workPackageId, {
      kind: "patch",
      acceptanceEvidence: [],
    }, {
      jobId: "job-code-0002",
      handoff: {
        state: "completed",
        summary: "Implemented and verified the bounded feature.",
        changedFiles: ["src/feature.js"],
        deliverable: { kind: "patch", acceptanceEvidence: [] },
        usage: { inputTokens: 1200, outputTokens: 300, durationMs: 1500 },
      },
      baseIntegration: { integrated: true, verification: deterministicVerification(work) },
    });

    task = prepare(taskId);
    work = onlyReady(task, "verification");
    assert.throws(() => assertIntegrationFence(firstFence, {
      mission: task.program.contracts.mission,
      contextDossier: task.program.contracts.contextDossier,
      masterPlan: task.program.contracts.masterPlan,
      resourceBudget: task.program.contracts.resourceBudget,
      campaign: task.program.contracts.campaign,
    }), /stale/i);
    const evidence = [
      { requirementId: "REQ-BUILD", level: "integration", ref: "verify:build", summary: "The patch is integrated.", passed: true },
      { requirementId: "REQ-VISIBLE", level: "user-visible", ref: "verify:visible", summary: "The user-visible behavior passed.", passed: true },
    ];
    const verificationJobId = "job-verify-0001";
    updateTask(task.taskId, (current) => {
      current.program.workPackages = current.program.workPackages.map((row) => row.workPackageId === work.workPackageId
        ? { ...row, state: "running", jobId: verificationJobId }
        : row);
      return current;
    });
    const verificationDir = jobDirectory(task.taskId, verificationJobId);
    fs.mkdirSync(verificationDir, { recursive: true });
    writeJson(path.join(verificationDir, "contract.json"), {
      taskId: task.taskId,
      jobId: verificationJobId,
      provider: work.allocation.provider,
      model: work.allocation.model,
      deliverableKind: "verification-result",
      directorProgram: { workPackageId: work.workPackageId, revisionFence: work.revisionFence },
      revisionFence: work.revisionFence,
    });
    writeJson(path.join(verificationDir, "status.json"), { taskId: task.taskId, jobId: verificationJobId, state: "completed" });
    writeJson(path.join(verificationDir, "handoff.json"), {
      state: "completed",
      summary: "Verified both acceptance outcomes.",
      changedFiles: [],
      deliverable: {
        kind: "verification-result",
        actions: [{ passed: true }],
        acceptanceEvidence: evidence,
      },
    });
    writeJson(path.join(verificationDir, "usage.json"), { inputTokens: 600, outputTokens: 200, durationMs: 900 });
    const verifiedJob = integrateDirectorJob({ taskId: task.taskId, jobId: verificationJobId, workPackageId: work.workPackageId });
    assert.equal(verifiedJob.integrated, true, JSON.stringify(verifiedJob));

    task = readTask(taskId);
    assert.notEqual(task.state, "completed");
    assert.equal(task.program.phase, "awaiting-evidence");
    assert.equal(task.requirements.find((row) => row.id === "REQ-VISIBLE").status, "failing");
    assert.ok(task.evidence.some((row) => row.sourceRef === "verify:visible" && row.accepted === false));
    const pendingEvidenceRecovery = task.program.workPackages.find((row) => row.evidenceRecovery && row.state === "pending");
    assert.equal(pendingEvidenceRecovery.evidenceRecovery.owner, "director");
    assert.equal(pendingEvidenceRecovery.evidenceRecovery.transition, "dispatch-package-linked-verification");
    assert.ok(pendingEvidenceRecovery.milestoneId);
    assert.ok(pendingEvidenceRecovery.workstreamId);
    assert.ok(pendingEvidenceRecovery.verificationCommands.length > 0);

    task = prepare(taskId);
    const evidenceRecovery = onlyReady(task, "verification");
    assert.equal(evidenceRecovery.workPackageId, pendingEvidenceRecovery.workPackageId);
    assert.ok(evidenceRecovery.revisionFence?.fingerprint);
    const recoveryVerification = deterministicVerification(evidenceRecovery);
    assert.equal(recoveryVerification.passed, true);
    integrateDirectorArtifact(task, evidenceRecovery.workPackageId, {
      kind: "verification-result",
      actions: [{ passed: true }],
      acceptanceEvidence: evidence,
    }, {
      jobId: "job-evidence-recovery-0001",
      handoff: {
        state: "completed",
        summary: "Package-linked deterministic verification closed the remaining acceptance gap.",
        changedFiles: [],
        verification: recoveryVerification,
        deliverable: { kind: "verification-result", actions: [{ passed: true }], acceptanceEvidence: evidence },
      },
      baseIntegration: { integrated: true, typedDeliverable: true },
    });

    task = readTask(taskId);
    assert.equal(task.state, "completed");
    assert.equal(task.program.phase, "completed");
    assert.ok(task.requirements.every((row) => row.status === "passing"));
    assert.ok(task.program.masterPlan.workstreams.every((row) => row.state === "completed"));
    assert.ok(task.program.masterPlan.milestones.every((row) => row.state === "completed"));
    assert.equal(task.program.mission.state, "completed");
    assert.equal(task.program.contracts.state, "completed");
    const completedMissionRevision = task.program.mission.revision;
    const summary = directorProgramSummary(task);
    assert.equal(summary.execution.status, "completed");
    const firstReport = emitProgramReport(taskId);
    const duplicateReport = emitProgramReport(taskId);
    assert.equal(firstReport.emit, true);
    assert.equal(duplicateReport.emit, false);
    const corrected = reconcileTask({
      taskId,
      userRequest: "Keep the feature, but revise the user-visible outcome and rebuild the plan.",
      outcome: "Build, verify, and document the revised user-visible feature.",
      acceptanceEvidence: [
        { id: "REQ-REVISED", description: "The revised user-visible feature is documented and verified.", minimumEvidenceLevel: "user-visible" },
      ],
    });
    assert.equal(corrected.program.phase, "context");
    assert.equal(corrected.program.mission.revision, completedMissionRevision + 1);
    assert.equal(corrected.program.plan, null);
    const revisedTask = readTask(taskId);
    assert.equal(revisedTask.program.mission.state, "active");
    assert.equal(revisedTask.program.masterPlan, null);
    assert.equal(revisedTask.program.resourceBudget, null);
    assert.equal(revisedTask.program.workPackages.filter((row) => row.state === "pending" && row.executorKind === "context-scout").length, 1);
    assert.equal(routingGuardRegression(workspace), true);
    assert.equal(staleCorrectionRegression(workspace), true);

    console.log(JSON.stringify({
      ok: true,
      directBypass: direct.mode,
      finalPhase: task.program.phase,
      contextModel: "gpt-5.6-terra",
      strategyModel: "fable-5",
      failureReconciled: task.program.failureMemory.length,
      premiumRouteReachedLaunch: true,
      rejectedAllocationReleased: true,
      terminalIntegrationFailure,
      planRevision,
      userDecisionOnly,
      executionContextScout,
      duplicateFailureNoOp: true,
      reconciliationChangeApplied: true,
      staleFenceRejected: true,
      staleCorrectionPreserved: true,
      contextFreshness,
      userCorrectionInvalidatedPlan: true,
      reportDeduplicated: true,
    }, null, 2));
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
    delete process.env.AI_MOBILE_DATA_ROOT;
  }
}

run();
