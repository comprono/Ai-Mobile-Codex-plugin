#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-mobile-provider-capability-"));
process.env.LOCALAPPDATA = path.join(root, "local");
process.env.AI_MOBILE_DATA_ROOT = path.join(root, "state");
const diagnosticKeyName = ["ANTHROPIC", "API", "KEY"].join("_");
const diagnosticKeyValue = ["diagnostic", "fixture"].join("-");
process.env[diagnosticKeyName] = diagnosticKeyValue;
const workspace = path.join(root, "workspace");
fs.mkdirSync(workspace, { recursive: true });
fs.writeFileSync(path.join(workspace, "source.txt"), "fixture\n", "utf8");
const antigravityPermissionFixture = path.join(root, "agy-permission.cmd");
fs.writeFileSync(antigravityPermissionFixture, '@echo off\r\necho jetski: a tool required the "command" permission; headless mode cannot prompt, so it was auto-denied.\r\nexit /b 0\r\n', "utf8");

const { providerDiagnostics } = require("./core/provider-diagnostics");
const { classifyFailure: classifyProgramFailure } = require("./core/failure-reconciler");
const { providerHistory } = require("./core/provider-history");
const { normalizeRequest, route } = require("./core/router");
const { writeProfile } = require("./lib/orchestrator-profile");
const { antigravityCliModelArgument, antigravityLimitModels, buildAntigravityArgs, callableAntigravityModels, classifyFailure, codexCacheCompatibility, codexNativeCompatibility, enrichModel, inferModelTier, runProvider } = require("./providers");

