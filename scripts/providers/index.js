"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { commandResult, resolveCommand, bounded } = require("../core/utils");
const { codexCliCandidates, parseCodexLoginStatus, buildCodexExecArgs, parseCodexJsonl } = require("../lib/codex-cli");
const { parseClaudeAuth, parseClaudeModels, parseClaudeUsage } = require("./claude-usage");
const { deliverableKind, executorKind } = require("../core/typed-deliverables");
const { masterPlanJsonSchema } = require("../core/plan-assurance");
const { assertDirectorWorkerContract } = require("../core/director-worker-contract");

const CODEX_SCHEMA_DIRECTORY_PREFIX = "ai-mobile-codex-schema-";

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

const PROVIDER_PERMISSIONS = {
  codex: { command: true, database: true, "service-control": true, browser: false, "external-write": false },
  claude: { command: true, database: true, "service-control": true, browser: false, "external-write": false },
  antigravity: { command: true, database: true, "service-control": true, browser: true, "external-write": true },
  cursor: { command: false, database: false, "service-control": false, browser: false, "external-write": false },
};

function inferModelTier(row = {}) {
  const identity = `${row.id || ""} ${row.displayName || ""}`.toLowerCase();
  const text = `${identity} ${row.description || ""}`.toLowerCase();
  if (/\b(spark|mini|lite|haiku)\b/.test(identity) || /\bflash[- ]?low\b/.test(identity)) return "efficient";
  if (/\b(fable|opus|ultra)\b/.test(identity) || /\bpro(?:[- ]?high)?\b/.test(identity)) return "frontier";
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

function modelIdentity(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
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

function numericVersion(value) {
  const match = String(value || "").match(/(\d+)\.(\d+)\.(\d+)/);
  return match ? match.slice(1).map(Number) : null;
}

function compareVersions(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

function codexCacheCompatibility(cliVersion, options = {}) {
  const codexRoot = options.codexHome || process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  const cacheFile = path.join(codexRoot, "models_cache.json");
  if (!fs.existsSync(cacheFile)) return { compatible: true, cliVersion: String(cliVersion || ""), cacheVersion: "", reason: "model-cache-absent", reasonCode: "cache-absent" };
  let cache;
  try { cache = JSON.parse(fs.readFileSync(cacheFile, "utf8")); }
  catch {
    return { compatible: false, cliVersion: String(cliVersion || ""), cacheVersion: "invalid", reason: "Codex model cache is not valid JSON.", reasonCode: "cache-invalid" };
  }
  const cli = numericVersion(cliVersion);
  const cached = numericVersion(cache.client_version);
  if (cli && cached && compareVersions(cached, cli) > 0) {
    return {
      compatible: false,
      cliVersion: cli.join("."),
      cacheVersion: cached.join("."),
      reason: `Codex CLI ${cli.join(".")} is older than local model cache ${cached.join(".")}; update the CLI before worker use.`,
      reasonCode: "cache-newer",
    };
  }
  return { compatible: true, cliVersion: cli ? cli.join(".") : String(cliVersion || ""), cacheVersion: cached ? cached.join(".") : "", reason: "compatible", reasonCode: "compatible" };
}

function codexNativeCompatibility(cacheCompatibility, native) {
  if (cacheCompatibility.compatible || cacheCompatibility.reasonCode !== "cache-newer") return cacheCompatibility;
  const models = native?.models?.data || native?.models?.models || [];
  if (!Array.isArray(models) || models.length === 0) return cacheCompatibility;
  return {
    ...cacheCompatibility,
    compatible: true,
    reason: "A fresh native Codex app-server probe returned the current model roster.",
    reasonCode: "native-probe-verified",
    nativeProbeVerified: true,
  };
}

function discoverCodex() {
  const cli = findCodex();
  if (!cli.found) return provider("codex", false, { reason: "Codex CLI not found." });
  const cacheCompatibility = codexCacheCompatibility(cli.version);
  if (!cacheCompatibility.compatible && cacheCompatibility.reasonCode !== "cache-newer") return provider("codex", false, {
    installed: true,
    command: cli.command,
    version: cli.version,
    cacheCompatibility,
    reason: cacheCompatibility.reason,
  });
  const login = commandResult(cli.command, ["login", "status"], { timeout: 7000 });
  const auth = parseCodexLoginStatus(login.stdout, login.stderr);
  const probe = commandResult(process.execPath, [path.join(__dirname, "codex-app-server-probe.js"), cli.command], { timeout: 9000 });
  let native = null;
  try { native = JSON.parse(probe.stdout); } catch { /* native evidence remains unavailable */ }
  const compatibility = codexNativeCompatibility(cacheCompatibility, native);
  if (!compatibility.compatible) return provider("codex", false, {
    installed: true,
    command: cli.command,
    version: cli.version,
    cacheCompatibility: compatibility,
    reason: compatibility.reason,
  });
  const snapshots = native?.rateLimits?.rateLimitsByLimitId || (native?.rateLimits?.rateLimits ? { codex: native.rateLimits.rateLimits } : {});
  const windows = [];
  for (const [limitId, snapshot] of Object.entries(snapshots || {})) {
    for (const name of ["primary", "secondary"]) {
      const window = snapshot?.[name];
      if (!window || !Number.isFinite(Number(window.usedPercent))) continue;
      windows.push({ limitId, limitName: snapshot?.limitName || null, name, remainingPercent: Math.max(0, 100 - Number(window.usedPercent)), resetAt: window.resetsAt ? new Date(Number(window.resetsAt) * 1000).toISOString() : null, windowMinutes: window.windowDurationMins ?? null });
    }
  }
  const modelRows = native?.models?.data || native?.models?.models || [];
  const namedModelIds = new Set();
  for (const window of windows.filter((row) => row.limitName)) {
    const wanted = modelIdentity(window.limitName);
    window.modelIds = modelRows
      .filter((row) => [row.id, row.model, row.slug, row.displayName, row.name].some((value) => modelIdentity(value) === wanted))
      .map((row) => row.id || row.model || row.slug || row.displayName)
      .filter(Boolean);
    window.modelIds.forEach((id) => namedModelIds.add(id));
  }
  for (const window of windows.filter((row) => !row.limitName)) {
    window.modelIds = modelRows
      .map((row) => row.id || row.model || row.slug || row.displayName)
      .filter((id) => id && !namedModelIds.has(id));
  }
  const effectiveWindows = windows.some((item) => item.limitId === "codex") ? windows.filter((item) => item.limitId === "codex") : windows;
  return provider("codex", auth.loggedIn === true, {
    command: cli.command, version: cli.version, authMode: auth.authMode,
    cacheCompatibility: compatibility,
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

function antigravityLimitModels(body = {}) {
  if (Array.isArray(body.Models) && body.Models.length) {
    return body.Models.map((row) => {
      const displayName = String(row?.DisplayName || "").trim();
      const id = modelId(row?.Id || displayName);
      if (!id || !displayName) return null;
      const remainingPercent = numericOrNull(row?.Quota?.RemainingPercent);
      const status = row?.Disabled === true || String(row?.Quota?.Status || "").toLowerCase() === "exhausted" || remainingPercent === 0
        ? "exhausted"
        : String(row?.Quota?.Status || "").toLowerCase() === "available" || (remainingPercent !== null && remainingPercent > 0)
          ? "available"
          : "unknown";
      return { id, displayName, remainingPercent, resetAt: row?.Quota?.ResetTimeUtc || null, status };
    }).filter(Boolean);
  }
  const available = (body?.RecommendedAvailable || []).map((row) => ({ id: modelId(row.Id || row.DisplayName), displayName: row.DisplayName || row.Id || "", remainingPercent: numericOrNull(row.RemainingPercent), resetAt: row.ResetTimeUtc || null, status: "available" }));
  const blocked = (body?.BlockedOrResetting || []).map((row) => ({ id: modelId(row.Id || row.DisplayName), displayName: row.DisplayName || row.Id || "", remainingPercent: 0, resetAt: row.ResetTimeUtc || null, status: "exhausted" }));
  return [...available, ...blocked];
}

function antigravityLimits() {
  for (const helper of antigravityHelperCandidates()) {
    const result = commandResult("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", helper, "models"], { timeout: 20000, maxBuffer: 2 * 1024 * 1024 });
    if (result.status !== 0) continue;
    let body = null;
    try { body = JSON.parse(result.stdout); } catch { continue; }
    const models = antigravityLimitModels(body);
    if (!models.length) continue;
    return { checked: true, source: body?.Source || "antigravity-2-local-helper", generatedAt: body?.GeneratedAtUtc || null, models };
  }
  return { checked: false, source: "agy-roster", generatedAt: null, models: [] };
}

function callableAntigravityModels(rosterModels = [], measuredModels = []) {
  return rosterModels.map((model) => ({
    ...model,
    quota: measuredModels.find((row) => row.id === model.id || modelId(row.displayName) === model.id) || null,
  }));
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
  // The quota helper exposes internal aliases that the headless CLI may not
  // accept. The native agy models roster alone defines callable candidates.
  const models = callableAntigravityModels(rosterModels, measured);
  const enriched = models.map((model) => enrichModel(model));
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
  return { id, installed: Boolean(extra.command), available, authenticated: available, headless: true, confidence: available ? "medium" : "high", models: [], capabilities: PROVIDER_CAPABILITIES[id] || {}, surfaces: PROVIDER_SURFACES[id] || { headless: true }, permissions: PROVIDER_PERMISSIONS[id] || {}, ...extra };
}

function exactPermissionGrant(contract, name) {
  return Array.isArray(contract.permissionGrant)
    && contract.permissionGrant.some((value) => String(value || "").trim().toLowerCase() === name);
}

function permissionPreflightPassed(contract) {
  return contract.permissionPreflight?.ok === true;
}

function sameJson(left, right) {
  try { return JSON.stringify(left) === JSON.stringify(right); }
  catch { return false; }
}

function structuredCommandsValid(commands) {
  return Array.isArray(commands) && commands.length > 0 && commands.every((row) => (
    row
    && typeof row === "object"
    && !Array.isArray(row)
    && Boolean(String(row.command || "").trim())
    && Array.isArray(row.args)
    && row.args.every((arg) => typeof arg === "string")
    && Number(row.timeoutSeconds || 0) > 0
  ));
}

function directorExecutionBinding(contract = {}) {
  if (contract.directorProviderAuthorization !== true || !contract.directorProgram) return false;
  try { assertDirectorWorkerContract(contract.directorWorkerContract); }
  catch { return false; }
  const envelope = contract.directorWorkerContract.executionEnvelope || {};
  const authorization = envelope.authorization || {};
  const revisions = envelope.revisions || {};
  const allocation = contract.allocation || {};
  const exact = (left, right) => String(left ?? "") === String(right ?? "");
  if (!exact(envelope.workPackageId, contract.workPackageId || contract.workGraphNodeId)) return false;
  if (!exact(envelope.workPackageId, contract.directorProgram.workPackageId)) return false;
  if (!exact(envelope.executorKind, contract.executorKind || contract.kind)) return false;
  if (!exact(envelope.deliverableKind, contract.deliverableKind)) return false;
  if (!sameJson(envelope.commands || [], contract.commands || [])) return false;
  if (!sameJson(authorization.requiredCapabilities || [], contract.requiredCapabilities || [])) return false;
  if (!sameJson(envelope.preconditions || [], contract.preconditions || [])) return false;
  if (!sameJson(envelope.postconditions || [], contract.postconditions || [])) return false;
  if (!sameJson(envelope.rollback ?? null, contract.rollback ?? null)) return false;
  if (!exact(envelope.recoveryAction, contract.recoveryAction)) return false;
  if (Boolean(envelope.mutatesExternalState) !== Boolean(contract.mutatesExternalState)) return false;
  if (!exact(envelope.sideEffectKey, contract.sideEffectKey)) return false;
  if (!exact(envelope.observedStateFingerprint, contract.observedStateFingerprint)) return false;
  if (!exact(envelope.userAuthorizationRef, contract.userAuthorizationRef)) return false;
  if (!sameJson(authorization.requiredPermissions || [], contract.requiredPermissions || [])) return false;
  if (!sameJson(authorization.permissionGrant || [], contract.permissionGrant || [])) return false;
  if (!sameJson(authorization.permissionPreflight || null, contract.permissionPreflight || null)) return false;
  if (!exact(revisions.allocationId, allocation.allocationId)) return false;
  if (!sameJson(envelope.allocation || null, contract.allocation || null)) return false;
  if (!exact(revisions.allocationCandidateId, allocation.candidateId)) return false;
  if (!exact(revisions.allocationProvider, allocation.provider) || !exact(allocation.provider, contract.provider)) return false;
  if (!exact(revisions.allocationModel, allocation.model) || !exact(allocation.model, contract.model)) return false;
  if (Number(revisions.allocationTokenLimit || 0) !== Number(allocation.tokenLimit || 0)) return false;
  if (Number(revisions.allocationDurationLimitMs || 0) !== Number(allocation.durationLimitMs || 0)) return false;
  if (Number(revisions.allocationMaxAttempts || 0) !== Number(allocation.maxAttempts || 0)) return false;
  return true;
}

function directorApiBudgetUsd(contract, directorBound) {
  const generic = Number(contract.maxApiBudgetUsd || 0);
  if (!contract.directorProgram) return Number.isFinite(generic) && generic > 0 ? generic : null;
  if (!directorBound) return null;
  const measurement = contract.allocation?.cost?.apiUsd;
  const value = Number(measurement?.value);
  if (measurement?.state !== "known" || measurement?.unit !== "usd" || !Number.isFinite(value) || value < 0) return null;
  return generic > 0 ? Math.min(generic, value) : value;
}

function providerExecutionAccess(contract = {}) {
  const executor = executorKind(contract.executorKind || contract.kind);
  const deliverable = deliverableKind(contract);
  const preflightPassed = permissionPreflightPassed(contract);
  const directorBound = directorExecutionBinding(contract);
  const structuredCommands = structuredCommandsValid(contract.commands);
  const patchWriteEnabled = directorBound
    && preflightPassed
    && executor === "code-change"
    && deliverable === "patch"
    && contract.readOnly !== true
    && exactPermissionGrant(contract, "write-files")
    && (
      !(contract.requiredCapabilities || []).includes("command")
      || exactPermissionGrant(contract, "run-command")
    );
  const commandExecutor = ["context-scout", "evidence-observer", "verification", "operational-transaction"].includes(executor);
  const commandToolsEnabled = directorBound
    && preflightPassed
    && commandExecutor
    && exactPermissionGrant(contract, "run-command")
    && structuredCommands
    && (executor !== "operational-transaction" || contract.directorEffectAuthorization === true);
  const commandMutationEnabled = commandToolsEnabled && executor === "operational-transaction";
  const browserGranted = directorBound && preflightPassed && exactPermissionGrant(contract, "browser");
  const externalWriteGranted = directorBound
    && preflightPassed
    && contract.directorEffectAuthorization === true
    && exactPermissionGrant(contract, "external-write")
    && Boolean(String(contract.userAuthorizationRef || "").trim());
  const browserMutationEnabled = executor === "browser-action"
    && contract.mutatesExternalState === true
    && browserGranted
    && externalWriteGranted
    && structuredCommands;
  const externalMutationEnabled = (executor === "external-transaction" || deliverable === "external-transaction-receipt")
    && externalWriteGranted
    && structuredCommands;
  return {
    executor,
    deliverable,
    directorBound,
    preflightPassed,
    patchWriteEnabled,
    commandToolsEnabled,
    browserGranted,
    commandMutationEnabled,
    browserMutationEnabled,
    externalMutationEnabled,
  };
}

function classifyFailure(value, exitCode, timedOut = false) {
  const text = String(value || "").toLowerCase();
  if (timedOut) return "provider-timeout";
  if (/error_max_structured_output_retries|failed to provide valid structured output after \d+ attempts?/.test(text)) return "provider-output-invalid";
  if (/tool required.{0,240}permission|permission.{0,240}cannot prompt|auto-denied|(?:missing|not (?:present|included)).{0,120}permissions\.allow|permissions\.allow.{0,120}(?:required|missing|denied)/.test(text)) return "authorization-required";
  if (exitCode === 0) return "";
  if (/transport closed|econnreset|econnrefused|socket hang up|broken pipe|connection (?:closed|reset|refused)/.test(text)) return "transport-unavailable";
  if (/etimedout|timedout|timed? out|timeout|deadline exceeded/.test(text)) return "provider-timeout";
  if (/rate.?limit|quota|usage limit|capacity.*exhaust|model.*unavailable/.test(text)) return "capacity-unavailable";
  if (/not logged in|login required|unauthorized|authentication|invalid.*token|oauth/.test(text)) return "authentication-required";
  if (/permission|approval required|access denied/.test(text)) return "authorization-required";
  return "provider-process-failed";
}

function codexReadOnlyMode(contract = {}) {
  const access = providerExecutionAccess(contract);
  const patchOutputWriter = access.deliverable === "patch" && contract.readOnly !== true && contract.skipModelReview !== true;
  const authorizedMutation = access.commandMutationEnabled || access.browserMutationEnabled || access.externalMutationEnabled;
  return patchOutputWriter || !authorizedMutation;
}

function codexInvocationModelUsage(model, ok) {
  const exactModel = String(model || "").trim();
  const verified = ok === true && Boolean(exactModel);
  return {
    model: verified ? exactModel : "unknown",
    requestedModel: exactModel,
    actualModelId: verified ? exactModel : "",
    principalModelObserved: verified,
    modelIdentityMatched: verified,
    identitySource: verified ? "codex-cli-exact-catalog-bound-model-argument" : "unavailable",
    identityRationale: verified
      ? "Codex CLI received one exact validated --model argument and completed that invocation successfully."
      : "A successful exact Codex CLI invocation was not observed.",
  };
}

function codexModelIdentityEvidence(requestedModel, args = [], parsed = {}, successful = false) {
  const requested = bounded(String(requestedModel || "").trim(), 240);
  if (!successful || !requested) return { observed: false, matched: false, actualModelId: "", source: "" };
  const reported = bounded(String(parsed.actualModelId || "").trim(), 240);
  if (reported) {
    return {
      observed: true,
      matched: modelIdentity(reported) === modelIdentity(requested),
      actualModelId: reported,
      source: String(parsed.modelIdentitySource || "codex-jsonl-resolved-model"),
    };
  }
  const modelArgIndex = args.findIndex((value) => String(value) === "--model");
  const exactArgumentBound = modelArgIndex >= 0 && String(args[modelArgIndex + 1] || "") === requested;
  return exactArgumentBound
    ? { observed: true, matched: true, actualModelId: requested, source: "successful-exact-codex-model-argument" }
    : { observed: false, matched: false, actualModelId: "", source: "" };
}

function prepareCodexInvocation(contract) {
  const model = contract.model;
  const readOnly = codexReadOnlyMode(contract);
  const kind = deliverableKind(contract);
  const schema = contract.artifactKind !== "work-plan" && kind !== "patch"
    ? typedClaudeSchema(kind, Math.max(1200, Math.min(24000, Number(contract.maxWorkerOutputTokens || 4000) * 4)), contract)
    : null;
  let schemaRoot = null;
  let schemaFile = null;
  if (schema) {
    schemaRoot = fs.mkdtempSync(path.join(os.tmpdir(), CODEX_SCHEMA_DIRECTORY_PREFIX));
    try { fs.chmodSync(schemaRoot, 0o700); } catch { /* Windows ACLs remain authoritative. */ }
    schemaFile = path.join(schemaRoot, "schema.json");
    fs.writeFileSync(schemaFile, JSON.stringify(schema), { encoding: "utf8", mode: 0o600, flag: "wx" });
  }
  return {
    args: buildCodexExecArgs({ workspace: contract.workspace, model, effort: contract.effort || "medium", readOnly, outputSchema: schemaFile }),
    schemaFile,
    cleanup() {
      if (!schemaRoot) return;
      const resolved = path.resolve(schemaRoot);
      if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith(CODEX_SCHEMA_DIRECTORY_PREFIX)) {
        throw new Error("Refusing Codex schema cleanup outside the dedicated temporary boundary.");
      }
      fs.rmSync(resolved, { recursive: true, force: true });
    },
  };
}

function runCodex(providerState, contract, prompt) {
  const model = contract.model;
  if (!model) return { ok: false, typedBlocker: "model-unavailable", text: "No allowed Codex model was selected from the native catalog." };
  const invocation = prepareCodexInvocation(contract);
  let result;
  try {
    result = commandResult(providerState.command, invocation.args, { cwd: contract.workspace, input: prompt, timeout: contract.timeoutSeconds * 1000, maxBuffer: 16 * 1024 * 1024 });
  } finally {
    invocation.cleanup();
  }
  const parsed = parseCodexJsonl(result.stdout);
  const processOk = !result.timedOut && result.status === 0 && !parsed.turnFailed;
  const identity = codexModelIdentityEvidence(model, invocation.args, parsed, processOk);
  const partial = parsed.resultText || result.stderr;
  let text = result.timedOut ? `Codex worker exceeded ${contract.timeoutSeconds} seconds before final structured output. Partial output: ${partial || "none"}` : partial;
  let typedBlocker = processOk ? "" : classifyFailure(text, result.status ?? 1, result.timedOut);
  if (processOk && !identity.observed) typedBlocker = "model-identity-unavailable";
  else if (processOk && !identity.matched) typedBlocker = "model-identity-mismatch";
  if (typedBlocker === "model-identity-mismatch") text = `${text ? text + "\n" : ""}Codex resolved model ${identity.actualModelId || "unknown"}, but the exact catalog-bound request was ${model}.`;
  return {
    ok: processOk && !typedBlocker,
    typedBlocker,
    text,
    usage: {
      model: identity.actualModelId || "unknown",
      requestedModel: model,
      actualModelId: identity.actualModelId,
      actualModel: identity.actualModelId,
      principalModelObserved: identity.observed,
      modelIdentityMatched: identity.matched,
      modelIdentitySource: identity.source,
      inputTokens: parsed.inputTokens,
      cachedInputTokens: parsed.cachedInputTokens,
      outputTokens: parsed.outputTokens,
    },
    exitCode: result.status,
  };
}

const CLAUDE_SYSTEM_PROMPT = "You are a bounded project worker. Follow the supplied lane contract exactly. Never broaden scope, delegate, or interact with the visible project console. Use only the enabled local file tools. For read-only lanes do not edit. Stop when the requested evidence is sufficient and return only the required JSON.";

function typedClaudeSchema(kind, characterBudget, contract = {}) {
  const text = (maximum = 1200) => ({ type: "string", maxLength: Math.min(maximum, characterBudget) });
  const strings = (maxItems = 30, maximum = 1200) => ({ type: "array", maxItems, items: text(maximum) });
  const objects = (maxItems = 60) => ({ type: "array", maxItems, items: { type: "object", additionalProperties: true } });
  if (["operation-receipt", "browser-receipt", "external-transaction-receipt", "monitoring-evidence", "verification-result"].includes(kind)) {
    const check = {
      type: "object",
      additionalProperties: false,
      properties: { name: text(160), passed: { type: "boolean" }, evidence: text(1200) },
      required: ["name", "passed", "evidence"],
    };
    return {
      type: "object",
      additionalProperties: false,
      properties: {
        kind: { type: "string", enum: [kind] },
        state: { type: "string", enum: ["applied", "no-op", "observed", "verified", "failed"] },
        sideEffectKey: text(240),
        observedStateFingerprintBefore: text(160),
        observedStateFingerprintAfter: text(160),
        userAuthorizationRef: text(500),
        idempotency: {
          type: "object",
          additionalProperties: false,
          properties: { checked: { type: "boolean" }, duplicate: { type: "boolean" }, key: text(240), evidence: text(1200) },
          required: ["checked", "duplicate", "key", "evidence"],
        },
        preconditions: { type: "array", minItems: 1, maxItems: 30, items: check },
        actions: { type: "array", maxItems: 60, items: check },
        postconditions: { type: "array", minItems: 1, maxItems: 30, items: check },
        rollback: {
          type: "object",
          additionalProperties: false,
          properties: { available: { type: "boolean" }, executed: { type: "boolean" }, evidence: text(1200) },
          required: ["available", "executed", "evidence"],
        },
        evidence: strings(30),
        acceptanceEvidence: objects(30),
        blocker: text(1200),
      },
      required: ["kind", "state", "sideEffectKey", "observedStateFingerprintBefore", "observedStateFingerprintAfter", "userAuthorizationRef", "idempotency", "preconditions", "actions", "postconditions", "rollback", "evidence", "acceptanceEvidence", "blocker"],
    };
  }
  if (kind === "context-dossier") {
    const claim = {
      type: "object",
      additionalProperties: false,
      properties: { text: text(1200), sourceIds: strings(20, 100) },
      required: ["text", "sourceIds"],
    };
    const observation = {
      type: "object",
      additionalProperties: false,
      properties: {
        sourceId: text(100),
        status: { type: "string", enum: ["observed", "unchanged", "unavailable"] },
        fingerprint: text(128),
        queryReceiptFingerprint: text(128),
        queryReceiptSnapshotHash: text(128),
        revision: text(240),
        summary: text(1200),
        error: text(600),
      },
      required: ["sourceId", "status", "fingerprint", "queryReceiptFingerprint", "queryReceiptSnapshotHash", "revision", "summary", "error"],
    };
    const claims = { type: "array", maxItems: 60, items: claim };
    return {
      type: "object", additionalProperties: false,
      properties: {
        kind: { type: "string", enum: ["context-dossier", "context-scout"] },
        realGoal: text(6000), executiveSummary: text(6000),
        currentState: claims,
        sourceObservations: { type: "array", maxItems: 500, items: observation },
        facts: claims, assumptions: claims, unknowns: claims, constraints: claims, decisions: claims,
        failures: claims, risks: claims, acceptanceState: claims,
      },
      required: ["kind", "realGoal", "executiveSummary", "currentState", "sourceObservations", "facts", "assumptions", "unknowns", "constraints", "decisions", "failures", "risks"],
    };
  }
  if (kind === "master-plan") {
    return contract.directorWorkerContract?.executionEnvelope?.artifactContract?.jsonSchema
      || masterPlanJsonSchema();
  }
  if (kind === "reconciliation-decision") {
    const requiredFailureFingerprint = String(contract.directorWorkerContract?.reconciliation?.failurePacket?.failureFingerprint || "").trim();
    const failureFingerprint = requiredFailureFingerprint
      ? { type: "string", const: requiredFailureFingerprint, maxLength: 160 }
      : text(160);
    const requiredContextRefresh = contract.directorWorkerContract?.executionEnvelope?.artifactContract?.requiredContextRefresh === true;
    return {
      type: "object", additionalProperties: false,
      properties: {
        kind: { type: "string", enum: [kind] }, failureFingerprint, rootCause: text(2000),
        failureClass: text(120), evidence: strings(30), contextRefresh: requiredContextRefresh ? { type: "boolean", const: true } : { type: "boolean" },
        planRevision: { type: ["object", "null"], additionalProperties: true },
        changedContract: { type: ["object", "null"], additionalProperties: true },
        changedWorkerRequirements: { type: ["object", "null"], additionalProperties: true },
        changedPermissions: { type: ["object", "null"], additionalProperties: true },
        retryEligibility: { type: "boolean" }, userDecision: { type: ["object", "null"], additionalProperties: true },
        blocker: text(1200),
      },
      required: ["kind", "failureFingerprint", "rootCause", "failureClass", "evidence", "contextRefresh", "planRevision", "changedContract", "changedWorkerRequirements", "changedPermissions", "retryEligibility", "userDecision", "blocker"],
    };
  }
  return null;
}

function claudeResultSchema(contractOrTokens = 1200) {
  const contract = typeof contractOrTokens === "object" ? contractOrTokens : {};
  const maxOutputTokens = typeof contractOrTokens === "object" ? contractOrTokens.maxWorkerOutputTokens : contractOrTokens;
  const characterBudget = Math.max(1200, Math.min(12000, Math.floor(Number(maxOutputTokens || 1200) * 3)));
  const typed = contract.artifactKind !== "work-plan" ? typedClaudeSchema(deliverableKind(contract), characterBudget, contract) : null;
  if (typed) return JSON.stringify(typed);
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
function buildClaudeArgs(contract) {
  const access = providerExecutionAccess(contract);
  const patchWriter = access.deliverable === "patch" && contract.readOnly !== true;
  const tools = ["Read", "Glob", "Grep"];
  if (patchWriter) tools.push("Edit", "Write");
  if (access.commandToolsEnabled) tools.push("Bash");
  const mutating = patchWriter || access.commandMutationEnabled || access.browserMutationEnabled || access.externalMutationEnabled;
  const args = [
    "-p", "--output-format", "json", "--no-session-persistence", "--safe-mode", "--no-chrome",
    "--disable-slash-commands", "--prompt-suggestions", "false", "--exclude-dynamic-system-prompt-sections",
    "--system-prompt", CLAUDE_SYSTEM_PROMPT,
    "--permission-mode", mutating ? "acceptEdits" : "plan",
    "--json-schema", claudeResultSchema(contract),
    "--tools", tools.join(","),
  ];
  if (contract.model) args.push("--model", antigravityCliModelArgument(contract.model));
  if (contract.effort) args.push("--effort", contract.effort);
  const maxApiBudgetUsd = directorApiBudgetUsd(contract, access.directorBound);
  if (contract.providerAuthMode === "api-key" && maxApiBudgetUsd > 0) args.push("--max-budget-usd", String(maxApiBudgetUsd));
  return args;
}

function claudeInvocation(contract, prompt) {
  return {
    args: buildClaudeArgs(contract),
    input: String(prompt || ""),
  };
}

function structuredClaudeText(body) {
  const value = body?.structured_output || body?.structuredOutput;
  if (!value || typeof value !== "object") return body?.result || body?.message || "";
  if (!Object.prototype.hasOwnProperty.call(value, "outcome")) return JSON.stringify(value);
  return [
    value.outcome,
    ...(Array.isArray(value.evidence) ? value.evidence.map((item) => `- ${item}`) : []),
    ...(Array.isArray(value.checks) ? value.checks.map((item) => `- Check: ${item}`) : []),
    value.blocker ? `- Blocker: ${value.blocker}` : "",
  ].filter(Boolean).join("\n");
}

function claudeUsageNumber(value, keys) {
  for (const key of keys) {
    const raw = value?.[key];
    if (raw === null || raw === undefined || raw === "") continue;
    const number = Number(raw);
    if (Number.isFinite(number)) return Math.max(0, number);
  }
  return null;
}

const CLAUDE_MODEL_FAMILIES = new Set(["opus", "sonnet", "haiku", "fable", "mythos"]);

function claudeModelDescriptor(value) {
  const tokens = String(value || "").trim().toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  if (tokens[0] === "claude") tokens.shift();
  const family = tokens.find((token) => CLAUDE_MODEL_FAMILIES.has(token)) || "";
  const alias = Boolean(family && tokens.length === 1 && tokens[0] === family);
  return { identity: tokens.join(""), family, alias };
}

function claudeModelIdentityMatch(requestedModel, actualModel) {
  const requested = claudeModelDescriptor(requestedModel);
  const actual = claudeModelDescriptor(actualModel);
  if (!requested.identity || !actual.identity) return { matched: false, reason: "model-identity-unavailable", alias: false };
  if (requested.alias && requested.family === actual.family) return { matched: true, reason: "catalog-family-alias", alias: true };
  if (requested.identity === actual.identity) return { matched: true, reason: "exact-normalized-model", alias: false };
  return { matched: false, reason: requested.family && requested.family === actual.family ? "explicit-version-or-tier-mismatch" : "model-family-mismatch", alias: false };
}

function claudeModelMatchScore(observed, requested) {
  const actual = claudeModelDescriptor(observed);
  const wanted = claudeModelDescriptor(requested);
  if (!actual.identity || !wanted.identity) return 0;
  if (actual.identity === wanted.identity) return 1000;
  if (wanted.alias && wanted.family === actual.family) return 800;
  return wanted.family && wanted.family === actual.family ? 100 : 0;
}

function normalizeClaudeUsage(body, model) {
  const raw = body?.usage || {};
  const rows = Object.entries(body?.modelUsage || body?.model_usage || {}).map(([id, value]) => ({
    model: id,
    inputTokens: claudeUsageNumber(value, ["inputTokens", "input_tokens"]),
    cacheCreationInputTokens: claudeUsageNumber(value, ["cacheCreationInputTokens", "cache_creation_input_tokens"]),
    cacheReadInputTokens: claudeUsageNumber(value, ["cacheReadInputTokens", "cache_read_input_tokens"]),
    outputTokens: claudeUsageNumber(value, ["outputTokens", "output_tokens"]),
    equivalentUsd: claudeUsageNumber(value, ["costUSD", "costUsd", "cost_usd"]),
  }));
  const aggregate = (key) => rows.length > 0 && rows.every((row) => row[key] !== null)
    ? rows.reduce((total, row) => total + row[key], 0)
    : null;
  const principal = [...rows]
    .map((row, index) => ({ row, index, score: claudeModelMatchScore(row.model, model) }))
    .sort((left, right) => right.score - left.score || (right.row.outputTokens || 0) - (left.row.outputTokens || 0) || left.index - right.index)[0];
  const principalObserved = Boolean(principal?.score);
  const actualModel = bounded(String(body?.model || (principalObserved ? principal.row.model : "")).trim(), 240);
  const identity = claudeModelIdentityMatch(model, actualModel);
  const actualModelId = actualModel
    ? (identity.matched && model ? String(model).trim() : actualModel.toLowerCase().replace(/[^a-z0-9.]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, ""))
    : "";
  const inputTokens = rows.length ? aggregate("inputTokens") : claudeUsageNumber(raw, ["input_tokens", "inputTokens"]);
  const cacheCreationInputTokens = rows.length ? aggregate("cacheCreationInputTokens") : claudeUsageNumber(raw, ["cache_creation_input_tokens", "cacheCreationInputTokens"]);
  const cacheReadInputTokens = rows.length ? aggregate("cacheReadInputTokens") : claudeUsageNumber(raw, ["cache_read_input_tokens", "cacheReadInputTokens"]);
  const outputTokens = rows.length ? aggregate("outputTokens") : claudeUsageNumber(raw, ["output_tokens", "outputTokens"]);
  const totalInputTokens = [inputTokens, cacheCreationInputTokens, cacheReadInputTokens].every((value) => value !== null)
    ? inputTokens + cacheCreationInputTokens + cacheReadInputTokens
    : null;
  const totalTokens = totalInputTokens !== null && outputTokens !== null ? totalInputTokens + outputTokens : null;
  const equivalentUsd = claudeUsageNumber(body, ["total_cost_usd", "totalCostUsd"]) ?? aggregate("equivalentUsd");
  return {
    model: actualModelId || "unknown",
    requestedModel: model || "",
    actualModelId,
    actualModel,
    principalModelObserved: Boolean(actualModel),
    modelIdentityMatched: identity.matched,
    modelIdentityReason: identity.reason,
    modelIdentitySource: body?.model ? "claude-result-model" : principalObserved ? "claude-model-usage" : "",
    inputTokens,
    cacheCreationInputTokens,
    cacheReadInputTokens,
    cachedInputTokens: cacheReadInputTokens,
    outputTokens,
    totalInputTokens,
    totalTokens,
    durationMs: claudeUsageNumber(body, ["duration_ms", "durationMs"]),
    equivalentUsd,
    resourceAccountingComplete: totalTokens !== null,
    modelUsage: rows,
    auxiliaryModels: rows.filter((row) => row.model !== principal?.row?.model).map((row) => row.model),
    billingNote: "Equivalent usage telemetry is not a subscription balance or confirmed charge.",
  };
}

function runClaude(providerState, contract, prompt) {
  const invocation = claudeInvocation(contract, prompt);
  const result = commandResult(providerState.command, invocation.args, { cwd: contract.workspace, input: invocation.input, timeout: contract.timeoutSeconds * 1000, maxBuffer: 16 * 1024 * 1024 });
  let body = null;
  try { body = JSON.parse(result.stdout); } catch { /* retain plain output */ }
  const partial = structuredClaudeText(body) || result.stdout || result.stderr;
  let text = result.timedOut ? `Claude worker exceeded ${contract.timeoutSeconds} seconds before final structured output. Partial output: ${partial || "none"}` : partial;
  const processOk = !result.timedOut && result.status === 0 && !body?.is_error;
  const usage = normalizeClaudeUsage(body, contract.model);
  let typedBlocker = processOk ? "" : classifyFailure(text, result.status ?? 1, result.timedOut);
  if (processOk && contract.model && !usage.principalModelObserved) typedBlocker = "model-identity-unavailable";
  else if (processOk && contract.model && !usage.modelIdentityMatched) typedBlocker = "model-identity-mismatch";
  if (typedBlocker === "model-identity-mismatch") text = `${text ? text + "\n" : ""}Claude model identity mismatch: requested ${contract.model}; resolved ${usage.actualModel || "unknown"}; reason ${usage.modelIdentityReason}.`;
  return { ok: processOk && !typedBlocker, typedBlocker, text, artifact: body?.structured_output || body?.structuredOutput || null, usage, exitCode: result.status };
}

function antigravityCliModelArgument(model) {
  const value = String(model || "").trim();
  const pro = value.match(/^gemini-([0-9]+(?:.[0-9]+)?)-pro-(high|low)$/i);
  if (!pro) return value;
  const tier = pro[2].slice(0, 1).toUpperCase() + pro[2].slice(1).toLowerCase();
  return `Gemini ${pro[1]} Pro (${tier})`;
}

function buildAntigravityArgs(contract, prompt) {
  const access = providerExecutionAccess(contract);
  const patchWriter = access.deliverable === "patch" && contract.readOnly !== true;
  const authorizedMutation = access.commandMutationEnabled || access.browserMutationEnabled || access.externalMutationEnabled;
  const authorizedExecution = authorizedMutation || access.patchWriteEnabled;
  const permissions = new Set([...(contract.requiredPermissions || []), ...(contract.permissionGrant || [])].map((value) => String(value || "").toLowerCase()));
  const capabilities = new Set((contract.requiredCapabilities || []).map((value) => String(value || "").toLowerCase()));
  const safeDirectorReadOnly = access.directorBound
    && contract.readOnly === true
    && contract.permissionPreflight?.ok === true
    && !(contract.commands || []).length
    && !permissions.has("run-command")
    && !permissions.has("external-write")
    && !permissions.has("browser")
    && !capabilities.has("command")
    && !capabilities.has("browser");
  const args = ["--print", prompt, "--project", contract.projectId || "default-cli-project", "--add-dir", contract.workspace, "--sandbox", "--mode", patchWriter || authorizedMutation ? "accept-edits" : "plan", "--print-timeout", `${contract.timeoutSeconds}s`];
  if (authorizedExecution || safeDirectorReadOnly) args.push("--dangerously-skip-permissions");
  if (contract.conversation) args.push("--conversation", contract.conversation);
  if (contract.model) args.push("--model", antigravityCliModelArgument(contract.model));
  return args;
}

const ANTIGRAVITY_INLINE_PROMPT_MAX_CHARS = 8000;
const ANTIGRAVITY_INVOCATION_DIRECTORY_PREFIX = "ai-mobile-antigravity-invocation-";
const ANTIGRAVITY_LOG_MAX_BYTES = 256 * 1024;

function boundedAntigravityLog(logFile) {
  if (!logFile || !fs.existsSync(logFile)) return "";
  let handle;
  try {
    const size = Math.min(Math.max(0, fs.statSync(logFile).size), ANTIGRAVITY_LOG_MAX_BYTES);
    if (!size) return "";
    const buffer = Buffer.alloc(size);
    handle = fs.openSync(logFile, "r");
    const bytesRead = fs.readSync(handle, buffer, 0, size, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } catch {
    return "";
  } finally {
    if (handle !== undefined) {
      try { fs.closeSync(handle); } catch { /* best-effort close before isolated cleanup */ }
    }
  }
}

function parseAntigravityResolvedModelLog(value) {
  const source = String(value || "").slice(0, ANTIGRAVITY_LOG_MAX_BYTES);
  const pattern = /Propagating selected model override to backend:\s*label=(?:"([^"\r\n]{1,240})"|'([^'\r\n]{1,240})'|([^\r\n]{1,240}))/gi;
  let resolved = "";
  let match;
  while ((match = pattern.exec(source)) !== null) resolved = match[1] || match[2] || match[3] || "";
  return bounded(resolved.replace(/[\u0000-\u001f\u007f]/g, " ").trim(), 200);
}

function antigravityModelDescriptor(value) {
  const normalized = String(value || "").trim().toLowerCase().replace(/([a-z])([0-9])/g, "$1 $2").replace(/([0-9])([a-z])/g, "$1 $2");
  const tokens = normalized.split(/[^a-z0-9]+/).filter(Boolean);
  let tier = "";
  const tierIndexes = new Set();
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const next = tokens[index + 1];
    if (token === "very" && next === "high") {
      tier = "very-high";
      tierIndexes.add(index);
      tierIndexes.add(index + 1);
      index += 1;
    } else if (["veryhigh", "vhigh"].includes(token)) {
      tier = "very-high";
      tierIndexes.add(index);
    } else if (["low", "efficient"].includes(token)) {
      tier = "low";
      tierIndexes.add(index);
    } else if (["medium", "balanced"].includes(token)) {
      tier = "medium";
      tierIndexes.add(index);
    } else if (["high", "ultra"].includes(token)) {
      tier = token;
      tierIndexes.add(index);
    }
  }
  return { identity: tokens.join(""), baseIdentity: tokens.filter((_, index) => !tierIndexes.has(index)).join(""), tier };
}

function antigravityModelIdentityMatch(requestedModel, actualModel) {
  const requested = antigravityModelDescriptor(requestedModel);
  const actual = antigravityModelDescriptor(actualModel);
  if (!requested.identity || !actual.identity) return { matched: false, reason: "model-identity-unavailable", requestedTier: requested.tier, actualTier: actual.tier };
  if (requested.baseIdentity !== actual.baseIdentity) return { matched: false, reason: "model-family-or-version-mismatch", requestedTier: requested.tier, actualTier: actual.tier };
  if (requested.tier && requested.tier !== actual.tier) return { matched: false, reason: "model-tier-mismatch", requestedTier: requested.tier, actualTier: actual.tier };
  return { matched: true, reason: requested.tier ? "exact-normalized-model-and-tier" : "exact-normalized-model", requestedTier: requested.tier, actualTier: actual.tier };
}

function prepareAntigravityInvocation(contract, prompt) {
  const completePrompt = String(prompt || "");
  const tempRoot = path.resolve(os.tmpdir());
  const invocationRoot = fs.mkdtempSync(path.join(tempRoot, ANTIGRAVITY_INVOCATION_DIRECTORY_PREFIX));
  try { fs.chmodSync(invocationRoot, 0o700); } catch { /* Windows ACLs remain authoritative */ }
  const logFile = path.join(invocationRoot, "agy.log");
  let promptFile = null;
  let transport = "argv";
  let providerPrompt = completePrompt;
  if (completePrompt.length > ANTIGRAVITY_INLINE_PROMPT_MAX_CHARS) {
    transport = "isolated-prompt-file";
    promptFile = path.join(invocationRoot, "prompt.txt");
    fs.writeFileSync(promptFile, completePrompt, { encoding: "utf8", mode: 0o600, flag: "wx" });
    providerPrompt = [
      "Read the complete UTF-8 worker instructions from this exact file before doing anything:",
      promptFile,
      "This file's directory contains instructions only; it is not the project workspace.",
      "Use the separately added project workspace for every project read or action.",
      "Treat the file contents as the full authoritative prompt. Follow every instruction in it and return only the result it requires.",
    ].join("\n");
  }
  const args = buildAntigravityArgs(contract, providerPrompt);
  args.unshift("--log-file", logFile);
  if (promptFile) {
    const projectDirectoryIndex = args.indexOf("--add-dir");
    args.splice(projectDirectoryIndex >= 0 ? projectDirectoryIndex : args.length, 0, "--add-dir", invocationRoot);
  }
  return {
    args,
    transport,
    promptFile,
    logFile,
    resolvedModel() { return parseAntigravityResolvedModelLog(boundedAntigravityLog(logFile)); },
    cleanup() {
      const resolved = path.resolve(invocationRoot);
      if (path.dirname(resolved) !== tempRoot || !path.basename(resolved).startsWith(ANTIGRAVITY_INVOCATION_DIRECTORY_PREFIX)) {
        throw new Error("Refusing Antigravity invocation cleanup outside the dedicated temporary boundary.");
      }
      fs.rmSync(resolved, { recursive: true, force: true });
    },
  };
}

function runAntigravity(providerState, contract, prompt) {
  if (contract.needsUi) return { ok: false, typedBlocker: "ui-required", text: "This lane requires visible Antigravity UI state; CLI execution was intentionally not attempted." };
  const invocation = prepareAntigravityInvocation(contract, prompt);
  let result;
  let actualModel = "";
  try {
    result = commandResult(providerState.command, invocation.args, { cwd: contract.workspace, timeout: contract.timeoutSeconds * 1000, maxBuffer: 16 * 1024 * 1024 });
    actualModel = invocation.resolvedModel();
  } finally {
    invocation.cleanup();
  }
  const requestedModel = bounded(String(contract.model || "").trim(), 200);
  const identity = antigravityModelIdentityMatch(requestedModel, actualModel);
  const partial = [result.stdout, result.stderr].filter(Boolean).join("\n");
  let text = result.timedOut ? `Antigravity worker exceeded ${contract.timeoutSeconds} seconds before final structured output. Partial output: ${partial || "none"}` : partial;
  let typedBlocker = classifyFailure(text, result.status, result.timedOut);
  if (!typedBlocker && requestedModel && !actualModel) typedBlocker = "model-identity-unavailable";
  else if (!typedBlocker && requestedModel && !identity.matched) typedBlocker = "model-identity-mismatch";
  if (typedBlocker === "model-identity-unavailable") text = `${text ? text + "\n" : ""}Antigravity did not provide an authoritative resolved-model identity.`;
  if (typedBlocker === "model-identity-mismatch") text = `${text ? text + "\n" : ""}Antigravity model identity mismatch: requested ${requestedModel}; resolved ${actualModel}; reason ${identity.reason}.`;
  const actualModelId = actualModel ? (identity.matched && requestedModel ? requestedModel : actualModel.toLowerCase().replace(/[^a-z0-9.]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "")) : "";
  return {
    ok: !result.timedOut && result.status === 0 && !typedBlocker,
    typedBlocker,
    text,
    usage: {
      model: actualModelId || "unknown",
      actualModelId,
      requestedModel,
      actualModel,
      principalModelObserved: Boolean(actualModel),
      modelIdentityMatched: identity.matched,
      modelIdentityReason: identity.reason,
      promptTransport: invocation.transport,
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      resourceAccountingComplete: false,
    },
    exitCode: result.status,
  };
}

function runCursor(providerState, contract, prompt) {
  const args = ["-p", "--workspace", contract.workspace, prompt];
  const result = commandResult(providerState.command, args, { cwd: contract.workspace, timeout: contract.timeoutSeconds * 1000, maxBuffer: 16 * 1024 * 1024 });
  const partial = result.stdout || result.stderr;
  const text = result.timedOut ? `Cursor worker exceeded ${contract.timeoutSeconds} seconds before final structured output. Partial output: ${partial || "none"}` : partial;
  const ok = !result.timedOut && result.status === 0;
  return { ok, typedBlocker: ok ? "" : classifyFailure(text, result.status, result.timedOut), text, usage: {}, exitCode: result.status };
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

module.exports = { antigravityCliModelArgument, antigravityLimitModels, callableAntigravityModels, antigravityModelIdentityMatch, antigravityRemaining, buildAntigravityArgs, buildClaudeArgs, claudeInvocation, claudeModelIdentityMatch, claudeResultSchema, classifyFailure, codexCacheCompatibility, codexNativeCompatibility, codexInvocationModelUsage, codexModelIdentityEvidence, codexReadOnlyMode, discoverAll, discoverProvider, enrichModel, inferModelTier, normalizeClaudeUsage, numericOrNull, parseAntigravityResolvedModelLog, prepareAntigravityInvocation, prepareCodexInvocation, providerExecutionAccess, runProvider, typedClaudeSchema };
