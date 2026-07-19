"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { inventory } = require("./capacity");
const { createJob, statusFor, TERMINAL_STATES } = require("./job-store");
const { appendMaterialEvent, readMaterialEvents, target } = require("./material-events");
const { providerHistory } = require("./provider-history");
const {
  collectRound,
  completeTask,
  dispatchRound,
  integrateRound,
  taskSummary,
} = require("./task-orchestrator");
const {
  jobDirectory,
  readPortfolio,
  readPortfolioRound,
  readRound,
  readTask,
} = require("./state-store");
const { bounded, processAlive, readJson, utcNow, withDirectoryLock, writeJson } = require("./utils");

const COORDINATOR_TERMINAL_STATES = new Set(["completed", "stopped", "failed", "cancelled", "interrupted", "superseded"]);

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(minimum, Math.min(maximum, Math.floor(parsed))) : fallback;
}

function coordinatorFile(input) {
  return path.join(target(input).root, "coordinator.json");
}

function coordinatorPayloadFile(input) {
  return path.join(target(input).root, "coordinator-input.json");
}

function readCoordinator(input) {
  return readJson(coordinatorFile(input), null);
}

function coordinatorConfig(input = {}) {
  return {
    maxRounds: boundedInteger(input.maxRounds, 20, 1, 50),
    maxMinutes: boundedInteger(input.maxMinutes, 300, 1, 300),
    noProgressLimit: boundedInteger(input.noProgressLimit, 2, 1, 5),
    horizonHours: boundedInteger(input.horizonHours, 5, 1, 24),
  };
}

function targetArgs(input = {}) {
  const descriptor = target(input);
  return descriptor.type === "portfolio" ? { portfolioId: descriptor.portfolioId } : { taskId: descriptor.taskId };
}

function executionId() {
  return `execution-${Date.now().toString(36)}-${crypto.randomBytes(6).toString("hex")}`;
}

function material(input, execution, value) {
  return appendMaterialEvent(input, { executionId: execution.executionId, ...value });
}

function compactCoordinator(input, state = readCoordinator(input)) {
  if (!state) return { state: "not-started", active: false };
  const active = state.state === "running" && processAlive(state.pid);
  return {
    executionId: state.executionId,
    state: active ? "running" : state.state === "running" ? "interrupted" : state.state,
    active,
    pid: active ? state.pid : null,
    startedAt: state.startedAt || null,
    finishedAt: state.finishedAt || null,
    roundsStarted: Number(state.roundsStarted || 0),
    stopReason: state.stopReason || "",
    lastMaterialEvent: readMaterialEvents({ ...targetArgs(input), maxEvents: 1 }).lastEvent,
    config: state.config || null,
  };
}

function writeCoordinator(input, patch) {
  const file = coordinatorFile(input);
  return withDirectoryLock(`${file}.lock`, () => {
    const current = readJson(file, {});
    const effective = { ...patch };
    const currentExecution = String(current.executionId || "");
    const incomingExecution = String(effective.executionId || currentExecution);
    if (currentExecution && effective.executionId && currentExecution !== effective.executionId && effective.state !== "launching") {
      return current;
    }
    const sameExecution = !currentExecution || !incomingExecution || currentExecution === incomingExecution;
    if (sameExecution && current.state === "cancel-requested" && effective.state && effective.state !== "cancel-requested") {
      if (COORDINATOR_TERMINAL_STATES.has(effective.state)) {
        effective.state = "cancelled";
        effective.stopReason = "cancelled";
      } else {
        delete effective.state;
        delete effective.pid;
      }
    } else if (sameExecution && COORDINATOR_TERMINAL_STATES.has(current.state) && effective.state && effective.state !== current.state) {
      delete effective.state;
      delete effective.pid;
      delete effective.startedAt;
      delete effective.finishedAt;
      delete effective.stopReason;
      delete effective.blocker;
    }
    const next = { schemaVersion: 1, ...current, ...effective, revision: Number(current.revision || 0) + 1, updatedAt: utcNow() };
    writeJson(file, next);
    return next;
  });
}

