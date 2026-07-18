"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-mobile-trusted-"));
const workspace = path.join(root, "repo");
process.env.AI_MOBILE_DATA_ROOT = path.join(root, "state");
process.env.LOCALAPPDATA = path.join(root, "local");
fs.mkdirSync(path.join(workspace, "src"), { recursive: true });
fs.writeFileSync(path.join(workspace, "src", "trusted.txt"), "base\n");
const fakeBin = path.join(workspace, ".test-bin");
fs.mkdirSync(fakeBin, { recursive: true });
fs.writeFileSync(path.join(fakeBin, "fake-claude.js"), `"use strict";
const fs = require("node:fs");
const path = require("node:path");
fs.writeFileSync(path.join(process.cwd(), "src", "trusted.txt"), "trusted model changed primary\\n");
process.stdout.write(JSON.stringify({
  is_error: false,
  structured_output: { outcome: "Changed the bounded primary file.", evidence: ["src/trusted.txt"], checks: ["verification delegated to deterministic runner"], blocker: "" },
  usage: { input_tokens: 40, output_tokens: 20 },
  modelUsage: { "claude-fable-5": { inputTokens: 40, outputTokens: 20, costUSD: 0 } }
}));
`);
fs.writeFileSync(path.join(fakeBin, "fake-claude.cmd"), `@echo off\r\n"${process.execPath}" "%~dp0fake-claude.js" %*\r\n`);
fs.writeFileSync(path.join(fakeBin, "fake-claude-fail.js"), `"use strict";
const fs = require("node:fs");
const path = require("node:path");
fs.writeFileSync(path.join(process.cwd(), "src", "trusted.txt"), "invalid direct edit\\n");
process.stdout.write(JSON.stringify({
  is_error: false,
  structured_output: { outcome: "Changed the bounded primary file.", evidence: ["src/trusted.txt"], checks: [], blocker: "" },
  usage: { input_tokens: 20, output_tokens: 10 },
  modelUsage: { "claude-fable-5": { inputTokens: 20, outputTokens: 10, costUSD: 0 } }
}));
`);
fs.writeFileSync(path.join(fakeBin, "fake-claude-fail.cmd"), `@echo off\r\n"${process.execPath}" "%~dp0fake-claude-fail.js" %*\r\n`);
fs.writeFileSync(path.join(workspace, "verify-trusted.js"), `"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
assert.equal(fs.readFileSync("src/trusted.txt", "utf8"), "trusted model changed primary\\n");
`);
function git(args) {
  const result = spawnSync("git", args, { cwd: workspace, encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  return result;
}
git(["init", "-q"]);
git(["config", "user.email", "test@example.invalid"]);
git(["config", "user.name", "AI Mobile Test"]);
git(["add", "."]);
git(["commit", "-qm", "fixture"]);

const { normalizeRequestedModel, trustedPrimaryDecision } = require("./core/trusted-models");
const { cleanupIsolatedWorkspace, prepareWorkspaceForContract, rollbackPrimaryWorkspace } = require("./core/workspace-isolation");
const { createRestartHandoff, safeReasoningEffort, safeResumeModel, safeThreadId } = require("./core/restart-handoff");
const { jobDirectory } = require("./core/state-store");
const { readJson, writeJson } = require("./core/utils");
const { executeWorker } = require("./core/worker");

const profile = {
  worktreeDiskQuotaMb: 64,
  worktreeMinFreeMb: 1,
  worktreeMaxAgeHours: 1,
  trustedPrimaryWriteModels: ["claude-fable-5", "claude-sonnet-5"],
};
const verificationCommands = [{ name: "trusted-content", command: "node", args: ["verify-trusted.js"] }];
const contract = {
  workspace,
  provider: "claude",
  model: "Fable 5",
  readOnly: false,
  expectedFiles: ["src/trusted.txt"],
  verificationCommands,
};

assert.equal(normalizeRequestedModel("Fable 5"), "claude-fable-5");
assert.equal(normalizeRequestedModel("Sonnet 5"), "claude-sonnet-5");
assert.equal(trustedPrimaryDecision(contract, profile).trusted, true);
const primary = prepareWorkspaceForContract(contract, "task-trusted-0001", "job-trusted-0001", profile);
assert.equal(primary.mode, "trusted-primary-workspace");
assert.equal(primary.executionWorkspace, workspace);
assert.equal(primary.skipModelReview, true);
assert.equal(fs.existsSync(path.join(process.env.AI_MOBILE_DATA_ROOT, "worktrees")), false);
const taskId = "task-trusted-0001";
const jobId = "job-trusted-0001";
const dir = jobDirectory(taskId, jobId);
fs.mkdirSync(dir, { recursive: true });
writeJson(path.join(dir, "contract.json"), {
  ...contract,
  taskId,
  jobId,
  model: "claude-fable-5",
  providerCommand: path.join(fakeBin, "fake-claude.cmd"),
  providerAuthMode: "subscription",
  projectGoal: "Ship the verified fixture",
  currentCodexGoal: "Verify another disjoint file",
  independenceReason: "The trusted file is independently owned.",
  relevantFiles: ["src/trusted.txt"],
  acceptanceCriteria: ["The trusted file contains the expected result."],
  executionWorkspace: workspace,
  isolation: primary,
  skipModelReview: true,
  maxWorkerOutputTokens: 500,
  timeoutSeconds: 30,
});
assert.equal(executeWorker({ taskId, jobId }), 0);
assert.equal(fs.readFileSync(path.join(workspace, "src", "trusted.txt"), "utf8"), "trusted model changed primary\n");
const workerHandoff = readJson(path.join(dir, "handoff.json"));
assert.equal(workerHandoff.skipModelReview, true);
assert.equal(workerHandoff.alreadyInPrimaryWorkspace, true);
assert.equal(workerHandoff.verification.passed, true);
assert.equal(readJson(path.join(dir, "usage.json")).model, "claude-fable-5");
spawnSync("git", ["-C", workspace, "restore", "src/trusted.txt"]);

assert.equal(trustedPrimaryDecision({ ...contract, model: "sonnet" }, profile).trusted, false);
const generic = prepareWorkspaceForContract({ ...contract, model: "sonnet" }, "task-generic-0001", "job-generic-0001", profile);
assert.equal(generic.mode, "isolated-git-worktree");
cleanupIsolatedWorkspace(generic);

const noChecks = prepareWorkspaceForContract({ ...contract, verificationCommands: [] }, "task-checks-0001", "job-checks-0001", profile);
assert.equal(noChecks.mode, "isolated-git-worktree");
cleanupIsolatedWorkspace(noChecks);
const codexOwned = prepareWorkspaceForContract({ ...contract, currentCodexFiles: ["src/current-codex.js"] }, "task-codex-owner-0001", "job-codex-owner-0001", profile);
assert.equal(codexOwned.mode, "isolated-git-worktree");
cleanupIsolatedWorkspace(codexOwned);


fs.writeFileSync(path.join(workspace, "src", "trusted.txt"), "existing owner\n");
assert.throws(() => prepareWorkspaceForContract(contract, "task-dirty-0001", "job-dirty-0001", profile), /completely clean repository/);
spawnSync("git", ["-C", workspace, "restore", "src/trusted.txt"]);


const failedPrimary = prepareWorkspaceForContract(contract, "task-failed-0001", "job-failed-0001", profile);
const failedTaskId = "task-failed-0001";
const failedJobId = "job-failed-0001";
const failedDir = jobDirectory(failedTaskId, failedJobId);
fs.mkdirSync(failedDir, { recursive: true });
writeJson(path.join(failedDir, "contract.json"), {
  ...contract,
  taskId: failedTaskId,
  jobId: failedJobId,
  model: "claude-fable-5",
  providerCommand: path.join(fakeBin, "fake-claude-fail.cmd"),
  providerAuthMode: "subscription",
  projectGoal: "Reject an invalid direct edit",
  currentCodexGoal: "Work on a disjoint file",
  independenceReason: "The trusted file is independently owned.",
  relevantFiles: ["src/trusted.txt"],
  acceptanceCriteria: ["The deterministic check must pass."],
  executionWorkspace: workspace,
  isolation: failedPrimary,
  skipModelReview: true,
  maxWorkerOutputTokens: 500,
  timeoutSeconds: 30,
});
assert.equal(executeWorker({ taskId: failedTaskId, jobId: failedJobId }), 1);
assert.equal(fs.readFileSync(path.join(workspace, "src", "trusted.txt"), "utf8").replace(/\r\n/g, "\n"), "base\n");
const failedHandoff = readJson(path.join(failedDir, "handoff.json"));
assert.equal(failedHandoff.rollback.rolledBack, true);
assert.match(failedHandoff.blocker, /Verification failed/);
assert.equal(String(spawnSync("git", ["-C", workspace, "status", "--porcelain=v1"], { encoding: "utf8" }).stdout).trim(), "");

const boundedRollback = prepareWorkspaceForContract(contract, "task-bounded-rollback", "job-bounded-rollback", profile);
fs.writeFileSync(path.join(workspace, "src", "trusted.txt"), "owned failure\n");
fs.writeFileSync(path.join(workspace, "verify-trusted.js"), "unrelated concurrent change\n");
const boundedResult = rollbackPrimaryWorkspace(boundedRollback, ["src/trusted.txt", "verify-trusted.js"]);
assert.equal(boundedResult.rolledBack, false);
assert.deepEqual(boundedResult.outsidePaths, ["verify-trusted.js"]);
assert.equal(fs.readFileSync(path.join(workspace, "verify-trusted.js"), "utf8"), "unrelated concurrent change\n");
spawnSync("git", ["-C", workspace, "restore", "src/trusted.txt", "verify-trusted.js"]);
const threadId = "01234567-89ab-cdef-0123-456789abcdef";
assert.equal(safeThreadId(threadId), threadId);
assert.throws(() => safeThreadId("bad"), /valid Codex thread id/);
assert.equal(safeResumeModel("gpt-5.6-luna"), "gpt-5.6-luna");
assert.throws(() => safeResumeModel("gpt-5.6-luna --danger"), /exact safe model id/);
assert.equal(safeReasoningEffort("ultra"), "ultra");
assert.throws(() => safeReasoningEffort("reckless"), /effort is invalid/);
const handoff = createRestartHandoff({
  userAuthorized: true,
  threadId,
  workspace,
  verificationModel: "gpt-5.6-sol",
  verificationEffort: "ultra",
  resumeModel: "gpt-5.6-luna",
  resumeEffort: "low",
  outcome: "Ship the verified fixture",
  latestUserRequest: "Continue without asking me to restate context",
  priorities: ["finish acceptance evidence", "preserve the current task"],
  nextAction: "Run the trusted writer verification",
  cleanupPluginIds: ["ai-mobile@personal"],
});
assert.equal(handoff.schemaVersion, 2);
assert.equal(handoff.oneShot, true);
assert.equal(handoff.restartState, "prepared");
assert.equal(handoff.expectedRuntimeVersion, "1.2.0");
assert.equal(handoff.verificationModel, "gpt-5.6-sol");
assert.equal(handoff.verificationEffort, "ultra");
assert.equal(handoff.resumeModel, "gpt-5.6-luna");
assert.equal(handoff.resumeEffort, "low");
assert.match(handoff.resumePrompt, /Visible console model: gpt-5\.6-luna at low effort/);
assert.match(handoff.resumePrompt, /dispatch the returned dependency-ready work-plane unit/i);
assert.equal(handoff.restartLog.length, 1);
assert.deepEqual(handoff.refreshPluginIds, ["ai-mobile@ai-mobile"]);
assert.equal(fs.existsSync(handoff.file), true);
const dryRun = spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(__dirname, "restart-codex-handoff.ps1"), "-HandoffFile", handoff.file, "-DryRun"], { encoding: "utf8" });
assert.equal(dryRun.status, 0, dryRun.stderr);
const dry = JSON.parse(dryRun.stdout);
assert.equal(dry.OneShot, true);
assert.equal(dry.Recurring, false);
assert.equal(dry.OpensProviderUi, false);
assert.match(dry.ResumeSurface, /app-server same-task continuation/i);
assert.equal(dry.ExpectedRuntimeVersion, "1.2.0");
assert.equal(dry.VerificationModel, "gpt-5.6-sol");
assert.equal(dry.VerificationEffort, "ultra");
assert.equal(dry.RequestedResumeModel, "gpt-5.6-luna");
assert.equal(dry.RequestedResumeEffort, "low");
assert.equal(dry.ModelSwitchVerified, false);
assert.equal(dry.DesktopLaunchBeforeResume, false);
assert.equal(dry.ResumeDetached, false);
assert.equal(dry.DesktopLaunchMethod, "shell:AppsFolder activation plus codex protocol deep link");
assert.match(dry.DesktopAppUserModelId, /!App$/);
assert.match(dry.DesktopAppsFolderTarget, /^shell:AppsFolder\\/i);
assert.equal(dry.ThreadDeepLink, "codex://threads/" + threadId);
assert.match(dry.ResumeHelper, /resume-codex-thread\.ps1$/i);
assert.deepEqual(dry.ResumeArguments, ["--handoff-file", handoff.file]);
assert.equal(dry.PackageName, "OpenAI.Codex");
assert.deepEqual(dry.DesktopArguments, ["--open-project", workspace, "codex://threads/" + threadId]);
if (dry.DesktopResolved) {
  assert.match(dry.DesktopExecutable, /OpenAI\.Codex_/i);
  assert.doesNotMatch(dry.DesktopExecutable, /ChatGPT-Desktop/i);
}
assert.deepEqual(dry.CleanupPluginIds, ["ai-mobile@personal"]);
assert.deepEqual(dry.RefreshPluginIds, ["ai-mobile@ai-mobile"]);

