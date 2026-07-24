#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "director-cfo-campaign-continuation-"));
process.env.AI_MOBILE_DATA_ROOT = path.join(root, "state");
const workspace = path.join(root, "workspace");
fs.mkdirSync(workspace, { recursive: true });

const { createCampaign, evidenceFingerprint, startCampaign } = require("./core/campaign-engine");
const { capacityFingerprint } = require("./core/capacity-wait");
const { __test: coordinatorTest, readCoordinator, runCampaignSupervisor, startCoordinator } = require("./core/coordinator");
const { readMaterialEvents } = require("./core/material-events");
const { createRoundRecord, createTaskRecord, jobDirectory, listJobIds, readTask, taskDirectory, updateRound, updateTask } = require("./core/state-store");
const { writeJson } = require("./core/utils");

const config = {
  maxRounds: 1,
  maxMinutes: 1,
  noProgressLimit: 2,
  horizonHours: 1,
  capacityBackoffSeconds: 1,
  capacityMaxBackoffSeconds: 2,
  capacityWaitChecks: 2,
};

function createDirectorFixture(label, noProgressLimit = 2, includeFoundation = false) {
  const fixtureWorkspace = path.join(workspace, label);
  fs.mkdirSync(fixtureWorkspace, { recursive: true });
  const created = createTaskRecord({
    workspace: fixtureWorkspace,
    outcome: `Continue ${label} without another user message.`,
    outcomeAuthority: "user",
    requirements: [{
      id: `REQ-${label.toUpperCase()}`,
      description: "The next safe action is reached with authoritative acceptance evidence.",
      required: true,
      status: "failing",
      minimumEvidenceLevel: "integration",
      evidence: [],
      blocker: null,
    }],
    currentCodex: { model: "gpt-5.3-codex-spark", effort: "medium", files: [] },
    workGraph: [{ id: `work-${label}`, state: "running", dependsOn: [], priority: 100 }],
  });
  const startedAt = new Date().toISOString();
  const campaign = startCampaign(createCampaign({
    missionId: `mission-${label}`,
    maxHours: 1,
    maxWorkers: 1,
    noProgressLimit,
    evidence: [],
    allocationIds: [`allocation-${label}`],
    createdAt: startedAt,
  }), startedAt);
  updateTask(created.taskId, (task) => {
    task.program = {
      mode: "director-cfo",
      state: "active",
      phase: "execution",
      mission: { missionId: `mission-${label}`, outcome: task.outcome, state: "active" },
      activeCampaign: campaign,
      campaigns: [campaign],
      workPackages: [{
        workPackageId: `work-${label}`,
        state: "running",
        jobId: `job-${label}`,
        allocation: { allocationId: `allocation-${label}` },
      }],
      executionReceipts: [],
      evidenceLedger: { entries: [] },
      runtime: { budget: { budgetRevision: 1, allocations: [], deferred: [], reserves: {} } },
      nextAction: "Continue the next bounded slice.",
    };
    if (includeFoundation) {
      task.program.contextDossier = { contextRevision: 1, contextFingerprint: `${label}-context-1` };
    }
    return task;
  });
  return { ...created, startedAt };
}

function seedCoordinator(fixture, executionId) {
  writeJson(path.join(taskDirectory(fixture.taskId), "coordinator.json"), {
    schemaVersion: 1,
    executionId,
    state: "running",
    pid: process.pid,
    config,
    campaignSupervisor: true,
    campaignStartedAt: fixture.startedAt,
    campaignSlices: 0,
    roundsStarted: 0,
    startedAt: fixture.startedAt,
  });
}

function summaryFor(taskId) {
  const task = readTask(taskId);
  return {
    taskId,
    state: task.state,
    progress: { required: 1, passing: 0 },
    program: { mode: "director-cfo" },
    latestRound: null,
    execution: { userActionRequired: false },
    workPlane: {
      recommendedWorkUnits: (task.program?.workPackages || [])
        .filter((row) => row.state === "ready")
        .map((row) => ({ workPackageId: row.workPackageId })),
    },
  };
}

async function crossingAndCapacityScenario() {
  const fixture = createDirectorFixture("continuation", 2);
  updateTask(fixture.taskId, (task) => {
    task.workGraph = [
      { id: "work-first", state: "running", dependsOn: [], priority: 100 },
      { id: "work-next", state: "pending", dependsOn: ["work-first"], priority: 90 },
    ];
    task.program.workPackages = [
      { workPackageId: "work-first", state: "running", jobId: "job-first", allocation: { allocationId: "allocation-first" } },
      { workPackageId: "work-next", state: "pending", jobId: null, allocation: { allocationId: "allocation-next" } },
    ];
    return task;
  });
  const executionId = "execution-campaign-slice-one";
  seedCoordinator(fixture, executionId);

  let sliceCalls = 0;
  let sleepCalls = 0;
  let dispatches = 0;
  let integrations = 0;
  let nextSafeActions = 0;
  let capacityReady = false;
  let inventoryCalls = 0;
  const waitingModes = [];
  const sliceExecutionIds = [];
  const sliceCampaignStarts = [];
  const capacityWait = {
    kind: "capacity-wait",
    reasons: ["minimum-free-ram-floor-would-be-crossed"],
    workPackageIds: ["work-next"],
    observedFreeRamMb: 300,
    observedFreeDiskMb: 10000,
    requiredFreeRamMb: 500,
    requiredFreeDiskMb: null,
    initialFingerprint: "fixture-low-capacity",
    backoffSeconds: 1,
    maxBackoffSeconds: 2,
    maximumChecks: 2,
  };
  const campaignSummary = () => summaryFor(fixture.taskId);
  const runSlice = async (payload) => {
    sliceCalls += 1;
    sliceExecutionIds.push(payload.executionId);
    sliceCampaignStarts.push(payload.campaignStartedAt);
    assert.equal(payload.config.maxRounds, 1);
    assert.equal(payload.config.maxMinutes, 1);
    assert.equal(payload.config.horizonHours, 1);
    if (sliceCalls === 1) {
      dispatches += 1;
      writeJson(path.join(taskDirectory(fixture.taskId), "coordinator.json"), {
        schemaVersion: 1,
        executionId: payload.executionId,
        state: "slice-stopped",
        pid: process.pid,
        stopReason: "worker-deadline",
        config,
        campaignSupervisor: true,
        campaignStartedAt: payload.campaignStartedAt,
        campaignSlices: 0,
      });
      return { taskId: fixture.taskId, executionId: payload.executionId, state: "slice-stopped", stopReason: "worker-deadline", roundsStarted: 1 };
    }
    if (sliceCalls === 2) {
      integrations += 1;
      const resumed = readTask(fixture.taskId);
      assert.equal(resumed.program.workPackages.find((row) => row.workPackageId === "work-first").state, "completed");
      assert.equal(resumed.program.activeCampaign.wakeHistory.at(-1).reason, "evidence-change");
      writeJson(path.join(taskDirectory(fixture.taskId), "coordinator.json"), {
        schemaVersion: 1,
        executionId: payload.executionId,
        state: "slice-stopped",
        pid: process.pid,
        stopReason: "capacity-wait",
        capacityWait,
        config,
        campaignSupervisor: true,
        campaignStartedAt: payload.campaignStartedAt,
        campaignSlices: 1,
      });
      return { taskId: fixture.taskId, executionId: payload.executionId, state: "slice-stopped", stopReason: "capacity-wait", capacityWait, roundsStarted: 0 };
    }
    nextSafeActions += 1;
    const resumed = readTask(fixture.taskId);
    assert.deepEqual(resumed.program.activeCampaign.wakeHistory.map((row) => row.reason), ["evidence-change", "quota-reset"]);
    writeJson(path.join(taskDirectory(fixture.taskId), "coordinator.json"), {
      schemaVersion: 1,
      executionId: payload.executionId,
      state: "stopped",
      pid: null,
      stopReason: "user-decision-required",
      config,
      campaignSupervisor: true,
      campaignStartedAt: payload.campaignStartedAt,
      campaignSlices: 2,
    });
    return { taskId: fixture.taskId, executionId: payload.executionId, state: "stopped", stopReason: "user-decision-required", roundsStarted: 0 };
  };
  const campaignSleep = async (_milliseconds, wake) => {
    sleepCalls += 1;
    waitingModes.push(wake.capacityWait === true ? "capacity" : "worker");
    const waitingTask = readTask(fixture.taskId);
    const waitingCoordinator = readCoordinator({ taskId: fixture.taskId });
    assert.equal(waitingTask.program.activeCampaign.state, "waiting");
    assert.equal(waitingTask.program.activeCampaign.nextWakeAt, wake.nextWakeAt);
    assert.equal(waitingCoordinator.state, "waiting");
    assert.equal(waitingCoordinator.pid, process.pid, "The live supervisor must own every persisted wait.");
    assert.equal(waitingCoordinator.nextWakeAt, wake.nextWakeAt);
    if (wake.capacityWait === true) {
      capacityReady = true;
      return;
    }
    updateTask(fixture.taskId, (task) => {
      task.program.workPackages = task.program.workPackages.map((row) => row.workPackageId === "work-first"
        ? { ...row, state: "completed", completedAt: new Date().toISOString() }
        : row.workPackageId === "work-next" ? { ...row, state: "ready" } : row);
      task.program.evidenceLedger.entries.push({
        requirementId: "REQ-CONTINUATION",
        level: "integration",
        ref: "fixture:first-worker-terminal",
        passed: true,
        accepted: true,
      });
      task.program.nextAction = "Integrate the terminal worker once, then evaluate the next ready package.";
      task.workGraph = task.workGraph.map((row) => row.id === "work-first"
        ? { ...row, state: "completed" }
        : row.id === "work-next" ? { ...row, state: "pending" } : row);
      return task;
    });
  };
  const inventory = async () => {
    inventoryCalls += 1;
    return {
      machine: { freeRamMb: capacityReady ? 800 : 300, freeDiskMb: 10000 },
      worktreeStorage: { freeMb: 10000, withinQuota: true, hasMinimumFree: true },
      providers: {},
    };
  };

  const result = await runCampaignSupervisor({
    taskId: fixture.taskId,
    executionId,
    config,
    createdAt: fixture.startedAt,
    campaignStartedAt: fixture.startedAt,
    campaignSupervisor: true,
  }, path.join(__dirname, "ai-mobile-local-mcp.js"), {
    runSlice,
    campaignSleep,
    campaignSummary,
    inventory,
  });

  const finalTask = readTask(fixture.taskId);
  const finalCoordinator = readCoordinator({ taskId: fixture.taskId });
  const events = readMaterialEvents({ taskId: fixture.taskId, maxEvents: 50 }).events;
  assert.equal(result.stopReason, "user-decision-required");
  assert.equal(result.campaignSlices, 3);
  assert.equal(sliceCalls, 3);
  assert.equal(sleepCalls, 2);
  assert.deepEqual(waitingModes, ["worker", "capacity"]);
  assert.ok(inventoryCalls >= 2);
  assert.equal(dispatches, 1, "The first slice dispatch must not be duplicated.");
  assert.equal(integrations, 1, "The terminal result must be integrated exactly once.");
  assert.equal(nextSafeActions, 1);
  assert.equal(new Set(sliceExecutionIds).size, 3);
  assert.deepEqual(sliceCampaignStarts, [fixture.startedAt, fixture.startedAt, fixture.startedAt], "Every chained slice must preserve the original supervisor horizon start.");
  assert.deepEqual(finalTask.program.activeCampaign.wakeHistory.map((row) => row.reason), ["evidence-change", "quota-reset"]);
  assert.equal(finalTask.program.activeCampaign.wakeHistory[0].acceptanceImproved, true);
  assert.equal(finalTask.program.activeCampaign.wakeHistory[1].acceptanceImproved, false);
  assert.equal(finalTask.program.activeCampaign.noProgressCount, 0);
  assert.equal(finalTask.program.activeCampaign.state, "stopped");
  assert.equal(finalTask.program.activeCampaign.nextWakeAt, null);
  assert.equal(finalCoordinator.campaignStartedAt, fixture.startedAt);
  assert.equal(finalCoordinator.nextWakeAt || null, null);
  assert.ok(events.filter((row) => row.type === "campaign.waiting").length >= 2);
  assert.ok(events.filter((row) => row.type === "campaign.woke").length >= 2);
  return {
    campaignSlices: result.campaignSlices,
    wakeReasons: finalTask.program.activeCampaign.wakeHistory.map((row) => row.reason),
    originalHorizonPreserved: new Set(sliceCampaignStarts).size === 1,
    duplicateDispatches: dispatches - 1,
    duplicateIntegrations: integrations - 1,
    nextSafeActions,
    terminalStop: result.stopReason,
  };
}

