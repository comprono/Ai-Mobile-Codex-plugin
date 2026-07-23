#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const regressionRoot = fs.mkdtempSync(path.join(os.tmpdir(), "director-cfo-budget-"));
process.env.AI_MOBILE_DATA_ROOT = path.join(regressionRoot, "state");
process.on("exit", () => fs.rmSync(regressionRoot, { recursive: true, force: true }));

const {
  BUDGET_CATEGORIES,
  normalizeCostVector,
  normalizeQuotaPool,
  normalizeReservePolicy,
  notApplicableMeasurement,
} = require("./core/budget-contracts");
const { forecastPlanDemand } = require("./core/demand-forecast");
const { buildResourceLedger } = require("./core/resource-ledger");
const { selectConcurrentBundle } = require("./core/budget-planner");
const { arbitratePortfolio, fairnessAdjustment } = require("./core/portfolio-arbiter");
const { createExecutionAccounting, recordExecutionReceipt } = require("./core/execution-accounting");
const { createRebudgetJournal, evaluateRebudget, recordMaterialRebudgetTrigger } = require("./core/rebudget-controller");
const { estimatedAntigravityQuotaPercent, prepareProgramDispatch, startDirectorProgram } = require("./core/director-cfo-orchestrator");
const { readTask, updateTask } = require("./core/state-store");

const now = Date.parse("2026-07-21T00:00:00.000Z");
const resetAt = new Date(now + 2 * 60 * 60 * 1000).toISOString();
const noApiCost = notApplicableMeasurement("usd", "subscription capacity");
assert.equal(estimatedAntigravityQuotaPercent("frontier"), 10);
assert.equal(estimatedAntigravityQuotaPercent("balanced"), 5);
assert.equal(estimatedAntigravityQuotaPercent("efficient"), 2);

function cost(provider, poolId, values = {}) {
  return {
    tokens: values.tokens ?? 2000,
    wallTimeSeconds: values.wallTimeSeconds ?? 120,
    opportunityCostSeconds: values.opportunityCostSeconds ?? 20,
    ramMb: values.ramMb ?? 512,
    diskMb: values.diskMb ?? 64,
    apiUsd: values.apiUsd ?? noApiCost,
    quotaDemands: values.quotaDemands ?? [{ provider, poolId, percent: values.percent ?? 4 }],
  };
}

function workPackage(id, category, provider, model, overrides = {}) {
  return {
    workPackageId: id,
    projectId: overrides.projectId || "project-a",
    category,
    type: category,
    goal: `Advance ${id}`,
    acceptanceIds: [`ACC-${id}`],
    dependsOn: overrides.dependsOn || [],
    requiredCapabilities: overrides.requiredCapabilities || ["source"],
    requiredPermissions: overrides.requiredPermissions || [],
    ownershipKeys: overrides.ownershipKeys || [`files/${id}`],
    expectedAcceptanceGain: overrides.expectedAcceptanceGain ?? 8,
    successProbability: overrides.successProbability ?? 0.8,
    criticalPath: overrides.criticalPath === true,
    deadlineAt: overrides.deadlineAt || new Date(now + 8 * 60 * 60 * 1000).toISOString(),
    resourceEstimate: cost(provider, overrides.poolId || "all", overrides.cost || {}),
    candidates: [{
      provider,
      model,
      successProbability: overrides.candidateProbability ?? 0.85,
      quotaPoolIds: [overrides.poolId || "all"],
      ...(overrides.candidate || {}),
    }],
  };
}