function startCoordinator(input = {}, entrypoint) {
  const args = targetArgs(input);
  const summary = taskSummary(args);
  if (summary.state === "completed") return { ...args, state: "completed", active: false, completionAllowed: true, noDesktopUiLaunched: true };
  const existing = readCoordinator(args);
  if (existing?.state === "running" && processAlive(existing.pid)) {
    return { ...args, ...compactCoordinator(args, existing), reused: true, noDesktopUiLaunched: true };
  }
  if (existing?.state === "running" && !processAlive(existing.pid)) {
    writeCoordinator(args, { executionId: existing.executionId, state: "interrupted", pid: null, finishedAt: utcNow(), stopReason: "coordinator-process-lost" });
    appendMaterialEvent(args, {
      type: "coordinator.interrupted",
      state: "interrupted",
      executionId: existing.executionId,
      summary: "The deterministic coordinator process ended before a terminal record; durable task and worker state will be reconciled once.",
      blocker: "coordinator-process-lost",
      nextAction: "Resume from authoritative task and worker state without duplicating completed collection or integration.",
    });
  }
  const config = coordinatorConfig(input);
  const id = executionId();
  const payload = { ...args, executionId: id, config, createdAt: utcNow() };
  const payloadFile = coordinatorPayloadFile(args);
  writeJson(payloadFile, payload);
  writeCoordinator(args, {
    executionId: id,
    state: "launching",
    pid: null,
    startedAt: payload.createdAt,
    finishedAt: null,
    stopReason: "",
    roundsStarted: 0,
    lastRoundId: null,
    config,
  });
  let child;
  try {
    child = spawn(process.execPath, [entrypoint, "coordinator", "--json-file", payloadFile], {
      cwd: path.dirname(entrypoint),
      windowsHide: true,
      detached: true,
      stdio: "ignore",
    });
    child.unref();
  } catch (error) {
    writeCoordinator(args, { executionId: id, state: "failed", pid: null, finishedAt: utcNow(), stopReason: "coordinator-launch-failed", blocker: bounded(error.message, 800) });
    throw error;
  }
  const state = writeCoordinator(args, { executionId: id, state: "running", pid: child.pid });
  if (state.state === "running" && processAlive(state.pid)) {
    material(args, state, {
      type: "coordinator.started",
      state: "running",
      summary: "A finite event-driven coordinator started; the visible task owns no project files.",
      nextAction: "Wait for a material worker, integration, blocker, or acceptance transition.",
      data: { maxRounds: config.maxRounds, maxMinutes: config.maxMinutes, noProgressLimit: config.noProgressLimit },
    });
  }
  return { ...args, ...compactCoordinator(args, state), reused: false, noDesktopUiLaunched: true };
}

function roundRecord(args, roundId) {
  return args.portfolioId ? readPortfolioRound(args.portfolioId, roundId) : readRound(args.taskId, roundId);
}

function roundStatuses(args, round) {
  return (round.jobs || []).map((job) => {
    const taskId = job.taskId || args.taskId;
    try { return { ...job, taskId, status: statusFor(taskId, job.jobId) }; }
    catch (error) { return { ...job, taskId, status: { state: "failed", blocker: `worker-record-missing: ${bounded(error.message, 400)}` } }; }
  });
}

function waitForRoundTerminal(args, round, deadline) {
  const initial = roundStatuses(args, round);
  if (!initial.length || initial.every((row) => TERMINAL_STATES.has(row.status.state))) return Promise.resolve({ terminal: true, rows: initial });
  return new Promise((resolve) => {
    const watchers = [];
    let timer = null;
    let fallback = null;
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      for (const watcher of watchers) {
        try { watcher.close(); } catch { /* already closed */ }
      }
      if (timer) clearTimeout(timer);
      if (fallback) clearInterval(fallback);
      resolve(value);
    };
    const inspect = () => {
      let rows;
      try { rows = roundStatuses(args, round); }
      catch { return; }
      if (rows.every((row) => TERMINAL_STATES.has(row.status.state))) finish({ terminal: true, rows });
    };
    for (const row of initial) {
      if (TERMINAL_STATES.has(row.status.state)) continue;
      try {
        const watcher = fs.watch(path.dirname(path.join(target({ taskId: row.taskId }).root, "jobs", row.jobId, "status.json")), { persistent: true }, inspect);
        watcher.on("error", () => { /* bounded deterministic reconciliation below remains authoritative */ });
        watchers.push(watcher);
      } catch { /* bounded deterministic reconciliation below remains authoritative */ }
    }
    fallback = setInterval(inspect, 1000);
    const waitMs = Math.max(1, deadline - Date.now());
    timer = setTimeout(() => {
      const rows = roundStatuses(args, round);
      finish({ terminal: rows.every((row) => TERMINAL_STATES.has(row.status.state)), rows, deadlineReached: true });
    }, waitMs);
  });
}

