#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");
const { classifyCanaryStart, cloneProjectWorkspace } = require("./live-state-release-canary");
const { prepareWorkspaceForContract } = require("./core/workspace-isolation");

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

  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ai-mobile-canary-policy-"));
  try {
    const sourceWorkspace = path.join(fixtureRoot, "source");
    const cloneRoot = path.join(fixtureRoot, "clone");
    fs.mkdirSync(sourceWorkspace, { recursive: true });
    fs.mkdirSync(cloneRoot, { recursive: true });
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
    try {
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
    sqliteSandboxSnapshotVerified: true,
  }) + "\n");
}

main().catch((error) => {
  process.stderr.write((error.stack || error.message) + "\n");
  process.exitCode = 1;
});
