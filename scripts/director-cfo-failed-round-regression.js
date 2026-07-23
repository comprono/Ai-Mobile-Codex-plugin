#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "director-cfo-failed-round-"));
process.env.AI_MOBILE_DATA_ROOT = path.join(root, "state");
const workspace = path.join(root, "workspace");
fs.mkdirSync(path.join(workspace, ".codex"), { recursive: true });
fs.writeFileSync(path.join(workspace, ".codex", "PROJECT_OUTCOME.md"), "# Outcome\nRecover failed Director workers through strong reconciliation.\n", "utf8");
fs.writeFileSync(path.join(workspace, ".codex", "ACCEPTANCE.json"), JSON.stringify({ requirements: ["reconciled"] }, null, 2) + "\n", "utf8");

const { runCoordinator } = require("./core/coordinator");
const {
  prepareProgramDispatch,
  integrateDirectorArtifact,
  programRecommendedWorkUnits,
  recordProgramFailure,
  startDirectorProgram,
} = require("./core/director-cfo-orchestrator");
const { readMaterialEvents } = require("./core/material-events");
const {
  dispatchRound,
  collectRound,
  integrateRound,
} = require("./core/task-orchestrator");
const {
  jobDirectory,
  readRound,
  listJobIds,
  readTask,
  taskDirectory,
  updateRound,
} = require("./core/state-store");
const { readJson, writeJson } = require("./core/utils");

function provider(id, model, tier) {
  return {
    id,
    available: true,
    authenticated: true,
    headless: true,
    authMode: "subscription",
    command: process.execPath,
    models: [{ id: model, displayName: model, capabilityTier: tier }],
    surfaces: {
      headless: true,
      source: true,
      "local-files": true,
      git: true,
      tests: true,
      command: true,
      database: true,
      "service-control": true,
      browser: id === "antigravity",
    },
    permissions: {
      command: true,
      database: true,
      "service-control": true,
      browser: id === "antigravity",
      "external-write": id === "antigravity",
    },
    capacity: { remainingPercent: 80, source: "fixture" },
    quotaPools: [],
  };
}

const resources = {
  generatedAt: new Date().toISOString(),
  machine: { freeRamMb: 12000, totalRamMb: 16000, logicalCpuCount: 8 },
  worktreeStorage: { freeMb: 20000, minimumFreeMb: 1, quotaMb: 2048, withinQuota: true, hasMinimumFree: true },
  providers: {
    antigravity: provider("antigravity", "gemini-3.6-flash-low", "efficient"),
    claude: provider("claude", "fable-5", "frontier"),
    codex: provider("codex", "gpt-5.6-terra", "balanced"),
  },
};

function validContextArtifact(task, workPackage) {
  const snapshots = new Map((workPackage.bootstrapContract?.sourceSnapshotManifest?.snapshots || []).map((row) => [row.sourceId, row]));
  const sourceObservations = task.program.sourceCatalog.sources.map((source) => {
    const snapshot = snapshots.get(source.id);
    if (!snapshot || snapshot.state === "unavailable") {
      return {
        sourceId: source.id,
        status: "unavailable",
        fingerprint: "",
        queryReceiptFingerprint: "",
        queryReceiptSnapshotHash: "",
        revision: "",
        summary: "",
        error: snapshot?.error || "No deterministic snapshot was supplied.",
      };
    }
    return {
      sourceId: source.id,
      status: "observed",
      fingerprint: snapshot.fingerprint,
      queryReceiptFingerprint: "",
      queryReceiptSnapshotHash: "",
      revision: snapshot.revision || "",
      summary: `Observed ${source.id} from the immutable Director snapshot.`,
      error: "",
    };
  });
  const citedSource = sourceObservations.find((row) => row.status !== "unavailable")?.sourceId;
  assert.ok(citedSource, "The semantic recovery fixture requires one observable source.");
  return {
    kind: "context-dossier",
    realGoal: task.program.mission.outcome,
    executiveSummary: "Recovered a complete cited dossier after applying the reconciler's stronger worker contract.",
    currentState: [{ text: "The corrected context worker completed the authorized snapshot pass.", sourceIds: [citedSource] }],
    sourceObservations,
    facts: [{ text: "The retry used a fresh immutable Director snapshot.", sourceIds: [citedSource] }],
    assumptions: [],
    unknowns: [],
    constraints: [],
    decisions: [],
    failures: [],
    risks: [],
  };
}