function progressSignature(summary) {
  if (summary.portfolioId) {
    return JSON.stringify((summary.projects || []).map((project) => ({
      taskId: project.taskId,
      state: project.state,
      passing: project.progress?.passing || 0,
      graph: (project.workGraph || []).map((node) => [node.id, node.state]),
      evidence: (project.requirements || []).reduce((total, row) => total + Number(row.evidenceCount || 0), 0),
    })));
  }
  return JSON.stringify({
    state: summary.state,
    passing: summary.progress?.passing || 0,
    graph: (summary.workGraph || []).map((node) => [node.id, node.state]),
    evidence: (summary.requirements || []).reduce((total, row) => total + Number(row.evidenceCount || 0), 0),
  });
}

function completedEnough(summary) {
  if (summary.state === "completed") return true;
  if (summary.portfolioId) {
    const projectsReady = (summary.projects || []).length > 0 && (summary.projects || []).every((project) => project.state === "completed" || (project.progress?.required > 0 && project.progress.passing === project.progress.required));
    const portfolioRequirementsReady = (summary.portfolioRequirements || []).every((row) => row.status === "passing");
    return summary.completionAllowed === true || (projectsReady && portfolioRequirementsReady);
  }
  return summary.progress?.required > 0 && summary.progress.passing === summary.progress.required;
}

function completionReady(summary) {
  if (!summary.portfolioId) return completedEnough(summary);
  if (completedEnough(summary)) return true;
  return (summary.projects || []).some((project) => project.state !== "completed"
    && Number(project.progress?.required || 0) > 0
    && project.progress.passing === project.progress.required);
}

function workerDetails(results = []) {
  return results.map((row) => ({
    jobId: row.jobId,
    projectId: row.projectId || null,
    provider: row.provider,
    model: row.model,
    state: row.state,
    blocker: bounded(row.blocker, 600),
  }));
}