async function noProgressChurnScenario() {
  const fixture = createDirectorFixture("churn", 2, true);
  updateTask(fixture.taskId, (task) => {
    task.program.evidenceLedger.entries = [{
      requirementId: "REQ-CHURN",
      level: "integration",
      ref: "fixture:canonical-required-evidence",
      passed: true,
      accepted: true,
    }];
    task.requirements.push({
      id: "REQ-OPTIONAL-CHURN",
      description: "Optional evidence must not reset the supervisor.",
      required: false,
      status: "failing",
      minimumEvidenceLevel: "integration",
      evidence: [],
      blocker: null,
    });
    return task;
  });
  const executionId = "execution-campaign-churn-one";
  seedCoordinator(fixture, executionId);
  let sliceCalls = 0;
  let sleepCalls = 0;
  const sliceCampaignStarts = [];
  const runSlice = async (payload) => {
    sliceCalls += 1;
    sliceCampaignStarts.push(payload.campaignStartedAt);
    updateTask(fixture.taskId, (task) => {
      const revision = Number(task.program.contextDossier.contextRevision) + 1;
      task.program.contextDossier = { contextRevision: revision, contextFingerprint: `churn-context-${revision}` };
      task.program.workPackages = task.program.workPackages.map((row) => ({ ...row, state: row.state === "running" ? "ready" : "running" }));
      task.program.evidenceLedger.entries.push(
        {
          requirementId: "REQ-CHURN",
          level: "activity",
          ref: `fixture:activity-${sliceCalls}`,
          passed: true,
          accepted: false,
        },
        {
          requirementId: "REQ-CHURN",
          level: "integration",
          ref: "fixture:canonical-required-evidence",
          passed: true,
          accepted: true,
        },
        {
          requirementId: "REQ-OPTIONAL-CHURN",
          level: "integration",
          ref: `fixture:optional-${sliceCalls}`,
          passed: true,
          accepted: true,
        },
      );
      task.program.evidenceLedger.entries.reverse();
      return task;
    });
    writeJson(path.join(taskDirectory(fixture.taskId), "coordinator.json"), {
      schemaVersion: 1,
      executionId: payload.executionId,
      state: "slice-stopped",
      pid: process.pid,
      stopReason: "worker-deadline",
      config,
      campaignSupervisor: true,
      campaignStartedAt: payload.campaignStartedAt,
      campaignSlices: sliceCalls - 1,
    });
    return { taskId: fixture.taskId, executionId: payload.executionId, state: "slice-stopped", stopReason: "worker-deadline", roundsStarted: 1 };
  };

  const result = await runCampaignSupervisor({
    taskId: fixture.taskId,
    executionId,
    config,
    createdAt: fixture.startedAt,
    campaignStartedAt: fixture.startedAt,
    campaignSupervisor: true,
  }, path.join(__dirname, "ai-mobile-local-mcp.js"), {
    runSlice,
    campaignSleep: async () => { sleepCalls += 1; },
    campaignSummary: () => summaryFor(fixture.taskId),
  });

  const finalTask = readTask(fixture.taskId);
  const runtimeCampaign = finalTask.program.activeCampaign;
  const runtimeSupervisor = finalTask.program.runtime.programSupervisor;
  assert.equal(result.stopReason, "no-progress-limit");
  assert.equal(result.campaignSlices, 3, "Only the first monotonic context transition may be neutral; repeated revision churn must stop.");
  assert.equal(sliceCalls, 3);
  assert.equal(sleepCalls, 0);
  assert.equal(runtimeCampaign.state, "stopped");
  assert.equal(runtimeCampaign.stopReason, "no-acceptance-progress");
  assert.equal(runtimeSupervisor.state, "stopped");
  assert.equal(runtimeSupervisor.stopReason, "no-acceptance-progress");
  assert.equal(runtimeSupervisor.noProgressCount, 2);
  assert.equal(runtimeSupervisor.wakeHistory.length, 3);
  assert.ok(runtimeSupervisor.wakeHistory.every((row) => row.acceptanceImproved === false));
  assert.deepEqual(runtimeSupervisor.foundationTransitions, ["context"]);
  assert.equal(runtimeSupervisor.wakeCount, 3);
  assert.deepEqual(sliceCampaignStarts, [fixture.startedAt, fixture.startedAt, fixture.startedAt]);
  return {
    campaignSlices: result.campaignSlices,
    noProgressCount: runtimeSupervisor.noProgressCount,
    acceptedEvidenceResets: runtimeSupervisor.wakeHistory.filter((row) => row.acceptanceImproved).length,
    boundedFoundationTransitions: runtimeSupervisor.foundationTransitions,
  };
}

async function cancelBeforeNextSliceScenario() {
  const fixture = createDirectorFixture("cancel-race", 2);
  const executionId = "execution-campaign-cancel-one";
  seedCoordinator(fixture, executionId);
  let sliceCalls = 0;
  let summaryCalls = 0;
  const runSlice = async (payload) => {
    sliceCalls += 1;
    updateTask(fixture.taskId, (task) => {
      task.program.workPackages = task.program.workPackages.map((row) => ({ ...row, state: "ready" }));
      return task;
    });
    writeJson(path.join(taskDirectory(fixture.taskId), "coordinator.json"), {
      schemaVersion: 1,
      executionId: payload.executionId,
      state: "slice-stopped",
      pid: process.pid,
      stopReason: "worker-deadline",
      config,
      campaignSupervisor: true,
      campaignStartedAt: payload.campaignStartedAt,
      campaignSlices: 0,
    });
    return { taskId: fixture.taskId, executionId: payload.executionId, state: "slice-stopped", stopReason: "worker-deadline", roundsStarted: 1 };
  };
  const campaignSummary = () => {
    summaryCalls += 1;
    if (summaryCalls === 3) {
      const current = readCoordinator({ taskId: fixture.taskId });
      writeJson(path.join(taskDirectory(fixture.taskId), "coordinator.json"), {
        ...current,
        state: "cancel-requested",
        pid: process.pid,
      });
    }
    return summaryFor(fixture.taskId);
  };

  const result = await runCampaignSupervisor({
    taskId: fixture.taskId,
    executionId,
    config,
    createdAt: fixture.startedAt,
    campaignStartedAt: fixture.startedAt,
    campaignSupervisor: true,
  }, path.join(__dirname, "ai-mobile-local-mcp.js"), { runSlice, campaignSummary });

  const finalTask = readTask(fixture.taskId);
  const finalCoordinator = readCoordinator({ taskId: fixture.taskId });
  assert.equal(result.stopReason, "cancelled");
  assert.equal(sliceCalls, 1, "A cancellation observed before chaining must prevent the next slice.");
  assert.equal(finalTask.program.activeCampaign.state, "cancelled");
  assert.equal(finalCoordinator.state, "cancelled");
  assert.equal(finalCoordinator.pid, null);
  assert.equal(readMaterialEvents({ taskId: fixture.taskId, maxEvents: 50 }).events.filter((row) => row.type === "campaign.woke").length, 0);
  return { slicesBeforeCancel: sliceCalls, terminalStop: result.stopReason };
}

async function phaseAndEpochScenario() {
  const fixture = createDirectorFixture("phase-epoch", 2);
  const executionId = "execution-program-phase-one";
  updateTask(fixture.taskId, (task) => {
    task.program.phase = "context";
    task.program.activeCampaign = null;
    task.program.campaigns = [];
    task.program.contextDossier = null;
    task.program.masterPlan = null;
    task.program.resourceBudget = null;
    task.program.runtime = { budget: null };
    task.program.workPackages = [{ workPackageId: "context-package", state: "running", jobId: "job-context", allocation: null }];
    task.workGraph = [{ id: "context-package", state: "running", dependsOn: [], priority: 100 }];
    return task;
  });
  seedCoordinator(fixture, executionId);
  let sliceCalls = 0;
  const sliceCampaignStarts = [];
  const campaignOne = startCampaign(createCampaign({
    campaignId: "campaign-phase-one",
    missionId: "mission-phase-epoch",
    maxHours: 1,
    maxWorkers: 1,
    noProgressLimit: 2,
    allocationIds: ["allocation-execution-one"],
    evidence: [],
  }));
  const campaignTwo = startCampaign(createCampaign({
    campaignId: "campaign-phase-two",
    missionId: "mission-phase-epoch",
    epoch: 2,
    maxHours: 1,
    maxWorkers: 1,
    noProgressLimit: 2,
    allocationIds: ["allocation-recovery-two"],
    evidence: [],
  }));
  const runSlice = async (payload) => {
    sliceCalls += 1;
    sliceCampaignStarts.push(payload.campaignStartedAt);
    if (sliceCalls === 1) {
      updateTask(fixture.taskId, (task) => {
        task.program.phase = "strategy";
        task.program.contextDossier = { contextRevision: 1, contextFingerprint: "phase-context-1" };
        task.program.workPackages = [
          { workPackageId: "context-package", state: "completed", jobId: "job-context" },
          { workPackageId: "strategy-package", state: "ready", jobId: null },
        ];
        task.workGraph = [
          { id: "context-package", state: "completed", dependsOn: [], priority: 100 },
          { id: "strategy-package", state: "pending", dependsOn: ["context-package"], priority: 95 },
        ];
        return task;
      });
    } else if (sliceCalls === 2) {
      updateTask(fixture.taskId, (task) => {
        task.program.phase = "execution";
        task.program.masterPlan = { planRevision: 1, planFingerprint: "phase-plan-1" };
        task.program.resourceBudget = { revision: 1, inventoryFingerprint: "budget-inventory-1" };
        task.program.runtime = { ...task.program.runtime, budget: { budgetRevision: 1 } };
        task.program.activeCampaign = campaignOne;
        task.program.campaigns = [campaignOne];
        task.program.workPackages = [
          { workPackageId: "context-package", state: "completed", jobId: "job-context" },
          { workPackageId: "strategy-package", state: "completed", jobId: "job-strategy" },
          { workPackageId: "execution-one", state: "ready", jobId: null, allocation: { allocationId: "allocation-execution-one" } },
        ];
        task.workGraph = [
          { id: "context-package", state: "completed", dependsOn: [], priority: 100 },
          { id: "strategy-package", state: "completed", dependsOn: ["context-package"], priority: 95 },
          { id: "execution-one", state: "pending", dependsOn: ["strategy-package"], priority: 90 },
        ];
        return task;
      });
    } else if (sliceCalls === 3) {
      updateTask(fixture.taskId, (task) => {
        const completed = { ...task.program.activeCampaign, state: "completed", finishedAt: new Date().toISOString(), stopReason: "campaign-work-packages-completed" };
        task.program.activeCampaign = completed;
        task.program.campaigns = [completed];
        task.program.workPackages = [
          ...task.program.workPackages.map((row) => row.workPackageId === "execution-one" ? { ...row, state: "completed", jobId: "job-execution-one" } : row),
          { workPackageId: "evidence-recovery", state: "pending", jobId: null, allocation: null },
        ];
        task.program.evidenceLedger.entries.push({ requirementId: "REQ-PHASE-EPOCH", level: "integration", ref: "fixture:epoch-one-accepted", passed: true, accepted: true });
        task.workGraph = [
          ...task.workGraph.map((row) => row.id === "execution-one" ? { ...row, state: "completed" } : row),
          { id: "evidence-recovery", state: "pending", dependsOn: ["execution-one"], priority: 100 },
        ];
        return task;
      });
    } else if (sliceCalls === 4) {
      updateTask(fixture.taskId, (task) => {
        task.program.resourceBudget = { revision: 2, inventoryFingerprint: "budget-inventory-2" };
        task.program.runtime = { ...task.program.runtime, budget: { budgetRevision: 2 } };
        task.program.activeCampaign = campaignTwo;
        task.program.campaigns = [...task.program.campaigns, campaignTwo];
        task.program.workPackages = task.program.workPackages.map((row) => row.workPackageId === "evidence-recovery"
          ? { ...row, state: "ready", allocation: { allocationId: "allocation-recovery-two" } }
          : row);
        return task;
      });
    } else {
      writeJson(path.join(taskDirectory(fixture.taskId), "coordinator.json"), {
        schemaVersion: 1,
        executionId: payload.executionId,
        state: "stopped",
        pid: null,
        stopReason: "user-decision-required",
        config: payload.config,
        campaignSupervisor: true,
        campaignStartedAt: payload.campaignStartedAt,
      });
      return { taskId: fixture.taskId, executionId: payload.executionId, state: "stopped", stopReason: "user-decision-required", roundsStarted: 0 };
    }
    writeJson(path.join(taskDirectory(fixture.taskId), "coordinator.json"), {
      schemaVersion: 1,
      executionId: payload.executionId,
      state: "slice-stopped",
      pid: process.pid,
      stopReason: "round-limit",
      config: payload.config,
      campaignSupervisor: true,
      campaignStartedAt: payload.campaignStartedAt,
    });
    return { taskId: fixture.taskId, executionId: payload.executionId, state: "slice-stopped", stopReason: "round-limit", roundsStarted: 1 };
  };

  const result = await runCampaignSupervisor({
    taskId: fixture.taskId,
    executionId,
    config,
    createdAt: fixture.startedAt,
    campaignStartedAt: fixture.startedAt,
    campaignSupervisor: true,
  }, path.join(__dirname, "ai-mobile-local-mcp.js"), {
    runSlice,
    campaignSummary: () => summaryFor(fixture.taskId),
  });

  const finalTask = readTask(fixture.taskId);
  const supervisor = finalTask.program.runtime.programSupervisor;
  assert.equal(result.stopReason, "user-decision-required");
  assert.equal(sliceCalls, 5);
  assert.equal(new Set(sliceCampaignStarts).size, 1);
  assert.equal(supervisor.state, "stopped");
  assert.deepEqual(supervisor.campaignIds, ["campaign-phase-one", "campaign-phase-two"]);
  assert.ok(supervisor.foundationTransitions.includes("context"));
  assert.ok(supervisor.foundationTransitions.includes("plan"));
  assert.ok(supervisor.foundationTransitions.includes("budget"));
  assert.ok(supervisor.foundationTransitions.includes("phase:2"));
  assert.ok(supervisor.foundationTransitions.includes("phase:4"));
  assert.equal(finalTask.program.campaigns.length, 2);
  assert.equal(finalTask.program.campaigns[0].state, "completed");
  assert.equal(finalTask.program.activeCampaign.campaignId, "campaign-phase-two");
  assert.equal(finalTask.program.activeCampaign.state, "stopped");
  return {
    slices: sliceCalls,
    phasesCrossed: ["context", "strategy", "execution"],
    campaignEpochs: supervisor.campaignIds,
    originalHorizonPreserved: new Set(sliceCampaignStarts).size === 1,
  };
}

