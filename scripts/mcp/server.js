"use strict";

const readline = require("node:readline");
const { inventory } = require("../core/capacity");
const { cleanupAbandonedJobs, createJob } = require("../core/job-store");
const { providerHistory } = require("../core/provider-history");
const { cancelTask, collectRound, compactCapacity, completeTask, dispatchRound, integrateRound, reconcileTask, recordEvidence, startTask, taskSummary } = require("../core/task-orchestrator");
const { cleanupStaleLeases, resourceLeaseSnapshot } = require("../core/resource-leases");
const { cleanupAbandonedWorktrees, storageStatus } = require("../core/workspace-isolation");
const { runTaskCycle } = require("../core/task-cycle");
const { coordinatorStatus, requestCoordinatorCancel } = require("../core/coordinator");
const { providerDiagnostics } = require("../core/provider-diagnostics");
const { directorProgramSummary, emitProgramReport, migrateLegacyTaskToDirector, startDirectorProgram } = require("../core/director-cfo-orchestrator");
const { readProfile, writeProfile } = require("../lib/orchestrator-profile");
const { assertCurrentRuntime, pluginVersion } = require("../lib/version");
const { runtimeFingerprint } = require("../lib/runtime-identity");
const { readMaterialEvents } = require("../core/material-events");

const { createRestartHandoff } = require("../core/restart-handoff");
const PROVIDERS = ["auto", "codex", "claude", "antigravity", "cursor"];
const TASK_KINDS = ["architecture", "browser", "code", "debug", "docs", "generic", "live-state", "repository-scan", "research", "review", "tests"];
const EVIDENCE_LEVELS = ["activity", "process-health", "focused-test", "integration", "end-to-end", "user-visible"];

const WORK_UNIT_SCHEMA = {
  type: "object",
  required: ["goal", "independenceReason", "relevantFiles"],
  properties: {
    goal: { type: "string" },
    projectId: { type: "string" },
    workGraphNodeId: { type: "string" },
    priority: { type: "number", minimum: 1, maximum: 100 },
    independenceReason: { type: "string" },
    relevantFiles: { type: "array", minItems: 1, items: { type: "string" } },
    acceptanceCriteria: { type: "array", items: { type: "string" } },
    expectedContribution: { type: "string" },
    integrationAction: { type: "string" },
    preferredProvider: { enum: PROVIDERS },
    selectionAuthority: { enum: ["router", "user"], description: "Set \"user\" only for a provider/model the user explicitly mandated (for example an explicit Claude Fable request). A model named in the recorded user request is honored as a user mandate even if this field is omitted; mandates bypass economic gates but never safety, ownership, or capacity gates." },
    readOnly: { type: "boolean" },
    expectedFiles: { type: "array", items: { type: "string" } },
    verificationCommands: { type: "array", items: { type: "object" } },
    timeoutSeconds: { type: "number", minimum: 30, maximum: 3600 },
    complexity: { enum: ["small", "medium", "large"] },
    taskKind: { enum: TASK_KINDS },
    model: { type: "string", description: "Exact model for this lane. An explicitly user-requested model is dispatched or reported with its concrete blocking reason; it is never left silently idle." },
    effort: { type: "string" },
    allowAntigravity: { type: "boolean" },
    allowPaidApi: { type: "boolean" },
    allowPremiumModel: { type: "boolean" },
    needsUi: { type: "boolean" },
    estimatedDirectTokens: { type: "number" },
    maxWorkerOutputTokens: { type: "number" },
    maxApiBudgetUsd: { type: "number" },
    minimumSavingsPercent: { type: "number" },
    currentCodexReserved: { type: "boolean" },
    workPlaneRequired: { type: "boolean", description: "Internal coordinator flag. The visible console cannot execute this unit directly." },
    artifactKind: { enum: ["work-plan"], description: "Structured read-only observation artifact consumed once by the deterministic coordinator." },
    requiredCapabilities: { type: "array", maxItems: 12, items: { type: "string" }, description: "Callable capabilities required by this lane, such as source, local-files, git, tests, browser, github, api, command, database, or service-control." },
  },
};

