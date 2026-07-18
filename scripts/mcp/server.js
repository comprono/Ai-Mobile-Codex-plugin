"use strict";

const readline = require("node:readline");
const { inventory } = require("../core/capacity");
const { createJob } = require("../core/job-store");
const { providerHistory } = require("../core/provider-history");
const { cancelTask, collectRound, compactCapacity, completeTask, dispatchRound, integrateRound, reconcileTask, recordEvidence, startTask, taskSummary } = require("../core/task-orchestrator");
const { cleanupStaleLeases, resourceLeaseSnapshot } = require("../core/resource-leases");
const { cleanupAbandonedWorktrees, storageStatus } = require("../core/workspace-isolation");
const { readProfile, writeProfile } = require("../lib/orchestrator-profile");
const { assertCurrentRuntime, pluginVersion } = require("../lib/version");

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
  },
};

const ACCEPTANCE_SCHEMA = { type: "array", minItems: 1, maxItems: 12, items: { oneOf: [{ type: "string" }, { type: "object", required: ["description"], properties: { description: { type: "string" }, required: { type: "boolean" }, minimumEvidenceLevel: { enum: EVIDENCE_LEVELS } } }] } };
const PROJECT_SCHEMA = { type: "object", required: ["workspace"], properties: {
  projectId: { type: "string" }, workspace: { type: "string" }, outcome: { type: "string" }, acceptanceEvidence: ACCEPTANCE_SCHEMA,
  userRequest: { type: "string" }, outcomeAuthority: { enum: ["auto", "user"] },
  constraints: { type: "array", items: { type: "string" } }, priority: { type: "number", minimum: 1, maximum: 100 },
  blockers: { type: "array", items: { oneOf: [{ type: "string" }, { type: "object", properties: { id: { type: "string" }, description: { type: "string" }, resolved: { type: "boolean" } } }] } },
  workGraph: { type: "array", items: { type: "object", required: ["goal"], properties: { id: { type: "string" }, goal: { type: "string" }, dependsOn: { type: "array", items: { type: "string" } }, priority: { type: "number", minimum: 1, maximum: 100 }, state: { enum: ["pending", "running", "awaiting-evidence", "completed", "blocked"] } } } },
} };
const TASK_OR_PORTFOLIO = { anyOf: [{ required: ["taskId"] }, { required: ["portfolioId"] }] };