async function runCoordinator(payload, entrypoint, dependencies = {}) {
  const args = targetArgs(payload);
  const current = readCoordinator(args);
  if (current?.executionId && current.executionId !== payload.executionId) return { ...args, state: "superseded", executionId: payload.executionId };
  const config = coordinatorConfig(payload.config || payload);
  const deadline = Date.now() + config.maxMinutes * 60 * 1000;
  const inventoryFn = dependencies.inventory || inventory;
  const historyFn = dependencies.providerHistory || providerHistory;
  const createJobFn = dependencies.createJob || ((contract) => createJob(contract, entrypoint));
  let state = writeCoordinator(args, { executionId: payload.executionId, state: "running", pid: process.pid, config, startedAt: current?.startedAt || utcNow() });
  let roundsStarted = Number(state.roundsStarted || 0);
  let noProgress = 0;
  const executionRoundIds = new Set(
    current?.executionId === payload.executionId && current.lastRoundId ? [current.lastRoundId] : [],
  );
  let summary = taskSummary(args);
  let signature = progressSignature(summary);
  const failedProviders = new Set();
  let stopReason = "time-limit";

  try {
    while (Date.now() < deadline) {
      const liveState = readCoordinator(args);
      if (liveState?.executionId !== payload.executionId) { stopReason = "superseded"; break; }
      if (liveState?.state === "cancel-requested") { stopReason = "cancelled"; break; }
      summary = taskSummary(args);
      if (completionReady(summary)) {
        const completion = completeTask(args);
        summary = taskSummary(args);
        if (completion.completionAllowed === true) {
          material(args, state, {
            type: "acceptance.completed",
            state: "completed",
            summary: "All required acceptance evidence passed for this target.",
            evidenceRefs: summary.portfolioId
              ? (summary.projects || []).flatMap((project) => (project.requirements || []).flatMap((row) => row.evidenceCount ? [`${project.taskId}:${row.id}`] : [])).slice(0, 12)
              : (summary.requirements || []).filter((row) => row.evidenceCount).map((row) => row.id).slice(0, 12),
          });
          stopReason = "acceptance-complete";
          break;
        }
      }

      const latest = summary.latestRound;
      if (latest && ["running", "ready-for-integration", "needs-correction"].includes(latest.state)) {
        const round = roundRecord(args, latest.roundId);
        if (latest.state === "running") {
          const waited = await waitForRoundTerminal(args, round, deadline);
          if (!waited.terminal) {
            stopReason = "worker-deadline";
            material(args, state, {
              type: "coordinator.stopped",
              state: "blocked",
              roundId: round.roundId,
              summary: "The finite coordinator deadline arrived while a worker still owned the action.",
              blocker: "worker-deadline",
              nextAction: "Reconcile the same durable task after the worker reaches a terminal state; do not duplicate the worker.",
            });
            break;
          }
        }
        const collected = collectRound({ ...args, roundId: latest.roundId, waitSeconds: 0, detail: "full" });
        const belongsToCurrentExecution = executionRoundIds.has(latest.roundId);
        const terminal = (collected.results || []).filter((row) => row.terminal);
        material(args, state, {
          type: "round.collected",
          state: collected.state,
          roundId: latest.roundId,
          summary: `Collected ${terminal.length} terminal worker result(s) exactly once.`,
          data: { workers: workerDetails(terminal) },
        });
        if (belongsToCurrentExecution) {
          for (const row of terminal.filter((item) => item.state !== "completed")) failedProviders.add(String(row.provider || "").toLowerCase());
        }

        const completed = terminal.filter((row) => row.state === "completed");
        if (completed.length) {
          const integrated = integrateRound({ ...args, roundId: latest.roundId });
          const failed = (integrated.integrations || []).filter((row) => row.integrated !== true);
          if (belongsToCurrentExecution) {
            for (const row of failed) {
              const worker = terminal.find((item) => item.jobId === row.jobId);
              failedProviders.add(String(worker?.provider || "").toLowerCase());
            }
          }
          const observations = (integrated.integrations || []).filter((row) => row.observation === true && row.integrated === true);
          const accepted = (integrated.acceptedEvidence || []).length;
          material(args, state, {
            type: "round.integrated",
            state: integrated.state,
            roundId: latest.roundId,
            summary: `Integrated ${Math.max(0, completed.length - observations.length - failed.length)} patch(es), accepted ${observations.length} structured observation(s), and recorded ${accepted} acceptance evidence item(s).`,
            blocker: failed.map((row) => row.blocker).filter(Boolean).join(" | "),
            evidenceRefs: (integrated.acceptedEvidence || []).map((row) => row.ref).filter(Boolean).slice(0, 12),
            data: { observations: observations.map((row) => ({ jobId: row.jobId, createdWorkGraphNodeIds: row.createdWorkGraphNodeIds || [] })) },
          });
        }

        summary = taskSummary(args);
        const nextSignature = progressSignature(summary);
        if (nextSignature !== signature) {
          noProgress = 0;
          signature = nextSignature;
        } else if (belongsToCurrentExecution) {
          noProgress += 1;
        }
        if (noProgress >= config.noProgressLimit) {
          stopReason = "no-progress-limit";
          material(args, state, {
            type: "coordinator.stopped",
            state: "blocked",
            summary: "The configured no-progress limit was reached without stronger acceptance or work-graph evidence.",
            blocker: "no-progress-limit",
            nextAction: "Inspect the typed failure or blocker before any materially changed retry.",
          });
          break;
        }
      }

      summary = taskSummary(args);
      if (completionReady(summary)) continue;
      const execution = summary.portfolioId
        ? (summary.projects || []).find((project) => project.taskId === summary.currentCodex?.taskId)?.execution
        : summary.execution;
      const recommended = summary.portfolioId
        ? (summary.projects || []).flatMap((project) => project.workPlane?.recommendedWorkUnits || [])
        : (summary.workPlane?.recommendedWorkUnits || []);
      if (execution?.userActionRequired) {
        stopReason = "user-decision-required";
        material(args, state, {
          type: "decision.required",
          state: "blocked",
          requirementId: execution.requirementId,
          summary: "A recorded user-owned decision is required; other dependency-ready work is exhausted.",
          blocker: bounded(execution.reason, 1200),
          nextAction: bounded(execution.action, 1200),
        });
        break;
      }
      if (!recommended.length) {
        stopReason = "no-dependency-ready-unit";
        material(args, state, {
          type: "coordinator.stopped",
          state: "blocked",
          summary: "No dependency-ready bounded unit remains for deterministic dispatch.",
          blocker: "no-dependency-ready-unit",
          nextAction: bounded(execution?.action || "Reconcile the project acceptance graph from authoritative evidence.", 1200),
        });
        break;
      }
      if (roundsStarted >= config.maxRounds) { stopReason = "round-limit"; break; }

      const resources = await inventoryFn({ refresh: true, forDispatch: true, horizonHours: config.horizonHours });
      const histories = { ...historyFn() };
      for (const provider of failedProviders) histories[provider] = { ...(histories[provider] || {}), cooledDown: true, cooldownReason: "failed-earlier-in-same-execution" };
      const dispatched = dispatchRound({ ...args, horizonHours: config.horizonHours }, resources, histories, (contract) => {
        if (failedProviders.has(String(contract.provider || "").toLowerCase())) throw new Error("provider-failed-earlier-in-same-execution: unchanged invocation is not retried");
        return createJobFn(contract);
      });
      roundsStarted += 1;
      executionRoundIds.add(dispatched.roundId);
      state = writeCoordinator(args, { executionId: payload.executionId, roundsStarted, lastRoundId: dispatched.roundId });
      material(args, state, {
        type: "round.dispatched",
        state: dispatched.state,
        roundId: dispatched.roundId,
        summary: `Assigned ${(dispatched.workers || []).length} dependency-ready worker(s) after fresh capacity and lease checks.`,
        blocker: (dispatched.rejected || []).map((row) => row.reason).filter(Boolean).join(" | "),
        nextAction: (dispatched.workers || []).length ? "The coordinator is waiting on worker state changes, not polling an LLM." : bounded(dispatched.nextAction, 1200),
        data: { workers: workerDetails(dispatched.workers || []) },
      });
      if (!(dispatched.workers || []).length) {
        const rejectionText = (dispatched.rejected || []).map((row) => row.reason).filter(Boolean).join(" | ");
        if (/missing callable capabilities|visible UI is required|not authorized|authentication-required|not authenticated/i.test(rejectionText)) {
          stopReason = "capability-decision-required";
          material(args, state, {
            type: "decision.required",
            state: "blocked",
            summary: "No authorized callable headless surface satisfies the next unit's capability contract.",
            blocker: bounded(rejectionText, 1600),
            nextAction: "Authorize or connect the named capability once, or revise the unit to a genuinely callable headless surface; AI Mobile will not fake the capability or auto-launch a UI.",
          });
        } else {
          stopReason = "no-eligible-worker";
        }
        break;
      }
    }
  } catch (error) {
    stopReason = "coordinator-failed";
    material(args, state, {
      type: "coordinator.failed",
      state: "failed",
      summary: "The deterministic coordinator stopped on an unexpected invariant violation.",
      blocker: bounded(error.stack || error.message, 1600),
      nextAction: "Repair the recorded invariant before resuming this same durable target.",
    });
  }

  summary = taskSummary(args);
  const finalState = stopReason === "acceptance-complete" ? "completed" : stopReason === "cancelled" ? "cancelled" : stopReason === "coordinator-failed" ? "failed" : "stopped";
  state = writeCoordinator(args, { executionId: payload.executionId, state: finalState, pid: null, finishedAt: utcNow(), stopReason, roundsStarted });
  if (!["acceptance-complete", "coordinator-failed", "no-progress-limit", "no-dependency-ready-unit", "user-decision-required", "capability-decision-required", "worker-deadline"].includes(stopReason)) {
    material(args, state, {
      type: "coordinator.stopped",
      state: finalState,
      summary: `The finite coordinator stopped: ${stopReason}.`,
      blocker: stopReason,
      nextAction: "Resume this same durable target only when capacity, dependency, or project evidence changes.",
    });
  }
  return { ...args, executionId: payload.executionId, state: finalState, stopReason, roundsStarted, progress: summary.progress, completionAllowed: summary.completionAllowed === true };
}

