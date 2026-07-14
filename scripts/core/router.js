"use strict";

const { boundedList, safeRelativePath } = require("./utils");
const { boundariesOverlap, economicEstimate, goalOverlap, laneKey } = require("./lane-policy");
const { readProfile } = require("../lib/orchestrator-profile");

const PROVIDERS = new Set(["auto", "codex", "claude", "antigravity", "cursor"]);
const TASK_KINDS = new Set(["architecture", "browser", "code", "debug", "docs", "generic", "live-state", "repository-scan", "research", "review", "tests"]);
const SELECTION_AUTHORITIES = new Set(["router", "user"]);
const CANONICAL_MODEL_FAMILIES = [
  ["claude", /(^|[^a-z])(claude|fable|mythos|opus|sonnet|haiku)([^a-z]|$)/i],
  ["codex", /(^|[^a-z])(gpt|codex)([^a-z]|$)/i],
  ["antigravity", /(^|[^a-z])gemini([^a-z]|$)/i],
];
const CANONICAL_BINDING_HINT = "Fable/Opus/Sonnet/Haiku are Claude models, GPT models are Codex, Gemini models are Antigravity";

function canonicalModelProvider(model) {
  const value = String(model || "").trim();
  if (!value) return "";
  const matches = CANONICAL_MODEL_FAMILIES.filter(([, pattern]) => pattern.test(value)).map(([provider]) => provider);
  return matches.length === 1 ? matches[0] : "";
}
const FIT = {
  codex: { architecture: 88, browser: 45, code: 88, debug: 90, docs: 70, generic: 78, "live-state": 92, "repository-scan": 68, research: 65, review: 82, tests: 78 },
  claude: { architecture: 94, browser: 45, code: 90, debug: 88, docs: 76, generic: 78, "live-state": 55, "repository-scan": 78, research: 72, review: 90, tests: 76 },
  antigravity: { architecture: 58, browser: 96, code: 52, debug: 55, docs: 88, generic: 68, "live-state": 70, "repository-scan": 92, research: 94, review: 72, tests: 60 },
  cursor: { architecture: 70, browser: 55, code: 82, debug: 78, docs: 68, generic: 70, "live-state": 50, "repository-scan": 72, research: 62, review: 72, tests: 75 },
};

