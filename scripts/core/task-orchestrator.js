"use strict";

const { boundariesOverlap, goalOverlap } = require("./lane-policy");
const { route } = require("./router");
const { cancelTaskJobs, readJob, statusFor, TERMINAL_STATES } = require("./job-store");
const { resourceLeaseSnapshot } = require("./resource-leases");
const {
  createPortfolioRecord,
  createPortfolioRoundRecord,
  createRoundRecord,
  createTaskRecord,
  readPortfolio,
  readPortfolioRound,
  readRound,
  readTask,
  updatePortfolio,
  updatePortfolioRound,
  updateRound,
  updateTask,
} = require("./state-store");
const { readProfile } = require("../lib/orchestrator-profile");
const { boundedList, utcNow } = require("./utils");

const EVIDENCE_RANK = { activity: 0, "process-health": 1, "focused-test": 2, integration: 3, "end-to-end": 4, "user-visible": 5 };

function finite(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function compactCapacity(resources) {
  return Object.fromEntries(Object.entries(resources.providers || {}).map(([id, provider]) => [id, {
    available: provider.available === true,
    authenticated: provider.authenticated === true,
    authMode: provider.authMode || "unknown",
    confidence: provider.confidence || "unknown",
    observedAt: provider.observedAt || null,
    expiresAt: provider.expiresAt || null,
    cached: provider.cached === true,
    models: (provider.models || []).slice(0, 12).map((model) => model.id || model.displayName).filter(Boolean),
    quotaPools: (provider.quotaPools || []).slice(0, 12).map((pool) => ({
      id: pool.id,
      scope: pool.scope,
      period: pool.period,
      remainingPercent: finite(pool.remainingPercent),
      resetAt: pool.resetAt || null,
    })),
    remainingPercent: finite(provider.capacity?.effectiveRemainingPercent ?? provider.capacity?.remainingPercent),
    source: provider.capacity?.source || "unknown",
    reason: provider.reason || "",
  }]));
}

function compactResources(resources) {
  return {
    generatedAt: resources.generatedAt,
    machine: resources.machine || null,
    providers: compactCapacity(resources),
  };
}

function cleanStrings(values, maxItems, maxChars) {
  return boundedList(values, maxItems, maxChars);
}

function requirementRows(values, defaultLevel = "end-to-end") {
  if (!Array.isArray(values) || !values.length) throw new Error("At least one positive acceptanceEvidence item is required.");
  return values.slice(0, 12).map((value, index) => {
    const item = typeof value === "string" ? { description: value } : value || {};
    const description = String(item.description || "").trim().slice(0, 1200);
    if (!description) throw new Error(`acceptanceEvidence[${index}] requires a description.`);
    if (/\bor\s+(?:blocked|a blocker|unavailable)\b|\bif available\b|\bwhen eligible\b/i.test(description)) {
      throw new Error("Acceptance evidence must describe positive observable proof, not an escape condition.");
    }
    const minimumEvidenceLevel = EVIDENCE_RANK[item.minimumEvidenceLevel] === undefined ? defaultLevel : item.minimumEvidenceLevel;
    return { id: `A${index + 1}`, description, required: item.required !== false, status: "failing", minimumEvidenceLevel, evidence: [] };
  });
}

function normalizeProjectId(value, index, seen) {
  const base = String(value || `project-${index + 1}`).trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || `project-${index + 1}`;
  if (seen.has(base)) throw new Error(`Duplicate portfolio projectId: ${base}`);
  seen.add(base);
  return base;
}

function normalizeBlockers(values) {
  return (Array.isArray(values) ? values : []).slice(0, 20).map((value, index) => {
    const row = typeof value === "string" ? { description: value } : value || {};
    return {
      id: String(row.id || `B${index + 1}`).slice(0, 80),
      description: String(row.description || "").trim().slice(0, 1000),
      resolved: row.resolved === true,
    };
  }).filter((row) => row.description);
}

function normalizeWorkGraph(values) {
  const seen = new Set();
  return (Array.isArray(values) ? values : []).slice(0, 100).map((value, index) => {
    const row = value || {};
    const id = String(row.id || `W${index + 1}`).trim().replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 80);
    if (!id || seen.has(id)) throw new Error(`Portfolio workGraph requires unique node ids; duplicate or invalid id: ${id || index}.`);
    seen.add(id);
    return {
      id,
      goal: String(row.goal || "").trim().slice(0, 2000),
      dependsOn: cleanStrings(row.dependsOn, 20, 80),
      priority: Math.max(1, Math.min(100, Number(row.priority || 50))),
      state: ["pending", "running", "awaiting-evidence", "completed", "blocked"].includes(row.state) ? row.state : "pending",
      owner: row.owner || null,
      evidenceRefs: [],
    };
  });
}

function projectBlocked(project) {
  return (project.blockers || []).some((blocker) => blocker.resolved !== true);
}