const providers = {
  codex: {
    available: true,
    authenticated: true,
    headless: true,
    authMode: "chatgpt",
    models: [{ id: "gpt-5.3-codex-spark", displayName: "Codex Spark" }],
    surfaces: { headless: true, source: true, "local-files": true, tests: true, browser: false },
    quotaPools: [{ id: "all", scope: "all", remainingPercent: 70, resetAt, source: "fixture" }],
  },
  claude: {
    available: true,
    authenticated: true,
    headless: true,
    authMode: "subscription",
    models: [{ id: "fable-5", displayName: "Fable 5" }],
    surfaces: { headless: true, source: true, "local-files": true, tests: true, browser: false, command: true },
    quotaPools: [{ id: "all", scope: "all", remainingPercent: 80, resetAt, source: "fixture" }],
  },
  antigravity: {
    available: true,
    authenticated: true,
    headless: true,
    authMode: "cli-session",
    models: [{ id: "gemini-3.5-flash", displayName: "Gemini 3.5 Flash" }],
    surfaces: { headless: true, source: true, "local-files": true, browser: true, tests: false },
    quotaPools: [{ id: "all", scope: "all", remainingPercent: 65, resetAt, source: "fixture" }],
  },
  unknownModelProvider: {
    available: true,
    authenticated: true,
    headless: true,
    surfaces: { headless: true, source: true },
    quotaPools: [{ id: "all", remainingPercent: 50 }],
  },
  emptyModelProvider: {
    available: true,
    authenticated: true,
    headless: true,
    models: [],
    surfaces: { headless: true, source: true },
    quotaPools: [{ id: "all", remainingPercent: 50 }],
  },
};

const reservePolicy = normalizeReservePolicy({
  context: 3,
  strategy: 5,
  verification: 8,
  reconciliation: 8,
  emergency: 5,
  codexReservePercent: 15,
});
const ledger = buildResourceLedger({
  generatedAt: new Date(now).toISOString(),
  machine: { freeRamMb: 6000, totalRamMb: 16000, freeDiskMb: 5000, logicalCpuCount: 8 },
  providers,
}, {
  observedAt: new Date(now).toISOString(),
  reservePolicy,
  profile: { maxGlobalWorkers: 2, maxWorkersPerProvider: 1, minimumFreeRamMb: 1000, worktreeMinFreeMb: 500, worktreeDiskQuotaMb: 1000, codexReservePercent: 15 },
});

assert.equal(ledger.providers.codex.quotaPools[0].remaining.unit, "percent");
assert.equal(Object.hasOwn(ledger.providers.codex.quotaPools[0].remaining, "tokens"), false, "percent-only quota must never acquire a synthetic token value");
assert.equal(ledger.providers.unknownModelProvider.models.state, "unknown");
assert.equal(ledger.providers.emptyModelProvider.models.state, "known");
assert.equal(ledger.providers.emptyModelProvider.models.rows.length, 0);
assert.throws(() => normalizeQuotaPool({ id: "mixed", remainingPercent: 40, remainingTokens: 1000 }, "codex"), /cannot mix percent, token, and request units/i);

const laterObservedProviders = structuredClone(providers);
for (const provider of Object.values(laterObservedProviders)) provider.observedAt = new Date(now + 60000).toISOString();
const laterObservedLedger = buildResourceLedger({
  generatedAt: new Date(now + 60000).toISOString(),
  machine: { freeRamMb: 6000, totalRamMb: 16000, freeDiskMb: 5000, logicalCpuCount: 8 },
  providers: laterObservedProviders,
}, {
  observedAt: new Date(now + 60000).toISOString(),
  reservePolicy,
  profile: { maxGlobalWorkers: 2, maxWorkersPerProvider: 1, minimumFreeRamMb: 1000, worktreeMinFreeMb: 500, worktreeDiskQuotaMb: 1000, codexReservePercent: 15 },
});
assert.equal(laterObservedLedger.fingerprint, ledger.fingerprint, "Observation timestamps alone must not create a new budget authority fingerprint.");