const ACCEPTANCE_SCHEMA = { type: "array", minItems: 1, maxItems: 12, items: { oneOf: [{ type: "string" }, { type: "object", required: ["description"], properties: { description: { type: "string" }, required: { type: "boolean" }, minimumEvidenceLevel: { enum: EVIDENCE_LEVELS } } }] } };
const PROGRAM_ACCEPTANCE_SCHEMA = { type: "array", minItems: 1, maxItems: 250, items: { oneOf: [{ type: "string" }, { type: "object", required: ["description"], properties: {
  id: { type: "string" }, requirementId: { type: "string" }, description: { type: "string" }, required: { type: "boolean" },
  status: { enum: ["passing", "failing", "blocked", "waived"] }, minimumEvidenceLevel: { enum: EVIDENCE_LEVELS },
} }] } };
const PROJECT_SCHEMA = { type: "object", required: ["workspace"], properties: {
  projectId: { type: "string" }, workspace: { type: "string" }, outcome: { type: "string" }, acceptanceEvidence: ACCEPTANCE_SCHEMA,
  userRequest: { type: "string" }, outcomeAuthority: { enum: ["auto", "user"] },
  constraints: { type: "array", items: { type: "string" } }, priority: { type: "number", minimum: 1, maximum: 100 },
  blockers: { type: "array", items: { oneOf: [{ type: "string" }, { type: "object", properties: { id: { type: "string" }, description: { type: "string" }, resolved: { type: "boolean" } } }] } },
  workGraph: { type: "array", items: { type: "object", required: ["goal"], properties: { id: { type: "string" }, goal: { type: "string" }, dependsOn: { type: "array", items: { type: "string" } }, priority: { type: "number", minimum: 1, maximum: 100 }, state: { enum: ["pending", "running", "awaiting-evidence", "completed", "blocked"] } } } },
} };
const TASK_OR_PORTFOLIO = { anyOf: [{ required: ["taskId"] }, { required: ["portfolioId"] }] };

const SOURCE_DESCRIPTOR_SCHEMA = { oneOf: [
  { type: "string", description: "An explicitly supplied source locator." },
  { type: "object", anyOf: [{ required: ["locator"] }, { required: ["path"] }, { required: ["ref"] }, { required: ["uri"] }, { required: ["url"] }, { required: ["threadId"] }], properties: {
    id: { type: "string" }, locator: { type: "string" }, path: { type: "string" }, ref: { type: "string" }, uri: { type: "string" }, url: { type: "string" }, threadId: { type: "string" }, access: { enum: ["read", "metadata", "observe"] },
    authorized: { type: "boolean" }, required: { type: "boolean" }, authority: { type: "string" },
    description: { type: "string" }, revisionHint: { type: "string" }, capabilities: { type: "array", items: { type: "string" } },
  } },
] };
const SOURCE_DESCRIPTORS_SCHEMA = { type: "object", description: "Authorized source descriptors or snapshot locators supplied by the caller. AI Mobile does not discover Codex chats automatically.", properties: Object.fromEntries(
  ["chats", "files", "git", "logs", "databases", "services", "browsers", "external"].map((key) => [key, { type: "array", items: SOURCE_DESCRIPTOR_SCHEMA }]),
) };