function highestValueReadyProject(portfolio) {
  return [...(portfolio.projects || [])]
    .filter((project) => project.state === "active" && !projectBlocked(project))
    .sort((left, right) => Number(right.priority || 50) - Number(left.priority || 50) || String(left.projectId).localeCompare(String(right.projectId)))[0] || null;
}

function startSingleTask(args, resources, portfolioContext = {}) {
  const outcome = String(args.outcome || "").trim().slice(0, 6000);
  if (!outcome) throw new Error("outcome is required.");
  const defaultLevel = EVIDENCE_RANK[args.minimumEvidenceLevel] === undefined ? "end-to-end" : args.minimumEvidenceLevel;
  const requirements = requirementRows(args.acceptanceEvidence, defaultLevel);
  const record = createTaskRecord({
    workspace: args.workspace,
    outcome,
    requirements,
    constraints: cleanStrings(args.constraints, 12, 1000),
    blockers: normalizeBlockers(args.blockers),
    workGraph: normalizeWorkGraph(args.workGraph),
    priority: Math.max(1, Math.min(100, Number(args.priority || 50))),
    portfolioId: portfolioContext.portfolioId || null,
    projectId: portfolioContext.projectId || null,
    currentCodex: {
      model: String(args.currentCodexModel || "").trim().slice(0, 160),
      reservePercent: Math.max(5, Math.min(50, Number(args.codexReservePercent || 15))),
      goal: "Inspect the project and choose the smallest acceptance-linked critical path before proposing external work.",
      files: [],
    },
    capacitySnapshot: compactResources(resources),
  });
  return record;
}

function startPortfolio(args, resources) {
  const outcome = String(args.outcome || "").trim().slice(0, 6000);
  if (!outcome) throw new Error("A portfolio outcome is required.");
  const inputProjects = Array.isArray(args.projects) ? args.projects.slice(0, 20) : [];
  if (inputProjects.length < 2) throw new Error("A portfolio requires at least two separate project entries.");
  const profile = readProfile();
  const provisional = createPortfolioRecord({
    outcome,
    requirements: Array.isArray(args.acceptanceEvidence) && args.acceptanceEvidence.length ? requirementRows(args.acceptanceEvidence) : [],
    projects: [],
    capacitySnapshot: compactResources(resources),
    currentCodex: {},
    allocationPolicy: {
      horizonHours: Math.max(1, Math.min(24, Number(args.horizonHours || 5))),
      maxGlobalWorkers: profile.maxGlobalWorkers,
      maxWorkersPerProvider: profile.maxWorkersPerProvider,
      codexReservePercent: Math.max(5, Math.min(50, Number(args.codexReservePercent || profile.codexReservePercent))),
      fairness: "priority-first round-robin across ready projects; older grants win ties",
    },
  });
  const seen = new Set();
  const projects = [];
  try {
    for (let index = 0; index < inputProjects.length; index += 1) {
      const input = inputProjects[index] || {};
      const projectId = normalizeProjectId(input.projectId, index, seen);
      const task = startSingleTask({
        ...input,
        codexReservePercent: args.codexReservePercent,
        currentCodexModel: args.currentCodexModel,
      }, resources, { portfolioId: provisional.portfolioId, projectId });
      projects.push({
        projectId,
        taskId: task.taskId,
        workspace: task.workspace,
        outcome: task.outcome,
        requirements: task.requirements.map(({ id, description, minimumEvidenceLevel, required }) => ({ id, description, minimumEvidenceLevel, required })),
        priority: task.priority,
        blockers: task.blockers,
        workGraph: task.workGraph,
        state: task.state,
        lastGrantedAt: null,
      });
    }
  } catch (error) {
    for (const project of projects) updateTask(project.taskId, (task) => ({ ...task, state: "cancelled", cancelledAt: utcNow(), blocker: "Portfolio creation failed before dispatch." }));
    updatePortfolio(provisional.portfolioId, (portfolio) => ({ ...portfolio, state: "invalid", blocker: error.message }));
    throw error;
  }
  const current = highestValueReadyProject({ projects });
  const portfolio = updatePortfolio(provisional.portfolioId, (record) => ({
    ...record,
    projects,
    currentCodex: current ? {
      projectId: current.projectId,
      taskId: current.taskId,
      goal: "Inspect this highest-priority ready project and advance its smallest acceptance-linked critical path.",
      files: [],
    } : {},
  }));
  return {
    portfolioId: portfolio.portfolioId,
    state: portfolio.state,
    outcome: portfolio.outcome,
    projects: portfolio.projects.map((project) => ({ projectId: project.projectId, taskId: project.taskId, workspace: project.workspace, outcome: project.outcome, priority: project.priority, blockers: project.blockers, requirements: project.requirements, workGraph: project.workGraph })),
    capacity: portfolio.capacitySnapshot,
    currentCodex: portfolio.currentCodex,
    nextAction: "Current Codex should inspect and actively advance the recommended project. Dispatch a finite round only for dependency-ready work that is disjoint and cheaper on another available CLI.",
    reportingRule: "Report only assignments, accepted project evidence, a real blocker, or the next material action. Do not create a Goal, manager loop, heartbeat, automation, UI launch, or status feed.",
  };
}