const unknownCapacityProviders = structuredClone(providers);
delete unknownCapacityProviders.antigravity.quotaPools;
const unknownCapacityLedger = buildResourceLedger({
  generatedAt: new Date(now).toISOString(),
  machine: { freeRamMb: 6000, totalRamMb: 16000, freeDiskMb: 5000, logicalCpuCount: 8 },
  providers: { antigravity: unknownCapacityProviders.antigravity },
}, {
  observedAt: new Date(now).toISOString(),
  reservePolicy,
  profile: { maxGlobalWorkers: 1, maxWorkersPerProvider: 1, minimumFreeRamMb: 1000, worktreeMinFreeMb: 500, worktreeDiskQuotaMb: 1000 },
});
const unknownCapacityPackage = workPackage("unknown-capacity-context", "context", "antigravity", "gemini-3.5-flash", {
  poolId: "unknown-shared-pool",
  cost: { percent: 2 },
  candidate: { allowUnknownQuota: true, allowUnknownCapacity: true, maxAttempts: 4 },
});
const unknownCapacityForecast = forecastPlanDemand({
  planId: "unknown-capacity-plan",
  missionId: "project-a",
  projectId: "project-a",
  revision: 1,
  contextRevision: 1,
  workPackages: [unknownCapacityPackage],
});
const unknownCapacityBudget = selectConcurrentBundle({
  forecast: unknownCapacityForecast,
  ledger: unknownCapacityLedger,
  items: unknownCapacityForecast.items,
  authorizedPermissions: { "project-a": ["source"] },
  nowMs: now,
  budgetId: "unknown-capacity-budget",
});
assert.equal(unknownCapacityBudget.allocations.length, 1, `A callable authenticated provider may receive one bounded exclusive read-only attempt when quota capacity is unknown: ${JSON.stringify(unknownCapacityBudget.deferred)}`);
assert.equal(unknownCapacityBudget.allocations[0].maxAttempts, 1);
assert.equal(unknownCapacityBudget.allocations[0].accountingBasis.mode, "bounded-wall-time-exclusive-unknown-quota");
assert.equal(unknownCapacityBudget.allocations[0].quotaReservations[0].unknownCapacity, true);
assert.ok(unknownCapacityBudget.limits.maxDurationMs > 0, "Known pending work duration must survive unknown synthetic phase estimates.");

const liveInventoryShapeLedger = buildResourceLedger({
  generatedAt: new Date(now).toISOString(),
  machine: { freeRamMb: 6000, totalRamMb: 16000, logicalCpuCount: 8 },
  worktreeStorage: { freeMb: 47536, minimumFreeMb: 500, quotaMb: 1000 },
  providers: {},
}, {
  profile: { maxGlobalWorkers: 2, maxWorkersPerProvider: 1, minimumFreeRamMb: 1000, worktreeMinFreeMb: 500, worktreeDiskQuotaMb: 1000 },
});
assert.equal(liveInventoryShapeLedger.machine.freeDiskMb.state, "known");
assert.equal(liveInventoryShapeLedger.machine.freeDiskMb.value, 47536, "the ledger must consume the real resource-inventory worktreeStorage.freeMb field");

