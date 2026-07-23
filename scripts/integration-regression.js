#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-mobile-integration-"));
process.env.AI_MOBILE_DATA_ROOT = path.join(root, "state");
process.env.LOCALAPPDATA = path.join(root, "local");
const workspace = path.join(root, "workspace");
fs.mkdirSync(path.join(workspace, "src"), { recursive: true });
fs.mkdirSync(path.join(workspace, "scripts"), { recursive: true });

function git(args) {
  const result = spawnSync("git", ["-C", workspace, ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout;
}

function patch(fromValue, toValue) {
  return [
    "diff --git a/src/value.txt b/src/value.txt",
    "index 3367afd..3e75765 100644",
    "--- a/src/value.txt",
    "+++ b/src/value.txt",
    "@@ -1 +1 @@",
    "-" + fromValue,
    "+" + toValue,
    "",
  ].join(String.fromCharCode(10));
}

try {
  fs.writeFileSync(path.join(workspace, "src", "value.txt"), "old" + String.fromCharCode(10), "utf8");
  fs.writeFileSync(path.join(workspace, "scripts", "verify.js"), [
    '"use strict";',
    'const fs = require("node:fs");',
    'const expected = process.env.EXPECT_VALUE || "new";',
    'const actual = fs.readFileSync("src/value.txt", "utf8").trim();',
    'if (actual !== expected) process.exit(1);',
  ].join(String.fromCharCode(10)), "utf8");
  git(["init"]);
  git(["add", "."]);
  git(["-c", "user.name=AI Mobile Test", "-c", "user.email=test@example.invalid", "commit", "-m", "fixture"]);

  const { startTask } = require("./core/task-orchestrator");
  const { integrateJob } = require("./core/patch-integration");
  const { jobDirectory } = require("./core/state-store");
  const { writeJson } = require("./core/utils");
  const resources = { generatedAt: new Date().toISOString(), providers: {} };
  const task = startTask({ workspace, outcome: "Integrate a verified patch", acceptanceEvidence: [{ description: "The patch passes integration verification", minimumEvidenceLevel: "integration" }] }, resources);

  function fixtureJob(jobId, patchText, verificationCommands) {
    const dir = jobDirectory(task.taskId, jobId);
    fs.mkdirSync(dir, { recursive: true });
    writeJson(path.join(dir, "status.json"), { taskId: task.taskId, jobId, state: "completed" });
    writeJson(path.join(dir, "contract.json"), {
      workspace,
      readOnly: false,
      skipModelReview: false,
      expectedFiles: ["src/value.txt"],
      verificationCommands,
    });
    writeJson(path.join(dir, "changed-files.json"), ["src/value.txt"]);
    fs.writeFileSync(path.join(dir, "worker.diff"), patchText, "utf8");
    return dir;
  }

  fixtureJob("job-integration-0001", patch("old", "new"), [{ name: "verify-value", command: "node", args: ["scripts/verify.js"] }]);
  const first = integrateJob(task.taskId, "job-integration-0001");
  assert.equal(first.integrated, true, JSON.stringify(first));
  assert.equal(fs.readFileSync(path.join(workspace, "src", "value.txt"), "utf8").trim(), "new");
  const repeated = integrateJob(task.taskId, "job-integration-0001");
  assert.equal(repeated.alreadyIntegrated, true);

  git(["add", "."]);
  git(["-c", "user.name=AI Mobile Test", "-c", "user.email=test@example.invalid", "commit", "-m", "integrated"]);
  fixtureJob("job-integration-0002", patch("new", "third"), [{ name: "verify-value", command: "node", args: ["scripts/verify.js"] }]);
  fs.writeFileSync(path.join(workspace, "src", "value.txt"), "user-change" + String.fromCharCode(10), "utf8");
  const conflict = integrateJob(task.taskId, "job-integration-0002");
  assert.equal(conflict.integrated, false);
  assert.equal(conflict.blocker, "primary-files-changed-since-dispatch");
  assert.equal(fs.readFileSync(path.join(workspace, "src", "value.txt"), "utf8").trim(), "user-change");
  git(["restore", "src/value.txt"]);

  fixtureJob("job-integration-0003", patch("new", "unverified"), []);
  const unverified = integrateJob(task.taskId, "job-integration-0003");
  assert.equal(unverified.integrated, false);
  assert.equal(unverified.blocker, "deterministic-verification-required-before-primary-integration");
  assert.equal(fs.readFileSync(path.join(workspace, "src", "value.txt"), "utf8").trim(), "new");

  process.env.EXPECT_VALUE = "stale";
  fixtureJob("job-integration-0004", patch("new", "stale"), [{ name: "verify-value", command: "node", args: ["scripts/verify.js"] }]);
  let finalizeCalled = false;
  const staleFinalization = integrateJob(task.taskId, "job-integration-0004", {
    finalize(candidate) {
      finalizeCalled = true;
      assert.equal(candidate.verification.passed, true);
      throw new Error("stale Director revision fence");
    },
  });
  delete process.env.EXPECT_VALUE;
  assert.equal(finalizeCalled, true);
  assert.equal(staleFinalization.integrated, false);
  assert.match(staleFinalization.blocker, /integration-finalization-failed.*stale Director revision fence/);
  assert.equal(staleFinalization.rollback.rolledBack, true);
  assert.equal(fs.readFileSync(path.join(workspace, "src", "value.txt"), "utf8").trim(), "new");

  fixtureJob("job-integration-0005", patch("new", "blocked"), [{ name: "verify-value", command: "node", args: ["scripts/verify.js"] }]);
  const stalePrecondition = integrateJob(task.taskId, "job-integration-0005", {
    beforeApply() { throw new Error("work package was superseded"); },
  });
  assert.equal(stalePrecondition.integrated, false);
  assert.match(stalePrecondition.blocker, /integration-precondition-failed.*superseded/);
  assert.equal(fs.readFileSync(path.join(workspace, "src", "value.txt"), "utf8").trim(), "new");

  process.env.EXPECT_VALUE = "tampered";
  fixtureJob("job-integration-0006", patch("new", "tampered"), [{ name: "verify-value", command: "node", args: ["scripts/verify.js"] }]);
  const incompleteRollback = integrateJob(task.taskId, "job-integration-0006", {
    finalize() {
      fs.writeFileSync(path.join(workspace, "src", "value.txt"), "manual-race\n", "utf8");
      throw new Error("stale result after concurrent file change");
    },
  });
  delete process.env.EXPECT_VALUE;
  assert.equal(incompleteRollback.integrated, false);
  assert.match(incompleteRollback.blocker, /rollback-incomplete/);
  assert.equal(incompleteRollback.rollback.rolledBack, false);
  assert.match(incompleteRollback.recoveryAction, /Stop automatic integration/);
  git(["restore", "src/value.txt"]);

  process.stdout.write(JSON.stringify({
    ok: true,
    patchAppliedOnce: true,
    deterministicVerificationPassed: true,
    userChangeProtected: true,
    unverifiedPatchRefused: true,
    stalePreconditionRefused: true,
    staleFinalizationRolledBack: true,
    incompleteRollbackFailsClosed: true,
  }, null, 2) + String.fromCharCode(10));
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