const restartSource = fs.readFileSync(path.join(__dirname, "restart-codex-handoff.ps1"), "utf8");
assert.equal(restartSource.includes("The restart handoff was already consumed"), true);
assert.equal(restartSource.includes("$childArgumentLine"), true);
assert.equal(restartSource.includes('Get-AppxPackage -Name "OpenAI.Codex"'), true);
assert.equal(restartSource.includes("shell:AppsFolder\\$appUserModelId"), true);
assert.equal(restartSource.includes("Start-CodexDesktop"), true);
assert.equal(restartSource.includes("Start-Process -FilePath $codexDesktopPackage.Executable"), false);
assert.equal(restartSource.includes('app "{0}"'), false);
assert.equal(restartSource.includes("Save-RestartState -State \"failed\""), true);
assert.equal(restartSource.includes("codex plugin remove"), true);
assert.equal(restartSource.includes("codex plugin add"), true);
assert.equal(restartSource.includes("installedRuntimeVersion"), true);
assert.equal(restartSource.includes("runningRuntimeVersion"), true);
assert.equal(restartSource.includes("codex-already-stopped"), true);
assert.equal(restartSource.includes("verifiedDesktopProcessIds"), true);
assert.equal(restartSource.includes("resume-codex-thread.ps1"), true);
assert.equal(restartSource.includes("$resumeProcess"), false);
assert.equal(restartSource.includes("& codex @codexArgs"), false);

