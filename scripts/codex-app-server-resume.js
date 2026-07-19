#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const { spawn } = require("node:child_process");

const MAX_LINE_BYTES = 4 * 1024 * 1024;
const MAX_STDERR_BYTES = 32 * 1024;

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
  if (!handoff.resumeModel || !handoff.resumePrompt) {
    throw new Error("The restart handoff requires an exact resume model and prompt.");
  }
  return handoff;
}

function valueContainsRuntimeVersion(value, expected, seen = new Set()) {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") {
    if (value.includes("runtimeVersion") && value.includes(expected)) return true;
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

function isAiMobileRuntimeProof(message, expected) {
  if (message?.method !== "item/completed") return false;
  const item = message.params?.item;
  if (!item || item.type !== "mcpToolCall" || item.status !== "completed") return false;
  const identity = [item.server, item.pluginId, item.tool].filter(Boolean).join(" ").toLowerCase().replace(/[^a-z0-9]/g, "");
  return identity.includes("aimobile") && valueContainsRuntimeVersion(item.result, expected);
}

class JsonLineRpcClient {
  constructor(child) {
    this.child = child;
    this.nextId = 1;
    this.buffer = "";
    this.stderr = "";
    this.pending = new Map();
    this.notifications = [];
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
    this.notifications.push(message);
    if (this.notifications.length > 200) this.notifications.shift();
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
  return { turnId, completed, notifications: [...client.notifications] };
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
          "Call the AI Mobile resource-inventory tool exactly once and report its runtimeVersion.",
          "The required runtimeVersion is " + handoff.expectedRuntimeVersion + ". Stop if it differs.",
        ].join(" "),
      }],
    };
    if (handoff.verificationModel) verificationParams.model = handoff.verificationModel;
    if (handoff.verificationEffort) verificationParams.effort = handoff.verificationEffort;
    const verificationStart = client.notifications.length;
    const verification = await runTurn(client, verificationParams, options.verificationTimeoutMs || 300000);
    const verificationEvents = client.notifications.slice(verificationStart);
    if (!verificationEvents.some((message) => isAiMobileRuntimeProof(message, handoff.expectedRuntimeVersion))) {
      throw new Error("Fresh AI Mobile runtime proof was not observed; the lightweight console turn was not started.");
    }

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
    return {
      ok: true,
      threadId: handoff.threadId,
      runtimeVersion: handoff.expectedRuntimeVersion,
      verificationModel: handoff.verificationModel || "preserved-thread-model",
      verificationEffort: handoff.verificationEffort || "preserved-thread-effort",
      verificationTurnId: verification.turnId,
      resumeModel: handoff.resumeModel,
      resumeEffort: handoff.resumeEffort || "low",
      threadSettingsUpdated: true,
      continuationTurnId: continuation.turnId,
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
  valueContainsRuntimeVersion,
};