#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { route } = require("./core/router");

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ai-mobile-economics-"));
const resources = { providers: {
  codex: { available: true, authenticated: true, authMode: "chatgpt", models: [{ id: "gpt-5.6-sol" }], capacity: { effectiveRemainingPercent: 80 } },
  claude: { available: true, authenticated: true, authMode: "subscription", models: [] },
  antigravity: { available: true, authenticated: true, authMode: "cli-session", models: [{ id: "gemini-3.5-flash-medium", displayName: "Gemini 3.5 Flash (Medium)" }] },
  cursor: { available: false, authenticated: false },
} };

function request(patch = {}) {
  return {
    workspace,
    projectGoal: "Deliver a verified product improvement.",
    currentCodexGoal: "Implement backend runtime recovery.",
    independenceReason: "The worker owns a disjoint surface and returns one bounded artifact.",
    currentCodexFiles: ["backend"],
    goal: "Review frontend accessibility and return exact findings.",
    relevantFiles: ["frontend"],
    readOnly: true,
    complexity: "large",
    taskKind: "review",
    estimatedDirectTokens: 12000,
    ...patch,
  };
}

try {
  const fableResources = JSON.parse(JSON.stringify(resources));
  fableResources.providers.claude.models = [{ id: "fable" }, { id: "sonnet" }];
  const scenarios = {
    smallDirect: route(request({ complexity: "small" }), resources),
    duplicateRejected: route(request({ currentCodexGoal: "Trace the exact cadence blocker and propose the smallest safe fix.", goal: "Identify the exact cadence blocker and implement the smallest safe fix.", currentCodexFiles: [], relevantFiles: [], taskKind: "debug" }), resources),
    disjointArchitecture: route(request({ taskKind: "architecture", preferredProvider: "auto" }), resources),
    cheapRepositoryScan: route(request({ taskKind: "repository-scan", allowAntigravity: true, preferredProvider: "auto" }), resources),
    cooledAntigravity: route(request({ taskKind: "repository-scan", allowAntigravity: true, preferredProvider: "auto" }), resources, { antigravity: { cooledDown: true, consecutiveFailures: 2 }, claude: { successRate: 1 } }),
    userMandatedFableSmall: route(request({ preferredProvider: "antigravity", model: "fable", selectionAuthority: "user", complexity: "small", estimatedDirectTokens: 900, allowAntigravity: true }), fableResources),
    routerFableUneconomic: route(request({ preferredProvider: "claude", model: "sonnet", complexity: "small" }), fableResources),
  };
  assert.equal(scenarios.smallDirect.action, "direct");
  assert.equal(scenarios.duplicateRejected.action, "direct");
  assert.equal(scenarios.disjointArchitecture.provider, "claude");
  assert.equal(scenarios.cheapRepositoryScan.provider, "antigravity");
  assert.equal(scenarios.cooledAntigravity.provider, "claude");
  assert.ok(scenarios.disjointArchitecture.economics.delegatedTokens < scenarios.disjointArchitecture.economics.directTokens);
  assert.ok(scenarios.disjointArchitecture.request.maxWorkerOutputTokens <= 2000);
  assert.equal(scenarios.userMandatedFableSmall.action, "delegate", "an explicit user Fable mandate must dispatch despite negative economics");
  assert.equal(scenarios.userMandatedFableSmall.provider, "claude", "a Fable mandate must be corrected to Claude, never Antigravity");
  assert.equal(scenarios.userMandatedFableSmall.request.model, "fable");
  assert.ok(scenarios.userMandatedFableSmall.warnings.some((item) => /Economic warning/i.test(item)), "waived economics must surface as a warning");
  assert.equal(scenarios.routerFableUneconomic.action, "direct", "router-preference small lanes keep the token-saving direct default");
  const report = Object.fromEntries(Object.entries(scenarios).map(([name, value]) => [name, {
    action: value.action,
    provider: value.provider || "current-codex",
    reason: value.reason,
    warnings: value.warnings || [],
    economics: value.economics || value.request?.economics || null,
  }]));
  process.stdout.write(`${JSON.stringify({ ok: true, simulated: true, modelCalls: 0, scenarios: report }, null, 2)}\n`);
} finally {
  fs.rmSync(workspace, { recursive: true, force: true });
}