async function expiredEpochRolloverScenario() {
  const fixture = createDirectorFixture("expired-epoch", 2);
  const executionId = "execution-expired-epoch-one";
  const expiredStartedAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  const expired = startCampaign(createCampaign({
    campaignId: "campaign-expired-one",
    missionId: "mission-expired-epoch",
    maxHours: 1,
    maxWorkers: 1,
    noProgressLimit: 2,
    allocationIds: ["allocation-expired-one"],
    evidence: [],
    createdAt: expiredStartedAt,
  }), expiredStartedAt);
  updateTask(fixture.taskId, (task) => {
    task.program.activeCampaign = expired;
    task.program.campaigns = [expired];
    task.program.workPackages = [{
      workPackageId: "work-expired-epoch",
      state: "pending",
      jobId: null,
      allocation: { allocationId: "allocation-expired-one" },
    }];
    task.workGraph = [{ id: "work-expired-epoch", state: "pending", dependsOn: [], priority: 100 }];
    return task;
  });
  seedCoordinator(fixture, executionId);
  let sliceCalls = 0;
  const sliceStarts = [];
  const replacement = startCampaign(createCampaign({
    campaignId: "campaign-expired-two",
    missionId: "mission-expired-epoch",
    epoch: 2,
    maxHours: 1,
    maxWorkers: 1,
    noProgressLimit: 2,
    allocationIds: ["allocation-expired-two"],
    evidence: [],
  }));
  const result = await runCampaignSupervisor({
    taskId: fixture.taskId,
    executionId,
    config,
    createdAt: fixture.startedAt,
    campaignStartedAt: fixture.startedAt,
    campaignSupervisor: true,
  }, path.join(__dirname, "ai-mobile-local-mcp.js"), {
    runSlice: async (payload) => {
      sliceCalls += 1;
      sliceStarts.push(payload.campaignStartedAt);
      if (sliceCalls === 1) {
        const rolled = readTask(fixture.taskId);
        assert.equal(rolled.program.activeCampaign, null);
        assert.equal(rolled.program.campaigns[0].state, "stopped");
        assert.equal(rolled.program.campaigns[0].stopReason, "campaign-epoch-horizon");
        assert.equal(rolled.program.workPackages[0].allocation, null);
        updateTask(fixture.taskId, (task) => {
          task.program.activeCampaign = replacement;
          task.program.campaigns = [...task.program.campaigns, replacement];
          task.program.runtime = { ...task.program.runtime, budget: { budgetRevision: 2 } };
          task.program.resourceBudget = { revision: 2, inventoryFingerprint: "expired-replacement-budget" };
          task.program.workPackages = task.program.workPackages.map((row) => ({
            ...row,
            state: "ready",
            allocation: { allocationId: "allocation-expired-two" },
          }));
          return task;
        });
        writeJson(path.join(taskDirectory(fixture.taskId), "coordinator.json"), {
          schemaVersion: 1,
          executionId: payload.executionId,
          state: "slice-stopped",
          pid: process.pid,
          stopReason: "round-limit",
          config: payload.config,
          campaignSupervisor: true,
          campaignStartedAt: payload.campaignStartedAt,
        });
        return { taskId: fixture.taskId, executionId: payload.executionId, state: "slice-stopped", stopReason: "round-limit", roundsStarted: 1 };
      }
      writeJson(path.join(taskDirectory(fixture.taskId), "coordinator.json"), {
        schemaVersion: 1,
        executionId: payload.executionId,
        state: "stopped",
        pid: null,
        stopReason: "user-decision-required",
        config: payload.config,
        campaignSupervisor: true,
        campaignStartedAt: payload.campaignStartedAt,
      });
      return { taskId: fixture.taskId, executionId: payload.executionId, state: "stopped", stopReason: "user-decision-required", roundsStarted: 0 };
    },
    campaignSummary: () => summaryFor(fixture.taskId),
  });
  const finalTask = readTask(fixture.taskId);
  const supervisor = finalTask.program.runtime.programSupervisor;
  assert.equal(result.stopReason, "user-decision-required");
  assert.equal(sliceCalls, 2);
  assert.deepEqual(supervisor.campaignIds, ["campaign-expired-one", "campaign-expired-two"]);
  assert.equal(finalTask.program.campaigns[0].stopReason, "campaign-epoch-horizon");
  assert.equal(finalTask.program.activeCampaign.campaignId, "campaign-expired-two");
  assert.equal(new Set(sliceStarts).size, 1);
  return { campaignEpochs: supervisor.campaignIds, slices: sliceCalls, originalHorizonPreserved: new Set(sliceStarts).size === 1 };
}
async function resumeOriginalHorizonScenario() {
  const fixture = createDirectorFixture("resume-horizon", 2);
  const executionId = "execution-program-resume";
  const originalStartedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const originalDeadlineAt = new Date(Date.parse(originalStartedAt) + 48 * 60 * 60 * 1000).toISOString();
  updateTask(fixture.taskId, (task) => {
    task.program.phase = "strategy";
    task.program.activeCampaign = null;
    task.program.campaigns = [];
    task.program.runtime = {
      ...task.program.runtime,
      programSupervisor: {
        schemaVersion: 1,
        supervisorId: "program-supervisor-resume-fixture",
        missionId: task.program.mission.missionId,
        state: "waiting",
        startedAt: originalStartedAt,
        deadlineAt: originalDeadlineAt,
        horizonHours: 48,
        limits: { noProgressLimit: 2, maxEvents: 960 },
        cadence: { backoffMs: 1000, maxBackoffMs: 2000 },
        noProgressCount: 1,
        wakeCount: 7,
        wakeCursor: "resume-cursor",
        wakeHistory: [],
        lastAcceptanceFingerprint: evidenceFingerprint([]),
        foundationTransitions: ["context", "phase:2"],
        campaignIds: [],
        nextWakeAt: new Date(Date.now() + 1000).toISOString(),
        recovery: null,
        stopReason: "",
        finishedAt: null,
        updatedAt: new Date().toISOString(),
      },
    };
    return task;
  });
  seedCoordinator(fixture, executionId);
  const restartedAt = new Date().toISOString();
  let observedPayload = null;
  const result = await runCampaignSupervisor({
    taskId: fixture.taskId,
    executionId,
    config: { ...config, horizonHours: 48 },
    createdAt: restartedAt,
    campaignStartedAt: restartedAt,
    campaignSupervisor: true,
  }, path.join(__dirname, "ai-mobile-local-mcp.js"), {
    runSlice: async (payload) => {
      observedPayload = payload;
      writeJson(path.join(taskDirectory(fixture.taskId), "coordinator.json"), {
        schemaVersion: 1,
        executionId: payload.executionId,
        state: "stopped",
        pid: null,
        stopReason: "user-decision-required",
        config: payload.config,
        campaignSupervisor: true,
        campaignStartedAt: payload.campaignStartedAt,
      });
      return { taskId: fixture.taskId, executionId: payload.executionId, state: "stopped", stopReason: "user-decision-required", roundsStarted: 0 };
    },
    campaignSummary: () => summaryFor(fixture.taskId),
  });
  const finalSupervisor = readTask(fixture.taskId).program.runtime.programSupervisor;
  assert.equal(result.stopReason, "user-decision-required");
  assert.equal(observedPayload.campaignStartedAt, originalStartedAt);
  assert.equal(observedPayload.config.horizonHours, 48);
  assert.equal(finalSupervisor.startedAt, originalStartedAt);
  assert.equal(finalSupervisor.deadlineAt, originalDeadlineAt);
  assert.equal(finalSupervisor.wakeCount, 7);
  assert.equal(finalSupervisor.noProgressCount, 1);
  return {
    resumedStartedAt: finalSupervisor.startedAt,
    preservedDeadlineAt: finalSupervisor.deadlineAt,
    horizonHours: observedPayload.config.horizonHours,
    priorWakeCount: finalSupervisor.wakeCount,
  };
}
function writeResourceJob(taskId, jobId, input = {}) {
  const directory = jobDirectory(taskId, jobId);
  fs.mkdirSync(directory, { recursive: true });
  const createdAt = input.createdAt || new Date(Date.now() - 2000).toISOString();
  const finishedAt = input.finishedAt || new Date(Date.now() - 1000).toISOString();
  writeJson(path.join(directory, "contract.json"), {
    taskId,
    jobId,
    provider: input.provider || "codex",
    model: input.model || "gpt-5.3-codex-spark",
    createdAt,
    directorProgram: {
      programId: input.programId || "",
      workPackageId: input.workPackageId || "work-resource-cap",
      phase: input.phase || "execution",
    },
    allocation: {
      allocationId: input.allocationId || "allocation-resource-cap",
      workPackageId: input.workPackageId || "work-resource-cap",
      candidateId: input.candidateId || "candidate-resource-cap",
      provider: input.provider || "codex",
      model: input.model || "gpt-5.3-codex-spark",
      tokenLimit: Number(input.tokenLimit || 20000),
      durationLimitMs: Number(input.durationLimitMs || 60000),
      maxAttempts: Number(input.maxAttempts || 1),
    },
  });
  writeJson(path.join(directory, "status.json"), {
    state: input.state || "completed",
    startedAt: createdAt,
    finishedAt,
  });
  writeJson(path.join(directory, "usage.json"), {
    provider: input.provider || "codex",
    totalTokens: Number(input.totalTokens || 100),
    durationMs: Number(input.durationMs || 1000),
    resourceAccountingComplete: true,
  });
  fs.writeFileSync(path.join(directory, "worker.diff"), "", "utf8");
}

function acceptedBudgetRecords(label, maxTokens, revision = 1, planRevision = revision) {
  const plan = {
    state: "approved",
    approval: "director-cfo plan assurance passed",
    planId: `plan-${label}`,
    revision: planRevision,
    planFingerprint: `plan-fingerprint-${label}-${planRevision}`,
  };
  const budget = {
    state: "active",
    budgetId: `budget-${label}-${revision}`,
    revision,
    planId: plan.planId,
    planRevision,
    inventoryFingerprint: `inventory-fingerprint-${label}-${revision}`,
    forecastFingerprint: `forecast-fingerprint-${label}-${revision}`,
    fingerprint: `budget-fingerprint-${label}-${revision}`,
    limits: {
      maxTokens,
      maxDurationMs: 180000,
      maxAttempts: 3,
      maxConcurrentWorkers: 1,
    },
    reserves: { reconciliationTokens: 1000, emergencyTokens: 1000 },
  };
  return { plan, budget };
}

function bootstrapBudgetRecord(label, input = {}) {
  const revision = Number(input.revision || 1);
  return {
    state: "draft",
    budgetId: `budget-bootstrap-${label}-${revision}`,
    budgetRevision: revision,
    revision,
    missionId: `mission-${label}`,
    planId: `bootstrap-program-${label}`,
    planRevision: 1,
    inventoryFingerprint: `bootstrap-inventory-${label}-${revision}`,
    forecastFingerprint: `bootstrap-forecast-${label}-${revision}`,
    limits: {
      maxTokens: Number(input.maxTokens ?? 96000),
      maxDurationMs: Number(input.maxDurationMs ?? 180000),
      maxAttempts: Number(input.maxAttempts ?? 3),
      maxConcurrentWorkers: Number(input.maxConcurrentWorkers ?? 1),
    },
    reserves: { contextTokens: 12000, strategyTokens: 30000, reconciliationTokens: 16000 },
    allocations: input.allocations || [],
  };
}

function persistBootstrapBudget(task, budget) {
  task.program.resourceBudget = JSON.parse(JSON.stringify(budget));
  task.program.runtime = { ...task.program.runtime, budget: JSON.parse(JSON.stringify(budget)) };
  return task;
}
async function hardProgramResourceCapScenario() {
  const fixture = createDirectorFixture("resource-cap", 2);
  const executionId = "execution-resource-cap";
  seedCoordinator(fixture, executionId);
  writeResourceJob(fixture.taskId, "job-resource-cap-0001", {
    workPackageId: "work-resource-cap",
    allocationId: "allocation-resource-cap",
    tokenLimit: 20000,
  });
  let sliceCalls = 0;
  const result = await runCampaignSupervisor({
    taskId: fixture.taskId,
    executionId,
    config: { ...config, programMaxTokens: 10000 },
    campaignStartedAt: fixture.startedAt,
    campaignSupervisor: true,
  }, path.join(__dirname, "ai-mobile-local-mcp.js"), {
    campaignSummary: ({ taskId }) => summaryFor(taskId),
    runSlice: async () => {
      sliceCalls += 1;
      return { stopReason: "worker-deadline" };
    },
  });
  const supervisor = readTask(fixture.taskId).program.runtime.programSupervisor;
  assert.equal(result.stopReason, "resource-cap-exceeded");
  assert.equal(sliceCalls, 0, "Preexisting exposure above an explicit user cap must stop before any coordinator slice.");
  assert.ok(supervisor.resourceSnapshot.capCheck.blockers.some((row) => row.code === "program-token-cap-exceeded"));
  assert.equal(supervisor.resourceSnapshot.authorization.totals.tokens, 20000);
  assert.equal(supervisor.hardCeilings.maxTokens, 10000, "The explicit user ceiling must be durable across supervisor resumes and accepted-budget revisions.");
  return {
    slices: sliceCalls,
    blocker: result.blocker,
    authorizedTokens: supervisor.resourceSnapshot.authorization.totals.tokens,
    maxTokens: supervisor.limits.maxTokens,
  };
}