function startTask(args, resources) {
  if (Array.isArray(args.projects) && args.projects.length) return startPortfolio(args, resources);
  const record = startSingleTask(args, resources);
  return {
    taskId: record.taskId,
    state: record.state,
    outcome: record.outcome,
    requirements: record.requirements.map(({ id, description, minimumEvidenceLevel }) => ({ id, description, minimumEvidenceLevel })),
    capacity: record.capacitySnapshot,
    currentCodex: record.currentCodex,
    nextAction: "Current Codex should inspect the minimum authoritative project state, define its own critical-path unit, then call dispatch-round only for genuinely independent bounded work. Small or overlapping work stays direct.",
    reportingRule: "Report only assignments, accepted evidence, a real blocker, or the next material action. Do not create a Goal, manager loop, heartbeat, automation, or status feed.",
  };
}

function terminalRoundState(rows) {
  if (!rows.length) return "direct";
  if (!rows.every((row) => TERMINAL_STATES.has(row.state))) return "running";
  return rows.every((row) => row.state === "completed") ? "ready-for-integration" : "needs-correction";
}

function quotaPoolIds(providerId, provider, model) {
  const modelText = String(model || "").toLowerCase();
  const selected = (provider?.quotaPools || []).filter((pool) => {
    const scope = String(pool.scope || "all").toLowerCase();
    return ["all", "shared", "global"].includes(scope) || !modelText || modelText.includes(scope) || scope.includes(modelText);
  });
  const rows = selected.length ? selected : (provider?.quotaPools || []);
  return [...new Set(rows.map((pool) => `${providerId}:${pool.id}`))];
}

function dispatchSingleRound(args, resources, histories, createJob) {
  const task = readTask(args.taskId);
  if (task.state !== "active") throw new Error(`Task ${task.taskId} is ${task.state}; it cannot dispatch another round.`);
  const previousRoundRef = (task.rounds || []).at(-1);
  if (previousRoundRef) {
    const previous = readRound(task.taskId, previousRoundRef.roundId);
    if (previous.state === "running") throw new Error(`Round ${previous.roundId} is still running. Collect it at the integration point instead of creating duplicate work.`);
  }
  const currentCodex = args.currentCodex || {};
  const currentGoal = String(currentCodex.goal || "").trim().slice(0, 5000);
  if (!currentGoal) throw new Error("currentCodex.goal is required after project reconnaissance.");
  const currentFiles = cleanStrings(currentCodex.files, 80, 500);
  const workUnits = Array.isArray(args.workUnits) ? args.workUnits.slice(0, 2) : [];
  const round = createRoundRecord(task.taskId, {
    state: "planning",
    currentCodex: { goal: currentGoal, files: currentFiles, acceptanceCriteria: cleanStrings(currentCodex.acceptanceCriteria, 12, 1000) },
    jobs: [],
    rejected: [],
    capacitySnapshot: compactResources(resources),
  });
  const jobs = [];
  const rejected = [];
  const workerOwners = [];
  for (const unit of workUnits) {
    const unitGoal = String(unit.goal || "").trim();
    if (!unitGoal) { rejected.push({ goal: "", reason: "Work unit requires a bounded goal." }); continue; }
    const unitFiles = cleanStrings([...(unit.relevantFiles || []), ...(unit.expectedFiles || [])], 100, 500);
    const workerConflict = workerOwners.find((owner) => boundariesOverlap(unitFiles, owner.files).length || goalOverlap(unitGoal, owner.goal).overlaps);
    if (workerConflict) { rejected.push({ goal: unitGoal, reason: `This unit overlaps another unit in the same round (${workerConflict.goal}); serialize it in current Codex.` }); continue; }
    let decision;
    try {
      decision = route({ ...unit, workspace: task.workspace, projectGoal: task.outcome, goal: unitGoal, currentCodexGoal: currentGoal, currentCodexFiles: currentFiles, horizonHours: args.horizonHours || 5 }, resources, histories);
    } catch (error) { rejected.push({ goal: unitGoal, reason: error.message }); continue; }
    if (decision.action !== "delegate") { rejected.push({ goal: unitGoal, reason: decision.reason, economics: decision.economics || null, considered: decision.considered || [] }); continue; }
    try {
      const selected = resources.providers[decision.provider];
      const receipt = createJob({
        ...decision.request,
        taskId: task.taskId,
        roundId: round.roundId,
        completionEvidence: task.requirements.map((item) => item.description),
        workspace: task.workspace,
        provider: decision.provider,
        providerCommand: selected.command,
        providerAuthMode: selected.authMode || "unknown",
        quotaPoolIds: quotaPoolIds(decision.provider, selected, decision.request.model),
        fairnessKey: task.taskId,
      });
      jobs.push({ ...receipt, goal: unitGoal, reason: decision.reason, economics: decision.economics, integrationAction: decision.request.integrationAction || "" });
      workerOwners.push({ goal: unitGoal, files: unitFiles });
    } catch (error) { rejected.push({ goal: unitGoal, reason: error.message, considered: decision.considered || [] }); }
  }
  const state = jobs.length ? "running" : "direct";
  updateRound(task.taskId, round.roundId, { state, jobs, rejected });
  updateTask(task.taskId, (current) => {
    current.currentCodex = { ...current.currentCodex, goal: currentGoal, files: currentFiles, acceptanceCriteria: cleanStrings(currentCodex.acceptanceCriteria, 12, 1000), updatedAt: utcNow() };
    current.capacitySnapshot = compactResources(resources);
    return current;
  });
  return {
    taskId: task.taskId,
    roundId: round.roundId,
    state,
    currentCodex: { goal: currentGoal, files: currentFiles, instruction: "Start or continue this critical-path unit now; do not wait for workers." },
    workers: jobs,
    rejected,
    nextAction: jobs.length ? "Continue current Codex work and collect this round once at the natural integration point." : "No worker passed independence and economic gates. Current Codex should do the next dependency-ready work directly.",
  };
}

