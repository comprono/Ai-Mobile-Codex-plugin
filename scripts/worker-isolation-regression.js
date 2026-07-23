#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-mobile-v1-worker-"));
const workspace = path.join(root, "workspace");
process.env.AI_MOBILE_DATA_ROOT = path.join(root, "state");
process.env.LOCALAPPDATA = path.join(root, "local");
fs.mkdirSync(path.join(workspace, "src"), { recursive: true });
fs.writeFileSync(path.join(workspace, "src", "ui.txt"), "original\n", "utf8");
fs.writeFileSync(path.join(workspace, "src", "api.txt"), "api\n", "utf8");

function git(args) {
  const result = spawnSync("git", args, { cwd: workspace, encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}
git(["init"]);
git(["config", "user.email", "ai-mobile@example.invalid"]);
git(["config", "user.name", "AI Mobile Test"]);
git(["add", "."]);
git(["commit", "-m", "fixture"]);
const workspaceRoot = spawnSync("git", ["-C", workspace, "rev-parse", "--show-toplevel"], { encoding: "utf8", windowsHide: true }).stdout.trim();

const fake = path.join(root, "fake-worker.js");
fs.writeFileSync(fake, 'const fs=require("node:fs"),path=require("node:path");const file=path.join(process.cwd(),"src","ui.txt");fs.appendFileSync(file,"isolated-change\\n");process.stdout.write(JSON.stringify({is_error:false,result:"updated isolated UI file",model:"sonnet",usage:{input_tokens:20,cache_creation_input_tokens:0,cache_read_input_tokens:0,output_tokens:8}}));', "utf8");
let command;
if (process.platform === "win32") {
  command = path.join(root, "ai-mobile-worker.cmd");
  fs.writeFileSync(command, `@echo off\r\n"${process.execPath}" "${fake}" %*\r\n`, "utf8");
} else {
  command = path.join(root, "ai-mobile-worker");
  fs.writeFileSync(command, `#!/bin/sh\n"${process.execPath}" "${fake}" "$@"\n`, "utf8");
  fs.chmodSync(command, 0o755);
}

const { createJob } = require("./core/job-store");
const { jobDirectory } = require("./core/state-store");
const { readJson } = require("./core/utils");
const { collectRound, dispatchRound, startTask } = require("./core/task-orchestrator");
const entrypoint = path.join(__dirname, "ai-mobile-local-mcp.js");
const resources = { generatedAt: new Date().toISOString(), providers: {
  codex: { available: false, authenticated: false, reason: "fixture", models: [], quotaPools: [] },
  claude: { available: true, authenticated: true, authMode: "subscription", command, models: [{ id: "sonnet" }], capacity: { remainingPercent: 80 }, quotaPools: [] },
  antigravity: { available: false, authenticated: false, reason: "not part of this isolation fixture", models: [], quotaPools: [] },
  cursor: { available: false, authenticated: false, reason: "not part of this isolation fixture", models: [], quotaPools: [] },
} };

try {
  const task = startTask({ workspace: workspaceRoot, outcome: "Update UI fixture", acceptanceEvidence: [{ description: "Patch is isolated and ready for integration", minimumEvidenceLevel: "integration" }] }, resources);
  const round = dispatchRound({
    taskId: task.taskId,
    workUnits: [{
      goal: "Implement the independent UI fixture change",
      independenceReason: "The UI file is disjoint from the API file owned by current Codex",
      relevantFiles: ["src/ui.txt"],
      expectedFiles: ["src/ui.txt"],
      readOnly: false,
      complexity: "medium",
      taskKind: "code",
      estimatedDirectTokens: 8000,
      preferredProvider: "claude",
      selectionAuthority: "user",
      integrationAction: "Apply the stored patch once",
    }],
  }, resources, {}, (contract) => createJob(contract, entrypoint));
  assert.equal(round.workers.length, 1);
  assert.equal(round.workers[0].isolation, "isolated-git-worktree");
  const contract = readJson(path.join(jobDirectory(task.taskId, round.workers[0].jobId), "contract.json"), {});
  assert.equal(fs.existsSync(contract.isolation.executionWorkspace), true);
  const collected = collectRound({ taskId: task.taskId, roundId: round.roundId, waitSeconds: 30, detail: "full" });
  assert.equal(collected.results[0].state, "completed", collected.results[0].blocker || "worker failed");
  assert.match(collected.results[0].patch, /isolated-change/);
  assert.equal(fs.readFileSync(path.join(workspace, "src", "ui.txt"), "utf8"), "original\n", "worker must not edit the primary worktree");
  assert.equal(collected.results[0].handoff.patchAvailable, true);
  assert.equal(fs.existsSync(contract.isolation.executionWorkspace), false, "collected writer worktree must be cleaned immediately");
  process.stdout.write(`${JSON.stringify({ ok: true, isolation: round.workers[0].isolation, patchCaptured: true, primaryWorktreeUntouched: true, collectionCleanup: true }, null, 2)}\n`);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