(async () => {
  try {
    const started = startDirectorProgram({
      workspace,
      outcome: "Recover an all-failed context round without leaving stale ownership.",
      forceProgram: true,
      acceptanceEvidence: [{
        id: "REQ-FAILED-ROUND",
        description: "A failed context worker produces one strong reconciliation package.",
        minimumEvidenceLevel: "integration",
      }],
    }, resources);
    const prepared = prepareProgramDispatch(readTask(started.taskId), resources);
    const context = prepared.program.workPackages.find((row) => row.executorKind === "context-scout" && row.state === "ready");
    assert.ok(context, "Context package must be budgeted and ready.");

    const failedJobId = "job-director-all-failed-0001";
    const dispatched = dispatchRound({ taskId: started.taskId }, resources, {}, (contract) => {
      const dir = jobDirectory(started.taskId, failedJobId);
      fs.mkdirSync(dir, { recursive: true });
      writeJson(path.join(dir, "contract.json"), { ...contract, taskId: started.taskId, jobId: failedJobId });
      writeJson(path.join(dir, "status.json"), {
        taskId: started.taskId,
        jobId: failedJobId,
        state: "failed",
        provider: contract.provider,
        model: contract.model,
        blocker: "provider-process-failed: spawnSync agy.exe ENAMETOOLONG",
        createdAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
      });
      writeJson(path.join(dir, "handoff.json"), {
        state: "failed",
        blocker: "provider-process-failed: spawnSync agy.exe ENAMETOOLONG",
        summary: "The provider process could not receive the complete Director prompt.",
      });
      return {
        taskId: started.taskId,
        jobId: failedJobId,
        state: "queued",
        provider: contract.provider,
        model: contract.model,
        readOnly: true,
      };
    });
    assert.equal(dispatched.workers.length, 1);
    assert.equal(dispatched.workers[0].jobId, failedJobId);

    const executionId = "execution-director-all-failed";
    writeJson(path.join(taskDirectory(started.taskId), "coordinator.json"), {
      schemaVersion: 1,
      executionId,
      state: "running",
      pid: process.pid,
      roundsStarted: 1,
      lastRoundId: dispatched.roundId,
      startedAt: new Date().toISOString(),
    });
    const result = await runCoordinator({
      taskId: started.taskId,
      executionId,
      config: { maxRounds: 1, maxMinutes: 1, noProgressLimit: 2, horizonHours: 5 },
    }, path.join(__dirname, "ai-mobile-local-mcp.js"), {
      inventory: async () => resources,
      providerHistory: () => ({}),
      createJob: () => { throw new Error("The round limit must stop before dispatching reconciliation."); },
    });

    assert.equal(result.stopReason, "round-limit", JSON.stringify(result));
    const reconciled = readTask(started.taskId);
    const failedContext = reconciled.program.workPackages.find((row) => row.workPackageId === context.workPackageId);
    const reconciliation = reconciled.program.workPackages.filter((row) => row.executorKind === "reconciliation");
    assert.equal(reconciled.program.phase, "reconciliation");
    assert.equal(failedContext.state, "failed");
    assert.equal(reconciled.program.workPackages.some((row) => row.state === "running"), false);
    assert.equal(reconciled.program.failureMemory.length, 1);
    assert.equal(reconciled.program.failureMemory[0].attemptId, failedJobId);
    assert.equal(reconciliation.length, 1);
    assert.ok(["pending", "ready"].includes(reconciliation[0].state));
    assert.equal(reconciliation[0].minimumCapabilityTier, "frontier");
    assert.equal(reconciliation[0].failurePacket.attemptId, failedJobId);
    assert.equal(reconciliation[0].resourceEstimate.tokens, 150000, "A frontier reconciliation allocation must cover the observed Codex invocation overhead instead of guaranteeing a post-run budget failure.");

    const round = readRound(started.taskId, dispatched.roundId);
    assert.equal(round.state, "correction-scheduled");
    assert.equal(round.integrationResults[0].reconciled, true);
    const events = readMaterialEvents({ taskId: started.taskId, maxEvents: 50 }).events;
    assert.ok(events.some((event) => event.type === "round.integrated"));
    assert.equal(events.some((event) => event.blocker === "no-dependency-ready-unit"), false);

    integrateRound({ taskId: started.taskId, roundId: dispatched.roundId });
    const replayed = readTask(started.taskId);
    assert.equal(replayed.program.failureMemory.length, 1, "Repeated integration must not duplicate the failure packet.");
    assert.equal(replayed.program.workPackages.filter((row) => row.executorKind === "reconciliation").length, 1, "Repeated integration must not duplicate reconciliation work.");

    const restartStarted = startDirectorProgram({
      workspace,
      outcome: "Resume an already-collected pre-plan reconciliation without duplicating its worker or round.",
      forceProgram: true,
      acceptanceEvidence: [{
        id: "REQ-RESTART-REPLAY",
        description: "A stopped no-dependency execution replays its terminal reconciliation exactly once.",
        minimumEvidenceLevel: "integration",
      }],
    }, resources);
    const restartPrepared = prepareProgramDispatch(readTask(restartStarted.taskId), resources);
    const restartContext = restartPrepared.program.workPackages.find((row) => row.executorKind === "context-scout" && row.state === "ready");
    assert.ok(restartContext, "Restart replay fixture requires a budgeted context package.");
    const restartFailedContextJobId = "job-restart-context-failed-0001";
    recordProgramFailure(
      restartPrepared,
      restartContext,
      "context scout artifact requires a non-empty executiveSummary",
      {
        jobId: restartFailedContextJobId,
        provider: restartContext.allocation.provider,
        model: restartContext.allocation.model,
        summary: "The original context artifact violated its typed Director contract.",
      },
    );

    const restartReconciliationPrepared = prepareProgramDispatch(readTask(restartStarted.taskId), resources);
    const restartReconciliation = restartReconciliationPrepared.program.workPackages.find((row) => row.executorKind === "reconciliation" && row.state === "ready");
    assert.ok(restartReconciliation, "Restart replay fixture requires a strong reconciliation package.");
    assert.equal(restartReconciliation.revisionFence, null, "Pre-plan reconciliation must have no canonical revision fence.");
    const restartReconciliationJobId = "job-restart-reconciliation-completed-0001";
    const restartDecision = {
      kind: "reconciliation-decision",
      rootCause: "The completed context artifact violated the typed dossier contract.",
      failureClass: "director-contract",
      evidence: ["The Director rejected executiveSummary before accepting a context dossier."],
      contextRefresh: true,
      changedWorkerRequirements: {
        minimumCapabilityTier: "frontier",
        timeoutSeconds: 1200,
        maxWorkerOutputTokens: 4000,
        postconditions: ["Return a schema-valid, source-backed dossier for every required authorized source."],
      },
      retryEligibility: true,
      failureFingerprint: restartReconciliation.failurePacket.failureFingerprint,
    };
    const restartDispatch = dispatchRound({ taskId: restartStarted.taskId }, resources, {}, (contract) => {
      assert.equal(contract.executorKind, "reconciliation");
      assert.equal(contract.directorProgram?.workPackageId, restartReconciliation.workPackageId);
      assert.equal(contract.directorProgram?.revisionFence, null);
      assert.equal(contract.revisionFence, null);
      const dir = jobDirectory(restartStarted.taskId, restartReconciliationJobId);
      fs.mkdirSync(dir, { recursive: true });
      writeJson(path.join(dir, "contract.json"), { ...contract, taskId: restartStarted.taskId, jobId: restartReconciliationJobId });
      writeJson(path.join(dir, "status.json"), {
        taskId: restartStarted.taskId,
        jobId: restartReconciliationJobId,
        state: "completed",
        provider: contract.provider,
        model: contract.model,
        createdAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
      });
      writeJson(path.join(dir, "handoff.json"), {
        state: "completed",
        summary: "Refresh the complete authorized context before strategy.",
        artifact: restartDecision,
        deliverable: restartDecision,
      });
      return {
        taskId: restartStarted.taskId,
        jobId: restartReconciliationJobId,
        state: "queued",
        provider: contract.provider,
        model: contract.model,
        readOnly: true,
      };
    });
    assert.equal(restartDispatch.workers.length, 1);
    const restartCollected = collectRound({
      taskId: restartStarted.taskId,
      roundId: restartDispatch.roundId,
      waitSeconds: 0,
      detail: "full",
    });
    assert.equal(restartCollected.state, "ready-for-integration");
    updateRound(restartStarted.taskId, restartDispatch.roundId, {
      state: "needs-correction",
      integratedAt: null,
      integrationResults: [{
        jobId: restartReconciliationJobId,
        integrated: false,
        reconciled: false,
        managerTransition: false,
        stale: false,
        blocker: "director-revision-fence-missing",
      }],
    });

    const stalledRestartTask = readTask(restartStarted.taskId);
    const stalledRestartPackage = stalledRestartTask.program.workPackages.find((row) => row.workPackageId === restartReconciliation.workPackageId);
    const stalledRestartGraph = stalledRestartTask.workGraph.find((row) => row.id === restartReconciliation.workPackageId);
    assert.equal(stalledRestartTask.program.phase, "reconciliation");
    assert.equal(stalledRestartTask.program.contextDossier, null);
    assert.equal(stalledRestartTask.program.masterPlan, null);
    assert.equal(stalledRestartTask.program.contracts?.campaign ?? null, null);
    assert.equal(stalledRestartTask.program.nextAction, "Wait for material worker terminals; then integrate each fenced deliverable once.");
    assert.equal(stalledRestartPackage.state, "running");
    assert.equal(stalledRestartPackage.jobId, restartReconciliationJobId);
    assert.equal(stalledRestartPackage.revisionFence, null);
    assert.equal(stalledRestartGraph.owner, null, "Collection must clear graph ownership while preserving the exact stale package state.");
    const restartJobStatus = readJson(path.join(jobDirectory(restartStarted.taskId, restartReconciliationJobId), "status.json"), {});
    assert.equal(restartJobStatus.state, "completed");
    assert.ok(restartJobStatus.collectedAt, "The exact stalled worker must already be collected.");

    const restartCoordinatorPath = path.join(taskDirectory(restartStarted.taskId), "coordinator.json");
    const stoppedExecutionId = "execution-restart-stopped-no-dependency";
    writeJson(restartCoordinatorPath, {
      schemaVersion: 1,
      executionId: stoppedExecutionId,
      state: "stopped",
      pid: null,
      stopReason: "no-dependency-ready-unit",
      roundsStarted: 1,
      lastRoundId: restartDispatch.roundId,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
    });
    const seededStoppedCoordinator = readJson(restartCoordinatorPath, {});
    assert.equal(seededStoppedCoordinator.state, "stopped");
    assert.equal(seededStoppedCoordinator.stopReason, "no-dependency-ready-unit");

    const restartJobIdsBefore = listJobIds(restartStarted.taskId);
    const restartRoundIdsBefore = readTask(restartStarted.taskId).rounds.map((row) => row.roundId);
    const restartFailureCountBefore = stalledRestartTask.program.failureMemory.length;
    const restartUnavailableResources = {
      ...resources,
      providers: Object.fromEntries(Object.entries(resources.providers).map(([id, row]) => [id, {
        ...row,
        available: false,
      }])),
    };
    const resumedExecutionId = "execution-restart-replay-fixed-runtime";
    writeJson(restartCoordinatorPath, {
      schemaVersion: 1,
      executionId: resumedExecutionId,
      state: "running",
      pid: process.pid,
      stopReason: "",
      roundsStarted: 0,
      lastRoundId: null,
      startedAt: new Date().toISOString(),
      finishedAt: null,
    });
    let restartReplayCreateCalls = 0;
    const restartResult = await runCoordinator({
      taskId: restartStarted.taskId,
      executionId: resumedExecutionId,
      config: { maxRounds: 1, maxMinutes: 1, noProgressLimit: 2, horizonHours: 5 },
    }, path.join(__dirname, "ai-mobile-local-mcp.js"), {
      inventory: async () => restartUnavailableResources,
      providerHistory: () => ({}),
      createJob: () => {
        restartReplayCreateCalls += 1;
        throw new Error("Restart replay must integrate before any new worker dispatch.");
      },
    });
    assert.equal(restartResult.stopReason, "no-eligible-worker", JSON.stringify(restartResult));
    assert.equal(restartReplayCreateCalls, 0, "The bounded replay must not create another worker.");

    const restartRecovered = readTask(restartStarted.taskId);
    const recoveredReconciliation = restartRecovered.program.workPackages.find((row) => row.workPackageId === restartReconciliation.workPackageId);
    const recoveredReconciliationGraph = restartRecovered.workGraph.find((row) => row.id === restartReconciliation.workPackageId);
    const pendingRestartContexts = restartRecovered.program.workPackages.filter((row) => row.executorKind === "context-scout" && row.state === "pending");
    assert.equal(restartRecovered.program.phase, "context");
    assert.equal(restartRecovered.program.state, "active");
    assert.equal(restartRecovered.program.activeCampaign, null);
    assert.match(restartRecovered.program.nextAction, /no package passed the current budget and permission gates/i);
    assert.doesNotMatch(restartRecovered.program.nextAction, /wait for material worker/i);
    assert.equal(recoveredReconciliation.state, "completed");
    assert.equal(recoveredReconciliation.jobId, restartReconciliationJobId, "The terminal job id remains provenance, not running ownership.");
    assert.ok(recoveredReconciliation.completedAt);
    assert.equal(recoveredReconciliationGraph.state, "completed");
    assert.equal(recoveredReconciliationGraph.owner, null);
    assert.equal(restartRecovered.program.workPackages.some((row) => row.state === "running"), false);
    assert.equal(pendingRestartContexts.length, 1, "Reconciliation must create exactly one replacement context package.");
    assert.equal(String(pendingRestartContexts[0].jobId || ""), "");
    assert.equal(pendingRestartContexts[0].revisionFence, null);
    const pendingRestartContextGraph = restartRecovered.workGraph.find((row) => row.id === pendingRestartContexts[0].workPackageId);
    assert.equal(pendingRestartContextGraph.state, "pending");
    assert.equal(pendingRestartContextGraph.owner, null);

    const restartIntegratedRound = readRound(restartStarted.taskId, restartDispatch.roundId);
    assert.equal(restartIntegratedRound.state, "integrated");
    assert.equal(restartIntegratedRound.integrationResults.length, 1);
    assert.equal(restartIntegratedRound.integrationResults[0].integrated, true);
    assert.deepEqual(listJobIds(restartStarted.taskId), restartJobIdsBefore, "Restart replay must not duplicate a worker job.");
    assert.deepEqual(restartRecovered.rounds.map((row) => row.roundId), restartRoundIdsBefore, "Restart replay must not duplicate a round.");
    assert.equal(restartRecovered.program.failureMemory.length, restartFailureCountBefore);
    assert.equal(restartRecovered.program.workPackages.filter((row) => row.executorKind === "reconciliation").length, 1);

    const restartEvents = readMaterialEvents({ taskId: restartStarted.taskId, maxEvents: 50 }).events
      .filter((event) => event.executionId === resumedExecutionId);
    assert.ok(restartEvents.some((event) => event.type === "round.integrated" && event.state === "integrated"));
    assert.equal(restartEvents.some((event) => event.blocker === "no-dependency-ready-unit"), false);
    assert.equal(restartEvents.some((event) => /wait for material worker terminals/i.test(event.nextAction || "")), false);
    const restartStopEvent = restartEvents.find((event) => event.type === "coordinator.stopped");
    assert.equal(restartStopEvent?.blocker, "no-eligible-worker");
    assert.doesNotMatch(restartStopEvent?.nextAction || "", /wait for material worker/i);
    const resumedCoordinator = readJson(restartCoordinatorPath, {});
    assert.equal(resumedCoordinator.state, "stopped");
    assert.equal(resumedCoordinator.stopReason, "no-eligible-worker");

    const completedAtBeforeReplay = recoveredReconciliation.completedAt;
    const replayIntegration = integrateRound({ taskId: restartStarted.taskId, roundId: restartDispatch.roundId });
    assert.equal(replayIntegration.integrations.length, 1);
    assert.equal(replayIntegration.integrations[0].integrated, true);
    assert.equal(replayIntegration.integrations[0].alreadyIntegrated, true);
    const restartReplayed = readTask(restartStarted.taskId);
    assert.equal(restartReplayed.program.workPackages.find((row) => row.workPackageId === restartReconciliation.workPackageId).completedAt, completedAtBeforeReplay);
    assert.equal(restartReplayed.program.failureMemory.length, restartFailureCountBefore);
    assert.equal(restartReplayed.program.workPackages.filter((row) => row.executorKind === "reconciliation").length, 1);
    assert.equal(restartReplayed.program.workPackages.filter((row) => row.executorKind === "context-scout" && row.state === "pending").length, 1);
    assert.deepEqual(listJobIds(restartStarted.taskId), restartJobIdsBefore);
    assert.deepEqual(restartReplayed.rounds.map((row) => row.roundId), restartRoundIdsBefore);

    const restartBudgeted = prepareProgramDispatch(restartReplayed, resources);
    const readyRestartContexts = restartBudgeted.program.workPackages.filter((row) => row.executorKind === "context-scout" && row.state === "ready");
    assert.equal(readyRestartContexts.length, 1);
    assert.equal(readyRestartContexts[0].workPackageId, pendingRestartContexts[0].workPackageId);
    assert.ok(readyRestartContexts[0].allocation);
    assert.equal(String(readyRestartContexts[0].jobId || ""), "");
    assert.equal(readyRestartContexts[0].revisionFence, null);
    const readyRestartContextGraph = restartBudgeted.workGraph.find((row) => row.id === readyRestartContexts[0].workPackageId);
    assert.equal(readyRestartContextGraph.state, "pending");
    assert.equal(readyRestartContextGraph.owner, null);
    const restartRecommendations = programRecommendedWorkUnits(restartBudgeted);
    assert.equal(restartRecommendations.length, 1);
    assert.equal(restartRecommendations[0].workPackageId, readyRestartContexts[0].workPackageId);
    assert.deepEqual(listJobIds(restartStarted.taskId), restartJobIdsBefore);
    assert.deepEqual(restartBudgeted.rounds.map((row) => row.roundId), restartRoundIdsBefore);

    const semanticResources = {
      ...resources,
      providers: {
        antigravity: { ...resources.providers.antigravity, available: false },
        claude: {
          ...resources.providers.claude,
          models: [
            { id: "sonnet", displayName: "sonnet", capabilityTier: "balanced" },
            { id: "fable-5", displayName: "fable-5", capabilityTier: "frontier" },
          ],
        },
        codex: { ...resources.providers.codex, available: false },
      },
    };
    const semanticStarted = startDirectorProgram({
      workspace,
      outcome: "Recover a semantic context integration failure on the same provider without poisoning its stronger reconciler.",
      forceProgram: true,
      acceptanceEvidence: [{
        id: "REQ-SEMANTIC-RECOVERY",
        description: "A completed but invalid context artifact is reconciled by a stronger model on the same provider.",
        minimumEvidenceLevel: "integration",
      }],
    }, semanticResources);
    const semanticPrepared = prepareProgramDispatch(readTask(semanticStarted.taskId), semanticResources);
    const semanticContext = semanticPrepared.program.workPackages.find((row) => row.executorKind === "context-scout" && row.state === "ready");
    assert.equal(semanticContext.allocation.provider, "claude");
    assert.equal(semanticContext.allocation.model, "sonnet");

    const semanticContextJobId = "job-semantic-context-0001";
    const semanticContextRound = dispatchRound({ taskId: semanticStarted.taskId }, semanticResources, {}, (contract) => {
      const dir = jobDirectory(semanticStarted.taskId, semanticContextJobId);
      fs.mkdirSync(dir, { recursive: true });
      writeJson(path.join(dir, "contract.json"), { ...contract, taskId: semanticStarted.taskId, jobId: semanticContextJobId });
      writeJson(path.join(dir, "status.json"), {
        taskId: semanticStarted.taskId,
        jobId: semanticContextJobId,
        state: "completed",
        provider: contract.provider,
        model: contract.model,
        createdAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
      });
      writeJson(path.join(dir, "handoff.json"), {
        state: "completed",
        summary: "The context worker returned a semantically invalid dossier.",
        artifact: { kind: "context-dossier" },
        deliverable: { kind: "context-dossier" },
      });
      return {
        taskId: semanticStarted.taskId,
        jobId: semanticContextJobId,
        state: "queued",
        provider: contract.provider,
        model: contract.model,
        readOnly: true,
      };
    });
    assert.equal(semanticContextRound.workers.length, 1);

    const semanticExecutionId = "execution-semantic-recovery";
    writeJson(path.join(taskDirectory(semanticStarted.taskId), "coordinator.json"), {
      schemaVersion: 1,
      executionId: semanticExecutionId,
      state: "running",
      pid: process.pid,
      roundsStarted: 1,
      lastRoundId: semanticContextRound.roundId,
      startedAt: new Date().toISOString(),
    });
    let reconciliationContract = null;
    let retryContextContract = null;
    let retrySnapshotInvalidated = false;
    const semanticResult = await runCoordinator({
      taskId: semanticStarted.taskId,
      executionId: semanticExecutionId,
      config: { maxRounds: 3, maxMinutes: 1, noProgressLimit: 2, horizonHours: 5 },
    }, path.join(__dirname, "ai-mobile-local-mcp.js"), {
      inventory: async () => {
        const current = readTask(semanticStarted.taskId);
        const pendingRetry = current.program.workPackages.find((row) => row.executorKind === "context-scout" && row.retryOfWorkPackageId && row.state === "pending");
        if (pendingRetry && !retrySnapshotInvalidated) {
          fs.appendFileSync(path.join(workspace, ".codex", "PROJECT_OUTCOME.md"), "\nReconciliation retry snapshot refresh fixture.\n", "utf8");
          retrySnapshotInvalidated = true;
        }
        return semanticResources;
      },
      providerHistory: () => ({}),
      createJob: (contract) => {
        if (contract.executorKind === "context-scout") {
          retryContextContract = contract;
          assert.equal(contract.provider, "claude");
          assert.equal(contract.model, "fable-5");
          assert.notEqual(contract.directorProgram?.workPackageId, semanticContext.workPackageId);
          const retryJobId = "job-semantic-context-retry-0001";
          const retryDir = jobDirectory(semanticStarted.taskId, retryJobId);
          fs.mkdirSync(retryDir, { recursive: true });
          const artifact = validContextArtifact(readTask(semanticStarted.taskId), {
            bootstrapContract: contract.directorWorkerContract?.bootstrapContract,
          });
          writeJson(path.join(retryDir, "contract.json"), { ...contract, taskId: semanticStarted.taskId, jobId: retryJobId });
          writeJson(path.join(retryDir, "status.json"), {
            taskId: semanticStarted.taskId,
            jobId: retryJobId,
            state: "completed",
            provider: contract.provider,
            model: contract.model,
            createdAt: new Date().toISOString(),
            finishedAt: new Date().toISOString(),
          });
          writeJson(path.join(retryDir, "handoff.json"), {
            state: "completed",
            summary: "The corrected frontier context worker returned a valid cited dossier.",
            artifact,
            deliverable: artifact,
          });
          return {
            taskId: semanticStarted.taskId,
            jobId: retryJobId,
            state: "queued",
            provider: contract.provider,
            model: contract.model,
            readOnly: true,
          };
        }
        reconciliationContract = contract;
        assert.equal(contract.executorKind, "reconciliation");
        assert.equal(contract.provider, "claude");
        assert.equal(contract.model, "fable-5");
        const failurePacket = contract.directorWorkerContract?.reconciliation?.failurePacket;
        assert.ok(failurePacket?.failureFingerprint);
        assert.equal(contract.directorWorkerContract.executionEnvelope.artifactContract.requiredContextRefresh, true, "A pre-context reconciliation must immutably require a context refresh.");
        assert.equal(contract.directorWorkerContract.reconciliation.policy.fullContextRefresh, true);
        const reconciliationJobId = "job-semantic-reconciliation-0001";
        const dir = jobDirectory(semanticStarted.taskId, reconciliationJobId);
        fs.mkdirSync(dir, { recursive: true });
        writeJson(path.join(dir, "contract.json"), { ...contract, taskId: semanticStarted.taskId, jobId: reconciliationJobId });
        writeJson(path.join(dir, "status.json"), {
          taskId: semanticStarted.taskId,
          jobId: reconciliationJobId,
          state: "completed",
          provider: contract.provider,
          model: contract.model,
          createdAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
        });
        const decision = {
          kind: "reconciliation-decision",
          rootCause: "The completed context artifact did not satisfy the typed dossier contract.",
          failureClass: "director-contract",
          evidence: ["The Director rejected the artifact before accepting any context dossier."],
          contextRefresh: true,
          changedWorkerRequirements: {
            minimumCapabilityTier: "frontier",
            timeoutSeconds: 1200,
            maxWorkerOutputTokens: 4000,
            postconditions: ["Return a schema-valid, source-backed dossier for every required authorized source."],
          },
          retryEligibility: true,
          failureFingerprint: failurePacket.failureFingerprint,
        };
        writeJson(path.join(dir, "handoff.json"), {
          state: "completed",
          summary: "Refresh the complete authorized context before strategy.",
          artifact: decision,
          deliverable: decision,
        });
        return {
          taskId: semanticStarted.taskId,
          jobId: reconciliationJobId,
          state: "queued",
          provider: contract.provider,
          model: contract.model,
          readOnly: true,
        };
      },
    });

    assert.equal(semanticResult.stopReason, "round-limit", JSON.stringify(semanticResult));
    assert.ok(reconciliationContract, "The stronger same-provider reconciler must be dispatched.");
    assert.ok(retryContextContract, "The reconciler's corrected context retry must be dispatched.");
    assert.equal(retrySnapshotInvalidated, true, "The retry fixture must exercise pending-bootstrap refresh after reconciliation.");
    const semanticRecovered = readTask(semanticStarted.taskId);
    const completedReconciliation = semanticRecovered.program.workPackages.find((row) => row.executorKind === "reconciliation");
    const originalContext = semanticRecovered.program.workPackages.find((row) => row.workPackageId === semanticContext.workPackageId);
    const retryWorkPackageId = retryContextContract.directorProgram.workPackageId;
    const completedRetry = semanticRecovered.program.workPackages.find((row) => row.workPackageId === retryWorkPackageId);
    const packageIds = semanticRecovered.program.workPackages.map((row) => row.workPackageId);
    assert.equal(new Set(packageIds).size, packageIds.length, "Director work-package ids must remain unique across reconciliation retries.");
    assert.equal(completedReconciliation.state, "completed");
    assert.equal(completedReconciliation.failurePacket.failureClass, "director-contract");
    assert.equal(completedReconciliation.materialDeltaRequired.anyOf.includes("contextRefresh"), false);
    assert.ok(completedReconciliation.materialDeltaRequired.anyOf.includes("changedWorkerRequirements"));
    assert.equal(originalContext.state, "superseded");
    assert.ok(completedRetry, "The corrected context retry must remain in durable program state.");
    assert.equal(completedRetry.state, "completed");
    assert.equal(completedRetry.retryOfWorkPackageId, semanticContext.workPackageId);
    assert.equal(completedRetry.minimumCapabilityTier, "frontier");
    assert.deepEqual(completedRetry.requestedReconciliationPatch.postconditions, ["Return a schema-valid, source-backed dossier for every required authorized source."]);
    assert.deepEqual(completedRetry.requiredCapabilities, ["source", "local-files"]);
    assert.deepEqual(completedRetry.requiredPermissions, ["read-project", "read-files"]);
    assert.equal(completedRetry.reconciliationAdjustments.safeContextTransport, "immutable-sqlite-receipt");
    assert.equal(completedRetry.reconciliationAdjustments.strongRetry, true);
    assert.equal(completedRetry.reconciledContract.minimumCapabilityTier, "frontier");
    assert.equal(semanticRecovered.program.phase, "strategy");
    assert.ok(semanticRecovered.program.contextDossier, "The corrected retry must integrate a durable context dossier.");
    assert.equal(semanticRecovered.program.workPackages.some((row) => row.state === "running"), false);
    assert.match(semanticRecovered.program.nextAction, /strategist/i);
    const strategyPrepared = prepareProgramDispatch(semanticRecovered, semanticResources);
    const readyStrategists = strategyPrepared.program.workPackages.filter((row) => row.executorKind === "strategist" && row.state === "ready");
    assert.equal(readyStrategists.length, 1);
    assert.equal(readyStrategists[0].allocation.provider, "claude");
    assert.equal(readyStrategists[0].allocation.model, "fable-5");
    assert.equal(strategyPrepared.program.workPackages.find((row) => row.workPackageId === semanticContext.workPackageId).state, "superseded");

    process.stdout.write(JSON.stringify({
      ok: true,
      allFailedDirectorRoundIntegrated: true,
      failureMemoryRecordedOnce: true,
      strongReconciliationScheduled: true,
      staleRunningOwnershipCleared: true,
      noDependencyDeadEndAvoided: true,
      stoppedNoDependencyRestartReplayed: true,
      semanticFailureDidNotPoisonProvider: true,
      prePlanReconciliationTriggeredContextRefresh: true,
    }, null, 2) + "\n");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    delete process.env.AI_MOBILE_DATA_ROOT;
  }
})().catch((error) => {
  process.stderr.write((error.stack || error.message) + "\n");
  process.exitCode = 1;
});
