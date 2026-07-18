"use strict";

const { boundariesOverlap, goalOverlap } = require("./lane-policy");
const { route } = require("./router");
const { cancelTaskJobs, readJob, statusFor, TERMINAL_STATES } = require("./job-store");
const { resourceLeaseSnapshot } = require("./resource-leases");
const {
  compactProjectContext,
  criticalPath,
  defaultWorkGraph,
  discoverProjectContext,
  resolveOutcome,
  safeId: safeContractId,
} = require("./project-context");
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
    if (!description) throw new Error("acceptanceEvidence[" + index + "] requires a description.");
    if (/\bor\s+(?:blocked|a blocker|unavailable)\b|\bif available\b|\bwhen eligible\b/i.test(description)) {
      throw new Error("Acceptance evidence must describe positive observable proof, not an escape condition.");
    }
    const minimumEvidenceLevel = EVIDENCE_RANK[item.minimumEvidenceLevel] === undefined ? defaultLevel : item.minimumEvidenceLevel;
    const evidence = (Array.isArray(item.evidence) ? item.evidence : []).filter((row) => (
      EVIDENCE_RANK[row?.level] !== undefined
      && String(row?.ref || "").trim()
      && String(row?.summary || "").trim()
    )).slice(-10).map((row) => ({
      level: row.level,
      ref: String(row.ref).trim().slice(0, 1000),
      summary: String(row.summary).trim().slice(0, 1200),
      verifiedAt: row.verifiedAt || row.verified_utc || null,
      imported: row.imported === true || item.imported === true,
    }));
    const sourceStatus = ["passing", "failing", "blocked"].includes(item.status) ? item.status : "failing";
    const status = sourceStatus === "passing" && evidence.length ? "passing" : sourceStatus === "blocked" ? "blocked" : "failing";
    return {
      id: safeContractId(item.id, "A" + (index + 1)),
      description,
      required: item.required !== false,
      status,
      minimumEvidenceLevel,
      evidence: status === "passing" ? evidence : [],
      blocker: status === "blocked" ? (item.blocker || null) : null,
      sourceStatus,
      imported: item.imported === true,
    };
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
      owner: String(row.owner || "current-codex").trim().slice(0, 120),
      recoveryTrigger: String(row.recoveryTrigger || "New evidence or corrected state is available.").trim().slice(0, 500),
      recoveryAction: String(row.recoveryAction || "Inspect authoritative state and retry only after the blocker changes.").trim().slice(0, 1000),
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
      evidenceRefs: cleanStrings(row.evidenceRefs, 10, 1000),
      acceptanceRequirementId: row.acceptanceRequirementId ? safeContractId(row.acceptanceRequirementId) : null,
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

function requirementsForStart(args, context, defaultLevel) {
  const hasSuppliedAcceptance = Array.isArray(args.acceptanceEvidence) && args.acceptanceEvidence.length > 0;
  const projectOutcomeMatches = context.projectOutcome && outcomeKey(args.resolvedOutcome || args.outcome) === outcomeKey(context.projectOutcome);
  if (context.requirements.length && args.outcomeAuthority !== "user" && (projectOutcomeMatches || !hasSuppliedAcceptance)) return requirementRows(context.requirements, defaultLevel);
  if (Array.isArray(args.acceptanceEvidence) && args.acceptanceEvidence.length) {
    return requirementRows(args.acceptanceEvidence, defaultLevel);
  }
  if (context.requirements.length) return requirementRows(context.requirements, defaultLevel);
  throw new Error("At least one acceptanceEvidence item is required, either in the request or a bounded project contract.");
}

function graphForStart(args, context, requirements) {
  if (Array.isArray(args.workGraph) && args.workGraph.length) return normalizeWorkGraph(args.workGraph);
  if (context.workGraph.length) return normalizeWorkGraph(context.workGraph);
  return normalizeWorkGraph(defaultWorkGraph(requirements, context.currentSliceRequirementId));
}

function codexPlan(args, requirements, workGraph) {
  const plan = criticalPath(requirements, workGraph);
  return {
    model: String(args.currentCodexModel || args.currentModel || args.currentCodex?.model || "").trim().slice(0, 160),
    reservePercent: Math.max(5, Math.min(50, Number(args.codexReservePercent || 15))),
    goal: plan.goal,
    files: [],
    acceptanceCriteria: plan.acceptanceCriteria || [],
    requirementId: plan.requirementId || null,
    workGraphNodeId: plan.workGraphNodeId || null,
    reason: plan.reason,
  };
}