const packages = [
  workPackage("context-scout", "context", "antigravity", "gemini-3.5-flash", { expectedAcceptanceGain: 3 }),
  workPackage("strong-plan", "strategy", "claude", "fable-5", { expectedAcceptanceGain: 5 }),
  workPackage("critical-code", "execution", "claude", "fable-5", { expectedAcceptanceGain: 12, criticalPath: true, cost: { percent: 5 } }),
  workPackage("parallel-browser", "execution", "antigravity", "gemini-3.5-flash", { projectId: "project-b", expectedAcceptanceGain: 9, requiredCapabilities: ["browser"], cost: { percent: 5 } }),
  workPackage("verify", "verification", "codex", "gpt-5.3-codex-spark", { expectedAcceptanceGain: 4 }),
  workPackage("integrate", "integration", "codex", "gpt-5.3-codex-spark", { expectedAcceptanceGain: 4 }),
  workPackage("reconcile", "reconciliation", "claude", "fable-5", { expectedAcceptanceGain: 5 }),
  workPackage("permission-blocked", "execution", "claude", "fable-5", { requiredCapabilities: ["browser"], expectedAcceptanceGain: 50 }),
  workPackage("dependency-blocked", "execution", "codex", "gpt-5.3-codex-spark", { dependsOn: ["missing-package"], expectedAcceptanceGain: 50 }),
  workPackage("ram-blocked", "execution", "codex", "gpt-5.3-codex-spark", { expectedAcceptanceGain: 50, cost: { ramMb: 5500 } }),
  workPackage("codex-reserve-blocked", "execution", "codex", "gpt-5.3-codex-spark", { expectedAcceptanceGain: 50, cost: { percent: 30 } }),
];
const masterPlan = {
  planId: "master-plan-1",
  missionId: "project-a",
  revision: 3,
  contextRevision: 2,
  workstreams: [{ workstreamId: "delivery", workPackages: packages }],
};
const forecast = forecastPlanDemand(masterPlan, { generatedAt: new Date(now).toISOString() });
assert.deepEqual(Object.keys(forecast.categories), [...BUDGET_CATEGORIES]);
assert.equal(forecast.categories.context.items[0].workPackageId, "context-scout");
assert.equal(forecast.categories.strategy.demand.tokens.state, "known");
assert.equal(forecast.categories.execution.items.length, 6);
assert.equal(forecast.contextRevision, 2);
assert.equal(forecast.planRevision, 3);

const authorizedPermissions = {
  "project-a": ["source", "local-files", "tests", "command"],
  "project-b": ["source", "local-files", "browser"],
};
const planningItems = forecast.items.filter((row) => [
  "critical-code",
  "parallel-browser",
  "permission-blocked",
  "dependency-blocked",
  "ram-blocked",
  "codex-reserve-blocked",
].includes(row.workPackageId));
const budget = selectConcurrentBundle({
  forecast,
  ledger,
  items: planningItems,
  authorizedPermissions,
  nowMs: now,
  budgetId: "budget-1",
});
assert.deepEqual(new Set(budget.allocations.map((row) => row.workPackageId)), new Set(["critical-code", "parallel-browser"]));
assert.equal(budget.allocations.length, 2, "the CFO should select the best feasible concurrent bundle");

const commandAliasPackage = workPackage("command-alias", "context", "claude", "fable-5", {
  requiredCapabilities: ["command"],
  requiredPermissions: ["run-command"],
  cost: { percent: 1 },
});
const commandAliasForecast = forecastPlanDemand({
  planId: "command-alias-plan",
  missionId: "project-a",
  projectId: "project-a",
  revision: 1,
  contextRevision: 1,
  workPackages: [commandAliasPackage],
});
const commandAliasBudget = selectConcurrentBundle({
  forecast: commandAliasForecast,
  ledger,
  items: commandAliasForecast.items,
  authorizedPermissions: { "project-a": ["run-command"] },
  nowMs: now,
  budgetId: "command-alias-budget",
});
assert.equal(commandAliasBudget.allocations.length, 1, "The command capability must honor exact run-command authorization without requiring a duplicate command permission.");

const testAliasPackage = workPackage("test-alias", "verification", "claude", "fable-5", {
  requiredCapabilities: ["tests"],
  requiredPermissions: ["run-tests"],
  cost: { percent: 1 },
});
const testAliasForecast = forecastPlanDemand({
  planId: "test-alias-plan",
  missionId: "project-a",
  projectId: "project-a",
  revision: 1,
  contextRevision: 1,
  workPackages: [testAliasPackage],
});
const testAliasBudget = selectConcurrentBundle({
  forecast: testAliasForecast,
  ledger,
  items: testAliasForecast.items,
  authorizedPermissions: { "project-a": ["tests"] },
  nowMs: now,
  budgetId: "test-alias-budget",
});
assert.equal(testAliasBudget.allocations.length, 1, "The tests capability must authorize its exact run-tests execution permission.");

