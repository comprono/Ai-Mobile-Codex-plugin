"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { commandResult, resolveCommand, bounded } = require("../core/utils");
const { codexCliCandidates, parseCodexLoginStatus, buildCodexExecArgs, parseCodexJsonl } = require("../lib/codex-cli");

function version(command) {
  if (!command) return "";
  const result = commandResult(command, ["--version"], { timeout: 6000 });
  return result.status === 0 ? bounded(result.stdout || result.stderr, 200).trim() : "";
}

function findCodex() {
  for (const candidate of codexCliCandidates()) {
    const result = commandResult(candidate, ["--version"], { timeout: 5000 });
    if (result.status === 0) return { found: true, command: candidate, version: bounded(result.stdout || result.stderr, 200).trim() };
  }
  return { found: false, command: "", version: "" };
}

function discoverCodex() {
  const cli = findCodex();
  if (!cli.found) return provider("codex", false, { reason: "Codex CLI not found." });
  const login = commandResult(cli.command, ["login", "status"], { timeout: 7000 });
  const auth = parseCodexLoginStatus(login.stdout, login.stderr);
  const probe = commandResult(process.execPath, [path.join(__dirname, "codex-app-server-probe.js"), cli.command], { timeout: 9000 });
  let native = null;
  try { native = JSON.parse(probe.stdout); } catch { /* native evidence remains unavailable */ }
  const snapshots = native?.rateLimits?.rateLimitsByLimitId || (native?.rateLimits?.rateLimits ? { codex: native.rateLimits.rateLimits } : {});
  const windows = [];
  for (const [limitId, snapshot] of Object.entries(snapshots || {})) {
    for (const name of ["primary", "secondary"]) {
      const window = snapshot?.[name];
      if (!window || !Number.isFinite(Number(window.usedPercent))) continue;
      windows.push({ limitId, name, remainingPercent: Math.max(0, 100 - Number(window.usedPercent)), resetAt: window.resetsAt ? new Date(Number(window.resetsAt) * 1000).toISOString() : null, windowMinutes: window.windowDurationMins ?? null });
    }
  }
  const modelRows = native?.models?.data || native?.models?.models || [];
  const effectiveWindows = windows.some((item) => item.limitId === "codex") ? windows.filter((item) => item.limitId === "codex") : windows;
  return provider("codex", auth.loggedIn === true, {
    command: cli.command, version: cli.version, authMode: auth.authMode,
    confidence: auth.loggedIn === true ? "high" : "medium",
    models: modelRows.slice(0, 100).map((row) => ({ id: row.id || row.model || row.slug || row.displayName, displayName: row.displayName || row.name || "" })).filter((row) => row.id),
    capacity: windows.length
      ? { windows, effectiveRemainingPercent: Math.min(...effectiveWindows.map((item) => item.remainingPercent)), availableResetCredits: native?.rateLimits?.rateLimitResetCredits?.availableCount ?? null, source: "codex-app-server", confidence: "high" }
      : { remainingPercent: null, resetAt: null, source: "native-cli-auth", note: "Exact shared Codex window is unavailable; current Codex remains authoritative." },
    usage: native?.usage?.summary || null,
  });
}

function discoverClaude() {
  const cli = resolveCommand("claude", [
    process.env.APPDATA ? path.join(process.env.APPDATA, "npm", "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe") : "",
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Programs", "Claude", "claude.exe") : "",
  ]);
  if (!cli.found) return provider("claude", false, { reason: "Claude Code CLI not found." });
  const authResult = commandResult(cli.command, ["auth", "status"], { timeout: 7000 });
  const text = `${authResult.stdout}\n${authResult.stderr}`;
  const authenticated = authResult.status === 0 && !/not logged in|login required/i.test(text);
  return provider("claude", authenticated, {
    command: cli.command, version: cli.version, authMode: process.env.ANTHROPIC_API_KEY ? "api-key" : "subscription",
    confidence: authenticated ? "high" : "medium",
    capacity: { remainingPercent: null, resetAt: null, source: "native-cli-auth", note: "Claude Code does not expose a stable machine-readable subscription quota endpoint." },
  });
}

function discoverAntigravity() {
  const cli = resolveCommand("agy", []);
  if (!cli.found) return provider("antigravity", false, { reason: "Antigravity CLI (agy) not found." });
  const roster = commandResult(cli.command, ["models"], { timeout: 15000 });
  const models = roster.status === 0 ? roster.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(0, 50).map((displayName) => ({ id: displayName, displayName })) : [];
  return provider("antigravity", true, {
    command: cli.command, version: cli.version, authMode: "cli-session", confidence: "medium", models,
    capacity: { remainingPercent: null, resetAt: null, source: "native-cli", note: "Availability is verified; exact model quota is unknown unless the CLI exposes it." },
  });
}

