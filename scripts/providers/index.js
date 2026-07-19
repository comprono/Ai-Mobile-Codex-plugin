"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { commandResult, resolveCommand, bounded } = require("../core/utils");
const { codexCliCandidates, parseCodexLoginStatus, buildCodexExecArgs, parseCodexJsonl } = require("../lib/codex-cli");
const { parseClaudeAuth, parseClaudeModels, parseClaudeUsage } = require("./claude-usage");

const PROVIDER_CAPABILITIES = {
  codex: { architecture: 88, browser: 45, code: 88, debug: 90, docs: 70, generic: 78, "live-state": 92, "repository-scan": 68, research: 65, review: 82, tests: 78 },
  claude: { architecture: 94, browser: 45, code: 90, debug: 88, docs: 76, generic: 78, "live-state": 55, "repository-scan": 78, research: 72, review: 90, tests: 76 },
  antigravity: { architecture: 58, browser: 96, code: 52, debug: 55, docs: 88, generic: 68, "live-state": 70, "repository-scan": 92, research: 94, review: 72, tests: 60 },
  cursor: { architecture: 70, browser: 55, code: 82, debug: 78, docs: 68, generic: 70, "live-state": 50, "repository-scan": 72, research: 62, review: 72, tests: 75 },
};

const PROVIDER_SURFACES = {
  codex: { headless: true, source: true, "local-files": true, git: true, tests: true, browser: false, github: false, api: false, "project-tools": false },
  claude: { headless: true, source: true, "local-files": true, git: true, tests: true, browser: false, github: false, api: false, "project-tools": false },
  antigravity: { headless: true, source: true, "local-files": true, git: true, tests: true, browser: true, github: false, api: false, "project-tools": false },
  cursor: { headless: true, source: true, "local-files": true, git: true, tests: true, browser: false, github: false, api: false, "project-tools": false },
};

function inferModelTier(row = {}) {
  const identity = `${row.id || ""} ${row.displayName || ""}`.toLowerCase();
  const text = `${identity} ${row.description || ""}`.toLowerCase();
  if (/\b(spark|mini|lite|haiku)\b/.test(identity) || /\bflash[- ]?low\b/.test(identity)) return "efficient";
  if (/\b(fable|opus|ultra)\b/.test(identity)) return "frontier";
  if (/\b(frontier|maximum|most capable|advanced|ultra)\b/.test(text)) return "frontier";
  if (/\b(fast|efficient|affordable|small|mini|lite|low|haiku)\b/.test(text)) return "efficient";
  if (/\b(balanced|general|strong|medium|sonnet|flash)\b/.test(text)) return "balanced";
  return "unknown";
}

function enrichModel(row = {}) {
  return { ...row, capabilityTier: row.capabilityTier || inferModelTier(row) };
}

function enrichModels(rows = []) {
  return rows.map(enrichModel);
}

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
    // Preserve native metadata. The router uses these descriptions and effort
    // capabilities, rather than a stale model-name leaderboard or list order.
    models: modelRows.slice(0, 100).map((row) => ({
      id: row.id || row.model || row.slug || row.displayName,
      displayName: row.displayName || row.name || "",
      description: row.description || "",
      isDefault: row.isDefault === true,
      defaultReasoningEffort: row.defaultReasoningEffort || "",
      supportedReasoningEfforts: (row.supportedReasoningEfforts || []).map((item) => item.reasoningEffort || item).filter(Boolean),
    })).filter((row) => row.id).map(enrichModel),
    capacity: windows.length
      ? { windows, effectiveRemainingPercent: Math.min(...effectiveWindows.map((item) => item.remainingPercent)), availableResetCredits: native?.rateLimits?.rateLimitResetCredits?.availableCount ?? null, source: "codex-app-server", confidence: "high" }
      : { remainingPercent: null, resetAt: null, source: "native-cli-auth", note: "Exact shared Codex capacity is unavailable; the configured reserve remains protected." },
    usage: native?.usage?.summary || null,
    activeWork: native?.threadSignal || { supported: false },
  });
}