const resetSoon = new Date(Date.now() + 60 * 60 * 1000).toISOString();
const providers = {
  codex: {
    id: "codex", installed: true, available: true, authenticated: true, headless: true, authMode: "chatgpt", command: "C:/fixture/codex.exe", version: "fixture",
    surfaces: { headless: true, source: true, "local-files": true, git: true, tests: true, browser: false, github: false, api: false, "project-tools": false },
    permissions: { command: true, database: true, "service-control": true, browser: false, "external-write": false },
    capabilities: { code: 90, architecture: 90, browser: 10 },
    models: [enrichModel({ id: "gpt-future-frontier", displayName: "Future Frontier", description: "Most capable frontier model", supportedReasoningEfforts: ["low", "high"], defaultReasoningEffort: "low" })],
    capacity: { effectiveRemainingPercent: 71, source: "native-fixture" }, quotaPools: [{ id: "codex", scope: "all", remainingPercent: 71, resetAt: resetSoon, source: "native-fixture" }],
  },
  claude: {
    id: "claude", installed: true, available: true, authenticated: true, headless: true, authMode: "subscription", subscriptionType: "pro", command: "C:/fixture/claude.exe", version: "fixture",
    surfaces: { headless: true, source: true, "local-files": true, git: true, tests: true, browser: false, github: false, api: false, "project-tools": false },
    permissions: { command: true, database: true, "service-control": true, browser: false, "external-write": false },
    capabilities: { code: 90, architecture: 95, browser: 10 },
    models: [enrichModel({ id: "fable", displayName: "Claude Fable 5" }), enrichModel({ id: "sonnet", displayName: "Claude Sonnet" })],
    capacity: { source: "claude-slash-usage", windows: [{ id: "all", scope: "all", remainingPercent: 95, resetAt: resetSoon }, { id: "fable", scope: "fable", remainingPercent: 91, resetAt: resetSoon }] },
    quotaPools: [{ id: "all", scope: "all", remainingPercent: 95, resetAt: resetSoon, source: "fixture" }, { id: "fable", scope: "fable", remainingPercent: 91, resetAt: resetSoon, source: "fixture" }],
  },
  antigravity: {
    id: "antigravity", installed: true, available: true, authenticated: true, headless: true, authMode: "cli-session", command: "C:/fixture/agy.exe", version: "fixture",
    surfaces: { headless: true, source: true, "local-files": true, git: true, tests: true, browser: true, github: false, api: false, "project-tools": false },
    permissions: { command: true, database: true, "service-control": true, browser: true, "external-write": true },
    capabilities: { browser: 96, research: 94, code: 52 }, models: [enrichModel({ id: "gemini-future-flash", displayName: "Gemini Future Flash" }), enrichModel({ id: "gemini-3.5-flash-high", displayName: "Gemini 3.5 Flash High" })],
    capacity: { remainingPercent: 80, source: "fixture" }, quotaPools: [{ id: "gemini-future-flash", scope: "gemini-future-flash", remainingPercent: 80, resetAt: resetSoon, source: "fixture" }],
  },
  cursor: { id: "cursor", installed: false, available: false, authenticated: false, headless: true, models: [], quotaPools: [], surfaces: {}, reason: "not installed" },
};
const resources = { generatedAt: new Date().toISOString(), machine: { freeRamMb: 8000, logicalCpuCount: 8 }, providers };
const historyTaskId = "task-provider-history-fixture";
const historyTaskRoot = path.join(process.env.AI_MOBILE_DATA_ROOT, "tasks", historyTaskId);
const historyJobsRoot = path.join(historyTaskRoot, "jobs");
fs.mkdirSync(historyJobsRoot, { recursive: true });
fs.writeFileSync(path.join(historyTaskRoot, "task.json"), JSON.stringify({
  taskId: historyTaskId,
  program: {
    resultRecoveries: [{ state: "adopted", jobId: "job-history-adopted" }],
    runtimeRecoveries: [{ state: "retry-admitted", jobId: "job-history-repaired" }],
  },
}), "utf8");
for (const [jobId, state, at] of [
  ["job-history-completed", "completed", "2026-07-23T00:00:00.000Z"],
  ["job-history-adopted", "failed", "2026-07-23T00:01:00.000Z"],
  ["job-history-repaired", "failed", "2026-07-23T00:02:00.000Z"],
]) {
  const dir = path.join(historyJobsRoot, jobId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "contract.json"), JSON.stringify({ provider: "antigravity" }), "utf8");
  fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify({ state, finishedAt: at, blocker: state === "failed" ? "authorization-required: fixture" : "" }), "utf8");
}
const recoveredHistory = providerHistory();
assert.equal(recoveredHistory.antigravity.lastState, "completed");
assert.equal(recoveredHistory.antigravity.cooledDown, false, "Adopted or runtime-repaired terminal failures must not poison provider cooldown.");
const codexCacheRoot = path.join(root, "codex-cache");
fs.mkdirSync(codexCacheRoot, { recursive: true });
fs.writeFileSync(path.join(codexCacheRoot, "models_cache.json"), JSON.stringify({ client_version: "0.145.0", models: [] }), "utf8");
const incompatibleCodexCache = codexCacheCompatibility("codex-cli 0.144.1", { codexHome: codexCacheRoot });
assert.equal(incompatibleCodexCache.compatible, false);
assert.match(incompatibleCodexCache.reason, /older than local model cache/i);
assert.equal(codexNativeCompatibility(incompatibleCodexCache, { models: { data: [] } }).compatible, false);
const nativeVerifiedCodexCache = codexNativeCompatibility(incompatibleCodexCache, {
  models: { data: [{ id: "gpt-5.6-sol", supportedReasoningEfforts: [{ reasoningEffort: "ultra" }] }] },
});
assert.equal(nativeVerifiedCodexCache.compatible, true);
assert.equal(nativeVerifiedCodexCache.nativeProbeVerified, true);
assert.equal(nativeVerifiedCodexCache.reasonCode, "native-probe-verified");
assert.equal(codexCacheCompatibility("codex-cli 0.145.0", { codexHome: codexCacheRoot }).compatible, true);
const fullAntigravityModels = antigravityLimitModels({ Models: [
  { Id: "claude-opus-4-6-thinking", DisplayName: "Claude Opus 4.6 (Thinking)", Disabled: false, Quota: { Status: "available", RemainingPercent: 100, ResetTimeUtc: resetSoon } },
  { Id: "gemini-3.1-pro-high", DisplayName: "Gemini 3.1 Pro (High)", Disabled: false, Quota: { Status: "available", RemainingPercent: 80, ResetTimeUtc: resetSoon } },
  { Id: "hidden-internal", DisplayName: null, Disabled: false, Quota: { Status: "available", RemainingPercent: 100 } },
] });
assert.deepEqual(fullAntigravityModels.map((row) => row.id), ["claude-opus-4-6-thinking", "gemini-3.1-pro-high"]);
assert.equal(inferModelTier({ id: "gemini-3.1-pro-high", displayName: "Gemini 3.1 Pro (High)" }), "frontier");
assert.equal(antigravityCliModelArgument("gemini-3.1-pro-high"), "Gemini 3.1 Pro (High)", "The CLI requires the Pro display label even though its roster advertises the canonical ID.");
assert.equal(antigravityCliModelArgument("claude-opus-4-6-thinking"), "claude-opus-4-6-thinking");
const translatedProArgs = buildAntigravityArgs({ workspace, projectId: "fixture-project", timeoutSeconds: 30, readOnly: true, model: "gemini-3.1-pro-high" }, "inspect");
assert.equal(translatedProArgs[translatedProArgs.indexOf("--model") + 1], "Gemini 3.1 Pro (High)");
const callableAntigravity = callableAntigravityModels([
  { id: "gemini-3.1-pro-high", displayName: "gemini-3.1-pro-high" },
  { id: "claude-opus-4-6-thinking", displayName: "claude-opus-4-6-thinking" },
], [
  ...fullAntigravityModels,
  { id: "gemini-2.5-pro", displayName: "Gemini 2.5 Pro", remainingPercent: 100, status: "available" },
]);
assert.deepEqual(callableAntigravity.map((row) => row.id), ["gemini-3.1-pro-high", "claude-opus-4-6-thinking"], "Helper-only internal aliases must never become callable routing candidates.");
assert.equal(callableAntigravity[0].quota.remainingPercent, 80, "Quota metadata must still join onto an exact native CLI model.");

