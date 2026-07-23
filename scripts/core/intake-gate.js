"use strict";

const crypto = require("node:crypto");

const DIRECT_THRESHOLD_SECONDS = 60;
const DIRECT_OVERRIDES = new Set(["direct", "host", "bypass"]);
const PROGRAM_OVERRIDES = new Set(["program", "orchestrate", "orchestration"]);

const SIGNALS = [
  ["long-horizon", /\b(unattended|overnight|multi[- ]?day|days?|weeks?|long[- ]?(?:running|horizon)|keep (?:it )?(?:working|running)|until (?:it is )?(?:done|complete))\b/i],
  ["project-delivery", /\b(build|implement|refactor|migrate|deploy|publish|ship|release|architecture|orchestrat(?:e|ion)|project)\b/i],
  ["broad-context", /\b(all (?:the )?(?:chats?|threads?|history|context)|full context|project history|across (?:the )?(?:project|repository|repo))\b/i],
  ["planning-required", /\b(milestones?|critical path|workstreams?|roadmap|master plan|team members?|resource budget|timeline)\b/i],
  ["high-impact-operation", /\b(production|database migration|drop (?:a )?(?:table|database)|delete (?:all|production)|payment|billing|credential|rotate (?:a )?(?:key|secret)|irreversible)\b/i],
  ["diagnostic-uncertainty", /\b(root cause|repeated(?:ly)? fail|keeps? failing|unknown failure|reconcile|why (?:does|is|did) .{0,80}(?:fail|broken|stuck))\b/i],
  ["multi-stage-language", /\b(first|initially)\b[\s\S]{0,500}\b(then|after that|next|finally)\b/i],
];

function stableHash(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 24);
}

function textOf(input) {
  return String(input?.request || input?.prompt || input?.outcome || input?.goal || "").trim();
}

function explicitOverride(input) {
  const candidates = [input?.override, input?.mode, input?.orchestrationMode]
    .map((value) => String(value || "").trim().toLowerCase())
    .filter(Boolean);
  if (input?.forceDirect === true) candidates.push("direct");
  if (input?.forceProgram === true || input?.forceOrchestration === true) candidates.push("program");
  const modes = new Set(candidates.map((value) => DIRECT_OVERRIDES.has(value)
    ? "direct"
    : PROGRAM_OVERRIDES.has(value)
      ? "program"
      : value));
  if (modes.has("direct") && modes.has("program")) throw new Error("Conflicting direct and program intake overrides.");
  const unknown = [...modes].filter((value) => value !== "auto" && value !== "direct" && value !== "program");
  if (unknown.length) throw new Error(`Unknown intake override: ${unknown[0]}`);
  return modes.has("direct") ? "direct" : modes.has("program") ? "program" : "auto";
}

function declaredSourceCount(input) {
  const sourceCatalogCount = Array.isArray(input?.sourceCatalog?.sources) ? input.sourceCatalog.sources.length : 0;
  const descriptors = input?.sourceDescriptors && typeof input.sourceDescriptors === "object"
    ? Object.values(input.sourceDescriptors).reduce((sum, value) => sum + (Array.isArray(value) ? value.length : value ? 1 : 0), 0)
    : 0;
  return sourceCatalogCount || descriptors;
}

function estimateSeconds(input, text, signals) {
  const supplied = Number(input?.expectedDurationSeconds ?? input?.estimatedDurationSeconds);
  if (Number.isFinite(supplied) && supplied >= 0) return Math.round(Math.min(supplied, 365 * 24 * 60 * 60));
  const words = text ? text.split(/\s+/).length : 0;
  const checklistLines = text.split(/\r?\n/).filter((line) => /^\s*(?:[-*]|\d+[.)])\s+/.test(line)).length;
  const base = 12 + Math.ceil(words / 8) * 4 + checklistLines * 12;
  const signalCost = signals.reduce((sum, signal) => sum + ({
    "long-horizon": 3600,
    "project-delivery": 180,
    "broad-context": 180,
    "planning-required": 180,
    "high-impact-operation": 300,
    "diagnostic-uncertainty": 120,
    "multi-stage-language": 90,
    "multiple-authorized-sources": 90,
  }[signal] || 60), 0);
  return Math.max(10, Math.min(365 * 24 * 60 * 60, base + signalCost));
}

function decideIntake(input = {}) {
  const text = textOf(input);
  if (!text) throw new Error("Intake requires a request, prompt, outcome, or goal.");
  const override = explicitOverride(input);
  const signals = SIGNALS.filter(([, pattern]) => pattern.test(text)).map(([code]) => code);
  const sourceCount = declaredSourceCount(input);
  if (sourceCount > 2) signals.push("multiple-authorized-sources");
  const suppliedDuration = Number(input.expectedDurationSeconds ?? input.estimatedDurationSeconds);
  if (Number.isFinite(suppliedDuration) && suppliedDuration > DIRECT_THRESHOLD_SECONDS) signals.unshift("declared-over-one-minute");
  const uniqueSignals = [...new Set(signals)];
  const estimatedDurationSeconds = estimateSeconds(input, text, uniqueSignals);
  const naturallyProgram = estimatedDurationSeconds > DIRECT_THRESHOLD_SECONDS || uniqueSignals.length > 0;
  const mode = override === "direct" ? "direct" : override === "program" ? "program" : naturallyProgram ? "program" : "direct";
  const reasonCodes = override !== "auto"
    ? [`explicit-${override}-override`, ...uniqueSignals]
    : mode === "direct"
      ? ["estimated-within-one-minute", "no-complexity-signal"]
      : [estimatedDurationSeconds > DIRECT_THRESHOLD_SECONDS ? "estimated-over-one-minute" : "complexity-signal", ...uniqueSignals];
  const decisionBasis = {
    mode,
    override,
    thresholdSeconds: DIRECT_THRESHOLD_SECONDS,
    estimatedDurationSeconds,
    reasonCodes,
    complexSignals: uniqueSignals,
    declaredSourceCount: sourceCount,
  };
  return {
    schemaVersion: "director-cfo/intake-decision@1",
    ...decisionBasis,
    orchestrationRequired: mode === "program",
    directExecutionAllowed: mode === "direct",
    conservativeEstimate: !Number.isFinite(suppliedDuration),
    decisionFingerprint: stableHash(decisionBasis),
  };
}

module.exports = {
  DIRECT_THRESHOLD_SECONDS,
  decideIntake,
  explicitOverride,
};