function discoverClaude() {
  const cli = resolveCommand("claude", [
    process.env.APPDATA ? path.join(process.env.APPDATA, "npm", "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe") : "",
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Programs", "Claude", "claude.exe") : "",
  ], { preferFallbacks: process.platform === "win32" });
  if (!cli.found) return provider("claude", false, { reason: "Claude Code CLI not found." });
  const authResult = commandResult(cli.command, ["auth", "status"], { timeout: 7000 });
  const auth = parseClaudeAuth(authResult.stdout);
  const help = commandResult(cli.command, ["--help"], { timeout: 7000 });
  // Capacity is useful only if it arrives before it delays the project's first
  // useful move. A slow Claude usage view is reported as unknown and can be
  // refreshed later; it never blocks a finite orchestration contract.
  const usageProbe = auth.loggedIn ? commandResult(cli.command, ["-p", "--safe-mode", "--tools", "", "--no-session-persistence", "--output-format", "text", "/usage"], { timeout: 8000 }) : { status: 1, stdout: "" };
  const windows = usageProbe.status === 0 ? parseClaudeUsage(usageProbe.stdout) : [];
  const shared = windows.filter((window) => window.scope === "all");
  const authenticated = authResult.status === 0 && auth.loggedIn;
  return provider("claude", authenticated, {
    command: cli.command, version: cli.version, authMode: auth.authMode, subscriptionType: auth.subscriptionType,
    confidence: authenticated ? "high" : "medium",
    models: help.status === 0 ? enrichModels(parseClaudeModels(help.stdout)) : [],
    capacity: windows.length
      ? { windows, remainingPercent: shared.length ? Math.min(...shared.map((window) => window.remainingPercent)) : null, resetAt: [...shared].sort((a, b) => a.remainingPercent - b.remainingPercent)[0]?.resetAt || null, source: "claude-slash-usage", confidence: "high", note: "Built-in subscription usage; model-specific windows apply only to matching model families." }
      : { remainingPercent: null, resetAt: null, source: "native-cli-auth", note: usageProbe.status === 0 ? "Claude usage output contained no parseable windows." : "Claude built-in usage is unavailable; quota remains unknown." },
  });
}

function modelId(displayName) {
  return String(displayName || "").toLowerCase()
    .replace(/[()]/g, " ")
    .replace(/[^a-z0-9.]+/g, "-")
    .replace(/^-|-$/g, "");
}

function numericOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function antigravityRemaining(models = []) {
  const available = models.filter((row) => row.status === "available" && numericOrNull(row.remainingPercent) !== null);
  if (available.length) return Math.max(...available.map((row) => numericOrNull(row.remainingPercent)));
  if (models.length && models.every((row) => row.status === "exhausted")) return 0;
  return null;
}

function antigravityHelperCandidates() {
  const values = [process.env.AI_MOBILE_ANTIGRAVITY_HELPER, path.join(os.homedir(), "plugins", "antigravity-2", "scripts", "antigravity.ps1")];
  const cacheRoot = path.join(os.homedir(), ".codex", "plugins", "cache", "personal", "antigravity-2");
  try {
    for (const versionName of fs.readdirSync(cacheRoot)) values.push(path.join(cacheRoot, versionName, "scripts", "antigravity.ps1"));
  } catch { /* optional integration */ }
  return [...new Set(values.filter(Boolean))].filter((candidate) => fs.existsSync(candidate));
}

function antigravityLimits() {
  for (const helper of antigravityHelperCandidates()) {
    const result = commandResult("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", helper, "limits-summary"], { timeout: 20000, maxBuffer: 2 * 1024 * 1024 });
    if (result.status !== 0) continue;
    let body = null;
    try { body = JSON.parse(result.stdout); } catch { continue; }
    const available = (body?.RecommendedAvailable || []).map((row) => ({ id: modelId(row.Id || row.DisplayName), displayName: row.DisplayName || row.Id || "", remainingPercent: numericOrNull(row.RemainingPercent), resetAt: row.ResetTimeUtc || null, status: "available" }));
    const blocked = (body?.BlockedOrResetting || []).map((row) => ({ id: modelId(row.Id || row.DisplayName), displayName: row.DisplayName || row.Id || "", remainingPercent: 0, resetAt: row.ResetTimeUtc || null, status: "exhausted" }));
    return { checked: true, source: body?.Source || "antigravity-2-local-helper", generatedAt: body?.GeneratedAtUtc || null, models: [...available, ...blocked] };
  }
  return { checked: false, source: "agy-roster", generatedAt: null, models: [] };
}

