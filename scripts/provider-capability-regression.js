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
const { route } = require("./core/router");
const { writeProfile } = require("./lib/orchestrator-profile");
const { classifyFailure, enrichModel, runProvider } = require("./providers");

const resetSoon = new Date(Date.now() + 60 * 60 * 1000).toISOString();
const providers = {
  codex: {
    id: "codex", installed: true, available: true, authenticated: true, headless: true, authMode: "chatgpt", command: "C:/fixture/codex.exe", version: "fixture",
    surfaces: { headless: true, source: true, "local-files": true, git: true, tests: true, browser: false, github: false, api: false, "project-tools": false },
    capabilities: { code: 90, architecture: 90, browser: 10 },
    models: [enrichModel({ id: "gpt-future-frontier", displayName: "Future Frontier", description: "Most capable frontier model", supportedReasoningEfforts: ["low", "high"], defaultReasoningEffort: "low" })],
    capacity: { effectiveRemainingPercent: 71, source: "native-fixture" }, quotaPools: [{ id: "codex", scope: "all", remainingPercent: 71, resetAt: resetSoon, source: "native-fixture" }],
  },
  claude: {
    id: "claude", installed: true, available: true, authenticated: true, headless: true, authMode: "subscription", subscriptionType: "pro", command: "C:/fixture/claude.exe", version: "fixture",
    surfaces: { headless: true, source: true, "local-files": true, git: true, tests: true, browser: false, github: false, api: false, "project-tools": false },
    capabilities: { code: 90, architecture: 95, browser: 10 },
    models: [enrichModel({ id: "fable", displayName: "Claude Fable 5" }), enrichModel({ id: "sonnet", displayName: "Claude Sonnet" })],
    capacity: { source: "claude-slash-usage", windows: [{ id: "all", scope: "all", remainingPercent: 95, resetAt: resetSoon }, { id: "fable", scope: "fable", remainingPercent: 91, resetAt: resetSoon }] },
    quotaPools: [{ id: "all", scope: "all", remainingPercent: 95, resetAt: resetSoon, source: "fixture" }, { id: "fable", scope: "fable", remainingPercent: 91, resetAt: resetSoon, source: "fixture" }],
  },
  antigravity: {
    id: "antigravity", installed: true, available: true, authenticated: true, headless: true, authMode: "cli-session", command: "C:/fixture/agy.exe", version: "fixture",
    surfaces: { headless: true, source: true, "local-files": true, git: true, tests: true, browser: true, github: false, api: false, "project-tools": false },
    capabilities: { browser: 96, research: 94, code: 52 }, models: [enrichModel({ id: "gemini-future-flash", displayName: "Gemini Future Flash" }), enrichModel({ id: "gemini-3.5-flash-high", displayName: "Gemini 3.5 Flash High" })],
    capacity: { remainingPercent: 80, source: "fixture" }, quotaPools: [{ id: "gemini-future-flash", scope: "gemini-future-flash", remainingPercent: 80, resetAt: resetSoon, source: "fixture" }],
  },
  cursor: { id: "cursor", installed: false, available: false, authenticated: false, headless: true, models: [], quotaPools: [], surfaces: {}, reason: "not installed" },
};
const resources = { generatedAt: new Date().toISOString(), machine: { freeRamMb: 8000, logicalCpuCount: 8 }, providers };

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
