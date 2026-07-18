#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-mobile-fable-routing-"));
process.env.AI_MOBILE_DATA_ROOT = path.join(root, "state");
process.env.LOCALAPPDATA = path.join(root, "local");
const workspace = path.join(root, "workspace");
fs.mkdirSync(path.join(workspace, ".codex"), { recursive: true });
fs.mkdirSync(path.join(workspace, "src"), { recursive: true });
fs.mkdirSync(path.join(workspace, "docs"), { recursive: true });
fs.mkdirSync(path.join(workspace, "tools"), { recursive: true });
fs.writeFileSync(path.join(workspace, ".codex", "PROJECT_OUTCOME.md"), "# Project Outcome\n\n## North Star\n\nShip truthful model routing.\n", "utf8");
fs.writeFileSync(path.join(workspace, ".codex", "ACCEPTANCE.json"), JSON.stringify({
  schema_version: 1,
  project_state: "active",
  current_slice_requirement_id: "ROUTING",
  requirements: [
    { id: "ROUTING", description: "Routing reports every provider truthfully.", required: true, status: "failing", minimum_evidence_level: "integration", evidence: [], blocker: null },
  ],
}, null, 2) + "\n", "utf8");

const { dispatchRound, startTask } = require("./core/task-orchestrator");
const resources = { generatedAt: new Date().toISOString(), providers: {
  codex: { available: true, authenticated: true, authMode: "chatgpt", command: "codex", models: [{ id: "gpt-5.6-sol", description: "frontier capable model" }], capacity: { effectiveRemainingPercent: 78 }, quotaPools: [] },
  claude: { available: true, authenticated: true, authMode: "subscription", command: "claude", models: [{ id: "fable" }, { id: "sonnet" }], capacity: { remainingPercent: 80 }, quotaPools: [] },
  antigravity: { available: true, authenticated: true, authMode: "cli-session", command: "agy", models: [{ id: "gemini-3.5-flash-medium", displayName: "Gemini Flash" }], capacity: { remainingPercent: 90 }, quotaPools: [] },
  cursor: { available: false, authenticated: false, reason: "headless cursor-agent is not installed", models: [], quotaPools: [] },
} };

let sequence = 0;
function fakeCreate(contract) {
  sequence += 1;
  return { taskId: contract.taskId, jobId: "job-fable-" + sequence, state: "running", provider: contract.provider, model: contract.model || "", isolation: "shared-read-only" };
}

try {
  // 1. An explicit Fable request in the recorded user text must dispatch a real
  //    Claude worker instead of leaving the provider idle behind the premium gate.
  const fableTask = startTask({ workspace, userRequest: "Use Claude Fable to improve the plugin routing", currentCodexModel: "gpt-5.6-sol" }, resources);
  const fableRound = dispatchRound({
    taskId: fableTask.taskId,
    workUnits: [{
      goal: "Review provider routing documentation for truthfulness gaps",
      independenceReason: "Read-only documentation review is disjoint from the orchestrator implementation",
      relevantFiles: ["docs"],
      readOnly: true,
      complexity: "large",
      taskKind: "review",
      estimatedDirectTokens: 12000,
      model: "fable",
    }],
  }, resources, {}, fakeCreate);
  assert.equal(fableRound.workers.length, 1, "Fable lane was not dispatched: " + JSON.stringify(fableRound.rejected));
  assert.equal(fableRound.workers[0].provider, "claude");
  assert.equal(fableRound.workers[0].model, "fable");
  assert.match(fableRound.workers[0].reason, /user request explicitly names "fable"/i);
  const fableClaude = fableRound.resources.providers.find((row) => row.provider === "claude");
  assert.equal(fableClaude.status, "selected");
  assert.equal(fableClaude.model, "fable");
  assert.equal(fableClaude.jobId, fableRound.workers[0].jobId);
  assert.match(fableClaude.reason, /callable CLI worker job/i);
  assert.equal(fableRound.resources.providers.find((row) => row.provider === "codex-cli").status, "idle");

  // 2. A premium model the user never asked for stays gated, and the resource
  //    report must state the concrete gate instead of a generic idle reason.
  const gatedTask = startTask({ workspace, userRequest: "Harden the routing status output", currentCodexModel: "gpt-5.6-sol" }, resources);
  const gatedRound = dispatchRound({
    taskId: gatedTask.taskId,
    workUnits: [{
      goal: "Review provider routing documentation for truthfulness gaps",
      independenceReason: "Read-only documentation review is disjoint from the orchestrator implementation",
      relevantFiles: ["docs"],
      readOnly: true,
      complexity: "large",
      taskKind: "review",
      estimatedDirectTokens: 12000,
      preferredProvider: "claude",
      model: "fable",
    }],
  }, resources, {}, fakeCreate);
  assert.equal(gatedRound.workers.length, 0);
  assert.match(gatedRound.rejected[0].reason, /not policy-enabled/i);
  const gatedClaude = gatedRound.resources.providers.find((row) => row.provider === "claude");
  assert.equal(gatedClaude.status, "idle");
  assert.match(gatedClaude.reason, /"fable" is not policy-enabled/i);
  assert.doesNotMatch(gatedClaude.reason, /^No independently owned/i);

  // 3. A dispatched Codex worker is always reported as codex-cli with its job id,
  //    so Codex CLI use is never ambiguous with current Codex.
  const codexTask = startTask({ workspace, userRequest: "Use a Codex CLI worker on gpt-5.6-sol for the disjoint scan", currentCodexModel: "gpt-5.6-sol" }, resources);
  const codexRound = dispatchRound({
    taskId: codexTask.taskId,
    workUnits: [{
      goal: "Scan repository tooling for stale provider assumptions",
      independenceReason: "Read-only tooling scan is disjoint from the orchestrator implementation",
      relevantFiles: ["tools"],
      readOnly: true,
      complexity: "large",
      taskKind: "repository-scan",
      estimatedDirectTokens: 12000,
      preferredProvider: "codex",
      selectionAuthority: "user",
      model: "gpt-5.6-sol",
    }],
  }, resources, {}, fakeCreate);
  assert.equal(codexRound.workers.length, 1, "Codex CLI lane was not dispatched: " + JSON.stringify(codexRound.rejected));
  const codexEntry = codexRound.resources.providers.find((row) => row.provider === "codex-cli");
  assert.equal(codexEntry.status, "selected");
  assert.equal(codexEntry.jobId, codexRound.workers[0].jobId);
  assert.match(codexEntry.reason, /callable CLI worker job/i);
  assert.equal(codexRound.resources.providers.some((row) => row.provider === "codex"), false);
  assert.equal(codexRound.resources.selected.find((row) => row.actor === "external-worker").provider, "codex-cli");
  assert.equal(codexRound.resources.selected.find((row) => row.actor === "visible-console").model, "gpt-5.6-sol");

  process.stdout.write(JSON.stringify({ ok: true, explicitFableDispatched: true, unrequestedPremiumStillGatedWithConcreteReason: true, codexCliUnambiguous: true }, null, 2) + "\n");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