async function resumeExplicitCapTighteningScenario() {
  const fixture = createDirectorFixture("resume-cap-tightening", 2);
  const executionId = "execution-resume-cap-tightening";
  writeResourceJob(fixture.taskId, "job-resume-cap-tightening", {
    workPackageId: "work-resume-cap-tightening",
    allocationId: "allocation-resume-cap-tightening",
    tokenLimit: 20000,
  });
  const startedAt = new Date().toISOString();
  updateTask(fixture.taskId, (task) => {
    task.program.runtime = {
      ...task.program.runtime,
      programSupervisor: {
        schemaVersion: 2,
        supervisorId: "program-supervisor-resume-cap-tightening",
        missionId: task.program.mission.missionId,
        state: "active",
        startedAt,
        deadlineAt: new Date(Date.parse(startedAt) + 60 * 60 * 1000).toISOString(),
        horizonHours: 1,
        limits: {
          noProgressLimit: 2,
          maxEvents: 50,
          maxTokens: 100000,
          maxDurationMs: 1800000,
          maxAttempts: 4,
          maxArtifacts: 250,
          maxArtifactBytes: 100 * 1024 * 1024,
          maxWorkers: 2,
          maxCampaigns: 50,
        },
        hardCeilings: {},
        limitRevision: 1,
        limitSource: { kind: "bootstrap", fingerprint: "bootstrap-resume-cap-tightening", revision: 0 },
        limitHistory: [],
        cadence: { backoffMs: 1000, maxBackoffMs: 2000 },
        noProgressCount: 0,
        wakeCount: 0,
        wakeCursor: "",
        wakeHistory: [],
        lastAcceptanceFingerprint: evidenceFingerprint([]),
        foundationTransitions: [],
        campaignIds: [task.program.activeCampaign.campaignId],
        campaignCount: 1,
        lastCampaignId: task.program.activeCampaign.campaignId,
        allocationIds: [],
        resourceSnapshot: null,
        nextWakeAt: null,
        recovery: null,
        stopReason: "",
        finishedAt: null,
        updatedAt: startedAt,
      },
    };
    return task;
  });
  seedCoordinator(fixture, executionId);
  let sliceCalls = 0;
  const result = await runCampaignSupervisor({
    taskId: fixture.taskId,
    executionId,
    config: { ...config, programMaxTokens: 10000 },
    campaignStartedAt: fixture.startedAt,
    campaignSupervisor: true,
  }, path.join(__dirname, "ai-mobile-local-mcp.js"), {
    campaignSummary: ({ taskId }) => summaryFor(taskId),
    runSlice: async () => {
      sliceCalls += 1;
      return { stopReason: "user-decision-required" };
    },
  });
  let supervisor = readTask(fixture.taskId).program.runtime.programSupervisor;
  assert.equal(result.stopReason, "resource-cap-exceeded");
  assert.equal(sliceCalls, 0, "A stricter explicit cap on resume must apply before another slice.");
  assert.equal(supervisor.limits.maxTokens, 10000);
  assert.equal(supervisor.hardCeilings.maxTokens, 10000);
  assert.equal(result.blocker, "program-token-cap-exceeded");

  const replay = await runCampaignSupervisor({
    taskId: fixture.taskId,
    executionId: "execution-resume-cap-looser-replay",
    config: { ...config, programMaxTokens: 200000 },
    campaignStartedAt: fixture.startedAt,
    campaignSupervisor: true,
  }, path.join(__dirname, "ai-mobile-local-mcp.js"), {
    campaignSummary: ({ taskId }) => summaryFor(taskId),
    runSlice: async () => {
      sliceCalls += 1;
      return { stopReason: "user-decision-required" };
    },
  });
  supervisor = readTask(fixture.taskId).program.runtime.programSupervisor;
  assert.equal(replay.stopReason, "resource-cap-exceeded");
  assert.equal(sliceCalls, 0);
  assert.equal(supervisor.limits.maxTokens, 10000, "A later looser explicit cap must not expand a durable hard ceiling.");
  assert.equal(supervisor.hardCeilings.maxTokens, 10000);
  return {
    blocker: result.blocker,
    maxTokens: supervisor.limits.maxTokens,
    slices: sliceCalls,
    looserReplayExpanded: false,
  };
}

async function exactCapExhaustionScenario() {
  const fixture = createDirectorFixture("exact-cap-exhaustion", 2);
  const executionId = "execution-exact-cap-exhaustion";
  updateTask(fixture.taskId, (task) => {
    task.program.workPackages = task.program.workPackages.map((row) => ({ ...row, state: "pending", jobId: null }));
    return task;
  });
  writeResourceJob(fixture.taskId, "job-exact-cap-exhaustion", {
    workPackageId: "work-exact-cap-consumed",
    allocationId: "allocation-exact-cap-consumed",
    tokenLimit: 20000,
    maxAttempts: 1,
    state: "completed",
  });
  seedCoordinator(fixture, executionId);
  const beforeJobs = listJobIds(fixture.taskId).length;
  const beforeCampaigns = readTask(fixture.taskId).program.campaigns.length;
  let sliceCalls = 0;
  const result = await runCampaignSupervisor({
    taskId: fixture.taskId,
    executionId,
    config: { ...config, programMaxTokens: 20000 },
    campaignStartedAt: fixture.startedAt,
    campaignSupervisor: true,
  }, path.join(__dirname, "ai-mobile-local-mcp.js"), {
    campaignSummary: ({ taskId }) => summaryFor(taskId),
    runSlice: async () => {
      sliceCalls += 1;
      return { stopReason: "user-decision-required" };
    },
  });
  const task = readTask(fixture.taskId);
  const supervisor = task.program.runtime.programSupervisor;
  assert.equal(result.stopReason, "resource-cap-exceeded");
  assert.equal(result.blocker, "program-token-cap-exhausted");
  assert.equal(sliceCalls, 0, "Exact cap exhaustion with only pending work must not enter a coordinator slice.");
  assert.equal(listJobIds(fixture.taskId).length, beforeJobs, "Exact exhaustion must create no new job or attempt.");
  assert.equal(task.program.campaigns.length, beforeCampaigns, "Exact exhaustion must create no new campaign.");
  assert.ok(supervisor.resourceSnapshot.capCheck.exhausted.some((row) => row.code === "program-token-cap-exhausted"));
  return {
    blocker: result.blocker,
    slices: sliceCalls,
    newJobs: listJobIds(fixture.taskId).length - beforeJobs,
    newCampaigns: task.program.campaigns.length - beforeCampaigns,
  };
}
async function staleRunningPackageUsesLiveLeaseScenario() {
  const fixture = createDirectorFixture("stale-running", 2);
  const executionId = "execution-stale-running";
  updateTask(fixture.taskId, (task) => {
    const { plan, budget } = acceptedBudgetRecords("stale-running", 12000);
    task.program.masterPlan = plan;
    task.program.resourceBudget = budget;
    task.program.contracts = { ...(task.program.contracts || {}), masterPlan: plan, resourceBudget: budget };
    return task;
  });
  seedCoordinator(fixture, executionId);
  let sliceCalls = 0;
  const result = await runCampaignSupervisor({
    taskId: fixture.taskId,
    executionId,
    config: { ...config, programMaxTokens: 50000, programMaxWorkers: 5 },
    campaignStartedAt: fixture.startedAt,
    campaignSupervisor: true,
  }, path.join(__dirname, "ai-mobile-local-mcp.js"), {
    campaignSummary: ({ taskId }) => summaryFor(taskId),
    runSlice: async () => {
      sliceCalls += 1;
      return { stopReason: "user-decision-required", blocker: "fixture-decision" };
    },
  });
  const supervisor = readTask(fixture.taskId).program.runtime.programSupervisor;
  assert.equal(result.stopReason, "user-decision-required");
  assert.equal(sliceCalls, 1, "A stale running package without a live lease must not trip concurrency.");
  assert.equal(supervisor.resourceSnapshot.concurrency.programActive, 0);
  assert.equal(supervisor.limits.maxWorkers, 1, "The accepted budget concurrency ceiling must override a looser requested cap.");
  assert.equal(supervisor.limits.maxTokens, 12000, "The accepted whole-plan budget must be the immutable tighter token ceiling.");
  return {
    slices: sliceCalls,
    liveWorkers: supervisor.resourceSnapshot.concurrency.programActive,
    maxWorkers: supervisor.limits.maxWorkers,
    maxTokens: supervisor.limits.maxTokens,
  };
}

async function bootstrapToAcceptedBudgetScenario() {
  const fixture = createDirectorFixture("budget-revision", 2);
  const executionId = "execution-budget-revision";
  updateTask(fixture.taskId, (task) => persistBootstrapBudget(task, bootstrapBudgetRecord("budget-revision")));
  seedCoordinator(fixture, executionId);
  let sliceCalls = 0;
  const result = await runCampaignSupervisor({
    taskId: fixture.taskId,
    executionId,
    config,
    campaignStartedAt: fixture.startedAt,
    campaignSupervisor: true,
  }, path.join(__dirname, "ai-mobile-local-mcp.js"), {
    campaignSummary: ({ taskId }) => summaryFor(taskId),
    runSlice: async () => {
      sliceCalls += 1;
      if (sliceCalls === 1) {
        writeResourceJob(fixture.taskId, "job-bootstrap-spend-0001", {
          workPackageId: "work-bootstrap-spend",
          allocationId: "allocation-bootstrap-spend",
          tokenLimit: 20000,
          durationLimitMs: 60000,
        });
        updateTask(fixture.taskId, (task) => {
          const { plan, budget } = acceptedBudgetRecords("budget-revision", 250000);
          budget.allocations = [{ allocationId: "allocation-plan-funded", workPackageId: "work-plan-funded" }];
          task.program.masterPlan = plan;
          task.program.resourceBudget = budget;
          task.program.contracts = { ...(task.program.contracts || {}), masterPlan: plan, resourceBudget: budget };
          task.program.workPackages = task.program.workPackages.map((row) => ({ ...row, state: "ready" }));
          return task;
        });
        writeResourceJob(fixture.taskId, "job-plan-funded-0002", {
          workPackageId: "work-plan-funded",
          allocationId: "allocation-plan-funded",
          tokenLimit: 30000,
          durationLimitMs: 60000,
        });
        return { stopReason: "worker-deadline" };
      }
      return { stopReason: "user-decision-required", blocker: "fixture-decision" };
    },
  });
  const supervisor = readTask(fixture.taskId).program.runtime.programSupervisor;
  assert.equal(result.stopReason, "user-decision-required");
  assert.equal(sliceCalls, 2);
  assert.equal(supervisor.limitRevision, 2);
  assert.equal(supervisor.limitHistory.length, 1, "The accepted plan budget must create exactly one durable cap revision.");
  assert.equal(supervisor.limitHistory[0].priorLimits.maxTokens, 96000);
  assert.equal(supervisor.limitHistory[0].newLimits.maxTokens, 270000, "Historical bootstrap exposure is additive while the already-funded allocation is deduplicated.");
  assert.equal(supervisor.limitHistory[0].baseline.historicalExposure.tokens, 20000);
  assert.equal(supervisor.limitHistory[0].baseline.fundedExposure.tokens, 30000);
  assert.equal(supervisor.limitHistory[0].baseline.acceptedRemainingBudget.tokens, 250000);
  assert.equal(supervisor.limitHistory[0].reason, "accepted-plan-resource-budget-revision");
  assert.equal(supervisor.limitSource.budgetId, "budget-budget-revision-1");
  return {
    slices: sliceCalls,
    limitRevision: supervisor.limitRevision,
    priorMaxTokens: supervisor.limitHistory[0].priorLimits.maxTokens,
    revisedMaxTokens: supervisor.limits.maxTokens,
    sourceBudgetId: supervisor.limitSource.budgetId,
  };
}

