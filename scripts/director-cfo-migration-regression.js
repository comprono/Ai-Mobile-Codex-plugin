"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "director-cfo-migration-"));
const workspace = path.join(root, "Sample Project");
process.env.AI_MOBILE_DATA_ROOT = path.join(root, "state");
fs.mkdirSync(path.join(workspace, ".codex"), { recursive: true });
fs.mkdirSync(path.join(workspace, "context"), { recursive: true });
fs.mkdirSync(path.join(workspace, "Jobs Harness"), { recursive: true });
fs.writeFileSync(path.join(workspace, ".codex", "PROJECT_OUTCOME.md"), "# Outcome\nSubmit truthful suitable applications.\n");
fs.writeFileSync(path.join(workspace, ".codex", "ACCEPTANCE.json"), JSON.stringify({ requirements: [] }));
fs.writeFileSync(path.join(workspace, "README.md"), "# Sample Project\n");
fs.writeFileSync(path.join(workspace, "context", "thread-snapshot.md"), "# Authorized Codex thread snapshot\n");
fs.writeFileSync(path.join(workspace, "Jobs Harness", "harness.db"), "");
const exitEntrypoint = path.join(root, "coordinator-exit.js");
fs.writeFileSync(exitEntrypoint, "process.exit(0);\n", "utf8");

const {
  createRoundRecord,
  createTaskRecord,
  jobDirectory,
  listTaskIds,
  readRound,
  readTask,
  updateRound,
  updateTask,
} = require("./core/state-store");
const { statusFor } = require("./core/job-store");
const { processAlive, writeJson } = require("./core/utils");
const { migrateLegacyTaskToDirector, repairDirectorLegacyRounds } = require("./core/director-cfo-orchestrator");
const { startCoordinator } = require("./core/coordinator");

function requirementRows() {
  return [
    {
      id: "REQ-001",
      description: "One truthful suitable application has canonical confirmation.",
      required: true,
      status: "passing",
      minimumEvidenceLevel: "end-to-end",
      evidence: [{
        level: "end-to-end",
        ref: "harness.db:receipt-1",
        summary: "Canonical external confirmation exists.",
        verifiedAt: "2026-07-16T14:40:40Z",
      }],
      blocker: null,
    },
    {
      id: "REQ-003",
      description: "Receipt timestamps demonstrate the required cadence.",
      required: true,
      status: "blocked",
      minimumEvidenceLevel: "end-to-end",
      evidence: [],
      blocker: {
        owner: "runtime",
        reason: "Two fresh receipts are still required.",
        recoveryTrigger: "Eligible work appears.",
        recoveryAction: "Run a guarded campaign.",
      },
    },
  ];
}

function legacyTask(suffix) {
  return createTaskRecord({
    workspace,
    outcome: `Finish the sample project ${suffix}.`,
    requestedOutcome: `Finish the sample project ${suffix}.`,
    latestUserRequest: "Continue the existing task; do not create another task.",
    outcomeAuthority: "user",
    contractVersion: 16,
    requirements: requirementRows(),
    constraints: ["No fabricated profile facts.", "No duplicate submissions."],
    currentCodex: { model: "gpt-5.6-luna", effort: "low", files: [] },
    workGraph: [{
      id: "R-REQ-003",
      goal: "Legacy cadence work.",
      state: "pending",
      acceptanceRequirementId: "REQ-003",
      lastFailure: "no-patch-produced",
    }],
  });
}

function createRunningJob(taskId) {
  const jobId = "job-migration-running-0001";
  const directory = jobDirectory(taskId, jobId);
  fs.mkdirSync(directory, { recursive: true });
  writeJson(path.join(directory, "contract.json"), {
    taskId,
    jobId,
    workspace,
    readOnly: true,
    isolation: { mode: "shared-readonly", workspace },
  });
  writeJson(path.join(directory, "status.json"), {
    taskId,
    jobId,
    state: "running",
    pid: null,
  });
  return jobId;
}

