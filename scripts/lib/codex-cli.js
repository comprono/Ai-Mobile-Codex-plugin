"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const SAFE_MODEL = /^[A-Za-z0-9._:/+-]+$/;
const SAFE_EFFORTS = new Set(["minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);

function unique(values) {
  const seen = new Set();
  return values.filter((value) => {
    const key = String(value || "").trim().toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function codexCliCandidates(options = {}) {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const home = options.home || os.homedir();
  const names = platform === "win32" ? ["codex.exe", "codex.cmd", "codex"] : ["codex"];
  const candidates = [env.CODEX_CLI_PATH];

  if (platform === "win32") {
    if (env.LOCALAPPDATA) {
      candidates.push(path.join(env.LOCALAPPDATA, "Programs", "OpenAI", "Codex", "bin", "codex.exe"));
    }
    candidates.push(path.join(home, ".local", "bin", "codex.exe"));
  } else {
    candidates.push(path.join(home, ".local", "bin", "codex"));
    candidates.push("/usr/local/bin/codex", "/opt/homebrew/bin/codex");
  }

  for (const directory of String(env.PATH || "").split(path.delimiter).filter(Boolean)) {
    if (platform === "win32" && /\\WindowsApps(?:\\|$)/i.test(directory)) continue;
    for (const name of names) {
      const candidate = path.join(directory, name);
      if (fs.existsSync(candidate)) candidates.push(candidate);
    }
  }
  candidates.push(...names);
  return unique(candidates);
}

function parseCodexLoginStatus(stdout = "", stderr = "") {
  const text = `${stdout}\n${stderr}`.trim();
  if (/logged in using chatgpt/i.test(text)) {
    return { checked: true, loggedIn: true, authMode: "chatgpt", text };
  }
  if (/logged in/i.test(text)) {
    return { checked: true, loggedIn: true, authMode: "other", text };
  }
  if (/not logged in|login required|run\s+codex\s+login/i.test(text)) {
    return { checked: true, loggedIn: false, authMode: "none", text };
  }
  return { checked: true, loggedIn: null, authMode: "unknown", text };
}

function safeCodexModel(value) {
  const model = String(value || "").trim();
  if (!model || !SAFE_MODEL.test(model)) {
    throw new Error("Unsafe Codex model id. Use the exact simple id from the local Codex model catalog.");
  }
  return model;
}

function safeCodexEffort(value = "medium") {
  const effort = String(value || "medium").trim().toLowerCase();
  if (!SAFE_EFFORTS.has(effort)) throw new Error(`Unsupported Codex reasoning effort: ${effort}`);
  return effort;
}

function buildCodexExecArgs(options = {}) {
  const workspace = path.resolve(String(options.workspace || ""));
  if (!workspace || workspace === path.parse(workspace).root) {
    throw new Error("Codex worker requires a non-root workspace path.");
  }
  const model = safeCodexModel(options.model);
  const effort = safeCodexEffort(options.effort);
  const sandbox = options.readOnly === false ? "workspace-write" : "read-only";
  return [
    "-a", "never",
    "exec",
    "--ephemeral",
    "--ignore-user-config",
    "--disable", "plugins",
    "--disable", "apps",
    "--disable", "goals",
    "--disable", "computer_use",
    "--disable", "browser_use",
    "--disable", "in_app_browser",
    "--disable", "image_generation",
    "--disable", "multi_agent",
    "--json",
    "--sandbox", sandbox,
    "--model", model,
    "-c", `model_reasoning_effort=\"${effort}\"`,
    "-C", workspace,
    "-",
  ];
}

function numberOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseCodexJsonl(output = "") {
  const messages = [];
  const errors = [];
  const diagnostics = [];
  let threadId = "";
  let usage = {};
  let turnFailed = false;
  let parsedEvents = 0;

  for (const rawLine of String(output || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    let event;
    try {
      event = JSON.parse(line);
      parsedEvents += 1;
    } catch {
      diagnostics.push(line);
      continue;
    }
    const type = String(event.type || "");
    if (type === "thread.started") threadId = String(event.thread_id || event.threadId || "");
    const item = event.item || {};
    if ((type === "item.completed" || type === "item.updated") && item.type === "agent_message" && item.text) {
      messages.push(String(item.text));
    }
    if (type === "turn.completed") usage = event.usage || usage;
    if (type === "turn.failed" || type === "error") {
      turnFailed = true;
      errors.push(String(event.error?.message || event.message || event.error || type));
    }
    if (item.type === "error") {
      turnFailed = true;
      errors.push(String(item.message || item.text || "Codex item failed."));
    }
  }

  return {
    parsedEvents,
    threadId,
    resultText: messages.join("\n\n").trim(),
    errors,
    diagnostics,
    turnFailed,
    inputTokens: numberOrNull(usage.input_tokens ?? usage.inputTokens),
    cachedInputTokens: numberOrNull(usage.cached_input_tokens ?? usage.cachedInputTokens),
    outputTokens: numberOrNull(usage.output_tokens ?? usage.outputTokens),
  };
}

module.exports = {
  buildCodexExecArgs,
  codexCliCandidates,
  parseCodexJsonl,
  parseCodexLoginStatus,
  safeCodexEffort,
  safeCodexModel,
};