function providerPreferencePackage(id, preferred) {
  const row = workPackage(id, "context", "claude", "fable-5", {
    requiredCapabilities: ["source"],
    requiredPermissions: [],
    cost: { percent: 1 },
  });
  row.candidates = [
    {
      provider: "antigravity",
      cost: cost("antigravity", "all", { percent: 1 }),
      model: "gemini-3.5-flash",
      successProbability: 0.3,
      quotaPoolIds: ["all"],
      allowUnknownQuota: true,
      ...(preferred ? { preferenceRank: 0, preferenceReason: "work-package-preferred-provider:antigravity" } : {}),
    },
    {
      provider: "claude",
      cost: cost("claude", "all", { percent: 1 }),
      model: "fable-5",
      successProbability: 0.98,
      quotaPoolIds: ["all"],
      allowUnknownQuota: true,
      ...(preferred ? { preferenceRank: 1, preferenceReason: "work-package-preferred-provider:antigravity" } : {}),
    },
  ];
  return row;
}

function providerPreferenceBudget(row, resourceLedger, budgetId) {
  const preferenceForecast = forecastPlanDemand({
    planId: `${budgetId}-plan`,
    missionId: "project-a",
    projectId: "project-a",
    revision: 1,
    contextRevision: 1,
    workPackages: [row],
  });
  return selectConcurrentBundle({
    forecast: preferenceForecast,
    ledger: resourceLedger,
    items: preferenceForecast.items,
    authorizedPermissions: { "project-a": ["read-project", "read-files"] },
    nowMs: now,
    budgetId,
  });
}

const preferredProviderBudget = providerPreferenceBudget(
  providerPreferencePackage("provider-preferred-feasible", true),
  ledger,
  "provider-preferred-feasible-budget",
);
assert.equal(preferredProviderBudget.allocations[0].provider, "antigravity", "A lower-utility preferred provider must win whenever it passes every budget gate.");
const unknownQuotaPreferredPackage = providerPreferencePackage("provider-preferred-quota-unknown", true);
unknownQuotaPreferredPackage.candidates[0].cost = null;
unknownQuotaPreferredPackage.candidates[0].quotaDemands = [];
const unknownQuotaFallbackBudget = providerPreferenceBudget(
  unknownQuotaPreferredPackage,
  ledger,
  "provider-preferred-quota-unknown-budget",
);
assert.equal(unknownQuotaFallbackBudget.allocations[0].provider, "claude", "A preferred Antigravity candidate with unknown per-job quota demand must be rejected before execution and fall back.");


const unavailablePreferredLedger = structuredClone(ledger);
unavailablePreferredLedger.providers.antigravity.availability = "unavailable";
const preferredProviderFallbackBudget = providerPreferenceBudget(
  providerPreferencePackage("provider-preferred-unavailable", true),
  unavailablePreferredLedger,
  "provider-preferred-unavailable-budget",
);
assert.equal(preferredProviderFallbackBudget.allocations[0].provider, "claude", "The budget must fall back when no preferred-provider candidate is eligible.");

const autoProviderBudget = providerPreferenceBudget(
  providerPreferencePackage("provider-auto", false),
  ledger,
  "provider-auto-budget",
);
assert.equal(autoProviderBudget.allocations[0].provider, "claude", "Ordinary auto routing must continue to choose the highest-utility eligible candidate.");