function graphNodeReady(project, nodeId) {
  if (!nodeId) return true;
  const node = (project.workGraph || []).find((row) => row.id === nodeId);
  if (!node) return false;
  const completed = new Set((project.workGraph || []).filter((row) => row.state === "completed").map((row) => row.id));
  return node.state === "pending" && (node.dependsOn || []).every((dependency) => completed.has(dependency));
}

function portfolioCandidateOrder(units, portfolio, fairness) {
  const byProject = new Map();
  for (const unit of units) {
    const project = portfolio.projects.find((row) => row.projectId === unit.projectId);
    if (!project) continue;
    if (!byProject.has(project.projectId)) byProject.set(project.projectId, []);
    byProject.get(project.projectId).push({ unit, project });
  }
  for (const rows of byProject.values()) rows.sort((left, right) => Number(right.unit.priority || 50) - Number(left.unit.priority || 50));
  const projectRows = [...byProject.entries()].sort((left, right) => {
    const leftProject = left[1][0].project;
    const rightProject = right[1][0].project;
    const priority = Number(rightProject.priority || 50) - Number(leftProject.priority || 50);
    if (priority) return priority;
    const leftGrant = Date.parse(fairness[`${portfolio.portfolioId}:${leftProject.projectId}`] || "") || 0;
    const rightGrant = Date.parse(fairness[`${portfolio.portfolioId}:${rightProject.projectId}`] || "") || 0;
    return leftGrant - rightGrant;
  });
  const ordered = [];
  let remaining = true;
  for (let pass = 0; remaining; pass += 1) {
    remaining = false;
    for (const [, rows] of projectRows) {
      if (rows[pass]) { ordered.push(rows[pass]); remaining = true; }
    }
  }
  return ordered;
}

