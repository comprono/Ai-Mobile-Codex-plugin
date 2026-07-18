"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { boundaryAllows, changedFingerprints, collectDiff, fingerprint, statusPaths } = require("./git-evidence");
const { event, setStatus } = require("./job-store");
const { runVerification } = require("./verification");
const { clearInventoryCache } = require("./capacity");
const { bounded, readJson, redact, safeWorkspace, utcNow, writeJson } = require("./utils");
const { jobDirectory } = require("./state-store");
const { releaseResourceLease } = require("./resource-leases");
const { cleanTransientOutputs, rollbackPrimaryWorkspace } = require("./workspace-isolation");
const { runProvider } = require("../providers");
const { normalizeModelId } = require("./trusted-models");

function communicationContract(mode = "smart-compact") {
  if (mode === "detailed") return "Explain the result and material reasoning clearly, without greetings, task repetition, tool narration, waiting commentary, or offers for more work.";
  if (mode === "standard") return "Use concise complete prose. Lead with the result and omit greetings, task repetition, tool narration, waiting commentary, and postambles.";
  return "Think deeply and communicate compactly. Lead with the result. Preserve exact facts, paths, commands, errors, caveats, and evidence. Omit greetings, repeated context, tool narration, waiting commentary, and postambles.";
}

function promptFor(contract) {
  const maxWords = Math.max(220, Math.min(1400, Math.floor((contract.maxWorkerOutputTokens || 1000) * 0.7)));
  return [
    "You are one bounded worker in a finite project round. Complete only the assigned unit.",
    contract.taskContext?.latestUserRequest ? `Latest user request: ${contract.taskContext.latestUserRequest}` : "",
    contract.taskContext?.constraints?.length ? `Project constraints:\n- ${contract.taskContext.constraints.join("\n- ")}` : "",
    contract.taskContext?.unresolvedAcceptance?.length ? `Unresolved project acceptance:\n${contract.taskContext.unresolvedAcceptance.map((item) => `- ${item.id}: ${item.description}${item.blocker ? ` (blocker: ${JSON.stringify(item.blocker)})` : ""}`).join("\n")}` : "",
    `Project outcome: ${contract.projectGoal}`,
    `Your unit: ${contract.goal}`,
    `Visible console role (no project-file ownership): ${contract.currentCodexGoal}`,
    `Why this is independent: ${contract.independenceReason}`,
    `Execution workspace: ${contract.executionWorkspace}`,
    `Mode: ${contract.readOnly ? "read-only" : contract.skipModelReview ? "trusted primary writer" : "isolated writer"}`,
    contract.relevantFiles?.length ? `Read scope: ${contract.relevantFiles.join(", ")}` : "",
    contract.expectedFiles?.length ? `Only allowed write boundaries: ${contract.expectedFiles.join(", ")}` : "Do not modify files.",
    contract.acceptanceCriteria?.length ? `Unit acceptance:\n- ${contract.acceptanceCriteria.join("\n- ")}` : "",
    contract.expectedContribution ? `Required contribution: ${contract.expectedContribution}` : "",
    contract.integrationAction ? `Coordinator integration action: ${contract.integrationAction}` : "",
    contract.skipModelReview ? "You are trusted to edit the bounded primary workspace directly. Finish the unit and run its deterministic checks; do not request another model review." : "",
    "Do not delegate, start another agent, create recurring work, interact with the visible console, or broaden scope.",
    "Read no more than 24 relevant files; stop with one exact blocker if the bounded scope is insufficient.",
    "Run only the deterministic verification commands listed in this contract. Never launch a repository-wide test suite unless that exact command is listed.",
    "Do not claim the project outcome is complete. Return only your unit result, evidence, checks, changed files, and one blocker if present.",
    communicationContract(contract.communicationMode),
    `Hard summary budget: ${contract.maxWorkerOutputTokens || 1000} output tokens, approximately ${maxWords} words. Code changes belong in files, not the summary.`,
  ].filter(Boolean).join("\n\n");
}