async function acceptedPlanToRecoveryBudgetScenario() {
  const label = "accepted-recovery-budget";
  const fixture = createDirectorFixture(label, 2);
  const historicalAllocationId = "allocation-accepted-recovery-history";
  const acceptedAllocationId = "allocation-accepted-recovery-current";
  const recoveryAllocationId = "allocation-accepted-recovery-strategy";
  const { plan, budget } = acceptedBudgetRecords(label, 1000, 31, 2);
  budget.limits.maxAttempts = 1;
  budget.limits.maxDurationMs = 10000;
  budget.allocations = [{
    allocationId: acceptedAllocationId,
    workPackageId: "work-accepted-recovery-current",
  }];
  updateTask(fixture.taskId, (task) => {
    task.program.phase = "execution";
    task.program.masterPlan = plan;
    task.program.contracts = { ...(task.program.contracts || {}), masterPlan: plan, resourceBudget: budget };
    task.program.resourceBudget = budget;
    task.program.runtime = { ...(task.program.runtime || {}), budget };
    task.program.workPackages = [{
      workPackageId: "work-accepted-recovery-history",
      executorKind: "implementation",
      state: "completed",
      readOnly: false,
      jobId: "job-accepted-recovery-history",
      allocation: {
        allocationId: historicalAllocationId,
        provider: "codex",
        model: "gpt-5.3-codex-spark",
        tokenLimit: 100,
        durationLimitMs: 1000,
        maxAttempts: 1,
      },
    }, {
      workPackageId: "work-accepted-recovery-current",
      executorKind: "implementation",
      state: "pending",
      readOnly: false,
      jobId: null,
      allocation: {
        allocationId: acceptedAllocationId,
        provider: "codex",
        model: "gpt-5.3-codex-spark",
        tokenLimit: 100,
        durationLimitMs: 1000,
        maxAttempts: 1,
      },
    }];
    return task;
  });
  writeResourceJob(fixture.taskId, "job-accepted-recovery-history", {
    workPackageId: "work-accepted-recovery-history",
    allocationId: historicalAllocationId,
    tokenLimit: 100,
    durationLimitMs: 1000,
    maxAttempts: 1,
    state: "completed",
  });
  const initialSupervisor = coordinatorTest.ensureProgramSupervisor(fixture.taskId, { config });
  assert.equal(initialSupervisor.limitSource.kind, "accepted-resource-budget");
  assert.equal(initialSupervisor.limitSource.revision, 31);
  assert.equal(initialSupervisor.limits.maxAttempts, 2, "Historical exposure plus the accepted one-attempt budget defines the cumulative ceiling.");

  writeResourceJob(fixture.taskId, "job-accepted-recovery-current", {
    workPackageId: "work-accepted-recovery-current",
    allocationId: acceptedAllocationId,
    tokenLimit: 100,
    durationLimitMs: 1000,
    maxAttempts: 1,
    state: "completed",
  });
  updateTask(fixture.taskId, (task) => {
    task.program.workPackages = task.program.workPackages.map((row) => (
      row.workPackageId === "work-accepted-recovery-current"
        ? { ...row, state: "completed", jobId: "job-accepted-recovery-current" }
        : row
    ));
    return task;
  });
  seedCoordinator(fixture, "execution-accepted-recovery-exhausted");
  let exhaustedSlices = 0;
  const exhausted = await runCampaignSupervisor({
    taskId: fixture.taskId,
    executionId: "execution-accepted-recovery-exhausted",
    config,
    campaignStartedAt: fixture.startedAt,
    campaignSupervisor: true,
  }, path.join(__dirname, "ai-mobile-local-mcp.js"), {
    campaignSummary: ({ taskId }) => summaryFor(taskId),
    runSlice: async () => {
      exhaustedSlices += 1;
      return { stopReason: "user-decision-required" };
    },
  });
  assert.equal(exhausted.stopReason, "resource-cap-exceeded");
  assert.equal(exhaustedSlices, 0, "Exact accepted-cap equality stops before a distinct recovery budget exists.");

  const recoveryAllocation = {
    allocationId: recoveryAllocationId,
    workPackageId: "strategy-accepted-recovery",
    provider: "antigravity",
    model: "gemini-3.1-pro-high",
    tokenLimit: 100,
    durationLimitMs: 1000,
    maxAttempts: 1,
    permissions: ["read-project", "read-files"],
  };
  const recoveryBudget = bootstrapBudgetRecord(label, {
    revision: 34,
    maxTokens: 100,
    maxDurationMs: 1000,
    maxAttempts: 1,
    allocations: [recoveryAllocation],
  });
  updateTask(fixture.taskId, (task) => {
    task.program.phase = "strategy";
    task.program.masterPlan = null;
    task.program.contracts = { ...(task.program.contracts || {}), masterPlan: plan, resourceBudget: null };
    persistBootstrapBudget(task, recoveryBudget);
    task.program.workPackages = [...task.program.workPackages, {
      workPackageId: "strategy-accepted-recovery",
      executorKind: "strategist",
      deliverableKind: "master-plan",
      state: "ready",
      readOnly: true,
      jobId: null,
      budgetRevision: 34,
      requiredPermissions: ["read-project", "read-files"],
      permissionGrant: ["read-project", "read-files"],
      allocation: recoveryAllocation,
    }];
    return task;
  });
  seedCoordinator(fixture, "execution-accepted-recovery-revised");
  let recoverySlices = 0;
  const recovered = await runCampaignSupervisor({
    taskId: fixture.taskId,
    executionId: "execution-accepted-recovery-revised",
    config,
    campaignStartedAt: fixture.startedAt,
    campaignSupervisor: true,
  }, path.join(__dirname, "ai-mobile-local-mcp.js"), {
    campaignSummary: ({ taskId }) => summaryFor(taskId),
    runSlice: async (payload) => {
      recoverySlices += 1;
      const current = readTask(fixture.taskId).program.runtime.programSupervisor;
      assert.equal(current.limitSource.kind, "recovery-resource-budget");
      assert.equal(current.limitSource.revision, 34);
      assert.equal(current.limits.maxAttempts, 3);
      assert.equal(payload.programResourceEnvelope, null, "The revision-fenced recovery budget restores positive authority before dispatch.");
      return { stopReason: "user-decision-required", blocker: "recovery-authority-observed" };
    },
  });
  const recoveredSupervisor = readTask(fixture.taskId).program.runtime.programSupervisor;
  const revision = recoveredSupervisor.limitHistory.at(-1);
  assert.equal(recovered.stopReason, "user-decision-required");
  assert.equal(recoverySlices, 1);
  assert.equal(revision.reason, "recovery-resource-budget-revision");
  assert.equal(revision.baseline.historicalExposure.attempts, 2);
  assert.equal(revision.baseline.fundedExposure.attempts, 0);
  assert.equal(revision.baseline.acceptedRemainingBudget.attempts, 1);
  assert.equal(revision.newLimits.maxAttempts, 3);
  return {
    priorSourceRevision: 31,
    recoverySourceRevision: recoveredSupervisor.limitSource.revision,
    priorCeiling: 2,
    revisedCeiling: recoveredSupervisor.limits.maxAttempts,
    slices: recoverySlices,
  };
}

async function conservativeNoBudgetHorizonScenario() {
  const fixture = createDirectorFixture("no-budget-168h", 2);
  const executionId = "execution-no-budget-168h";
  seedCoordinator(fixture, executionId);
  let sliceCalls = 0;
  let initialSupervisor = null;
  const result = await runCampaignSupervisor({
    taskId: fixture.taskId,
    executionId,
    config: { ...config, horizonHours: 168 },
    campaignStartedAt: fixture.startedAt,
    campaignSupervisor: true,
  }, path.join(__dirname, "ai-mobile-local-mcp.js"), {
    campaignSummary: ({ taskId }) => summaryFor(taskId),
    runSlice: async () => {
      sliceCalls += 1;
      if (sliceCalls === 1) {
        initialSupervisor = JSON.parse(JSON.stringify(readTask(fixture.taskId).program.runtime.programSupervisor));
        updateTask(fixture.taskId, (task) => persistBootstrapBudget(task, bootstrapBudgetRecord("no-budget-168h")));
        return { stopReason: "worker-deadline" };
      }
      return { stopReason: "user-decision-required", blocker: "fixture-decision" };
    },
  });
  const supervisor = readTask(fixture.taskId).program.runtime.programSupervisor;
  assert.equal(result.stopReason, "user-decision-required");
  assert.equal(sliceCalls, 2);
  assert.equal(initialSupervisor.horizonHours, 168);
  assert.equal(initialSupervisor.limitSource.kind, "bootstrap");
  assert.equal(initialSupervisor.limits.maxTokens, 50000, "A multi-day horizon must not create token authority.");
  assert.equal(initialSupervisor.limits.maxDurationMs, 1800000, "A multi-day horizon must not create execution-duration authority.");
  assert.equal(initialSupervisor.limits.maxAttempts, 4, "Attempt authority must not be derived from horizon event count.");
  assert.equal(initialSupervisor.limits.maxEvents, 50);
  assert.equal(initialSupervisor.limits.maxArtifactBytes, 100 * 1024 * 1024);
  assert.equal(supervisor.limitSource.kind, "bootstrap-resource-budget", "A persisted provisional CFO budget must replace fixed bootstrap defaults.");
  assert.equal(supervisor.limits.maxTokens, 96000);
  assert.equal(supervisor.limitRevision, 2);
  assert.equal(supervisor.limitHistory.length, 1);
  assert.equal(supervisor.limitHistory[0].reason, "bootstrap-resource-budget-revision");
  assert.equal(supervisor.limitHistory[0].priorLimits.maxTokens, 50000);
  return {
    horizonHours: initialSupervisor.horizonHours,
    initialMaxTokens: initialSupervisor.limits.maxTokens,
    initialMaxDurationMs: initialSupervisor.limits.maxDurationMs,
    initialMaxAttempts: initialSupervisor.limits.maxAttempts,
    revisedSource: supervisor.limitSource.kind,
    revisedMaxTokens: supervisor.limits.maxTokens,
  };
}
async function provisionalBootstrapBudgetScenario() {
  const fixture = createDirectorFixture("provisional-budget", 2);
  const executionId = "execution-provisional-budget";
  const fundedAllocation = {
    allocationId: "allocation-provisional-funded",
    workPackageId: "work-provisional-funded",
    provider: "codex",
    model: "gpt-5.3-codex-spark",
    tokenLimit: 30000,
    durationLimitMs: 2040000,
    maxAttempts: 1,
  };
  const provisionalBudget = bootstrapBudgetRecord("provisional-budget", {
    maxTokens: 96000,
    maxDurationMs: 0,
    maxAttempts: 2,
    allocations: [fundedAllocation],
  });
  provisionalBudget.limits.maxConcurrent = 2;
  delete provisionalBudget.limits.maxConcurrentWorkers;
  updateTask(fixture.taskId, (task) => persistBootstrapBudget(task, provisionalBudget));
  writeResourceJob(fixture.taskId, "job-provisional-history", {
    workPackageId: "work-provisional-history",
    allocationId: "allocation-provisional-history",
    tokenLimit: 20000,
    totalTokens: 5000,
  });
  writeResourceJob(fixture.taskId, "job-provisional-funded", {
    workPackageId: fundedAllocation.workPackageId,
    allocationId: fundedAllocation.allocationId,
    tokenLimit: fundedAllocation.tokenLimit,
    durationLimitMs: fundedAllocation.durationLimitMs,
    totalTokens: 2000,
    state: "running",
  });
  seedCoordinator(fixture, executionId);
  let sliceCalls = 0;
  const payload = {
    taskId: fixture.taskId,
    executionId,
    config,
    campaignStartedAt: fixture.startedAt,
    campaignSupervisor: true,
  };
  const result = await runCampaignSupervisor(payload, path.join(__dirname, "ai-mobile-local-mcp.js"), {
    campaignSummary: ({ taskId }) => summaryFor(taskId),
    runSlice: async () => {
      sliceCalls += 1;
      return { stopReason: "user-decision-required", blocker: "fixture-decision" };
    },
  });
  let supervisor = readTask(fixture.taskId).program.runtime.programSupervisor;
  assert.equal(result.stopReason, "user-decision-required");
  assert.equal(sliceCalls, 1);
  assert.equal(supervisor.limitSource.kind, "bootstrap-resource-budget");
  assert.equal(supervisor.limits.maxTokens, 116000, "Historical exposure outside the bootstrap allocation is additive; its funded allocation is not double-counted.");
  assert.equal(supervisor.limits.maxDurationMs, 2100000, "A missing duration dimension is bounded at the exact preexisting authorization instead of discarding the valid budget.");
  assert.equal(supervisor.limits.maxAttempts, 3);
  assert.equal(supervisor.limits.maxWorkers, 2);
  assert.equal(supervisor.limitBaseline.historicalExposure.tokens, 20000);
  assert.equal(supervisor.limitBaseline.historicalCommitted.tokens, 5000);
  assert.equal(supervisor.limitBaseline.fundedExposure.tokens, 30000);
  assert.equal(supervisor.limitBaseline.sourceRemainingBudget.tokens, 96000);
  assert.equal(supervisor.limitRevision, 1);
  assert.equal(supervisor.limitHistory.length, 0);

  const replay = await runCampaignSupervisor(payload, path.join(__dirname, "ai-mobile-local-mcp.js"), {
    campaignSummary: ({ taskId }) => summaryFor(taskId),
    runSlice: async () => {
      sliceCalls += 1;
      return { stopReason: "user-decision-required", blocker: "unexpected-replay" };
    },
  });
  supervisor = readTask(fixture.taskId).program.runtime.programSupervisor;
  assert.equal(replay.stopReason, "user-decision-required");
  assert.equal(sliceCalls, 1, "A stopped supervisor replay must not dispatch another slice.");
  assert.equal(supervisor.limits.maxTokens, 116000, "Replaying the same revision-fenced provisional budget must not expand its cap.");
  assert.equal(supervisor.limitRevision, 1);
  assert.equal(supervisor.limitHistory.length, 0);
  return {
    source: supervisor.limitSource.kind,
    maxTokens: supervisor.limits.maxTokens,
    maxDurationMs: supervisor.limits.maxDurationMs,
    historicalTokens: supervisor.limitBaseline.historicalExposure.tokens,
    fundedTokens: supervisor.limitBaseline.fundedExposure.tokens,
    replayExpanded: false,
  };
}
async function drainAndBudgetRefreshScenario() {
  const refreshFixture = createDirectorFixture("drain-budget-refresh", 2);
  const refreshExecutionId = "execution-drain-budget-refresh";
  const oldBudget = bootstrapBudgetRecord("drain-budget-refresh", { revision: 1, maxTokens: 100, maxDurationMs: 10000, maxAttempts: 2 });
  updateTask(refreshFixture.taskId, (task) => {
    persistBootstrapBudget(task, oldBudget);
    task.program.workPackages = task.program.workPackages.map((row) => ({ ...row, state: "ready", jobId: null, allocation: null }));
    return task;
  });
  writeResourceJob(refreshFixture.taskId, "job-drain-budget-history", {
    workPackageId: "work-drain-budget-history",
    allocationId: "allocation-drain-budget-history",
    tokenLimit: 100,
    durationLimitMs: 1000,
    maxAttempts: 1,
    state: "completed",
  });
  coordinatorTest.ensureProgramSupervisor(refreshFixture.taskId, { config });
  updateTask(refreshFixture.taskId, (task) => {
    task.program.runtime.programSupervisor.limits.maxTokens = 100;
    task.program.runtime.programSupervisor.limitSource = {
      kind: "bootstrap-resource-budget",
      budgetId: oldBudget.budgetId,
      revision: oldBudget.revision,
      fingerprint: coordinatorTest.programRecoveryFence(task).fingerprint,
      planId: oldBudget.planId,
      planRevision: oldBudget.planRevision,
      inventoryFingerprint: oldBudget.inventoryFingerprint,
      forecastFingerprint: oldBudget.forecastFingerprint,
    };
    task.program.runtime.programSupervisor.hardCeilings = {};
    return task;
  });
  seedCoordinator(refreshFixture, refreshExecutionId);
  let refreshSlices = 0;
  const refreshResult = await runCampaignSupervisor({
    taskId: refreshFixture.taskId,
    executionId: refreshExecutionId,
    config,
    campaignStartedAt: refreshFixture.startedAt,
    campaignSupervisor: true,
  }, path.join(__dirname, "ai-mobile-local-mcp.js"), {
    campaignSummary: ({ taskId }) => summaryFor(taskId),
    runSlice: async (payload) => {
      refreshSlices += 1;
      if (refreshSlices === 1) {
        assert.equal(payload.programResourceEnvelope.allowBudgetRefresh, true);
        const revisedBudget = bootstrapBudgetRecord("drain-budget-refresh", { revision: 2, maxTokens: 200, maxDurationMs: 20000, maxAttempts: 3 });
        updateTask(refreshFixture.taskId, (task) => persistBootstrapBudget(task, revisedBudget));
        return { stopReason: "resource-budget-refreshed" };
      }
      return { stopReason: "user-decision-required", blocker: "refreshed-authority-observed" };
    },
  });
  const refreshedSupervisor = readTask(refreshFixture.taskId).program.runtime.programSupervisor;
  assert.equal(refreshResult.stopReason, "user-decision-required");
  assert.equal(refreshSlices, 2, "A no-job budget refresh must revise authority and continue without another user message.");
  assert.equal(refreshedSupervisor.limitSource.revision, 2);
  assert.ok(refreshedSupervisor.limits.maxTokens > 100);

  const overshootFixture = createDirectorFixture("overshoot-drain", 2);
  const overshootExecutionId = "execution-overshoot-drain";
  writeResourceJob(overshootFixture.taskId, "job-overshoot-drain", {
    workPackageId: "work-overshoot-drain",
    allocationId: "allocation-overshoot-drain",
    tokenLimit: 200,
    durationLimitMs: 1000,
    maxAttempts: 1,
    state: "completed",
  });
  seedCoordinator(overshootFixture, overshootExecutionId);
  const beforeJobs = listJobIds(overshootFixture.taskId).length;
  let overshootSlices = 0;
  const overshootSummary = ({ taskId }) => ({ ...summaryFor(taskId), latestRound: { roundId: "round-overshoot-drain", state: "needs-correction" } });
  const overshootResult = await runCampaignSupervisor({
    taskId: overshootFixture.taskId,
    executionId: overshootExecutionId,
    config: { ...config, programMaxTokens: 100 },
    campaignStartedAt: overshootFixture.startedAt,
    campaignSupervisor: true,
  }, path.join(__dirname, "ai-mobile-local-mcp.js"), {
    campaignSummary: overshootSummary,
    runSlice: async (payload) => {
      overshootSlices += 1;
      assert.equal(payload.programResourceEnvelope.allowNewConsumption, false);
      assert.equal(payload.programResourceEnvelope.allowBudgetRefresh, false);
      return { stopReason: "resource-cap-exhausted", blocker: "program-token-cap-exceeded" };
    },
  });
  assert.equal(overshootResult.stopReason, "resource-cap-exceeded");
  assert.equal(overshootSlices, 1, "A terminal owned result must receive one deterministic drain slice even after prior overshoot.");
  assert.equal(listJobIds(overshootFixture.taskId).length, beforeJobs);
  return { refreshSlices, revisedMaxTokens: refreshedSupervisor.limits.maxTokens, overshootDrainSlices: overshootSlices, newJobs: 0 };
}