function requirementKey(row) {
  return String(row?.description || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function outcomeKey(value) {
  return String(value || "")
    .trim()
    .replace(/^(?:[-*]\s*)?outcome:\s*/i, "")
    .replace(/\s+(?:[-*]\s*)?why(?: it matters)?:.*$/i, "")
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function mergeRequirements(existing, proposed, options = {}) {
  if (options.authoritative === true) {
    return (proposed || []).map((row) => ({
      ...row,
      evidence: [...(row.evidence || [])].slice(-10),
      blocker: row.status === "blocked" ? (row.blocker || null) : null,
    }));
  }
  const current = new Map((existing || []).map((row) => [requirementKey(row), row]));
  return (proposed || []).map((row) => {
    const match = current.get(requirementKey(row));
    if (!match || match.minimumEvidenceLevel !== row.minimumEvidenceLevel) return { ...row, status: row.status === "blocked" ? "blocked" : "failing", evidence: [] };
    return {
      ...row,
      status: match.status,
      evidence: [...(match.evidence || [])].slice(-10),
      sourceStatus: row.sourceStatus || match.sourceStatus,
      blocker: match.status === "blocked" ? (row.blocker || match.blocker || null) : null,
    };
  });
}

function classifyRecovery(reason) {
  const value = String(reason || "");
  if (/overlap|ownership|serialize/i.test(value)) {
    return {
      failureClass: "ownership-conflict",
      owner: "current-codex",
      recoveryTrigger: "The current Codex lane completes or the worker receives genuinely disjoint file and goal boundaries.",
      recoveryAction: "Finish the current critical-path unit, then serialize this work or redefine it with disjoint ownership. Do not retry the same overlapping lane.",
    };
  }
  if (/capacity|quota|reserve|provider|authenticated|unavailable|cooldown|worker limit/i.test(value)) {
    return {
      failureClass: "capacity-unavailable",
      owner: "current-codex",
      recoveryTrigger: "Fresh capacity evidence changes or another eligible provider becomes available.",
      recoveryAction: "Keep advancing the acceptance item in current Codex. Re-dispatch only after a fresh capacity transition or a materially different provider choice.",
    };
  }
  if (/economic|overhead|saving|small task/i.test(value)) {
    return {
      failureClass: "delegation-not-worthwhile",
      owner: "current-codex",
      recoveryTrigger: "The remaining unit becomes materially larger and independently verifiable.",
      recoveryAction: "Complete the unit directly in current Codex; do not spend another worker prompt or review cycle.",
    };
  }
  if (/dependencies|blocked|not active|work graph/i.test(value)) {
    return {
      failureClass: "dependency-blocked",
      owner: "current-codex",
      recoveryTrigger: "The named dependency or blocker has verifiably changed.",
      recoveryAction: "Advance another dependency-ready acceptance item. Retry this unit only after its recorded dependency transition.",
    };
  }
  return {
    failureClass: "contract-invalid",
    owner: "current-codex",
    recoveryTrigger: "The work contract is corrected using the observed rejection.",
    recoveryAction: "Correct the bounded goal, acceptance, or ownership once. Do not repeat the same rejected contract.",
  };
}

function nextPlanForTask(task, failures = [], completed = []) {
  const base = criticalPath(task.requirements || [], task.workGraph || []);
  const transitions = failures.slice(0, 12).map((failure) => ({
    goal: String(failure.goal || "").slice(0, 1200),
    reason: String(failure.reason || failure.blocker || "").slice(0, 1200),
    ...classifyRecovery(failure.reason || failure.blocker),
  }));
  const integrations = completed.slice(0, 12).map((result) => {
    const node = (task.workGraph || []).find((row) => row.id === result.workGraphNodeId);
    return {
      jobId: result.jobId,
      goal: String(result.goal || "").slice(0, 1200),
      workGraphNodeId: result.workGraphNodeId || null,
      requirementId: node?.acceptanceRequirementId || null,
      action: String(result.integration?.action || result.handoff?.integrationAction || "").slice(0, 1200),
      trustedPrimaryWrite: result.skipModelReview === true,
      rule: result.skipModelReview === true ? "The exact trusted model already changed the primary workspace and deterministic checks passed. Do not spend another model call reviewing it; record acceptance-linked evidence." : "Inspect this handoff once, run deterministic checks, and record only acceptance-linked evidence.",
    };
  });
  return {
    state: base.state,
    owner: "current-codex",
    requirementId: base.requirementId || null,
    workGraphNodeId: base.workGraphNodeId || null,
    goal: base.goal,
    acceptanceCriteria: base.acceptanceCriteria || [],
    reason: transitions.length
      ? "A worker path was rejected or failed; the task remains active on the next unresolved acceptance item."
      : base.reason,
    transitions,
    integrations,
    instruction: integrations.length
      ? integrations.every((item) => item.trustedPrimaryWrite) ? "Trusted changes are already in the primary workspace. Do not run another model review; record their deterministic acceptance evidence and continue the returned current Codex goal." : "Integrate each listed handoff exactly once, run deterministic checks, record acceptance evidence, then continue the returned current Codex goal."
      : base.state === "verification"
        ? "Run final deterministic acceptance checks, record sufficient evidence, then request completion."
        : "Start or continue this acceptance-linked current Codex unit now. Dispatch again only for a new disjoint unit with positive total economics.",
  };
}

function executionContract(task, failures = [], completed = []) {
  const plan = nextPlanForTask(task, failures, completed);
  const requirement = (task.requirements || []).find((row) => row.id === plan.requirementId) || null;
  const blocker = requirement?.status === "blocked" ? (requirement.blocker || null) : null;
  const userActionRequired = plan.state === "blocked" && /\b(user|human)\b/i.test(String(blocker?.owner || ""));
  const recoveryAction = String(blocker?.recoveryAction || "").trim();
  const mustStartNow = plan.state !== "blocked" || (!userActionRequired && Boolean(recoveryAction));
  const action = plan.state === "blocked" && recoveryAction ? recoveryAction : plan.goal;
  return {
    mode: "same-turn",
    status: userActionRequired ? "decision-required" : mustStartNow ? "active" : "blocked",
    owner: userActionRequired ? blocker.owner : "current-codex",
    action,
    reason: blocker?.reason || plan.reason,
    requirementId: plan.requirementId || null,
    workGraphNodeId: plan.workGraphNodeId || null,
    mustStartNow,
    userActionRequired,
    mayEndTurn: !mustStartNow,
    blocker,
    reporting: {
      when: ["resource assignment", "accepted evidence", "new blocker", "material recovery transition"],
      format: "Done / Active / Blocked / Resources / Next",
      nextRule: "Next names the material action already starting; never hand a safe executable action back to the user.",
    },
    stopConditions: [
      "All required acceptance evidence passes.",
      "An exact user decision or authorization is required and no other dependency-ready work remains.",
      "A genuine blocker has no safe recovery action and no other dependency-ready work remains.",
    ],
  };
}

function workerProviderLabel(provider) {
  // "codex" alone is ambiguous with current Codex; every worker-facing entry
  // names the callable CLI explicitly.
  return provider === "codex" ? "codex-cli" : provider;
}

function rejectionReasonsByProvider(rejected) {
  const reasons = {};
  for (const row of Array.isArray(rejected) ? rejected : []) {
    for (const item of Array.isArray(row.considered) ? row.considered : []) {
      if (item.eligible || !item.provider || reasons[item.provider]) continue;
      reasons[item.provider] = `Lane "${String(row.goal || "").slice(0, 160)}" was not dispatched here: ${String(item.reason || "").slice(0, 500)}`;
    }
  }
  return reasons;
}

function resourceReport(task, workers = [], rejected = []) {
  const providers = task.capacitySnapshot?.providers || {};
  const workerList = Array.isArray(workers) ? workers : [];
  const rejectionReasons = rejectionReasonsByProvider(rejected);
  const selectedWorkers = workerList.map((worker) => ({
    actor: "external-worker",
    provider: workerProviderLabel(worker.provider),
    jobId: worker.jobId || null,
    model: worker.model || "provider-default",
    role: worker.goal || "bounded independent work",
    reason: worker.reason || "Selected by the capacity, fit, safety, and economic router.",
  }));
  const decisions = Object.entries(providers).map(([provider, state]) => {
    const label = workerProviderLabel(provider);
    const selected = workerList.find((worker) => worker.provider === provider);
    if (selected) {
      return {
        provider: label,
        status: "selected",
        model: selected.model || "provider-default",
        jobId: selected.jobId || null,
        reason: `${selected.reason || "Best eligible fit for an accepted independent lane."}${selected.jobId ? ` Dispatched as callable CLI worker job ${selected.jobId}.` : ""}`,
      };
    }
    if (!state.available || !state.authenticated) return { provider: label, status: "unavailable", models: state.models || [], reason: state.reason || "Provider is unavailable or unauthenticated." };
    if (provider === "codex") {
      const base = `Current Codex is active; no additional Codex CLI lane was accepted, preserving the ${task.currentCodex?.reservePercent || 15}% integration reserve.`;
      return { provider: "codex-cli", status: "reserved", models: state.models || [], reason: rejectionReasons.codex ? `${base} ${rejectionReasons.codex}` : base };
    }
    return { provider: label, status: "idle", models: state.models || [], reason: rejectionReasons[provider] || "No independently owned, economically positive lane has been accepted for this provider yet." };
  });
  return {
    observedAt: task.capacitySnapshot?.generatedAt || null,
    selected: [
      { actor: "current-codex", model: task.currentCodex?.model || "current-task-model", role: task.currentCodex?.goal || "highest-value critical path", reason: `Current Codex owns the critical path while preserving a ${task.currentCodex?.reservePercent || 15}% reserve.` },
      ...selectedWorkers,
    ],
    providers: decisions,
    rejected: (rejected || []).slice(0, 8).map((row) => ({ goal: row.goal || "", reason: row.reason || row.blocker || "Rejected by routing gates." })),
  };
}
function startSingleTask(args, resources, portfolioContext = {}) {
  const context = discoverProjectContext(args.workspace);
  const outcomeReconciliation = resolveOutcome(args, context);
  const outcome = outcomeReconciliation.resolvedOutcome;
  const defaultLevel = EVIDENCE_RANK[args.minimumEvidenceLevel] === undefined ? "end-to-end" : args.minimumEvidenceLevel;
  const requirements = requirementsForStart({ ...args, resolvedOutcome: outcome }, context, defaultLevel);
  const workGraph = graphForStart(args, context, requirements);
  const record = createTaskRecord({
    workspace: args.workspace,
    outcome,
    requestedOutcome: outcomeReconciliation.requestedOutcome || outcome,
    latestUserRequest: outcomeReconciliation.latestUserRequest,
    outcomeReconciliation,
    outcomeAuthority: args.outcomeAuthority === "user" ? "user" : "auto",
    projectContext: compactProjectContext(context),
    contractVersion: 1,
    requirements,
    constraints: cleanStrings(args.constraints, 12, 1000),
    blockers: normalizeBlockers(args.blockers),
    workGraph,
    priority: Math.max(1, Math.min(100, Number(args.priority || 50))),
    portfolioId: portfolioContext.portfolioId || null,
    projectId: portfolioContext.projectId || null,
    currentCodex: codexPlan(args, requirements, workGraph),
    capacitySnapshot: compactResources(resources),
  });
  return record;
}

function startPortfolio(args, resources) {
  const outcome = String(args.outcome || args.userRequest || "").trim().slice(0, 6000);
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
        outcomeReconciliation: task.outcomeReconciliation,
        projectContext: task.projectContext,
        requirements: task.requirements.map(({ id, description, minimumEvidenceLevel, required, status }) => ({ id, description, minimumEvidenceLevel, required, status })),
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
  const currentTask = current ? readTask(current.taskId) : null;
  const portfolio = updatePortfolio(provisional.portfolioId, (record) => ({
    ...record,
    projects,
    currentCodex: current ? {
      projectId: current.projectId,
      taskId: current.taskId,
      ...currentTask.currentCodex,
    } : {},
  }));
  return {
    portfolioId: portfolio.portfolioId,
    state: portfolio.state,
    outcome: portfolio.outcome,
    projects: portfolio.projects.map((project) => ({ projectId: project.projectId, taskId: project.taskId, workspace: project.workspace, outcome: project.outcome, priority: project.priority, blockers: project.blockers, requirements: project.requirements, workGraph: project.workGraph })),
    capacity: portfolio.capacitySnapshot,
    currentCodex: portfolio.currentCodex,
    execution: currentTask ? executionContract(currentTask) : { mode: "same-turn", status: "blocked", mustStartNow: false, mayEndTurn: true, reason: "No active portfolio project is ready." },
    resources: currentTask ? resourceReport(currentTask) : { observedAt: portfolio.capacitySnapshot?.generatedAt || null, selected: [], providers: [] },
    nextAction: currentTask ? executionContract(currentTask).action : "Resolve the recorded portfolio blocker.",
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
    outcomeReconciliation: record.outcomeReconciliation,
    projectContext: record.projectContext,
    requirements: record.requirements.map(({ id, description, minimumEvidenceLevel, status, blocker }) => ({ id, description, minimumEvidenceLevel, status, blocker: blocker || null })),
    workGraph: record.workGraph,
    capacity: record.capacitySnapshot,
    currentCodex: record.currentCodex,
    execution: executionContract(record),
    resources: resourceReport(record),
    nextAction: executionContract(record).action,
    reportingRule: "Report only assignments, accepted evidence, a real blocker, or the next material action. Do not create a Goal, manager loop, heartbeat, automation, or status feed.",
  };
}

function activeRound(task) {
  const reference = (task.rounds || []).at(-1);
  if (!reference) return null;
  const round = readRound(task.taskId, reference.roundId);
  return ["planning", "running"].includes(round.state) ? round : null;
}

function activePortfolioProjectRound(reference, taskId) {
  if (!reference) return null;
  const portfolio = readPortfolio(reference.portfolioId);
  const latest = (portfolio.rounds || []).at(-1);
  if (!latest) return null;
  const round = readPortfolioRound(portfolio.portfolioId, latest.roundId);
  if (!["planning", "running"].includes(round.state)) return null;
  return (round.jobs || []).some((job) => job.taskId === taskId)
    ? { portfolio, round }
    : null;
}

function reconcileSingleTask(args, portfolioReference = null) {
  const task = readTask(args.taskId);
  const context = discoverProjectContext(task.workspace);
  const outcomeInput = Object.prototype.hasOwnProperty.call(args, "outcome") ? args.outcome : task.outcome;
  const latestCorrection = String(args.userRequest || args.latestUserRequest || "").trim();
  const latestRequestChanged = Boolean(latestCorrection && latestCorrection !== String(task.latestUserRequest || "").trim());
  const outcomeAuthority = args.outcomeAuthority || (latestRequestChanged ? "auto" : task.outcomeAuthority || "auto");
  const resolution = resolveOutcome({
    ...args,
    outcomeAuthority,
    outcome: outcomeInput,
    userRequest: args.userRequest || args.latestUserRequest || task.latestUserRequest,
  }, context);
  const defaultLevel = EVIDENCE_RANK[args.minimumEvidenceLevel] === undefined ? "end-to-end" : args.minimumEvidenceLevel;
  const hasAcceptance = Array.isArray(args.acceptanceEvidence) && args.acceptanceEvidence.length > 0;
  const outcomeChanged = resolution.resolvedOutcome !== task.outcome;
  const refreshFromProject = args.refreshProjectContext === true || outcomeChanged;
  const projectOutcomeMatches = context.projectOutcome && outcomeKey(resolution.resolvedOutcome) === outcomeKey(context.projectOutcome);
  const projectRequirementsAuthoritative = context.requirements.length > 0 && projectOutcomeMatches && outcomeAuthority !== "user" && (refreshFromProject || hasAcceptance);
  let proposedRequirements = task.requirements;
  if (projectRequirementsAuthoritative) proposedRequirements = requirementRows(context.requirements, defaultLevel);
  else if (hasAcceptance) proposedRequirements = requirementRows(args.acceptanceEvidence, defaultLevel);
  else if (refreshFromProject && context.requirements.length) proposedRequirements = requirementRows(context.requirements, defaultLevel);
  const requirements = mergeRequirements(task.requirements, proposedRequirements, { authoritative: projectRequirementsAuthoritative });

  const explicitGraph = Array.isArray(args.workGraph);
  const workGraph = explicitGraph
    ? normalizeWorkGraph(args.workGraph.length ? args.workGraph : defaultWorkGraph(requirements, context.currentSliceRequirementId))
    : outcomeChanged || hasAcceptance || args.refreshProjectContext === true
      ? normalizeWorkGraph(context.workGraph.length ? context.workGraph : defaultWorkGraph(requirements, context.currentSliceRequirementId))
      : task.workGraph;
  const constraints = Object.prototype.hasOwnProperty.call(args, "constraints")
    ? cleanStrings(args.constraints, 12, 1000)
    : task.constraints;
  const blockers = Object.prototype.hasOwnProperty.call(args, "blockers")
    ? normalizeBlockers(args.blockers)
    : task.blockers;
  const materialChange = outcomeChanged
    || hasAcceptance
    || explicitGraph
    || Object.prototype.hasOwnProperty.call(args, "constraints")
    || Object.prototype.hasOwnProperty.call(args, "blockers")
    || args.refreshProjectContext === true;
  const taskRound = activeRound(task);
  const portfolioRound = activePortfolioProjectRound(portfolioReference, task.taskId);
  const staleRound = taskRound || portfolioRound?.round || null;
  if (staleRound && materialChange && args.cancelActiveWorkers === false) {
    return {
      taskId: task.taskId,
      state: task.state,
      reconciliationAllowed: false,
      blocker: "The latest round still owns workers under the stale contract.",
      recoveryAction: "Call reconcile-task again with cancelActiveWorkers true, or collect the terminal round before revising.",
      activeRoundId: staleRound.roundId,
    };
  }

  let cancelledWorkers = [];
  if (staleRound && materialChange) {
    cancelledWorkers = cancelTaskJobs(task.taskId);
  }
  if (taskRound && materialChange) {
    updateRound(task.taskId, taskRound.roundId, {
      state: "invalidated",
      invalidatedAt: utcNow(),
      invalidatedReason: "Task contract changed from a latest user correction or authoritative project reconciliation.",
    });
  }
  if (portfolioRound && materialChange) {
    const otherJobs = (portfolioRound.round.jobs || []).filter((job) => job.taskId !== task.taskId);
    const invalidatedJobs = (portfolioRound.round.jobs || []).filter((job) => job.taskId === task.taskId);
    updatePortfolioRound(portfolioRound.portfolio.portfolioId, portfolioRound.round.roundId, {
      state: otherJobs.length ? "running" : "invalidated",
      jobs: otherJobs,
      invalidatedJobs: [
        ...(portfolioRound.round.invalidatedJobs || []),
        ...invalidatedJobs.map((job) => ({ ...job, invalidatedAt: utcNow(), invalidatedReason: "Project contract changed." })),
      ].slice(-40),
      contractRevisions: [
        ...(portfolioRound.round.contractRevisions || []),
        { projectId: portfolioReference.projectId, taskId: task.taskId, revisedAt: utcNow() },
      ].slice(-20),
    });
  }
  const nextCodex = codexPlan({
    currentCodexModel: args.currentCodexModel || task.currentCodex?.model,
    codexReservePercent: args.codexReservePercent || task.currentCodex?.reservePercent,
  }, requirements, workGraph);
  const updated = updateTask(task.taskId, (current) => ({
    ...current,
    state: materialChange && current.state === "completed" ? "active" : current.state === "cancelled" && materialChange ? "active" : current.state,
    completedAt: materialChange ? null : current.completedAt,
    cancelledAt: materialChange ? null : current.cancelledAt,
    outcome: resolution.resolvedOutcome,
    requestedOutcome: resolution.requestedOutcome || resolution.resolvedOutcome,
    latestUserRequest: resolution.latestUserRequest,
    outcomeReconciliation: { ...resolution, contractChanged: materialChange },
    outcomeAuthority,
    projectContext: compactProjectContext(context),
    contractVersion: Number(current.contractVersion || 1) + (materialChange ? 1 : 0),
    revisedAt: materialChange ? utcNow() : current.revisedAt,
    requirements,
    evidence: requirements.flatMap((requirement) => (requirement.evidence || []).map((evidence) => ({ requirementId: requirement.id, ...evidence }))).slice(-50),
    constraints,
    blockers,
    workGraph,
    currentCodex: materialChange ? nextCodex : current.currentCodex,
  }));

  if (portfolioReference) {
    updatePortfolio(portfolioReference.portfolioId, (portfolio) => {
      portfolio.projects = portfolio.projects.map((project) => project.projectId === portfolioReference.projectId ? {
        ...project,
        outcome: updated.outcome,
        outcomeReconciliation: updated.outcomeReconciliation,
        projectContext: updated.projectContext,
        requirements: updated.requirements.map(({ id, description, minimumEvidenceLevel, required, status }) => ({ id, description, minimumEvidenceLevel, required, status })),
        blockers: updated.blockers,
        workGraph: updated.workGraph,
        state: updated.state,
      } : project);
      const ready = highestValueReadyProject(portfolio);
      if (ready) portfolio.currentCodex = { projectId: ready.projectId, taskId: ready.taskId, ...readTask(ready.taskId).currentCodex };
      return portfolio;
    });
  }
  return {
    ...singleTaskSummary(updated),
    reconciliationAllowed: true,
    reconciliation: updated.outcomeReconciliation,
    cancelledWorkers,
    nextPlan: nextPlanForTask(updated),
  };
}

function reconcileTask(args) {
  if (args.taskId) return reconcileSingleTask(args);
  const portfolio = readPortfolio(args.portfolioId);
  const projectId = String(args.projectId || "").trim();
  const project = portfolio.projects.find((row) => row.projectId === projectId);
  if (!project) throw new Error("reconcile-task with portfolioId requires a valid projectId.");
  return reconcileSingleTask({ ...args, taskId: project.taskId }, { portfolioId: portfolio.portfolioId, projectId });
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

function applyUserModelMandate(task, unit) {
  // An explicitly named model in the recorded user request is a user mandate.
  // Without this, premium gates silently strand a request like "use Fable"
  // as an idle provider even though the user asked for that exact model.
  const model = String(unit?.model || "").trim();
  if (!model || unit.selectionAuthority) return unit;
  const text = `${task.latestUserRequest || ""} ${task.requestedOutcome || ""}`.toLowerCase();
  if (!text.trim()) return unit;
  const tokens = model.toLowerCase().split(/[^a-z0-9.]+/)
    .filter((token) => token.length >= 4 && !["claude", "codex", "auto", "model"].includes(token));
  const named = tokens.some((token) => text.includes(token)) || text.includes(model.toLowerCase());
  if (!named) return unit;
  return {
    ...unit,
    selectionAuthority: "user",
    mandateSource: `The recorded user request explicitly names "${model}", so this lane is routed as a user model mandate.`,
  };
}

function withMandateNote(reason, unit) {
  return unit.mandateSource ? `${reason} ${unit.mandateSource}` : reason;
}

function workerTaskContext(task) {
  return {
    latestUserRequest: String(task.latestUserRequest || "").slice(0, 6000),
    constraints: (task.constraints || []).slice(0, 20).map((item) => String(item).slice(0, 600)),
    unresolvedAcceptance: (task.requirements || []).filter((item) => item.required !== false && item.status !== "passing").slice(0, 12).map((item) => ({
      id: item.id,
      description: String(item.description || "").slice(0, 1000),
      blocker: item.blocker || null,
    })),
  };
}
function dispatchSingleRound(args, resources, histories, createJob) {
  const task = synchronizeTaskWithProject(readTask(args.taskId));
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
    const mandatedUnit = applyUserModelMandate(task, unit);
    let decision;
    try {
      decision = route({ ...mandatedUnit, workspace: task.workspace, projectGoal: task.outcome, goal: unitGoal, currentCodexGoal: currentGoal, currentCodexFiles: currentFiles, horizonHours: args.horizonHours || 5 }, resources, histories);
    } catch (error) { rejected.push({ goal: unitGoal, reason: withMandateNote(error.message, mandatedUnit) }); continue; }
    if (decision.action !== "delegate") { rejected.push({ goal: unitGoal, reason: withMandateNote(decision.reason, mandatedUnit), economics: decision.economics || null, considered: decision.considered || [] }); continue; }
    try {
      const selected = resources.providers[decision.provider];
      const receipt = createJob({
        ...decision.request,
        taskId: task.taskId,
        roundId: round.roundId,
        workGraphNodeId: unit.workGraphNodeId || null,
        completionEvidence: task.requirements.map((item) => item.description),
        taskContext: workerTaskContext(task),
        workspace: task.workspace,
        provider: decision.provider,
        providerCommand: selected.command,
        providerAuthMode: selected.authMode || "unknown",
        quotaPoolIds: quotaPoolIds(decision.provider, selected, decision.request.model),
        fairnessKey: task.taskId,
      });
      jobs.push({ ...receipt, workGraphNodeId: unit.workGraphNodeId || null, goal: unitGoal, reason: withMandateNote(decision.reason, mandatedUnit), economics: decision.economics, integrationAction: decision.request.integrationAction || "" });
      workerOwners.push({ goal: unitGoal, files: unitFiles });
    } catch (error) { rejected.push({ goal: unitGoal, reason: error.message, considered: decision.considered || [] }); }
  }
  const state = jobs.length ? "running" : "direct";
  updateRound(task.taskId, round.roundId, { state, jobs, rejected });
  const updatedTask = updateTask(task.taskId, (current) => {
    current.currentCodex = { ...current.currentCodex, goal: currentGoal, files: currentFiles, acceptanceCriteria: cleanStrings(currentCodex.acceptanceCriteria, 12, 1000), updatedAt: utcNow() };
    current.capacitySnapshot = compactResources(resources);
    current.workGraph = (current.workGraph || []).map((node) => {
      const job = jobs.find((row) => row.workGraphNodeId === node.id);
      return job ? { ...node, state: "running", owner: { type: "worker", jobId: job.jobId, provider: job.provider } } : node;
    });
    return current;
  });
  const nextPlan = nextPlanForTask(updatedTask, rejected);
  return {
    taskId: task.taskId,
    roundId: round.roundId,
    state,
    currentCodex: { goal: currentGoal, files: currentFiles, instruction: "Start or continue this critical-path unit now; do not wait for workers." },
    workers: jobs,
    rejected,
    recoveryPlan: nextPlan,
    execution: { ...executionContract(updatedTask, rejected), status: "active", action: currentGoal, mustStartNow: true, mayEndTurn: false },
    resources: resourceReport(updatedTask, jobs, rejected),
    nextAction: currentGoal,
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
    const mandatedUnit = unit.model && !unit.selectionAuthority ? applyUserModelMandate(readTask(project.taskId), unit) : unit;
    let decision;
    try {
      decision = route({
        ...mandatedUnit,
        workspace: project.workspace,
        projectGoal: project.outcome,
        goal: unitGoal,
        currentCodexGoal: currentGoal,
        currentCodexFiles: project.projectId === currentProjectId ? currentFiles : [],
        currentCodexReserved: unit.currentCodexReserved === true,
        horizonHours: args.horizonHours || portfolio.allocationPolicy.horizonHours || 5,
        projectId: project.projectId,
      }, resources, histories);
    } catch (error) { rejected.push({ projectId: project.projectId, goal: unitGoal, reason: withMandateNote(error.message, mandatedUnit) }); continue; }
    if (decision.action !== "delegate") { rejected.push({ projectId: project.projectId, goal: unitGoal, reason: withMandateNote(decision.reason, mandatedUnit), economics: decision.economics || null, considered: decision.considered || [] }); continue; }
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
        taskContext: workerTaskContext(task),
        workspace: project.workspace,
        provider: decision.provider,
        providerCommand: selected.command,
        providerAuthMode: selected.authMode || "unknown",
        quotaPoolIds: quotaPoolIds(decision.provider, selected, decision.request.model),
        fairnessKey: `${portfolio.portfolioId}:${project.projectId}`,
      });
      jobs.push({ ...receipt, projectId: project.projectId, taskId: project.taskId, workGraphNodeId: unit.workGraphNodeId || null, goal: unitGoal, reason: withMandateNote(decision.reason, mandatedUnit), economics: decision.economics, integrationAction: decision.request.integrationAction || "" });
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
  const recoveryPlans = Object.fromEntries(portfolio.projects.map((project) => [
    project.projectId, nextPlanForTask(readTask(project.taskId), rejected.filter((row) => row.projectId === project.projectId)),
  ]));
  const currentTaskAfterDispatch = readTask(currentProject.taskId);
  return {
    portfolioId: portfolio.portfolioId,
    roundId: round.roundId,
    state,
    currentCodex: { projectId: currentProjectId, taskId: currentProject.taskId, goal: currentGoal, files: currentFiles, instruction: "Advance this highest-value critical path now; do not wait for workers." },
    workers: jobs,
    rejected,
    recoveryPlans,
    execution: { ...executionContract(currentTaskAfterDispatch, rejected.filter((row) => !row.projectId || row.projectId === currentProjectId)), status: "active", action: currentGoal, mustStartNow: true, mayEndTurn: false },
    resources: resourceReport(currentTaskAfterDispatch, jobs, rejected),
    nextAction: currentGoal,
  };
}

function dispatchRound(args, resources, histories, createJob) {
  return args.portfolioId ? dispatchPortfolioRound(args, resources, histories, createJob) : dispatchSingleRound(args, resources, histories, createJob);
}

function collectSingleRound(args) {
  const task = readTask(args.taskId);
  const round = readRound(task.taskId, args.roundId);
  if (round.state === "invalidated") throw new Error("This round was invalidated by a task contract revision and cannot be collected.");
  const results = (round.jobs || []).map((job) => readJob(task.taskId, job.jobId, args.detail || "compact", Number(args.waitSeconds || 0)));
  const state = terminalRoundState(results);
  updateRound(task.taskId, round.roundId, { state, collectedAt: results.every((row) => row.terminal) ? utcNow() : null });
  const updatedTask = updateTask(task.taskId, (current) => {
    current.workGraph = (current.workGraph || []).map((node) => {
      const job = (round.jobs || []).find((row) => row.workGraphNodeId === node.id);
      if (!job) return node;
      const result = results.find((row) => row.jobId === job.jobId);
      if (!result || !result.terminal) return node;
      return result.state === "completed"
        ? { ...node, state: "awaiting-evidence", owner: null }
        : { ...node, state: "pending", owner: null, lastFailure: String(result.blocker || "Worker failed.").slice(0, 1000) };
    });
    return current;
  });
  const failures = results.filter((row) => row.terminal && row.state !== "completed").map((row) => ({ goal: row.goal, blocker: row.blocker }));
  const completed = results.filter((row) => row.terminal && row.state === "completed");
  const nextPlan = state === "running" ? null : nextPlanForTask(updatedTask, failures, completed);
  return { taskId: task.taskId, roundId: round.roundId, state, results, recoveryPlan: nextPlan, execution: executionContract(updatedTask, failures, completed), resources: resourceReport(updatedTask, round.jobs || [], failures), nextAction: executionContract(updatedTask, failures, completed).action };
}

function collectPortfolioRound(args) {
  const portfolio = readPortfolio(args.portfolioId);
  const round = readPortfolioRound(portfolio.portfolioId, args.roundId);
  if (round.state === "invalidated") throw new Error("This portfolio round was invalidated by a project contract revision and cannot be collected.");
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
          return result.state === "completed"
            ? { ...node, state: "awaiting-evidence", owner: null }
            : { ...node, state: "pending", owner: null, lastFailure: String(result.blocker || "Worker failed.").slice(0, 1000) };
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
        return result.state === "completed"
          ? { ...node, state: "awaiting-evidence", owner: null }
          : { ...node, state: "pending", owner: null, lastFailure: String(result.blocker || "Worker failed.").slice(0, 1000) };
      });
      return task;
    });
  }
  const recoveryPlans = Object.fromEntries(portfolio.projects.map((project) => {
    const owned = results.filter((result) => result.projectId === project.projectId);
    const failures = owned.filter((row) => row.terminal && row.state !== "completed").map((row) => ({ goal: row.goal, blocker: row.blocker }));
    const completed = owned.filter((row) => row.terminal && row.state === "completed");
    return [project.projectId, nextPlanForTask(readTask(project.taskId), failures, completed)];
  }));
  const activeTask = readTask(readPortfolio(portfolio.portfolioId).currentCodex?.taskId || portfolio.projects[0].taskId);
  return { portfolioId: portfolio.portfolioId, roundId: round.roundId, state, results, recoveryPlans, execution: executionContract(activeTask), resources: resourceReport(activeTask, round.jobs || [], results.filter((row) => row.terminal && row.state !== "completed")), nextAction: executionContract(activeTask).action };
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
        requirement.blocker = null;
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

