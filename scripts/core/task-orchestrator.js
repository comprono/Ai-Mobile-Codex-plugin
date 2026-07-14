"use strict";

const crypto = require("node:crypto");
const path = require("node:path");
const { route } = require("./router");
const { readJson, safeWorkspace, utcNow, writeJson } = require("./utils");

function finite(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function compactCapacity(resources) {
  return Object.fromEntries(Object.entries(resources.providers || {}).map(([id, provider]) => {
    const windows = (provider.capacity?.windows || []).slice(0, 4).map((window) => ({
      scope: window.scope || window.limitId || "all",
      period: window.period || window.name || "",
      remainingPercent: finite(window.remainingPercent),
      resetAt: window.resetAt || null,
    }));
    return [id, {
      available: provider.available === true,
      authenticated: provider.authenticated === true,
      authMode: provider.authMode || "unknown",
      version: provider.version || "",
      confidence: provider.confidence || "unknown",
      capacitySource: provider.capacity?.source || "unknown",
      models: (provider.models || []).slice(0, 4).map((model) => model.id),
      remainingPercent: finite(provider.capacity?.effectiveRemainingPercent ?? provider.capacity?.remainingPercent),
      resetAt: provider.capacity?.resetAt || null,
      windows,
      reason: provider.reason || "",
    }];
  }));
}

function taskId(workspace, rootOutcome) {
  const digest = crypto.createHash("sha256").update(`${workspace}\n${rootOutcome.trim().toLowerCase()}`).digest("hex").slice(0, 16);
  return `task-${digest}`;
}

function compactConsidered(rows = []) {
  return rows.map((row) => ({
    provider: row.provider,
    eligible: row.eligible,
    model: row.model || "",
    remainingPercent: row.remainingPercent ?? null,
    score: row.score,
    reason: row.reason,
  }));
}

function normalizedLaneGoal(value) {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function isConditionalCompletionEvidence(value) {
  const text = String(value || "").trim();
  return /\bor\s+(?:(?:a|an|one)\s+)?(?:(?:documented|genuine|external|user-only)\s+)*(?:blocker|blocked|gate|unavailable)\b/i.test(text)
    || /\bwhen\b.{0,100}\beligible\b/i.test(text)
    || /\bif\b.{0,100}\b(?:available|eligible|possible)\b/i.test(text)
    || /\bunless\b/i.test(text);
}

function validate(args) {
  if (!String(args.rootOutcome || "").trim()) throw new Error("rootOutcome is required.");
  if (!Array.isArray(args.completionEvidence) || !args.completionEvidence.filter(Boolean).length) throw new Error("At least one completionEvidence item is required.");
  if (args.completionEvidence.some(isConditionalCompletionEvidence)) {
    throw new Error("completionEvidence must contain positive observable proof, not blocker, availability, or eligibility alternatives. Put genuine external stop conditions in blockingConditions.");
  }
  if (!String(args.currentCodexGoal || "").trim()) throw new Error("currentCodexGoal is required.");
  if (!Array.isArray(args.candidateLanes) || args.candidateLanes.length < 1 || args.candidateLanes.length > 2) throw new Error("Provide one or two bounded candidateLanes.");
  for (const lane of args.candidateLanes) {
    if (!String(lane.goal || "").trim()) throw new Error("Every candidate lane requires a goal.");
    if (!String(lane.independenceReason || "").trim()) throw new Error("Every candidate lane requires an independenceReason.");
    if (!Array.isArray(lane.relevantFiles) || !lane.relevantFiles.length) throw new Error("Every candidate lane requires at least one relevantFiles boundary.");
    if (lane.readOnly === false && (!Array.isArray(lane.expectedFiles) || !lane.expectedFiles.length)) throw new Error("Writer candidate lanes require expectedFiles.");
  }
}

function orchestrateTask(args, resources, histories, createJob) {
  validate(args);
  const workspace = safeWorkspace(args.workspace);
  const rootOutcome = String(args.rootOutcome).trim().slice(0, 6000);
  const completionEvidence = args.completionEvidence.map((item) => String(item).trim().slice(0, 1200)).filter(Boolean).slice(0, 12);
  const blockingConditions = (args.blockingConditions || []).map((item) => String(item).trim().slice(0, 1200)).filter(Boolean).slice(0, 8);
  const currentCodexGoal = String(args.currentCodexGoal).trim().slice(0, 5000);
  const id = taskId(workspace, rootOutcome);
  const recordPath = path.join(workspace, ".ai-mobile", "tasks", `${id}.json`);
  const previous = readJson(recordPath, null);
  const priorLanes = new Map((previous?.dispatches || []).map((item) => [normalizedLaneGoal(item.lane), item]));
  const dispatches = [];
  const rejected = [];

  for (const lane of args.candidateLanes) {
    const priorLane = priorLanes.get(normalizedLaneGoal(lane.goal));
    if (priorLane) {
      rejected.push({ goal: lane.goal, existingJobId: priorLane.jobId, provider: priorLane.provider, reason: "This exact lane was already dispatched for the same root outcome; collect or integrate its existing job instead of spending capacity twice.", considered: [] });
      continue;
    }
    let decision;
    try {
      decision = route({
        workspace,
        projectGoal: rootOutcome,
        goal: lane.goal,
        currentCodexGoal,
        independenceReason: lane.independenceReason,
        acceptanceCriteria: lane.acceptanceCriteria || [],
        nextStep: lane.collectAt || lane.nextStep || "Integrate this result before taking over the lane.",
        preferredProvider: lane.preferredProvider || "auto",
        readOnly: lane.readOnly !== false,
        relevantFiles: lane.relevantFiles,
        currentCodexFiles: args.currentCodexFiles || [],
        expectedFiles: lane.expectedFiles || [],
        verificationCommands: lane.verificationCommands || [],
        timeoutSeconds: lane.timeoutSeconds,
        complexity: lane.complexity || "medium",
        taskKind: lane.taskKind || "generic",
        model: lane.model || "",
        effort: lane.effort || "",
        allowAntigravity: lane.allowAntigravity === undefined ? args.allowAntigravity : lane.allowAntigravity,
        allowPaidApi: lane.allowPaidApi === true,
        allowPremiumModel: lane.allowPremiumModel === true,
        needsUi: lane.needsUi === true,
        projectId: lane.projectId || "",
        conversation: lane.conversation || "",
        estimatedDirectTokens: lane.estimatedDirectTokens,
        maxWorkerOutputTokens: lane.maxWorkerOutputTokens,
        maxApiBudgetUsd: lane.maxApiBudgetUsd,
        minimumSavingsPercent: lane.minimumSavingsPercent,
        horizonHours: args.horizonHours,
      }, resources, histories);
    } catch (error) {
      rejected.push({ goal: lane.goal, reason: error.message, considered: [] });
      continue;
    }

    if (decision.action !== "delegate") {
      rejected.push({ goal: lane.goal, reason: decision.reason, considered: compactConsidered(decision.considered) });
      continue;
    }

    try {
      const provider = resources.providers[decision.provider];
      const receipt = createJob({
        ...decision.request,
        taskId: id,
        completionEvidence,
        workspace,
        provider: decision.provider,
        providerCommand: provider.command,
        providerAuthMode: provider.authMode || "unknown",
      });
      dispatches.push({
        lane: lane.goal,
        provider: decision.provider,
        model: decision.request.model || "",
        reason: decision.reason,
        economics: decision.economics,
        considered: compactConsidered(decision.considered),
        ...receipt,
      });
    } catch (error) {
      rejected.push({ goal: lane.goal, reason: error.message, considered: compactConsidered(decision.considered) });
    }
  }

  const createdAt = previous?.createdAt || utcNow();
  const record = {
    schemaVersion: 1,
    taskId: id,
    rootOutcome,
    completionEvidence,
    blockingConditions,
    currentCodex: {
      goal: currentCodexGoal,
      files: args.currentCodexFiles || [],
      acceptanceCriteria: args.currentCodexAcceptanceCriteria || [],
    },
    candidateLanes: args.candidateLanes,
    dispatches: [
      ...(previous?.dispatches || []),
      ...dispatches.map((item) => ({ jobId: item.jobId, lane: item.lane, provider: item.provider, model: item.model })),
    ].slice(-20),
    rejected,
    createdAt,
    updatedAt: utcNow(),
    invocationCount: Number(previous?.invocationCount || 0) + 1,
  };
  writeJson(recordPath, record);

  return {
    taskId: id,
    reusedContract: Boolean(previous),
    rootOutcome,
    completionEvidence: record.completionEvidence,
    blockingConditions: record.blockingConditions,
    capacityEvidence: { generatedAt: resources.generatedAt || null, cached: resources.cached === true, horizonHours: Math.max(1, Math.min(24, Number(args.horizonHours || 5))) },
    capacity: compactCapacity(resources),
    currentCodex: record.currentCodex,
    workers: dispatches,
    workersStarted: dispatches.length,
    rejectedLanes: rejected,
    completionFirewall: {
      projectCompleteAllowed: false,
      rule: "A milestone, runner restart, passing unit test, or worker completion is not the project outcome. Claim completion only after every completionEvidence item is verified end to end.",
    },
    turnExitFirewall: {
      finalAnswerAllowedNow: false,
      rule: "Do not end this turn with setup, status, a running service, an empty eligible queue, or a named gate. First advance the current-Codex lane. A blocker may end the turn only with evidence that it is external or user-only and that no dependency-ready local improvement remains.",
      requiredBeforeFinal: [
        "Produce and verify a material current-Codex change or satisfy a completionEvidence item.",
        "Otherwise prove one blockingCondition, identify its owner, and prove no dependency-ready local work remains.",
      ],
    },
    nextAction: dispatches.length
      ? "Start the current-Codex lane now while workers run. Do not wait or duplicate their files/questions. Collect each result once at its integration point."
      : "Start the current-Codex lane now. No candidate worker passed the gates; preserve the rejection reasons and do not pretend external capacity was used.",
    contractRule: "This one finite call replaces separate inventory and dispatch setup. Do not create a manager loop, Goal, automation, heartbeat, or repeated status poll.",
    reportingRule: "Report verified artifacts, accepted changes, concrete blockers, and the next dependency-ready action. Activity alone is not progress.",
  };
}

module.exports = { compactCapacity, isConditionalCompletionEvidence, orchestrateTask, taskId, validate };
