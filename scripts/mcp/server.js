"use strict";

const readline = require("node:readline");
const path = require("node:path");
const { inventory } = require("../core/capacity");
const { cancelJob, createJob, jobDirectory, readJob } = require("../core/job-store");
const { route } = require("../core/router");
const { runVerification } = require("../core/verification");
const { readJson, safeWorkspace } = require("../core/utils");
const { readProfile, writeProfile } = require("../lib/orchestrator-profile");

const TOOLS = [
  { name: "orchestrator-profile", description: "Read or update private local routing preferences. Does not start workers or applications.", inputSchema: { type: "object", properties: { action: { enum: ["read", "update"] }, patch: { type: "object" } } } },
  { name: "resource-inventory", description: "Passively inspect authenticated local AI CLIs and known capacity evidence. Never opens desktop applications.", inputSchema: { type: "object", properties: { refresh: { type: "boolean" }, detail: { enum: ["compact", "full"] } } } },
  { name: "run-efficient-task", description: "Economically route and immediately dispatch one finite independent lane. Returns direct when delegation would cost more than it saves.", inputSchema: { type: "object", required: ["workspace", "goal"], properties: {
    workspace: { type: "string" }, projectGoal: { type: "string" }, goal: { type: "string" }, acceptanceCriteria: { type: "array", items: { type: "string" } }, nextStep: { type: "string" },
    preferredProvider: { enum: ["auto", "codex", "claude", "antigravity", "cursor"] }, readOnly: { type: "boolean" }, expectedFiles: { type: "array", items: { type: "string" } },
    verificationCommands: { type: "array", items: { type: "object", required: ["command"], properties: { name: { type: "string" }, command: { type: "string" }, args: { type: "array", items: { type: "string" } }, timeoutSeconds: { type: "number" }, expectedExitCode: { type: "number" } } } },
    timeoutSeconds: { type: "number" }, complexity: { enum: ["small", "medium", "large"] }, model: { type: "string" }, effort: { type: "string" }, allowAntigravity: { type: "boolean" }, needsUi: { type: "boolean" }, projectId: { type: "string" }, conversation: { type: "string" }, mode: { type: "string" }
  } } },
  { name: "read-job", description: "Read one compact terminal result at the natural integration point. Legacy artifacts remain readable.", inputSchema: { type: "object", required: ["workspace", "jobId"], properties: { workspace: { type: "string" }, jobId: { type: "string" }, detail: { enum: ["compact", "full"] } } } },
  { name: "verify-job", description: "Run deterministic no-model verification for one completed job using its declared command allowlist.", inputSchema: { type: "object", required: ["workspace", "jobId"], properties: { workspace: { type: "string" }, jobId: { type: "string" }, commands: { type: "array", items: { type: "object" } } } } },
  { name: "cancel-job", description: "Cancel one finite worker process tree. Does not affect other jobs or applications.", inputSchema: { type: "object", required: ["workspace", "jobId"], properties: { workspace: { type: "string" }, jobId: { type: "string" } } } },
];

function content(value, isError = false) { return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], isError }; }
function invoke(name, args = {}, entrypoint) {
  if (name === "orchestrator-profile") return args.action === "update" ? writeProfile(args.patch || {}) : readProfile();
  if (name === "resource-inventory") {
    const value = inventory({ refresh: args.refresh === true });
    return args.detail === "full" ? value : { generatedAt: value.generatedAt, cached: value.cached, passive: true, providers: Object.fromEntries(Object.entries(value.providers).map(([id, item]) => [id, { available: item.available, authenticated: item.authenticated, version: item.version || "", authMode: item.authMode || "unknown", confidence: item.confidence, models: item.models || [], capacity: item.capacity, reason: item.reason || "" }])) };
  }
  if (name === "run-efficient-task") {
    const workspace = safeWorkspace(args.workspace);
    const resources = inventory({ refresh: false });
    const decision = route({ ...args, workspace }, resources);
    if (decision.action === "direct") return { dispatched: false, action: "current-codex", reason: decision.reason, instruction: "Continue this lane directly; no worker was started." };
    return { dispatched: true, decision: { provider: decision.provider, reason: decision.reason }, ...createJob({ ...decision.request, workspace, provider: decision.provider, providerCommand: resources.providers[decision.provider].command }, entrypoint), collection: "Read once at the integration point or after the declared timeout." };
  }
  if (name === "read-job") return readJob(args.workspace, args.jobId, args.detail || "compact");
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
    if (message.method === "initialize") return { jsonrpc: "2.0", id: message.id, result: { protocolVersion: message.params?.protocolVersion || "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "ai-mobile-local", version: "0.4.0" } } };
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
