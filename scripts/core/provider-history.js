"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { readJson } = require("./utils");

function providerId(status = {}) {
  const value = String(status.provider || status.worker || "").toLowerCase();
  if (value.includes("claude")) return "claude";
  if (value.includes("antigravity")) return "antigravity";
  if (value.includes("codex")) return "codex";
  if (value.includes("cursor")) return "cursor";
  return value;
}

function statusTime(status = {}, fallback = 0) {
  return Date.parse(status.finishedAt || status.updatedAt || status.completedAt || status.createdAt || "") || fallback;
}

function readRows(root, limit = 40) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const dir = path.join(root, entry.name);
      const status = readJson(path.join(dir, "status.json"), {});
      let fallback = 0;
      try { fallback = fs.statSync(dir).mtimeMs; } catch { /* ignored */ }
      return { id: entry.name, status, at: statusTime(status, fallback) };
    })
    .filter((row) => row.status && Object.keys(row.status).length)
    .sort((a, b) => b.at - a.at)
    .slice(0, limit);
}

function providerHistory(workspace) {
  const rows = [
    ...readRows(path.join(workspace, ".ai-mobile", "jobs")),
    ...readRows(path.join(workspace, ".antigravity-bridge", "jobs")),
  ].sort((a, b) => b.at - a.at).slice(0, 60);
  const result = {};
  for (const id of ["codex", "claude", "antigravity", "cursor"]) {
    const providerRows = rows.filter((row) => providerId(row.status) === id).slice(0, 8);
    const terminal = providerRows.filter((row) => ["completed", "failed", "cancelled", "rejected"].includes(row.status.state));
    const completed = terminal.filter((row) => row.status.state === "completed").length;
    const failures = terminal.filter((row) => row.status.state === "failed").length;
    let consecutiveFailures = 0;
    for (const row of terminal) {
      if (row.status.state !== "failed") break;
      consecutiveFailures += 1;
    }
    const lastAt = terminal[0]?.at || 0;
    const lastBlocker = String(terminal[0]?.status?.blocker || terminal[0]?.status?.warning || "");
    const immediateOutage = /transport-unavailable|authentication-required|provider-timeout/.test(lastBlocker);
    result[id] = {
      samples: terminal.length,
      completed,
      failures,
      successRate: terminal.length ? Number((completed / terminal.length).toFixed(2)) : null,
      consecutiveFailures,
      cooledDown: (immediateOutage || consecutiveFailures >= 2) && lastAt >= Date.now() - 60 * 60 * 1000,
      cooldownReason: immediateOutage ? lastBlocker.split(":", 1)[0] : (consecutiveFailures >= 2 ? "repeated-provider-failure" : ""),
      lastState: terminal[0]?.status?.state || "unknown",
      lastAt: terminal[0] ? new Date(lastAt).toISOString() : null,
    };
  }
  return result;
}

module.exports = { providerHistory };
