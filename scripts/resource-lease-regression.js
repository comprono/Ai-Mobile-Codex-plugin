#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-mobile-resource-lease-"));
process.env.AI_MOBILE_DATA_ROOT = path.join(root, "state");
process.env.LOCALAPPDATA = path.join(root, "local");

const originalFreeMem = os.freemem;
const originalStatfsSync = fs.statfsSync;
os.freemem = () => 4096 * 1024 * 1024;
fs.statfsSync = () => ({ bavail: 8192, bsize: 1024 * 1024 });

const {
  acquireResourceLease,
  bindLeasePid,
  cleanupStaleLeases,
  releaseResourceLease,
  resourceLeaseSnapshot,
} = require("./core/resource-leases");

const { capacityRequirementSatisfied, capacityWaitDescriptor, isRecoverableCapacityWait } = require("./core/capacity-wait");

const profile = {
  maxGlobalWorkers: 8,
  maxWorkersPerProvider: 8,
  minimumFreeRamMb: 1024,
  worktreeMinFreeMb: 2048,
};
const workspace = path.join(root, "workspace");
fs.mkdirSync(workspace, { recursive: true });

function contract(jobNumber, resources, extra = {}) {
  return {
    taskId: "task-resource-lease",
    provider: `provider-${jobNumber}`,
    quotaPoolIds: [`pool-${jobNumber}`],
    fairnessKey: `project-${jobNumber}`,
    workspace,
    timeoutSeconds: 60,
    ...resources,
    ...extra,
  };
}

