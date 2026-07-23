#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const { spawn } = require("node:child_process");

const MAX_LINE_BYTES = 4 * 1024 * 1024;
const MAX_STDERR_BYTES = 32 * 1024;
const MAX_NOTIFICATION_RING = 200;
const MAX_TURN_NOTIFICATIONS = 10_000;
const MAX_TOOL_RESULT_TEXT_BYTES = 1024 * 1024;
const AI_MOBILE_DYNAMIC_NAMESPACE = "mcp__ai_mobile_local";
const AI_MOBILE_DYNAMIC_TOOLS = new Map([
  ["start_program", "startprogram"],
  ["run_program_campaign", "runprogramcampaign"],
  ["program_report", "programreport"],
  ["start_task", "starttask"],
  ["reconcile_task", "reconciletask"],
  ["dispatch_round", "dispatchround"],
  ["run_task_cycle", "runtaskcycle"],
  ["collect_round", "collectround"],
  ["integrate_round", "integrateround"],
  ["record_evidence", "recordevidence"],
  ["task_summary", "tasksummary"],
  ["material_status", "materialstatus"],
  ["complete_task", "completetask"],
  ["cancel_task", "canceltask"],
  ["resource_inventory", "resourceinventory"],
  ["provider_diagnostics", "providerdiagnostics"],
  ["orchestrator_profile", "orchestratorprofile"],
  ["prepare_restart_handoff", "preparerestarthandoff"],
]);


function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith("--")) continue;
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error("Missing value for " + key + ".");
    values[key.slice(2)] = value;
    index += 1;
  }
  return values;
}

function readHandoff(file) {
  const handoff = JSON.parse(fs.readFileSync(file, "utf8"));
  if (handoff.schemaVersion !== 4) {
    throw new Error("App-server continuation requires a version 4 restart handoff.");
  }
  if (handoff.oneShot !== true || handoff.userAuthorized !== true || !handoff.consumedAt) {
    throw new Error("App-server continuation requires a consumed, authorized, one-shot handoff.");
  }
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(String(handoff.threadId || ""))) {
    throw new Error("The restart handoff has an invalid Codex thread id.");
  }
  if (!handoff.workspace || !fs.statSync(handoff.workspace).isDirectory()) {
    throw new Error("The restart handoff workspace is unavailable.");
  }
  if (!/^[0-9]+.[0-9]+.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$/.test(String(handoff.expectedRuntimeVersion || ""))) {
    throw new Error("The restart handoff has no exact expected runtime version.");
  }
  if (!/^[a-f0-9]{64}$/i.test(String(handoff.expectedRuntimeFingerprint || ""))) {
    throw new Error("The restart handoff has no exact expected runtime fingerprint.");
  }
  if (!/^task-[A-Za-z0-9._-]{8,100}$/.test(String(handoff.taskId || ""))) {
    throw new Error("The restart handoff has no exact durable task id.");
  }
  if (!new Set(["resume-program", "migrate-program"]).has(handoff.handoffMode)) {
    throw new Error("The restart handoff has an invalid continuation mode.");
  }
  if (handoff.campaignContract?.taskId !== handoff.taskId) {
    throw new Error("The restart campaign contract does not match the durable task id.");
  }
  if (handoff.handoffMode === "resume-program" && handoff.reconcileContract) {
    throw new Error("A Director-CFO resume handoff must not contain a reconciliation contract.");
  }
  if (!handoff.resumeModel || !handoff.resumePrompt) {
    throw new Error("The restart handoff requires an exact resume model and prompt.");
  }
  return handoff;
}

function valueContainsRuntimeVersion(value, expected, seen = new Set()) {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") {
    try {
      return valueContainsRuntimeVersion(JSON.parse(value), expected, seen);
    } catch {
      return false;
    }
  }
  if (typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  if (Object.prototype.hasOwnProperty.call(value, "runtimeVersion") && String(value.runtimeVersion) === expected) return true;
  return Object.values(value).some((entry) => valueContainsRuntimeVersion(entry, expected, seen));
}