async function hardCeilingPendingRealSummaryScenario() {
  const fixture = createDirectorFixture("hard-pending-real-summary", 2);
  const executionId = "execution-hard-pending-real-summary";
  updateTask(fixture.taskId, (task) => {
    task.program.workPackages = task.program.workPackages.map((row) => ({
      ...row,
      state: "pending",
      jobId: null,
      allocation: null,
      dependencies: [],
      goal: "Execute the pending hard-cap fixture package.",
      executorKind: "implementation",
      deliverableKind: "patch",
      relevantFiles: [],
      expectedFiles: [],
      requiredCapabilities: [],
      requiredPermissions: [],
    }));
    task.workGraph = task.workGraph.map((row) => ({
      ...row,
      state: "pending",
      dependsOn: [],
      owner: null,
      goal: "Execute the pending hard-cap fixture package.",
      acceptanceRequirementId: "REQ-HARD-PENDING-REAL-SUMMARY",
    }));
    return task;
  });
  writeResourceJob(fixture.taskId, "job-hard-pending-history", {
    workPackageId: "work-hard-pending-history",
    allocationId: "allocation-hard-pending-history",
    tokenLimit: 200,
    durationLimitMs: 10000,
    maxAttempts: 1,
    state: "completed",
  });
  seedCoordinator(fixture, executionId);
  const beforeTask = readTask(fixture.taskId);
  const beforeJobs = listJobIds(fixture.taskId).length;
  const beforeCampaigns = beforeTask.program.campaigns.length;
  const beforeBudget = JSON.stringify(beforeTask.program.resourceBudget || beforeTask.program.runtime?.budget || null);
  let jobCalls = 0;
  const resources = {
    generatedAt: new Date().toISOString(),
    machine: { freeRamMb: 4096, freeDiskMb: 10000 },
    worktreeStorage: { freeMb: 10000, withinQuota: true, hasMinimumFree: true },
    providers: {},
  };
  const result = await runCampaignSupervisor({
    taskId: fixture.taskId,
    executionId,
    config: { ...config, programMaxTokens: 200 },
    campaignStartedAt: fixture.startedAt,
    campaignSupervisor: true,
  }, path.join(__dirname, "ai-mobile-local-mcp.js"), {
    inventory: async () => resources,
    providerHistory: () => ({}),
    createJob: () => { jobCalls += 1; throw new Error("hard ceiling attempted a job"); },
  });
  const afterTask = readTask(fixture.taskId);
  assert.equal(result.stopReason, "resource-cap-exceeded");
  assert.equal(jobCalls, 0);
  assert.equal(listJobIds(fixture.taskId).length, beforeJobs);
  assert.equal(afterTask.program.campaigns.length, beforeCampaigns, "A hard-ceiling equality must not create campaign N+1 during budget refresh.");
  assert.equal(JSON.stringify(afterTask.program.resourceBudget || afterTask.program.runtime?.budget || null), beforeBudget, "A hard-ceiling equality must not persist new allocation authority.");
  return { stopReason: result.stopReason, newJobs: 0, newCampaigns: 0, budgetAuthorityChanged: false };
}

async function runningOvershootDrainScenario() {
  const fixture = createDirectorFixture("running-overshoot-drain", 2);
  const executionId = "execution-running-overshoot-drain";
  const jobId = "job-running-overshoot-drain";
  writeResourceJob(fixture.taskId, jobId, {
    workPackageId: "work-running-overshoot-drain",
    allocationId: "allocation-running-overshoot-drain",
    tokenLimit: 200,
    durationLimitMs: 10000,
    maxAttempts: 1,
    state: "running",
    finishedAt: null,
  });
  updateTask(fixture.taskId, (task) => {
    task.program.workPackages = task.program.workPackages.map((row) => ({ ...row, state: "running", jobId }));
    return task;
  });
  const round = createRoundRecord(fixture.taskId, {
    state: "running",
    jobs: [{ jobId, provider: "codex", model: "gpt-5.3-codex-spark", workGraphNodeId: "work-running-overshoot-drain" }],
    rejected: [],
  });
  coordinatorTest.ensureProgramSupervisor(fixture.taskId, { config: { ...config, programMaxTokens: 100 } });
  updateTask(fixture.taskId, (task) => {
    task.program.runtime.programSupervisor.limits.maxEvents = 1;
    task.program.runtime.programSupervisor.wakeCount = 1;
    return task;
  });
  seedCoordinator(fixture, executionId);
  const beforeJobs = listJobIds(fixture.taskId).length;
  let sliceCalls = 0;
  let sleepCalls = 0;
  let integrations = 0;
  const runningSummary = ({ taskId }) => ({ ...summaryFor(taskId), latestRound: { roundId: round.roundId, state: "running" } });
  const result = await runCampaignSupervisor({
    taskId: fixture.taskId,
    executionId,
    config: { ...config, programMaxTokens: 100 },
    campaignStartedAt: fixture.startedAt,
    campaignSupervisor: true,
  }, path.join(__dirname, "ai-mobile-local-mcp.js"), {
    campaignSummary: runningSummary,
    campaignSleep: async () => {
      sleepCalls += 1;
      writeJson(path.join(jobDirectory(fixture.taskId, jobId), "status.json"), {
        state: "completed",
        startedAt: new Date(Date.now() - 2000).toISOString(),
        finishedAt: new Date().toISOString(),
      });
    },
    runSlice: async (payload) => {
      sliceCalls += 1;
      assert.equal(payload.programResourceEnvelope.allowNewConsumption, false);
      if (sliceCalls === 1) return { stopReason: "worker-deadline" };
      integrations += 1;
      updateRound(fixture.taskId, round.roundId, { state: "integrated" });
      return { stopReason: "resource-cap-exhausted", blocker: "program-token-cap-exceeded" };
    },
  });
  assert.equal(result.stopReason, "resource-cap-exceeded");
  assert.equal(sliceCalls, 2, `A worker terminal after the finite slice must wake exactly one integration-only drain slice: ${JSON.stringify({ result, supervisor: readTask(fixture.taskId).program.runtime.programSupervisor })}`);
  assert.equal(sleepCalls, 1);
  assert.equal(integrations, 1);
  assert.equal(listJobIds(fixture.taskId).length, beforeJobs);
  return { slices: sliceCalls, waits: sleepCalls, integrations, duplicateJobs: 0, eventCapDrain: true };
}

async function reservedAuthorityEnvelopeScenario() {
  const retryFixture = createDirectorFixture("reserved-authority-retry", 2);
  const retryExecutionId = "execution-reserved-authority-retry";
  const retryAllocation = {
    allocationId: "allocation-reserved-authority-retry",
    workPackageId: "work-reserved-authority-retry",
    candidateId: "candidate-reserved-authority-retry",
    provider: "codex",
    model: "gpt-5.3-codex-spark",
    tokenLimit: 50,
    durationLimitMs: 1000,
    maxAttempts: 2,
  };
  updateTask(retryFixture.taskId, (task) => {
    task.program.workPackages = task.program.workPackages.map((row) => ({ ...row, state: "ready", jobId: null, allocation: retryAllocation }));
    task.program.activeCampaign = { ...task.program.activeCampaign, allocationIds: [retryAllocation.allocationId] };
    task.program.campaigns = [{ ...task.program.activeCampaign }];
    return task;
  });
  writeResourceJob(retryFixture.taskId, "job-reserved-authority-first", {
    workPackageId: retryAllocation.workPackageId,
    allocationId: retryAllocation.allocationId,
    candidateId: retryAllocation.candidateId,
    tokenLimit: retryAllocation.tokenLimit,
    durationLimitMs: retryAllocation.durationLimitMs,
    maxAttempts: retryAllocation.maxAttempts,
    state: "failed",
  });
  seedCoordinator(retryFixture, retryExecutionId);
  let retrySlices = 0;
  const retryResult = await runCampaignSupervisor({
    taskId: retryFixture.taskId,
    executionId: retryExecutionId,
    config: { ...config, programMaxTokens: 100, programMaxDurationMs: 2000, programMaxAttempts: 2 },
    campaignStartedAt: retryFixture.startedAt,
    campaignSupervisor: true,
  }, path.join(__dirname, "ai-mobile-local-mcp.js"), {
    campaignSummary: ({ taskId }) => summaryFor(taskId),
    runSlice: async (payload) => {
      retrySlices += 1;
      assert.deepEqual(payload.programResourceEnvelope.allowedAllocationIds, [retryAllocation.allocationId]);
      return { stopReason: "user-decision-required", blocker: "retry-envelope-observed" };
    },
  });
  assert.equal(retryResult.stopReason, "user-decision-required");
  assert.equal(retrySlices, 1, "Aggregate equality must still enter one slice for an already-reserved retry.");

  const campaignFixture = createDirectorFixture("campaign-equality", 2);
  const campaignExecutionId = "execution-campaign-equality";
  const campaignAllocation = {
    allocationId: "allocation-campaign-equality",
    workPackageId: "work-campaign-equality",
    candidateId: "candidate-campaign-equality",
    provider: "codex",
    model: "gpt-5.3-codex-spark",
    tokenLimit: 1000,
    durationLimitMs: 1000,
    maxAttempts: 1,
  };
  updateTask(campaignFixture.taskId, (task) => {
    task.program.workPackages = task.program.workPackages.map((row) => ({ ...row, state: "ready", jobId: null, allocation: campaignAllocation }));
    task.program.activeCampaign = { ...task.program.activeCampaign, epoch: 1, allocationIds: [campaignAllocation.allocationId] };
    task.program.campaigns = [{ ...task.program.activeCampaign }];
    return task;
  });
  seedCoordinator(campaignFixture, campaignExecutionId);
  let campaignSlices = 0;
  const campaignResult = await runCampaignSupervisor({
    taskId: campaignFixture.taskId,
    executionId: campaignExecutionId,
    config: { ...config, programMaxCampaigns: 1, programMaxTokens: 10000, programMaxDurationMs: 10000, programMaxAttempts: 10 },
    campaignStartedAt: campaignFixture.startedAt,
    campaignSupervisor: true,
  }, path.join(__dirname, "ai-mobile-local-mcp.js"), {
    campaignSummary: ({ taskId }) => summaryFor(taskId),
    runSlice: async (payload) => {
      campaignSlices += 1;
      assert.equal(payload.programResourceEnvelope.allowCreateCampaign, false);
      assert.deepEqual(payload.programResourceEnvelope.allowedAllocationIds, [campaignAllocation.allocationId]);
      return { stopReason: "user-decision-required", blocker: "campaign-envelope-observed" };
    },
  });
  assert.equal(campaignResult.stopReason, "user-decision-required");
  assert.equal(campaignSlices, 1, "Campaign #1 at maxCampaigns=1 must still dispatch its already-funded allocation.");
  const campaignTask = readTask(campaignFixture.taskId);
  const campaignSupervisor = campaignTask.program.runtime.programSupervisor;
  const campaignSafety = coordinatorTest.programSupervisorResourceSafety(campaignTask, campaignSupervisor);
  const envelope = coordinatorTest.programConsumptionEnvelope(campaignTask, campaignSupervisor, campaignSafety);
  assert.equal(envelope.allowCreateCampaign, false);
  assert.equal(envelope.allowBudgetRefresh, false);
  return { reservedRetrySlices: retrySlices, currentCampaignSlices: campaignSlices, newCampaignAllowed: false };
}