const TOOLS = [
  { name: "start-program", description: "Director-CFO intake for AI Mobile. Tasks estimated within one minute return a direct bypass. Complex projects reuse the one active Director program already bound to the workspace, or create one durable mission when none exists. Different wording still preserves and resumes the canonical outcome; only an explicit reconcile-task call may replace it. Source descriptors or snapshots must be explicitly supplied and authorized; chats are never discovered automatically.", inputSchema: { type: "object", required: ["workspace"], anyOf: [{ required: ["outcome"] }, { required: ["userRequest"] }, { required: ["request"] }], properties: {
    workspace: { type: "string" }, outcome: { type: "string" }, userRequest: { type: "string" }, request: { type: "string" },
    mode: { enum: ["auto", "direct", "program"] }, orchestrationMode: { enum: ["auto", "direct", "program"] }, forceDirect: { type: "boolean" }, forceProgram: { type: "boolean" },
    expectedDurationSeconds: { type: "number", minimum: 0 }, acceptanceEvidence: PROGRAM_ACCEPTANCE_SCHEMA,
    constraints: { type: "array", items: { type: "string" } }, projectContract: { oneOf: [{ type: "boolean" }, { type: "object" }] },
    sourceDescriptors: SOURCE_DESCRIPTORS_SCHEMA,
    authorization: { type: "object", properties: { scopeId: { type: "string" }, authorizedBy: { type: "string" }, grantRef: { type: "string" }, allowedTypes: { type: "array", items: { enum: ["project-outcome", "acceptance", "chat", "file", "git", "log", "database", "service", "browser", "external"] } } } },
    authorizedPermissions: { type: "array", items: { type: "string" } }, contextSourceFingerprints: { type: "object", additionalProperties: { type: "string" } },
    campaignHours: { type: "number", minimum: 1, maximum: 4 }, noProgressLimit: { type: "number", minimum: 1, maximum: 5 }, maxWorkers: { type: "number", minimum: 1, maximum: 20 },
    consoleModel: { type: "string" }, consoleEffort: { enum: ["low", "medium"] }, codexReservePercent: { type: "number", minimum: 5, maximum: 50 },
  } } },
  { name: "run-program-campaign", description: "Start or resume one durable Director-CFO program supervisor across finite coordinator slices and budget-campaign epochs. It accounts for every durable attempt across epochs, uses fixed conservative authority before a budget exists, then revision-fenced provisional and accepted plan budgets, persists recoverable capacity waits, and stops at the overall horizon, accepted-evidence no-progress limit, cancellation, user decision, or hard resource cap; it creates no LLM manager loop.", inputSchema: { type: "object", required: ["taskId"], properties: {
    taskId: { type: "string" }, awaitBoundarySeconds: { type: "number", minimum: 0, maximum: 120 }, maxRounds: { type: "number", minimum: 1, maximum: 50 }, maxMinutes: { type: "number", minimum: 1, maximum: 300 }, noProgressLimit: { type: "number", minimum: 1, maximum: 5 }, horizonHours: { type: "number", minimum: 1, maximum: 168 },
    programMaxEvents: { type: "number", minimum: 20, maximum: 5000 }, programMaxTokens: { type: "number", minimum: 1, maximum: 1000000000 }, programMaxDurationMs: { type: "number", minimum: 1000, maximum: 30000000000 }, programMaxAttempts: { type: "number", minimum: 1, maximum: 5000 },
    programMaxArtifacts: { type: "number", minimum: 10, maximum: 25000 }, programMaxArtifactBytes: { type: "number", minimum: 1048576, maximum: 2147483648 }, programMaxWorkers: { type: "number", minimum: 1, maximum: 20 }, programMaxGlobalWorkers: { type: "number", minimum: 1, maximum: 100 }, programMaxCampaigns: { type: "number", minimum: 1, maximum: 5000 },
  } } },
  { name: "program-report", description: "Emit one deduplicated material Director-CFO report with goal, milestone, accepted progress, blockers, budget, and next action. Unchanged state returns emit=false.", inputSchema: { type: "object", required: ["taskId"], properties: { taskId: { type: "string" } } } },
  { name: "start-task", description: "First AI Mobile call for one project or portfolio. Recovers bounded intent and capacity, keeps the visible Codex task as a zero-file lightweight console, and returns a dependency-ready work-plane unit for separate workers. It starts no UI, loop, Goal, automation, or heartbeat.", inputSchema: { type: "object", anyOf: [{ required: ["workspace"] }, { required: ["projects"] }], properties: {
    workspace: { type: "string" }, outcome: { type: "string" }, userRequest: { type: "string" }, outcomeAuthority: { enum: ["auto", "user"] }, acceptanceEvidence: ACCEPTANCE_SCHEMA, projects: { type: "array", minItems: 2, maxItems: 20, items: PROJECT_SCHEMA }, constraints: { type: "array", items: { type: "string" } }, minimumEvidenceLevel: { enum: EVIDENCE_LEVELS }, consoleModel: { type: "string" }, consoleEffort: { enum: ["low", "medium"] }, currentCodexModel: { type: "string", description: "Backward-compatible alias for consoleModel." }, currentModel: { type: "string" }, currentCodex: { type: "object", properties: { model: { type: "string" }, effort: { type: "string" } } }, codexReservePercent: { type: "number", minimum: 5, maximum: 50 }, horizonHours: { type: "number", minimum: 1, maximum: 24 }
  } } },
  { name: "reconcile-task", description: "Apply the latest correction to one task, or explicitly migrate one canonical legacy task in place to Director-CFO mode. Migration preserves accepted evidence, cancels stale workers, and never creates a duplicate task.", inputSchema: { type: "object", ...TASK_OR_PORTFOLIO, properties: {
    taskId: { type: "string" }, portfolioId: { type: "string" }, projectId: { type: "string" }, migrateToDirector: { type: "boolean" }, outcome: { type: "string" }, userRequest: { type: "string" }, outcomeAuthority: { enum: ["auto", "user"] }, acceptanceEvidence: PROGRAM_ACCEPTANCE_SCHEMA, constraints: { type: "array", items: { type: "string" } }, blockers: PROJECT_SCHEMA.properties.blockers, workGraph: PROJECT_SCHEMA.properties.workGraph, minimumEvidenceLevel: { enum: EVIDENCE_LEVELS }, refreshProjectContext: { type: "boolean" }, cancelActiveWorkers: { type: "boolean" }, sourceDescriptors: SOURCE_DESCRIPTORS_SCHEMA, authorization: { type: "object" }, projectContract: { oneOf: [{ type: "boolean" }, { type: "object" }] }, authorizedPermissions: { type: "array", items: { type: "string" } }, consoleModel: { type: "string" }, consoleEffort: { enum: ["low", "medium"] }, currentCodexModel: { type: "string", description: "Backward-compatible alias for consoleModel." }, codexReservePercent: { type: "number", minimum: 5, maximum: 50 }, campaignHours: { type: "number", minimum: 1, maximum: 4 }, noProgressLimit: { type: "number", minimum: 1, maximum: 5 }, maxWorkers: { type: "number", minimum: 1, maximum: 20 }
  } } },
  { name: "dispatch-round", description: "Allocate dependency-ready work-plane units to separate Codex CLI, Claude, Antigravity, or Cursor workers under global provider, quota, RAM, storage, ownership, and economic gates. The visible Codex console owns no project files. Omit workUnits to dispatch the coordinator's recommended critical-path unit.", inputSchema: { type: "object", ...TASK_OR_PORTFOLIO, properties: {
    taskId: { type: "string" }, portfolioId: { type: "string" }, horizonHours: { type: "number", minimum: 1, maximum: 24 }, currentCodex: { type: "object", description: "Optional console metadata only; project file ownership is rejected.", properties: { projectId: { type: "string" }, files: { type: "array", maxItems: 0, items: { type: "string" } }, priorityOverrideReason: { type: "string" } } }, workUnits: { type: "array", maxItems: 40, items: WORK_UNIT_SCHEMA }
  } } },
  { name: "run-task-cycle", description: "Start or reuse one finite event-driven coordinator for a task or portfolio. It returns immediately, opens no desktop UI, watches worker state changes without an LLM manager loop, and performs one-time collection, structured observation acceptance, deterministic integration, and next dispatch under round, time, resource, and no-progress caps.", inputSchema: { type: "object", ...TASK_OR_PORTFOLIO, properties: { taskId: { type: "string" }, portfolioId: { type: "string" }, maxRounds: { type: "number", minimum: 1, maximum: 50 }, maxMinutes: { type: "number", minimum: 1, maximum: 300 }, noProgressLimit: { type: "number", minimum: 1, maximum: 5 }, horizonHours: { type: "number", minimum: 1, maximum: 24 } } } },
  { name: "collect-round", description: "Collect one finite task or portfolio round at an integration point, persist compact patches/evidence, and immediately clean collected editing worktrees.", inputSchema: { type: "object", required: ["roundId"], ...TASK_OR_PORTFOLIO, properties: { taskId: { type: "string" }, portfolioId: { type: "string" }, roundId: { type: "string" }, waitSeconds: { type: "number", minimum: 0, maximum: 300 }, detail: { enum: ["compact", "full"] } } } },
  { name: "integrate-round", description: "Deterministically integrate completed isolated worker patches once. It enforces writer boundaries, refuses conflicts with current primary changes, requires verification commands, rolls back failed verification, records sufficient integration evidence, and uses no review model.", inputSchema: { type: "object", required: ["roundId"], ...TASK_OR_PORTFOLIO, properties: { taskId: { type: "string" }, portfolioId: { type: "string" }, roundId: { type: "string" } } } },
  { name: "record-evidence", description: "Record concrete acceptance evidence against one task or the named project inside a portfolio. Evidence never crosses project boundaries.", inputSchema: { type: "object", required: ["evidence"], ...TASK_OR_PORTFOLIO, properties: { taskId: { type: "string" }, portfolioId: { type: "string" }, evidence: { type: "array", minItems: 1, maxItems: 40, items: { type: "object", required: ["requirementId", "level", "ref", "summary", "passed"], properties: { projectId: { type: "string" }, requirementId: { type: "string" }, workGraphNodeId: { type: "string" }, level: { enum: EVIDENCE_LEVELS }, ref: { type: "string" }, summary: { type: "string" }, passed: { type: "boolean" } } } } } } },
  { name: "task-summary", description: "Return one compact evidence-based task or portfolio summary. This explicit diagnostic is not a heartbeat or polling surface.", inputSchema: { type: "object", ...TASK_OR_PORTFOLIO, properties: { taskId: { type: "string" }, portfolioId: { type: "string" } } } },
  { name: "material-status", description: "Read the current durable coordinator state and recent deduplicated material transitions only. It performs no provider probe, project scan, dispatch, polling loop, UI launch, or state mutation.", inputSchema: { type: "object", ...TASK_OR_PORTFOLIO, properties: { taskId: { type: "string" }, portfolioId: { type: "string" }, maxEvents: { type: "number", minimum: 1, maximum: 50 } } } },
  { name: "complete-task", description: "Complete a task, each portfolio project, and finally the portfolio only from its own sufficient acceptance evidence.", inputSchema: { type: "object", ...TASK_OR_PORTFOLIO, properties: { taskId: { type: "string" }, portfolioId: { type: "string" } } } },
  { name: "cancel-task", description: "Cancel finite workers, release machine leases, and clean editing worktrees for one task or portfolio.", inputSchema: { type: "object", ...TASK_OR_PORTFOLIO, properties: { taskId: { type: "string" }, portfolioId: { type: "string" } } } },
  { name: "resource-inventory", description: "Passive diagnostic capacity inventory. It never opens provider desktop applications.", inputSchema: { type: "object", properties: { refresh: { type: "boolean" }, detail: { enum: ["compact", "full"] }, horizonHours: { type: "number", minimum: 1, maximum: 24 } } } },
  { name: "provider-diagnostics", description: "Privacy-safe headless provider diagnostics. Reports executable, authentication, billing mode, models, quota/reset evidence, callable capabilities, config-variable names/presence, and typed failures without returning secrets. A minimal read-only canary runs only when runCanary is explicitly true.", inputSchema: { type: "object", properties: { refresh: { type: "boolean" }, providerIds: { type: "array", maxItems: 4, items: { enum: ["codex", "claude", "antigravity", "cursor"] } }, runCanary: { type: "boolean" }, canaryProvider: { enum: ["codex", "claude", "antigravity", "cursor"] } } } },
  { name: "orchestrator-profile", description: "Read or update private local provider, model, reserve, efficiency, and communication preferences. It starts no workers or applications.", inputSchema: { type: "object", properties: { action: { enum: ["read", "update"] }, patch: { type: "object" } } } },
  { name: "prepare-restart-handoff", description: "Persist one authorized restart boundary for the exact Codex task. The launcher verifies both runtime version and build fingerprint, then resumes or migrates the same durable Director-CFO task and starts one finite program campaign.", inputSchema: { type: "object", required: ["taskId", "workspace", "nextAction", "resumeModel"], properties: {
    taskId: { type: "string" }, threadId: { type: "string" }, workspace: { type: "string" }, migrateToDirector: { type: "boolean" },
    verificationModel: { type: "string" }, verificationEffort: { enum: ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] },
    resumeModel: { type: "string" }, resumeEffort: { enum: ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] },
    outcome: { type: "string" }, latestUserRequest: { type: "string" }, nextAction: { type: "string" },
    constraints: { type: "array", items: { type: "string" } }, projectContract: { oneOf: [{ type: "boolean" }, { type: "object" }] },
    sourceDescriptors: SOURCE_DESCRIPTORS_SCHEMA, authorization: { type: "object" }, authorizedPermissions: { type: "array", items: { type: "string" } },
    codexReservePercent: { type: "number", minimum: 5, maximum: 50 }, maxRounds: { type: "number", minimum: 1, maximum: 50 },
    maxMinutes: { type: "number", minimum: 1, maximum: 300 }, noProgressLimit: { type: "number", minimum: 1, maximum: 5 }, horizonHours: { type: "number", minimum: 1, maximum: 168 },
    priorities: { type: "array", items: { type: "string" } }, cleanupPluginIds: { type: "array", maxItems: 5, items: { type: "string" } }, userAuthorized: { type: "boolean" },
  } } },
];

