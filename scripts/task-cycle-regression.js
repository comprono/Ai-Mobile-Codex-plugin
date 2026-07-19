#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-mobile-task-cycle-"));
process.env.AI_MOBILE_DATA_ROOT = path.join(root, "state");
process.env.LOCALAPPDATA = path.join(root, "local");
const workspace = path.join(root, "workspace");
const fakeBin = path.join(root, "bin");
fs.mkdirSync(workspace, { recursive: true });
fs.mkdirSync(fakeBin, { recursive: true });
fs.mkdirSync(path.join(workspace, "Jobs Harness", "workflow"), { recursive: true });
fs.writeFileSync(path.join(workspace, "Jobs Harness", "workflow", "controls_to_questions.py"), "# bounded discovery fixture\n", "utf8");
fs.mkdirSync(path.join(workspace, ".claude", "worktrees", "stale", "Jobs Harness", "workflow"), { recursive: true });
fs.writeFileSync(path.join(workspace, ".claude", "worktrees", "stale", "Jobs Harness", "workflow", "controls_to_questions.py"), "# stale worktree fixture\n", "utf8");
fs.writeFileSync(path.join(workspace, "verify.js"), 'const fs=require("node:fs"); if(fs.readFileSync("feature.txt","utf8").trim()!=="TASK_CYCLE_OK") process.exit(1);\n', "utf8");
fs.writeFileSync(path.join(fakeBin, "fake-codex.js"), [
  'const patch=["```diff","diff --git a/feature.txt b/feature.txt","new file mode 100644","--- /dev/null","+++ b/feature.txt","@@ -0,0 +1 @@","+TASK_CYCLE_OK","```"].join("\\n");',
  'process.stdout.write(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:patch}})+"\\n"+JSON.stringify({type:"turn.completed",usage:{input_tokens:100,output_tokens:30}})+"\\n");',
].join("\n") + "\n", "utf8");
fs.writeFileSync(path.join(fakeBin, "fake-codex.cmd"), `@echo off\r\n"${process.execPath}" "%~dp0fake-codex.js" %*\r\n`, "utf8");

