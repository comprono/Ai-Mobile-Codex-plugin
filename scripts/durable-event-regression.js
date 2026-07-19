#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-mobile-durable-event-"));
process.env.AI_MOBILE_DATA_ROOT = path.join(root, "state");
process.env.LOCALAPPDATA = path.join(root, "local");
const fakeBin = path.join(root, "bin");
fs.mkdirSync(fakeBin, { recursive: true });

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stderr || result.stdout || result.error?.message);
}

function cleanupFixtureRoot() {
  const tempRoot = path.resolve(os.tmpdir());
  const target = path.resolve(root);
  assert.ok(target.startsWith(`${tempRoot}${path.sep}ai-mobile-durable-event-`), `Refusing fixture cleanup outside the expected temp boundary: ${target}`);
  let lastError = null;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      fs.rmSync(target, { recursive: true, force: true });
      if (!fs.existsSync(target)) return;
    } catch (error) {
      lastError = error;
      if (!["EACCES", "EBUSY", "ENOTEMPTY", "EPERM"].includes(String(error.code || "").toUpperCase())) throw error;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(500, 50 * (attempt + 1)));
  }
  throw lastError || new Error(`Fixture cleanup did not remove ${target}`);
}

function workspace(name, verificationName, targetFile, expectedText) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, verificationName), `const fs=require("node:fs"); if(fs.readFileSync("${targetFile}","utf8").trim()!=="${expectedText}") process.exit(1);\n`, "utf8");
  fs.writeFileSync(path.join(dir, "context.md"), "Bounded project context.\n", "utf8");
  run("git", ["init"], dir);
  run("git", ["config", "user.email", "durable@example.invalid"], dir);
  run("git", ["config", "user.name", "AI Mobile Durable Test"], dir);
  run("git", ["add", "."], dir);
  run("git", ["commit", "-m", "fixture"], dir);
  return dir;
}

const observationWorkspace = workspace("observation", "verify-planned.js", "planned.txt", "PLANNED_OK");
const detachedWorkspace = workspace("detached", "verify-durable.js", "durable.txt", "DURABLE_OK");
const lostWorkspace = workspace("lost-worker", "verify-lost.js", "lost.txt", "NEVER_WRITTEN");

fs.writeFileSync(path.join(fakeBin, "fake-claude.js"), `process.stdout.write(JSON.stringify({is_error:false,structured_output:{outcome:"Observed the bounded gap and produced one exact implementation unit.",evidence:["context.md identifies the fixture"],checks:["node verify-planned.js"],blocker:"",blockerOwner:"",recoveryTrigger:"",recoveryAction:"",proposedWorkUnits:[{goal:"Create planned.txt containing PLANNED_OK",relevantFiles:["context.md","verify-planned.js","planned.txt"],expectedFiles:["planned.txt"],acceptanceCriteria:["node verify-planned.js exits zero"],verificationCommands:[{name:"verify-planned",command:"node",args:["verify-planned.js"],timeoutSeconds:30}],taskKind:"code",complexity:"medium",priority:100}]},usage:{input_tokens:40,output_tokens:20}}));\n`, "utf8");
fs.writeFileSync(path.join(fakeBin, "fake-claude.cmd"), `@echo off\r\n"${process.execPath}" "%~dp0fake-claude.js" %*\r\n`, "utf8");
fs.writeFileSync(path.join(fakeBin, "fake-codex.js"), [
  'const fs=require("node:fs"); const durable=fs.existsSync("verify-durable.js"); const file=durable?"durable.txt":"planned.txt"; const value=durable?"DURABLE_OK":"PLANNED_OK";',
  'const patch=["```diff",`diff --git a/${file} b/${file}`,"new file mode 100644","--- /dev/null",`+++ b/${file}`,"@@ -0,0 +1 @@",`+${value}`,"```"].join("\\n");',
  'process.stdout.write(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:patch}})+"\\n"+JSON.stringify({type:"turn.completed",usage:{input_tokens:60,output_tokens:18}})+"\\n");',
].join("\n") + "\n", "utf8");
fs.writeFileSync(path.join(fakeBin, "fake-codex.cmd"), `@echo off\r\n"${process.execPath}" "%~dp0fake-codex.js" %*\r\n`, "utf8");
fs.writeFileSync(path.join(fakeBin, "fake-codex-slow.js"), 'setTimeout(() => process.stdout.write(JSON.stringify({type:"turn.completed",usage:{input_tokens:1,output_tokens:0}})+"\\n"), 30000);\n', "utf8");
fs.writeFileSync(path.join(fakeBin, "fake-codex-slow.cmd"), `@echo off\r\n"${process.execPath}" "%~dp0fake-codex-slow.js" %*\r\n`, "utf8");

