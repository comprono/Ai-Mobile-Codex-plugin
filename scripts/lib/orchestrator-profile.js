"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const DEFAULT_PROFILE = Object.freeze({
  schemaVersion: 6,
  communicationStyle: "professional",
  communicationMode: "smart-compact",
  address: "",
  updateStyle: "concise-executive",
  role: "technical project manager",
  codexModelAllowPattern: "^gpt-",
  // Empty by default: the router ranks the current native catalog rather than
  // assuming a particular model name or catalog order.
  codexPreferredModelPattern: "(?!)",
  codexPreferredTaskPattern: "",
  codexDefaultEffort: "auto",
  claudeModelAllowPattern: ".*",
  claudePreferredModelPattern: "(?!)",
  antigravityPreferredTaskPattern: "browser|research|repository-scan|docs|discovery|scout|summary",
  modelPolicyReviewAfter: "",
  adaptiveRouting: true,
  cliFirst: true,
  uiFallbackOnly: true,
  antigravityAutoApprovePermissions: false,
  subscriptionOnlyClaude: true,
  codexReservePercent: 15,
  maxExternalWorkers: 2,
  minimumDelegationSavingsPercent: 20,
  useExpiringPremiumCapacity: false,
});

function profilePath() {
  return path.join(process.env.LOCALAPPDATA || os.tmpdir(), "AI Mobile", "orchestrator-profile.json");
}

function cleanText(value, max) {
  return String(value || "").trim().replace(/[\r\n\t]+/g, " ").slice(0, max);
}

function safePattern(value, fallback = DEFAULT_PROFILE.codexModelAllowPattern) {
  const pattern = cleanText(value, 200) || fallback;
  try {
    new RegExp(pattern, "i");
    return pattern;
  } catch {
    return fallback;
  }
}

function normalizeProfile(value = {}) {
  const style = ["professional", "royal"].includes(String(value.communicationStyle || "").toLowerCase())
    ? String(value.communicationStyle).toLowerCase()
    : DEFAULT_PROFILE.communicationStyle;
  return {
    schemaVersion: 6,
    communicationStyle: style,
    communicationMode: ["smart-compact", "standard", "detailed"].includes(String(value.communicationMode || "").toLowerCase())
      ? String(value.communicationMode).toLowerCase()
      : DEFAULT_PROFILE.communicationMode,
    address: cleanText(value.address, 80),
    updateStyle: ["concise-executive", "technical", "minimal"].includes(String(value.updateStyle || "").toLowerCase())
      ? String(value.updateStyle).toLowerCase()
      : DEFAULT_PROFILE.updateStyle,
    role: cleanText(value.role, 120) || DEFAULT_PROFILE.role,
    codexModelAllowPattern: safePattern(value.codexModelAllowPattern, DEFAULT_PROFILE.codexModelAllowPattern),
    codexPreferredModelPattern: safePattern(value.codexPreferredModelPattern, DEFAULT_PROFILE.codexPreferredModelPattern),
    codexPreferredTaskPattern: cleanText(value.codexPreferredTaskPattern, 200),
    codexDefaultEffort: ["auto", "low", "medium", "high", "xhigh", "max", "ultra"].includes(String(value.codexDefaultEffort || "").toLowerCase())
      ? String(value.codexDefaultEffort).toLowerCase()
      : DEFAULT_PROFILE.codexDefaultEffort,
    claudeModelAllowPattern: safePattern(value.claudeModelAllowPattern, DEFAULT_PROFILE.claudeModelAllowPattern),
    claudePreferredModelPattern: safePattern(value.claudePreferredModelPattern, DEFAULT_PROFILE.claudePreferredModelPattern),
    antigravityPreferredTaskPattern: safePattern(value.antigravityPreferredTaskPattern, DEFAULT_PROFILE.antigravityPreferredTaskPattern),
    modelPolicyReviewAfter: cleanText(value.modelPolicyReviewAfter, 40),
    adaptiveRouting: value.adaptiveRouting !== false,
    cliFirst: value.cliFirst !== false,
    uiFallbackOnly: value.uiFallbackOnly !== false,
    antigravityAutoApprovePermissions: value.antigravityAutoApprovePermissions === true,
    subscriptionOnlyClaude: value.subscriptionOnlyClaude !== false,
    codexReservePercent: Math.max(5, Math.min(50, Number(value.codexReservePercent ?? DEFAULT_PROFILE.codexReservePercent))),
    maxExternalWorkers: Math.max(1, Math.min(2, Number(value.maxExternalWorkers ?? DEFAULT_PROFILE.maxExternalWorkers))),
    minimumDelegationSavingsPercent: Math.max(10, Math.min(70, Number(value.minimumDelegationSavingsPercent ?? DEFAULT_PROFILE.minimumDelegationSavingsPercent))),
    useExpiringPremiumCapacity: value.useExpiringPremiumCapacity === true,
  };
}

function readProfile() {
  const filePath = profilePath();
  try {
    return { ...normalizeProfile({ ...DEFAULT_PROFILE, ...JSON.parse(fs.readFileSync(filePath, "utf8")) }), path: filePath, source: "local-profile" };
  } catch {
    return { ...DEFAULT_PROFILE, path: filePath, source: "default" };
  }
}

function writeProfile(patch = {}) {
  const current = readProfile();
  const supplied = Object.fromEntries(Object.entries(patch).filter(([key, value]) => {
    if (["path", "source", "action"].includes(key) || value === undefined) return false;
    if (typeof value === "string" && key !== "address" && value.trim() === "") return false;
    return true;
  }));
  const next = normalizeProfile({ ...current, ...supplied });
  const filePath = profilePath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  fs.renameSync(tempPath, filePath);
  return { ...next, path: filePath, source: "local-profile" };
}

function modelPattern(profile = readProfile()) {
  try {
    return new RegExp(profile.codexModelAllowPattern, "i");
  } catch {
    return new RegExp(DEFAULT_PROFILE.codexModelAllowPattern, "i");
  }
}

module.exports = {
  DEFAULT_PROFILE,
  modelPattern,
  normalizeProfile,
  profilePath,
  readProfile,
  writeProfile,
};