const ramBoundaryPackage = workPackage("ram-boundary", "context", "claude", "fable-5", {
  requiredCapabilities: ["source"],
  requiredPermissions: [],
  cost: { ramMb: 512, percent: 1 },
});
const ramBoundaryForecast = forecastPlanDemand({
  planId: "ram-boundary-plan",
  missionId: "project-a",
  projectId: "project-a",
  revision: 1,
  contextRevision: 1,
  workPackages: [ramBoundaryPackage],
});
function ramBoundaryLedger(freeRamMb) {
  return buildResourceLedger({
    generatedAt: new Date(now).toISOString(),
    machine: { freeRamMb, totalRamMb: 11924, freeDiskMb: 5000, logicalCpuCount: 8 },
    providers,
  }, {
    observedAt: new Date(now).toISOString(),
    reservePolicy,
    profile: { maxGlobalWorkers: 2, maxWorkersPerProvider: 1, minimumFreeRamMb: 1024, worktreeMinFreeMb: 500, worktreeDiskQuotaMb: 1000, codexReservePercent: 15 },
  });
}
const belowRamBoundary = selectConcurrentBundle({
  forecast: ramBoundaryForecast,
  ledger: ramBoundaryLedger(1535),
  items: ramBoundaryForecast.items,
  authorizedPermissions: { "project-a": ["source", "read-project"] },
  nowMs: now,
  budgetId: "ram-boundary-low",
});
assert.equal(belowRamBoundary.allocations.length, 0);
assert.ok(belowRamBoundary.deferred[0].reasons.includes("minimum-free-ram-floor-would-be-crossed"));
const atRamBoundary = selectConcurrentBundle({
  forecast: ramBoundaryForecast,
  ledger: ramBoundaryLedger(1536),
  items: ramBoundaryForecast.items,
  authorizedPermissions: { "project-a": ["source", "read-project"] },
  nowMs: now,
  budgetId: "ram-boundary-ready",
});
assert.equal(atRamBoundary.allocations.length, 1, "A 512 MB package must become eligible exactly at 1536 MB free with a 1024 MB reserve.");

assert.ok(budget.deferred.find((row) => row.workPackageId === "permission-blocked").reasons.some((reason) => /permission-unavailable:browser/.test(reason)));
assert.ok(budget.deferred.find((row) => row.workPackageId === "dependency-blocked").reasons.some((reason) => /dependencies-not-complete/.test(reason)));
assert.ok(budget.deferred.find((row) => row.workPackageId === "ram-blocked").reasons.some((reason) => /minimum-free-ram-floor/.test(reason)));
assert.ok(budget.deferred.find((row) => row.workPackageId === "codex-reserve-blocked").reasons.some((reason) => /protected-reserve/.test(reason)));
assert.ok(ledger.providers.codex.quotaPools[0].reserves.some((row) => row.category === "codex"));
for (const category of ["context", "strategy", "verification", "reconciliation", "emergency"]) {
  assert.ok(ledger.providers.codex.quotaPools[0].reserves.some((row) => row.category === category), `${category} reserve should be protected`);
}


