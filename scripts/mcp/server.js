"use strict";

const readline = require("node:readline");
const path = require("node:path");
const { inventory } = require("../core/capacity");
const { cancelJob, createJob, jobDirectory, readJob } = require("../core/job-store");
const { providerHistory } = require("../core/provider-history");
const { compactCapacity, orchestrateTask } = require("../core/task-orchestrator");
const { runVerification } = require("../core/verification");
const { readJson, safeWorkspace } = require("../core/utils");
const { readProfile, writeProfile } = require("../lib/orchestrator-profile");
const { assertCurrentRuntime, pluginVersion } = require("../lib/version");

const TOOLS = [
  { name: "orchestrate-task", description: "MANDATORY FIRST tool after an explicit @ai-mobile project request. Before any project shell, file, browser, or runtime action, create one finite execution contract, inventory capacity, keep Codex on a concrete critical path, and route one or two independent candidate lanes. This is not a manager loop.", inputSchema: { type: "object", required: ["workspace", "rootOutcome", "completionEvidence", "currentCodexGoal", "candidateLanes"], properties: {
    workspace: { type: "string" }, rootOutcome: { type: "string" }, completionEvidence: { type: "array", minItems: 1, maxItems: 12, items: { type: "string" } }, blockingConditions: { type: "array", maxItems: 8, items: { type: "string" } }, currentCodexGoal: { type: "string" }, currentCodexFiles: { type: "array", items: { type: "string" } }, currentCodexAcceptanceCriteria: { type: "array", items: { type: "string" } }, allowAntigravity: { type: "boolean" }, horizonHours: { type: "number", minimum: 1, maximum: 24 },
    candidateLanes: { type: "array", minItems: 1, maxItems: 2, items: { type: "object", required: ["goal", "independenceReason", "relevantFiles"], properties: {
      goal: { type: "string" }, independenceReason: { type: "string" }, relevantFiles: { type: "array", minItems: 1, items: { type: "string" } }, acceptanceCriteria: { type: "array", items: { type: "string" } }, collectAt: { type: "string" }, preferredProvider: { enum: ["auto", "codex", "claude", "antigravity", "cursor"] }, selectionAuthority: { enum: ["router", "user"], description: "\"user\" only when the user explicitly mandated this lane's provider/model; hard gates still apply but economics only warn." }, readOnly: { type: "boolean" }, expectedFiles: { type: "array", items: { type: "string" } }, verificationCommands: { type: "array", items: { type: "object" } }, timeoutSeconds: { type: "number" }, complexity: { enum: ["small", "medium", "large"] }, taskKind: { enum: ["architecture", "browser", "code", "debug", "docs", "generic", "live-state", "repository-scan", "research", "review", "tests"] }, model: { type: "string" }, effort: { type: "string" }, allowAntigravity: { type: "boolean" }, allowPaidApi: { type: "boolean" }, allowPremiumModel: { type: "boolean" }, needsUi: { type: "boolean" }, projectId: { type: "string" }, conversation: { type: "string" }, estimatedDirectTokens: { type: "number" }, maxWorkerOutputTokens: { type: "number" }, maxApiBudgetUsd: { type: "number" }, minimumSavingsPercent: { type: "number" }
    } } }
  } } },
  { name: "read-job", description: "Collect one compact result at the natural integration point. Can wait internally for up to 60 seconds without repeated model-side polling. Legacy artifacts remain readable.", inputSchema: { type: "object", required: ["workspace", "jobId"], properties: { workspace: { type: "string" }, jobId: { type: "string" }, detail: { enum: ["compact", "full"] }, waitSeconds: { type: "number", minimum: 0, maximum: 60 } } } },
  { name: "verify-job", description: "Run deterministic no-model verification for one completed job using its declared command allowlist.", inputSchema: { type: "object", required: ["workspace", "jobId"], properties: { workspace: { type: "string" }, jobId: { type: "string" }, commands: { type: "array", items: { type: "object" } } } } },
  { name: "cancel-job", description: "Cancel one finite worker process tree. Does not affect other jobs or applications.", inputSchema: { type: "object", required: ["workspace", "jobId"], properties: { workspace: { type: "string" }, jobId: { type: "string" } } } },
  { name: "resource-inventory", description: "Diagnostic-only passive capacity view. Do not use this to begin an @ai-mobile project; orchestrate-task already inventories capacity in its mandatory first call.", inputSchema: { type: "object", properties: { refresh: { type: "boolean" }, detail: { enum: ["compact", "full"] }, workspace: { type: "string" }, horizonHours: { type: "number" } } } },
  { name: "orchestrator-profile", description: "Read or update private local routing preferences. Does not start workers or applications.", inputSchema: { type: "object", properties: { action: { enum: ["read", "update"] }, patch: { type: "object" } } } },
];

function content(value, isError = false) { return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], isError }; }
function invoke(name, args = {}, entrypoint) {
  assertCurrentRuntime();
  if (name === "orchestrator-profile") return args.action === "update" ? writeProfile(args.patch || {}) : readProfile();
  if (name === "orchestrate-task") {
    const workspace = safeWorkspace(args.workspace);
    const resources = inventory({ refresh: false });
    return {
      runtimeVersion: pluginVersion(),
      ...orchestrateTask({ ...args, workspace }, resources, providerHistory(workspace), (contract) => createJob(contract, entrypoint)),
    };
  }
  if (name === "resource-inventory") {
    const value = inventory({ refresh: args.refresh === true });
    const workspace = args.workspace ? safeWorkspace(args.workspace) : null;
    const history = workspace ? providerHistory(workspace) : null;
    const compact = compactCapacity(value);
    for (const [id, row] of Object.entries(compact)) row.recentOutcome = history?.[id] || null;
    const base = { runtimeVersion: pluginVersion(), generatedAt: value.generatedAt, cached: value.cached, passive: true, horizonHours: Math.max(1, Math.min(24, Number(args.horizonHours || 5))), providers: compact };
    return args.detail === "full" ? { ...value, ...base, providers: value.providers } : base;
  }
  if (name === "read-job") return readJob(args.workspace, args.jobId, args.detail || "compact", args.waitSeconds || 0);
  if (name === "verify-job") {
    const workspace = safeWorkspace(args.workspace);
    const dir = jobDirectory(workspace, args.jobId);
    const contract = readJson(path.join(dir, "contract.json"), {});
    return runVerification(workspace, dir, Array.isArray(args.commands) ? args.commands : contract.verificationCommands || []);
  }
  if (name === "cancel-job") return cancelJob(args.workspace, args.jobId);
  throw new Error(`Unknown tool: ${name}`);
}

function handle(message, entrypoint) {
  if (!message || message.id === undefined) return null;
  try {
    if (message.method === "initialize") return { jsonrpc: "2.0", id: message.id, result: { protocolVersion: message.params?.protocolVersion || "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "ai-mobile-local", version: pluginVersion() } } };
    if (message.method === "tools/list") return { jsonrpc: "2.0", id: message.id, result: { tools: TOOLS } };
    if (message.method === "tools/call") return { jsonrpc: "2.0", id: message.id, result: content(invoke(message.params?.name, message.params?.arguments || {}, entrypoint)) };
    return { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `Method not found: ${message.method}` } };
  } catch (error) {
    return { jsonrpc: "2.0", id: message.id, result: content({ error: error.message }, true) };
  }
}

function serve(entrypoint) {
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  input.on("line", (line) => {
    if (!line.trim()) return;
    let message;
    try { message = JSON.parse(line); } catch { return; }
    const response = handle(message, entrypoint);
    if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
  });
}

module.exports = { TOOLS, handle, invoke, serve };