function dispatchPortfolioRound(args, resources, histories, createJob) {
  const portfolio = readPortfolio(args.portfolioId);
  if (portfolio.state !== "active") throw new Error(`Portfolio ${portfolio.portfolioId} is ${portfolio.state}; it cannot dispatch another round.`);
  const previousRoundRef = (portfolio.rounds || []).at(-1);
  if (previousRoundRef) {
    const previous = readPortfolioRound(portfolio.portfolioId, previousRoundRef.roundId);
    if (previous.state === "running") throw new Error(`Portfolio round ${previous.roundId} is still running. Collect it once at the integration point.`);
  }
  const recommended = highestValueReadyProject(portfolio);
  if (!recommended) throw new Error("No unblocked active portfolio project is ready for current Codex.");
  const currentCodex = args.currentCodex || {};
  const currentProjectId = String(currentCodex.projectId || recommended.projectId);
  if (currentProjectId !== recommended.projectId && !String(currentCodex.priorityOverrideReason || "").trim()) {
    throw new Error(`Current Codex must advance highest-value ready project ${recommended.projectId}; provide a concrete priorityOverrideReason only when new evidence changes that choice.`);
  }
  const currentProject = portfolio.projects.find((project) => project.projectId === currentProjectId);
  if (!currentProject || currentProject.state !== "active" || projectBlocked(currentProject)) throw new Error(`Current Codex project is not ready: ${currentProjectId}.`);
  const currentGoal = String(currentCodex.goal || "").trim().slice(0, 5000);
  if (!currentGoal) throw new Error("currentCodex.goal is required after reconnaissance of the selected portfolio project.");
  const currentFiles = cleanStrings(currentCodex.files, 80, 500);
  const round = createPortfolioRoundRecord(portfolio.portfolioId, {
    state: "planning",
    currentCodex: { projectId: currentProjectId, taskId: currentProject.taskId, goal: currentGoal, files: currentFiles, acceptanceCriteria: cleanStrings(currentCodex.acceptanceCriteria, 12, 1000) },
    jobs: [],
    rejected: [],
    capacitySnapshot: compactResources(resources),
  });
  const leaseState = resourceLeaseSnapshot();
  const profile = readProfile();
  const availableSlots = Math.max(0, profile.maxGlobalWorkers - leaseState.active.length);
  const requested = Array.isArray(args.workUnits) ? args.workUnits.slice(0, 40) : [];
  const ordered = portfolioCandidateOrder(requested, portfolio, leaseState.fairness);
  const jobs = [];
  const rejected = [];
  const workerOwners = [];
  for (const candidate of ordered) {
    const unit = candidate.unit;
    const project = candidate.project;
    const unitGoal = String(unit.goal || "").trim();
    if (jobs.length >= availableSlots) { rejected.push({ projectId: project.projectId, goal: unitGoal, reason: "Held for a later finite round by the machine-wide worker limit and portfolio fairness policy." }); continue; }
    if (!unitGoal) { rejected.push({ projectId: project.projectId, goal: "", reason: "Work unit requires a bounded goal." }); continue; }
    if (project.state !== "active" || projectBlocked(project)) { rejected.push({ projectId: project.projectId, goal: unitGoal, reason: "Project is blocked or not active; another ready project may continue." }); continue; }
    if (!graphNodeReady(project, unit.workGraphNodeId)) { rejected.push({ projectId: project.projectId, goal: unitGoal, reason: `Work graph node is missing, already owned, or has incomplete dependencies: ${unit.workGraphNodeId}.` }); continue; }
    const unitFiles = cleanStrings([...(unit.relevantFiles || []), ...(unit.expectedFiles || [])], 100, 500);
    const conflict = workerOwners.find((owner) => owner.workspace.toLowerCase() === project.workspace.toLowerCase() && (boundariesOverlap(unitFiles, owner.files).length || goalOverlap(unitGoal, owner.goal).overlaps));
    if (conflict) { rejected.push({ projectId: project.projectId, goal: unitGoal, reason: `Worker ownership overlaps ${conflict.projectId}; serialize this unit.` }); continue; }
    let decision;
    try {
      decision = route({
        ...unit,
        workspace: project.workspace,
        projectGoal: project.outcome,
        goal: unitGoal,
        currentCodexGoal: currentGoal,
        currentCodexFiles: project.projectId === currentProjectId ? currentFiles : [],
        currentCodexReserved: unit.currentCodexReserved === true,
        horizonHours: args.horizonHours || portfolio.allocationPolicy.horizonHours || 5,
        projectId: project.projectId,
      }, resources, histories);
    } catch (error) { rejected.push({ projectId: project.projectId, goal: unitGoal, reason: error.message }); continue; }
    if (decision.action !== "delegate") { rejected.push({ projectId: project.projectId, goal: unitGoal, reason: decision.reason, economics: decision.economics || null, considered: decision.considered || [] }); continue; }
    try {
      const selected = resources.providers[decision.provider];
      const task = readTask(project.taskId);
      const receipt = createJob({
        ...decision.request,
        portfolioId: portfolio.portfolioId,
        projectId: project.projectId,
        taskId: project.taskId,
        roundId: round.roundId,
        workGraphNodeId: unit.workGraphNodeId || null,
        completionEvidence: task.requirements.map((item) => item.description),
        workspace: project.workspace,
        provider: decision.provider,
        providerCommand: selected.command,
        providerAuthMode: selected.authMode || "unknown",
        quotaPoolIds: quotaPoolIds(decision.provider, selected, decision.request.model),
        fairnessKey: `${portfolio.portfolioId}:${project.projectId}`,
      });
      jobs.push({ ...receipt, projectId: project.projectId, taskId: project.taskId, workGraphNodeId: unit.workGraphNodeId || null, goal: unitGoal, reason: decision.reason, economics: decision.economics, integrationAction: decision.request.integrationAction || "" });
      workerOwners.push({ projectId: project.projectId, workspace: project.workspace, goal: unitGoal, files: unitFiles });
    } catch (error) { rejected.push({ projectId: project.projectId, goal: unitGoal, reason: error.message, considered: decision.considered || [] }); }
  }
  const state = jobs.length ? "running" : "direct";
  updatePortfolioRound(portfolio.portfolioId, round.roundId, { state, jobs, rejected });
  updatePortfolio(portfolio.portfolioId, (current) => {
    current.currentCodex = { projectId: currentProjectId, taskId: currentProject.taskId, goal: currentGoal, files: currentFiles, acceptanceCriteria: cleanStrings(currentCodex.acceptanceCriteria, 12, 1000), updatedAt: utcNow() };
    current.projects = current.projects.map((project) => {
      const owned = jobs.filter((job) => job.projectId === project.projectId);
      if (!owned.length) return project;
      const graph = (project.workGraph || []).map((node) => {
        const job = owned.find((row) => row.workGraphNodeId === node.id);
        return job ? { ...node, state: "running", owner: { type: "worker", jobId: job.jobId, provider: job.provider } } : node;
      });
      return { ...project, workGraph: graph, lastGrantedAt: utcNow() };
    });
    return current;
  });
  for (const project of portfolio.projects) {
    const owned = jobs.filter((job) => job.projectId === project.projectId);
    if (!owned.length) continue;
    updateTask(project.taskId, (task) => {
      task.workGraph = (task.workGraph || []).map((node) => {
        const job = owned.find((row) => row.workGraphNodeId === node.id);
        return job ? { ...node, state: "running", owner: { type: "worker", jobId: job.jobId, provider: job.provider } } : node;
      });
      return task;
    });
  }
  updateTask(currentProject.taskId, (task) => {
    task.currentCodex = { ...task.currentCodex, goal: currentGoal, files: currentFiles, updatedAt: utcNow() };
    return task;
  });
  return {
    portfolioId: portfolio.portfolioId,
    roundId: round.roundId,
    state,
    currentCodex: { projectId: currentProjectId, taskId: currentProject.taskId, goal: currentGoal, files: currentFiles, instruction: "Advance this highest-value critical path now; do not wait for workers." },
    workers: jobs,
    rejected,
    nextAction: jobs.length ? "Continue current Codex work. Collect this portfolio round once at the natural integration point." : "No worker passed current global, dependency, independence, and economic gates. Continue the highest-value ready work directly.",
  };
}

