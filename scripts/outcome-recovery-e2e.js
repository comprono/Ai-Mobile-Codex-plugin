#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-mobile-outcome-recovery-"));
process.env.AI_MOBILE_DATA_ROOT = path.join(root, "state");
process.env.LOCALAPPDATA = path.join(root, "local");

const {
  collectRound,
  completeTask,
  dispatchRound,
  reconcileTask,
  recordEvidence,
  startTask,
  taskSummary,
} = require("./core/task-orchestrator");
const { jobDirectory, readPortfolioRound, readRound } = require("./core/state-store");
const { writeJson } = require("./core/utils");

const resources = {
  generatedAt: new Date().toISOString(),
  providers: {
    codex: { available: true, authenticated: true, authMode: "chatgpt", models: [{ id: "gpt-fixture" }], capacity: { effectiveRemainingPercent: 80 }, quotaPools: [] },
    claude: { available: true, authenticated: true, authMode: "subscription", command: "claude", models: [{ id: "sonnet" }], capacity: { remainingPercent: 80 }, quotaPools: [] },
    antigravity: { available: true, authenticated: true, authMode: "cli-session", command: "agy", models: [{ id: "gemini-flash" }], capacity: { remainingPercent: 90 }, quotaPools: [] },
    cursor: { available: false, authenticated: false, models: [], quotaPools: [] },
  },
};

function makeWorkspace(name) {
  const workspace = path.join(root, name);
  fs.mkdirSync(path.join(workspace, ".codex"), { recursive: true });
  fs.mkdirSync(path.join(workspace, "src"), { recursive: true });
  fs.mkdirSync(path.join(workspace, "docs"), { recursive: true });
  fs.writeFileSync(path.join(workspace, ".codex", "PROJECT_OUTCOME.md"), [
    "# Project Outcome",
    "",
    "State: active",
    "",
    "## North Star",
    "",
    "Restore verified application throughput with truthful, unique, canonically confirmed results.",
    "",
    "## User Intent",
    "",
    "Keep improving the real system until verified throughput is restored.",
    "",
  ].join("\n"), "utf8");
  writeJson(path.join(workspace, ".codex", "ACCEPTANCE.json"), {
    schema_version: 1,
    project_state: "active",
    current_slice_requirement_id: "THROUGHPUT",
    requirements: [
      { id: "RUNTIME", description: "Runtime recovery is verified end to end.", required: true, status: "failing", minimum_evidence_level: "end-to-end", evidence: [] },
      { id: "THROUGHPUT", description: "A unique canonical result is observed at the required cadence.", required: true, status: "failing", minimum_evidence_level: "end-to-end", evidence: [] },
    ],
  });
  return workspace;
}

let sequence = 0;
function completedJob(contract) {
  sequence += 1;
  const jobId = "job-fixture-" + String(sequence).padStart(4, "0");
  const dir = jobDirectory(contract.taskId, jobId);
  fs.mkdirSync(dir, { recursive: true });
  writeJson(path.join(dir, "contract.json"), {
    ...contract,
    jobId,
    executionWorkspace: contract.workspace,
    isolation: { mode: "shared-read-only", executionWorkspace: contract.workspace },
  });
  writeJson(path.join(dir, "status.json"), {
    taskId: contract.taskId,
    jobId,
    state: "completed",
    provider: contract.provider,
    model: contract.model || "",
    finishedAt: new Date().toISOString(),
  });
  writeJson(path.join(dir, "handoff.json"), {
    schemaVersion: 1,
    state: "completed",
    summary: "Bounded fixture evidence is ready for integration.",
    changedFiles: [],
    patchAvailable: false,
    verification: null,
    blocker: "",
    integrationAction: contract.integrationAction || "",
    projectCompleteAllowed: false,
  });
  return { taskId: contract.taskId, jobId, state: "running", provider: contract.provider, model: contract.model || "", isolation: "shared-read-only" };
}