async function stoppedSupervisorRenewalScenario() {
  const fixture = createDirectorFixture("renewal", 2);
  const firstExecutionId = "execution-renewal-first";
  seedCoordinator(fixture, firstExecutionId);
  let firstSlices = 0;
  const first = await runCampaignSupervisor({
    taskId: fixture.taskId,
    executionId: firstExecutionId,
    config: { ...config, programMaxTokens: 50000 },
    campaignStartedAt: fixture.startedAt,
    campaignSupervisor: true,
  }, path.join(__dirname, "ai-mobile-local-mcp.js"), {
    campaignSummary: ({ taskId }) => summaryFor(taskId),
    runSlice: async () => {
      firstSlices += 1;
      return { stopReason: "user-decision-required", blocker: "fixture-stop" };
    },
  });
  const stopped = readTask(fixture.taskId).program.runtime.programSupervisor;
  assert.equal(first.stopReason, "user-decision-required");
  assert.equal(firstSlices, 1);
  assert.equal(stopped.state, "stopped");
  assert.ok(stopped.recoveryFence?.fingerprint);
  const oldId = stopped.supervisorId;
  const oldEpoch = stopped.supervisorEpoch;
  const oldDeadline = stopped.deadlineAt;
  const oldCampaignCount = stopped.campaignCount;
  const oldAllocations = [...stopped.allocationIds];

  const replay = await runCampaignSupervisor({
    taskId: fixture.taskId,
    executionId: "execution-renewal-identical",
    config: { ...config, programMaxTokens: 200000 },
    campaignStartedAt: fixture.startedAt,
    campaignSupervisor: true,
  }, path.join(__dirname, "ai-mobile-local-mcp.js"), {
    campaignSummary: ({ taskId }) => summaryFor(taskId),
    runSlice: async () => { throw new Error("identical stopped replay dispatched"); },
  });
  assert.equal(replay.state, "stopped");
  assert.equal(readTask(fixture.taskId).program.runtime.programSupervisor.supervisorId, oldId);

  updateTask(fixture.taskId, (task) => {
    task.program.contextDossier = { dossierId: "dossier-renewal", contextRevision: 1, contextFingerprint: "context-renewal-1" };
    return task;
  });
  const renewedExecutionId = "execution-renewal-second";
  seedCoordinator(fixture, renewedExecutionId);
  let renewedAtSlice = null;
  const renewedResult = await runCampaignSupervisor({
    taskId: fixture.taskId,
    executionId: renewedExecutionId,
    config: { ...config, programMaxTokens: 200000 },
    campaignStartedAt: fixture.startedAt,
    campaignSupervisor: true,
  }, path.join(__dirname, "ai-mobile-local-mcp.js"), {
    campaignSummary: ({ taskId }) => summaryFor(taskId),
    runSlice: async () => {
      renewedAtSlice = readTask(fixture.taskId).program.runtime.programSupervisor;
      coordinatorTest.persistProgramSupervisorStop(fixture.taskId, "stale-old-epoch-stop", { owner: "fixture", trigger: "stale", action: "none" }, { expectedSupervisorId: oldId, expectedSupervisorEpoch: oldEpoch });
      assert.equal(readTask(fixture.taskId).program.runtime.programSupervisor.state, "active", "A stale prior-epoch stop must not fence the renewed supervisor.");
      return { stopReason: "user-decision-required", blocker: "renewed-fixture-stop" };
    },
  });
  const renewed = readTask(fixture.taskId).program.runtime.programSupervisor;
  assert.equal(renewedResult.stopReason, "user-decision-required");
  assert.notEqual(renewedAtSlice.supervisorId, oldId);
  assert.equal(renewedAtSlice.supervisorEpoch, oldEpoch + 1);
  assert.ok(Date.parse(renewedAtSlice.deadlineAt) > Date.parse(oldDeadline));
  assert.equal(renewedAtSlice.hardCeilings.maxTokens, 50000, "A looser renewal call must preserve the prior hard ceiling.");
  assert.ok(renewedAtSlice.campaignCount >= oldCampaignCount);
  assert.deepEqual(renewedAtSlice.allocationIds, oldAllocations);
  assert.equal(renewed.stopReason, "user-decision-required");

  const completedFixture = createDirectorFixture("renewal-completed", 2);
  const completedSupervisor = coordinatorTest.ensureProgramSupervisor(completedFixture.taskId, { config });
  coordinatorTest.persistProgramSupervisorStop(completedFixture.taskId, "acceptance-complete", null, { completed: true, expectedSupervisorId: completedSupervisor.supervisorId });
  updateTask(completedFixture.taskId, (task) => { task.program.contextDossier = { contextRevision: 2, contextFingerprint: "completed-context-2" }; return task; });
  assert.equal(coordinatorTest.ensureProgramSupervisor(completedFixture.taskId, { config }).state, "completed");

  const cancelledFixture = createDirectorFixture("renewal-cancelled", 2);
  const cancelSupervisor = coordinatorTest.ensureProgramSupervisor(cancelledFixture.taskId, { config });
  updateTask(cancelledFixture.taskId, (task) => {
    task.program.runtime.programSupervisor.limits.maxEvents = 1;
    task.program.runtime.programSupervisor.limits.noProgressLimit = 1;
    return task;
  });
  const cancelled = coordinatorTest.persistProgramSupervisorWake(cancelledFixture.taskId, {
    reason: "cancel",
    stateFingerprint: "cancel-boundary",
    evidenceFingerprint: "cancel-evidence",
    expectedSupervisorId: cancelSupervisor.supervisorId,
    expectedSupervisorEpoch: cancelSupervisor.supervisorEpoch,
  }).supervisor;
  assert.equal(cancelled.state, "cancelled");
  assert.equal(cancelled.stopReason, "cancelled", "Explicit cancellation must outrank event/no-progress caps.");
  updateTask(cancelledFixture.taskId, (task) => { task.program.contextDossier = { contextRevision: 2, contextFingerprint: "cancelled-context-2" }; return task; });
  assert.equal(coordinatorTest.ensureProgramSupervisor(cancelledFixture.taskId, { config }).state, "cancelled");
  return { renewed: true, oldEpoch, newEpoch: renewedAtSlice.supervisorEpoch, staleStopIgnored: true, terminalStatesMonotonic: true };
}

async function readOnlyRecoveryAdmissionScenario() {
  const fixture = createDirectorFixture("recovery-admission", 2);
  updateTask(fixture.taskId, (task) => {
    task.program.programId = "program-recovery-admission";
    return task;
  });
  const initial = coordinatorTest.ensureProgramSupervisor(fixture.taskId, { config });
  coordinatorTest.persistProgramSupervisorStop(fixture.taskId, "no-acceptance-progress", {
    owner: "director",
    trigger: "bounded-reconciliation",
    action: "Run one read-only reconciliation package.",
  }, { expectedSupervisorId: initial.supervisorId, expectedSupervisorEpoch: initial.supervisorEpoch });
  writeResourceJob(fixture.taskId, "job-recovery-admission-failed", {
    programId: "program-recovery-admission",
    workPackageId: "work-recovery-admission-failed",
    allocationId: "allocation-recovery-admission-failed",
    tokenLimit: 150000,
    durationLimitMs: 2100000,
    totalTokens: 28000,
    durationMs: 217314,
    state: "failed",
  });
  updateTask(fixture.taskId, (task) => {
    task.program.workPackages = [{
      workPackageId: "work-recovery-admission-failed",
      executorKind: "code-change",
      state: "failed",
      jobId: "job-recovery-admission-failed",
      allocation: { allocationId: "allocation-recovery-admission-failed" },
    }, {
      workPackageId: "reconcile-recovery-admission",
      executorKind: "reconciliation",
      state: "pending",
      jobId: null,
      readOnly: true,
      failedWorkPackageId: "work-recovery-admission-failed",
      failurePacket: { failureFingerprint: "failure-recovery-admission" },
      requiredPermissions: ["read-project", "read-files"],
      permissionGrant: ["read-project", "read-files"],
      estimatedDirectTokens: 150000,
      resourceEstimate: { tokens: 150000, wallTimeSeconds: 1200 },
    }];
    return task;
  });
  const renewed = coordinatorTest.ensureProgramSupervisor(fixture.taskId, { config });
  assert.equal(renewed.state, "active", "One pending read-only reconciliation reopens a stopped recoverable supervisor.");
  assert.equal(renewed.supervisorEpoch, initial.supervisorEpoch + 1);
  assert.equal(renewed.activeRecoveryAdmission.workPackageId, "reconcile-recovery-admission");
  assert.equal(renewed.activeRecoveryAdmission.grant.maxAttempts, 1);
  assert.equal(renewed.activeRecoveryAdmission.grant.maxWorkers, 1);
  assert.equal(renewed.activeRecoveryAdmission.grant.externalWritesAllowed, false);
  assert.ok(renewed.limits.maxDurationMs >= 217314 + 1200000, "Unused terminal duration authorization must not block the bounded recovery grant.");
  assert.equal(renewed.recoveryAdmissionHistory.length, 1);

  coordinatorTest.persistProgramSupervisorStop(fixture.taskId, "no-progress-limit", {
    owner: "director",
    trigger: "material-change",
    action: "Do not replay an identical recovery admission.",
  }, { expectedSupervisorId: renewed.supervisorId, expectedSupervisorEpoch: renewed.supervisorEpoch });
  const replay = coordinatorTest.ensureProgramSupervisor(fixture.taskId, { config });
  assert.equal(replay.state, "stopped", "An identical recovery admission is not replayed.");
  assert.equal(replay.supervisorId, renewed.supervisorId);
  assert.equal(replay.recoveryAdmissionHistory.length, 1);

  const pendingRecoveryState = coordinatorTest.campaignFoundationState({ program: { phase: "reconciliation", workPackages: [{
    workPackageId: "reconcile-once",
    executorKind: "reconciliation",
    state: "pending",
    failurePacket: { failureFingerprint: "failure-once" },
  }] } });
  const completedRecoveryState = coordinatorTest.campaignFoundationState({ program: { phase: "context", workPackages: [{
    workPackageId: "reconcile-once",
    executorKind: "reconciliation",
    state: "completed",
    jobId: "job-reconcile-once",
    failurePacket: { failureFingerprint: "failure-once" },
  }] } });
  const recoveryTransition = coordinatorTest.campaignFoundationTransition(pendingRecoveryState, completedRecoveryState, {});
  assert.equal(recoveryTransition.eligible, true, "A newly completed strong reconciliation authorizes its prescribed correction once.");
  assert.ok(recoveryTransition.keys.includes("reconciliation:failure-once"));
  const consumedRecoveryTransition = coordinatorTest.campaignFoundationTransition(pendingRecoveryState, completedRecoveryState, { foundationTransitions: recoveryTransition.keys });
  assert.equal(consumedRecoveryTransition.eligible, false, "The same reconciliation fingerprint cannot reset no-progress twice.");
  const mutatingTask = JSON.parse(JSON.stringify(readTask(fixture.taskId)));
  mutatingTask.program.workPackages.find((row) => row.executorKind === "reconciliation").requiredPermissions.push("write-files");
  mutatingTask.program.runtime.programSupervisor.recoveryAdmissionHistory = [];
  const denied = coordinatorTest.programRecoveryAdmission(mutatingTask, {
    ...mutatingTask.program.runtime.programSupervisor,
    state: "stopped",
    stopReason: "no-progress-limit",
  }, { concurrency: { programActive: 0 }, jobs: [] });
  assert.equal(denied, null, "A mutating reconciliation cannot use the read-only recovery admission.");
  const hardCap = coordinatorTest.recoveryAdmissionLimits({}, {
    authorization: { capacityTotals: { tokens: 28000, durationMs: 217314, attempts: 1 } },
    totals: {},
  }, renewed.activeRecoveryAdmission, { maxDurationMs: 1000000 });
  assert.equal(hardCap.allowed, false, "An explicit hard ceiling still blocks recovery admission.");
  return {
    epoch: renewed.supervisorEpoch,
    admissionHistory: renewed.recoveryAdmissionHistory.length,
    replayBlocked: true,
    mutatingBlocked: true,
    hardCeilingPreserved: true,
  };
}