try {
  const legacy = legacyTask("canonical");
  const originalCreatedAt = legacy.createdAt;
  const runningRound = createRoundRecord(legacy.taskId, { state: "running", jobs: [] });
  const terminalRound = createRoundRecord(legacy.taskId, { state: "running", jobs: [] });
  updateRound(legacy.taskId, terminalRound.roundId, { state: "integrated" });
  const needsCorrectionRound = createRoundRecord(legacy.taskId, { state: "running", jobs: [] });
  updateRound(legacy.taskId, needsCorrectionRound.roundId, { state: "needs-correction" });
  const runningJobId = createRunningJob(legacy.taskId);

  const migrated = migrateLegacyTaskToDirector({
    taskId: legacy.taskId,
    migrateToDirector: true,
    sourceDescriptors: {
      chats: [{
        id: "target-thread-snapshot",
        locator: "context/thread-snapshot.md",
        access: "read",
        required: true,
        authorized: true,
        authority: "user",
      }],
      files: [{ id: "readme", locator: "README.md", authorized: true }],
      git: [{ id: "repository", locator: ".", access: "metadata", authorized: true }],
      databases: [{ id: "harness-db", locator: "Jobs Harness/harness.db", access: "observe", authorized: true }],
    },
    authorization: {
      scopeId: "sample-project",
      authorizedBy: "user",
      grantRef: "codex-thread:fixture-thread-0001",
      allowedTypes: ["project-outcome", "acceptance", "chat", "file", "git", "database"],
    },
    authorizedPermissions: ["run-command", "database", "service-control", "browser", "external-write"],
  });

  assert.equal(migrated.taskId, legacy.taskId);
  assert.equal(migrated.createdAt, originalCreatedAt);
  assert.equal(listTaskIds().length, 1, "in-place migration must not create another durable task");
  assert.equal(migrated.program.mode, "director-cfo");
  assert.equal(migrated.program.phase, "context");
  assert.equal(migrated.program.mission.revision, 1);
  assert.equal(migrated.program.sourceCatalog.authorization.scopeId, "sample-project");
  assert.deepEqual(
    migrated.program.sourceCatalog.sources.map((row) => row.type).sort(),
    ["acceptance", "chat", "database", "file", "git", "project-outcome"],
  );
  assert.equal(migrated.currentCodex.model, "gpt-5.3-codex-spark");
  assert.equal(migrated.currentCodex.effort, "medium");
  assert.equal(migrated.currentCodex.ownsProjectFiles, false);
  assert.equal(migrated.workGraph.length, 1);
  assert.equal(migrated.workGraph[0].programWorkPackageId.startsWith("context-"), true);
  assert.equal(migrated.requirements.find((row) => row.id === "REQ-001").status, "passing");
  assert.equal(migrated.requirements.find((row) => row.id === "REQ-001").evidence[0].ref, "harness.db:receipt-1");
  assert.equal(migrated.program.mission.requirements.find((row) => row.requirementId === "REQ-001").evidenceRefs[0], "harness.db:receipt-1");
  assert.equal(migrated.contractVersion, 17);
  assert.equal(migrated.program.migration.sourceTaskId, legacy.taskId);
  assert.deepEqual(migrated.program.migration.cancelledJobIds, [runningJobId]);
  assert.deepEqual(migrated.program.migration.invalidatedRoundIds, [runningRound.roundId, needsCorrectionRound.roundId]);
  assert.equal(migrated.program.migration.legacyRounds.find((row) => row.roundId === runningRound.roundId).state, "running");
  assert.equal(migrated.program.migration.legacyRounds.find((row) => row.roundId === needsCorrectionRound.roundId).state, "needs-correction");
  assert.equal(statusFor(legacy.taskId, runningJobId).state, "cancelled");
  assert.equal(readRound(legacy.taskId, runningRound.roundId).state, "invalidated");
  assert.equal(readRound(legacy.taskId, needsCorrectionRound.roundId).state, "invalidated");
  assert.equal(readRound(legacy.taskId, terminalRound.roundId).state, "integrated");
  assert.equal(migrated.program.authorizedPermissions.includes("external-write"), true);
  assert.equal(migrated.program.evidenceLedger.entries.length, 0);
  updateRound(legacy.taskId, needsCorrectionRound.roundId, {
    state: "needs-correction",
    invalidatedAt: null,
    invalidatedReason: null,
  });
  updateTask(legacy.taskId, (current) => {
    current.program = {
      ...current.program,
      migration: {
        ...current.program.migration,
        invalidatedRoundIds: current.program.migration.invalidatedRoundIds.filter((roundId) => roundId !== needsCorrectionRound.roundId),
        legacyRoundRepair: null,
      },
    };
    return current;
  });
  const productionLike = readTask(legacy.taskId);
  assert.equal(productionLike.rounds.at(-1).roundId, needsCorrectionRound.roundId);
  assert.equal(readRound(legacy.taskId, needsCorrectionRound.roundId).state, "needs-correction");

  const repairStart = startCoordinator({ taskId: legacy.taskId, maxRounds: 1, maxMinutes: 1, noProgressLimit: 1 }, exitEntrypoint);
  assert.notEqual(repairStart.executionId, "");
  const repaired = readTask(legacy.taskId);
  assert.equal(readRound(legacy.taskId, needsCorrectionRound.roundId).state, "invalidated");
  assert.equal(repaired.program.migration.invalidatedRoundIds.includes(needsCorrectionRound.roundId), true);
  assert.equal(repaired.program.migration.legacyRounds.find((row) => row.roundId === needsCorrectionRound.roundId).state, "needs-correction");
  assert.deepEqual(repaired.program.migration.legacyRoundRepair.repairedRoundIds, [needsCorrectionRound.roundId]);

  const repairedAt = repaired.program.migration.legacyRoundRepair.repairedAt;
  const repairedAgain = repairDirectorLegacyRounds(legacy.taskId);
  assert.equal(repairedAgain.program.migration.legacyRoundRepair.repairedAt, repairedAt);
  const repairExitDeadline = Date.now() + 5000;
  while (repairStart.pid && processAlive(repairStart.pid) && Date.now() < repairExitDeadline) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
  assert.equal(repairStart.pid ? processAlive(repairStart.pid) : false, false);


  const idempotent = migrateLegacyTaskToDirector({ taskId: legacy.taskId, migrateToDirector: true });
  assert.equal(idempotent.program.programId, migrated.program.programId);
  assert.equal(listTaskIds().length, 1);

  const unreadable = legacyTask("unreadable-chat");
  assert.throws(() => migrateLegacyTaskToDirector({
    taskId: unreadable.taskId,
    migrateToDirector: true,
    sourceDescriptors: {
      chats: [{
        id: "raw-thread-id",
        threadId: "fixture-thread-not-snapshotted",
        required: true,
        authorized: true,
      }],
    },
    authorization: {
      scopeId: "sample-project",
      authorizedBy: "user",
      grantRef: "explicit-test",
      allowedTypes: ["chat"],
    },
  }), /readable workspace snapshot/i);
  assert.equal(readTask(unreadable.taskId).program, undefined);

  process.stdout.write(JSON.stringify({
    ok: true,
    assertions: 39,
    taskIdPreserved: migrated.taskId,
    activeJobsCancelled: migrated.program.migration.cancelledJobIds.length,
    activeRoundsInvalidated: migrated.program.migration.invalidatedRoundIds.length,
    unreadableChatFailedClosed: true,
  }, null, 2) + "\n");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