const TOOLS = [
  { name: "start-task", description: "First AI Mobile call for one project or portfolio. Recovers bounded intent and capacity, keeps the visible Codex task as a zero-file lightweight console, and returns a dependency-ready work-plane unit for separate workers. It starts no UI, loop, Goal, automation, or heartbeat.", inputSchema: { type: "object", anyOf: [{ required: ["workspace"] }, { required: ["projects"] }], properties: {
    workspace: { type: "string" }, outcome: { type: "string" }, userRequest: { type: "string" }, outcomeAuthority: { enum: ["auto", "user"] }, acceptanceEvidence: ACCEPTANCE_SCHEMA, projects: { type: "array", minItems: 2, maxItems: 20, items: PROJECT_SCHEMA }, constraints: { type: "array", items: { type: "string" } }, minimumEvidenceLevel: { enum: EVIDENCE_LEVELS }, consoleModel: { type: "string" }, consoleEffort: { enum: ["low", "medium"] }, currentCodexModel: { type: "string", description: "Backward-compatible alias for consoleModel." }, currentModel: { type: "string" }, currentCodex: { type: "object", properties: { model: { type: "string" }, effort: { type: "string" } } }, codexReservePercent: { type: "number", minimum: 5, maximum: 50 }, horizonHours: { type: "number", minimum: 1, maximum: 24 }
  } } },
  { name: "reconcile-task", description: "Apply the latest user correction or refreshed project contract to the existing task. It invalidates stale dependent state, safely cancels stale workers by default, preserves matching acceptance evidence, and returns the next owned action.", inputSchema: { type: "object", ...TASK_OR_PORTFOLIO, properties: {
    taskId: { type: "string" }, portfolioId: { type: "string" }, projectId: { type: "string" }, outcome: { type: "string" }, userRequest: { type: "string" }, outcomeAuthority: { enum: ["auto", "user"] }, acceptanceEvidence: ACCEPTANCE_SCHEMA, constraints: { type: "array", items: { type: "string" } }, blockers: PROJECT_SCHEMA.properties.blockers, workGraph: PROJECT_SCHEMA.properties.workGraph, minimumEvidenceLevel: { enum: EVIDENCE_LEVELS }, refreshProjectContext: { type: "boolean" }, cancelActiveWorkers: { type: "boolean" }, consoleModel: { type: "string" }, consoleEffort: { enum: ["low", "medium"] }, currentCodexModel: { type: "string", description: "Backward-compatible alias for consoleModel." }, codexReservePercent: { type: "number", minimum: 5, maximum: 50 }
  } } },
  { name: "dispatch-round", description: "Allocate dependency-ready work-plane units to separate Codex CLI, Claude, Antigravity, or Cursor workers under global provider, quota, RAM, storage, ownership, and economic gates. The visible Codex console owns no project files. Omit workUnits to dispatch the coordinator's recommended critical-path unit.", inputSchema: { type: "object", ...TASK_OR_PORTFOLIO, properties: {
    taskId: { type: "string" }, portfolioId: { type: "string" }, horizonHours: { type: "number", minimum: 1, maximum: 24 }, currentCodex: { type: "object", description: "Optional console metadata only; project file ownership is rejected.", properties: { projectId: { type: "string" }, files: { type: "array", maxItems: 0, items: { type: "string" } }, priorityOverrideReason: { type: "string" } } }, workUnits: { type: "array", maxItems: 40, items: WORK_UNIT_SCHEMA }
  } } },  { name: "collect-round", description: "Collect one finite task or portfolio round at an integration point, persist compact patches/evidence, and immediately clean collected editing worktrees.", inputSchema: { type: "object", required: ["roundId"], ...TASK_OR_PORTFOLIO, properties: { taskId: { type: "string" }, portfolioId: { type: "string" }, roundId: { type: "string" }, waitSeconds: { type: "number", minimum: 0, maximum: 300 }, detail: { enum: ["compact", "full"] } } } },
  { name: "integrate-round", description: "Deterministically integrate completed isolated worker patches once. It enforces writer boundaries, refuses conflicts with current primary changes, requires verification commands, rolls back failed verification, records sufficient integration evidence, and uses no review model.", inputSchema: { type: "object", required: ["roundId"], ...TASK_OR_PORTFOLIO, properties: { taskId: { type: "string" }, portfolioId: { type: "string" }, roundId: { type: "string" } } } },
  { name: "record-evidence", description: "Record concrete acceptance evidence against one task or the named project inside a portfolio. Evidence never crosses project boundaries.", inputSchema: { type: "object", required: ["evidence"], ...TASK_OR_PORTFOLIO, properties: { taskId: { type: "string" }, portfolioId: { type: "string" }, evidence: { type: "array", minItems: 1, maxItems: 40, items: { type: "object", required: ["requirementId", "level", "ref", "summary", "passed"], properties: { projectId: { type: "string" }, requirementId: { type: "string" }, workGraphNodeId: { type: "string" }, level: { enum: EVIDENCE_LEVELS }, ref: { type: "string" }, summary: { type: "string" }, passed: { type: "boolean" } } } } } } },
  { name: "task-summary", description: "Return one compact evidence-based task or portfolio summary. This explicit diagnostic is not a heartbeat or polling surface.", inputSchema: { type: "object", ...TASK_OR_PORTFOLIO, properties: { taskId: { type: "string" }, portfolioId: { type: "string" } } } },
  { name: "complete-task", description: "Complete a task, each portfolio project, and finally the portfolio only from its own sufficient acceptance evidence.", inputSchema: { type: "object", ...TASK_OR_PORTFOLIO, properties: { taskId: { type: "string" }, portfolioId: { type: "string" } } } },
  { name: "cancel-task", description: "Cancel finite workers, release machine leases, and clean editing worktrees for one task or portfolio.", inputSchema: { type: "object", ...TASK_OR_PORTFOLIO, properties: { taskId: { type: "string" }, portfolioId: { type: "string" } } } },
  { name: "resource-inventory", description: "Passive diagnostic capacity inventory. It never opens provider desktop applications.", inputSchema: { type: "object", properties: { refresh: { type: "boolean" }, detail: { enum: ["compact", "full"] }, horizonHours: { type: "number", minimum: 1, maximum: 24 } } } },
  { name: "orchestrator-profile", description: "Read or update private local provider, model, reserve, efficiency, and communication preferences. It starts no workers or applications.", inputSchema: { type: "object", properties: { action: { enum: ["read", "update"] }, patch: { type: "object" } } } },
  { name: "prepare-restart-handoff", description: "Persist one authorized restart boundary for the exact Codex task. The one-shot launcher refreshes AI Mobile, uses the official local Codex app-server to verify the fresh runtime on a capable model, then starts the same task on the requested lightweight model and reopens only OpenAI.Codex.", inputSchema: { type: "object", required: ["workspace", "nextAction", "resumeModel"], properties: { taskId: { type: "string" }, threadId: { type: "string" }, workspace: { type: "string" }, verificationModel: { type: "string" }, verificationEffort: { enum: ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] }, resumeModel: { type: "string" }, resumeEffort: { enum: ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] }, outcome: { type: "string" }, latestUserRequest: { type: "string" }, nextAction: { type: "string" }, priorities: { type: "array", items: { type: "string" } }, cleanupPluginIds: { type: "array", maxItems: 5, items: { type: "string" } }, userAuthorized: { type: "boolean" } } } },
];

function content(value, isError = false) { return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], isError }; }

async function invoke(name, args = {}, entrypoint) {
  assertCurrentRuntime();
  if (name === "orchestrator-profile") return args.action === "update" ? writeProfile(args.patch || {}) : readProfile();
  if (name === "start-task") {
    const resources = await inventory({ refresh: false });
    return { runtimeVersion: pluginVersion(), ...startTask(args, resources) };
  }
  if (name === "reconcile-task") return { runtimeVersion: pluginVersion(), ...reconcileTask(args) };
  if (name === "dispatch-round") {
    const resources = await inventory({ forDispatch: true });
    return { runtimeVersion: pluginVersion(), ...dispatchRound(args, resources, providerHistory(), (contract) => createJob(contract, entrypoint)) };
  }
  if (name === "collect-round") return collectRound(args);
  if (name === "integrate-round") return integrateRound(args);
  if (name === "record-evidence") return recordEvidence(args);
  if (name === "task-summary") return taskSummary(args);
  if (name === "complete-task") return completeTask(args);
  if (name === "cancel-task") return cancelTask(args);
  if (name === "prepare-restart-handoff") return { runtimeVersion: pluginVersion(), ...createRestartHandoff(args) };
  if (name === "resource-inventory") {
    const value = await inventory({ refresh: args.refresh === true });
    const base = { runtimeVersion: pluginVersion(), generatedAt: value.generatedAt, cached: value.cached, passive: true, horizonHours: Math.max(1, Math.min(24, Number(args.horizonHours || 5))), machine: value.machine || null, providers: compactCapacity(value), leases: resourceLeaseSnapshot(), worktreeStorage: storageStatus() };
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
