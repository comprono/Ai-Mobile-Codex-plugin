"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const DEFAULT_MAX_FILES = 24;
const DEFAULT_TAIL_BYTES = 512 * 1024;
const DEFAULT_FRESH_MS = 15 * 60 * 1000;

function safeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function resetIso(value) {
  const seconds = safeNumber(value);
  return seconds === null || seconds <= 0 ? "" : new Date(seconds * 1000).toISOString();
}

function windowId(window, fallback) {
  const minutes = safeNumber(window?.window_minutes);
  if (minutes === 300) return "five_hour";
  if (minutes === 10080) return "seven_day";
  if (minutes !== null && minutes > 0) return `window_${Math.round(minutes)}m`;
  return fallback;
}

function normalizeWindow(window, fallback) {
  if (!window || typeof window !== "object") return null;
  const usedPercent = safeNumber(window.used_percent);
  const windowMinutes = safeNumber(window.window_minutes);
  if (usedPercent === null && windowMinutes === null && !window.resets_at) return null;
  return {
    id: windowId(window, fallback),
    usedPercent,
    remainingPercent: usedPercent === null ? null : Math.max(0, Math.min(100, Math.round((100 - usedPercent) * 10) / 10)),
    windowMinutes,
    resetAt: resetIso(window.resets_at),
    scope: String(window.scope || "codex-agentic-usage"),
  };
}

function parseTokenCountEvent(line) {
  let row;
  try {
    row = JSON.parse(String(line || ""));
  } catch {
    return null;
  }
  if (row?.type !== "event_msg" || row?.payload?.type !== "token_count") return null;
  const rateLimits = row.payload.rate_limits;
  if (!rateLimits || typeof rateLimits !== "object") return null;
  const windows = [
    normalizeWindow(rateLimits.primary, "primary"),
    normalizeWindow(rateLimits.secondary, "secondary"),
    normalizeWindow(rateLimits.individual_limit, "individual"),
  ].filter(Boolean);
  if (!windows.length) return null;

  const usage = row.payload.info?.total_token_usage || {};
  return {
    schemaVersion: 1,
    source: "codex-local-session-telemetry",
    evidence: "measured-local-undocumented-schema",
    observedAt: String(row.timestamp || ""),
    limitId: String(rateLimits.limit_id || ""),
    limitName: String(rateLimits.limit_name || ""),
    planType: String(rateLimits.plan_type || ""),
    rateLimitReachedType: String(rateLimits.rate_limit_reached_type || ""),
    credits: rateLimits.credits && typeof rateLimits.credits === "object"
      ? {
          hasCredits: rateLimits.credits.has_credits === true,
          unlimited: rateLimits.credits.unlimited === true,
          balance: safeNumber(rateLimits.credits.balance),
        }
      : null,
    windows,
    currentSession: {
      contextWindow: safeNumber(row.payload.info?.model_context_window),
      inputTokens: safeNumber(usage.input_tokens),
      cachedInputTokens: safeNumber(usage.cached_input_tokens),
      outputTokens: safeNumber(usage.output_tokens),
      reasoningOutputTokens: safeNumber(usage.reasoning_output_tokens),
      totalTokens: safeNumber(usage.total_tokens),
    },
  };
}

function listRecentJsonlFiles(root, maxFiles = DEFAULT_MAX_FILES) {
  if (!root || !fs.existsSync(root)) return [];
  const pending = [root];
  const files = [];
  let visitedDirectories = 0;
  while (pending.length && visitedDirectories < 96 && files.length < maxFiles * 8) {
    const current = pending.pop();
    visitedDirectories += 1;
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(fullPath);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(".jsonl")) {
        try {
          files.push({ path: fullPath, mtimeMs: fs.statSync(fullPath).mtimeMs });
        } catch {
          // File may have rotated while it was being inspected.
        }
      }
    }
  }
  return files.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, maxFiles);
}

function readTail(filePath, maxBytes = DEFAULT_TAIL_BYTES) {
  const handle = fs.openSync(filePath, "r");
  try {
    const stat = fs.fstatSync(handle);
    const length = Math.min(stat.size, maxBytes);
    const buffer = Buffer.alloc(length);
    fs.readSync(handle, buffer, 0, length, Math.max(0, stat.size - length));
    return buffer.toString("utf8");
  } finally {
    fs.closeSync(handle);
  }
}

function deriveState(telemetry) {
  const remaining = telemetry.windows
    .map((window) => window.remainingPercent)
    .filter(Number.isFinite);
  const effectiveRemainingPercent = remaining.length ? Math.min(...remaining) : null;
  let state = "unknown";
  if (effectiveRemainingPercent !== null) {
    if (effectiveRemainingPercent <= 0) state = "exhausted";
    else if (effectiveRemainingPercent < 10) state = "critical";
    else if (effectiveRemainingPercent < 25) state = "low";
    else if (effectiveRemainingPercent < 50) state = "medium";
    else state = "healthy";
  }
  return { state, effectiveRemainingPercent };
}

function readCodexUsageTelemetry(options = {}) {
  const codexHome = options.codexHome || process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  const sessionsRoot = options.sessionsRoot || path.join(codexHome, "sessions");
  const nowMs = options.nowMs ?? Date.now();
  const freshMs = options.freshMs ?? DEFAULT_FRESH_MS;
  const files = listRecentJsonlFiles(sessionsRoot, options.maxFiles || DEFAULT_MAX_FILES);
  for (const file of files) {
    let text;
    try {
      text = readTail(file.path, options.maxTailBytes || DEFAULT_TAIL_BYTES);
    } catch {
      continue;
    }
    const lines = text.split(/\r?\n/);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const telemetry = parseTokenCountEvent(lines[index]);
      if (!telemetry) continue;
      const observedMs = Date.parse(telemetry.observedAt);
      const ageMs = Number.isFinite(observedMs) ? Math.max(0, nowMs - observedMs) : null;
      const state = deriveState(telemetry);
      return {
        found: true,
        ...telemetry,
        ...state,
        ageSeconds: ageMs === null ? null : Math.round(ageMs / 1000),
        fresh: ageMs !== null && ageMs <= freshMs,
        privacy: "Only token_count capacity metadata was returned; prompts, responses, paths, and thread identifiers were discarded.",
      };
    }
  }
  return {
    found: false,
    schemaVersion: 1,
    source: "codex-local-session-telemetry",
    evidence: "unknown",
    observedAt: "",
    fresh: false,
    state: "unknown",
    effectiveRemainingPercent: null,
    windows: [],
    reason: "No recent supported token_count rate-limit event was found. The local schema may be unavailable or changed.",
    privacy: "No transcript content was returned.",
  };
}

module.exports = {
  deriveState,
  normalizeWindow,
  parseTokenCountEvent,
  readCodexUsageTelemetry,
};
