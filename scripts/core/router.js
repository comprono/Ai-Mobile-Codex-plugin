"use strict";

const { boundedList } = require("./utils");
const { readProfile } = require("../lib/orchestrator-profile");

const PROVIDERS = new Set(["auto", "codex", "claude", "antigravity", "cursor"]);

function normalizeRequest(input = {}) {
  const preferredProvider = String(input.preferredProvider || "auto").toLowerCase();
  if (!PROVIDERS.has(preferredProvider)) throw new Error(`Unsupported provider: ${preferredProvider}`);
  const readOnly = input.readOnly === true;
  const expectedFiles = boundedList(input.expectedFiles, 80, 500);
  if (!readOnly && !expectedFiles.length) throw new Error("Writer lanes require explicit expectedFiles boundaries.");
  return {
    projectGoal: String(input.projectGoal || "").trim().slice(0, 6000),
    goal: String(input.goal || "").trim().slice(0, 8000),
    acceptanceCriteria: boundedList(input.acceptanceCriteria, 20, 1000),
    nextStep: String(input.nextStep || "").trim().slice(0, 3000),
    workspace: input.workspace,
    preferredProvider,
    readOnly,
    expectedFiles,
    verificationCommands: Array.isArray(input.verificationCommands) ? input.verificationCommands : [],
    timeoutSeconds: Math.max(30, Math.min(3600, Number(input.timeoutSeconds || 900))),
    complexity: ["small", "medium", "large"].includes(input.complexity) ? input.complexity : "medium",
    model: String(input.model || "").trim(), effort: String(input.effort || "medium").trim(),
    allowAntigravity: input.allowAntigravity === true, needsUi: input.needsUi === true,
    conversation: String(input.conversation || "").trim(), mode: String(input.mode || "").trim(),
    projectId: String(input.projectId || "").trim(),
  };
}

function eligible(id, request, inventory) {
  const state = inventory.providers[id];
  if (!state?.available || !state.authenticated) return false;
  if (id === "antigravity" && !request.allowAntigravity) return false;
  if (id === "codex" && Number.isFinite(Number(state.capacity?.effectiveRemainingPercent)) && Number(state.capacity.effectiveRemainingPercent) <= 15) return false;
  return true;
}

function selectCodexModel(request, inventory, profile) {
  if (request.model) return request.model;
  let allowed; try { allowed = new RegExp(profile.codexModelAllowPattern, "i"); } catch { allowed = /^gpt-/i; }
  return inventory.providers.codex?.models?.find((model) => allowed.test(model.id))?.id || "";
}

function route(input, inventory) {
  const request = normalizeRequest(input);
  const profile = readProfile();
  request.communicationMode = profile.communicationMode || "smart-compact";
  if (!request.goal) throw new Error("A bounded worker goal is required.");
  if (request.preferredProvider !== "auto") {
    if (!eligible(request.preferredProvider, request, inventory)) return { action: "direct", reason: `${request.preferredProvider} is unavailable or not authorized.`, request };
    if (request.preferredProvider === "codex") request.model = selectCodexModel(request, inventory, profile);
    if (request.preferredProvider === "codex" && !request.model) return { action: "direct", reason: "No allowed Codex model is available.", request };
    return { action: "delegate", provider: request.preferredProvider, reason: "Explicit eligible provider.", request };
  }
  if (request.complexity === "small") return { action: "direct", reason: "Dispatch cost exceeds the likely savings for this small task.", request };
  if (eligible("claude", request, inventory)) return { action: "delegate", provider: "claude", reason: "Independent repository lane fits authenticated Claude Code.", request };
  if (request.readOnly && eligible("antigravity", request, inventory)) return { action: "delegate", provider: "antigravity", reason: "Authorized read-only lane fits Antigravity CLI.", request };
  if (eligible("cursor", request, inventory)) return { action: "delegate", provider: "cursor", reason: "A real headless Cursor agent is available.", request };
  if (eligible("codex", request, inventory)) {
    request.model = selectCodexModel(request, inventory, profile);
    if (request.model) return { action: "delegate", provider: "codex", reason: "Independent Codex lane is available above the shared reserve.", request };
  }
  return { action: "direct", reason: "No eligible external lane has a positive expected value.", request };
}

module.exports = { normalizeRequest, route };