function rawWorker(taskId, job) {
  const status = readJson(path.join(jobDirectory(taskId, job.jobId), "status.json"), {});
  return {
    jobId: job.jobId,
    projectId: job.projectId || null,
    provider: job.provider || status.provider || "",
    model: job.model || status.model || "",
    state: status.state || "unknown",
    goal: bounded(job.goal, 600),
    blocker: bounded(status.blocker, 600),
    startedAt: status.startedAt || null,
    finishedAt: status.finishedAt || null,
  };
}

function dependencyReadyNode(task) {
  const completed = new Set((task.workGraph || []).filter((node) => node.state === "completed").map((node) => node.id));
  return [...(task.workGraph || [])]
    .filter((node) => node.state === "pending" && (node.dependsOn || []).every((id) => completed.has(id)))
    .sort((left, right) => Number(right.priority || 50) - Number(left.priority || 50))[0] || null;
}

function taskMaterialView(task, workers = []) {
  const required = (task.requirements || []).filter((row) => row.required !== false);
  const blocked = required.filter((row) => row.status === "blocked").map((row) => ({ id: row.id, reason: row.blocker?.reason || row.description, owner: row.blocker?.owner || "coordinator", recoveryAction: row.blocker?.recoveryAction || "" }));
  const active = workers.filter((row) => ["queued", "running"].includes(row.state));
  const ready = dependencyReadyNode(task);
  const lastEvidence = (task.evidence || []).at(-1) || null;
  return {
    taskId: task.taskId,
    projectId: task.projectId || null,
    outcome: task.outcome,
    state: task.state,
    progress: { passing: required.filter((row) => row.status === "passing").length, required: required.length },
    workers,
    blocked,
    lastEvidence,
    next: active.length
      ? "Wait for the assigned worker state change; the coordinator owns collection and integration."
      : ready
        ? ready.goal
        : blocked[0]?.recoveryAction || "No dependency-ready unit is recorded.",
    capacitySnapshot: task.capacitySnapshot || null,
  };
}