fs.writeFileSync(path.join(workspace, "verify-failover.js"), 'const fs=require("node:fs"); if(fs.readFileSync("failover.txt","utf8").trim()!=="FAILOVER_OK") process.exit(1);\n', "utf8");
fs.writeFileSync(path.join(fakeBin, "fake-codex-failover.js"), [
  'const patch=["```diff","diff --git a/failover.txt b/failover.txt","new file mode 100644","--- /dev/null","+++ b/failover.txt","@@ -0,0 +1 @@","+FAILOVER_OK","```"].join("\\n");',
  'process.stdout.write(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:patch}})+"\\n"+JSON.stringify({type:"turn.completed",usage:{input_tokens:90,output_tokens:25}})+"\\n");',
].join("\n") + "\n", "utf8");
fs.writeFileSync(path.join(fakeBin, "fake-codex-failover.cmd"), "@echo off\r\n\"" + process.execPath + "\" \"%~dp0fake-codex-failover.js\" %*\r\n", "utf8");
fs.writeFileSync(path.join(fakeBin, "fake-claude-fail.cmd"), '@echo off\r\necho {"is_error":true,"result":"provider-process-failed fixture"}\r\nexit /b 1\r\n', "utf8");
fs.writeFileSync(path.join(fakeBin, "fake-claude-read.js"), 'process.stdout.write(JSON.stringify({is_error:false,structured_output:{outcome:"Found one exact bounded implementation.",evidence:["verify.js exists"],checks:["node verify-inspection.js"],blocker:"",blockerOwner:"",recoveryTrigger:"",recoveryAction:"",proposedWorkUnits:[{goal:"Create inspection.txt containing INSPECTED_OK",relevantFiles:["verify.js","verify-inspection.js","inspection.txt"],expectedFiles:["inspection.txt"],acceptanceCriteria:["node verify-inspection.js exits zero"],verificationCommands:[{name:"verify-inspection",command:"node",args:["verify-inspection.js"],timeoutSeconds:30}],taskKind:"code",complexity:"medium",priority:100,requiredCapabilities:["source","local-files","tests"]}]},usage:{input_tokens:30,output_tokens:12}}));\n', "utf8");
fs.writeFileSync(path.join(fakeBin, "fake-claude-read.cmd"), "@echo off\r\n\"" + process.execPath + "\" \"%~dp0fake-claude-read.js\" %*\r\n", "utf8");
fs.writeFileSync(path.join(workspace, "verify-inspection.js"), 'const fs=require("node:fs"); if(fs.readFileSync("inspection.txt","utf8").trim()!=="INSPECTED_OK") process.exit(1);\n', "utf8");
fs.writeFileSync(path.join(fakeBin, "fake-codex-inspection.js"), [
  'const patch=["```diff","diff --git a/inspection.txt b/inspection.txt","new file mode 100644","--- /dev/null","+++ b/inspection.txt","@@ -0,0 +1 @@","+INSPECTED_OK","```"].join("\\n");',
  'process.stdout.write(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:patch}})+"\\n"+JSON.stringify({type:"turn.completed",usage:{input_tokens:70,output_tokens:22}})+"\\n");',
].join("\n") + "\n", "utf8");
fs.writeFileSync(path.join(fakeBin, "fake-codex-inspection.cmd"), "@echo off\r\n\"" + process.execPath + "\" \"%~dp0fake-codex-inspection.js\" %*\r\n", "utf8");
fs.writeFileSync(path.join(workspace, "verify-noop.js"), 'require("node:fs").writeFileSync("verification-ran.txt","BAD\\n");\n', "utf8");
fs.writeFileSync(path.join(fakeBin, "fake-codex-noop.js"), 'process.stdout.write(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:"No changes were needed."}})+"\\n"+JSON.stringify({type:"turn.completed",usage:{input_tokens:50,output_tokens:10}})+"\\n");\n', "utf8");
fs.writeFileSync(path.join(fakeBin, "fake-codex-noop.cmd"), "@echo off\r\n\"" + process.execPath + "\" \"%~dp0fake-codex-noop.js\" %*\r\n", "utf8");
const invalidObservationPlan = { outcome: "Invalid bounded plan", evidence: ["claimed scan"], checks: ["node missing-verifier.js"], blocker: "", blockerOwner: "", recoveryTrigger: "", recoveryAction: "", proposedWorkUnits: [{ goal: "Write a file from an invalid plan", relevantFiles: ["missing-source.js", "hallucinated/result.txt"], expectedFiles: ["hallucinated/result.txt"], acceptanceCriteria: ["node missing-verifier.js exits zero"], verificationCommands: [{ name: "missing-verifier", command: "node", args: ["missing-verifier.js"], timeoutSeconds: 30 }], taskKind: "code", complexity: "medium", priority: 100, requiredCapabilities: ["source", "local-files", "tests"] }] };
const invalidObservationOutput = JSON.stringify({ is_error: false, structured_output: invalidObservationPlan, usage: { input_tokens: 24, output_tokens: 10 } });
fs.writeFileSync(path.join(fakeBin, "fake-claude-invalid-observation.js"), "process.stdout.write(" + JSON.stringify(invalidObservationOutput) + ");\n", "utf8");
fs.writeFileSync(path.join(fakeBin, "fake-claude-invalid-observation.cmd"), "@echo off\r\n\"" + process.execPath + "\" \"%~dp0fake-claude-invalid-observation.js\" %*\r\n", "utf8");
const validObservationPlan = { outcome: "One valid bounded implementation", evidence: ["verify.js and verify-observation.js exist"], checks: ["node verify-observation.js"], blocker: "", blockerOwner: "", recoveryTrigger: "", recoveryAction: "", proposedWorkUnits: [{ goal: "Create validated.txt containing VALIDATED_OK", relevantFiles: ["verify.js", "verify-observation.js", "validated.txt"], expectedFiles: ["validated.txt"], acceptanceCriteria: ["node verify-observation.js exits zero"], verificationCommands: [{ name: "verify-observation", command: "node", args: ["verify-observation.js"], timeoutSeconds: 30 }], taskKind: "code", complexity: "medium", priority: 100, requiredCapabilities: ["source", "local-files", "tests"] }] };
const validObservationOutput = JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify(validObservationPlan) } }) + "\n" + JSON.stringify({ type: "turn.completed", usage: { input_tokens: 28, output_tokens: 11 } }) + "\n";
fs.writeFileSync(path.join(fakeBin, "fake-codex-valid-observation.js"), "process.stdout.write(" + JSON.stringify(validObservationOutput) + ");\n", "utf8");
fs.writeFileSync(path.join(fakeBin, "fake-codex-valid-observation.cmd"), "@echo off\r\n\"" + process.execPath + "\" \"%~dp0fake-codex-valid-observation.js\" %*\r\n", "utf8");
fs.writeFileSync(path.join(workspace, "verify-observation.js"), 'const fs=require("node:fs"); if(fs.readFileSync("validated.txt","utf8").trim()!=="VALIDATED_OK") process.exit(1);\n', "utf8");
fs.writeFileSync(path.join(fakeBin, "fake-codex-valid-writer.js"), [
  'const patch=["```diff","diff --git a/validated.txt b/validated.txt","new file mode 100644","--- /dev/null","+++ b/validated.txt","@@ -0,0 +1 @@","+VALIDATED_OK","```"].join("\\n");',
  'process.stdout.write(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:patch}})+"\\n"+JSON.stringify({type:"turn.completed",usage:{input_tokens:65,output_tokens:20}})+"\\n");',
].join("\n") + "\n", "utf8");
fs.writeFileSync(path.join(fakeBin, "fake-codex-valid-writer.cmd"), "@echo off\r\n\"" + process.execPath + "\" \"%~dp0fake-codex-valid-writer.js\" %*\r\n", "utf8");
fs.writeFileSync(path.join(workspace, "verify-stale-inline.js"), 'const fs=require("node:fs"); if(fs.readFileSync("stale-inline.txt","utf8").trim()!=="STALE_INLINE_OK") process.exit(1);\n', "utf8");
fs.writeFileSync(path.join(fakeBin, "fake-codex-stale-inline.js"), [
  'const patch=["```diff","diff --git a/stale-inline.txt b/stale-inline.txt","new file mode 100644","--- /dev/null","+++ b/stale-inline.txt","@@ -0,0 +1 @@","+STALE_INLINE_OK","```"].join("\\n");',
  'process.stdout.write(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:patch}})+"\\n"+JSON.stringify({type:"turn.completed",usage:{input_tokens:60,output_tokens:18}})+"\\n");',
].join("\n") + "\n", "utf8");
fs.writeFileSync(path.join(fakeBin, "fake-codex-stale-inline.cmd"), "@echo off\r\n\"" + process.execPath + "\" \"%~dp0fake-codex-stale-inline.js\" %*\r\n", "utf8");
fs.writeFileSync(path.join(fakeBin, "fake-codex-stale-inline-fail.cmd"), '@echo off\r\necho {"type":"error","message":"stale inline provider failure fixture"}\r\nexit /b 1\r\n', "utf8");
function run(command, args) {
  const result = spawnSync(command, args, { cwd: workspace, encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}
run("git", ["init"]);
run("git", ["config", "user.email", "cycle@example.invalid"]);
run("git", ["config", "user.name", "AI Mobile Test"]);
run("git", ["add", "."]);
run("git", ["commit", "-m", "fixture"]);

const { createJob, setStatus, statusFor } = require("./core/job-store");
const { dispatchRound, startTask, taskSummary } = require("./core/task-orchestrator");
const { jobDirectory, readRound, readTask } = require("./core/state-store");
const { runTaskCycle } = require("./core/task-cycle");
const { promptFor } = require("./core/worker");
const planningPrompt = promptFor({ artifactKind: "work-plan", provider: "claude", readOnly: true, maxWorkerOutputTokens: 600 });
assert.match(planningPrompt, /Never use inline code flags such as node -e, python -c, or PowerShell -Command/);
assert.match(planningPrompt, /python -m unittest/);
assert.match(planningPrompt, /existing immediate parent directory/);
const entrypoint = path.join(__dirname, "ai-mobile-local-mcp.js");
const resources = {
  generatedAt: new Date().toISOString(),
  machine: { logicalCpuCount: 8, freeRamMb: 8000 },
  providers: {
    codex: {
      id: "codex", available: true, authenticated: true, authMode: "chatgpt", command: path.join(fakeBin, "fake-codex.cmd"),
      models: [{ id: "gpt-5.6-luna", defaultReasoningEffort: "low", supportedReasoningEfforts: ["low", "medium"] }],
      capacity: { remainingPercent: 90 }, quotaPools: [{ id: "codex", remainingPercent: 90 }],
    },
    claude: { id: "claude", available: false, authenticated: false, models: [], quotaPools: [], reason: "fixture" },
    antigravity: { id: "antigravity", available: false, authenticated: false, models: [], quotaPools: [], reason: "fixture" },
    cursor: { id: "cursor", available: false, authenticated: false, models: [], quotaPools: [], reason: "fixture" },
  },
};

(async () => {
  try {
    const blockedRecoveryTask = startTask({
      workspace,
      outcome: "Recover one blocked parser acceptance item without orphan work",
      outcomeAuthority: "user",
      acceptanceEvidence: [{
        id: "REQ-BLOCKED",
        description: "Repeated option controls become one explicit question group",
        minimumEvidenceLevel: "integration",
        status: "blocked",
        blocker: {
          owner: "coordinator",
          reason: "Exact parser paths are not yet identified.",
          recoveryTrigger: "A bounded filename scan identifies the parser and test fixture.",
          recoveryAction: "Inspect controls_to_questions and its fixture, then return exact writer files and checks.",
        },
      }],
      workGraph: [{
        id: "R-REQ-BLOCKED",
        goal: "Recover repeated option control parsing",
        state: "blocked",
        priority: 100,
        acceptanceRequirementId: "REQ-BLOCKED",
      }],
      consoleModel: "gpt-5.6-luna",
      consoleEffort: "low",
      codexReservePercent: 15,
    }, resources);
    const blockedRecoverySummary = taskSummary({ taskId: blockedRecoveryTask.taskId });
    const blockedRecoveryUnit = blockedRecoverySummary.workPlane.recommendedWorkUnits[0];
    assert.equal(blockedRecoverySummary.execution.workGraphNodeId, "R-REQ-BLOCKED");
    assert.equal(blockedRecoverySummary.execution.mustDispatchNow, true);
    assert.equal(blockedRecoveryUnit.workGraphNodeId, "R-REQ-BLOCKED");
    assert.ok(blockedRecoveryUnit.relevantFiles.includes("Jobs Harness/workflow/controls_to_questions.py"), JSON.stringify(blockedRecoveryUnit));
    assert.equal(blockedRecoveryUnit.relevantFiles.some((file) => file.startsWith(".claude/")), false, JSON.stringify(blockedRecoveryUnit));

    const task = startTask({
      workspace,
      outcome: "Prove a bounded cycle reaches accepted project evidence",
      outcomeAuthority: "user",
      acceptanceEvidence: [{ description: "The primary workspace contains deterministically verified TASK_CYCLE_OK", minimumEvidenceLevel: "integration" }],
      workGraph: [{
        id: "W1",
        goal: "Create feature.txt containing TASK_CYCLE_OK",
        state: "pending",
        priority: 100,
        acceptanceRequirementId: "A1",
        relevantFiles: ["feature.txt", "verify.js"],
        expectedFiles: ["feature.txt"],
        acceptanceCriteria: ["node verify.js exits zero in the primary workspace"],
        verificationCommands: [{ name: "verify-feature", command: "node", args: ["verify.js"], timeoutSeconds: 30 }],
        taskKind: "code",
        complexity: "large",
      }],
      consoleModel: "gpt-5.6-luna",
      consoleEffort: "low",
      codexReservePercent: 15,
    }, resources);

    const result = await runTaskCycle({ taskId: task.taskId, maxRounds: 1, maxMinutes: 2, noProgressLimit: 2 }, entrypoint, {
      inventory: async () => resources,
      providerHistory: () => ({}),
    });
    assert.equal(result.completionAllowed, true, JSON.stringify(result));
    assert.equal(result.continuationRequired, false);
    assert.equal(result.sliceSeconds, 210);
    assert.equal(fs.readFileSync(path.join(workspace, "feature.txt"), "utf8").trim(), "TASK_CYCLE_OK");
    assert.ok(result.transitions.some((row) => row.type === "dispatched"));
    assert.ok(result.transitions.some((row) => row.type === "collected"));
    assert.ok(result.transitions.some((row) => row.type === "integrated"));
    assert.ok(result.transitions.some((row) => row.type === "completed"));
    run("git", ["add", "."]);
    run("git", ["commit", "-m", "accept first cycle"]);
    const failoverResources = JSON.parse(JSON.stringify(resources));
    failoverResources.providers.codex.command = path.join(fakeBin, "fake-codex-failover.cmd");
    failoverResources.providers.claude = {
      id: "claude", available: true, authenticated: true, authMode: "subscription",
      command: path.join(fakeBin, "fake-claude-fail.cmd"),
      models: [{ id: "sonnet" }], capacity: { remainingPercent: 90 }, quotaPools: [{ id: "claude", remainingPercent: 90 }],
    };
    const failoverTask = startTask({
      workspace,
      outcome: "Finish after one provider process failure without repeating it",
      outcomeAuthority: "user",
      acceptanceEvidence: [{ description: "The primary workspace contains deterministically verified FAILOVER_OK", minimumEvidenceLevel: "integration" }],
      workGraph: [{
        id: "W2",
        goal: "Create failover.txt containing FAILOVER_OK",
        state: "pending",
        priority: 100,
        acceptanceRequirementId: "A1",
        relevantFiles: ["failover.txt", "verify-failover.js"],
        expectedFiles: ["failover.txt"],
        acceptanceCriteria: ["node verify-failover.js exits zero in the primary workspace"],
        verificationCommands: [{ name: "verify-failover", command: "node", args: ["verify-failover.js"], timeoutSeconds: 30 }],
        taskKind: "code",
        complexity: "large",
      }],
      consoleModel: "gpt-5.6-luna",
      consoleEffort: "low",
      codexReservePercent: 15,
    }, failoverResources);
    const failover = await runTaskCycle({ taskId: failoverTask.taskId, maxRounds: 2, maxMinutes: 2, noProgressLimit: 2 }, entrypoint, {
      inventory: async () => failoverResources,
      providerHistory: () => ({}),
    });
    const dispatchedProviders = failover.transitions
      .filter((row) => row.type === "dispatched")
      .flatMap((row) => row.workers.map((worker) => worker.provider));
    assert.deepEqual(dispatchedProviders, ["claude", "codex"], JSON.stringify(failover));
    assert.equal(failover.completionAllowed, true, JSON.stringify(failover));
    assert.equal(fs.readFileSync(path.join(workspace, "failover.txt"), "utf8").trim(), "FAILOVER_OK");
    assert.equal(failover.failures.filter((row) => row.provider === "claude").length, 1);
    assert.equal(failover.transitions.find((row) => row.type === "collected" && row.failedJobs.length)?.recovery[0]?.failureClass, "provider-adapter-failure");
    run("git", ["add", "."]);
    run("git", ["commit", "-m", "accept failover cycle"]);
    const staleInlineFailureResources = JSON.parse(JSON.stringify(resources));
    staleInlineFailureResources.providers.codex.command = path.join(fakeBin, "fake-codex-stale-inline-fail.cmd");
    const staleInlineTask = startTask({
      workspace,
      outcome: "Recover the same provider after collecting a stale failed round",
      outcomeAuthority: "user",
      acceptanceEvidence: [{ description: "The primary workspace contains deterministically verified STALE_INLINE_OK", minimumEvidenceLevel: "integration" }],
      workGraph: [{
        id: "STALE_INLINE",
        goal: "Create stale-inline.txt containing STALE_INLINE_OK",
        state: "pending",
        priority: 100,
        acceptanceRequirementId: "A1",
        relevantFiles: ["stale-inline.txt", "verify-stale-inline.js"],
        expectedFiles: ["stale-inline.txt"],
        acceptanceCriteria: ["node verify-stale-inline.js exits zero in the primary workspace"],
        verificationCommands: [{ name: "verify-stale-inline", command: "node", args: ["verify-stale-inline.js"], timeoutSeconds: 30 }],
        taskKind: "code",
        complexity: "large",
      }],
      consoleModel: "gpt-5.6-luna",
      consoleEffort: "low",
      codexReservePercent: 15,
    }, staleInlineFailureResources);
    const staleInlineRound = dispatchRound(
      { taskId: staleInlineTask.taskId, horizonHours: 5 },
      staleInlineFailureResources,
      {},
      (contract) => createJob(contract, entrypoint),
    );
    const staleInlineJob = staleInlineRound.workers[0];
    const staleInlineDeadline = Date.now() + 10000;
    while (!["completed", "failed", "blocked", "cancelled"].includes(statusFor(staleInlineTask.taskId, staleInlineJob.jobId).state) && Date.now() < staleInlineDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(statusFor(staleInlineTask.taskId, staleInlineJob.jobId).state, "failed");
    const staleInlineRecoveryResources = JSON.parse(JSON.stringify(resources));
    staleInlineRecoveryResources.providers.codex.command = path.join(fakeBin, "fake-codex-stale-inline.cmd");
    const staleInlineResult = await runTaskCycle(
      { taskId: staleInlineTask.taskId, maxRounds: 1, maxMinutes: 2, noProgressLimit: 1 },
      entrypoint,
      { inventory: async () => staleInlineRecoveryResources, providerHistory: () => ({}) },
    );
    assert.equal(staleInlineResult.completionAllowed, true, JSON.stringify(staleInlineResult));
    assert.equal(staleInlineResult.stopReason, "acceptance-complete", JSON.stringify(staleInlineResult));
    assert.equal(fs.readFileSync(path.join(workspace, "stale-inline.txt"), "utf8").trim(), "STALE_INLINE_OK");
    run("git", ["add", "."]);
    run("git", ["commit", "-m", "accept stale inline recovery"]);

    const readOnlyResources = JSON.parse(JSON.stringify(resources));
    readOnlyResources.providers.codex.available = false;
    readOnlyResources.providers.codex.authenticated = false;
    readOnlyResources.providers.claude = {
      id: "claude", available: true, authenticated: true, authMode: "subscription",
      command: path.join(fakeBin, "fake-claude-read.cmd"),
      models: [{ id: "sonnet" }], capacity: { remainingPercent: 90 }, quotaPools: [{ id: "claude", remainingPercent: 90 }],
    };
    const readOnlyTask = startTask({
      workspace,
      outcome: "Return one compact inspection artifact without repeating it",
      outcomeAuthority: "user",
      acceptanceEvidence: [{ description: "A later implementation uses the exact inspected evidence", minimumEvidenceLevel: "integration" }],
      workGraph: [{
        id: "W3",
        goal: "Inspect verify.js once and return its exact verification command",
        state: "pending",
        priority: 100,
        acceptanceRequirementId: "A1",
        relevantFiles: ["verify.js"],
        expectedFiles: [],
        acceptanceCriteria: ["Return the exact verification command"],
        verificationCommands: [],
        readOnly: true,
        taskKind: "repository-scan",
        complexity: "medium",
      }],
      consoleModel: "gpt-5.6-luna",
      consoleEffort: "low",
      codexReservePercent: 15,
    }, readOnlyResources);
    const readOnlyWriterResources = JSON.parse(JSON.stringify(resources));
    readOnlyWriterResources.providers.codex.command = path.join(fakeBin, "fake-codex-inspection.cmd");
    let readOnlyInventoryCalls = 0;
    const readOnly = await runTaskCycle({ taskId: readOnlyTask.taskId, maxRounds: 3, maxMinutes: 2, noProgressLimit: 2 }, entrypoint, {
      inventory: async () => (++readOnlyInventoryCalls === 1 ? readOnlyResources : readOnlyWriterResources),
      providerHistory: () => ({}),
    });
    assert.equal(readOnly.completionAllowed, true, JSON.stringify(readOnly));
    assert.equal(readOnly.startedRounds, 2);
    assert.equal(readOnly.transitions.filter((row) => row.type === "dispatched").length, 2);
    assert.equal(fs.readFileSync(path.join(workspace, "inspection.txt"), "utf8").trim(), "INSPECTED_OK");
    const invalidObservationResources = JSON.parse(JSON.stringify(resources));
    invalidObservationResources.providers.codex.available = false;
    invalidObservationResources.providers.codex.authenticated = false;
    invalidObservationResources.providers.claude = {
      id: "claude", available: true, authenticated: true, authMode: "subscription",
      command: path.join(fakeBin, "fake-claude-invalid-observation.cmd"),
      models: [{ id: "sonnet" }], capacity: { remainingPercent: 90 }, quotaPools: [{ id: "claude", remainingPercent: 90 }],
    };
    const invalidObservationTask = startTask({
      workspace,
      outcome: "Reject invented paths, inspect again with another provider, and finish only the valid plan",
      outcomeAuthority: "user",
      acceptanceEvidence: [{ description: "validated.txt is created only from a workspace-validated observation", minimumEvidenceLevel: "integration" }],
      workGraph: [{
        id: "W-invalid-observation",
        goal: "Inspect verify.js and return one exact implementation plan",
        state: "pending",
        priority: 100,
        acceptanceRequirementId: "A1",
        relevantFiles: ["verify.js"],
        expectedFiles: [],
        acceptanceCriteria: ["Return an exact workspace-grounded implementation plan"],
        verificationCommands: [],
        readOnly: true,
        taskKind: "repository-scan",
        complexity: "medium",
      }],
      consoleModel: "gpt-5.6-luna",
      consoleEffort: "low",
      codexReservePercent: 15,
    }, invalidObservationResources);
    const validObservationResources = JSON.parse(JSON.stringify(invalidObservationResources));
    validObservationResources.providers.codex.available = true;
    validObservationResources.providers.codex.authenticated = true;
    validObservationResources.providers.codex.command = path.join(fakeBin, "fake-codex-valid-observation.cmd");
    const validWriterResources = JSON.parse(JSON.stringify(validObservationResources));
    validWriterResources.providers.codex.command = path.join(fakeBin, "fake-codex-valid-writer.cmd");
    let invalidObservationInventoryCalls = 0;
    const invalidObservationFailover = await runTaskCycle({
      taskId: invalidObservationTask.taskId, maxRounds: 3, maxMinutes: 2, noProgressLimit: 2,
    }, entrypoint, {
      inventory: async () => {
        invalidObservationInventoryCalls += 1;
        if (invalidObservationInventoryCalls === 1) return invalidObservationResources;
        if (invalidObservationInventoryCalls === 2) return validObservationResources;
        return validWriterResources;
      },
      providerHistory: () => ({}),
    });
    const invalidObservationProviders = invalidObservationFailover.transitions
      .filter((row) => row.type === "dispatched")
      .flatMap((row) => row.workers.map((worker) => worker.provider));
    assert.deepEqual(invalidObservationProviders, ["claude", "codex", "codex"], JSON.stringify(invalidObservationFailover));
    assert.ok(invalidObservationFailover.transitions.some((row) => row.type === "integrated" && (row.failures || []).some((failure) => /structured-work-plan-path-invalid/.test(failure.blocker || ""))));
    assert.equal(invalidObservationFailover.completionAllowed, true, JSON.stringify(invalidObservationFailover));
    assert.equal(fs.readFileSync(path.join(workspace, "validated.txt"), "utf8").trim(), "VALIDATED_OK");
    const invalidObservationFinalTask = readTask(invalidObservationTask.taskId);
    const invalidObservationContracts = (invalidObservationFinalTask.rounds || []).flatMap((roundRef) => {
      const round = readRound(invalidObservationTask.taskId, roundRef.roundId);
      return (round.jobs || []).map((job) => JSON.parse(fs.readFileSync(path.join(jobDirectory(invalidObservationTask.taskId, job.jobId), "contract.json"), "utf8")));
    });
    assert.equal(invalidObservationContracts.some((contract) => (contract.expectedFiles || []).includes("hallucinated/result.txt")), false);
    assert.equal(invalidObservationContracts.filter((contract) => contract.readOnly !== true).length, 1);

    const noPatchResources = JSON.parse(JSON.stringify(resources));
    noPatchResources.providers.codex.command = path.join(fakeBin, "fake-codex-noop.cmd");
    const noPatchTask = startTask({
      workspace,
      outcome: "Reject a no-patch editor before verification",
      outcomeAuthority: "user",
      acceptanceEvidence: [{ description: "A real patch passes the focused no-op verification", minimumEvidenceLevel: "integration" }],
      workGraph: [{
        id: "W4",
        goal: "Create noop.txt",
        state: "pending",
        priority: 100,
        acceptanceRequirementId: "A1",
        relevantFiles: ["noop.txt", "verify-noop.js"],
        expectedFiles: ["noop.txt"],
        acceptanceCriteria: ["noop.txt exists"],
        verificationCommands: [{ name: "must-not-run", command: "node", args: ["verify-noop.js"], timeoutSeconds: 30 }],
        taskKind: "code",
        complexity: "medium",
      }],
      consoleModel: "gpt-5.6-luna",
      consoleEffort: "low",
      codexReservePercent: 15,
    }, noPatchResources);
    const noPatch = await runTaskCycle({ taskId: noPatchTask.taskId, maxRounds: 1, maxMinutes: 2, sliceSeconds: 30, noProgressLimit: 2 }, entrypoint, {
      inventory: async () => noPatchResources,
      providerHistory: () => ({}),
    });
    assert.equal(noPatch.completionAllowed, false);
    assert.match(noPatch.failures[0]?.blocker || "", /provider-unified-diff-missing|no-patch-produced/, JSON.stringify(noPatch));
    const noPatchJobId = noPatch.transitions.find((row) => row.type === "dispatched")?.workers?.[0]?.jobId;
    assert.ok(noPatchJobId, JSON.stringify(noPatch));
    const terminalBeforeLateLaunchWrite = statusFor(noPatchTask.taskId, noPatchJobId);
    assert.equal(terminalBeforeLateLaunchWrite.state, "failed");
    const terminalAfterLateLaunchWrite = setStatus(noPatchTask.taskId, noPatchJobId, { state: "running", pid: 999999, startedAt: new Date().toISOString() });
    assert.equal(terminalAfterLateLaunchWrite.state, "failed", "a late parent launch write must not resurrect a terminal worker");
    assert.equal(terminalAfterLateLaunchWrite.blocker, terminalBeforeLateLaunchWrite.blocker);
    assert.equal(fs.existsSync(path.join(workspace, "verification-ran.txt")), false, "verification must not run after a no-patch editor");
    process.stdout.write(JSON.stringify({
      ok: true,
      completionAllowed: true,
      transitionTypes: result.transitions.map((row) => row.type),
      noUserMessageRequired: true,
      failedProviderRetriedUnchanged: false,
      automaticFailoverProviders: dispatchedProviders,
      readOnlyArtifactRepeated: false,
      noPatchVerificationSkipped: true,
      terminalWorkerStateMonotonic: true,
      mcpSliceSeconds: result.sliceSeconds,
    }, null, 2) + "\n");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
