"use strict";

function stripAnsi(value) {
  return String(value || "").replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

function timezoneOffsetMs(date, timeZone) {
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(date);
    const values = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)]));
    return Date.UTC(values.year, values.month - 1, values.day, values.hour, values.minute, values.second) - date.getTime();
  } catch {
    return null;
  }
}

function resetIso(value, now = new Date()) {
  const source = String(value || "").trim();
  const timeZone = source.match(/\(([^)]+\/[^)]+)\)\s*$/)?.[1] || "";
  const raw = source.replace(/\s*\([^)]*\)\s*$/, "").trim();
  const match = raw.match(/^([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i);
  if (!match) return null;
  const month = new Date(`${match[1]} 1, 2000`).getMonth();
  if (!Number.isFinite(month)) return null;
  let hour = Number(match[3]) % 12;
  if (match[5].toLowerCase() === "pm") hour += 12;
  const minute = Number(match[4] || 0);
  const build = (year) => {
    const localUtc = Date.UTC(year, month, Number(match[2]), hour, minute, 0);
    if (!timeZone) return new Date(localUtc).toISOString();
    let candidate = localUtc;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const offset = timezoneOffsetMs(new Date(candidate), timeZone);
      if (!Number.isFinite(offset)) return null;
      candidate = localUtc - offset;
    }
    return new Date(candidate).toISOString();
  };
  let result = build(now.getFullYear());
  if (result && Date.parse(result) < now.getTime() - 24 * 60 * 60 * 1000) result = build(now.getFullYear() + 1);
  return result;
}

function scopeId(value) {
  const text = String(value || "all").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return text === "all-models" ? "all" : text || "all";
}

function parseClaudeUsage(output, now = new Date()) {
  const windows = [];
  for (const rawLine of stripAnsi(output).split(/\r?\n/)) {
    const line = rawLine.trim();
    const match = line.match(/^Current\s+(session|week(?:\s+\(([^)]+)\))?):\s*([\d.]+)%\s+used\s*[·-]\s*resets\s+(.+)$/i);
    if (!match) continue;
    const session = match[1].toLowerCase() === "session";
    const scope = session ? "all" : scopeId(match[2] || "all models");
    const usedPercent = Math.max(0, Math.min(100, Number(match[3])));
    windows.push({
      id: session ? "five-hour" : `weekly-${scope}`,
      period: session ? "five-hour" : "weekly",
      scope,
      usedPercent,
      remainingPercent: Number((100 - usedPercent).toFixed(1)),
      resetAt: resetIso(match[4], now),
      resetText: match[4].trim(),
    });
  }
  return windows;
}

function parseClaudeAuth(stdout, env = process.env) {
  let body = null;
  try { body = JSON.parse(String(stdout || "")); } catch { /* keep unknown */ }
  const loggedIn = body?.loggedIn === true;
  const subscription = loggedIn && String(body?.authMethod || "").toLowerCase() === "claude.ai" && /^(pro|max|team|enterprise)\b/i.test(String(body?.subscriptionType || ""));
  const apiKey = Boolean(String(env.ANTHROPIC_API_KEY || "").trim());
  return {
    loggedIn,
    authMode: apiKey ? "api-key" : (subscription ? "subscription" : (loggedIn ? "unknown" : "none")),
    subscriptionType: subscription ? String(body.subscriptionType).toLowerCase() : "",
  };
}

function parseClaudeModels(helpText) {
  const text = String(helpText || "");
  const aliases = [...new Set((text.match(/\b(?:haiku|sonnet|opus|fable)\b/gi) || []).map((item) => item.toLowerCase()))];
  const exact = [...new Set((text.match(/\bclaude-[a-z0-9.-]+\b/gi) || []).map((item) => item.toLowerCase()))];
  return aliases.map((id) => ({ id, displayName: exact.find((model) => model.includes(`-${id}-`) || model.endsWith(`-${id}`)) || `Claude ${id[0].toUpperCase()}${id.slice(1)} (alias)` }));
}

function windowsForModel(windows = [], model = "") {
  const family = String(model || "").toLowerCase();
  return windows.filter((window) => window.scope === "all" || family.includes(window.scope));
}

module.exports = { parseClaudeAuth, parseClaudeModels, parseClaudeUsage, resetIso, windowsForModel };