function dispatchRound(args, resources, histories, createJob) {
  return args.portfolioId ? dispatchPortfolioRound(args, resources, histories, createJob) : dispatchSingleRound(args, resources, histories, createJob);
}

function collectSingleRound(args) {
  const task = readTask(args.taskId);
  const round = readRound(task.taskId, args.roundId);
  const results = (round.jobs || []).map((job) => readJob(task.taskId, job.jobId, args.detail || "compact", Number(args.waitSeconds || 0)));
  const state = terminalRoundState(results);
  updateRound(task.taskId, round.roundId, { state, collectedAt: results.every((row) => row.terminal) ? utcNow() : null });
  return { taskId: task.taskId, roundId: round.roundId, state, results, nextAction: state === "running" ? "Continue current Codex work; collect again only after a material transition or at integration." : "Integrate each useful handoff once, run deterministic checks, then record only acceptance-linked evidence." };
}

function collectPortfolioRound(args) {
  const portfolio = readPortfolio(args.portfolioId);
  const round = readPortfolioRound(portfolio.portfolioId, args.roundId);
  const results = (round.jobs || []).map((job) => ({ projectId: job.projectId, ...readJob(job.taskId, job.jobId, args.detail || "compact", Number(args.waitSeconds || 0)) }));
  const state = terminalRoundState(results);
  updatePortfolioRound(portfolio.portfolioId, round.roundId, { state, collectedAt: results.every((row) => row.terminal) ? utcNow() : null });
  updatePortfolio(portfolio.portfolioId, (current) => {
    current.projects = current.projects.map((project) => {
      const owned = results.filter((result) => result.projectId === project.projectId);
      if (!owned.length) return project;
      return {
        ...project,
        workGraph: (project.workGraph || []).map((node) => {
          const result = owned.find((row) => round.jobs.find((job) => job.jobId === row.jobId)?.workGraphNodeId === node.id);
          if (!result) return node;
          return { ...node, state: result.state === "completed" ? "awaiting-evidence" : "blocked", owner: null };
        }),
      };
    });
    return current;
  });
  for (const project of portfolio.projects) {
    const owned = results.filter((result) => result.projectId === project.projectId);
    if (!owned.length) continue;
    updateTask(project.taskId, (task) => {
      task.workGraph = (task.workGraph || []).map((node) => {
        const result = owned.find((row) => round.jobs.find((job) => job.jobId === row.jobId)?.workGraphNodeId === node.id);
        if (!result) return node;
        return { ...node, state: result.state === "completed" ? "awaiting-evidence" : "blocked", owner: null };
      });
      return task;
    });
  }
  return { portfolioId: portfolio.portfolioId, roundId: round.roundId, state, results, nextAction: state === "running" ? "Continue current Codex work; collect again only after a material transition or at integration." : "Integrate each accepted project handoff once and record evidence only against that project's requirements." };
}

function collectRound(args) {
  return args.portfolioId ? collectPortfolioRound(args) : collectSingleRound(args);
}