const historyWorkspace = path.join(regressionRoot, "history-workspace");
fs.mkdirSync(path.join(historyWorkspace, ".codex"), { recursive: true });
fs.writeFileSync(path.join(historyWorkspace, ".codex", "PROJECT_OUTCOME.md"), "# Outcome\nDispatch only the currently eligible package.\n", "utf8");
fs.writeFileSync(path.join(historyWorkspace, ".codex", "ACCEPTANCE.json"), JSON.stringify({ requirements: ["dispatch-current"] }, null, 2) + "\n", "utf8");
const historyResources = {
  generatedAt: new Date(now).toISOString(),
  machine: { freeRamMb: 6000, totalRamMb: 16000, freeDiskMb: 5000, logicalCpuCount: 8 },
  providers,
};
const historyStarted = startDirectorProgram({
  workspace: historyWorkspace,
  outcome: "Prove historical work cannot displace the current dependency-ready package.",
  forceProgram: true,
  acceptanceEvidence: [{
    id: "REQ-CURRENT-DISPATCH",
    description: "The current dependency-ready package receives the dispatch allocation.",
    minimumEvidenceLevel: "integration",
  }],
}, historyResources);
const historySeed = readTask(historyStarted.taskId).program.workPackages[0];
updateTask(historyStarted.taskId, (task) => {
  const packageWithState = (workPackageId, state, expectedAcceptanceGain) => ({
    ...historySeed,
    workPackageId,
    state,
    expectedAcceptanceGain,
    allocation: null,
    permissionPreflight: null,
    dependencies: [],
  });
  task.program = {
    ...task.program,
    phase: "execution",
    workPackages: [
      packageWithState("current-ready-package", "pending", 1),
      {
        ...packageWithState("future-dependent-package", "pending", 50),
        dependencies: ["current-ready-package"],
      },
      packageWithState("historical-failed-package", "failed", 100),
      packageWithState("historical-completed-package", "completed", 200),
    ],
  };
  return task;
});
const historyPrepared = prepareProgramDispatch(readTask(historyStarted.taskId), historyResources, { codex: { cooledDown: true, cooldownReason: "fixture-provider-failure" } });
const currentHistoryPackage = historyPrepared.program.workPackages.find((row) => row.workPackageId === "current-ready-package");
const futureDependentPackage = historyPrepared.program.workPackages.find((row) => row.workPackageId === "future-dependent-package");
const failedHistoryPackage = historyPrepared.program.workPackages.find((row) => row.workPackageId === "historical-failed-package");
const completedHistoryPackage = historyPrepared.program.workPackages.find((row) => row.workPackageId === "historical-completed-package");
assert.equal(currentHistoryPackage.state, "ready", "the current dependency-ready package must be selected even when historical work has higher utility");
assert.ok(currentHistoryPackage.allocation, "the current dependency-ready package must receive an allocation");
assert.notEqual(currentHistoryPackage.allocation.provider, "codex", "a cooled provider must be removed before the CFO persists an allocation");
assert.deepEqual(historyPrepared.program.runtime.budget.allocations.map((row) => row.workPackageId), ["current-ready-package"]);
assert.equal(futureDependentPackage.state, "pending", "future dependent work must remain pending");
assert.ok(
  historyPrepared.program.runtime.budget.deferred.find((row) => (
    row.workPackageId === "future-dependent-package"
    && row.reasons.some((reason) => /dependencies-not-complete/.test(reason))
  )),
  "the plan-wide budget must explicitly defer future dependent work",
);
assert.equal(failedHistoryPackage.state, "failed", "historical failed work must not be selected again");
assert.equal(failedHistoryPackage.allocation, null, "historical failed work must not receive an allocation");
assert.equal(completedHistoryPackage.state, "completed", "historical completed work must remain completed");
assert.equal(completedHistoryPackage.allocation, null, "historical completed work must not receive an allocation");
const projectAForecast = { ...forecast, projectId: "project-a", items: forecast.items.filter((row) => row.workPackageId === "critical-code") };
const projectBForecast = { ...forecast, projectId: "project-b", items: forecast.items.filter((row) => row.workPackageId === "parallel-browser") };
const portfolio = arbitratePortfolio({
  portfolioId: "portfolio-1",
  programs: [
    { projectId: "project-a", forecast: projectAForecast, authorizedPermissions: authorizedPermissions["project-a"], lastServedAt: new Date(now - 60 * 60 * 1000).toISOString() },
    { projectId: "project-b", forecast: projectBForecast, authorizedPermissions: authorizedPermissions["project-b"] },
  ],
  ledger,
  nowMs: now,
});
assert.equal(portfolio.allocations.length, 2);
assert.ok(portfolio.projects.every((row) => row.allocated.length === 1));
assert.ok(fairnessAdjustment({ projectId: "never-served" }, ledger, now).weight > fairnessAdjustment({ projectId: "recent", recentAllocations: 4, lastServedAt: new Date(now).toISOString() }, ledger, now).weight);

