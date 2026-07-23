"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-mobile-program-resources-"));
let outsideRoot = "";
let symlinkParent = "";
process.env.AI_MOBILE_DATA_ROOT = root;

const { allocationAuthorization, buildProgramResourceSnapshot, containedLocalArtifactPath, evaluateProgramResourceCaps } = require("./core/program-resource-snapshot");
const { createTaskRecord, jobDirectory, readTask, updateTask } = require("./core/state-store");
const { writeJson } = require("./core/utils");
const { leaseFile } = require("./core/resource-leases");

function writeJob(taskId, jobId, input) {
  const directory = jobDirectory(taskId, jobId);
  fs.mkdirSync(directory, { recursive: true });
  writeJson(path.join(directory, "contract.json"), {
    taskId,
    jobId,
    provider: input.provider,
    createdAt: input.createdAt,
    directorProgram: {
      programId: "program-resource-fixture",
      workPackageId: input.workPackageId,
      phase: input.phase,
    },
    allocation: {
      allocationId: input.allocationId,
      workPackageId: input.workPackageId,
      provider: input.provider,
      tokenLimit: input.tokenLimit,
      durationLimitMs: input.durationLimitMs,
      maxAttempts: input.maxAttempts || 2,
    },
  });
  writeJson(path.join(directory, "status.json"), input.status);
  if (input.usage) writeJson(path.join(directory, "usage.json"), input.usage);
  if (input.handoff) writeJson(path.join(directory, "handoff.json"), input.handoff);
  if (input.artifact) writeJson(path.join(directory, "artifact.json"), input.artifact);
  fs.writeFileSync(path.join(directory, "worker.diff"), input.patch || "", "utf8");
  fs.writeFileSync(path.join(directory, "durable-output.bin"), Buffer.alloc(input.bytes, 7));
  return directory;
}