function clamp(value, min, max, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function paths(workspace, values) {
  return boundedList(values, 80, 500).map((value) => safeRelativePath(workspace, value)).filter(Boolean);
}

function normalizeRequest(input = {}) {
  let preferredProvider = String(input.preferredProvider || "auto").toLowerCase();
  if (!PROVIDERS.has(preferredProvider)) throw new Error(`Unsupported provider: ${preferredProvider}`);
  const selectionAuthority = String(input.selectionAuthority || "router").trim().toLowerCase();
  if (!SELECTION_AUTHORITIES.has(selectionAuthority)) {
    throw new Error(`Unsupported selectionAuthority: ${selectionAuthority}. Use "user" only for a provider/model the user explicitly mandated; omit it for automatic routing.`);
  }
  const model = String(input.model || "").trim();
  const canonicalProvider = canonicalModelProvider(model);
  let selectionCorrection = "";
  if (model && canonicalProvider && preferredProvider !== "auto" && preferredProvider !== canonicalProvider) {
    selectionCorrection = `Corrected provider "${preferredProvider}" to "${canonicalProvider}": "${model}" is a ${canonicalProvider} model (${CANONICAL_BINDING_HINT}).`;
    preferredProvider = canonicalProvider;
  }
  if (selectionAuthority === "user" && preferredProvider === "auto") {
    if (model && canonicalProvider) {
      preferredProvider = canonicalProvider;
    } else if (model) {
      throw new Error(`selectionAuthority "user" cannot bind model "${model}" to one provider (${CANONICAL_BINDING_HINT}). Set the exact preferredProvider the user mandated.`);
    } else {
      throw new Error('selectionAuthority "user" requires the explicit preferredProvider and/or model the user mandated. Omit selectionAuthority for automatic routing.');
    }
  }
  const readOnly = input.readOnly === true;
  const expectedFiles = paths(input.workspace, input.expectedFiles);
  if (!readOnly && !expectedFiles.length) throw new Error("Writer lanes require explicit expectedFiles boundaries.");
  const complexity = ["small", "medium", "large"].includes(input.complexity) ? input.complexity : "medium";
  const defaultOutput = complexity === "large" ? 2000 : 1200;
  const taskKind = TASK_KINDS.has(input.taskKind) ? input.taskKind : (input.mode === "review" ? "review" : "generic");
  const request = {
    projectGoal: String(input.projectGoal || "").trim().slice(0, 6000),
    goal: String(input.goal || "").trim().slice(0, 8000),
    currentCodexGoal: String(input.currentCodexGoal || "").trim().slice(0, 5000),
    independenceReason: String(input.independenceReason || "").trim().slice(0, 2000),
    acceptanceCriteria: boundedList(input.acceptanceCriteria, 20, 1000),
    nextStep: String(input.nextStep || "").trim().slice(0, 3000),
    workspace: input.workspace,
    preferredProvider,
    readOnly,
    relevantFiles: paths(input.workspace, input.relevantFiles),
    currentCodexFiles: paths(input.workspace, input.currentCodexFiles),
    expectedFiles,
    verificationCommands: Array.isArray(input.verificationCommands) ? input.verificationCommands : [],
    timeoutSeconds: clamp(input.timeoutSeconds, 30, 3600, 900),
    complexity,
    taskKind,
    model,
    selectionAuthority,
    selectionCorrection,
    effort: String(input.effort || (readOnly ? "low" : "medium")).trim(),
    allowAntigravity: input.allowAntigravity === undefined ? null : input.allowAntigravity === true,
    allowPaidApi: input.allowPaidApi === true,
    allowPremiumModel: input.allowPremiumModel === true,
    needsUi: input.needsUi === true,
    conversation: String(input.conversation || "").trim(),
    mode: String(input.mode || "").trim(),
    projectId: String(input.projectId || "").trim(),
    horizonHours: clamp(input.horizonHours, 1, 24, 5),
    estimatedDirectTokens: clamp(input.estimatedDirectTokens, 500, 200000, 0),
    maxWorkerOutputTokens: clamp(input.maxWorkerOutputTokens, 300, 4000, defaultOutput),
    maxApiBudgetUsd: clamp(input.maxApiBudgetUsd ?? input.maxEquivalentUsd, 0.01, 5, complexity === "large" ? 0.75 : 0.35),
    minimumSavingsPercent: clamp(input.minimumSavingsPercent, 10, 70, 20),
  };
  request.laneKey = laneKey(request);
  return request;
}

function match(pattern, value) {
  try { return new RegExp(pattern, "i").test(value); } catch { return false; }
}

function modelAllowed(pattern, model) {
  try { return new RegExp(pattern, "i").test(model); } catch { return false; }
}

function modelFamily(value) {
  return String(value || "").toLowerCase().replace(/^claude-/, "").replace(/[^a-z]+/g, " ").trim().split(/\s+/)[0] || "";
}

function windowApplies(window, model) {
  const scope = String(window?.scope || "all").toLowerCase();
  if (scope === "all") return true;
  const family = modelFamily(model);
  const scopeFamily = modelFamily(scope);
  return Boolean(family && scopeFamily && family === scopeFamily);
}

function antigravityModel(request, state) {
  if (request.model) return request.model;
  const models = (state.models || []).filter((item) => item.quota?.status !== "exhausted" && Number(item.quota?.remainingPercent ?? 1) > 0);
  const wanted = request.taskKind === "browser" || request.complexity === "large"
    ? [/gemini.*flash.*high/i, /gemini.*flash.*medium/i, /flash/i]
    : [/gemini.*flash.*medium/i, /gemini.*flash.*low/i, /flash/i];
  for (const pattern of wanted) {
    const row = models.find((item) => pattern.test(`${item.id} ${item.displayName}`));
    if (row) return row.id;
  }
  return models[0]?.id || "";
}

function providerModel(id, request, state, profile) {
  const requestedFamily = canonicalModelProvider(request.model);
  if (request.model && requestedFamily && requestedFamily !== id && ["codex", "claude", "antigravity"].includes(id)) return "";
  if (id === "codex") {
    if (request.model) return modelAllowed(profile.codexModelAllowPattern, request.model) ? request.model : "";
    return state.models?.find((item) => modelAllowed(profile.codexModelAllowPattern, item.id))?.id || "";
  }
  if (id === "claude") {
    const available = (state.models || []).map((item) => item.id).filter((model) => modelAllowed(profile.claudeModelAllowPattern, model));
    const preferred = available.find((model) => match(profile.claudePreferredModelPattern, model));
    let model = request.model || preferred || available.find((item) => /sonnet/i.test(item)) || "sonnet";
    if (!request.model && profile.useExpiringPremiumCapacity && request.complexity === "large" && ["architecture", "debug", "review"].includes(request.taskKind)) {
      const dedicated = (state.capacity?.windows || []).find((window) => modelFamily(window.scope) === "fable");
      const resetAt = Date.parse(dedicated?.resetAt || "");
      const withinHorizon = Number.isFinite(resetAt) && resetAt > Date.now() && resetAt <= Date.now() + request.horizonHours * 60 * 60 * 1000;
      if (withinHorizon && Number(dedicated.remainingPercent) >= 10 && state.models?.some((item) => /fable/i.test(item.id))) model = "fable";
    }
    if (!modelAllowed(profile.claudeModelAllowPattern, model)) return "";
    const userMandatedModel = request.selectionAuthority === "user" && Boolean(request.model);
    if (!request.allowPremiumModel && !profile.useExpiringPremiumCapacity && !userMandatedModel && /fable|opus/i.test(model)) return "";
    return model;
  }
  if (id === "antigravity") return antigravityModel(request, state);
  return request.model || "";
}

function capacityFor(id, state, model) {
  if (id === "claude") {
    const windows = (state.capacity?.windows || []).filter((window) => windowApplies(window, model));
    const measured = windows.map((window) => finiteNumber(window.remainingPercent)).filter((value) => value !== null);
    const limiting = windows.filter((window) => finiteNumber(window.remainingPercent) !== null)
      .sort((left, right) => Number(left.remainingPercent) - Number(right.remainingPercent))[0];
    return {
      remainingPercent: measured.length ? Math.min(...measured) : finiteNumber(state.capacity?.remainingPercent),
      resetAt: limiting?.resetAt || state.capacity?.resetAt || null,
      source: state.capacity?.source || "unknown",
    };
  }
  if (id === "antigravity") {
    const row = (state.capacity?.models || []).find((item) => item.id === model || modelFamily(item.id) === modelFamily(model));
    return {
      remainingPercent: finiteNumber(row?.remainingPercent) ?? finiteNumber(state.capacity?.remainingPercent),
      resetAt: row?.resetAt || state.capacity?.resetAt || null,
      source: state.capacity?.source || "unknown",
    };
  }
  return {
    remainingPercent: finiteNumber(state.capacity?.effectiveRemainingPercent ?? state.capacity?.remainingPercent),
    resetAt: state.capacity?.resetAt || null,
    source: state.capacity?.source || "unknown",
  };
}

function providerEligibility(id, request, inventory, profile, history) {
  const state = inventory.providers[id] || {};
  if (!state.available) return { eligible: false, reason: state.reason || "not installed" };
  if (!state.authenticated) return { eligible: false, reason: "not authenticated" };
  if (request.needsUi) return { eligible: false, reason: "visible UI is required; CLI dispatch is intentionally refused" };
  if (id === "antigravity" && !request.allowAntigravity) return { eligible: false, reason: "Antigravity CLI was not authorized for this lane" };
  if (id === "claude" && profile.subscriptionOnlyClaude !== false && state.authMode === "api-key" && !request.allowPaidApi) {
    return { eligible: false, reason: "Claude would use API/PAYG billing; explicit allowPaidApi is required" };
  }
  const model = providerModel(id, request, state, profile);
  if (["codex", "claude", "antigravity"].includes(id) && !model) {
    const requestedFamily = canonicalModelProvider(request.model);
    const reason = !request.model
      ? "no policy-allowed model is available"
      : requestedFamily && requestedFamily !== id
        ? `model "${request.model}" is a ${requestedFamily} model and never dispatches through ${id} (${CANONICAL_BINDING_HINT})`
        : `requested model "${request.model}" is not policy-enabled for ${id} (model allow pattern, or premium gate without allowPremiumModel or an explicit user mandate)`;
    return { eligible: false, reason };
  }
  const capacity = capacityFor(id, state, model);
  const remaining = capacity.remainingPercent;
  if (remaining !== null && remaining <= (id === "codex" ? profile.codexReservePercent : 2)) {
    return { eligible: false, reason: id === "codex" ? `shared Codex reserve (${profile.codexReservePercent}%) is protected` : "reported capacity is exhausted" };
  }
  if (history?.cooledDown && request.preferredProvider !== id) return { eligible: false, reason: `provider cooldown: ${history.cooldownReason || `${history.consecutiveFailures} consecutive failures`}` };
  return { eligible: true, reason: "eligible", model, ...capacity, authMode: state.authMode || "unknown" };
}

function providerScore(id, request, profile, history, gate) {
  const factors = { taskFit: FIT[id]?.[request.taskKind] || 60, capacity: 0, reliability: 0, billing: 0, preference: 0, sharedPool: 0 };
  if (gate.remainingPercent !== null && gate.remainingPercent !== undefined) factors.capacity = Math.round((gate.remainingPercent - 50) * 0.25);
  if (history?.successRate !== null && history?.successRate !== undefined) factors.reliability = Math.round((history.successRate - 0.5) * 20);
  if (["subscription", "chatgpt", "cli-session"].includes(gate.authMode)) factors.billing = gate.authMode === "cli-session" ? 2 : 4;
  if (gate.authMode === "api-key") factors.billing = -12;
  if (id === "antigravity" && match(profile.antigravityPreferredTaskPattern, `${request.taskKind} ${request.goal}`)) factors.preference += 8;
  if (id === "claude" && match(profile.claudePreferredModelPattern, gate.model)) factors.preference += 4;
  if (id === "claude" && request.readOnly && ["research", "repository-scan", "docs"].includes(request.taskKind)) factors.preference -= 8;
  if (id === "codex") factors.sharedPool = -8; // A separate Codex worker consumes the same shared pool.
  return { score: Object.values(factors).reduce((sum, value) => sum + value, 0), factors };
}

function applyProfileAuthorization(request, profile) {
  const savedReadOnlyAuthorization = request.allowAntigravity === null
    && request.readOnly
    && profile.antigravityAutoApprovePermissions === true;
  request.allowAntigravity = request.allowAntigravity === true || savedReadOnlyAuthorization;
  request.antigravityAutoApprovePermissions = request.allowAntigravity
    && request.readOnly
    && profile.antigravityAutoApprovePermissions === true;
  return request;
}

function coordinationGate(request) {
  if (!request.currentCodexGoal) return "Delegation requires the concrete current-Codex lane; otherwise independence cannot be proven.";
  if (!request.independenceReason) return "Delegation requires a concise independence reason.";
  const overlap = goalOverlap(request.goal, request.currentCodexGoal);
  if (overlap.overlaps) return `Worker and current Codex goals overlap (${overlap.shared.join(", ")}); keep this lane in current Codex.`;
  const workerFiles = [...request.relevantFiles, ...request.expectedFiles];
  const fileOverlap = boundariesOverlap(workerFiles, request.currentCodexFiles);
  if (fileOverlap.length) return `Worker and current Codex file ownership overlaps (${fileOverlap.map((pair) => pair.join(" <-> ")).join(", ")}); serialize the work.`;
  return "";
}

function route(input, inventory, histories = {}) {
  const request = normalizeRequest(input);
  const profile = readProfile();
  request.communicationMode = profile.communicationMode || "smart-compact";
  request.maxExternalWorkers = profile.maxExternalWorkers || 2;
  if (input.minimumSavingsPercent === undefined) request.minimumSavingsPercent = profile.minimumDelegationSavingsPercent || 20;
  applyProfileAuthorization(request, profile);
  if (!request.goal) throw new Error("A bounded worker goal is required.");
  const userMandated = request.selectionAuthority === "user";
  const warnings = request.selectionCorrection ? [request.selectionCorrection] : [];
  if (request.complexity === "small" && !userMandated) return { action: "direct", reason: "Dispatch overhead exceeds the likely savings for this small task.", request, considered: [] };
  const coordinationBlocker = coordinationGate(request);
  if (coordinationBlocker) return { action: "direct", reason: coordinationBlocker, hardBlocker: userMandated || undefined, request, considered: [] };
  const economics = economicEstimate(request);
  request.economics = economics;
  if (!economics.positive || request.complexity === "small") {
    if (!userMandated) {
      return { action: "direct", reason: `Delegation is not economically positive (${economics.savingsPercent}% estimated token-equivalent saving).`, request, considered: [] };
    }
    warnings.push(`Economic warning: ${request.complexity === "small"
      ? "small-task dispatch overhead normally keeps this lane in current Codex"
      : `the estimated token-equivalent saving is ${economics.savingsPercent}%, below the ${request.minimumSavingsPercent}% threshold`}; dispatching anyway because the user explicitly mandated ${request.preferredProvider}${request.model ? `/${request.model}` : ""}.`);
  }

  const ids = request.preferredProvider === "auto" ? ["codex", "claude", "antigravity", "cursor"] : [request.preferredProvider];
  const considered = ids.map((id) => {
    const gate = providerEligibility(id, request, inventory, profile, histories[id]);
    const scored = gate.eligible ? providerScore(id, request, profile, histories[id], gate) : { score: null, factors: null };
    return { provider: id, ...gate, score: scored.score, scoreFactors: scored.factors, model: gate.model || "" };
  });
  const selected = considered.filter((item) => item.eligible).sort((a, b) => b.score - a.score)[0];
  if (!selected) {
    return {
      action: "direct",
      reason: `No eligible provider: ${considered.map((item) => `${item.provider}: ${item.reason}`).join("; ")}.`,
      hardBlocker: userMandated || undefined,
      request,
      considered,
      economics,
      warnings: warnings.length ? warnings : undefined,
    };
  }
  request.model = selected.model || request.model;
  return {
    action: "delegate",
    provider: selected.provider,
    reason: userMandated
      ? `User-mandated ${selected.provider}${selected.model ? `/${selected.model}` : ""} passed the hard authentication, capacity, billing, ownership, and safety gates${warnings.length ? "; economic and correction warnings were recorded without blocking" : ""}.`
      : request.preferredProvider === "auto"
        ? `${selected.provider} has the best fit-adjusted score (${selected.score}) for this independent ${request.taskKind} lane.`
        : `Explicit ${selected.provider} selection passed independence, capacity, billing, and economic gates.`,
    request,
    considered,
    economics,
    warnings: warnings.length ? warnings : undefined,
  };
}

module.exports = { applyProfileAuthorization, canonicalModelProvider, coordinationGate, normalizeRequest, providerEligibility, route };