function content(value, isError = false) { return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], isError }; }

async function waitForCampaignBoundary(taskId, executionId, baselineEventIds, seconds) {
  const waitMs = Math.max(0, Math.min(120000, Math.floor(Number(seconds || 0) * 1000)));
  if (!waitMs) return null;
  const deadline = Date.now() + waitMs;
  const ignoredTypes = new Set(["coordinator.started", "campaign.woke"]);
  while (Date.now() < deadline) {
    const events = readMaterialEvents({ taskId, maxEvents: 50 }).events;
    const boundary = events.find((event) => (
      !baselineEventIds.has(event.eventId)
      && (!executionId || event.executionId === executionId)
      && !ignoredTypes.has(event.type)
    ));
    if (boundary) return boundary;
    await new Promise((resolve) => setTimeout(resolve, Math.min(250, Math.max(1, deadline - Date.now()))));
  }
  return null;
}

async function invoke(name, args = {}, entrypoint) {
  assertCurrentRuntime();
  if (name === "prepare-restart-handoff") return { runtimeVersion: pluginVersion(), runtimeFingerprint: runtimeFingerprint(), ...createRestartHandoff(args) };
  if (name === "orchestrator-profile") return args.action === "update" ? writeProfile(args.patch || {}) : readProfile();
  if (name === "start-program") {
    const resources = await inventory({ refresh: false });
    const started = startDirectorProgram(args, resources);
    return started.taskId ? { runtimeVersion: pluginVersion(), ...started, program: directorProgramSummary(started.taskId) } : { runtimeVersion: pluginVersion(), ...started };
  }
  if (name === "run-program-campaign") {
    if (!directorProgramSummary(args.taskId)) throw new Error("run-program-campaign requires a Director-CFO taskId.");
    const baselineEventIds = new Set(readMaterialEvents({ taskId: args.taskId, maxEvents: 50 }).events.map((event) => event.eventId));
    const launched = await runTaskCycle({ ...args, campaignSupervisor: true }, entrypoint);
    const firstBoundary = await waitForCampaignBoundary(args.taskId, launched.executionId, baselineEventIds, args.awaitBoundarySeconds);
    return {
      runtimeVersion: pluginVersion(),
      ...launched,
      firstBoundary,
      boundaryWaitExpired: Number(args.awaitBoundarySeconds || 0) > 0 && !firstBoundary,
      program: directorProgramSummary(args.taskId),
    };
  }
  if (name === "program-report") return { runtimeVersion: pluginVersion(), taskId: args.taskId, ...emitProgramReport(args.taskId), program: directorProgramSummary(args.taskId) };
  if (name === "start-task") {
    const resources = await inventory({ refresh: false });
    return { runtimeVersion: pluginVersion(), ...startTask(args, resources) };
  }
  if (name === "reconcile-task") {
    if (args.migrateToDirector === true) {
      const resources = await inventory({ refresh: false });
      const migrated = migrateLegacyTaskToDirector(args, resources);
      return { runtimeVersion: pluginVersion(), taskId: migrated.taskId, migrated: true, program: directorProgramSummary(migrated.taskId) };
    }
    return { runtimeVersion: pluginVersion(), ...reconcileTask(args) };
  }
  if (name === "dispatch-round") {
    const resources = await inventory({ forDispatch: true });
    return { runtimeVersion: pluginVersion(), ...dispatchRound(args, resources, providerHistory(), (contract) => createJob(contract, entrypoint)) };
  }
  if (name === "run-task-cycle") return { runtimeVersion: pluginVersion(), ...await runTaskCycle(args, entrypoint) };
  if (name === "collect-round") return collectRound(args);
  if (name === "integrate-round") return integrateRound(args);
  if (name === "record-evidence") return recordEvidence(args);
  if (name === "task-summary") return taskSummary(args);
  if (name === "material-status") return { runtimeVersion: pluginVersion(), ...coordinatorStatus(args) };
  if (name === "complete-task") return completeTask(args);
  if (name === "cancel-task") { requestCoordinatorCancel(args); return cancelTask(args); }
  if (name === "provider-diagnostics") return { runtimeVersion: pluginVersion(), ...await providerDiagnostics(args) };
  if (name === "resource-inventory") {
    const value = await inventory({ refresh: args.refresh === true });
    const base = { runtimeVersion: pluginVersion(), runtimeFingerprint: runtimeFingerprint(), generatedAt: value.generatedAt, cached: value.cached, passive: true, horizonHours: Math.max(1, Math.min(24, Number(args.horizonHours || 5))), machine: value.machine || null, providers: compactCapacity(value), leases: resourceLeaseSnapshot(), worktreeStorage: value.worktreeStorage || storageStatus() };
    return args.detail === "full" ? { ...value, ...base, providers: value.providers } : base;
  }
  throw new Error(`Unknown tool: ${name}`);
}

