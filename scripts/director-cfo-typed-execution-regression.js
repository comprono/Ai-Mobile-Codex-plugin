#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-mobile-typed-execution-"));
const workspace = path.join(root, "workspace");
process.env.AI_MOBILE_DATA_ROOT = path.join(root, "state");
fs.mkdirSync(workspace, { recursive: true });
fs.writeFileSync(path.join(workspace, "seed.txt"), "seed\n", "utf8");

function run(command, args, cwd = workspace) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stderr || result.stdout || result.error?.message);
}

run("git", ["init"]);
run("git", ["config", "user.email", "typed-execution@example.invalid"]);
run("git", ["config", "user.name", "Typed Execution Regression"]);
run("git", ["add", "seed.txt"]);
run("git", ["commit", "-m", "fixture"]);

const fake = path.join(root, "fake-claude.js");
fs.writeFileSync(fake, [
  '"use strict";',
  'const artifact = JSON.parse(process.env.AI_MOBILE_TYPED_ARTIFACT || "{}");',
  'process.stdout.write(JSON.stringify({ structured_output: artifact, model: "fixture-model", usage: { input_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 40 } }));',
].join("\n"), "utf8");
let providerCommand;
if (process.platform === "win32") {
  providerCommand = path.join(root, "fake-claude.cmd");
  fs.writeFileSync(providerCommand, `@echo off\r\n"${process.execPath}" "${fake}"\r\n`, "utf8");
} else {
  providerCommand = path.join(root, "fake-claude");
  fs.writeFileSync(providerCommand, `#!/bin/sh\n"${process.execPath}" "${fake}"\n`, "utf8");
  fs.chmodSync(providerCommand, 0o755);
}

const { jobDirectory } = require("./core/state-store");
const { createDirectorWorkerContract } = require("./core/director-worker-contract");
const { readJson, writeJson } = require("./core/utils");
const {
  executeWorker,
  promptFor,
  runtimeAuthorizationBlocker,
  structuredArtifact,
} = require("./core/worker");
const {
  buildAntigravityArgs,
  buildClaudeArgs,
  claudeResultSchema,
  providerExecutionAccess,
} = require("./providers");
const {
  promptContractFor,
  validateTypedDeliverable,
} = require("./core/typed-deliverables");
const { preservedVerificationRecovery } = require("./core/patch-integration");
const { __test: verificationTest } = require("./core/verification");

const typedKinds = [
  "context-dossier",
  "master-plan",
  "reconciliation-decision",
  "operation-receipt",
  "browser-receipt",
  "external-transaction-receipt",
  "monitoring-evidence",
  "verification-result",
  "patch",
];

const base = {
  taskId: "task-typed-regression",
  workspace,
  executionWorkspace: workspace,
  provider: "claude",
  providerCommand,
  model: "fixture-model",
  timeoutSeconds: 20,
  maxWorkerOutputTokens: 1000,
  estimatedDirectTokens: 4000,
  maxApiBudgetUsd: 0,
  projectGoal: "Prove typed execution",
  currentCodexGoal: "Report material transitions",
  goal: "Execute one bounded typed package",
  independenceReason: "The package has isolated ownership.",
  relevantFiles: ["seed.txt"],
  expectedFiles: [],
  acceptanceCriteria: ["Return the exact typed deliverable."],
  verificationCommands: [],
  requiredCapabilities: ["source", "local-files"],
  communicationMode: "smart-compact",
};