function recordTaskEvidence(taskId, entries) {
  return updateTask(taskId, (task) => {
    for (const entry of entries) {
      const requirement = task.requirements.find((item) => item.id === entry.requirementId);
      if (!requirement) throw new Error(`Unknown requirement: ${entry.requirementId}`);
      const level = String(entry.level || "");
      if (EVIDENCE_RANK[level] === undefined) throw new Error(`Invalid evidence level: ${level}`);
      const evidence = { level, ref: String(entry.ref || "").trim().slice(0, 1000), summary: String(entry.summary || "").trim().slice(0, 1200), verifiedAt: utcNow() };
      if (!evidence.ref || !evidence.summary) throw new Error("Evidence requires ref and summary.");
      requirement.evidence = [...(requirement.evidence || []), evidence].slice(-10);
      if (entry.passed === true) {
        if (EVIDENCE_RANK[level] < EVIDENCE_RANK[requirement.minimumEvidenceLevel]) throw new Error(`${requirement.id} requires ${requirement.minimumEvidenceLevel} evidence; ${level} is insufficient.`);
        requirement.status = "passing";
      }
      task.evidence = [...(task.evidence || []), { requirementId: requirement.id, ...evidence }].slice(-50);
      if (entry.workGraphNodeId) {
        task.workGraph = (task.workGraph || []).map((node) => node.id === entry.workGraphNodeId && entry.passed === true ? { ...node, state: "completed", evidenceRefs: [...(node.evidenceRefs || []), evidence.ref].slice(-10) } : node);
      }
    }
    return task;
  });
}

function recordEvidence(args) {
  const entries = Array.isArray(args.evidence) ? args.evidence : [];
  if (!entries.length) throw new Error("At least one evidence entry is required.");
  if (!args.portfolioId) {
    const updated = recordTaskEvidence(args.taskId, entries);
    return taskSummary({ taskId: updated.taskId });
  }
  const portfolio = readPortfolio(args.portfolioId);
  const portfolioEntries = entries.filter((entry) => !entry.projectId);
  if (portfolioEntries.length) {
    updatePortfolio(portfolio.portfolioId, (current) => {
      for (const entry of portfolioEntries) {
        const requirement = (current.requirements || []).find((item) => item.id === entry.requirementId);
        if (!requirement) throw new Error(`Unknown portfolio requirement: ${entry.requirementId}`);
        const level = String(entry.level || "");
        if (EVIDENCE_RANK[level] === undefined) throw new Error(`Invalid evidence level: ${level}`);
        const evidence = { level, ref: String(entry.ref || "").trim().slice(0, 1000), summary: String(entry.summary || "").trim().slice(0, 1200), verifiedAt: utcNow() };
        if (!evidence.ref || !evidence.summary) throw new Error("Evidence requires ref and summary.");
        requirement.evidence = [...(requirement.evidence || []), evidence].slice(-10);
        if (entry.passed === true) {
          if (EVIDENCE_RANK[level] < EVIDENCE_RANK[requirement.minimumEvidenceLevel]) throw new Error(`${requirement.id} requires ${requirement.minimumEvidenceLevel} evidence; ${level} is insufficient.`);
          requirement.status = "passing";
        }
        current.evidence = [...(current.evidence || []), { requirementId: requirement.id, ...evidence }].slice(-50);
      }
      return current;
    });
  }
  const grouped = new Map();
  for (const entry of entries.filter((row) => row.projectId)) {
    const project = portfolio.projects.find((row) => row.projectId === entry.projectId);
    if (!project) throw new Error(`Unknown portfolio projectId: ${entry.projectId}`);
    if (!grouped.has(project.taskId)) grouped.set(project.taskId, []);
    grouped.get(project.taskId).push(entry);
  }
  for (const [taskId, rows] of grouped) recordTaskEvidence(taskId, rows);
  updatePortfolio(portfolio.portfolioId, (current) => {
    current.projects = current.projects.map((project) => {
      const task = readTask(project.taskId);
      return { ...project, requirements: task.requirements, workGraph: task.workGraph, evidenceCount: (task.evidence || []).length };
    });
    return current;
  });
  return taskSummary({ portfolioId: portfolio.portfolioId });
}

function singleTaskSummary(task) {
  const lastRoundRef = (task.rounds || []).at(-1);
  const lastRound = lastRoundRef ? readRound(task.taskId, lastRoundRef.roundId) : null;
  const requirements = task.requirements.map((item) => ({ id: item.id, description: item.description, status: item.status, minimumEvidenceLevel: item.minimumEvidenceLevel, evidenceCount: (item.evidence || []).length }));
  return {
    taskId: task.taskId,
    projectId: task.projectId || null,
    state: task.state,
    outcome: task.outcome,
    blockers: task.blockers || [],
    workGraph: task.workGraph || [],
    progress: { passing: requirements.filter((item) => item.status === "passing").length, required: requirements.filter((item) => item.required).length },
    requirements,
    currentCodex: task.currentCodex,
    latestRound: lastRound ? { roundId: lastRound.roundId, state: lastRound.state, workers: (lastRound.jobs || []).map((job) => ({ jobId: job.jobId, provider: job.provider, model: job.model, goal: job.goal })) } : null,
    completionAllowed: task.state === "completed",
  };
}

