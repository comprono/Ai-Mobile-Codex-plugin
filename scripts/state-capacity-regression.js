#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-mobile-v1-state-"));
const workspace = path.join(root, "workspace");
process.env.AI_MOBILE_DATA_ROOT = path.join(root, "state");
fs.mkdirSync(workspace, { recursive: true });

const { createTaskRecord, readTask, stateRoot, updateTask } = require("./core/state-store");
const { inventory } = require("./core/capacity");

function git(args) {
  const result = spawnSync("git", args, { cwd: workspace, encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

async function run() {
  git(["init"]);
  git(["config", "user.email", "ai-mobile@example.invalid"]);
  git(["config", "user.name", "AI Mobile Test"]);
  fs.writeFileSync(path.join(workspace, "README.md"), "fixture\n", "utf8");
  git(["add", "README.md"]);
  git(["commit", "-m", "fixture"]);

  const first = createTaskRecord({ workspace, outcome: "first", requirements: [], constraints: [] });
  const second = createTaskRecord({ workspace, outcome: "second", requirements: [], constraints: [] });
  assert.notEqual(first.taskId, second.taskId, "concurrent tasks must have unique ids");
  assert.equal(fs.existsSync(path.join(workspace, ".ai-mobile")), false, "runtime state must not enter the project");
  assert.ok(stateRoot().startsWith(root), "test state must be central");

  git(["checkout", "-b", "state-test"]);
  updateTask(first.taskId, (task) => ({ ...task, currentCodex: { goal: "critical path" } }));
  assert.equal(readTask(first.taskId).currentCodex.goal, "critical path", "task must survive branch changes");
  assert.equal(readTask(second.taskId).outcome, "second", "same-workspace tasks must remain independent");

  let unavailableCalls = 0;
  const unavailableProbe = async (id) => {
    unavailableCalls += 1;
    return { id, available: false, authenticated: false, confidence: "high", models: [], reason: "fixture unavailable" };
  };
  const initial = await inventory({ refresh: true, probe: unavailableProbe });
  assert.equal(initial.providers.claude.available, false);
  assert.equal(unavailableCalls, 4);

  let refreshCalls = 0;
  const recoveredProbe = async (id) => {
    refreshCalls += 1;
    return id === "claude"
      ? { id, available: true, authenticated: true, confidence: "high", models: [{ id: "sonnet" }], capacity: { remainingPercent: 80, source: "fixture" } }
      : { id, available: false, authenticated: false, confidence: "high", models: [], reason: "fixture unavailable" };
  };
  const recovered = await inventory({ forDispatch: true, probe: recoveredProbe });
  assert.equal(recovered.providers.claude.available, true, "cached negative must be re-probed before dispatch");
  assert.ok(refreshCalls >= 1);

  let cachedProbeCalls = 0;
  const cached = await inventory({ probe: async () => { cachedProbeCalls += 1; throw new Error("positive cache should be reused"); } });
  assert.equal(cached.providers.claude.available, true);
  assert.equal(cachedProbeCalls, 0, "fresh positive evidence should avoid repeated probes");

  process.stdout.write(`${JSON.stringify({ ok: true, taskIds: [first.taskId, second.taskId], staleNegativeRecovered: true, workspaceStateCreated: false }, null, 2)}\n`);
}

run().finally(() => fs.rmSync(root, { recursive: true, force: true })).catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