function valueContainsRuntimeFingerprint(value, expected, seen = new Set()) {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") {
    try {
      return valueContainsRuntimeFingerprint(JSON.parse(value), expected, seen);
    } catch {
      return false;
    }
  }
  if (typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  if (Object.prototype.hasOwnProperty.call(value, "runtimeFingerprint") && String(value.runtimeFingerprint) === expected) return true;
  return Object.values(value).some((entry) => valueContainsRuntimeFingerprint(entry, expected, seen));
}

function valueContainsTaskId(value, expected, seen = new Set()) {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") {
    try {
      return valueContainsTaskId(JSON.parse(value), expected, seen);
    } catch {
      return false;
    }
  }
  if (typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  if (Object.prototype.hasOwnProperty.call(value, "taskId") && String(value.taskId) === expected) return true;
  return Object.values(value).some((entry) => valueContainsTaskId(entry, expected, seen));
}

function normalizedIdentity(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function aiMobileToolCall(message) {
  if (message?.method !== "item/completed") return null;
  const item = message.params?.item;
  if (!item || typeof item !== "object") return null;
  if (item.type === "mcpToolCall") {
    const server = normalizedIdentity(item.server);
    const plugin = normalizedIdentity(item.pluginId);
    if (server !== "aimobilelocal" && plugin !== "aimobileaimobile") return null;
    return { item, kind: "mcp", name: normalizedIdentity(item.tool) };
  }
  if (item.type === "dynamicToolCall") {
    if (String(item.namespace || "") !== AI_MOBILE_DYNAMIC_NAMESPACE) return null;
    const name = AI_MOBILE_DYNAMIC_TOOLS.get(String(item.tool || ""));
    if (!name) return null;
    return { item, kind: "dynamic", name };
  }
  return null;
}

function toolName(call) {
  return call?.name || "";
}

function parsedArguments(call) {
  const item = call?.item || call;
  if (item?.arguments && typeof item.arguments === "object") return item.arguments;
  if (typeof item?.arguments === "string") {
    try { return JSON.parse(item.arguments); } catch { return {}; }
  }
  return {};
}

function parsedResultValues(result) {
  const values = [];
  if (result && typeof result === "object") {
    values.push(result);
    if (result.structuredContent && typeof result.structuredContent === "object") values.push(result.structuredContent);
    for (const row of Array.isArray(result.content) ? result.content : []) {
      if (typeof row?.text !== "string") continue;
      try { values.push(JSON.parse(row.text)); } catch { /* exact JSON proof only */ }
    }
  } else if (typeof result === "string") {
    try { values.push(JSON.parse(result)); } catch { /* exact JSON proof only */ }
  }
  return values;
}

function exactJsonCandidates(text) {
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > MAX_TOOL_RESULT_TEXT_BYTES) return [];
  const trimmed = text.trim();
  if (!trimmed) return [];
  const candidates = [trimmed];
  const envelope = /^Wall time:\s*[^\r\n]{1,200}\r?\nOutput:\r?\n([\s\S]+)$/u.exec(trimmed);
  if (envelope) candidates.push(envelope[1].trim());
  return candidates;
}

function collectExactJsonValues(value, values, depth = 0) {
  if (depth > 5 || value === null || value === undefined) return;
  values.push(value);
  if (Array.isArray(value)) {
    for (const row of value) collectExactJsonValues(row, values, depth + 1);
    return;
  }
  if (typeof value !== "object") return;
  if (value.structuredContent && typeof value.structuredContent === "object") {
    collectExactJsonValues(value.structuredContent, values, depth + 1);
  }
  for (const row of Array.isArray(value.content) ? value.content : []) {
    if (typeof row?.text === "string") collectExactJsonText(row.text, values, depth + 1);
  }
  if (typeof value.text === "string" && new Set(["text", "inputText", "input_text"]).has(String(value.type || ""))) {
    collectExactJsonText(value.text, values, depth + 1);
  }
}

function collectExactJsonText(text, values, depth = 0) {
  if (depth > 5) return;
  for (const candidate of exactJsonCandidates(text)) {
    try {
      collectExactJsonValues(JSON.parse(candidate), values, depth + 1);
      return;
    } catch {
      // Only a complete JSON value (or the exact bounded Codex envelope) is evidence.
    }
  }
}