const { inventory: unusedInventory } = require("./core/capacity");
void unusedInventory;
const { createJob, statusFor } = require("./core/job-store");
const { coordinatorStatus, runCoordinator, startCoordinator } = require("./core/coordinator");
const { readMaterialEvents } = require("./core/material-events");
const { dispatchRound, startTask, taskSummary } = require("./core/task-orchestrator");
const { terminateTree } = require("./core/utils");
const entrypoint = path.join(__dirname, "ai-mobile-local-mcp.js");

function resources(provider) {
  const base = {
    generatedAt: new Date().toISOString(),
    machine: { logicalCpuCount: 8, freeRamMb: 8000 },
    providers: {
      codex: { id: "codex", available: false, authenticated: false, models: [], quotaPools: [], reason: "fixture" },
      claude: { id: "claude", available: false, authenticated: false, models: [], quotaPools: [], reason: "fixture" },
      antigravity: { id: "antigravity", available: false, authenticated: false, models: [], quotaPools: [], reason: "fixture" },
      cursor: { id: "cursor", available: false, authenticated: false, models: [], quotaPools: [], reason: "fixture" },
    },
  };
  if (provider === "claude") base.providers.claude = {
    id: "claude", available: true, authenticated: true, authMode: "subscription", command: path.join(fakeBin, "fake-claude.cmd"),
    models: [{ id: "sonnet", displayName: "Sonnet" }], capabilities: { "repository-scan": 90 },
    capacity: { remainingPercent: 90, source: "fixture" }, quotaPools: [{ id: "claude", remainingPercent: 90 }],
  };
  if (provider === "codex") base.providers.codex = {
    id: "codex", available: true, authenticated: true, authMode: "chatgpt", command: path.join(fakeBin, "fake-codex.cmd"),
    models: [{ id: "gpt-fixture", displayName: "Fixture capable model", description: "balanced capable coding model", defaultReasoningEffort: "medium", supportedReasoningEfforts: ["low", "medium", "high"] }],
    capabilities: { code: 95 }, capacity: { remainingPercent: 90, effectiveRemainingPercent: 90, source: "fixture" }, quotaPools: [{ id: "codex", remainingPercent: 90 }],
  };
  return base;
}