try {
  const task = createTaskRecord({ workspace: root, outcome: "Resource fixture" });
  const measurableReceiptArtifact = path.join(root, "measurable-receipt.bin");
  fs.writeFileSync(measurableReceiptArtifact, Buffer.alloc(111, 9));
  outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ai-mobile-artifact-outside-"));
  const escapingArtifact = path.join(outsideRoot, "escape.bin");
  fs.writeFileSync(escapingArtifact, Buffer.alloc(777, 5));
  symlinkParent = path.join(root, "receipt-link");
  let symlinkEscapeSupported = false;
  try {
    fs.symlinkSync(outsideRoot, symlinkParent, process.platform === "win32" ? "junction" : "dir");
    symlinkEscapeSupported = true;
  } catch (error) {
    if (!["EACCES", "ENOSYS", "ENOTSUP", "EPERM", "UNKNOWN"].includes(String(error.code || ""))) throw error;
  }

  const syntheticTarget = path.join(root, "synthetic-link", "escape.bin");
  const syntheticLink = path.dirname(syntheticTarget);
  const syntheticSymlink = containedLocalArtifactPath(syntheticTarget, [root], {
    lstatSync(target) {
      if (path.resolve(target) === path.resolve(syntheticLink)) return { isSymbolicLink: () => true };
      return fs.lstatSync(target);
    },
  });
  assert.equal(syntheticSymlink.ok, false);
  assert.match(syntheticSymlink.reason, /symbolic-link/, "A symbolic-link parent is rejected before artifact measurement.");
  const nativeRealpathSync = fs.realpathSync.native || fs.realpathSync;
  const syntheticRealpathEscape = containedLocalArtifactPath(syntheticTarget, [root], {
    lstatSync() { return { isSymbolicLink: () => false }; },
    realpathSync(target) {
      return path.resolve(target) === path.resolve(syntheticTarget) ? escapingArtifact : nativeRealpathSync(target);
    },
  });
  assert.equal(syntheticRealpathEscape.ok, false);
  assert.match(syntheticRealpathEscape.reason, /real path escapes/, "Realpath containment rejects a target outside its authorized root.");
  const nowMs = Date.parse("2026-07-22T10:00:00.000Z");
  updateTask(task.taskId, (current) => {
    current.program = {
      mode: "director-cfo",
      programId: "program-resource-fixture",
      campaigns: [
        { campaignId: "campaign-resource-old", epoch: 136 },
        { campaignId: "campaign-resource-current", epoch: 137 },
      ],
      activeCampaign: { campaignId: "campaign-resource-current", epoch: 137 },
      workPackages: [{
        workPackageId: "work-resource-current",
        state: "running",
        allocation: { allocationId: "allocation-resource-current", provider: "antigravity", quotaPool: "all" },
      }],
      executionReceipts: [{
        receiptId: "receipt-resource-fixture",
        artifacts: [
          { ref: "measurable-receipt.bin", fingerprint: "artifact-fingerprint", kind: "report" },
          { ref: "measurable-receipt.bin", fingerprint: "artifact-fingerprint", kind: "report" },
          { ref: "ai-mobile-patch:job-resource-failed-0001", fingerprint: "patch-artifact-fingerprint", kind: "patch" },
        ],
      }],
      runtime: {
        programSupervisor: { campaignCount: 137 },
        ledger: {
          providers: {
            antigravity: {
              quotaPools: [{
                id: "all",
                key: "antigravity:all",
                remaining: { state: "unknown", unit: "percent", value: null, reason: "live quota unavailable" },
              }],
            },
            claude: {
              quotaPools: [{
                id: "all",
                key: "claude:all",
                remaining: { state: "known", unit: "percent", value: 55 },
              }],
            },
          },
        },
      },
    };
    return current;
  });

  const failedJobId = "job-resource-failed-0001";
  const runningJobId = "job-resource-running-0002";
  const retryJobId = "job-resource-retry-0005";
  const failedDirectory = writeJob(task.taskId, failedJobId, {
    provider: "claude",
    createdAt: "2026-07-22T08:00:00.000Z",
    workPackageId: "work-resource-context",
    phase: "context",
    allocationId: "allocation-resource-old",
    tokenLimit: 1000,
    maxAttempts: 1,
    durationLimitMs: 5000,
    status: { state: "failed", blocker: "semantic fixture failure" },
    usage: {
      provider: "claude",
      inputTokens: 100,
      cacheCreationInputTokens: 20,
      cacheReadInputTokens: 30,
      outputTokens: 50,
      resourceAccountingComplete: true,
    },
    handoff: {
      deliverable: { kind: "context-dossier", evidence: ["fixture"] },
      artifact: { kind: "context-dossier", evidence: ["fixture"] },
    },
    artifact: { kind: "verification-report", passed: false },
    patch: "diff --git a/failed.txt b/failed.txt\n+failed-attempt-output\n",
    bytes: 321,
  });
  writeJob(task.taskId, retryJobId, {
    provider: "antigravity",
    createdAt: "2026-07-22T09:50:00.000Z",
    workPackageId: "work-resource-current",
    phase: "execution",
    allocationId: "allocation-resource-current",
    tokenLimit: 700,
    durationLimitMs: 4000,
    maxAttempts: 2,
    status: { state: "cancelled", blocker: "cancelled fixture attempt" },
    usage: { provider: "antigravity", totalTokens: null, resourceAccountingComplete: false },
    patch: "",
    bytes: 222,
  });
  writeJob(task.taskId, runningJobId, {
    provider: "antigravity",
    createdAt: "2026-07-22T09:59:00.000Z",
    workPackageId: "work-resource-current",
    phase: "execution",
    allocationId: "allocation-resource-current",
    tokenLimit: 700,
    durationLimitMs: 4000,
    maxAttempts: 2,
    status: { state: "running", startedAt: "2026-07-22T09:59:59.000Z", pid: process.pid },
    usage: { provider: "antigravity", totalTokens: null, resourceAccountingComplete: false },
    patch: "",
    bytes: 654,
  });
  const abandonedJobId = "job-resource-abandoned-0004";
  const abandonedDirectory = writeJob(task.taskId, abandonedJobId, {
    provider: "claude",
    createdAt: "2026-07-22T09:58:00.000Z",
    workPackageId: "work-resource-abandoned",
    phase: "execution",
    allocationId: "allocation-resource-abandoned",
    tokenLimit: 50000,
    durationLimitMs: 50000,
    status: {},
    bytes: 999,
  });
  writeJson(path.join(abandonedDirectory, "allocation-attempt-claim.json"), { state: "abandoned" });

  writeJson(leaseFile(), {
    schemaVersion: 1,
    active: [
      { jobId: runningJobId, taskId: task.taskId, provider: "antigravity", quotaPoolIds: ["all"], pid: process.pid, expiresAt: "2026-07-22T10:10:00.000Z" },
      { jobId: failedJobId, taskId: task.taskId, provider: "claude", quotaPoolIds: ["all"], pid: process.pid, expiresAt: "2026-07-22T09:00:00.000Z" },
      { jobId: "job-resource-other-0003", taskId: "task-resource-other-0003", provider: "codex", quotaPoolIds: ["codex"], pid: process.pid, expiresAt: "2026-07-22T10:10:00.000Z" },
    ],
  });

  const input = {
    taskId: task.taskId,
    campaignCount: 137,
    nowMs,
    limits: { maxAttempts: 3, maxTokens: 2400, maxDurationMs: 13000, maxArtifacts: 5, maxArtifactBytes: 100000 },
  };
  const first = buildProgramResourceSnapshot(input);
  const second = buildProgramResourceSnapshot(input);

  assert.deepEqual(second, first, "An unchanged durable point-in-time snapshot must be idempotent.");
  assert.equal(first.fingerprint, second.fingerprint);
  assert.equal(first.jobs.length, 3, "All real Director attempts across prior and current epochs are counted.");
  assert.ok(!first.jobs.some((row) => row.jobId === abandonedJobId), "An abandoned pre-spawn allocation claim is not a durable attempt.");
  assert.equal(first.totals.attempts.committed, 3, "Each durable job counts once, including failed and cancelled attempts.");
  assert.equal(first.totals.tokens.known, 200, "Claude input, cache creation, cache read, and output tokens are each counted once.");
  assert.equal(first.totals.tokens.committed, 1600, "Each missing-telemetry attempt commits its immutable allocation token limit.");
  assert.equal(first.totals.durationMs.known, 1000, "The active status elapsed time is observed.");
  assert.equal(first.totals.durationMs.committed, 13000, "Unmeasured terminal and active jobs each commit their immutable duration limit.");
  assert.equal(first.campaign.count, 137, "Campaign count remains monotonic beyond retained 100-row histories.");
  assert.equal(first.concurrency.programActive, 1, "Only a live resource lease controls program concurrency.");
  assert.equal(first.concurrency.globalActive, 2, "Live leases outside this program remain visible to the global cap.");
  assert.deepEqual(first.concurrency.byProvider, { antigravity: 1 });
  assert.equal(first.quota.providers.antigravity.pools[0].remaining.state, "unknown");
  assert.equal(first.quota.providers.antigravity.pools[0].remaining.value, null, "Unknown quota must never become zero.");
  assert.ok(first.blockers.some((row) => row.code === "quota-capacity-unknown" && row.provider === "antigravity" && row.hard === true));
  assert.equal(first.totals.artifacts.known, 5, "Duplicate refs count once while distinct receipt, deliverable, and patch identities remain unique.");
  assert.ok(first.jobs.find((row) => row.jobId === failedJobId).durableBytes >= 321, "Failed-job durable bytes remain charged.");
  assert.ok(first.totals.durableBytes.known >= fs.statSync(path.join(failedDirectory, "durable-output.bin")).size + 222 + 654 + 111);
  assert.equal(first.artifactStorage.complete, true);
  assert.equal(first.artifactStorage.bytes, 111, "An existing authorized local receipt artifact is measured once.");
  assert.ok(first.artifactStorage.measured.some((row) => row.ref.startsWith("ai-mobile-patch:") && row.coveredByJobDirectory === true));
  assert.equal(first.totals.durableBytes.complete, true);

  assert.deepEqual(first.authorization.totals, { tokens: 2400, durationMs: 13000, attempts: 3 });
  const sharedGrant = first.authorization.allocations.find((row) => row.allocationId === "allocation-resource-current");
  assert.equal(sharedGrant.jobIds.length, 2, "Repeated attempts sharing one allocation produce one immutable grant.");
  assert.deepEqual(sharedGrant.authorized, { tokens: 1400, durationMs: 8000, attempts: 2 });
  assert.deepEqual(sharedGrant.committed, { tokens: 1400, durationMs: 8000, attempts: 2 });
  const thirdAttempt = allocationAuthorization([
    ...first.jobs,
    { ...first.jobs.find((row) => row.jobId === runningJobId), jobId: "job-resource-synthetic-third" },
  ]);
  assert.ok(thirdAttempt.blockers.some((row) => row.code === "allocation-attempt-authorization-exceeded"));
  assert.ok(thirdAttempt.blockers.some((row) => row.code === "allocation-token-authorization-exceeded"));
  assert.ok(thirdAttempt.blockers.some((row) => row.code === "allocation-duration-authorization-exceeded"));
  assert.equal(first.capCheck.safe, true, "Optional supervisor hard caps layer above immutable allocation authorization.");

  const retiredCapacity = allocationAuthorization([{
    jobId: "job-retired-capacity",
    state: "failed",
    allocationId: "allocation-retired-capacity",
    workPackageId: "work-retired-capacity",
    provider: "codex",
    tokens: { committed: 28000 },
    durationMs: { committed: 217314 },
    allocation: {
      allocationId: "allocation-retired-capacity",
      workPackageId: "work-retired-capacity",
      provider: "codex",
      model: "gpt-5.3-codex-spark",
      tokenLimit: 150000,
      durationLimitMs: 2100000,
      maxAttempts: 1,
    },
  }], [{ workPackageId: "work-retired-capacity", state: "failed" }]);
  assert.deepEqual(retiredCapacity.totals, { tokens: 150000, durationMs: 2100000, attempts: 1 }, "Gross historical authorization remains auditable.");
  assert.deepEqual(retiredCapacity.capacityTotals, { tokens: 28000, durationMs: 217314, attempts: 1 }, "A retired terminal grant releases unused token and duration headroom.");
  const activeCapacity = allocationAuthorization(retiredCapacity.allocations[0].jobIds.map(() => ({
    jobId: "job-retired-capacity",
    state: "failed",
    allocationId: "allocation-retired-capacity",
    workPackageId: "work-retired-capacity",
    provider: "codex",
    tokens: { committed: 28000 },
    durationMs: { committed: 217314 },
    allocation: retiredCapacity.allocations[0].binding,
  })), [{ workPackageId: "work-retired-capacity", state: "running" }]);
  assert.deepEqual(activeCapacity.capacityTotals, activeCapacity.totals, "A non-retired package retains its full immutable authorization.");
  const historicalTask = JSON.parse(JSON.stringify(readTask(task.taskId)));
  historicalTask.program.workPackages = historicalTask.program.workPackages.map((row) => ({ ...row, state: "completed" }));
  const historicalOnly = buildProgramResourceSnapshot({ ...input, task: historicalTask, liveLeases: [] });
  const historicalQuota = historicalOnly.quota.providerBlockers.find((row) => row.provider === "antigravity");
  assert.equal(historicalQuota.hard, false, "Unknown historical provider quota remains a provider-reuse blocker.");
  assert.ok(!historicalOnly.blockers.some((row) => row.code === "quota-capacity-unknown"), "Historical AG use alone must not freeze unrelated ready work.");
  assert.equal(historicalOnly.safe, true, "Unknown historical quota alone is not globally unsafe.");
  const boundedUnknownTask = JSON.parse(JSON.stringify(historicalTask));
  const boundedUnknownAllocationId = "allocation-bounded-unknown-first-attempt";
  boundedUnknownTask.program.activeCampaign = {
    campaignId: "campaign-bounded-unknown-first-attempt",
    epoch: 138,
    allocationIds: [boundedUnknownAllocationId],
  };
  boundedUnknownTask.program.workPackages.push({
    workPackageId: "work-bounded-unknown-first-attempt",
    state: "ready",
    allocation: {
      allocationId: boundedUnknownAllocationId,
      provider: "antigravity",
      quotaPool: "all",
      tokenLimit: 1000,
      durationLimitMs: 60000,
      maxAttempts: 1,
      quotaReservations: [{
        provider: "antigravity",
        poolId: "all",
        poolKey: "antigravity:all",
        remainingBefore: { state: "unknown", unit: "percent", value: null, reason: "live quota unavailable" },
        unknownCapacity: true,
        exclusive: true,
      }],
      accountingBasis: {
        mode: "bounded-wall-time-exclusive-unknown-quota",
        postRunQuotaRefreshRequired: true,
      },
    },
  });
  const boundedUnknownSnapshot = buildProgramResourceSnapshot({ ...input, task: boundedUnknownTask, liveLeases: [], campaignCount: 138 });
  const boundedUnknownQuota = boundedUnknownSnapshot.quota.providerBlockers.find((row) => row.provider === "antigravity");
  assert.equal(boundedUnknownQuota.hard, false, "One active-campaign allocation with immutable one-attempt caps may consume its existing unknown-quota authority.");
  assert.equal(boundedUnknownQuota.boundedFirstAttempt, true);
  assert.ok(!boundedUnknownSnapshot.blockers.some((row) => row.code === "quota-capacity-unknown"));
  assert.equal(boundedUnknownSnapshot.safe, true);
  const opaqueTask = JSON.parse(JSON.stringify(historicalTask));
  opaqueTask.program.executionReceipts = [{
    receiptId: "receipt-old-opaque-artifact",
    artifacts: [{ ref: "artifact://retired-output", fingerprint: "retired-output-fingerprint", kind: "report" }],
  }];
  const opaqueSnapshot = buildProgramResourceSnapshot({ ...input, task: opaqueTask, liveLeases: [] });
  const opaqueBlocker = opaqueSnapshot.blockers.find((row) => row.code === "program-artifact-bytes-unknown");
  assert.equal(opaqueBlocker.unknownCount, 1, "Unmeasurable old receipt refs produce one bounded explicit blocker.");
  assert.equal(opaqueSnapshot.artifactStorage.unknown.length, 1);
  assert.equal(opaqueSnapshot.totals.durableBytes.complete, false);
  assert.equal(opaqueSnapshot.totals.durableBytes.committed, null, "Unknown artifact bytes must never be coerced to zero.");
  assert.ok(opaqueSnapshot.totals.durableBytes.known > 0, "Known durable bytes remain a visible lower bound.");
  assert.ok(opaqueSnapshot.capCheck.blockers.some((row) => row.code === "program-durableBytes-accounting-unknown"));
  assert.equal(opaqueSnapshot.safe, false);

  if (symlinkEscapeSupported) {
    const escapedTask = JSON.parse(JSON.stringify(historicalTask));
    escapedTask.program.executionReceipts = [{
      receiptId: "receipt-workspace-symlink-escape",
      artifacts: [{ ref: path.join("receipt-link", "escape.bin"), fingerprint: "symlink-escape-fingerprint", kind: "report" }],
    }];
    const escapedSnapshot = buildProgramResourceSnapshot({ ...input, task: escapedTask, liveLeases: [] });
    const escapedBlocker = escapedSnapshot.blockers.find((row) => row.code === "program-artifact-bytes-unknown");
    assert.equal(escapedBlocker.unknownCount, 1, "A workspace symlink escape is unknown storage, never measured usage.");
    assert.equal(escapedSnapshot.artifactStorage.bytes, 0, "Outside artifact bytes must not enter program accounting.");
    assert.equal(escapedSnapshot.artifactStorage.measured.length, 0);
    assert.match(
      escapedSnapshot.artifactStorage.unknown[0].reason,
      /symbolic-link|real path escapes/,
      "The receipt records the containment failure without following the link.",
    );
    assert.equal(escapedSnapshot.totals.durableBytes.committed, null);
  }

  const exceeded = evaluateProgramResourceCaps(first, { maxTokens: 2399, maxAttempts: 2 });
  assert.equal(exceeded.safe, false);
  assert.ok(exceeded.blockers.some((row) => row.code === "program-token-cap-exceeded"));
  assert.ok(exceeded.blockers.some((row) => row.code === "program-attempt-cap-exceeded"));

  process.stdout.write(JSON.stringify({
    ok: true,
    jobs: first.jobs.length,
    attempts: first.totals.attempts.committed,
    knownTokens: first.totals.tokens.known,
    committedTokens: first.totals.tokens.committed,
    committedDurationMs: first.totals.durationMs.committed,
    campaignCount: first.campaign.count,
    activeLeases: first.concurrency.programActive,
    durableBytes: first.totals.durableBytes.known,
    fingerprint: first.fingerprint,
  }, null, 2) + "\n");
} finally {
  try {
    if (symlinkParent && fs.lstatSync(symlinkParent).isSymbolicLink()) fs.unlinkSync(symlinkParent);
  } catch {}
  fs.rmSync(root, { recursive: true, force: true });
  if (outsideRoot) fs.rmSync(outsideRoot, { recursive: true, force: true });
}
