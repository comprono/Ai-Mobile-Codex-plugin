#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { orchestrateTask } = require("./core/task-orchestrator");

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ai-mobile-orchestration-"));
const resources = { providers: {
  codex: { available: true, authenticated: true, authMode: "chatgpt", models: [{ id: "gpt-5.6-sol" }], capacity: { effectiveRemainingPercent: 85 } },
  claude: { available: true, authenticated: true, authMode: "subscription", models: [{ id: "sonnet" }], capacity: { windows: [{ scope: "all", remainingPercent: 70, resetAt: "2026-07-14T12:00:00Z" }] } },
  antigravity: { available: true, authenticated: true, authMode: "cli-session", models: [{ id: "gemini-3.5-flash-medium" }], capacity: { remainingPercent: 90 } },
  cursor: { available: false, authenticated: false, reason: "No headless agent." },
} };

const dispatched = [];
const args = {
  workspace,
  rootOutcome: "Sustain one authoritative, unique, policy-compliant transaction every seven minutes.",
  completionEvidence: [
    "Each transaction has an authoritative confirmation identifier.",
    "No duplicate or policy-violating transaction occurs.",
    "The cadence is verified over a representative soak period.",
  ],
  currentCodexGoal: "Repair and verify the live executor path end to end.",
  currentCodexFiles: ["runtime"],
  currentCodexAcceptanceCriteria: ["The executor is live and produces authoritative evidence."],
  allowAntigravity: true,
  candidateLanes: [
    {
      goal: "Find the exact eligibility and queue blockers from source evidence.",
      independenceReason: "This read-only analysis owns policy and queue code while Codex owns the live executor.",
      relevantFiles: ["workflow/eligibility"],
      readOnly: true,
      preferredProvider: "claude",
      taskKind: "debug",
      complexity: "large",
      estimatedDirectTokens: 14000,
    },
    {
      goal: "Audit discovery throughput and return only measured bottlenecks.",
      independenceReason: "This read-only audit owns discovery code while Codex owns runtime execution and the other worker owns eligibility.",
      relevantFiles: ["workflow/discovery"],
      readOnly: true,
      preferredProvider: "antigravity",
      allowAntigravity: true,
      taskKind: "repository-scan",
      complexity: "large",
      estimatedDirectTokens: 10000,
    },
  ],
};

try {
  const result = orchestrateTask(args, resources, {}, (contract) => {
    const receipt = { jobId: `job-regression-${dispatched.length + 1}`, state: "running", provider: contract.provider, artifactDirectory: path.join(workspace, ".ai-mobile", "jobs", `job-regression-${dispatched.length + 1}`) };
    dispatched.push({ contract, receipt });
    return receipt;
  });

  assert.equal(result.workersStarted, 2, "independent useful lanes must be dispatched instead of stopping after inventory");
  assert.deepEqual(dispatched.map((item) => item.contract.provider), ["claude", "antigravity"]);
  assert.equal(result.currentCodex.goal, args.currentCodexGoal, "Codex must retain concrete project work");
  assert.equal(result.completionFirewall.projectCompleteAllowed, false, "a restart or worker result cannot complete the root outcome");
  assert.deepEqual(result.completionEvidence, args.completionEvidence);
  assert.match(result.nextAction, /Start the current-Codex lane now/i);
  assert.doesNotMatch(JSON.stringify(result), /providerCommand|run-project-manager|project-manager-status|heartbeat status/i);
  assert.ok(JSON.stringify(result).length < 18000, "the startup receipt must remain compact");
  assert.ok(fs.existsSync(path.join(workspace, ".ai-mobile", "tasks", `${result.taskId}.json`)), "the finite task contract must be durable");

  process.stdout.write(`${JSON.stringify({
    ok: true,
    simulated: true,
    modelCalls: 0,
    workersStarted: result.workersStarted,
    providers: result.workers.map((worker) => worker.provider),
    codexLaneActive: Boolean(result.currentCodex.goal),
    projectCompleteAllowed: result.completionFirewall.projectCompleteAllowed,
    receiptCharacters: JSON.stringify(result).length,
  }, null, 2)}\n`);
} finally {
  fs.rmSync(workspace, { recursive: true, force: true });
}
