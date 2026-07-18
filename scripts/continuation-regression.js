#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-mobile-continuation-"));
process.env.AI_MOBILE_DATA_ROOT = path.join(root, "state");
process.env.LOCALAPPDATA = path.join(root, "local");
const workspace = path.join(root, "workspace");
fs.mkdirSync(path.join(workspace, ".codex"), { recursive: true });
fs.mkdirSync(path.join(workspace, "src"), { recursive: true });
fs.mkdirSync(path.join(workspace, "tools"), { recursive: true });
fs.writeFileSync(path.join(workspace, ".codex", "PROJECT_OUTCOME.md"), ["# Project Outcome", "", "## North Star", "", "Ship verified operational throughput.", ""].join(String.fromCharCode(10)), "utf8");

const blocker = {
  owner: "project runtime",
  reason: "Current database integrity is unsafe.",
  recovery_trigger: "A guarded repair reports zero issues.",
  recovery_action: "Run the guarded repair, verify startup preflight, and resume the authorized lane.",
};
fs.writeFileSync(path.join(workspace, ".codex", "ACCEPTANCE.json"), JSON.stringify({
  schema_version: 1,
  project_state: "active",
  current_slice_requirement_id: "REPAIR",
  requirements: [
    { id: "REPAIR", description: "Runtime integrity is safe.", required: true, status: "blocked", minimum_evidence_level: "end-to-end", evidence: [], blocker },
    { id: "PARSER", description: "The parser handles grouped controls correctly.", required: true, status: "failing", minimum_evidence_level: "integration", evidence: [], blocker: null },
  ],
}, null, 2), "utf8");

const { dispatchRound, startTask, taskSummary } = require("./core/task-orchestrator");
const resources = { generatedAt: new Date().toISOString(), providers: {
  codex: { available: true, authenticated: true, authMode: "chatgpt", command: "codex", models: [{ id: "gpt-5.6-sol", description: "frontier capable model" }], capacity: { effectiveRemainingPercent: 78 }, quotaPools: [] },
  claude: { available: true, authenticated: true, authMode: "subscription", command: "claude", models: [{ id: "sonnet" }], capacity: { remainingPercent: 80 }, quotaPools: [] },
  antigravity: { available: true, authenticated: true, authMode: "cli-session", command: "agy", models: [{ id: "gemini-3.5-flash-medium", displayName: "Gemini Flash" }], capacity: { remainingPercent: 90 }, quotaPools: [] },
  cursor: { available: false, authenticated: false, reason: "headless cursor-agent is not installed", models: [], quotaPools: [] },
} };

let sequence = 0;
function fakeCreate(contract) {
  sequence += 1;
  return { taskId: contract.taskId, jobId: "job-continuation-" + sequence, state: "running", provider: contract.provider, model: contract.model || "", isolation: contract.readOnly ? "shared-read-only" : "isolated-git-worktree" };
}

try {
  const started = startTask({ workspace, userRequest: "Finish the operational project", consoleModel: "gpt-5.6-luna", consoleEffort: "low", codexReservePercent: 15 }, resources);
  const blocked = started.requirements.find((row) => row.id === "REPAIR");
  assert.equal(blocked.blocker.owner, "project runtime");
  assert.match(blocked.blocker.recoveryAction, /guarded repair/i);
  assert.equal(started.console.role, "project-console");
  assert.equal(started.workPlane.plan.requirementId, "PARSER");
  assert.equal(started.execution.mustDispatchNow, true);
  assert.equal(started.execution.mustStartNow, false);
  assert.equal(started.execution.mayEndTurn, false);
  assert.match(started.execution.workPlaneAction, /PARSER/);
  assert.equal(started.resources.selected[0].actor, "visible-console");
  assert.equal(started.resources.selected[0].model, "gpt-5.6-luna");
  assert.equal(started.resources.providers.find((row) => row.provider === "claude").status, "idle");
  assert.equal(started.resources.providers.find((row) => row.provider === "cursor").status, "unavailable");
  assert.equal(started.resources.providers.find((row) => row.provider === "codex-cli").status, "idle");

  const round = dispatchRound({
    taskId: started.taskId,
    workUnits: [{
      goal: "Inspect independent runtime-repair evidence and return a compact risk note",
      independenceReason: "The console owns no files and this is an acceptance-linked work-plane unit",
      relevantFiles: ["tools"],
      readOnly: true,
      complexity: "large",
      taskKind: "repository-scan",
      estimatedDirectTokens: 12000,
      preferredProvider: "claude",
      selectionAuthority: "user",
      model: "sonnet",
      workGraphNodeId: "R-PARSER",
    }],
  }, resources, {}, fakeCreate);
  assert.equal(round.workers.length, 1);
  assert.equal(round.execution.mustStartNow, false);
  assert.equal(round.execution.status, "workers-running");
  assert.match(round.execution.action, /Collect this finite round/i);
  assert.equal(round.resources.selected.find((row) => row.actor === "external-worker").model, "sonnet");
  assert.equal(taskSummary({ taskId: started.taskId }).requirements.find((row) => row.id === "REPAIR").blocker.owner, "project runtime");

  const blockedOnly = path.join(root, "blocked-only");
  fs.mkdirSync(path.join(blockedOnly, ".codex"), { recursive: true });
  fs.writeFileSync(path.join(blockedOnly, ".codex", "PROJECT_OUTCOME.md"), ["# Project Outcome", "", "## North Star", "", "Restore the runtime.", ""].join(String.fromCharCode(10)), "utf8");
  fs.writeFileSync(path.join(blockedOnly, ".codex", "ACCEPTANCE.json"), JSON.stringify({ schema_version: 1, project_state: "active", current_slice_requirement_id: "REPAIR", requirements: [{ id: "REPAIR", description: "Runtime integrity is safe.", required: true, status: "blocked", minimum_evidence_level: "end-to-end", evidence: [], blocker }] }, null, 2), "utf8");
  const recovery = startTask({ workspace: blockedOnly, consoleModel: "gpt-5.6-luna" }, resources);
  assert.equal(recovery.execution.mustDispatchNow, true);
  assert.equal(recovery.execution.mustStartNow, false);
  assert.match(recovery.workPlane.recommendedWorkUnits[0].goal, /guarded repair/i);
  const recoveryRound = dispatchRound({ taskId: recovery.taskId }, resources, {}, fakeCreate);
  assert.equal(recoveryRound.workers.length, 1);

  process.stdout.write(JSON.stringify({ ok: true, blockerPreserved: true, consoleLightweight: true, workPlaneDispatched: true, externalModelReported: "sonnet" }, null, 2) + String.fromCharCode(10));
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