try {
  const workspace = makeWorkspace("operational-project");
  const recovered = startTask({
    workspace,
    outcome: "Perform a bounded architecture and live-state review of the project.",
    userRequest: "Fix the project and restore verified application throughput.",
    currentCodexModel: "gpt-5.6-sol",
  }, resources);
  assert.equal(recovered.outcome, "Restore verified application throughput with truthful, unique, canonically confirmed results.");
  assert.equal(recovered.outcomeReconciliation.changed, true);
  assert.equal(recovered.outcomeReconciliation.source, "project-contract");
  assert.deepEqual(recovered.projectContext.sources, [".codex/PROJECT_OUTCOME.md", ".codex/ACCEPTANCE.json"]);
  assert.deepEqual(recovered.requirements.map((row) => row.id), ["RUNTIME", "THROUGHPUT"]);
  assert.deepEqual(recovered.workGraph.map((row) => row.id), ["R-RUNTIME", "R-THROUGHPUT"]);
  assert.equal(recovered.workGraph.find((row) => row.id === "R-THROUGHPUT").priority, 100);
  assert.equal(recovered.currentCodex.requirementId, "THROUGHPUT");
  assert.equal(recovered.currentCodex.workGraphNodeId, "R-THROUGHPUT");

  const explicitReview = startTask({
    workspace,
    outcome: "Produce a bounded architecture review.",
    userRequest: "Produce only an architecture review as the final deliverable.",
    acceptanceEvidence: ["The requested architecture review is delivered."],
    outcomeAuthority: "user",
  }, resources);
  assert.equal(explicitReview.outcome, "Produce a bounded architecture review.");
  assert.equal(explicitReview.outcomeReconciliation.changed, false);
  assert.equal(explicitReview.outcomeReconciliation.source, "latest-user-request");

  const stale = startTask({
    workspace,
    outcome: "Produce a bounded architecture review.",
    userRequest: "Produce only an architecture review as the final deliverable.",
    acceptanceEvidence: ["The requested architecture review is delivered."],
    outcomeAuthority: "user",
  }, resources);
  const staleRound = dispatchRound({
    taskId: stale.taskId,
    currentCodex: { goal: "Inspect runtime source", files: ["src"] },
    workUnits: [{
      goal: "Review project documentation for independent evidence",
      independenceReason: "Documentation evidence is disjoint from runtime source inspection.",
      relevantFiles: ["docs"],
      readOnly: true,
      complexity: "large",
      taskKind: "review",
      estimatedDirectTokens: 12000,
    }],
  }, resources, {}, completedJob);
  assert.equal(staleRound.state, "running");
  const refusedRevision = reconcileTask({
    taskId: stale.taskId,
    userRequest: "Fix the project and restore verified application throughput.",
    refreshProjectContext: true,
    cancelActiveWorkers: false,
  });
  assert.equal(refusedRevision.reconciliationAllowed, false);
  assert.equal(readRound(stale.taskId, staleRound.roundId).state, "running");
  const reconciled = reconcileTask({
    taskId: stale.taskId,
    userRequest: "Fix the project and restore verified application throughput.",
    refreshProjectContext: true,
  });
  assert.equal(reconciled.reconciliationAllowed, true);
  assert.equal(reconciled.outcome, recovered.outcome);
  assert.equal(reconciled.contractVersion, 2);
  assert.equal(readRound(stale.taskId, staleRound.roundId).state, "invalidated");
  assert.equal(reconciled.cancelledWorkers.length, 1);
  assert.throws(() => collectRound({ taskId: stale.taskId, roundId: staleRound.roundId }), /invalidated by a task contract revision/i);
  assert.deepEqual(reconciled.requirements.map((row) => row.id), ["RUNTIME", "THROUGHPUT"]);

  const completedBeforeRevision = startTask({
    workspace,
    outcome: "Deliver the original verified release.",
    userRequest: "Deliver the original verified release.",
    outcomeAuthority: "user",
    minimumEvidenceLevel: "integration",
    acceptanceEvidence: [
      { id: "KEEP", description: "Stable integration evidence remains valid.", minimumEvidenceLevel: "integration" },
      { id: "OLD", description: "The original release requirement passes.", minimumEvidenceLevel: "integration" },
    ],
  }, resources);
  recordEvidence({
    taskId: completedBeforeRevision.taskId,
    evidence: [
      { requirementId: "KEEP", level: "integration", ref: "stable-check", summary: "Stable integration evidence passed.", passed: true },
      { requirementId: "OLD", level: "integration", ref: "old-check", summary: "Original release evidence passed.", passed: true },
    ],
  });
  assert.equal(completeTask({ taskId: completedBeforeRevision.taskId }).completionAllowed, true);
  const reopened = reconcileTask({
    taskId: completedBeforeRevision.taskId,
    outcome: "Deliver the corrected verified release.",
    userRequest: "Deliver the corrected verified release.",
    outcomeAuthority: "user",
    minimumEvidenceLevel: "integration",
    acceptanceEvidence: [
      { id: "KEEP", description: "Stable integration evidence remains valid.", minimumEvidenceLevel: "integration" },
      { id: "NEW", description: "The corrected release requirement passes.", minimumEvidenceLevel: "integration" },
    ],
  });
  assert.equal(reopened.state, "active");
  assert.equal(reopened.completionAllowed, false);
  assert.equal(reopened.requirements.find((row) => row.id === "KEEP").status, "passing");
  assert.equal(reopened.requirements.find((row) => row.id === "KEEP").evidenceCount, 1);
  assert.equal(reopened.requirements.find((row) => row.id === "NEW").status, "failing");
  assert.equal(reopened.requirements.some((row) => row.id === "OLD"), false);

  const secondaryWorkspace = makeWorkspace("secondary-operational-project");
  const portfolio = startTask({
    outcome: "Restore both disposable operational projects.",
    projects: [
      { projectId: "primary", workspace, priority: 100 },
      { projectId: "secondary", workspace: secondaryWorkspace, priority: 50 },
    ],
  }, resources);
  const portfolioRound = dispatchRound({
    portfolioId: portfolio.portfolioId,
    currentCodex: { projectId: "primary", goal: "Advance the primary current slice", files: ["src"] },
    workUnits: [{
      projectId: "secondary",
      goal: "Gather secondary cadence evidence",
      workGraphNodeId: "R-THROUGHPUT",
      independenceReason: "The second disposable project is independently owned.",
      relevantFiles: ["docs"],
      readOnly: true,
      complexity: "large",
      taskKind: "review",
      estimatedDirectTokens: 12000,
    }],
  }, resources, {}, completedJob);
  assert.equal(portfolioRound.workers.length, 1);
  reconcileTask({
    portfolioId: portfolio.portfolioId,
    projectId: "secondary",
    userRequest: "Restore verified secondary throughput under the refreshed contract.",
    refreshProjectContext: true,
  });
  const invalidatedPortfolioRound = readPortfolioRound(portfolio.portfolioId, portfolioRound.roundId);
  assert.equal(invalidatedPortfolioRound.state, "invalidated");
  assert.equal(invalidatedPortfolioRound.jobs.length, 0);
  assert.equal(invalidatedPortfolioRound.invalidatedJobs.length, 1);
  assert.throws(
    () => collectRound({ portfolioId: portfolio.portfolioId, roundId: portfolioRound.roundId }),
    /invalidated by a project contract revision/i,
  );

  const rejected = dispatchRound({
    taskId: recovered.taskId,
    currentCodex: { goal: "Implement runtime recovery", files: ["src"] },
    workUnits: [{
      goal: "Review and implement runtime recovery",
      independenceReason: "Claimed parallel work.",
      relevantFiles: ["src"],
      readOnly: true,
      complexity: "large",
      taskKind: "review",
      estimatedDirectTokens: 12000,
    }],
  }, resources, {}, completedJob);
  assert.equal(rejected.state, "direct");
  assert.equal(rejected.recoveryPlan.transitions[0].failureClass, "ownership-conflict");
  assert.equal(rejected.recoveryPlan.transitions[0].owner, "current-codex");
  assert.match(rejected.recoveryPlan.transitions[0].recoveryAction, /Do not retry/i);

  const roundTask = startTask({ workspace, userRequest: "Restore the project outcome." }, resources);
  const round = dispatchRound({
    taskId: roundTask.taskId,
    currentCodex: { goal: "Implement runtime recovery", files: ["src"] },
    workUnits: [{
      goal: "Gather cadence evidence from project documentation",
      workGraphNodeId: "R-THROUGHPUT",
      independenceReason: "Cadence evidence is read-only and disjoint from runtime implementation.",
      relevantFiles: ["docs"],
      readOnly: true,
      complexity: "large",
      taskKind: "review",
      estimatedDirectTokens: 12000,
    }],
  }, resources, {}, completedJob);
  assert.equal(round.workers.length, 1);
  const collected = collectRound({ taskId: roundTask.taskId, roundId: round.roundId, waitSeconds: 0 });
  assert.equal(collected.state, "ready-for-integration");
  assert.equal(collected.recoveryPlan.owner, "current-codex");
  assert.equal(collected.recoveryPlan.state, "awaiting-evidence");
  assert.equal(collected.recoveryPlan.requirementId, "THROUGHPUT");
  assert.equal(collected.recoveryPlan.workGraphNodeId, "R-THROUGHPUT");
  assert.equal(collected.recoveryPlan.integrations[0].workGraphNodeId, "R-THROUGHPUT");
  assert.equal(collected.recoveryPlan.integrations[0].requirementId, "THROUGHPUT");
  assert.equal(taskSummary({ taskId: roundTask.taskId }).latestRound.state, "ready-for-integration");

  process.stdout.write(JSON.stringify({
    ok: true,
    recoveredOutcome: recovered.outcome,
    importedRequirements: recovered.requirements.length,
    reconciledContractVersion: reconciled.contractVersion,
    staleRevisionRefusedBeforeCancellation: true,
    completedTaskReopened: true,
    portfolioRevisionIsolated: true,
    rejectionRecovery: rejected.recoveryPlan.transitions[0].failureClass,
    terminalNextRequirement: collected.recoveryPlan.requirementId,
  }, null, 2) + "\n");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