function handle(message, entrypoint) {
  if (!message || message.id === undefined) return null;
  try {
    if (message.method === "initialize") return { jsonrpc: "2.0", id: message.id, result: { protocolVersion: message.params?.protocolVersion || "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "ai-mobile-local", version: pluginVersion() } } };
    if (message.method === "tools/list") return { jsonrpc: "2.0", id: message.id, result: { tools: TOOLS } };
    if (message.method === "tools/call") return invoke(message.params?.name, message.params?.arguments || {}, entrypoint)
      .then((value) => ({ jsonrpc: "2.0", id: message.id, result: content(value) }))
      .catch((error) => ({ jsonrpc: "2.0", id: message.id, result: content({ error: error.message }, true) }));
    return { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `Method not found: ${message.method}` } };
  } catch (error) {
    return { jsonrpc: "2.0", id: message.id, result: content({ error: error.message }, true) };
  }
}

function serve(entrypoint) {
  cleanupAbandonedJobs();
  cleanupStaleLeases();
  cleanupAbandonedWorktrees();
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  input.on("line", async (line) => {
    if (!line.trim()) return;
    let message;
    try { message = JSON.parse(line); } catch { return; }
    const response = await Promise.resolve(handle(message, entrypoint));
    if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
  });
}

module.exports = { TOOLS, handle, invoke, serve };
