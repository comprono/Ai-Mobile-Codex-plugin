"use strict";

const { inventory } = require("./capacity");
const { createJob } = require("./job-store");
const { providerHistory } = require("./provider-history");
const { collectRound, completeTask, dispatchRound, integrateRound, taskSummary } = require("./task-orchestrator");
const { utcNow } = require("./utils");
const { startCoordinator } = require("./coordinator");

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(minimum, Math.min(maximum, Math.floor(parsed))) : fallback;
}

function passingCount(summary) {
  return Number(summary?.progress?.passing || 0);
}

function progressSignature(summary) {
  return JSON.stringify({
    state: summary?.state || "",
    passing: passingCount(summary),
    graph: (summary?.workGraph || []).map((node) => [node.id, node.state]),
    evidence: (summary?.requirements || []).reduce((total, row) => total + Number(row.evidenceCount || 0), 0),
  });
}

function compactFailure(result) {
  return {
    jobId: result.jobId,
    provider: result.provider,
    model: result.model,
    blocker: String(result.blocker || "worker-failed").slice(0, 800),
  };
}

async function runTaskCycleInline(args = {}, entrypoint, dependencies = {}) {
  const taskId = String(args.taskId || "").trim();
  if (!taskId) throw new Error("run-task-cycle requires taskId.");
  const maxRounds = boundedInteger(args.maxRounds, 3, 1, 5);
  const maxMinutes = boundedInteger(args.maxMinutes, 15, 1, 30);
  const sliceSeconds = boundedInteger(args.sliceSeconds, 210, 1, 240);
  const horizonHours = boundedInteger(args.horizonHours, 5, 1, 24);
  const noProgressLimit = boundedInteger(args.noProgressLimit, 2, 1, 3);
  const deadline = Date.now() + Math.min(maxMinutes * 60, sliceSeconds) * 1000;
  const inventoryFn = dependencies.inventory || inventory;
  const historiesFn = dependencies.providerHistory || providerHistory;
  const createJobFn = dependencies.createJob || ((contract) => createJob(contract, entrypoint));
  const transitions = [];
  const failures = [];
  const failedProviders = new Set();
  const executionRoundIds = new Set();
  let roundsStarted = 0;
  let noProgressCount = 0;
  let lastProgressSignature = progressSignature(taskSummary({ taskId }));
  let stopReason = "time-limit";

  while (Date.now() < deadline) {
    let summary = taskSummary({ taskId });
    if (summary.state !== "completed" && summary.progress?.required > 0 && summary.progress.passing === summary.progress.required) {
      const completion = completeTask({ taskId });
      transitions.push({ type: "completed", completionAllowed: completion.completionAllowed === true });
      summary = taskSummary({ taskId });
    }
    if (summary.state === "completed") {
      stopReason = "acceptance-complete";
      break;
    }

    const latest = summary.latestRound;
    if (latest && ["running", "ready-for-integration", "needs-correction"].includes(latest.state)) {
      const remainingSeconds = Math.max(0, Math.floor((deadline - Date.now()) / 1000));
      const collected = collectRound({
        taskId,
        roundId: latest.roundId,
        waitSeconds: latest.state === "running" ? Math.min(210, remainingSeconds) : 0,
        detail: "full",
      });
      const belongsToCurrentExecution = executionRoundIds.has(latest.roundId);
      if (collected.state === "running") {
        transitions.push({ type: "waiting", roundId: latest.roundId, state: "running" });
        stopReason = "continuation-required";
        break;
      }

      const terminalFailures = (collected.results || []).filter((row) => row.terminal && row.state !== "completed");
      const terminalCompleted = (collected.results || []).filter((row) => row.terminal && row.state === "completed");
      transitions.push({
        type: "collected",
        roundId: latest.roundId,
        state: collected.state,
        completedJobs: terminalCompleted.map((row) => ({ jobId: row.jobId, provider: row.provider, model: row.model })),
        failedJobs: terminalFailures.map(compactFailure),
        recovery: (collected.recoveryPlan?.transitions || []).map((row) => ({
          failureClass: row.failureClass,
          owner: row.owner,
          recoveryTrigger: row.recoveryTrigger,
          recoveryAction: row.recoveryAction,
        })),
      });
      failures.push(...terminalFailures.map(compactFailure));
      if (belongsToCurrentExecution) {
        for (const failure of terminalFailures) failedProviders.add(String(failure.provider || "").toLowerCase());
      }

      const needsIntegration = collected.state === "ready-for-integration" && terminalCompleted.length > 0;
      if (needsIntegration) {
        const integrated = integrateRound({ taskId, roundId: latest.roundId });
        const integrationFailures = (integrated.integrations || []).filter((row) => row.integrated !== true).map((row) => ({
          jobId: row.jobId,
          provider: terminalCompleted.find((completed) => completed.jobId === row.jobId)?.provider || "",
          model: terminalCompleted.find((completed) => completed.jobId === row.jobId)?.model || "",
          blocker: row.blocker,
        }));
        failures.push(...integrationFailures);
        if (belongsToCurrentExecution) {
          for (const failure of integrationFailures) failedProviders.add(String(failure.provider || "").toLowerCase());
        }
        transitions.push({
          type: "integrated",
          roundId: latest.roundId,
          state: integrated.state,
          acceptedEvidence: (integrated.acceptedEvidence || []).map((row) => ({ requirementId: row.requirementId, level: row.level, ref: row.ref })),
          observations: (integrated.integrations || []).filter((row) => row.observation === true && row.integrated === true).map((row) => ({ jobId: row.jobId, createdWorkGraphNodeIds: row.createdWorkGraphNodeIds || [] })),
          failures: integrationFailures,
        });
      }

      summary = taskSummary({ taskId });
      const currentProgressSignature = progressSignature(summary);
      if (currentProgressSignature !== lastProgressSignature) {
        lastProgressSignature = currentProgressSignature;
        noProgressCount = 0;
      } else if (belongsToCurrentExecution) {
        noProgressCount += 1;
      }
      if (noProgressCount >= noProgressLimit) {
        stopReason = "no-progress-limit";
        break;
      }
    }

    summary = taskSummary({ taskId });
    if (summary.state !== "completed" && summary.progress?.required > 0 && summary.progress.passing === summary.progress.required) {
      const completion = completeTask({ taskId });
      transitions.push({ type: "completed", completionAllowed: completion.completionAllowed === true });
      summary = taskSummary({ taskId });
    }
    if (summary.state === "completed") {
      stopReason = "acceptance-complete";
      break;
    }
    if (summary.execution?.userActionRequired) {
      stopReason = "user-decision-required";
      break;
    }
    if (summary.execution?.mustDispatchNow !== true || !(summary.workPlane?.recommendedWorkUnits || []).length) {
      stopReason = "no-dependency-ready-unit";
      break;
    }
    if (roundsStarted >= maxRounds) {
      stopReason = "round-limit";
      break;
    }

    const resources = await inventoryFn({ refresh: true, forDispatch: true });
    const histories = { ...historiesFn() };
    for (const provider of failedProviders) {
      histories[provider] = { ...(histories[provider] || {}), cooledDown: true, cooldownReason: "failed-earlier-in-same-cycle" };
    }
    const round = dispatchRound(
      { taskId, horizonHours },
      resources,
      histories,
      (contract) => {
        if (failedProviders.has(String(contract.provider || "").toLowerCase())) {
          throw new Error("provider-failed-earlier-in-same-cycle: unchanged invocation is not retried");
        }
        return createJobFn(contract);
      },
    );
    roundsStarted += 1;
    executionRoundIds.add(round.roundId);
    transitions.push({
      type: "dispatched",
      roundId: round.roundId,
      workers: (round.workers || []).map((row) => ({ jobId: row.jobId, provider: row.provider, model: row.model, goal: row.goal })),
      rejected: (round.rejected || []).map((row) => ({ goal: row.goal, reason: row.reason })),
    });
    if (!(round.workers || []).length) {
      stopReason = "no-eligible-worker";
      break;
    }
  }

  const summary = taskSummary({ taskId });
  const continuationRequired = summary.latestRound?.state === "running";
  if (continuationRequired && stopReason === "time-limit") stopReason = "continuation-required";
  return {
    taskId,
    state: summary.state,
    workState: summary.workState,
    stopReason,
    continuationRequired,
    sliceSeconds,
    startedRounds: roundsStarted,
    progress: summary.progress,
    transitions,
    failures: failures.slice(-5),
    execution: summary.execution,
    resources: summary.resources,
    latestRound: summary.latestRound,
    completionAllowed: summary.completionAllowed,
    generatedAt: utcNow(),
  };
}

async function runTaskCycle(args = {}, entrypoint, dependencies = {}) {
  if (Object.keys(dependencies || {}).length || args.inline === true) {
    return runTaskCycleInline(args, entrypoint, dependencies);
  }
  return startCoordinator(args, entrypoint);
}

module.exports = { runTaskCycle, runTaskCycleInline };
