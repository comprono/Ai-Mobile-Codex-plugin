#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");
const {
  classifyCanaryStart,
  cloneProjectWorkspace,
  databaseIntegrationProof,
  executionBoundarySatisfied,
  LIVE_CANARY_CAPTURE_SENTINEL,
  LIVE_CANARY_EXECUTOR_ALLOWLIST,
  postExecutionReconciliationBoundary,
  safeExternalDeferralBoundary,
  verifySupervisorRenewals,
} = require("./live-state-release-canary");
const { cleanupIsolatedWorkspace, prepareWorkspaceForContract } = require("./core/workspace-isolation");

const terminalCoordinator = { state: "stopped", pid: null };
const base = {
  program: {
    mode: "director-cfo",
    phase: "strategy",
    masterPlan: null,
    contextDossier: { contextRevision: 2, contextFingerprint: "context-fingerprint" },
    activeCampaign: null,
    failureMemory: [],
    workPackages: [{
      workPackageId: "strategy-retry",
      executorKind: "strategist",
      state: "pending",
      jobId: "",
      resourceEstimate: { tokens: 30000, wallTimeSeconds: 1200 },
    }],
  },
  rounds: [],
};

async function main() {
  const strategy = classifyCanaryStart(base, terminalCoordinator, "");
  assert.equal(strategy.mode, "strategy-resume");
  assert.deepEqual(strategy.executors, ["strategist", "context-scout"]);

  const execution = classifyCanaryStart({
    ...base,
    program: {
      ...base.program,
      phase: "execution",
      masterPlan: { planId: "plan-one", planRevision: 2 },
      workPackages: [
        { workPackageId: "strategy-retry", executorKind: "strategist", state: "completed", jobId: "job-strategy" },
        { workPackageId: "code-fix", executorKind: "code-change", state: "ready", jobId: "" },
        { workPackageId: "operation-repair", executorKind: "operational-transaction", state: "pending", jobId: "" },
      ],
    },
  }, terminalCoordinator, "");
  assert.equal(execution.mode, "execution-resume");
  assert.deepEqual(execution.executors.sort(), ["code-change", "operational-transaction"]);

  assert.throws(() => classifyCanaryStart({
    ...base,
    program: {
      ...base.program,
      phase: "strategy",
      masterPlan: { planId: "partial-plan", planRevision: 2 },
    },
  }, terminalCoordinator, ""), /must resume execution or verification/);
  const { disposableCanaryDecision } = require("./core/job-store");
  assert.equal(disposableCanaryDecision({
    workspace: "C:\\fixture\\disposable",
    directorProgram: { phase: "awaiting-evidence" },
    executorKind: "verification",
    readOnly: true,
  }, "disposable-project", "C:\\fixture\\disposable").allowed, true);
  assert.ok(LIVE_CANARY_EXECUTOR_ALLOWLIST.includes("verification"));
  assert.equal(LIVE_CANARY_EXECUTOR_ALLOWLIST.includes("code-change"), false);
  assert.equal(LIVE_CANARY_EXECUTOR_ALLOWLIST.includes("operational-transaction"), false);
  assert.equal(/^release-canary-/.test(LIVE_CANARY_CAPTURE_SENTINEL), false,
    "the intentional dry-capture sentinel must not trigger policy fail-fast");
  const verifiedSource = {
    relative: ".codex/ACCEPTANCE.json",
    contentHash: "a".repeat(64),
  };
  assert.deepEqual(postExecutionReconciliationBoundary({
    program: {
      phase: "reconciliation",
      workPackages: [{
        workPackageId: "reconcile-verification",
        executorKind: "reconciliation",
        state: "pending",
        acceptanceIds: ["requirement-2"],
        failurePacket: { failureFingerprint: "failure-fingerprint" },
      }],
    },
  }, [{
    jobId: "job-verification",
    contract: {
      executorKind: "verification",
      directorProgram: { phase: "execution" },
      readOnly: true,
      acceptanceIds: ["requirement-2"],
      isolation: { mode: "read-only-snapshot", copied: [verifiedSource] },
    },
    status: { state: "failed" },
    handoff: { state: "failed", blocker: "The authoritative acceptance evidence is still insufficient." },
  }]), {
    reason: "truthful-verification-failure-scheduled-for-reconciliation",
    failedVerificationJobIds: ["job-verification"],
    reconciliationWorkPackageIds: ["reconcile-verification"],
  });
  assert.equal(postExecutionReconciliationBoundary({
    program: {
      phase: "reconciliation",
      workPackages: [{
        workPackageId: "reconcile-empty-scratch",
        executorKind: "reconciliation",
        state: "pending",
        acceptanceIds: ["requirement-2"],
        failurePacket: { failureFingerprint: "failure-fingerprint" },
      }],
    },
  }, [{
    jobId: "job-empty-scratch",
    contract: {
      executorKind: "verification",
      directorProgram: { phase: "awaiting-evidence" },
      readOnly: true,
      acceptanceIds: ["requirement-2"],
      isolation: { mode: "read-only-snapshot", copied: [] },
    },
    status: { state: "failed" },
    handoff: { state: "failed", blocker: "The workspace was empty." },
  }]), null);
  assert.equal(executionBoundarySatisfied([], {
    reason: "truthful-verification-failure-scheduled-for-reconciliation",
  }), true);
  assert.equal(executionBoundarySatisfied([], null), false);

  const verifiedRenewals = verifySupervisorRenewals({
    supervisorEpoch: 1,
    recoveryAdmissionHistory: [],
  }, {
    supervisorEpoch: 3,
    recoveryAdmissionHistory: [{ admissionKey: "admission-one" }],
    renewalHistory: [{
      priorSupervisorEpoch: 1,
      recoveryAdmissionKey: "",
      priorRecoveryFence: {
        fingerprint: "old-fingerprint",
        missionId: "mission-one",
        missionRevision: 2,
        runtimeBuildFingerprint: "old-runtime",
      },
      recoveryFence: {
        fingerprint: "new-fingerprint",
        missionId: "mission-one",
        missionRevision: 3,
        runtimeBuildFingerprint: "new-runtime",
      },
    }, {
      priorSupervisorEpoch: 2,
      recoveryAdmissionKey: "admission-one",
    }],
  }, 1);
  assert.deepEqual(verifiedRenewals, { epochIncrease: 2, recoveryRenewals: 1, contractRenewals: 1 });
  assert.deepEqual(verifySupervisorRenewals({
    supervisorEpoch: 1,
    recoveryAdmissionHistory: [],
  }, {
    supervisorEpoch: 2,
    recoveryAdmissionHistory: [],
    renewalHistory: [{
      priorSupervisorEpoch: 1,
      recoveryAdmissionKey: "",
      priorRecoveryFence: {
        fingerprint: "old-fingerprint",
        missionId: "mission-one",
        missionRevision: 2,
        runtimeBuildFingerprint: "old-runtime",
      },
      recoveryFence: {
        fingerprint: "new-fingerprint",
        missionId: "mission-one",
        missionRevision: 3,
        runtimeBuildFingerprint: "new-runtime",
      },
    }],
  }, [0, 1]), { epochIncrease: 1, recoveryRenewals: 0, contractRenewals: 1 });
  assert.throws(() => verifySupervisorRenewals({
    supervisorEpoch: 1,
    recoveryAdmissionHistory: [],
  }, {
    supervisorEpoch: 3,
    recoveryAdmissionHistory: [{ admissionKey: "admission-one" }, { admissionKey: "admission-two" }],
    renewalHistory: [
      { priorSupervisorEpoch: 1, recoveryAdmissionKey: "admission-one" },
      { priorSupervisorEpoch: 2, recoveryAdmissionKey: "admission-two" },
    ],
  }, 1), /unexpected number of protected recovery epochs/);
  assert.deepEqual(safeExternalDeferralBoundary({
    program: {
      runtime: {
        budget: {
          deferred: [{
            workPackageId: "external-one",
            reasons: ["permission-not-authorized:external-write", "permission-unavailable:external-write"],
          }],
        },
      },
      workPackages: [{
        workPackageId: "external-one",
        executorKind: "operational-transaction",
        state: "pending",
        acceptanceIds: ["REQ-EXTERNAL"],
      }],
    },
  }, []), { reason: "external-write-unavailable", workPackageIds: ["external-one"] });
  assert.equal(safeExternalDeferralBoundary({
    program: {
      runtime: { budget: { deferred: [{ workPackageId: "ordinary", reasons: ["no-provider-candidate"] }] } },
      workPackages: [{ workPackageId: "ordinary", executorKind: "code-change", state: "pending", acceptanceIds: ["REQ-CODE"] }],
    },
  }, []), null);

  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ai-mobile-canary-policy-"));
  try {
    const sourceWorkspace = path.join(fixtureRoot, "source");
    const cloneRoot = path.join(fixtureRoot, "clone");
    fs.mkdirSync(sourceWorkspace, { recursive: true });
    fs.mkdirSync(cloneRoot, { recursive: true });
    const noDatabaseJobs = path.join(cloneRoot, "tasks", "task-no-database", "jobs");
    fs.mkdirSync(noDatabaseJobs, { recursive: true });
    assert.deepEqual(databaseIntegrationProof({
      taskId: "task-no-database",
      program: {
        sourceCatalog: { sources: [{ id: "project-outcome", type: "project-outcome", required: true }] },
        contextDossier: { sourceObservations: [{ sourceId: "project-outcome", status: "observed" }] },
      },
    }, cloneRoot, new Set(), false), { mode: "no-database-source-declared", sources: [] });
    fs.writeFileSync(path.join(sourceWorkspace, "tracked.txt"), "source-state\n", "utf8");
    const databasePath = path.join(sourceWorkspace, "runtime.db");
    const database = new DatabaseSync(databasePath);
    database.exec("CREATE TABLE evidence (id INTEGER PRIMARY KEY, value TEXT NOT NULL); INSERT INTO evidence(value) VALUES ('accepted');");
    database.close();
    const git = (args) => {
      const result = spawnSync("git", args, { cwd: sourceWorkspace, encoding: "utf8", windowsHide: true });
      assert.equal(result.status, 0, result.stderr || result.stdout);
    };
    git(["init"]);
    git(["config", "user.email", "canary@example.invalid"]);
    git(["config", "user.name", "Canary Fixture"]);
    git(["add", "tracked.txt"]);
    git(["commit", "-m", "fixture"]);
    const disposableWorkspace = await cloneProjectWorkspace({
      workspace: sourceWorkspace,
      program: {
        sourceCatalog: {
          sources: [
            { id: "git", type: "git", locator: "." },
            { id: "tracked", type: "file", locator: "tracked.txt" },
            { id: "database", type: "database", locator: "runtime.db" },
          ],
        },
      },
    }, cloneRoot);
    assert.notEqual(disposableWorkspace, sourceWorkspace);
    assert.equal(fs.readFileSync(path.join(disposableWorkspace, "tracked.txt"), "utf8"), "source-state\n");
    const clonedDatabase = new DatabaseSync(path.join(disposableWorkspace, "runtime.db"), { readOnly: true });
    assert.equal(clonedDatabase.prepare("SELECT value FROM evidence").get().value, "accepted");
    clonedDatabase.close();
    const previousPolicy = process.env.AI_MOBILE_CANARY_POLICY;
    const previousRoot = process.env.AI_MOBILE_CANARY_WORKSPACE_ROOT;
    process.env.AI_MOBILE_CANARY_POLICY = "disposable-project";
    process.env.AI_MOBILE_CANARY_WORKSPACE_ROOT = disposableWorkspace;
    let operationWorkspace;
    let codeWorkspace;
    try {
      codeWorkspace = prepareWorkspaceForContract({
        workspace: disposableWorkspace,
        directorProgram: { phase: "execution", workPackageId: "code-fix" },
        executorKind: "code-change",
        deliverableKind: "patch",
        readOnly: false,
        mutatesExternalState: false,
        expectedFiles: ["tracked.txt"],
        verificationCommands: [{ command: "git", args: ["diff", "--check"], timeoutSeconds: 30 }],
      }, "task-code-canary", "job-code-canary", {
        worktreeDiskQuotaMb: 64,
        worktreeMinFreeMb: 1,
        worktreeMaxAgeHours: 1,
      });
      operationWorkspace = prepareWorkspaceForContract({
        workspace: disposableWorkspace,
        directorProgram: { phase: "execution", workPackageId: "operation-repair" },
        executorKind: "operational-transaction",
        deliverableKind: "operation-receipt",
        readOnly: false,
        mutatesExternalState: false,
      }, "task-operation-canary", "job-operation-canary", {
        worktreeDiskQuotaMb: 64,
        worktreeMinFreeMb: 1,
        worktreeMaxAgeHours: 1,
      });
    } finally {
      if (previousPolicy == null) delete process.env.AI_MOBILE_CANARY_POLICY;
      else process.env.AI_MOBILE_CANARY_POLICY = previousPolicy;
      if (previousRoot == null) delete process.env.AI_MOBILE_CANARY_WORKSPACE_ROOT;
      else process.env.AI_MOBILE_CANARY_WORKSPACE_ROOT = previousRoot;
    }
    assert.equal(codeWorkspace.mode, "isolated-git-worktree");
    assert.notEqual(codeWorkspace.executionWorkspace, disposableWorkspace,
      "canary code changes must retain normal isolated-patch integration semantics");
    assert.equal(cleanupIsolatedWorkspace(codeWorkspace).cleaned, true);
    assert.equal(operationWorkspace.mode, "disposable-canary-project");
    assert.equal(operationWorkspace.executionWorkspace, disposableWorkspace);
    const sandboxDatabase = new DatabaseSync(path.join(operationWorkspace.executionWorkspace, "runtime.db"));
    sandboxDatabase.exec("INSERT INTO evidence(value) VALUES ('sandbox-only')");
    sandboxDatabase.close();
    const sourceDatabase = new DatabaseSync(databasePath, { readOnly: true });
    assert.equal(sourceDatabase.prepare("SELECT COUNT(*) AS count FROM evidence").get().count, 1);
    sourceDatabase.close();
    fs.writeFileSync(path.join(disposableWorkspace, "tracked.txt"), "sandbox-change\n", "utf8");
    assert.equal(fs.readFileSync(path.join(sourceWorkspace, "tracked.txt"), "utf8"), "source-state\n");
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }

  process.stdout.write(JSON.stringify({
    ok: true,
    strategyResumeAccepted: true,
    executionResumeAccepted: true,
    planSelectedExecutorsAreNotFrozenToBootstrap: true,
    disposableProjectClonePreservesProduction: true,
    localOperationExecutesOnlyInDisposableClone: true,
    codeChangeUsesIsolatedWorktree: true,
    sqliteSandboxSnapshotVerified: true,
    supervisorRenewalTypesVerified: true,
    projectsWithoutDatabasesAccepted: true,
    unavailableExternalWriteBoundaryVerified: true,
    awaitingEvidenceVerificationAllowed: true,
    postExecutionReconciliationVerified: true,
    liveCanaryMutationWorkersDenied: true,
    dryCaptureSentinelDoesNotFailFast: true,
    truthfulRecoveryBoundaryAcceptedWithoutFakeSuccess: true,
  }) + "\n");
}

main().catch((error) => {
  process.stderr.write((error.stack || error.message) + "\n");
  process.exitCode = 1;
});