const forecastCost = budget.allocations.find((row) => row.workPackageId === "critical-code").cost;
const receiptInput = {
  receiptId: "receipt-1",
  workPackageId: "critical-code",
  allocationId: budget.allocations.find((row) => row.workPackageId === "critical-code").allocationId,
  projectId: "project-a",
  provider: "claude",
  model: "fable-5",
  category: "execution",
  state: "completed",
  finishedAt: "2026-07-21T00:03:00.000Z",
  acceptanceImproved: true,
  acceptanceEvidenceGain: 2,
  evidenceFingerprint: "evidence-2",
  actualCost: cost("claude", "all", { tokens: 2600, wallTimeSeconds: 180, opportunityCostSeconds: 20, ramMb: 600, diskMb: 70, percent: 6 }),
};
const emptyAccounting = createExecutionAccounting({ budgetId: "budget-1", budgetRevision: 1, createdAt: "2026-07-21T00:00:00.000Z" });
const recorded = recordExecutionReceipt(emptyAccounting, receiptInput, forecastCost);
assert.equal(recorded.recorded, true);
assert.equal(recorded.receipt.actualCost.quotaDemands[0].measurement.unit, "percent");
assert.equal(recorded.receipt.variance.metrics.tokens.percent, 30);
const duplicate = recordExecutionReceipt(recorded.accounting, receiptInput, forecastCost);
assert.equal(duplicate.recorded, false);
assert.equal(duplicate.duplicate, true);

const unchanged = evaluateRebudget({ contextRevision: 2, planRevision: 3, ledger }, { contextRevision: 2, planRevision: 3, ledger }, { evaluatedAt: "2026-07-21T00:04:00.000Z" });
assert.equal(unchanged.material, false);
const smallLedgerChange = structuredClone(ledger);
smallLedgerChange.providers.claude.quotaPools[0].remaining.value = 76;
const smallCapacity = evaluateRebudget({ contextRevision: 2, planRevision: 3, ledger }, { contextRevision: 2, planRevision: 3, ledger: smallLedgerChange });
assert.equal(smallCapacity.material, false, "small capacity noise must not rebudget");
const largeLedgerChange = structuredClone(ledger);
largeLedgerChange.providers.claude.quotaPools[0].remaining.value = 60;
const capacityChange = evaluateRebudget({ contextRevision: 2, planRevision: 3, ledger }, { contextRevision: 2, planRevision: 3, ledger: largeLedgerChange });
assert.equal(capacityChange.material, true);
assert.ok(capacityChange.reasons.some((row) => row.code === "quota-capacity-materially-changed"));
const contextChange = evaluateRebudget({ contextRevision: 2, planRevision: 3 }, { contextRevision: 3, planRevision: 3 });
assert.ok(contextChange.reasons.some((row) => row.code === "context-revision-changed"));
const receiptChange = evaluateRebudget(
  { contextRevision: 2, planRevision: 3, accounting: emptyAccounting },
  { contextRevision: 2, planRevision: 3, accounting: recorded.accounting },
);
assert.ok(receiptChange.reasons.some((row) => row.code === "acceptance-evidence-improved"));
const journal = createRebudgetJournal({ budgetId: "budget-1" });
assert.equal(recordMaterialRebudgetTrigger(journal, unchanged).recorded, false);
const journalResult = recordMaterialRebudgetTrigger(journal, capacityChange);
assert.equal(journalResult.recorded, true);
assert.equal(recordMaterialRebudgetTrigger(journalResult.journal, capacityChange).recorded, false);

process.stdout.write(JSON.stringify({
  ok: true,
  planWideCategories: Object.keys(forecast.categories),
  percentQuotaPreserved: true,
  unknownModelDistinctFromEmpty: true,
  protectedReserves: ledger.providers.codex.quotaPools[0].reserves.map((row) => row.category),
  selectedBundle: budget.allocations.map((row) => `${row.projectId}:${row.workPackageId}:${row.provider}`),
  hardConstraintDeferrals: budget.deferred.map((row) => ({ workPackageId: row.workPackageId, reasons: row.reasons })),
  portfolioProjectsFunded: portfolio.projects.filter((row) => row.allocated.length).map((row) => row.projectId),
  actualReceiptRecorded: recorded.receipt.receiptId,
  duplicateReceiptNoOp: duplicate.duplicate,
  materialRebudgetReasons: capacityChange.reasons.map((row) => row.code),
  unchangedRebudgetSuppressed: !unchanged.material,
  ramBoundaryMb: 1536,
  historySafeDispatch: historyPrepared.program.runtime.budget.allocations.map((row) => row.workPackageId),
}, null, 2) + "\n");