try {
  for (const kind of typedKinds) {
    const contract = { ...base, executorKind: kind === "patch" ? "code-change" : undefined, deliverableKind: kind, readOnly: kind !== "patch" };
    assert.match(promptFor(contract), new RegExp(`Required deliverable: ${kind}`));
    if (kind !== "patch") assert.match(promptFor(contract), /never call write_file, create_file, edit, patch, apply_patch/);
    if (kind !== "patch") {
      const fenced = "prefix\n" + "```json\n" + JSON.stringify({ kind, summary: "ok" }) + "\n```";
      assert.deepEqual(structuredArtifact(contract, { text: fenced }), { kind, summary: "ok" });
    }
  }

  const operation = {
    ...base,
    executorKind: "operational-transaction",
    deliverableKind: "operation-receipt",
    readOnly: false,
    commands: [{ name: "apply", command: "fixture", args: [], timeoutSeconds: 10 }],
    sideEffectKey: "operation:fixture:1",
  };
  assert.match(runtimeAuthorizationBlocker(operation), /run-command/);
  assert.equal(providerExecutionAccess({ ...operation, permissionGrant: ["run-command"] }).commandToolsEnabled, false);
  const authorizedOperationBasis = {
    ...operation,
    workPackageId: "wp-typed-operation",
    requiredPermissions: ["run-command"],
    permissionGrant: ["run-command"],
    permissionPreflight: { ok: true, checkedAt: "fixture" },
    preconditions: [],
    postconditions: [],
    rollback: { available: true },
    recoveryAction: "Reconcile before retrying.",
    observedStateFingerprint: "typed-before",
    directorProviderAuthorization: true,
    directorEffectAuthorization: true,
    directorProgram: { workPackageId: "wp-typed-operation" },
    allocation: {
      allocationId: "allocation-typed-operation",
      candidateId: "claude:fixture-model",
      workPackageId: "wp-typed-operation",
      provider: "claude",
      model: "fixture-model",
      tokenLimit: 4000,
      durationLimitMs: 20000,
      maxAttempts: 1,
    },
  };
  const authorizedOperation = {
    ...authorizedOperationBasis,
    directorWorkerContract: createDirectorWorkerContract(authorizedOperationBasis),
  };
  assert.equal(runtimeAuthorizationBlocker(authorizedOperation), "");
  assert.equal(providerExecutionAccess(authorizedOperation).commandToolsEnabled, true);

  const deniedTools = buildClaudeArgs(operation, "fixture");
  assert.equal(deniedTools[deniedTools.indexOf("--tools") + 1].includes("Bash"), false);
  assert.equal(deniedTools[deniedTools.indexOf("--permission-mode") + 1], "plan");
  const allowedTools = buildClaudeArgs(authorizedOperation, "fixture");
  assert.equal(allowedTools[allowedTools.indexOf("--tools") + 1].includes("Bash"), true);
  assert.equal(allowedTools[allowedTools.indexOf("--permission-mode") + 1], "acceptEdits");
  assert.equal(buildAntigravityArgs(operation, "fixture").includes("--dangerously-skip-permissions"), false);
  assert.equal(buildAntigravityArgs(authorizedOperation, "fixture").includes("--dangerously-skip-permissions"), true);

  const authorizedPatchBasis = {
    ...authorizedOperationBasis,
    executorKind: "code-change",
    deliverableKind: "patch",
    commands: [],
    expectedFiles: ["seed.txt"],
    requiredCapabilities: ["source", "local-files", "tests", "command"],
    requiredPermissions: ["write-files", "run-command", "run-tests"],
    permissionGrant: ["write-files", "run-command", "run-tests"],
    permissionPreflight: {
      ok: true,
      blocker: "",
      missingCapabilities: [],
      missingAuthorization: [],
      missingGrant: [],
      missingProviderPermissions: [],
      invalidSideEffectContract: [],
      requiredCapabilities: ["source", "local-files", "tests", "command"],
      requiredPermissions: ["write-files", "run-command", "run-tests"],
      permissionGrant: ["write-files", "run-command", "run-tests"],
    },
    directorEffectAuthorization: false,
  };
  const authorizedPatch = {
    ...authorizedPatchBasis,
    directorWorkerContract: createDirectorWorkerContract(authorizedPatchBasis),
  };
  assert.equal(providerExecutionAccess(authorizedPatch).patchWriteEnabled, true);
  assert.equal(buildAntigravityArgs(authorizedPatch, "fixture").includes("--dangerously-skip-permissions"), true);
  assert.equal(buildAntigravityArgs({ ...authorizedPatch, directorWorkerContract: null }, "fixture").includes("--dangerously-skip-permissions"), false);

  assert.match(runtimeAuthorizationBlocker({
    ...base,
    executorKind: "browser-action",
    deliverableKind: "browser-receipt",
    mutatesExternalState: true,
    permissionGrant: ["browser"],
    permissionPreflight: { ok: true },
  }), /external-write/);
  assert.match(runtimeAuthorizationBlocker({
    ...base,
    executorKind: "browser-action",
    deliverableKind: "browser-receipt",
    mutatesExternalState: true,
    permissionGrant: ["browser", "external-write"],
    permissionPreflight: { ok: true },
  }), /userAuthorizationRef/);
  assert.match(runtimeAuthorizationBlocker({
    ...base,
    executorKind: "external-transaction",
    deliverableKind: "external-transaction-receipt",
    permissionGrant: ["external-write"],
    permissionPreflight: { ok: true },
  }), /userAuthorizationRef/);

  const receiptSchema = JSON.parse(claudeResultSchema(authorizedOperation));
  assert.deepEqual(receiptSchema.properties.kind.enum, ["operation-receipt"]);
  assert.ok(receiptSchema.required.includes("postconditions"));
  const masterSchema = JSON.parse(claudeResultSchema({ ...base, executorKind: "strategist", deliverableKind: "master-plan" }));
  assert.ok(masterSchema.required.includes("resourceEstimates"));

  const receipt = {
    kind: "operation-receipt",
    state: "applied",
    sideEffectKey: authorizedOperation.sideEffectKey,
    observedStateFingerprintBefore: "before-fixture",
    observedStateFingerprintAfter: "after-fixture",
    userAuthorizationRef: "",
    idempotency: { checked: true, duplicate: false, key: authorizedOperation.sideEffectKey, evidence: "No prior receipt exists." },
    preconditions: [{ name: "target", passed: true, evidence: "Fixture target exists." }],
    actions: [{ name: "apply", passed: true, evidence: "Fixture operation ran." }],
    postconditions: [{ name: "state", passed: true, evidence: "Authoritative fixture state changed." }],
    rollback: { available: true, executed: false, evidence: "Fixture rollback is available." },
    evidence: ["Authoritative fixture receipt."],
    acceptanceEvidence: [{ requirementId: "REQ-TYPED", level: "integration", ref: "fixture", summary: "Operation observed.", passed: true }],
    blocker: "",
  };
  process.env.AI_MOBILE_TYPED_ARTIFACT = JSON.stringify(receipt);
  const receiptJob = "job-receipt1";
  fs.mkdirSync(jobDirectory(base.taskId, receiptJob), { recursive: true });
  writeJson(path.join(jobDirectory(base.taskId, receiptJob), "contract.json"), { ...authorizedOperation, jobId: receiptJob });
  assert.equal(executeWorker({ taskId: base.taskId, jobId: receiptJob }), 0);
  const receiptHandoff = readJson(path.join(jobDirectory(base.taskId, receiptJob), "handoff.json"), {});
  assert.equal(receiptHandoff.state, "completed", receiptHandoff.blocker);
  assert.deepEqual(receiptHandoff.changedFiles, []);
  assert.equal(receiptHandoff.patchAvailable, false);
  assert.equal(receiptHandoff.deliverable.kind, "operation-receipt");
  assert.equal(receiptHandoff.deliverableValidation.ok, true);

  const legacyReceiptContract = {
    ...authorizedOperation,
    preconditions: ["Database available"],
    postconditions: ["Preflight clean"],
    commands: [{
      command: "python",
      args: ["tools/repair_application_plans.py", "--write", "--confirm", "I AUTHORIZE REPAIRING APPLICATION PLAN INTEGRITY"],
    }],
    userAuthorizationRef: "Explicit user authorization",
  };
  const legacyReceipt = {
    schemaVersion: "director-cfo/operation-receipt@1",
    workPackageId: authorizedOperation.workPackageId,
    allocationId: authorizedOperation.allocation.allocationId,
    executorKind: "operational-transaction",
    deliverableKind: "operation-receipt",
    status: "SUCCEEDED",
    preconditions: ["Database available"],
    actions: [{
      command: 'python tools/repair_application_plans.py --write --confirm "I AUTHORIZE REPAIRING APPLICATION PLAN INTEGRITY"',
      exitCode: 0,
      summary: "Integrity repaired.",
    }],
    postconditions: ["Preflight clean"],
    authoritativeEvidence: {
      preflightVerification: { exitCode: 0, safeToStart: true },
      repairSummary: { beforeIntegrityIssues: 580, afterIntegrityIssues: 0 },
    },
    idempotencyState: {
      sideEffectKey: authorizedOperation.sideEffectKey,
      observedStateFingerprint: authorizedOperation.observedStateFingerprint,
      executed: true,
    },
    rollbackOrRecovery: { backupPath: "fixture-backup.db" },
    acceptanceEvidence: { "REQ-TYPED": { satisfied: true } },
    blocker: null,
  };
  const passedVerification = {
    required: true,
    state: "passed",
    passed: true,
    checks: [{ name: "preflight", command: "python", args: ["tools/startup_preflight.py", "--json"], expectedExitCode: 0, exitCode: 0, passed: true }],
  };
  const legacyValidation = validateTypedDeliverable(legacyReceiptContract, {
    artifact: legacyReceipt,
    verification: passedVerification,
  });
  assert.equal(legacyValidation.ok, true, legacyValidation.blocker);
  assert.equal(legacyValidation.deliverable.state, "applied");
  assert.equal(legacyValidation.deliverable.sideEffectKey, authorizedOperation.sideEffectKey);
  assert.equal(legacyValidation.deliverable.acceptanceEvidence.length, 0);
  assert.ok(legacyValidation.deliverable.observedStateFingerprintAfter);
  const mismatchedLegacyValidation = validateTypedDeliverable(legacyReceiptContract, {
    artifact: {
      ...legacyReceipt,
      idempotencyState: { ...legacyReceipt.idempotencyState, sideEffectKey: "wrong-key" },
    },
    verification: passedVerification,
  });
  assert.equal(mismatchedLegacyValidation.ok, false);
  const unverifiedLegacyValidation = validateTypedDeliverable(legacyReceiptContract, {
    artifact: legacyReceipt,
    verification: { ...passedVerification, passed: false, state: "failed" },
  });
  assert.equal(unverifiedLegacyValidation.ok, false);
  assert.match(promptContractFor(legacyReceiptContract), /observedStateFingerprintBefore/);
  assert.match(promptContractFor(legacyReceiptContract), /idempotency \{ checked, duplicate, key, evidence \}/);

  const pytestFallback = verificationTest.fallbackInvocation({
    command: "pytest",
    args: ["Jobs Harness/test_verified_answer_form_resolution.py"],
  }, { error: { code: "ENOENT" } });
  assert.deepEqual(pytestFallback.args, ["-m", "pytest", "Jobs Harness/test_verified_answer_form_resolution.py"]);
  assert.equal(preservedVerificationRecovery(
    { state: "failed", exitCode: 0, blocker: "Verification failed: verification-1" },
    { state: "failed", patchAvailable: true, changedFiles: ["seed.txt"] },
    { checks: [{ passed: false, stderr: "spawnSync pytest ENOENT" }] },
    { preservedVerificationRecovery: { priorRuntimeFingerprint: "before", repairedRuntimeFingerprint: "after", evidence: ["verified adapter repair"] } },
  ).repairedRuntimeFingerprint, "after");
  assert.equal(preservedVerificationRecovery(
    { state: "failed", exitCode: 0, blocker: "Verification failed: verification-1" },
    { state: "failed", patchAvailable: true, changedFiles: ["seed.txt"] },
    { checks: [{ passed: false, stderr: "test assertions failed" }] },
    { preservedVerificationRecovery: { priorRuntimeFingerprint: "before", repairedRuntimeFingerprint: "after", evidence: ["irrelevant"] } },
  ), null);

  process.env.AI_MOBILE_TYPED_ARTIFACT = JSON.stringify({ outcome: "No files changed.", evidence: [], checks: [], blocker: "", blockerOwner: "", recoveryTrigger: "", recoveryAction: "", proposedWorkUnits: [] });
  const patchJob = "job-patch000";
  fs.mkdirSync(jobDirectory(base.taskId, patchJob), { recursive: true });
  writeJson(path.join(jobDirectory(base.taskId, patchJob), "contract.json"), {
    ...base,
    jobId: patchJob,
    executorKind: "code-change",
    deliverableKind: "patch",
    readOnly: false,
    expectedFiles: ["seed.txt"],
  });
  assert.equal(executeWorker({ taskId: base.taskId, jobId: patchJob }), 1);
  const patchHandoff = readJson(path.join(jobDirectory(base.taskId, patchJob), "handoff.json"), {});
  assert.match(patchHandoff.blocker, /no-patch-produced/);

  process.stdout.write(JSON.stringify({
    ok: true,
    typedKinds,
    structuredArtifactsParsed: true,
    strictLegacyOperationReceiptAdopted: true,
    operationReceiptWithoutPatchAccepted: true,
    patchWithoutChangesRejected: true,
    commandToolsRequireGrantAndPreflight: true,
    browserAndExternalMutationsFailClosed: true,
  }, null, 2) + "\n");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