(async () => {
  try {
    writeProfile({ useExpiringPremiumCapacity: true, subscriptionOnlyClaude: true, codexReservePercent: 15, antigravityReadOnlyConsent: false });
    const diagnostics = await providerDiagnostics({ refresh: true }, { inventory: async () => resources });
    const encoded = JSON.stringify(diagnostics);
    assert.equal(encoded.includes(diagnosticKeyValue), false);
    assert.equal(diagnostics.providers.claude.environment.find((row) => row.name === diagnosticKeyName).present, true);
    assert.equal(diagnostics.providers.claude.billingMode, "subscription-or-cli-session");
    assert.equal(diagnostics.providers.codex.models[0].capabilityTier, "frontier");
    assert.equal(diagnostics.providers.antigravity.surfaces.browser, true);
    assert.equal(diagnostics.passiveDiscovery, true);

    assert.equal(classifyFailure('jetski: a tool required the "command" permission; headless mode cannot prompt, so it was auto-denied.', 0), "authorization-required");
    assert.equal(classifyFailure("partial worker commentary", null, true), "provider-timeout");
    const structuredOutputExhaustion = JSON.stringify({
      subtype: "error_max_structured_output_retries",
      message: "Failed to provide valid structured output after 5 attempts",
      permission_denials: [],
    });
    assert.equal(classifyFailure(structuredOutputExhaustion, 1), "provider-output-invalid");
    assert.equal(classifyProgramFailure(`provider-output-invalid: ${structuredOutputExhaustion}`), "director-contract");
    const structuredOutputTelemetry = JSON.stringify({
      type: "result",
      subtype: "error_max_structured_output_retries",
      duration_ms: 109350,
      duration_api_ms: 76858,
      is_error: true,
      num_turns: 22,
      total_cost_usd: 1.06665375,
      usage: {
        input_tokens: 1609,
        cache_creation_input_tokens: 74746,
        cache_read_input_tokens: 405644,
        output_tokens: 4378,
      },
      modelUsage: {
        "claude-opus-4-8": { inputTokens: 1609, outputTokens: 4378, cacheReadInputTokens: 405644 },
      },
      permission_denials: [],
      errors: ["Failed to provide valid structured output after 5 attempts"],
    });
    assert.equal(classifyProgramFailure(`provider-output-invalid: ${structuredOutputTelemetry}`), "director-contract", "Incidental 537/500/564 digit sequences in real provider telemetry must not become a transient 5xx failure.");
    assert.equal(classifyProgramFailure(`authorization-required: ${structuredOutputTelemetry}`), "director-contract", "The typed structured-output subtype must outrank a stale outer authorization label.");
    assert.equal(classifyProgramFailure(JSON.stringify({ duration_ms: 109350, cache_read_input_tokens: 405644, cost_microusd: 537500 })), "project-semantic", "Bare numeric telemetry must not imply an HTTP 5xx response.");
    assert.equal(classifyProgramFailure("HTTP 503 Service Unavailable"), "transient-provider");
    assert.equal(classifyProgramFailure("server responded with 500"), "transient-provider");
    const familyNamedTransport = {
      workspace,
      goal: "Use the budgeted transport and model pair.",
      readOnly: true,
      relevantFiles: ["source.txt"],
      expectedFiles: [],
      preferredProvider: "antigravity",
      model: "claude-opus-4-6-thinking",
      selectionAuthority: "router",
      complexity: "large",
      taskKind: "repository-scan",
    };
    const genericFamilyBinding = normalizeRequest(familyNamedTransport);
    assert.equal(genericFamilyBinding.preferredProvider, "claude", "Generic routing must retain canonical model-family binding.");
    assert.equal(genericFamilyBinding.directorBudgetAuthority, false);
    const forgedDirectorBinding = normalizeRequest({
      ...familyNamedTransport,
      directorBudgetAuthority: true,
    });
    assert.equal(forgedDirectorBinding.preferredProvider, "claude", "An unproven Director marker must not bypass canonical binding.");
    assert.equal(forgedDirectorBinding.directorBudgetAuthority, false);
    const userFamilyBinding = normalizeRequest({
      ...familyNamedTransport,
      selectionAuthority: "user",
    });
    assert.equal(userFamilyBinding.preferredProvider, "claude", "User-mandated models must retain canonical provider binding.");
    assert.equal(userFamilyBinding.directorBudgetAuthority, false);
    const verifiedDirectorBinding = normalizeRequest({
      ...familyNamedTransport,
      directorBudgetAuthority: true,
      workPackageId: "context-recovery-1",
      workGraphNodeId: "context-recovery-1",
      directorProgram: {
        programId: "program-fixture",
        workPackageId: "context-recovery-1",
        phase: "context",
        revisionFence: null,
      },
      allocation: {
        allocationId: "budget-fixture:context-recovery-1:antigravity",
        candidateId: "context-recovery-1:antigravity:claude-opus-4-6-thinking",
        workPackageId: "context-recovery-1",
        provider: "antigravity",
        model: "claude-opus-4-6-thinking",
      },
    });
    assert.equal(verifiedDirectorBinding.preferredProvider, "antigravity", "A structurally verified Director budget allocation must preserve its transport provider.");
    assert.equal(verifiedDirectorBinding.model, "claude-opus-4-6-thinking");
    assert.equal(verifiedDirectorBinding.directorBudgetAuthority, true);
    const authorizedReadOnlyCommandArgs = buildAntigravityArgs({
      workspace,
      projectId: "fixture-project",
      timeoutSeconds: 30,
      readOnly: true,
      permissionPreflight: { ok: true },
      permissionGrant: ["read-project", "read-files", "run-command"],
    }, "inspect fixture");
    assert(authorizedReadOnlyCommandArgs.includes("--sandbox"));
    assert(authorizedReadOnlyCommandArgs.includes("plan"));
    assert.equal(authorizedReadOnlyCommandArgs.includes("--dangerously-skip-permissions"), false);
    const ungrantedReadOnlyArgs = buildAntigravityArgs({
      workspace,
      projectId: "fixture-project",
      timeoutSeconds: 30,
      readOnly: true,
      permissionPreflight: { ok: true },
      permissionGrant: ["read-project", "read-files"],
    }, "inspect fixture");
    assert.equal(ungrantedReadOnlyArgs.includes("--dangerously-skip-permissions"), false);
    const failedPreflightArgs = buildAntigravityArgs({
      workspace,
      projectId: "fixture-project",
      timeoutSeconds: 30,
      readOnly: true,
      permissionPreflight: { ok: false },
      permissionGrant: ["run-command"],
    }, "inspect fixture");
    assert.equal(failedPreflightArgs.includes("--dangerously-skip-permissions"), false);
    const antigravityPermission = runProvider({ antigravity: { available: true, command: antigravityPermissionFixture } }, { provider: "antigravity", workspace, timeoutSeconds: 30, readOnly: true, model: "fixture" }, "inspect fixture");
    assert.equal(antigravityPermission.ok, false);
    assert.equal(antigravityPermission.typedBlocker, "authorization-required");
    const base = {
      workspace,
      projectGoal: "Complete the capability-routed fixture",
      currentCodexGoal: "Lightweight console",
      currentCodexFiles: [],
      workPlaneRequired: true,
      goal: "Inspect a browser flow without editing files",
      independenceReason: "A bounded worker owns this explicit capability lane.",
      relevantFiles: ["source.txt"],
      readOnly: true,
      complexity: "medium",
      taskKind: "browser",
      estimatedDirectTokens: 6000,
      maxWorkerOutputTokens: 500,
      requiredCapabilities: ["browser"],
    };
    const deniedBrowser = route({ ...base, allowAntigravity: false }, resources, {});
    assert.equal(deniedBrowser.action, "direct");
    assert.match(deniedBrowser.reason, /antigravity.*not authorized/i);
    const browser = route({ ...base, allowAntigravity: true }, resources, {});
    assert.equal(browser.action, "delegate");
    assert.equal(browser.provider, "antigravity");

    const flashAlias = route({
      ...base,
      allowAntigravity: true,
      preferredProvider: "auto",
      selectionAuthority: "user",
      model: "Flash 3.5 High",
    }, resources, {});
    assert.equal(flashAlias.action, "delegate", JSON.stringify(flashAlias));
    assert.equal(flashAlias.provider, "antigravity");
    assert.equal(flashAlias.request.model, "Gemini 3.5 Flash High");

    const unavailableAntigravityModel = route({
      ...base,
      allowAntigravity: true,
      preferredProvider: "antigravity",
      selectionAuthority: "user",
      model: "gemini-missing-flash",
    }, resources, {});
    assert.equal(unavailableAntigravityModel.action, "direct");
    assert.match(unavailableAntigravityModel.reason, /not currently available in the live antigravity roster/i);

    const github = route({ ...base, taskKind: "research", goal: "Inspect a GitHub pull request", requiredCapabilities: ["github"], allowAntigravity: true }, resources, {});
    assert.equal(github.action, "direct");
    assert.match(github.reason, /missing callable capabilities: github/i);

    const operationalContext = route({
      ...base,
      goal: "Read the authorized project database and service state for the context dossier",
      taskKind: "repository-scan",
      requiredCapabilities: ["source", "local-files", "database", "command", "service-control"],
      allowAntigravity: true,
      preferredProvider: "antigravity",
    }, resources, {});
    assert.equal(operationalContext.action, "direct");
    assert.match(operationalContext.reason, /granular headless permission surface/i);
    const operationalContextFallback = route({
      ...base,
      goal: "Read the authorized project database and service state for the context dossier",
      taskKind: "repository-scan",
      requiredCapabilities: ["source", "local-files", "database", "command", "service-control"],
      allowAntigravity: true,
      preferredProvider: "auto",
    }, resources, {});
    assert.equal(operationalContextFallback.action, "delegate", JSON.stringify(operationalContextFallback));
    assert.notEqual(operationalContextFallback.provider, "antigravity");
    const deniedOperationalResources = JSON.parse(JSON.stringify(resources));
    deniedOperationalResources.providers.antigravity.permissions.command = false;
    const deniedOperationalContext = route({
      ...base,
      goal: "Read the authorized project database and service state for the context dossier",
      taskKind: "repository-scan",
      requiredCapabilities: ["source", "local-files", "database", "command", "service-control"],
      allowAntigravity: true,
      preferredProvider: "antigravity",
    }, deniedOperationalResources, {});
    assert.equal(deniedOperationalContext.action, "direct");
    assert.match(deniedOperationalContext.reason, /missing callable capabilities: command/i);

    const premium = route({
      ...base,
      goal: "Design the highest-risk architecture correction",
      taskKind: "architecture",
      complexity: "large",
      requiredCapabilities: ["source", "local-files"],
      allowAntigravity: false,
      preferredProvider: "claude",
    }, resources, {});
    assert.equal(premium.action, "delegate", JSON.stringify(premium));
    assert.equal(premium.provider, "claude");
    assert.equal(premium.request.model, "fable", "dedicated premium capacity resetting inside the planning horizon should be used for a matching hard task");

    const explicitFable = route({
      ...base,
      goal: "Use Fable 5 for the highest-risk architecture correction",
      taskKind: "architecture",
      complexity: "large",
      requiredCapabilities: ["source", "local-files"],
      preferredProvider: "claude",
      selectionAuthority: "user",
      model: "Fable 5",
    }, resources, {});
    assert.equal(explicitFable.action, "delegate", JSON.stringify(explicitFable));
    assert.equal(explicitFable.request.model, "fable", "a live Claude family alias may satisfy an explicitly named current model");

    const unavailableClaudeModel = route({
      ...base,
      goal: "Use a nonexistent future Claude model",
      taskKind: "architecture",
      complexity: "large",
      requiredCapabilities: ["source", "local-files"],
      preferredProvider: "claude",
      selectionAuthority: "user",
      model: "Claude Opus 99",
      allowPremiumModel: true,
    }, resources, {});
    assert.equal(unavailableClaudeModel.action, "direct");
    assert.match(unavailableClaudeModel.reason, /not currently available in the live claude roster/i);

    const reserveResources = JSON.parse(JSON.stringify(resources));
    reserveResources.providers.codex.capacity.effectiveRemainingPercent = 15;
    const codexReserve = route({
      ...base,
      goal: "Implement a bounded source change",
      taskKind: "code",
      readOnly: false,
      relevantFiles: ["source.txt"],
      expectedFiles: ["source.txt"],
      verificationCommands: [{ name: "check", command: "node", args: ["check.js"] }],
      requiredCapabilities: ["source", "local-files", "tests"],
      preferredProvider: "codex",
    }, reserveResources, {});
    assert.equal(codexReserve.action, "direct");
    assert.match(codexReserve.reason, /reserve \(15%\) is protected/i);

    const cooledPreferredCodex = route({
      ...base,
      goal: "Implement a bounded source change after a provider adapter failure",
      taskKind: "code",
      readOnly: false,
      relevantFiles: ["source.txt"],
      expectedFiles: ["source.txt"],
      verificationCommands: [{ name: "check", command: "node", args: ["check.js"] }],
      requiredCapabilities: ["source", "local-files", "tests"],
      preferredProvider: "codex",
    }, resources, { codex: { cooledDown: true, cooldownReason: "provider-adapter-failure" } });
    assert.equal(cooledPreferredCodex.action, "direct");
    assert.match(cooledPreferredCodex.reason, /provider cooldown: provider-adapter-failure/i);

    const unavailableCodexModel = route({
      ...base,
      goal: "Use a nonexistent Codex model",
      taskKind: "code",
      readOnly: false,
      relevantFiles: ["source.txt"],
      expectedFiles: ["source.txt"],
      verificationCommands: [{ name: "check", command: "node", args: ["check.js"] }],
      requiredCapabilities: ["source", "local-files", "tests"],
      preferredProvider: "codex",
      selectionAuthority: "user",
      model: "gpt-nonexistent-frontier",
    }, resources, {});
    assert.equal(unavailableCodexModel.action, "direct");
    assert.match(unavailableCodexModel.reason, /not currently available in the live codex roster/i);

    assert.throws(() => route({
      ...base,
      goal: "Create a structured work plan from the whole repository",
      taskKind: "review",
      artifactKind: "work-plan",
      relevantFiles: ["."],
    }, resources, {}), /bounded, non-root relevantFiles/i);

    const liveState = route({
      ...base,
      goal: "Inspect current runtime state",
      taskKind: "live-state",
      requiredCapabilities: ["source", "local-files"],
      allowAntigravity: false,
    }, resources, {});
    assert.equal(liveState.action, "delegate", JSON.stringify(liveState));
    assert.equal(liveState.provider, "codex");
    assert.equal(liveState.considered.find((row) => row.provider === "codex").scoreFactors.sharedPool, -2);

    const unauthenticated = JSON.parse(JSON.stringify(resources));
    unauthenticated.providers.antigravity.available = false;
    unauthenticated.providers.antigravity.authenticated = false;
    unauthenticated.providers.antigravity.reason = "Antigravity CLI is installed but its headless session is not authenticated.";
    const agDenied = route({ ...base, allowAntigravity: true, preferredProvider: "antigravity" }, unauthenticated, {});
    assert.equal(agDenied.action, "direct");
    assert.match(agDenied.reason, /not authenticated/i);

    process.stdout.write(JSON.stringify({
      ok: true,
      dynamicModelTiers: true,
      quotaResetHorizon: true,
      codexReserveProtected: true,
      capabilityRouting: true,
      explicitUnavailableModelsRejected: true,
      antigravityFlashAliasBound: true,
      boundedWorkPlanInputs: true,
      codexCapacityUsedAboveReserve: true,
      cliAuthenticationSeparatedFromInstallation: true,
      recoveredFailuresDoNotPoisonCooldown: true,
      secretsReturned: false,
      desktopUiLaunched: false,
    }, null, 2) + "\n");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