function taskSummary(args) {
  if (!args.portfolioId) return singleTaskSummary(readTask(args.taskId));
  const portfolio = readPortfolio(args.portfolioId);
  const projects = portfolio.projects.map((project) => singleTaskSummary(readTask(project.taskId)));
  const latestRef = (portfolio.rounds || []).at(-1);
  const latest = latestRef ? readPortfolioRound(portfolio.portfolioId, latestRef.roundId) : null;
  return {
    portfolioId: portfolio.portfolioId,
    state: portfolio.state,
    outcome: portfolio.outcome,
    capacity: portfolio.capacitySnapshot,
    allocationPolicy: portfolio.allocationPolicy,
    currentCodex: portfolio.currentCodex,
    progress: { completedProjects: projects.filter((project) => project.state === "completed").length, requiredProjects: projects.length },
    portfolioRequirements: (portfolio.requirements || []).map((item) => ({ id: item.id, description: item.description, status: item.status, minimumEvidenceLevel: item.minimumEvidenceLevel, evidenceCount: (item.evidence || []).length })),
    projects,
    latestRound: latest ? { roundId: latest.roundId, state: latest.state, workers: (latest.jobs || []).map((job) => ({ projectId: job.projectId, jobId: job.jobId, provider: job.provider, model: job.model, goal: job.goal })) } : null,
    completionAllowed: portfolio.state === "completed",
  };
}

function completeSingleTask(taskId) {
  const task = readTask(taskId);
  const missing = task.requirements.filter((item) => item.required && item.status !== "passing").map((item) => ({ id: item.id, description: item.description, status: item.status }));
  if (missing.length) return { taskId: task.taskId, state: task.state, completionAllowed: false, missing, rule: "Worker completion, process health, and activity cannot replace required acceptance evidence." };
  if (task.state === "completed") return { taskId: task.taskId, state: task.state, completionAllowed: true, completedAt: task.completedAt, alreadyCompleted: true };
  const completed = updateTask(task.taskId, (current) => ({ ...current, state: "completed", completedAt: utcNow() }));
  return { taskId: completed.taskId, state: completed.state, completionAllowed: true, completedAt: completed.completedAt };
}

function completeTask(args) {
  if (!args.portfolioId) return completeSingleTask(args.taskId);
  const portfolio = readPortfolio(args.portfolioId);
  const projectResults = portfolio.projects.map((project) => ({ projectId: project.projectId, ...completeSingleTask(project.taskId) }));
  updatePortfolio(portfolio.portfolioId, (current) => ({ ...current, projects: current.projects.map((project) => ({ ...project, state: readTask(project.taskId).state })) }));
  const missing = projectResults.filter((result) => result.completionAllowed !== true);
  const missingPortfolioRequirements = (readPortfolio(portfolio.portfolioId).requirements || []).filter((item) => item.required && item.status !== "passing").map((item) => ({ id: item.id, description: item.description, status: item.status }));
  if (missing.length || missingPortfolioRequirements.length) {
    const refreshed = readPortfolio(portfolio.portfolioId);
    const next = highestValueReadyProject(refreshed);
    if (next) updatePortfolio(portfolio.portfolioId, (current) => ({ ...current, currentCodex: { projectId: next.projectId, taskId: next.taskId, goal: "Advance this highest-value remaining project requirement.", files: [] } }));
    return { portfolioId: portfolio.portfolioId, state: "active", completionAllowed: false, projects: projectResults, missingPortfolioRequirements, rule: "Each project completes only from its own acceptance evidence; another project's evidence cannot satisfy it." };
  }
  const completed = updatePortfolio(portfolio.portfolioId, (current) => ({ ...current, state: "completed", completedAt: utcNow() }));
  return { portfolioId: completed.portfolioId, state: completed.state, completionAllowed: true, completedAt: completed.completedAt, projects: projectResults };
}

function cancelTask(args) {
  if (!args.portfolioId) {
    const task = readTask(args.taskId);
    const jobs = cancelTaskJobs(task.taskId);
    const cancelled = updateTask(task.taskId, (current) => ({ ...current, state: "cancelled", cancelledAt: utcNow() }));
    return { taskId: cancelled.taskId, state: cancelled.state, jobs };
  }
  const portfolio = readPortfolio(args.portfolioId);
  const projects = portfolio.projects.map((project) => {
    const jobs = cancelTaskJobs(project.taskId);
    const task = updateTask(project.taskId, (current) => current.state === "completed" ? current : { ...current, state: "cancelled", cancelledAt: utcNow() });
    return { projectId: project.projectId, taskId: task.taskId, state: task.state, jobs };
  });
  const cancelled = updatePortfolio(portfolio.portfolioId, (current) => ({ ...current, state: "cancelled", cancelledAt: utcNow(), projects: current.projects.map((project) => ({ ...project, state: readTask(project.taskId).state })) }));
  return { portfolioId: cancelled.portfolioId, state: cancelled.state, projects };
}

module.exports = {
  EVIDENCE_RANK,
  cancelTask,
  collectRound,
  compactCapacity,
  compactResources,
  completeTask,
  dispatchRound,
  highestValueReadyProject,
  quotaPoolIds,
  recordEvidence,
  requirementRows,
  startTask,
  taskSummary,
};
