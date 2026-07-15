"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { boundaryAllows, changedFingerprints, collectDiff, fingerprint, statusPaths } = require("./git-evidence");
const { event, jobDirectory, setStatus } = require("./job-store");
const { runVerification } = require("./verification");
const { clearInventoryCache } = require("./capacity");
const { bounded, readJson, redact, safeWorkspace, utcNow, writeJson } = require("./utils");
const { runProvider } = require("../providers");

function communicationContract(mode = "smart-compact") {
  if (mode === "detailed") return "Explain the outcome and material reasoning clearly, but omit greetings, repeated task text, tool narration, waiting commentary, and offers for more work.";
  if (mode === "standard") return "Use concise complete prose. Lead with the outcome and omit greetings, repeated task text, tool narration, waiting commentary, and postambles.";
  return "Think deeply; communicate compactly. Lead with the outcome. Use short bullets where useful. Omit greetings, repeated task text, tool narration, waiting commentary, and postambles. Preserve exact facts, numbers, paths, commands, errors, caveats, and evidence. Expand when ambiguity, safety, irreversible action, or a decision requires explanation.";
}

function promptFor(contract) {
  const maxWords = Math.max(250, Math.min(2200, Math.floor((contract.maxWorkerOutputTokens || 1200) * 0.72)));
  const smallReadOnlyCap = contract.readOnly && contract.complexity === "small"
    ? "Small read-only inspection cap: inspect at most three direct files or commands from the listed scope. Do not recurse through directories, scan logs broadly, or inspect unrelated files. If those checks cannot establish the answer, stop and report the missing evidence as the blocker."
    : "";
  return [
    "You are one bounded worker inside a larger project. Complete only this lane.",
    `Project outcome: ${contract.projectGoal || "Not supplied"}`,
    contract.completionEvidence?.length ? `Project completion evidence (not your lane completion):\n- ${contract.completionEvidence.join("\n- ")}` : "",
    `Your lane: ${contract.goal}`,
    `Current Codex owns this different lane: ${contract.currentCodexGoal}`,
    `Why the lanes are independent: ${contract.independenceReason}`,
    `Workspace: ${contract.workspace}`,
    `Mode: ${contract.readOnly ? "read-only" : "writer"}`,
    contract.relevantFiles?.length ? `Relevant read scope: ${contract.relevantFiles.join(", ")}` : "",
    contract.expectedFiles.length ? `Allowed write boundaries: ${contract.expectedFiles.join(", ")}` : "Do not modify files.",
    contract.acceptanceCriteria.length ? `Acceptance criteria:\n- ${contract.acceptanceCriteria.join("\n- ")}` : "",
    contract.expectedContribution ? `Expected contribution: ${contract.expectedContribution}` : "",
    contract.integrationAction ? `Integration action for current Codex: ${contract.integrationAction}` : "",
    contract.nextStep ? `Useful next step after this lane: ${contract.nextStep}` : "",
    smallReadOnlyCap,
    "Do not investigate, implement, or repeat the current-Codex lane. Do not run another agent, start a manager loop, create recurring work, or broaden scope.",
    "Completing this lane is evidence for current Codex. It does not complete the project outcome.",
    communicationContract(contract.communicationMode),
    `Hard result budget: at most ${contract.maxWorkerOutputTokens || 1200} output tokens (about ${maxWords} words), five evidence bullets, and one blocker. Stop after sufficient evidence.`,
    "Finish with concise evidence: result, files changed, checks run, and one concrete blocker if any.",
  ].filter(Boolean).join("\n\n");
}

function executeWorker(payload) {
  const workspace = safeWorkspace(payload.workspace);
  const dir = jobDirectory(workspace, payload.id);
  const contract = readJson(path.join(dir, "contract.json"), null);
  if (!contract) throw new Error("Missing job contract.");
  const beforeStatus = statusPaths(workspace);
  const observedBoundaries = contract.readOnly ? [] : contract.expectedFiles;
  const before = fingerprint(workspace, observedBoundaries, 5000);
  setStatus(dir, { state: "running", pid: process.pid, startedAt: readJson(path.join(dir, "status.json"), {}).startedAt || utcNow() });
  const providerState = { [contract.provider]: { available: true, authenticated: true, command: contract.providerCommand } };
  const response = runProvider(providerState, contract, promptFor(contract));
  if (!response.ok || response.typedBlocker) clearInventoryCache();
  const resultLimit = Math.max(1600, Math.min(12000, Number(contract.maxWorkerOutputTokens || 1200) * 4));
  fs.writeFileSync(path.join(dir, "provider-output.txt"), redact(bounded(response.text, resultLimit)), "utf8");
  const afterStatus = statusPaths(workspace);
  const after = fingerprint(workspace, observedBoundaries, 5000);
  const currentCodexPaths = contract.currentCodexFiles || [];
  const newlyDirty = afterStatus.paths.filter((file) => !beforeStatus.paths.includes(file) && !currentCodexPaths.some((boundary) => boundaryAllows(file, [boundary])));
  const changed = contract.readOnly ? [] : [...new Set([...changedFingerprints(before, after), ...newlyDirty])];
  const outside = changed.filter((file) => !boundaryAllows(file, contract.expectedFiles));
  const mutationViolation = contract.readOnly && changed.length > 0;
  writeJson(path.join(dir, "changed-files.json"), changed);
  fs.writeFileSync(path.join(dir, "worker.diff"), collectDiff(workspace, changed), "utf8");
  const usage = { provider: contract.provider, ...response.usage, capturedAt: utcNow() };
  const outputTokens = Number(usage.outputTokens ?? usage.output_tokens);
  const equivalentUsd = Number(usage.equivalentUsd ?? usage.total_cost_usd);
  usage.budgetExceeded = (Number.isFinite(outputTokens) && outputTokens > contract.maxWorkerOutputTokens)
    || (contract.providerAuthMode === "api-key" && Number.isFinite(equivalentUsd) && equivalentUsd > contract.maxApiBudgetUsd);
  usage.outputBudgetTokens = contract.maxWorkerOutputTokens;
  usage.apiBudgetUsd = contract.providerAuthMode === "api-key" ? contract.maxApiBudgetUsd : null;
  writeJson(path.join(dir, "usage.json"), usage);
  let verification = null;
  let blocker = response.typedBlocker ? `${response.typedBlocker}: ${bounded(response.text, 500)}` : "";
  if (outside.length) blocker = `Writer boundary violation: ${outside.join(", ")}`;
  if (mutationViolation) blocker = `Read-only worker modified files: ${changed.join(", ")}`;
  if (!blocker && response.ok) {
    verification = runVerification(workspace, dir, contract.verificationCommands);
    if (verification.required && !verification.passed) blocker = verification.blocker;
  }
  const state = !response.ok || blocker ? "failed" : "completed";
  const result = [bounded(response.text, resultLimit), changed.length ? `\nChanged: ${changed.join(", ")}` : "\nChanged: none", blocker ? `\nBlocker: ${blocker}` : "", usage.budgetExceeded ? "\nBudget warning: provider usage exceeded the declared lane budget; do not send this result to another model for review." : ""].join("").trim();
  fs.writeFileSync(path.join(dir, "result.md"), `${result}\n`, "utf8");
  setStatus(dir, { state, finishedAt: utcNow(), blocker, warning: usage.budgetExceeded ? "worker-budget-exceeded" : "", exitCode: response.exitCode ?? null, verificationState: verification?.state || "not-requested" });
  event(dir, "worker.finished", { state, changedCount: changed.length });
  return state === "completed" ? 0 : 1;
}

module.exports = { communicationContract, executeWorker, promptFor };
