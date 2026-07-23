#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-mobile-v1-storage-"));
process.env.AI_MOBILE_DATA_ROOT = path.join(root, "state");
process.env.LOCALAPPDATA = path.join(root, "local");
const workspace = path.join(root, "workspace");
fs.mkdirSync(workspace, { recursive: true });
fs.writeFileSync(path.join(workspace, "tracked.txt"), "primary\n", "utf8");
fs.mkdirSync(path.join(workspace, ".ai-mobile", "context"), { recursive: true });
fs.writeFileSync(path.join(workspace, ".ai-mobile", "context", "history.md"), "authorized chat\n", "utf8");

function git(args) {
  const result = spawnSync("git", args, { cwd: workspace, encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}
git(["init"]);
git(["config", "user.email", "ai-mobile@example.invalid"]);
git(["config", "user.name", "AI Mobile Test"]);
git(["add", "."]);
git(["commit", "-m", "fixture"]);

const { fileSha256, readJson, writeJson } = require("./core/utils");
const { stateRoot } = require("./core/state-store");
const { leaseFile, resourceLeaseSnapshot } = require("./core/resource-leases");
const { assertCanaryExecutorAllowed, cleanupAbandonedJobs, disposableCanaryDecision } = require("./core/job-store");
const { createSourceCatalog } = require("./core/source-catalog");
const { createContextScoutWorkPackage } = require("./core/context-dossier");
const { assertDirectorWorkerContract, createDirectorWorkerContract } = require("./core/director-worker-contract");
const { fingerprint, changedFingerprints } = require("./core/git-evidence");
const { assertCompleteSnapshotFingerprint, promptFor } = require("./core/worker");
const {
  cleanupAbandonedWorktrees,
  cleanupIsolatedWorkspace,
  metadataFile,
  prepareIsolatedWorkspace,
  prepareWorkspaceForContract,
  storageStatus,
  worktreeRoot,
} = require("./core/workspace-isolation");

const profile = { worktreeDiskQuotaMb: 64, worktreeMinFreeMb: 1, worktreeMaxAgeHours: 1 };
function status(taskId, jobId, value) {
  writeJson(path.join(stateRoot(), "tasks", taskId, "jobs", jobId, "status.json"), value);
}

try {
  const readOnly = prepareIsolatedWorkspace(workspace, "task-readonly-0001", "job-readonly-0001", true, profile);
  assert.equal(readOnly.mode, "shared-read-only");
  assert.equal(fs.existsSync(metadataFile("job-readonly-0001")), false);
  const directorScratch = prepareWorkspaceForContract({
    workspace,
    readOnly: true,
    directorProgram: { programId: "program-strategy", workPackageId: "strategy-1" },
    relevantFiles: [],
    resourceEstimate: { ramMb: 128, diskMb: 16 },
  }, "task-strategy-0001", "job-strategy-0001", profile);
  assert.equal(directorScratch.mode, "read-only-snapshot");
  assert.notEqual(directorScratch.executionWorkspace, workspace, "read-only Director strategy must never execute in the live project workspace");
  assert.equal(cleanupIsolatedWorkspace(directorScratch).cleaned, true);
  assert.equal(assertCanaryExecutorAllowed({ executorKind: "context-scout" }, "context-scout,strategist"), true);
  assert.throws(() => assertCanaryExecutorAllowed({ executorKind: "code-change" }, "context-scout,strategist"), /release-canary-executor-denied/);
  assert.equal(assertCanaryExecutorAllowed({ executorKind: "context-scout", directorProgram: { phase: "context" } }, "context-scout,strategist", "context,strategy"), true);
  assert.throws(
    () => assertCanaryExecutorAllowed({ executorKind: "context-scout", directorProgram: { phase: "execution" } }, "context-scout,strategist", "context,strategy"),
    /release-canary-phase-denied/,
  );
  const disposableWorkspace = path.join(root, "disposable-project");
  const canaryPolicy = (contract) => disposableCanaryDecision(
    { workspace: disposableWorkspace, directorProgram: { phase: "execution" }, ...contract },
    "disposable-project",
    disposableWorkspace,
  );
  assert.equal(canaryPolicy({ executorKind: "context-scout", readOnly: true }).allowed, true);
  assert.equal(canaryPolicy({
    executorKind: "code-change",
    deliverableKind: "patch",
    readOnly: false,
    mutatesExternalState: false,
    expectedFiles: ["src/fix.js"],
    verificationCommands: [{ command: "node", args: ["test.js"], timeoutSeconds: 30 }],
  }).allowed, true);
  assert.match(canaryPolicy({
    executorKind: "code-change",
    deliverableKind: "patch",
    readOnly: false,
    mutatesExternalState: true,
    expectedFiles: ["src/fix.js"],
    verificationCommands: [{ command: "node", args: ["test.js"], timeoutSeconds: 30 }],
  }).reason, /code-boundary-denied/);
  const disposableOperation = {
    executorKind: "operational-transaction",
    deliverableKind: "operation-receipt",
    readOnly: false,
    mutatesExternalState: false,
    relevantFiles: ["runtime.db"],
    verificationCommands: [{ command: "python", args: ["verify.py"], timeoutSeconds: 30 }],
    commands: [{ command: "python", args: ["repair.py"], timeoutSeconds: 30 }],
    preconditions: ["The disposable database needs repair."],
    postconditions: ["The disposable database passes integrity checks."],
    recoveryAction: "Restore the disposable snapshot.",
    sideEffectKey: "disposable-db-repair",
    observedStateFingerprint: "before-repair",
    userAuthorizationRef: "release-canary",
  };
  assert.equal(canaryPolicy(disposableOperation).allowed, true);
  assert.match(canaryPolicy({ ...disposableOperation, mutatesExternalState: true }).reason, /operation-boundary-denied/);
  assert.match(canaryPolicy({ ...disposableOperation, commands: [] }).reason, /operation-contract-incomplete/);
  assert.match(disposableCanaryDecision({
    workspace,
    directorProgram: { phase: "execution" },
    executorKind: "context-scout",
    readOnly: true,
  }, "disposable-project", disposableWorkspace).reason, /workspace-denied/);

  const databaseFile = path.join(workspace, "live.db");
  const writer = new DatabaseSync(databaseFile);
  try {
    writer.exec("PRAGMA journal_mode=WAL");
    writer.exec("PRAGMA wal_autocheckpoint=0");
    writer.exec("CREATE TABLE records (id INTEGER PRIMARY KEY, value TEXT NOT NULL)");
    writer.exec("INSERT INTO records(value) VALUES ('captured')");
    const sourceCatalog = createSourceCatalog({
      missionId: "mission-snapshot",
      authorization: { scopeId: "snapshot", allowedTypes: ["chat", "file", "git", "database"] },
      chats: [{ id: "chat-source", locator: path.join(workspace, ".ai-mobile", "context", "history.md"), authorized: true }],
      files: [{ id: "tracked-source", locator: path.join(workspace, "tracked.txt"), authorized: true }],
      git: [{ id: "git-source", locator: ".", authorized: true }],
      databases: [{ id: "database-source", locator: databaseFile, authorized: true }],
    });
    const bootstrap = createContextScoutWorkPackage({
      mission: { id: "mission-snapshot", revision: 1, outcome: "Read one immutable context snapshot" },
      sourceCatalog,
      workspace,
    });
    const workPackage = {
      workPackageId: "context-snapshot-1",
      executorKind: "context-scout",
      deliverableKind: "context-dossier",
      bootstrapContract: bootstrap,
      requiredCapabilities: ["source", "local-files"],
      requiredPermissions: ["read-project", "read-files"],
      permissionGrant: ["read-project", "read-files"],
      databaseObservation: { mode: "immutable-sqlite-receipt", sourceIds: ["database-source"] },
      permissionPreflight: { ok: true },
    };
    const directorWorkerContract = createDirectorWorkerContract(workPackage);
    const contextJob = {
      workspace,
      goal: bootstrap.prompt,
      readOnly: true,
      executorKind: "context-scout",
      deliverableKind: "context-dossier",
      directorProgram: { programId: "program-snapshot", workPackageId: workPackage.workPackageId, phase: "context" },
      directorWorkerContract,
      relevantFiles: [".ai-mobile/context/history.md", "tracked.txt", "live.db"],
      resourceEstimate: { ramMb: 128, diskMb: 20 },
    };
    assert.throws(() => prepareWorkspaceForContract({
      ...contextJob,
      relevantFiles: Array.from({ length: 81 }, (_, index) => `source-${index}.txt`),
    }, "task-source-limit-0001", "job-source-limit-0001", profile), /context-source-file-limit-exceeded:81/);
    assert.throws(() => assertCompleteSnapshotFingerprint({
      "__AI_MOBILE_FINGERPRINT_OVERFLOW__": "more-than-5000-entries",
    }), /read-only-snapshot-fingerprint-overflow/);
    const snapshot = prepareWorkspaceForContract(contextJob, "task-snapshot-0001", "job-snapshot-0001", profile);
    assert.equal(snapshot.mode, "read-only-snapshot");
    assert.equal(fs.existsSync(metadataFile("job-snapshot-0001")), true, "snapshot cleanup metadata must exist");
    assert.equal(assertDirectorWorkerContract(contextJob.directorWorkerContract), contextJob.directorWorkerContract);
    const workerBootstrap = contextJob.directorWorkerContract.bootstrapContract;
    assert.equal(workerBootstrap.sourceSnapshotManifest.workspace, ".");
    const gitSource = workerBootstrap.sourceCatalog.sources.find((row) => row.id === "git-source");
    assert.equal(gitSource.locator, ".ai-mobile-director/git/git-source.json", "required Git context must point to an immutable receipt");
    const gitReceipt = readJson(path.join(snapshot.executionWorkspace, gitSource.locator), null);
    assert.equal(gitReceipt.schemaVersion, "director-cfo/git-snapshot-receipt@1");
    assert.match(gitReceipt.head, /^[0-9a-f]{40,64}$/);
    const gitManifest = workerBootstrap.sourceSnapshotManifest.snapshots.find((row) => row.sourceId === "git-source");
    assert.equal(gitManifest.contentHash, gitReceipt.stateFingerprint, "Git source fingerprint must ignore capture time and bind stable repository state");
    const databaseSource = workerBootstrap.sourceCatalog.sources.find((row) => row.id === "database-source");
    assert.equal(databaseSource.locator, path.join(".ai-mobile-director", "database-observations", "database-source.json"));
    assert.equal(databaseSource.observationReceipt.path, databaseSource.locator);
    assert.equal(databaseSource.observationReceipt.schemaVersion, "director-cfo/sqlite-observation-receipt@1");
    assert.ok(contextJob.relevantFiles.includes(databaseSource.locator), "database receipt must be an explicit worker-readable file");
    assert.equal(contextJob.relevantFiles.includes("live.db"), false, "provider tools must not be told to parse the SQLite binary");
    assert.deepEqual(contextJob.contextObservationPreflight, {
      ok: true,
      mode: "immutable-sqlite-receipt",
      databaseSourceIds: ["database-source"],
    });
    assert.equal(JSON.stringify(contextJob.directorWorkerContract).toLowerCase().includes(workspace.toLowerCase()), false, "worker contract must not expose the live workspace path");
    assert.equal(contextJob.goal.toLowerCase().includes(workspace.toLowerCase()), false, "worker prompt must not expose the live workspace path");
    const providerPrompt = promptFor({
      ...contextJob,
      projectGoal: `Read the authorized project at ${workspace}`,
      currentCodexGoal: "Report only",
      independenceReason: "Immutable context capture",
      executionWorkspace: snapshot.executionWorkspace,
      isolation: snapshot,
      maxWorkerOutputTokens: 3000,
    });
    assert.match(providerPrompt, /Immutable Director worker contract/);
    assert.equal(providerPrompt.toLowerCase().includes(workspace.toLowerCase()), false, "final provider prompt must withhold the live workspace path");
    const copiedDatabase = path.join(snapshot.executionWorkspace, "live.db");
    const databaseSnapshot = new DatabaseSync(copiedDatabase, { readOnly: true });
    try {
      assert.equal(databaseSnapshot.prepare("SELECT COUNT(*) AS count FROM records").get().count, 1, "workspace isolation must use the WAL-safe SQLite helper");
    } finally {
      databaseSnapshot.close();
    }
    const databaseManifest = workerBootstrap.sourceSnapshotManifest.snapshots.find((row) => row.sourceId === "database-source");
    assert.equal(databaseManifest.contentHash, fileSha256(copiedDatabase), "worker contract must be rebuilt from the captured database");
    const databaseReceiptFile = path.join(snapshot.executionWorkspace, databaseSource.locator);
    const databaseReceipt = readJson(databaseReceiptFile, null);
    const databaseReceiptExpectation = contextJob.contextObservationReceiptExpectations["database-source"];
    assert.equal(databaseReceipt.schemaVersion, "director-cfo/sqlite-observation-receipt@1");
    assert.equal(databaseReceipt.sourceId, "database-source");
    assert.equal(databaseReceipt.snapshot.contentHash, databaseManifest.contentHash, "observation receipt must bind the exact immutable SQLite snapshot");
    assert.equal(databaseReceipt.receiptFingerprint, databaseReceiptExpectation.receiptFingerprint, "hidden integration expectation must bind the worker-visible receipt");
    assert.equal(databaseReceiptExpectation.snapshotContentHash, databaseManifest.contentHash);
    assert.ok(databaseReceipt.tables.find((row) => row.name === "records")?.sampleRows.some((row) => row.value === "captured"), "file-only context workers need bounded canonical database content");
    assert.match(contextJob.goal, /queryReceiptFingerprint/);
    assert.match(contextJob.goal, /do not parse the SQLite binary/i);
    writer.exec("INSERT INTO records(value) VALUES ('after-capture')");
    const stillImmutable = new DatabaseSync(copiedDatabase, { readOnly: true });
    try {
      assert.equal(stillImmutable.prepare("SELECT COUNT(*) AS count FROM records").get().count, 1);
    } finally {
      stillImmutable.close();
    }
    fs.writeFileSync(path.join(workspace, "tracked.txt"), "live-source-changed\n", "utf8");
    assert.equal(fs.readFileSync(path.join(snapshot.executionWorkspace, "tracked.txt"), "utf8"), "primary\n");
    const beforeMutation = fingerprint(snapshot.executionWorkspace, ["."], 5000, { strong: true });
    assert.ok(beforeMutation[".ai-mobile/context/history.md"], "strong snapshot guard must include authorized .ai-mobile context");
    assert.ok(beforeMutation[".ai-mobile-director/git/git-source.json"], "strong snapshot guard must include immutable Git evidence");
    assert.ok(beforeMutation[databaseSource.locator.replace(/\\/g, "/")], "strong snapshot guard must include immutable database observation evidence");
    fs.writeFileSync(path.join(snapshot.executionWorkspace, "worker-created.txt"), "mutation\n", "utf8");
    fs.mkdirSync(path.join(snapshot.executionWorkspace, "worker-empty"));
    const afterMutation = fingerprint(snapshot.executionWorkspace, ["."], 5000, { strong: true });
    const snapshotChanges = changedFingerprints(beforeMutation, afterMutation);
    assert.ok(snapshotChanges.includes("worker-created.txt"), "whole-snapshot fingerprinting must catch files outside relevantFiles");
    assert.ok(snapshotChanges.includes("worker-empty/"), "whole-snapshot fingerprinting must catch empty directories");
    assert.equal(fs.existsSync(path.join(workspace, "worker-created.txt")), false, "snapshot mutation must not reach the live workspace");
    const snapshotCleanup = cleanupIsolatedWorkspace(snapshot);
    assert.equal(snapshotCleanup.cleaned, true);
    assert.equal(fs.existsSync(snapshot.executionWorkspace), false);
    assert.equal(fs.existsSync(metadataFile("job-snapshot-0001")), false);
    fs.writeFileSync(path.join(workspace, "tracked.txt"), "primary\n", "utf8");
  } finally {
    writer.close();
  }

  const crashTask = "task-crash-00000001";
  const crashJob = "job-crash-00000001";
  const crashed = prepareIsolatedWorkspace(workspace, crashTask, crashJob, false, profile);
  assert.equal(fs.existsSync(crashed.executionWorkspace), true);
  status(crashTask, crashJob, { state: "running", pid: 2147483647 });
  writeJson(leaseFile(), {
    schemaVersion: 1,
    active: [{ jobId: crashJob, taskId: crashTask, provider: "claude", quotaPoolIds: ["test"], expiresAt: new Date(Date.now() + 60000).toISOString() }],
    fairness: {},
    updatedAt: new Date().toISOString(),
  });
  const crashCleanup = cleanupAbandonedWorktrees(profile);
  assert.equal(crashCleanup.reasons["lost-worker"], 1);
  assert.equal(fs.existsSync(crashed.executionWorkspace), false);
  assert.equal(resourceLeaseSnapshot().active.some((row) => row.jobId === crashJob), false, "abandoned workspace cleanup must release its reservation");

  const queuedTask = "task-queued-00000001";
  const queuedJob = "job-queued-00000001";
  const queued = prepareIsolatedWorkspace(workspace, queuedTask, queuedJob, false, profile);
  status(queuedTask, queuedJob, {
    state: "queued",
    pid: null,
    createdAt: new Date(Date.now() - 2 * 60 * 1000).toISOString(),
    updatedAt: new Date(Date.now() - 2 * 60 * 1000).toISOString(),
  });
  writeJson(leaseFile(), {
    schemaVersion: 1,
    active: [{ jobId: queuedJob, taskId: queuedTask, provider: "claude", quotaPoolIds: ["queued-test"], expiresAt: new Date(Date.now() + 60000).toISOString() }],
    fairness: {},
    updatedAt: new Date().toISOString(),
  });
  const queuedCleanup = cleanupAbandonedWorktrees(profile);
  assert.equal(queuedCleanup.reasons["queued-without-worker"], 1);
  assert.equal(fs.existsSync(queued.executionWorkspace), false);
  assert.equal(readJson(path.join(stateRoot(), "tasks", queuedTask, "jobs", queuedJob, "status.json"), {}).state, "failed");
  assert.equal(resourceLeaseSnapshot().active.some((row) => row.jobId === queuedJob), false, "unspawned queued job cleanup must release its reservation");

  const sharedTask = "task-shared-queued-0001";
  const sharedJob = "job-shared-queued-0001";
  status(sharedTask, sharedJob, {
    state: "queued",
    pid: null,
    createdAt: new Date(Date.now() - 2 * 60 * 1000).toISOString(),
    updatedAt: new Date(Date.now() - 2 * 60 * 1000).toISOString(),
  });
  writeJson(leaseFile(), {
    schemaVersion: 1,
    active: [{ jobId: sharedJob, taskId: sharedTask, provider: "claude", quotaPoolIds: ["shared-queued-test"], expiresAt: new Date(Date.now() + 60000).toISOString() }],
    fairness: {},
    updatedAt: new Date().toISOString(),
  });
  const sharedCleanup = cleanupAbandonedJobs();
  assert.ok(sharedCleanup.recovered >= 1);
  assert.equal(readJson(path.join(stateRoot(), "tasks", sharedTask, "jobs", sharedJob, "status.json"), {}).state, "failed");
  assert.equal(resourceLeaseSnapshot().active.some((row) => row.jobId === sharedJob), false, "shared read-only queued recovery must release its reservation without worktree metadata");

  const ageTask = "task-aged-000000001";
  const ageJob = "job-aged-000000001";
  const aged = prepareIsolatedWorkspace(workspace, ageTask, ageJob, false, profile);
  status(ageTask, ageJob, { state: "running", pid: process.pid });
  const agedMeta = readJson(metadataFile(ageJob), {});
  writeJson(metadataFile(ageJob), { ...agedMeta, createdAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString() });
  const ageCleanup = cleanupAbandonedWorktrees(profile);
  assert.equal(ageCleanup.reasons["maximum-age"], 1);
  assert.equal(fs.existsSync(aged.executionWorkspace), false);

  assert.throws(() => prepareIsolatedWorkspace(workspace, "task-quota-00000001", "job-quota-00000001", false, { ...profile, worktreeDiskQuotaMb: 0.0001 }), /violate storage limits|storage quota/i);
  assert.throws(() => prepareIsolatedWorkspace(workspace, "task-space-00000001", "job-space-00000001", false, { ...profile, worktreeMinFreeMb: Number.MAX_SAFE_INTEGER }), /Disk free space/i);

  const finalStorage = storageStatus(profile);
  assert.equal(finalStorage.withinQuota, true);
  assert.equal(fs.existsSync(worktreeRoot()) ? fs.readdirSync(worktreeRoot(), { recursive: true }).some((entry) => String(entry).includes("job-")) : false, false);
  assert.equal(fs.readFileSync(path.join(workspace, "tracked.txt"), "utf8"), "primary\n");

  process.stdout.write(`${JSON.stringify({ ok: true, readOnlyWorktrees: 0, immutableContextSnapshot: true, isolatedDirectorStrategy: true, sqliteWalSnapshot: true, sqliteObservationReceipt: true, fullSnapshotMutationGuard: true, fingerprintOverflowFailsClosed: true, sourceLimitFailsClosed: true, liveWorkspaceWithheld: true, snapshotCleanup: true, crashCleanup: true, queuedSpawnCleanup: true, sharedQueuedSpawnCleanup: true, maximumAgeCleanup: true, quotaEnforced: true, minimumFreeSpaceEnforced: true, primaryWorktreeUntouched: true, storageUsedMb: finalStorage.usedMb }, null, 2)}\n`);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