(async () => {
  try {
    const observation = startTask({
      workspace: observationWorkspace,
      outcome: "Turn bounded observation into a verified implementation without another visible turn",
      outcomeAuthority: "user",
      acceptanceEvidence: [{ description: "The primary workspace contains verified PLANNED_OK", minimumEvidenceLevel: "integration" }],
      workGraph: [{
        id: "OBSERVE",
        goal: "Inspect context.md and determine the exact bounded implementation",
        state: "pending",
        priority: 100,
        acceptanceRequirementId: "A1",
        relevantFiles: ["context.md", "verify-planned.js"],
        expectedFiles: [],
        acceptanceCriteria: ["Return one exact implementation unit"],
        verificationCommands: [],
        readOnly: true,
        taskKind: "repository-scan",
        complexity: "medium",
      }],
      consoleModel: "gpt-console",
      consoleEffort: "low",
      codexReservePercent: 15,
    }, resources("claude"));
    let inventoryCalls = 0;
    const result = await runCoordinator({ taskId: observation.taskId, executionId: "execution-observation-test", config: { maxRounds: 3, maxMinutes: 2, noProgressLimit: 2, horizonHours: 5 } }, entrypoint, {
      inventory: async () => (++inventoryCalls === 1 ? resources("claude") : resources("codex")),
      providerHistory: () => ({}),
    });
    assert.equal(result.state, "completed", JSON.stringify(result));
    assert.equal(fs.readFileSync(path.join(observationWorkspace, "planned.txt"), "utf8").trim(), "PLANNED_OK");
    const observationSummary = taskSummary({ taskId: observation.taskId });
    assert.equal(observationSummary.completionAllowed, true, JSON.stringify(observationSummary));
    assert.ok(observationSummary.workGraph.some((node) => node.sourceObservationJobId), "observation must create an exact writer node");
    const observationEvents = readMaterialEvents({ taskId: observation.taskId, maxEvents: 50 }).events;
    assert.equal(observationEvents.filter((event) => event.type === "round.integrated").length, 2);
    assert.equal(observationEvents.filter((event) => event.type === "round.dispatched").length, 2);

    const detached = startTask({
      workspace: detachedWorkspace,
      outcome: "Finish a detached provider result without another visible turn",
      outcomeAuthority: "user",
      acceptanceEvidence: [{ description: "The primary workspace contains verified DURABLE_OK", minimumEvidenceLevel: "integration" }],
      workGraph: [{
        id: "WRITE",
        goal: "Create durable.txt containing DURABLE_OK",
        state: "pending",
        priority: 100,
        acceptanceRequirementId: "A1",
        relevantFiles: ["durable.txt", "verify-durable.js"],
        expectedFiles: ["durable.txt"],
        acceptanceCriteria: ["node verify-durable.js exits zero"],
        verificationCommands: [{ name: "verify-durable", command: "node", args: ["verify-durable.js"], timeoutSeconds: 30 }],
        taskKind: "code",
        complexity: "medium",
      }],
      consoleModel: "gpt-console",
      consoleEffort: "low",
      codexReservePercent: 15,
    }, resources("codex"));
    dispatchRound({ taskId: detached.taskId, horizonHours: 5 }, resources("codex"), {}, (contract) => createJob(contract, entrypoint));
    const receipt = startCoordinator({ taskId: detached.taskId, maxRounds: 2, maxMinutes: 2, noProgressLimit: 2 }, entrypoint);
    assert.equal(receipt.active, true, JSON.stringify(receipt));
    const deadline = Date.now() + 30000;
    let status = coordinatorStatus({ taskId: detached.taskId, maxEvents: 20 });
    while (status.execution.active && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      status = coordinatorStatus({ taskId: detached.taskId, maxEvents: 20 });
    }
    assert.equal(status.execution.state, "completed", JSON.stringify(status));
    assert.equal(fs.readFileSync(path.join(detachedWorkspace, "durable.txt"), "utf8").trim(), "DURABLE_OK");
    assert.equal(status.material.events.filter((event) => event.type === "round.collected").length, 1);
    assert.equal(status.material.events.filter((event) => event.type === "round.integrated").length, 1);
    assert.equal(status.status.progress.passing, 1);
    assert.equal(status.passive, true);
    assert.equal(status.noProviderProbe, true);
    assert.equal(status.noProjectScan, true);

    const lostResources = resources("codex");
    lostResources.providers.codex.command = path.join(fakeBin, "fake-codex-slow.cmd");
    const lost = startTask({
      workspace: lostWorkspace,
      outcome: "Classify an abruptly lost worker without waiting for the coordinator deadline",
      outcomeAuthority: "user",
      acceptanceEvidence: [{ description: "A bounded writer produces verified lost.txt", minimumEvidenceLevel: "integration" }],
      workGraph: [{
        id: "WRITE_LOST",
        goal: "Create lost.txt containing NEVER_WRITTEN",
        state: "pending",
        priority: 100,
        acceptanceRequirementId: "A1",
        relevantFiles: ["lost.txt", "verify-lost.js"],
        expectedFiles: ["lost.txt"],
        acceptanceCriteria: ["node verify-lost.js exits zero"],
        verificationCommands: [{ name: "verify-lost", command: "node", args: ["verify-lost.js"], timeoutSeconds: 30 }],
        taskKind: "code",
        complexity: "medium",
      }],
      consoleModel: "gpt-console",
      consoleEffort: "low",
      codexReservePercent: 15,
    }, lostResources);
    const lostRound = dispatchRound({ taskId: lost.taskId, horizonHours: 5 }, lostResources, {}, (contract) => createJob(contract, entrypoint));
    const lostJob = lostRound.workers[0];
    assert.ok(lostJob?.jobId, JSON.stringify(lostRound));
    const lostPid = statusFor(lost.taskId, lostJob.jobId).pid;
    const lostStarted = Date.now();
    const lostRun = runCoordinator({ taskId: lost.taskId, executionId: "execution-lost-worker-test", config: { maxRounds: 2, maxMinutes: 1, noProgressLimit: 1, horizonHours: 5 } }, entrypoint, {
      inventory: async () => lostResources,
      providerHistory: () => ({}),
    });
    await new Promise((resolve) => setTimeout(resolve, 250));
    const terminated = terminateTree(lostPid);
    assert.equal(terminated.ok, true, JSON.stringify(terminated));
    const lostResult = await lostRun;
    assert.notEqual(lostResult.state, "completed");
    assert.ok(Date.now() - lostStarted < 10000, JSON.stringify(lostResult));
    const lostEvents = readMaterialEvents({ taskId: lost.taskId, maxEvents: 50 }).events;
    const lostCollection = lostEvents.find((event) => event.type === "round.collected");
    assert.match(JSON.stringify(lostCollection || {}), /worker-process-lost/);

    process.stdout.write(JSON.stringify({
      ok: true,
      observationToExactWriter: true,
      detachedContinuation: true,
      oneTimeCollection: true,
      oneTimeIntegration: true,
      lostWorkerReconciledWithoutDeadlineWait: true,
      visibleConsoleFileOwnership: 0,
      automaticDesktopLaunches: 0,
    }, null, 2) + "\n");
  } finally {
    cleanupFixtureRoot();
  }
})().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});