const resumeSource = fs.readFileSync(path.join(__dirname, "resume-codex-thread.ps1"), "utf8");
assert.equal(resumeSource.includes("codex-app-server-resume.js"), true);
assert.equal(resumeSource.includes("resume-complete"), true);
assert.equal(resumeSource.includes("runningRuntimeVersion"), true);
assert.equal(resumeSource.includes("codex exec resume"), false);
const appServerSource = fs.readFileSync(path.join(__dirname, "codex-app-server-resume.js"), "utf8");
assert.equal(appServerSource.includes('["app-server", "--stdio"]'), true);
assert.equal(appServerSource.includes('"thread/resume"'), true);
assert.equal((appServerSource.match(/"turn\/start"/g) || []).length >= 1, true);
assert.equal(appServerSource.includes("Fresh AI Mobile runtime proof was not observed"), true);

const skillSource = fs.readFileSync(path.join(__dirname, "..", "skills", "ai-mobile", "SKILL.md"), "utf8");
assert.equal(skillSource.includes("The visible Codex task is a lightweight project console"), true);
assert.equal(skillSource.includes("gpt-5.6-luna at low effort"), true);
assert.equal(skillSource.includes("resume the same thread through " + String.fromCharCode(96) + "codex exec resume"), false);
const mcpServerSource = fs.readFileSync(path.join(__dirname, "mcp", "server.js"), "utf8");
assert.equal(mcpServerSource.includes("official local Codex app-server"), true);
fs.rmSync(root, { recursive: true, force: true });
process.stdout.write(JSON.stringify({
  ok: true,
  exactTrustedModels: ["claude-fable-5", "claude-sonnet-5"],
  genericModelsRemainIsolated: true,
  dirtyOwnershipRejected: true,
  deterministicVerificationRequired: true,
  restartHandoffOneShot: true,
  concurrentCodexOwnershipIsolated: true,
  rollbackNeverTouchesUnownedPaths: true,
  trustedPrimaryWorkExecuted: true,
}, null, 2) + "\n");