function parsedDynamicResultValues(item) {
  const values = [];
  for (const row of Array.isArray(item?.contentItems) ? item.contentItems : []) {
    if (typeof row?.text === "string") collectExactJsonText(row.text, values);
  }
  return values;
}

function parsedCallResultValues(call) {
  const representations = call?.representations || [call];
  return representations.flatMap((representation) => (
    representation?.kind === "dynamic"
      ? parsedDynamicResultValues(representation.item)
      : parsedResultValues(representation?.item?.result)
  ));
}

function representationFailed(call) {
  const item = call?.item;
  if (item?.status !== "completed" || item?.result?.isError === true) return true;
  if (call?.kind === "dynamic" && item?.success === false) return true;
  if (item?.error && String(item.error.message || item.error).trim()) return true;
  const values = call?.kind === "dynamic" ? parsedDynamicResultValues(item) : parsedResultValues(item?.result);
  return values.some((value) => (
    value && typeof value === "object" && typeof value.error === "string" && value.error.trim()
  ));
}

function resultFailed(call) {
  return (call?.representations || [call]).some((representation) => representationFailed(representation));
}

function isAiMobileRuntimeProof(message, expectedVersion, expectedFingerprint) {
  const call = aiMobileToolCall(message);
  if (!call || toolName(call) !== "resourceinventory" || resultFailed(call)) return false;
  return parsedCallResultValues(call).some((value) => (
    valueContainsRuntimeVersion(value, expectedVersion)
    && valueContainsRuntimeFingerprint(value, expectedFingerprint)
  ));
}

function deduplicatedAiMobileCalls(events) {
  const representations = events.map((message, index) => ({ index, call: aiMobileToolCall(message) }))
    .filter((row) => row.call)
    .map((row) => ({ ...row.call, index: row.index, args: parsedArguments(row.call) }));
  const calls = [];
  const callsById = new Map();
  for (const representation of representations) {
    const id = String(representation.item?.id || representation.item?.callId || "").trim();
    const key = id ? "id:" + id : "event:" + representation.index;
    const prior = callsById.get(key);
    if (!prior) {
      const call = { ...representation, id, representations: [representation] };
      callsById.set(key, call);
      calls.push(call);
      continue;
    }
    if (prior.name !== representation.name || JSON.stringify(prior.args) !== JSON.stringify(representation.args)) {
      throw new Error("Restart proof emitted conflicting representations for AI Mobile tool call " + id + ".");
    }
    prior.representations.push(representation);
    prior.index = Math.min(prior.index, representation.index);
  }
  return calls;
}

function validateRuntimeProof(events, expectedVersion, expectedFingerprint) {
  const calls = deduplicatedAiMobileCalls(events);
  if (calls.length !== 1 || calls[0].name !== "resourceinventory") {
    throw new Error(
      "Restart verification must complete exactly one AI Mobile resource-inventory call and no other AI Mobile calls; observed "
      + calls.map((call) => call.item.tool).join(", ") + ".",
    );
  }
  const inventory = calls[0];
  if (resultFailed(inventory) || !parsedCallResultValues(inventory).some((value) => (
    valueContainsRuntimeVersion(value, expectedVersion)
    && valueContainsRuntimeFingerprint(value, expectedFingerprint)
  ))) {
    throw new Error("Fresh AI Mobile runtime proof was not observed; the lightweight console turn was not started.");
  }
  return {
    verified: true,
    runtimeVersion: expectedVersion,
    runtimeFingerprint: expectedFingerprint,
    inventoryCalls: 1,
    inventoryToolCallId: String(inventory.id || inventory.item.id || ""),
  };
}