function synchronizeTaskWithProject(task) {
  const context = discoverProjectContext(task.workspace);
  if (
    task.outcomeAuthority === "user"
    || !context.projectOutcome
    || !context.requirements.length
    || outcomeKey(task.outcome) !== outcomeKey(context.projectOutcome)
  ) return task;

  const requirements = requirementRows(context.requirements);
  const projectContext = compactProjectContext(context);
  const previousFingerprint = String(task.projectContext?.acceptance?.fingerprint || "");
  const currentFingerprint = String(projectContext.acceptance?.fingerprint || "");
  if (previousFingerprint && previousFingerprint === currentFingerprint) return task;
  const requirementsChanged = JSON.stringify(task.requirements || []) !== JSON.stringify(requirements);
  const contextChanged = JSON.stringify(task.projectContext || null) !== JSON.stringify(projectContext);
  if (!requirementsChanged && !contextChanged) return task;

  const workGraph = normalizeWorkGraph(context.workGraph.length
    ? context.workGraph
    : defaultWorkGraph(requirements, context.currentSliceRequirementId));
  const currentCodex = codexPlan({
    currentCodexModel: task.currentCodex?.model,
    codexReservePercent: task.currentCodex?.reservePercent,
  }, requirements, workGraph);
  const unresolved = requirements.some((item) => item.required !== false && item.status !== "passing");
  const active = activeRound(task);

  return updateTask(task.taskId, (current) => ({
    ...current,
    state: current.state === "completed" && unresolved ? "active" : current.state,
    completedAt: current.state === "completed" && unresolved ? null : current.completedAt,
    projectContext,
    requirements,
    evidence: requirements.flatMap((requirement) => (requirement.evidence || []).map((evidence) => ({ requirementId: requirement.id, ...evidence }))).slice(-50),
    workGraph,
    currentCodex,
    contractVersion: Number(current.contractVersion || 1) + 1,
    revisedAt: utcNow(),
    outcomeReconciliation: {
      ...(current.outcomeReconciliation || {}),
      authoritativeEvidenceRefreshed: true,
      source: "project-contract",
    },
    authoritativeSync: {
      syncedAt: utcNow(),
      source: ".codex/ACCEPTANCE.json",
      activeRoundNeedsReconciliation: Boolean(active),
    },
  }));
}