function discoverAntigravity() {
  const cli = resolveCommand("agy", []);
  if (!cli.found) return provider("antigravity", false, { reason: "Antigravity CLI (agy) not found." });
  const roster = commandResult(cli.command, ["models"], { timeout: 10000, maxBuffer: 2 * 1024 * 1024 });
  if (roster.status !== 0) {
    const output = bounded(`${roster.stdout}\n${roster.stderr}`, 1200);
    const failure = classifyFailure(output, roster.status || 1);
    const authFailure = failure === "authentication-required" || /sign in|not logged in/i.test(output);
    return provider("antigravity", false, {
      installed: true,
      command: cli.command,
      version: cli.version,
      authMode: authFailure ? "none" : "unknown",
      confidence: "high",
      reason: authFailure
        ? "Antigravity CLI is installed but its headless session is not authenticated; desktop-app login does not prove CLI authentication."
        : `${failure}: ${bounded(output, 500)}`,
      diagnostic: { failureClass: authFailure ? "authentication-required" : failure, canary: "agy models" },
    });
  }
  const limits = antigravityLimits();
  const measured = limits.models;
  const rosterModels = roster.stdout.split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !/^(fetching|available models?:)/i.test(line) && !/^[IEW]\d/.test(line))
    .slice(0, 100)
    .map((displayName) => ({ id: modelId(displayName), displayName }));
  const models = limits.checked
    ? limits.models.map((row) => ({ id: row.id, displayName: row.displayName }))
    : rosterModels;
  const enriched = models.map((model) => enrichModel({ ...model, quota: measured.find((row) => row.id === model.id || modelId(row.displayName) === model.id) || null }));
  return provider("antigravity", true, {
    installed: true,
    command: cli.command,
    version: cli.version,
    authMode: "cli-session",
    confidence: limits.checked ? "high" : "medium",
    models: enriched,
    capacity: limits.checked
      ? { models: measured, remainingPercent: antigravityRemaining(measured), resetAt: null, source: limits.source, generatedAt: limits.generatedAt, note: "Per-model quota from an installed local Antigravity helper after independent CLI-authentication proof; unknown percentages remain unknown; no desktop app was started." }
      : { remainingPercent: null, resetAt: null, source: "native-cli", note: "Headless CLI authentication is verified; exact model quota is unknown unless an optional local helper exposes it." },
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
  return { id, installed: Boolean(extra.command), available, authenticated: available, headless: true, confidence: available ? "medium" : "high", models: [], capabilities: PROVIDER_CAPABILITIES[id] || {}, surfaces: PROVIDER_SURFACES[id] || { headless: true }, ...extra };
}

function classifyFailure(value, exitCode) {
  if (exitCode === 0) return "";
  const text = String(value || "").toLowerCase();
  if (/transport closed|econnreset|econnrefused|socket hang up|broken pipe|connection (?:closed|reset|refused)/.test(text)) return "transport-unavailable";
  if (/etimedout|timedout|timed? out|timeout|deadline exceeded/.test(text)) return "provider-timeout";
  if (/rate.?limit|quota|usage limit|capacity.*exhaust|model.*unavailable/.test(text)) return "capacity-unavailable";
  if (/not logged in|login required|unauthorized|authentication|invalid.*token|oauth/.test(text)) return "authentication-required";
  if (/permission|approval required|access denied/.test(text)) return "authorization-required";
  return "provider-process-failed";
}

function runCodex(providerState, contract, prompt) {
  const model = contract.model;
  if (!model) return { ok: false, typedBlocker: "model-unavailable", text: "No allowed Codex model was selected from the native catalog." };
  const patchOutputWriter = contract.readOnly !== true && contract.skipModelReview !== true;
  const args = buildCodexExecArgs({ workspace: contract.workspace, model, effort: contract.effort || "medium", readOnly: patchOutputWriter ? true : contract.readOnly });
  const result = commandResult(providerState.command, args, { cwd: contract.workspace, input: prompt, timeout: contract.timeoutSeconds * 1000, maxBuffer: 16 * 1024 * 1024 });
  const parsed = parseCodexJsonl(result.stdout);
  const text = parsed.resultText || result.stderr;
  const ok = result.status === 0 && !parsed.turnFailed;
  return { ok, typedBlocker: ok ? "" : classifyFailure(text, result.status || 1), text, usage: { model, inputTokens: parsed.inputTokens, cachedInputTokens: parsed.cachedInputTokens, outputTokens: parsed.outputTokens }, exitCode: result.status };
}

const CLAUDE_SYSTEM_PROMPT = "You are a bounded project worker. Follow the supplied lane contract exactly. Never broaden scope, delegate, or interact with the visible project console. Use only the enabled local file tools. For read-only lanes do not edit. Stop when the requested evidence is sufficient and return only the required JSON.";

function claudeResultSchema(contractOrTokens = 1200) {
  const contract = typeof contractOrTokens === "object" ? contractOrTokens : {};
  const maxOutputTokens = typeof contractOrTokens === "object" ? contractOrTokens.maxWorkerOutputTokens : contractOrTokens;
  const characterBudget = Math.max(1200, Math.min(12000, Math.floor(Number(maxOutputTokens || 1200) * 3)));
  const commandSchema = {
    type: "object",
    additionalProperties: false,
    properties: {
      name: { type: "string", maxLength: 80 },
      command: { type: "string", maxLength: 260 },
      args: { type: "array", maxItems: 30, items: { type: "string", maxLength: 500 } },
      timeoutSeconds: { type: "number", minimum: 1, maximum: 900 },
    },
    required: ["name", "command", "args", "timeoutSeconds"],
  };
  const workUnitSchema = {
    type: "object",
    additionalProperties: false,
    properties: {
      goal: { type: "string", maxLength: 2000 },
      relevantFiles: { type: "array", minItems: 1, maxItems: 60, items: { type: "string", maxLength: 500 } },
      expectedFiles: { type: "array", minItems: 1, maxItems: 40, items: { type: "string", maxLength: 500 } },
      acceptanceCriteria: { type: "array", minItems: 1, maxItems: 12, items: { type: "string", maxLength: 1000 } },
      verificationCommands: { type: "array", minItems: 1, maxItems: 8, items: commandSchema },
      taskKind: { type: "string", maxLength: 40 },
      complexity: { type: "string", enum: ["small", "medium", "large"] },
      priority: { type: "number", minimum: 1, maximum: 100 },
      requiredCapabilities: { type: "array", maxItems: 12, items: { type: "string", maxLength: 80 } },
    },
    required: ["goal", "relevantFiles", "expectedFiles", "acceptanceCriteria", "verificationCommands", "taskKind", "complexity", "priority", "requiredCapabilities"],
  };
  return JSON.stringify({
    type: "object",
    additionalProperties: false,
    properties: {
      outcome: { type: "string", maxLength: Math.floor(characterBudget * 0.3) },
      evidence: { type: "array", maxItems: 8, items: { type: "string", maxLength: Math.floor(characterBudget * 0.05) } },
      checks: { type: "array", maxItems: 8, items: { type: "string", maxLength: Math.floor(characterBudget * 0.04) } },
      blocker: { type: "string", maxLength: Math.floor(characterBudget * 0.1) },
      blockerOwner: { type: "string", maxLength: 160 },
      recoveryTrigger: { type: "string", maxLength: 800 },
      recoveryAction: { type: "string", maxLength: 1200 },
      proposedWorkUnits: { type: "array", maxItems: contract.artifactKind === "work-plan" ? 3 : 0, items: workUnitSchema },
    },
    required: ["outcome", "evidence", "checks", "blocker", "blockerOwner", "recoveryTrigger", "recoveryAction", "proposedWorkUnits"],
  });
}
function buildClaudeArgs(contract, prompt) {
  const args = [
    "-p", "--output-format", "json", "--no-session-persistence", "--safe-mode", "--no-chrome",
    "--disable-slash-commands", "--prompt-suggestions", "false", "--exclude-dynamic-system-prompt-sections",
    "--system-prompt", CLAUDE_SYSTEM_PROMPT,
    "--permission-mode", contract.readOnly ? "plan" : "acceptEdits",
    "--json-schema", claudeResultSchema(contract),
    "--tools", contract.readOnly ? "Read,Glob,Grep" : "Read,Glob,Grep,Edit,Write",
  ];
  if (contract.model) args.push("--model", contract.model);
  if (contract.effort) args.push("--effort", contract.effort);
  if (contract.providerAuthMode === "api-key" && contract.maxApiBudgetUsd) args.push("--max-budget-usd", Number(contract.maxApiBudgetUsd).toFixed(2));
  args.push(prompt);
  return args;
}

function structuredClaudeText(body) {
  const value = body?.structured_output || body?.structuredOutput;
  if (!value || typeof value !== "object") return body?.result || body?.message || "";
  return [
    value.outcome,
    ...(Array.isArray(value.evidence) ? value.evidence.map((item) => `- ${item}`) : []),
    ...(Array.isArray(value.checks) ? value.checks.map((item) => `- Check: ${item}`) : []),
    value.blocker ? `- Blocker: ${value.blocker}` : "",
  ].filter(Boolean).join("\n");
}

function normalizeClaudeUsage(body, model) {
  const raw = body?.usage || {};
  const rows = Object.entries(body?.modelUsage || body?.model_usage || {});
  const sum = (keys) => rows.reduce((total, [, value]) => total + Number(keys.map((key) => value?.[key]).find((item) => Number.isFinite(Number(item))) || 0), 0);
  return {
    model: body?.model || rows[0]?.[0] || model || "unknown",
    inputTokens: raw.input_tokens ?? raw.inputTokens ?? (rows.length ? sum(["inputTokens", "input_tokens"]) : null),
    cachedInputTokens: raw.cache_read_input_tokens ?? raw.cacheReadInputTokens ?? (rows.length ? sum(["cacheReadInputTokens", "cache_read_input_tokens"]) : null),
    outputTokens: raw.output_tokens ?? raw.outputTokens ?? (rows.length ? sum(["outputTokens", "output_tokens"]) : null),
    equivalentUsd: body?.total_cost_usd ?? body?.totalCostUsd ?? (rows.length ? sum(["costUSD", "costUsd", "cost_usd"]) : null),
    billingNote: "Equivalent usage telemetry is not a subscription balance or confirmed charge.",
  };
}

function runClaude(providerState, contract, prompt) {
  const args = buildClaudeArgs(contract, prompt);
  const result = commandResult(providerState.command, args, { cwd: contract.workspace, timeout: contract.timeoutSeconds * 1000, maxBuffer: 16 * 1024 * 1024 });
  let body = null;
  try { body = JSON.parse(result.stdout); } catch { /* retain plain output */ }
  const text = structuredClaudeText(body) || result.stdout || result.stderr;
  const ok = result.status === 0 && !body?.is_error;
  return { ok, typedBlocker: ok ? "" : classifyFailure(text, result.status || 1), text, artifact: body?.structured_output || body?.structuredOutput || null, usage: normalizeClaudeUsage(body, contract.model), exitCode: result.status };
}

function buildAntigravityArgs(contract, prompt) {
  const args = ["--print", prompt, "--project", contract.projectId || "default-cli-project", "--add-dir", contract.workspace, "--sandbox", "--mode", contract.readOnly ? "plan" : "accept-edits", "--print-timeout", `${contract.timeoutSeconds}s`];
  if (contract.conversation) args.push("--conversation", contract.conversation);
  if (contract.model) args.push("--model", contract.model);
  return args;
}

function runAntigravity(providerState, contract, prompt) {
  if (contract.needsUi) return { ok: false, typedBlocker: "ui-required", text: "This lane requires visible Antigravity UI state; CLI execution was intentionally not attempted." };
  const args = buildAntigravityArgs(contract, prompt);
  const result = commandResult(providerState.command, args, { cwd: contract.workspace, timeout: contract.timeoutSeconds * 1000, maxBuffer: 16 * 1024 * 1024 });
  const text = result.stdout || result.stderr;
  return { ok: result.status === 0, typedBlocker: result.status === 0 ? "" : classifyFailure(text, result.status), text, usage: { model: contract.model || "unknown" }, exitCode: result.status };
}

function runCursor(providerState, contract, prompt) {
  const args = ["-p", "--workspace", contract.workspace, prompt];
  const result = commandResult(providerState.command, args, { cwd: contract.workspace, timeout: contract.timeoutSeconds * 1000, maxBuffer: 16 * 1024 * 1024 });
  const text = result.stdout || result.stderr;
  return { ok: result.status === 0, typedBlocker: result.status === 0 ? "" : classifyFailure(text, result.status), text, usage: {}, exitCode: result.status };
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

function discoverProvider(id) {
  if (id === "codex") return discoverCodex();
  if (id === "claude") return discoverClaude();
  if (id === "antigravity") return discoverAntigravity();
  if (id === "cursor") return discoverCursor();
  return provider(id || "unknown", false, { reason: "Unknown provider." });
}

module.exports = { antigravityRemaining, buildAntigravityArgs, buildClaudeArgs, claudeResultSchema, classifyFailure, discoverAll, discoverProvider, enrichModel, inferModelTier, normalizeClaudeUsage, numericOrNull, runProvider };