function validateContinuationProof(events, handoff) {
  const calls = deduplicatedAiMobileCalls(events);
  const allowedTools = handoff.handoffMode === "migrate-program"
    ? new Set(["reconciletask", "runprogramcampaign", "programreport"])
    : new Set(["runprogramcampaign", "programreport"]);
  const unexpected = calls.filter((row) => !allowedTools.has(row.name));
  if (unexpected.length) {
    throw new Error("Restart continuation used unauthorized AI Mobile tools: " + unexpected.map((row) => row.item.tool).join(", ") + ".");
  }

  const campaigns = calls.filter((row) => row.name === "runprogramcampaign");
  if (campaigns.length !== 1) {
    throw new Error("Restart continuation must complete exactly one run-program-campaign call; observed " + campaigns.length + ".");
  }
  const campaign = campaigns[0];
  if (campaign.args.taskId !== handoff.taskId) {
    throw new Error("Restart continuation campaign did not target durable task " + handoff.taskId + ".");
  }
  const campaignResults = parsedCallResultValues(campaign);
  if (resultFailed(campaign) || !campaignResults.some((value) => valueContainsTaskId(value, handoff.taskId))) {
    throw new Error("Restart continuation campaign did not return a successful receipt for durable task " + handoff.taskId + ".");
  }

  const reports = calls.filter((row) => row.name === "programreport");
  if (reports.length > 1) {
    throw new Error("Restart continuation may emit at most one program-report call; observed " + reports.length + ".");
  }
  if (reports.length === 1) {
    const report = reports[0];
    if (report.index < campaign.index) {
      throw new Error("Restart continuation program-report must follow the successful run-program-campaign call.");
    }
    if (report.args.taskId !== handoff.taskId) {
      throw new Error("Restart continuation report did not target durable task " + handoff.taskId + ".");
    }
    if (resultFailed(report) || !parsedCallResultValues(report).some((value) => valueContainsTaskId(value, handoff.taskId))) {
      throw new Error("Restart continuation report did not return a successful receipt for durable task " + handoff.taskId + ".");
    }
  }

  const reconciliations = calls.filter((row) => row.name === "reconciletask");
  if (handoff.handoffMode === "resume-program") {
    if (reconciliations.length !== 0) {
      throw new Error("An existing Director-CFO restart must resume without reconcile-task or migration.");
    }
  } else {
    if (reconciliations.length !== 1) {
      throw new Error("A legacy migration restart must complete exactly one reconcile-task call.");
    }
    const migration = reconciliations[0];
    const migrationResults = parsedCallResultValues(migration);
    if (migration.args.taskId !== handoff.taskId || migration.args.migrateToDirector !== true || resultFailed(migration)
      || !migrationResults.some((value) => valueContainsTaskId(value, handoff.taskId))) {
      throw new Error("Restart migration did not preserve and migrate the exact durable task.");
    }
    if (migration.index >= campaign.index) {
      throw new Error("Restart migration must complete before the Director-CFO campaign starts.");
    }
  }

  return {
    verified: true,
    taskId: handoff.taskId,
    handoffMode: handoff.handoffMode,
    campaignCalls: 1,
    reportCalls: reports.length,
    reconcileCalls: reconciliations.length,
    migrationVerified: handoff.handoffMode === "migrate-program",
    noStartOrLegacyTools: true,
    campaignToolCallId: String(campaign.id || campaign.item.id || ""),
    reportToolCallId: reports.length ? String(reports[0].id || reports[0].item.id || "") : "",
  };
}
class JsonLineRpcClient {
  constructor(child) {
    this.child = child;
    this.nextId = 1;
    this.buffer = "";
    this.stderr = "";
    this.pending = new Map();
    this.notifications = [];
    this.notificationCaptures = new Set();
    this.waiters = [];
    this.unexpectedServerRequest = null;

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => this.onData(chunk));
    child.stderr.on("data", (chunk) => {
      this.stderr = (this.stderr + chunk).slice(-MAX_STDERR_BYTES);
    });
    child.on("error", (error) => this.rejectAll(error));
    child.on("exit", (code, signal) => {
      if (this.pending.size || this.waiters.length) {
        this.rejectAll(new Error("Codex app-server exited before completion (" + String(code ?? signal) + "). " + this.stderr.trim()));
      }
    });
  }

  send(value) {
    if (!this.child.stdin.writable) throw new Error("Codex app-server stdin is closed.");
    this.child.stdin.write(JSON.stringify(value) + "\n");
  }

  onData(chunk) {
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer, "utf8") > MAX_LINE_BYTES * 2) {
      this.rejectAll(new Error("Codex app-server emitted an oversized unterminated message."));
      this.child.kill();
      return;
    }
    let newline;
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      if (Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) {
        this.rejectAll(new Error("Codex app-server emitted an oversized JSON message."));
        this.child.kill();
        return;
      }
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      this.onMessage(message);
    }
  }

  onMessage(message) {
    if (Object.prototype.hasOwnProperty.call(message, "id")
      && (Object.prototype.hasOwnProperty.call(message, "result") || Object.prototype.hasOwnProperty.call(message, "error"))) {
      const pending = this.pending.get(String(message.id));
      if (!pending) return;
      this.pending.delete(String(message.id));
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message || JSON.stringify(message.error)));
      else pending.resolve(message.result);
      return;
    }

    if (Object.prototype.hasOwnProperty.call(message, "id") && message.method) {
      this.unexpectedServerRequest = message;
      this.send({ id: message.id, error: { code: -32001, message: "Non-interactive AI Mobile restart continuation declines approval and elicitation requests." } });
      return;
    }

    if (!message.method) return;
    for (const capture of this.notificationCaptures) {
      if (capture.notifications.length >= capture.limit) {
        capture.overflowError = new Error("Codex app-server turn notification capture exceeded " + capture.limit + " events; restart continuation failed closed.");
        this.notificationCaptures.delete(capture);
        continue;
      }
      capture.notifications.push(message);
    }
    this.notifications.push(message);
    if (this.notifications.length > MAX_NOTIFICATION_RING) this.notifications.shift();
    const remaining = [];
    for (const waiter of this.waiters) {
      if (waiter.predicate(message)) {
        clearTimeout(waiter.timer);
        waiter.resolve(message);
      } else {
        remaining.push(waiter);
      }
    }
    this.waiters = remaining;
  }

  request(method, params, timeoutMs = 30000) {
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(String(id));
        reject(new Error(method + " timed out."));
      }, timeoutMs);
      this.pending.set(String(id), { resolve, reject, timer });
      this.send({ id, method, params });
    });
  }

  notify(method, params) {
    const message = { method };
    if (params !== undefined) message.params = params;
    this.send(message);
  }

  startNotificationCapture(limit = MAX_TURN_NOTIFICATIONS) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error("Notification capture limit must be a positive integer.");
    const capture = { limit, notifications: [], overflowError: null };
    this.notificationCaptures.add(capture);
    return capture;
  }

  finishNotificationCapture(capture) {
    this.notificationCaptures.delete(capture);
    if (capture.overflowError) throw capture.overflowError;
    return [...capture.notifications];
  }

  discardNotificationCapture(capture) {
    this.notificationCaptures.delete(capture);
  }

  waitFor(predicate, timeoutMs) {
    const prior = this.notifications.find(predicate);
    if (prior) return Promise.resolve(prior);
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        this.waiters = this.waiters.filter((entry) => entry !== waiter);
        reject(new Error("Codex app-server turn completion timed out."));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  rejectAll(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.waiters = [];
  }

  close() {
    try { this.child.stdin.end(); } catch {}
    try { this.child.kill(); } catch {}
  }
}