function executeWorker(payload) {
  const taskId = String(payload.taskId || "");
  const jobId = String(payload.jobId || "");
  const dir = jobDirectory(taskId, jobId);
  const contract = readJson(path.join(dir, "contract.json"), null);
  if (!contract) throw new Error("Missing job contract.");
  const executionWorkspace = safeWorkspace(contract.executionWorkspace || contract.workspace);
  const observedBoundaries = contract.readOnly ? contract.relevantFiles : contract.expectedFiles;
  const beforeStatus = statusPaths(executionWorkspace);
  const before = fingerprint(executionWorkspace, observedBoundaries, 5000);
  try {
    setStatus(taskId, jobId, { state: "running", pid: process.pid, startedAt: readJson(path.join(dir, "status.json"), {}).startedAt || utcNow() });
    const providerState = { [contract.provider]: { available: true, authenticated: true, command: contract.providerCommand } };
    const runtimeContract = { ...contract, workspace: executionWorkspace };
    const response = runProvider(providerState, runtimeContract, promptFor(contract));
    if (!response.ok || response.typedBlocker) clearInventoryCache();
    const resultLimit = Math.max(1600, Math.min(12000, Number(contract.maxWorkerOutputTokens || 1000) * 4));
    fs.writeFileSync(path.join(dir, "provider-output.txt"), redact(bounded(response.text, resultLimit)), "utf8");

    const transientCleanup = cleanTransientOutputs(contract.isolation || {});
    writeJson(path.join(dir, "transient-cleanup.json"), transientCleanup);
    const afterStatus = statusPaths(executionWorkspace);
    const after = fingerprint(executionWorkspace, observedBoundaries, 5000);
    const statusChanges = afterStatus.paths.filter((file) => !beforeStatus.paths.includes(file));
    const changed = [...new Set([...changedFingerprints(before, after), ...statusChanges])];
    const outside = changed.filter((file) => !boundaryAllows(file, observedBoundaries));
    const mutationViolation = contract.readOnly && changed.length > 0;
    const patch = contract.readOnly ? "" : collectDiff(executionWorkspace, changed);
    writeJson(path.join(dir, "changed-files.json"), changed);
    fs.writeFileSync(path.join(dir, "worker.diff"), patch, "utf8");

    const usage = { provider: contract.provider, ...response.usage, capturedAt: utcNow(), outputBudgetTokens: contract.maxWorkerOutputTokens };
    const inputTokens = Number(usage.inputTokens ?? usage.input_tokens);
    const cachedInputTokens = Number(usage.cachedInputTokens ?? usage.cached_input_tokens);
    const outputTokens = Number(usage.outputTokens ?? usage.output_tokens);
    const equivalentUsd = Number(usage.equivalentUsd ?? usage.total_cost_usd);
    const effectiveInputTokens = Number.isFinite(inputTokens) ? Math.max(0, inputTokens - (Number.isFinite(cachedInputTokens) ? cachedInputTokens : 0)) : null;
    const effectiveTotalTokens = Number.isFinite(effectiveInputTokens) && Number.isFinite(outputTokens) ? effectiveInputTokens + outputTokens : null;
    const totalBudgetTokens = Math.max(2000, Math.min(50000, Number(contract.estimatedDirectTokens || 12000)));
    usage.effectiveInputTokens = effectiveInputTokens;
    usage.effectiveTotalTokens = effectiveTotalTokens;
    usage.totalBudgetTokens = totalBudgetTokens;
    usage.budgetExceeded = (Number.isFinite(outputTokens) && outputTokens > contract.maxWorkerOutputTokens)
      || (Number.isFinite(effectiveTotalTokens) && effectiveTotalTokens > totalBudgetTokens)
      || (contract.providerAuthMode === "api-key" && Number.isFinite(equivalentUsd) && equivalentUsd > contract.maxApiBudgetUsd);
    writeJson(path.join(dir, "usage.json"), usage);

    let blocker = response.typedBlocker ? `${response.typedBlocker}: ${bounded(response.text, 500)}` : "";
    const expectedTrustedModel = contract.isolation?.trustedModel || "";
    const actualModel = normalizeModelId(usage.model);
    if (expectedTrustedModel && actualModel !== normalizeModelId(expectedTrustedModel)) {
      blocker = `model-identity-mismatch: trusted primary writing required ${expectedTrustedModel}, but the provider receipt reported ${usage.model || "unknown"}.`;
    }
    if (outside.length) blocker = `Writer boundary violation: ${outside.join(", ")}`;
    if (mutationViolation) blocker = `Read-only worker modified files: ${changed.join(", ")}`;
    if (!blocker && response.ok && !contract.readOnly && changed.length === 0) {
      blocker = "no-patch-produced: the editing worker changed no files; deterministic verification was skipped.";
    }
    let verification = null;
    if (!blocker && response.ok) {
      verification = runVerification(executionWorkspace, dir, contract.verificationCommands);
      if (verification.required && !verification.passed) blocker = verification.blocker;
    }

    let rollback = null;
    if (contract.skipModelReview === true && (!response.ok || blocker)) {
      rollback = rollbackPrimaryWorkspace(contract.isolation || {}, changed);
      if (!rollback.rolledBack) blocker = `${blocker || "trusted-primary-worker-failed"}; rollback-incomplete: ${JSON.stringify(rollback.failures || rollback.reason)}`;
    }
    const state = !response.ok || blocker ? "failed" : "completed";
    const summary = bounded(response.text, resultLimit);
    fs.writeFileSync(path.join(dir, "result.md"), `${summary}\n`, "utf8");
    writeJson(path.join(dir, "handoff.json"), {
      schemaVersion: 1,
      state,
      summary,
      changedFiles: changed,
      patchAvailable: Boolean(patch),
      patchPath: path.join(dir, "worker.diff"),
      verification,
      blocker,
      integrationAction: contract.integrationAction || "",
      skipModelReview: contract.skipModelReview === true,
      alreadyInPrimaryWorkspace: contract.skipModelReview === true,
      rollback,
      projectCompleteAllowed: false,
    });
    setStatus(taskId, jobId, {
      state,
      finishedAt: utcNow(),
      blocker,
      warning: usage.budgetExceeded ? "worker-budget-exceeded" : "",
      exitCode: response.exitCode ?? null,
      verificationState: verification?.state || "not-requested",
    });
    event(dir, "worker.finished", { state, changedCount: changed.length });
    return state === "completed" ? 0 : 1;
  } catch (error) {
    clearInventoryCache();
    const blocker = `worker-runtime-failed: ${bounded(error.message, 600)}`;
    writeJson(path.join(dir, "handoff.json"), { schemaVersion: 1, state: "failed", summary: "", changedFiles: [], patchAvailable: false, verification: null, blocker, projectCompleteAllowed: false });
    setStatus(taskId, jobId, { state: "failed", finishedAt: utcNow(), blocker });
    event(dir, "worker.failed", { blocker });
    return 1;
  } finally {
    try { writeJson(path.join(dir, "lease-release.json"), releaseResourceLease(jobId)); }
    catch (error) { writeJson(path.join(dir, "lease-release.json"), { released: false, warning: bounded(error.message, 300) }); }
  }
}

module.exports = { communicationContract, executeWorker, promptFor };