async function inSupervisorRecoveryAdmissionScenario() {
  const fixture = createDirectorFixture("in-supervisor-recovery", 1, true);
  updateTask(fixture.taskId, (task) => {
    task.program.programId = "program-in-supervisor-recovery";
    task.program.phase = "reconciliation";
    return task;
  });
  const executionId = "execution-in-supervisor-recovery";
  seedCoordinator(fixture, executionId);
  let sliceCalls = 0;
  let initialSupervisor = null;
  let admittedSupervisor = null;
  const result = await runCampaignSupervisor({
    taskId: fixture.taskId,
    executionId,
    config: { ...config, noProgressLimit: 1 },
    campaignStartedAt: fixture.startedAt,
    campaignSupervisor: true,
  }, path.join(__dirname, "ai-mobile-local-mcp.js"), {
    campaignSummary: ({ taskId }) => summaryFor(taskId),
    runSlice: async () => {
      sliceCalls += 1;
      if (sliceCalls === 1) {
        initialSupervisor = readTask(fixture.taskId).program.runtime.programSupervisor;
        writeResourceJob(fixture.taskId, "job-in-supervisor-failed", {
          programId: "program-in-supervisor-recovery",
          workPackageId: "work-in-supervisor-failed",
          allocationId: "allocation-in-supervisor-failed",
          tokenLimit: 100000,
          durationLimitMs: 900000,
          totalTokens: 20000,
          durationMs: 120000,
          state: "failed",
        });
        updateTask(fixture.taskId, (task) => {
          task.program.phase = "reconciliation";
          task.program.workPackages = [{
            workPackageId: "work-in-supervisor-failed",
            executorKind: "operational-transaction",
            state: "failed",
            jobId: "job-in-supervisor-failed",
            allocation: { allocationId: "allocation-in-supervisor-failed" },
          }, {
            workPackageId: "reconcile-in-supervisor-once",
            executorKind: "reconciliation",
            deliverableKind: "reconciliation-decision",
            state: "pending",
            jobId: null,
            readOnly: true,
            failedWorkPackageId: "work-in-supervisor-failed",
            failurePacket: { failureFingerprint: "failure-in-supervisor-once" },
            requiredPermissions: ["read-project", "read-files"],
            permissionGrant: ["read-project", "read-files"],
            estimatedDirectTokens: 100000,
            resourceEstimate: { tokens: 100000, wallTimeSeconds: 900 },
          }];
          task.workGraph = [
            { id: "work-in-supervisor-failed", state: "failed", dependsOn: [], priority: 100 },
            { id: "reconcile-in-supervisor-once", state: "pending", dependsOn: [], priority: 100 },
          ];
          return task;
        });
        return { taskId: fixture.taskId, stopReason: "worker-deadline", roundsStarted: 1 };
      }
      admittedSupervisor = readTask(fixture.taskId).program.runtime.programSupervisor;
      assert.equal(admittedSupervisor.state, "active");
      assert.equal(admittedSupervisor.supervisorEpoch, initialSupervisor.supervisorEpoch + 1);
      assert.equal(admittedSupervisor.activeRecoveryAdmission.workPackageId, "reconcile-in-supervisor-once");
      assert.equal(admittedSupervisor.activeRecoveryAdmission.grant.maxAttempts, 1);
      assert.equal(admittedSupervisor.activeRecoveryAdmission.grant.maxWorkers, 1);
      assert.equal(admittedSupervisor.activeRecoveryAdmission.grant.externalWritesAllowed, false);
      assert.equal(admittedSupervisor.startedAt, initialSupervisor.startedAt, "Protected recovery must not extend the authorized horizon start.");
      assert.equal(admittedSupervisor.deadlineAt, initialSupervisor.deadlineAt, "Protected recovery must not extend the authorized horizon deadline.");
      writeResourceJob(fixture.taskId, "job-in-supervisor-recovery-failed", {
        programId: "program-in-supervisor-recovery",
        workPackageId: "reconcile-in-supervisor-once",
        allocationId: "allocation-in-supervisor-recovery-failed",
        tokenLimit: 100000,
        durationLimitMs: 900000,
        totalTokens: 18000,
        durationMs: 90000,
        state: "failed",
      });
      updateTask(fixture.taskId, (task) => {
        const firstRecovery = task.program.workPackages.find((row) => row.workPackageId === "reconcile-in-supervisor-once");
        firstRecovery.state = "failed";
        firstRecovery.jobId = "job-in-supervisor-recovery-failed";
        firstRecovery.allocation = { allocationId: "allocation-in-supervisor-recovery-failed" };
        task.program.workPackages.push({
          workPackageId: "reconcile-in-supervisor-second",
          executorKind: "reconciliation",
          deliverableKind: "reconciliation-decision",
          state: "pending",
          jobId: null,
          readOnly: true,
          failedWorkPackageId: "reconcile-in-supervisor-once",
          failurePacket: { failureFingerprint: "failure-in-supervisor-second" },
          requiredPermissions: ["read-project", "read-files"],
          permissionGrant: ["read-project", "read-files"],
          estimatedDirectTokens: 100000,
          resourceEstimate: { tokens: 100000, wallTimeSeconds: 900 },
        });
        task.workGraph = [
          { id: "work-in-supervisor-failed", state: "failed", dependsOn: [], priority: 100 },
          { id: "reconcile-in-supervisor-once", state: "failed", dependsOn: [], priority: 100 },
          { id: "reconcile-in-supervisor-second", state: "pending", dependsOn: [], priority: 100 },
        ];
        return task;
      });
      return { taskId: fixture.taskId, stopReason: "worker-deadline", roundsStarted: 1 };
    },
  });
  const finalTask = readTask(fixture.taskId);
  const finalSupervisor = finalTask.program.runtime.programSupervisor;
  const events = readMaterialEvents({ taskId: fixture.taskId, maxEvents: 100 }).events;
  assert.equal(result.stopReason, "no-progress-limit");
  assert.equal(sliceCalls, 2, "The first pending read-only reconciler must run in the same host campaign invocation.");
  assert.equal(finalSupervisor.recoveryAdmissionHistory.length, 1);
  assert.equal(finalSupervisor.supervisorEpoch, initialSupervisor.supervisorEpoch + 1, "A distinct second failure must not open another recovery epoch in the same invocation.");
  assert.equal(finalSupervisor.recoveryAdmissionHistory[0].recoveryInvocationId, executionId);
  assert.equal(events.filter((row) => row.type === "campaign.recovery-admitted").length, 1);
  return {
    slices: sliceCalls,
    supervisorEpoch: admittedSupervisor.supervisorEpoch,
    admissionHistory: finalSupervisor.recoveryAdmissionHistory.length,
    secondDistinctAdmissionBlocked: true,
    originalHorizonPreserved: admittedSupervisor.deadlineAt === initialSupervisor.deadlineAt,
    anotherHostInvocationRequired: false,
  };
}

async function liveExplicitCapReuseScenario() {
  const fixture = createDirectorFixture("live-cap-reuse", 2);
  const executionId = "execution-live-cap-reuse";
  coordinatorTest.ensureProgramSupervisor(fixture.taskId, { config: { ...config, programMaxTokens: 100000 } });
  writeResourceJob(fixture.taskId, "job-live-cap-reuse", {
    workPackageId: "work-live-cap-reuse",
    allocationId: "allocation-live-cap-reuse",
    tokenLimit: 20000,
    state: "completed",
  });
  seedCoordinator(fixture, executionId);
  const reused = startCoordinator({ taskId: fixture.taskId, campaignSupervisor: true, programMaxTokens: 10000 }, path.join(__dirname, "ai-mobile-local-mcp.js"));
  const clamped = readTask(fixture.taskId).program.runtime.programSupervisor;
  assert.equal(reused.reused, true);
  assert.equal(clamped.limits.maxTokens, 10000);
  assert.equal(clamped.hardCeilings.maxTokens, 10000);
  let slices = 0;
  const stopped = await runCampaignSupervisor({
    taskId: fixture.taskId,
    executionId,
    config: { ...config, programMaxTokens: 100000 },
    campaignStartedAt: fixture.startedAt,
    campaignSupervisor: true,
  }, path.join(__dirname, "ai-mobile-local-mcp.js"), {
    campaignSummary: ({ taskId }) => summaryFor(taskId),
    runSlice: async () => { slices += 1; return { stopReason: "user-decision-required" }; },
  });
  assert.equal(stopped.stopReason, "resource-cap-exceeded");
  assert.equal(slices, 0);
  return { reused: true, durableMaxTokens: clamped.limits.maxTokens, slices };
}

async function quotaUnknownRecoveryScenario() {
  const fixture = createDirectorFixture("quota-recovery", 2);
  const executionId = "execution-quota-recovery";
  updateTask(fixture.taskId, (task) => {
    task.program.workPackages = task.program.workPackages.map((row) => ({
      ...row,
      state: "ready",
      jobId: null,
      allocation: {
        allocationId: "allocation-quota-recovery",
        provider: "antigravity",
        model: "gemini-3.5-flash",
        quotaPool: "all",
        tokenLimit: 1000,
        durationLimitMs: 60000,
        maxAttempts: 1,
      },
    }));
    task.program.runtime = {
      ...task.program.runtime,
      ledger: {
        providers: {
          antigravity: {
            quotaPools: [{
              id: "all",
              key: "antigravity:all",
              remaining: { state: "unknown", unit: "percent", value: null, reason: "fresh quota observation required" },
            }],
          },
        },
      },
    };
    return task;
  });
  seedCoordinator(fixture, executionId);
  let sliceCalls = 0;
  let sleepCalls = 0;
  let capacityReady = false;
  const resources = () => ({
    machine: { freeRamMb: 1000, freeDiskMb: 10000 },
    worktreeStorage: { freeMb: 10000, withinQuota: true, hasMinimumFree: true },
    providers: {
      antigravity: {
        available: true,
        authenticated: true,
        quotaPools: [{ id: "all", remainingPercent: capacityReady ? 50 : null }],
      },
    },
  });
  const result = await runCampaignSupervisor({
    taskId: fixture.taskId,
    executionId,
    config,
    campaignStartedAt: fixture.startedAt,
    campaignSupervisor: true,
  }, path.join(__dirname, "ai-mobile-local-mcp.js"), {
    campaignSummary: ({ taskId }) => summaryFor(taskId),
    inventory: async () => resources(),
    campaignSleep: async () => {
      sleepCalls += 1;
      capacityReady = true;
    },
    runSlice: async () => {
      sliceCalls += 1;
      if (sliceCalls === 1) {
        return {
          stopReason: "capacity-wait",
          capacityWait: {
            kind: "capacity-wait",
            reasons: ["quota-capacity-unknown:antigravity:all"],
            workPackageIds: ["work-quota-recovery"],
            requiredFreeRamMb: null,
            requiredFreeDiskMb: null,
            initialFingerprint: capacityFingerprint(resources()),
            backoffSeconds: 1,
            maxBackoffSeconds: 2,
            maximumChecks: 2,
          },
        };
      }
      return { stopReason: "user-decision-required", blocker: "fixture-decision" };
    },
  });
  const supervisor = readTask(fixture.taskId).program.runtime.programSupervisor;
  assert.equal(result.stopReason, "user-decision-required", "Quota-only unknown must not be misclassified as spent resource-cap breach.");
  assert.equal(sliceCalls, 2, "Exactly one guarded slice is allowed before the durable quota wake.");
  assert.equal(sleepCalls, 1);
  assert.ok(supervisor.resourceSnapshot.quota.providerBlockers.some((row) => row.code === "quota-capacity-unknown" && row.hard === true));
  return {
    slices: sliceCalls,
    capacityWaits: sleepCalls,
    terminalStop: result.stopReason,
    recoverableCapacity: supervisor.resourceSnapshot.recoverableCapacity,
  };
}

function traceScenario(name) {
  if (process.env.AI_MOBILE_TEST_TRACE === "1") process.stderr.write(`[continuation] ${name}\n`);
}

async function runSelectedScenario(name, action) {
  const selected = String(process.env.AI_MOBILE_TEST_SCENARIO || "").trim();
  if (selected && selected !== name) return { skipped: true };
  traceScenario(name);
  return action();
}

(async () => {
  try {
    const crossing = await runSelectedScenario("crossingAndCapacityScenario", crossingAndCapacityScenario);
    const churn = await runSelectedScenario("noProgressChurnScenario", noProgressChurnScenario);
    const cancellation = await runSelectedScenario("cancelBeforeNextSliceScenario", cancelBeforeNextSliceScenario);
    const phaseAndEpoch = await runSelectedScenario("phaseAndEpochScenario", phaseAndEpochScenario);
    const expiredEpoch = await runSelectedScenario("expiredEpochRolloverScenario", expiredEpochRolloverScenario);
    const resumedHorizon = await runSelectedScenario("resumeOriginalHorizonScenario", resumeOriginalHorizonScenario);
    const hardResourceCap = await runSelectedScenario("hardProgramResourceCapScenario", hardProgramResourceCapScenario);
    const resumeCapTightening = await runSelectedScenario("resumeExplicitCapTighteningScenario", resumeExplicitCapTighteningScenario);
    const exactCapExhaustion = await runSelectedScenario("exactCapExhaustionScenario", exactCapExhaustionScenario);
    const staleRunningLease = await runSelectedScenario("staleRunningPackageUsesLiveLeaseScenario", staleRunningPackageUsesLiveLeaseScenario);
    const budgetLimitRevision = await runSelectedScenario("bootstrapToAcceptedBudgetScenario", bootstrapToAcceptedBudgetScenario);
    const acceptedRecoveryBudget = await runSelectedScenario("acceptedPlanToRecoveryBudgetScenario", acceptedPlanToRecoveryBudgetScenario);
    const conservativeNoBudget = await runSelectedScenario("conservativeNoBudgetHorizonScenario", conservativeNoBudgetHorizonScenario);
    const provisionalBootstrapBudget = await runSelectedScenario("provisionalBootstrapBudgetScenario", provisionalBootstrapBudgetScenario);
    const drainRefresh = await runSelectedScenario("drainAndBudgetRefreshScenario", drainAndBudgetRefreshScenario);
    const hardPendingRealSummary = await runSelectedScenario("hardCeilingPendingRealSummaryScenario", hardCeilingPendingRealSummaryScenario);
    const runningOvershootDrain = await runSelectedScenario("runningOvershootDrainScenario", runningOvershootDrainScenario);
    const reservedAuthority = await runSelectedScenario("reservedAuthorityEnvelopeScenario", reservedAuthorityEnvelopeScenario);
    const renewal = await runSelectedScenario("stoppedSupervisorRenewalScenario", stoppedSupervisorRenewalScenario);
    const recoveryAdmission = await runSelectedScenario("readOnlyRecoveryAdmissionScenario", readOnlyRecoveryAdmissionScenario);
    const inSupervisorRecoveryAdmission = await runSelectedScenario("inSupervisorRecoveryAdmissionScenario", inSupervisorRecoveryAdmissionScenario);
    const liveCapReuse = await runSelectedScenario("liveExplicitCapReuseScenario", liveExplicitCapReuseScenario);
    const quotaRecovery = await runSelectedScenario("quotaUnknownRecoveryScenario", quotaUnknownRecoveryScenario);
    process.stdout.write(JSON.stringify({
      ok: true,
      oneInvocationCrossedStoppedSlices: true,
      crossing,
      churn,
      cancellation,
      phaseAndEpoch,
      expiredEpoch,
      resumedHorizon,
      hardResourceCap,
      resumeCapTightening,
      exactCapExhaustion,
      staleRunningLease,
      budgetLimitRevision,
      acceptedRecoveryBudget,
      conservativeNoBudget,
      provisionalBootstrapBudget,
      drainRefresh,
      hardPendingRealSummary,
      runningOvershootDrain,
      reservedAuthority,
      renewal,
      recoveryAdmission,
      inSupervisorRecoveryAdmission,
      liveCapReuse,
      quotaRecovery,
    }, null, 2) + "\n");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
