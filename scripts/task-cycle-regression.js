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
fs.writeFileSync(path.join(workspace, "verify.js"), 'const fs=require("node:fs"); if(fs.readFileSync("feature.txt","utf8").trim()!=="TASK_CYCLE_OK") process.exit(1);\n', "utf8");
fs.writeFileSync(path.join(fakeBin, "fake-codex.js"), 'const fs=require("node:fs"); fs.writeFileSync("feature.txt","TASK_CYCLE_OK\\n","utf8"); process.stdout.write(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:"Implemented and verified TASK_CYCLE_OK"}})+"\\n"+JSON.stringify({type:"turn.completed",usage:{input_tokens:100,output_tokens:30}})+"\\n");\n', "utf8");
fs.writeFileSync(path.join(fakeBin, "fake-codex.cmd"), `@echo off\r\n"${process.execPath}" "%~dp0fake-codex.js" %*\r\n`, "utf8");

fs.writeFileSync(path.join(workspace, "verify-failover.js"), 'const fs=require("node:fs"); if(fs.readFileSync("failover.txt","utf8").trim()!=="FAILOVER_OK") process.exit(1);\n', "utf8");
fs.writeFileSync(path.join(fakeBin, "fake-codex-failover.js"), 'const fs=require("node:fs"); fs.writeFileSync("failover.txt","FAILOVER_OK\\n","utf8"); process.stdout.write(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:"Implemented and verified FAILOVER_OK"}})+"\\n"+JSON.stringify({type:"turn.completed",usage:{input_tokens:90,output_tokens:25}})+"\\n");\n', "utf8");
fs.writeFileSync(path.join(fakeBin, "fake-codex-failover.cmd"), "@echo off\r\n\"" + process.execPath + "\" \"%~dp0fake-codex-failover.js\" %*\r\n", "utf8");
fs.writeFileSync(path.join(fakeBin, "fake-claude-fail.cmd"), '@echo off\r\necho {"is_error":true,"result":"provider-process-failed fixture"}\r\nexit /b 1\r\n', "utf8");
fs.writeFileSync(path.join(fakeBin, "fake-claude-read.js"), 'process.stdout.write(JSON.stringify({is_error:false,structured_output:{outcome:"Found one exact bounded fact.",evidence:["verify.js exists"],checks:["node verify.js"],blocker:""},usage:{input_tokens:30,output_tokens:12}}));\n', "utf8");
fs.writeFileSync(path.join(fakeBin, "fake-claude-read.cmd"), "@echo off\r\n\"" + process.execPath + "\" \"%~dp0fake-claude-read.js\" %*\r\n", "utf8");
fs.writeFileSync(path.join(workspace, "verify-noop.js"), 'require("node:fs").writeFileSync("verification-ran.txt","BAD\\n");\n', "utf8");
fs.writeFileSync(path.join(fakeBin, "fake-codex-noop.js"), 'process.stdout.write(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:"No changes were needed."}})+"\\n"+JSON.stringify({type:"turn.completed",usage:{input_tokens:50,output_tokens:10}})+"\\n");\n', "utf8");
fs.writeFileSync(path.join(fakeBin, "fake-codex-noop.cmd"), "@echo off\r\n\"" + process.execPath + "\" \"%~dp0fake-codex-noop.js\" %*\r\n", "utf8");
function run(command, args) {
  const result = spawnSync(command, args, { cwd: workspace, encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}
run("git", ["init"]);
run("git", ["config", "user.email", "cycle@example.invalid"]);
run("git", ["config", "user.name", "AI Mobile Test"]);
run("git", ["add", "."]);
run("git", ["commit", "-m", "fixture"]);

const { startTask } = require("./core/task-orchestrator");
const { runTaskCycle } = require("./core/task-cycle");
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
    const readOnly = await runTaskCycle({ taskId: readOnlyTask.taskId, maxRounds: 3, maxMinutes: 2, noProgressLimit: 2 }, entrypoint, {
      inventory: async () => readOnlyResources,
      providerHistory: () => ({}),
    });
    assert.equal(readOnly.stopReason, "read-only-result-ready", JSON.stringify(readOnly));
    assert.equal(readOnly.startedRounds, 1);
    assert.equal(readOnly.transitions.filter((row) => row.type === "dispatched").length, 1);
    assert.match(readOnly.transitions.find((row) => row.type === "read-only-result")?.jobs[0]?.summary || "", /bounded fact/i);

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
    assert.match(noPatch.failures[0]?.blocker || "", /no-patch-produced/);
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
      mcpSliceSeconds: result.sliceSeconds,
    }, null, 2) + "\n");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});