"use strict";

const path = require("node:path");
const { readJson } = require("./utils");
const { jobDirectory, listJobIds, listTaskIds } = require("./state-store");

function providerHistory() {
  const rows = [];
  for (const taskId of listTaskIds().slice(-100)) {
    for (const jobId of listJobIds(taskId)) {
      const dir = jobDirectory(taskId, jobId);
      const status = readJson(path.join(dir, "status.json"), {});
      const contract = readJson(path.join(dir, "contract.json"), {});
      const at = Date.parse(status.finishedAt || status.updatedAt || status.createdAt || "") || 0;
      if (status.state && contract.provider) rows.push({ provider: contract.provider, status, at });
    }
  }
  rows.sort((left, right) => right.at - left.at);
  const result = {};
  for (const id of ["codex", "claude", "antigravity", "cursor"]) {
    const terminal = rows.filter((row) => row.provider === id && ["completed", "failed", "cancelled", "rejected"].includes(row.status.state)).slice(0, 8);
    const completed = terminal.filter((row) => row.status.state === "completed").length;
    let consecutiveFailures = 0;
    for (const row of terminal) {
      if (row.status.state !== "failed") break;
      consecutiveFailures += 1;
    }
    const last = terminal[0] || null;
    const lastBlocker = String(last?.status?.blocker || "");
    const outage = /transport-unavailable|authentication-required|provider-timeout/.test(lastBlocker);
    result[id] = {
      samples: terminal.length,
      completed,
      failures: terminal.length - completed,
      successRate: terminal.length ? Number((completed / terminal.length).toFixed(2)) : null,
      consecutiveFailures,
      cooledDown: Boolean(last && (outage || consecutiveFailures >= 2) && last.at >= Date.now() - 60 * 60 * 1000),
      cooldownReason: outage ? lastBlocker.split(":", 1)[0] : (consecutiveFailures >= 2 ? "repeated-provider-failure" : ""),
      lastState: last?.status?.state || "unknown",
      lastAt: last ? new Date(last.at).toISOString() : null,
    };
  }
  return result;
}

module.exports = { providerHistory };