function materialView(input) {
  if (input.portfolioId) {
    const portfolio = readPortfolio(input.portfolioId);
    const latestRef = (portfolio.rounds || []).at(-1);
    const round = latestRef ? readPortfolioRound(portfolio.portfolioId, latestRef.roundId) : null;
    const projects = (portfolio.projects || []).map((project) => {
      const task = readTask(project.taskId);
      const workers = (round?.jobs || []).filter((job) => job.taskId === task.taskId).map((job) => rawWorker(task.taskId, job));
      return taskMaterialView(task, workers);
    });
    return {
      outcome: portfolio.outcome,
      state: portfolio.state,
      progress: { completedProjects: projects.filter((project) => project.state === "completed").length, requiredProjects: projects.length },
      projects,
      blocked: projects.flatMap((project) => project.blocked.map((blocker) => ({ projectId: project.projectId, ...blocker }))),
      resources: portfolio.capacitySnapshot || null,
      next: projects.filter((project) => project.state !== "completed").sort((left, right) => {
        const leftPriority = Number(portfolio.projects.find((row) => row.taskId === left.taskId)?.priority || 50);
        const rightPriority = Number(portfolio.projects.find((row) => row.taskId === right.taskId)?.priority || 50);
        return rightPriority - leftPriority;
      })[0]?.next || "No unfinished project remains.",
    };
  }
  const task = readTask(input.taskId);
  const latestRef = (task.rounds || []).at(-1);
  const round = latestRef ? readRound(task.taskId, latestRef.roundId) : null;
  const workers = (round?.jobs || []).map((job) => rawWorker(task.taskId, job));
  const view = taskMaterialView(task, workers);
  return { ...view, resources: view.capacitySnapshot };
}

function requestCoordinatorCancel(input = {}) {
  const args = targetArgs(input);
  const current = readCoordinator(args);
  if (!current || current.state !== "running") return { requested: false, state: current?.state || "not-started" };
  const next = writeCoordinator(args, { state: "cancel-requested", cancelRequestedAt: utcNow() });
  appendMaterialEvent(args, {
    type: "coordinator.cancel-requested",
    state: "cancel-requested",
    executionId: next.executionId,
    summary: "Cancellation was requested; active finite workers are being cancelled by the task lifecycle.",
  });
  return { requested: true, executionId: next.executionId, state: next.state };
}

function coordinatorStatus(input = {}) {
  const args = targetArgs(input);
  return {
    ...args,
    execution: compactCoordinator(args),
    status: materialView(args),
    material: readMaterialEvents({ ...args, maxEvents: input.maxEvents || 8 }),
    passive: true,
    noProviderProbe: true,
    noProjectScan: true,
  };
}

module.exports = {
  compactCoordinator,
  coordinatorConfig,
  coordinatorStatus,
  materialView,
  readCoordinator,
  requestCoordinatorCancel,
  runCoordinator,
  startCoordinator,
  waitForRoundTerminal,
};