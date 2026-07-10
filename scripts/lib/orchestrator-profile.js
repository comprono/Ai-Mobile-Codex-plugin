"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const DEFAULT_PROFILE = Object.freeze({
  schemaVersion: 1,
  communicationStyle: "professional",
  address: "",
  updateStyle: "concise-executive",
  role: "technical project manager",
  codexModelAllowPattern: "^gpt-",
  modelPolicyReviewAfter: "",
  cliFirst: true,
  uiFallbackOnly: true,
});

function profilePath() {
  return path.join(process.env.LOCALAPPDATA || os.tmpdir(), "AI Mobile", "orchestrator-profile.json");
}

function cleanText(value, max) {
  return String(value || "").trim().replace(/[\r\n\t]+/g, " ").slice(0, max);
}

function safePattern(value) {
  const pattern = cleanText(value, 200) || DEFAULT_PROFILE.codexModelAllowPattern;
  try {
    new RegExp(pattern, "i");
    return pattern;
  } catch {
    return DEFAULT_PROFILE.codexModelAllowPattern;
  }
}

function normalizeProfile(value = {}) {
  const style = ["professional", "royal"].includes(String(value.communicationStyle || "").toLowerCase())
    ? String(value.communicationStyle).toLowerCase()
    : DEFAULT_PROFILE.communicationStyle;
  return {
    schemaVersion: 1,
    communicationStyle: style,
    address: cleanText(value.address, 80),
    updateStyle: ["concise-executive", "technical", "minimal"].includes(String(value.updateStyle || "").toLowerCase())
      ? String(value.updateStyle).toLowerCase()
      : DEFAULT_PROFILE.updateStyle,
    role: cleanText(value.role, 120) || DEFAULT_PROFILE.role,
    codexModelAllowPattern: safePattern(value.codexModelAllowPattern),
    modelPolicyReviewAfter: cleanText(value.modelPolicyReviewAfter, 40),
    cliFirst: value.cliFirst !== false,
    uiFallbackOnly: value.uiFallbackOnly !== false,
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
