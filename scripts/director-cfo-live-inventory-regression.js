#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-mobile-live-inventory-"));
process.env.AI_MOBILE_DATA_ROOT = path.join(root, "state");

const { inventory } = require("./core/capacity");
const {
  capacityRequirementSatisfied,
  capacityWaitDescriptor,
  isRecoverableCapacityReason,
  isRecoverableCapacityWait,
} = require("./core/capacity-wait");
const { waitForCapacityRecovery } = require("./core/coordinator");
const { normalizeReservePolicy } = require("./core/budget-contracts");
const { forecastPlanDemand } = require("./core/demand-forecast");
const { selectConcurrentBundle } = require("./core/budget-planner");
const { buildResourceLedger } = require("./core/resource-ledger");

(async () => {
  try {
    assert.equal(isRecoverableCapacityReason("minimum-free-ram-floor-would-be-crossed:live=1800;active=0;requested=512;floor=1536"), true);
    const resources = await inventory({
      refresh: true,
      providerIds: ["codex"],
      probe: async () => ({
        id: "codex",
        available: true,
        authenticated: true,
        headless: true,
        models: [
          { id: "gpt-5.6-luna", displayName: "GPT-5.6-Luna", capabilityTier: "efficient" },
          { id: "gpt-5.3-codex-spark", displayName: "GPT-5.3-Codex-Spark", capabilityTier: "efficient" },
        ],
        surfaces: { headless: true, source: true, "local-files": true },
        permissions: { command: true, database: true, "service-control": true },
        capacity: {
          source: "captured-codex-app-server-shape",
          windows: [
            { limitId: "codex_bengalfox", limitName: "GPT-5.3-Codex-Spark", name: "primary", remainingPercent: 99, modelIds: ["gpt-5.3-codex-spark"] },
            { limitId: "codex", limitName: null, name: "primary", remainingPercent: 14, modelIds: ["gpt-5.6-luna"] },
          ],
        },
      }),
    });
    assert.ok(Number.isFinite(Number(resources.worktreeStorage.freeMb)), "The raw internal inventory must include free disk.");
    assert.deepEqual(resources.providers.codex.quotaPools.find((row) => row.id === "codex_bengalfox").modelIds, ["gpt-5.3-codex-spark"]);
    assert.deepEqual(resources.providers.codex.quotaPools.find((row) => row.id === "codex").modelIds, ["gpt-5.6-luna"]);

    const ledger = buildResourceLedger(resources, {
      reservePolicy: normalizeReservePolicy({ codexReservePercent: 15 }),
      profile: { maxGlobalWorkers: 2, maxWorkersPerProvider: 1, minimumFreeRamMb: 256, worktreeMinFreeMb: 100, worktreeDiskQuotaMb: 1000, codexReservePercent: 15 },
    });
    const workPackage = {
      workPackageId: "context-live-shape",
      projectId: "project-live",
      category: "context",
      goal: "Recover the authoritative context",
      dependsOn: [],
      requiredCapabilities: ["source", "local-files"],
      requiredPermissions: ["read-project", "read-files"],
      ownershipKeys: [],
      expectedAcceptanceGain: 4,
      successProbability: 0.9,
      criticalPath: true,
      resourceEstimate: {
        tokens: 12000,
        wallTimeSeconds: 900,
        opportunityCostSeconds: 90,
        ramMb: 256,
        diskMb: 16,
        apiUsd: 0,
        quotaDemands: [],
      },
      candidates: [
        { provider: "codex", model: "gpt-5.6-luna", quotaPoolIds: ["codex"], allowUnknownQuota: true, successProbability: 0.9 },
        { provider: "codex", model: "gpt-5.3-codex-spark", quotaPoolIds: ["codex_bengalfox"], allowUnknownQuota: true, successProbability: 0.9 },
      ],
    };
    const forecast = forecastPlanDemand({
      planId: "captured-live-inventory",
      missionId: "mission-live",
      projectId: "project-live",
      contextRevision: 1,
      revision: 1,
      workPackages: [workPackage],
    });
    const budget = selectConcurrentBundle({
      forecast,
      ledger,
      items: forecast.items,
      authorizedPermissions: ["source", "local-files", "read-project", "read-files"],
      budgetId: "budget-live-shape",
    });
    assert.equal(budget.allocations.length, 1, JSON.stringify(budget.deferred));
    assert.equal(budget.allocations[0].model, "gpt-5.3-codex-spark");
    assert.deepEqual(budget.allocations[0].quotaReservations.map((row) => row.poolId), ["codex_bengalfox"]);
    assert.ok(budget.allocations[0].quotaReservations[0].exclusive, "Unknown percent demand must remain one exclusive bounded lease.");

    const capacityBlocked = {
      workers: [],
      rejected: [{ goal: "context-1-1", reason: "minimum-free-ram-floor-would-be-crossed" }],
    };
    assert.equal(isRecoverableCapacityWait(capacityBlocked), true);
    const lowResources = { ...resources, machine: { ...resources.machine, freeRamMb: 1160, totalRamMb: 11924 } };
    const capacityTask = {
      program: {
        runtime: {
          ledger: {
            limits: {
              minimumFreeRamMb: { state: "known", unit: "megabytes", value: 1024 },
              minimumFreeDiskMb: { state: "known", unit: "megabytes", value: 2048 },
            },
          },
          forecast: {
            items: [{
              workPackageId: "context-1-1",
              cost: {
                ramMb: { state: "known", unit: "megabytes", value: 512 },
                diskMb: { state: "known", unit: "megabytes", value: 16 },
              },
            }],
          },
        },
      },
    };
    const waitDescriptor = capacityWaitDescriptor(capacityTask, capacityBlocked, lowResources, {
      capacityBackoffSeconds: 1,
      capacityMaxBackoffSeconds: 1,
      capacityWaitChecks: 2,
    });
    assert.equal(waitDescriptor.requiredFreeRamMb, 1536);
    assert.equal(capacityRequirementSatisfied(waitDescriptor, { ...lowResources, machine: { ...lowResources.machine, freeRamMb: 1535 } }), false);
    assert.equal(capacityRequirementSatisfied(waitDescriptor, { ...lowResources, machine: { ...lowResources.machine, freeRamMb: 1536 } }), true);

    let changedInventoryCalls = 0;
    const changedRecovery = await waitForCapacityRecovery(
      { taskId: "fixture-task", executionId: "execution-capacity-change" },
      waitDescriptor,
      Date.now() + 1000,
      async () => {
        changedInventoryCalls += 1;
        return {
          ...lowResources,
          machine: { ...lowResources.machine, freeRamMb: changedInventoryCalls === 1 ? 1535 : 1536 },
        };
      },
      { horizonHours: 5, capacityBackoffSeconds: 1, capacityMaxBackoffSeconds: 1, capacityWaitChecks: 2 },
      {
        capacitySleep: async () => {},
        readCoordinator: () => ({ executionId: "execution-capacity-change", state: "running" }),
      },
    );
    assert.equal(changedRecovery.recovered, true);
    assert.equal(changedInventoryCalls, 2);

    let unchangedInventoryCalls = 0;
    const unchangedRecovery = await waitForCapacityRecovery(
      { taskId: "fixture-task", executionId: "execution-capacity-unchanged" },
      waitDescriptor,
      Date.now() + 1000,
      async () => {
        unchangedInventoryCalls += 1;
        return { ...lowResources, machine: { ...lowResources.machine, freeRamMb: 1535 } };
      },
      { horizonHours: 5, capacityBackoffSeconds: 1, capacityMaxBackoffSeconds: 1, capacityWaitChecks: 2 },
      {
        capacitySleep: async () => {},
        readCoordinator: () => ({ executionId: "execution-capacity-unchanged", state: "running" }),
      },
    );
    assert.equal(unchangedRecovery.recovered, false);
    assert.equal(unchangedRecovery.stopReason, "capacity-wait");
    assert.equal(unchangedInventoryCalls, 2);

    process.stdout.write(JSON.stringify({
      ok: true,
      internalFreeDiskKnown: true,
      sparkPoolRemainingPercent: 99,
      generalPoolRemainingPercent: 14,
      selectedModel: budget.allocations[0].model,
      exclusiveUnknownQuotaLease: true,
      codexReservePercent: 15,
      capacityWaitThresholdMb: waitDescriptor.requiredFreeRamMb,
      changedCapacityRecovers: changedRecovery.recovered,
      unchangedCapacityStopsBoundedly: unchangedRecovery.stopReason,
    }, null, 2) + "\n");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch((error) => {
  process.stderr.write((error.stack || error.message) + "\n");
  process.exitCode = 1;
});