function discoverCursor() {
  const cli = resolveCommand("cursor-agent", []);
  return cli.found
    ? provider("cursor", true, { command: cli.command, version: cli.version, authMode: "cli-session", confidence: "medium", capacity: unknownCapacity("native-cli") })
    : provider("cursor", false, { reason: "A real headless cursor-agent is not installed; Cursor UI is not treated as a worker." });
}

function unknownCapacity(source) {
  return { remainingPercent: null, resetAt: null, source, note: "Exact quota is not exposed by this CLI." };
}

function provider(id, available, extra = {}) {
  return { id, available, authenticated: available, confidence: available ? "medium" : "high", models: [], ...extra };
}

function runCodex(providerState, contract, prompt) {
  const model = contract.model;
  if (!model) return { ok: false, typedBlocker: "model-unavailable", text: "No allowed Codex model was selected from the native catalog." };
  const args = buildCodexExecArgs({ workspace: contract.workspace, model, effort: contract.effort || "medium", readOnly: contract.readOnly });
  const result = commandResult(providerState.command, args, { cwd: contract.workspace, input: prompt, timeout: contract.timeoutSeconds * 1000, maxBuffer: 16 * 1024 * 1024 });
  const parsed = parseCodexJsonl(result.stdout);
  return { ok: result.status === 0 && !parsed.turnFailed, text: parsed.resultText || result.stderr, usage: { inputTokens: parsed.inputTokens, cachedInputTokens: parsed.cachedInputTokens, outputTokens: parsed.outputTokens }, exitCode: result.status };
}

function runClaude(providerState, contract, prompt) {
  const args = ["-p", "--output-format", "json", "--no-session-persistence", "--permission-mode", contract.readOnly ? "plan" : "acceptEdits"];
  if (contract.model) args.push("--model", contract.model);
  if (contract.effort) args.push("--effort", contract.effort);
  args.push(prompt);
  const result = commandResult(providerState.command, args, { cwd: contract.workspace, timeout: contract.timeoutSeconds * 1000, maxBuffer: 16 * 1024 * 1024 });
  let body = null;
  try { body = JSON.parse(result.stdout); } catch { /* retain plain output */ }
  const text = body?.result || body?.message || result.stdout || result.stderr;
  return { ok: result.status === 0 && !body?.is_error, text, usage: body?.usage || {}, exitCode: result.status };
}

function runAntigravity(providerState, contract, prompt) {
  if (contract.needsUi) return { ok: false, typedBlocker: "ui-required", text: "This lane requires visible Antigravity UI state; CLI execution was intentionally not attempted." };
  const args = ["--print", prompt, "--project", contract.projectId || "default-cli-project", "--add-dir", contract.workspace, "--sandbox"];
  if (contract.conversation) args.push("--conversation", contract.conversation);
  if (contract.model) args.push("--model", contract.model);
  if (contract.mode) args.push("--mode", contract.mode);
  const result = commandResult(providerState.command, args, { cwd: contract.workspace, timeout: contract.timeoutSeconds * 1000, maxBuffer: 16 * 1024 * 1024 });
  return { ok: result.status === 0, text: result.stdout || result.stderr, usage: {}, exitCode: result.status };
}

function runCursor(providerState, contract, prompt) {
  const args = ["-p", "--workspace", contract.workspace, prompt];
  const result = commandResult(providerState.command, args, { cwd: contract.workspace, timeout: contract.timeoutSeconds * 1000, maxBuffer: 16 * 1024 * 1024 });
  return { ok: result.status === 0, text: result.stdout || result.stderr, usage: {}, exitCode: result.status };
}

function runProvider(state, contract, prompt) {
  const selected = state[contract.provider];
  if (!selected?.available) return { ok: false, typedBlocker: "provider-unavailable", text: selected?.reason || `${contract.provider} is unavailable.` };
  if (contract.provider === "codex") return runCodex(selected, contract, prompt);
  if (contract.provider === "claude") return runClaude(selected, contract, prompt);
  if (contract.provider === "antigravity") return runAntigravity(selected, contract, prompt);
  if (contract.provider === "cursor") return runCursor(selected, contract, prompt);
  return { ok: false, typedBlocker: "unsupported-provider", text: `Unsupported provider: ${contract.provider}` };
}

function discoverAll() {
  return { codex: discoverCodex(), claude: discoverClaude(), antigravity: discoverAntigravity(), cursor: discoverCursor() };
}

module.exports = { discoverAll, runProvider };