try {
  const direct = acquireResourceLease(contract("direct", { ramMb: 1600, diskMb: 500 }), "job-direct", profile);
  assert.equal(direct.ramMb, 1600);
  assert.equal(direct.diskMb, 500);
  assert.deepEqual(resourceLeaseSnapshot().active.map(({ jobId, ramMb, diskMb }) => ({ jobId, ramMb, diskMb })), [
    { jobId: "job-direct", ramMb: 1600, diskMb: 500 },
  ]);

  assert.throws(
    () => acquireResourceLease(contract("director-ram", {
      resourceEstimate: { ramMb: 1500, diskMb: 500 },
    }, { directorProgram: { workPackageId: "wp-ram" } }), "job-director-ram", profile),
    /minimum-free-ram-floor-would-be-crossed/,
  );
  assert.equal(resourceLeaseSnapshot().active.length, 1, "A refused reservation must not be persisted.");

  assert.equal(releaseResourceLease("job-direct").released, true);
  const afterRamRelease = acquireResourceLease(contract("director-ram", {
    resourceEstimate: { ramMb: 1500, diskMb: 500 },
  }, { directorProgram: { workPackageId: "wp-ram" } }), "job-director-ram", profile);
  assert.equal(afterRamRelease.ramMb, 1500, "Release must make the RAM reservation available immediately.");
  releaseResourceLease("job-director-ram");

  acquireResourceLease(contract("disk-a", { resourceEstimate: { ramMb: 100, diskMb: 3500 } }), "job-disk-a", profile);
  const diskB = contract("disk-b", {
    allocation: {
      cost: {
        ramMb: { state: "known", value: 100 },
        diskMb: { state: "known", value: 2800 },
      },
    },
  });
  assert.throws(() => acquireResourceLease(diskB, "job-disk-b", profile), /minimum-free-disk-floor-would-be-crossed/);
  assert.equal(releaseResourceLease("job-disk-a").released, true);
  assert.equal(acquireResourceLease(diskB, "job-disk-b", profile).diskMb, 2800);
  releaseResourceLease("job-disk-b");

  acquireResourceLease(contract("stale-release", { ramMb: 2000, diskMb: 4000 }), "job-stale-release", profile);
  bindLeasePid("job-stale-release", 2147483647);
  const unrelatedRelease = releaseResourceLease("job-not-present");
  assert.equal(unrelatedRelease.released, false, "Cleaning an unrelated stale row must not claim the requested job was released.");
  assert.equal(unrelatedRelease.active, 0);

  acquireResourceLease(contract("stale-cleanup", { ramMb: 2000, diskMb: 4000 }), "job-stale-cleanup", profile);
  bindLeasePid("job-stale-cleanup", 2147483647);
  assert.deepEqual(cleanupStaleLeases(), { removed: 1, active: 0 });
  const afterCleanup = acquireResourceLease(contract("after-cleanup", { ramMb: 2000, diskMb: 4000 }), "job-after-cleanup", profile);
  assert.equal(afterCleanup.ramMb, 2000, "Stale cleanup must release the persisted RAM reservation.");
  assert.equal(afterCleanup.diskMb, 4000, "Stale cleanup must release the persisted disk reservation.");
  assert.equal(releaseResourceLease("job-after-cleanup").released, true);
  assert.equal(resourceLeaseSnapshot().active.length, 0);

  const concurrencyResources = {
    machine: { freeRamMb: 4096, freeDiskMb: 8192 },
    worktreeStorage: { freeMb: 8192, withinQuota: true, hasMinimumFree: true },
    providers: {},
  };
  acquireResourceLease(contract("global-owner", { ramMb: 100, diskMb: 100 }, {
    taskId: "task-global-owner",
    programResourceLimits: { maxGlobalWorkers: 1, maxWorkers: 1 },
  }), "job-global-owner", profile);
  const globalRejected = { workers: [], rejected: [{ workPackageId: "work-global-wait", reason: "global-worker-cap-exhausted:1>=1" }] };
  assert.equal(isRecoverableCapacityWait(globalRejected), true);
  const globalDescriptor = capacityWaitDescriptor({ taskId: "task-global-wait", program: { runtime: {} } }, globalRejected, concurrencyResources, { capacityWaitChecks: 2 });
  assert.equal(capacityRequirementSatisfied(globalDescriptor, concurrencyResources), false);
  assert.throws(() => acquireResourceLease(contract("global-wait", { ramMb: 100, diskMb: 100 }, {
    taskId: "task-global-wait",
    programResourceLimits: { maxGlobalWorkers: 1, maxWorkers: 1 },
  }), "job-global-wait", profile), /global-worker-cap-exhausted:1>=1/);
  releaseResourceLease("job-global-owner");
  assert.equal(capacityRequirementSatisfied(globalDescriptor, concurrencyResources), true, "Lease release must satisfy the targeted concurrency wake without RAM/disk jitter.");
  acquireResourceLease(contract("global-wait", { ramMb: 100, diskMb: 100 }, {
    taskId: "task-global-wait",
    programResourceLimits: { maxGlobalWorkers: 1, maxWorkers: 1 },
  }), "job-global-wait", profile);
  releaseResourceLease("job-global-wait");

  acquireResourceLease(contract("program-owner", { ramMb: 100, diskMb: 100 }, {
    taskId: "task-program-equality",
    programResourceLimits: { maxGlobalWorkers: 8, maxWorkers: 1 },
  }), "job-program-owner", profile);
  assert.throws(() => acquireResourceLease(contract("program-wait", { ramMb: 100, diskMb: 100 }, {
    taskId: "task-program-equality",
    programResourceLimits: { maxGlobalWorkers: 8, maxWorkers: 1 },
  }), "job-program-wait", profile), /program-worker-cap-exhausted:1>=1/);
  releaseResourceLease("job-program-owner");
  acquireResourceLease(contract("program-wait", { ramMb: 100, diskMb: 100 }, {
    taskId: "task-program-equality",
    programResourceLimits: { maxGlobalWorkers: 8, maxWorkers: 1 },
  }), "job-program-wait", profile);
  releaseResourceLease("job-program-wait");

  process.stdout.write(`${JSON.stringify({
    ok: true,
    plannedReservationsPersisted: true,
    aggregateRamFloorProtected: true,
    aggregateDiskFloorProtected: true,
    releaseAndCleanupFreeReservations: true,
    concurrencyEqualityWaitsAndWakes: true,
  }, null, 2)}\n`);
} finally {
  os.freemem = originalFreeMem;
  fs.statfsSync = originalStatfsSync;
  try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* best effort */ }
}