async function runTurn(client, params, timeoutMs) {
  const capture = client.startNotificationCapture();
  try {
    const response = await client.request("turn/start", params, 30000);
    const turnId = response?.turn?.id;
    if (!turnId) throw new Error("Codex app-server did not return a turn id.");
    const completed = await client.waitFor((message) => (
      message.method === "turn/completed"
      && message.params?.threadId === params.threadId
      && message.params?.turn?.id === turnId
    ), timeoutMs);
    const turn = completed.params.turn;
    if (turn.status !== "completed") {
      throw new Error("Codex app-server turn " + turnId + " ended as " + turn.status + ": " + (turn.error?.message || "no error detail"));
    }
    if (client.unexpectedServerRequest) {
      throw new Error("Continuation required unsupported interactive request " + client.unexpectedServerRequest.method + "; it was declined.");
    }
    const notifications = client.finishNotificationCapture(capture);
    const turnNotifications = notifications.filter((message) => {
      const notificationTurnId = message.params?.turnId || message.params?.turn?.id;
      return message.params?.threadId === params.threadId && notificationTurnId === turnId;
    });
    return { turnId, completed, notifications: turnNotifications };
  } finally {
    client.discardNotificationCapture(capture);
  }
}

async function runContinuation(handoff, options = {}) {
  const child = (options.spawnAppServer || spawn)(
    options.codexCommand || process.env.AI_MOBILE_CODEX_COMMAND || "codex",
    ["app-server", "--stdio"],
    {
      cwd: handoff.workspace,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  const client = new JsonLineRpcClient(child);
  try {
    await client.request("initialize", {
      clientInfo: { name: "ai-mobile-restart", title: "AI Mobile Restart Continuation", version: handoff.expectedRuntimeVersion },
      capabilities: { experimentalApi: true },
    });
    client.notify("initialized");
    await client.request("thread/resume", {
      threadId: handoff.threadId,
      cwd: handoff.workspace,
      excludeTurns: true,
    }, 60000);

    const verificationParams = {
      threadId: handoff.threadId,
      cwd: handoff.workspace,
      input: [{
        type: "text",
        text: [
          "Post-restart release verification only.",
          "Remain on the capable setup model. Do not switch models, inspect project files, edit, dispatch work, create a task, Goal, automation, or run shell commands.",
          "Call the AI Mobile resource-inventory tool exactly once and report its runtimeVersion and runtimeFingerprint.",
          "The required runtimeVersion is " + handoff.expectedRuntimeVersion + " and the required runtimeFingerprint is " + handoff.expectedRuntimeFingerprint + ". Stop if either differs.",
        ].join(" "),
      }],
    };
    if (handoff.verificationModel) verificationParams.model = handoff.verificationModel;
    if (handoff.verificationEffort) verificationParams.effort = handoff.verificationEffort;
    const verification = await runTurn(client, verificationParams, options.verificationTimeoutMs || 300000);
    const verificationEvents = verification.notifications;
    validateRuntimeProof(verificationEvents, handoff.expectedRuntimeVersion, handoff.expectedRuntimeFingerprint);

    await client.request("thread/settings/update", {
      threadId: handoff.threadId,
      model: handoff.resumeModel,
      effort: handoff.resumeEffort || "low",
    }, 30000);

    const continuationParams = {
      threadId: handoff.threadId,
      cwd: handoff.workspace,
      model: handoff.resumeModel,
      effort: handoff.resumeEffort || "low",
      input: [{ type: "text", text: handoff.resumePrompt }],
    };
    const continuation = await runTurn(client, continuationParams, options.continuationTimeoutMs || 1200000);
    const continuationEvents = continuation.notifications;
    const continuationProof = validateContinuationProof(continuationEvents, handoff);
    return {
      ok: true,
      threadId: handoff.threadId,
      runtimeVersion: handoff.expectedRuntimeVersion,
      runtimeFingerprint: handoff.expectedRuntimeFingerprint,
      verificationModel: handoff.verificationModel || "preserved-thread-model",
      verificationEffort: handoff.verificationEffort || "preserved-thread-effort",
      verificationTurnId: verification.turnId,
      resumeModel: handoff.resumeModel,
      resumeEffort: handoff.resumeEffort || "low",
      threadSettingsUpdated: true,
      continuationTurnId: continuation.turnId,
      continuationProof,
      visibleAfterDesktopReopen: true,
    };
  } finally {
    client.close();
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args["handoff-file"]) throw new Error("--handoff-file is required.");
  const handoff = readHandoff(args["handoff-file"]);
  const result = await runContinuation(handoff);
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write("AI Mobile app-server continuation failed: " + error.message + "\n");
    process.exitCode = 1;
  });
}

module.exports = {
  JsonLineRpcClient,
  isAiMobileRuntimeProof,
  readHandoff,
  runContinuation,
  validateContinuationProof,
  validateRuntimeProof,
  valueContainsRuntimeFingerprint,
  valueContainsRuntimeVersion,
  valueContainsTaskId,
};
