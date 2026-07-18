"use strict";

const EXACT_TRUSTED_PRIMARY_MODELS = Object.freeze([
  "claude-fable-5",
  "claude-sonnet-5",
]);

function normalizeModelId(value) {
  return String(value || "").trim().toLowerCase().replace(/[_ ]+/g, "-").replace(/-+/g, "-");
}

function normalizeRequestedModel(value) {
  const normalized = normalizeModelId(value);
  if (/^(?:claude-)?fable-?5$/.test(normalized)) return "claude-fable-5";
  if (/^(?:claude-)?sonnet-?5$/.test(normalized)) return "claude-sonnet-5";
  return String(value || "").trim();
}

function trustedModelList(profile = {}) {
  return [...new Set((Array.isArray(profile.trustedPrimaryWriteModels) ? profile.trustedPrimaryWriteModels : [])
    .map(normalizeRequestedModel)
    .map(normalizeModelId)
    .filter((model) => EXACT_TRUSTED_PRIMARY_MODELS.includes(model)))];
}

function trustedPrimaryDecision(contract = {}, profile = {}) {
  if (contract.readOnly === true) return { trusted: false, reason: "read-only-lane" };
  if (String(contract.provider || "").toLowerCase() !== "claude") return { trusted: false, reason: "claude-only" };
  const model = normalizeModelId(normalizeRequestedModel(contract.model));
  if (!EXACT_TRUSTED_PRIMARY_MODELS.includes(model)) return { trusted: false, reason: "exact-fable-5-or-sonnet-5-required", model };
  if (!trustedModelList(profile).includes(model)) return { trusted: false, reason: "model-not-enabled-in-private-trust-policy", model };
  if (Array.isArray(contract.currentCodexFiles) && contract.currentCodexFiles.length) {
    return { trusted: false, reason: "current-codex-file-owner-active", model };
  }
  if (!Array.isArray(contract.verificationCommands) || !contract.verificationCommands.length) {
    return { trusted: false, reason: "deterministic-verification-required", model };
  }
  return {
    trusted: true,
    model,
    writeMode: "trusted-primary",
    skipModelReview: true,
    reason: "Exact trusted model is enabled by private policy; deterministic verification replaces redundant model review.",
  };
}

module.exports = {
  EXACT_TRUSTED_PRIMARY_MODELS,
  normalizeModelId,
  normalizeRequestedModel,
  trustedModelList,
  trustedPrimaryDecision,
};