function singleTaskSummary(task) {
  const lastRoundRef = (task.rounds || []).at(-1);
  const lastRound = lastRoundRef ? readRound(task.taskId, lastRoundRef.roundId) : null;
  const requirements = task.requirements.map((item) => ({ id: item.id, description: item.description, required: item.required !== false, status: item.status, minimumEvidenceLevel: item.minimumEvidenceLevel, evidenceCount: (item.evidence || []).length, blocker: item.blocker || null }));
  const execution = executionContract(task);
  const workState = task.state === "completed"
    ? "completed"
    : lastRound?.state === "running"
      ? "workers-running"
      : execution.mustStartNow
        ? "ready-for-current-codex"
        : execution.status || "blocked";
  return {
    taskId: task.taskId,
    projectId: task.projectId || null,
    state: task.state,
    workState,
    contractVersion: Number(task.contractVersion || 1),
    outcome: task.outcome,
    outcomeReconciliation: task.outcomeReconciliation || null,
    projectContext: task.projectContext || null,
    blockers: task.blockers || [],
    workGraph: task.workGraph || [],
    progress: { passing: requirements.filter((item) => item.status === "passing").length, required: requirements.filter((item) => item.required).length },
    requirements,
    currentCodex: task.currentCodex,
    nextPlan: nextPlanForTask(task),
    execution,
    resources: resourceReport(task, lastRound?.jobs || [], lastRound?.rejected || []),
    latestRound: lastRound ? { roundId: lastRound.roundId, state: lastRound.state, workers: (lastRound.jobs || []).map((job) => ({ jobId: job.jobId, provider: job.provider, model: job.model, goal: job.goal })) } : null,
    completionAllowed: task.state === "completed",
  };
}

function taskSummary(args) {
  if (!args.portfolioId) return singleTaskSummary(synchronizeTaskWithProject(readTask(args.taskId)));
  const portfolio = readPortfolio(args.portfolioId);
  const projects = portfolio.projects.map((project) => singleTaskSummary(synchronizeTaskWithProject(readTask(project.taskId))));
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
  const task = synchronizeTaskWithProject(readTask(taskId));
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
  nextPlanForTask,
  quotaPoolIds,
  reconcileTask,
  recordEvidence,
  requirementRows,
  startTask,
  taskSummary,
};
