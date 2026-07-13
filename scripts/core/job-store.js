"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { appendJsonl, bounded, processAlive, readJson, readText, safeWorkspace, terminateTree, utcNow, writeJson } = require("./utils");

function primaryRoot(workspace) { return path.join(workspace, ".ai-mobile", "jobs"); }
function legacyRoot(workspace) { return path.join(workspace, ".antigravity-bridge", "jobs"); }
function safeId(value) {
  const id = String(value || "").trim();
  if (!/^[A-Za-z0-9._-]{6,100}$/.test(id)) throw new Error("Invalid job id.");
  return id;
}
function locate(workspace, id) {
  const clean = safeId(id);
  for (const root of [primaryRoot(workspace), legacyRoot(workspace)]) {
    const dir = path.join(root, clean);
    if (fs.existsSync(dir)) return { dir, legacy: root.includes(".antigravity-bridge") };
  }
  throw new Error(`Job not found: ${clean}`);
}
function event(dir, type, data = {}) { appendJsonl(path.join(dir, "events.jsonl"), { at: utcNow(), type, ...data }); }
function setStatus(dir, patch) {
  const current = readJson(path.join(dir, "status.json"), {});
  const next = { ...current, ...patch, updatedAt: utcNow() };
  writeJson(path.join(dir, "status.json"), next);
  event(dir, `job.${next.state || "updated"}`, { provider: next.provider, blocker: next.blocker || "" });
  return next;
}
function createJob(contract, entrypoint) {
  const workspace = safeWorkspace(contract.workspace);
  const id = `job-${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`;
  const dir = path.join(primaryRoot(workspace), id);
  fs.mkdirSync(dir, { recursive: true });
  const stored = { ...contract, id, workspace, createdAt: utcNow(), schemaVersion: 2 };
  writeJson(path.join(dir, "contract.json"), stored);
  writeJson(path.join(dir, "status.json"), { id, state: "queued", provider: contract.provider, createdAt: stored.createdAt, updatedAt: stored.createdAt, pid: null, blocker: "" });
  fs.writeFileSync(path.join(dir, "request.md"), `${contract.goal}\n`, "utf8");
  event(dir, "job.queued", { provider: contract.provider });
  const payloadFile = path.join(dir, "worker-payload.json");
  writeJson(payloadFile, { workspace, id });
  const child = spawn(process.execPath, [entrypoint, "worker", "--json-file", payloadFile], { cwd: workspace, detached: true, stdio: "ignore", windowsHide: true });
  child.unref();
  setStatus(dir, { state: "running", pid: child.pid, startedAt: utcNow() });
  return { jobId: id, state: "running", provider: contract.provider, artifactDirectory: dir };
}
function repairStale(dir, status) {
  if (["queued", "running"].includes(status.state) && status.pid && !processAlive(status.pid)) {
    return setStatus(dir, { state: "failed", finishedAt: utcNow(), blocker: "Worker process exited without a terminal status." });
  }
  return status;
}
function readJob(workspaceValue, id, detail = "compact") {
  const workspace = safeWorkspace(workspaceValue);
  const found = locate(workspace, id);
  const status = found.legacy ? readJson(path.join(found.dir, "status.json"), {}) : repairStale(found.dir, readJson(path.join(found.dir, "status.json"), {}));
  const result = {
    jobId: id, state: status.state || "unknown", provider: status.provider || readJson(path.join(found.dir, "contract.json"), {})?.provider || "unknown",
    blocker: status.blocker || "", startedAt: status.startedAt || null, finishedAt: status.finishedAt || null,
    result: readText(path.join(found.dir, "result.md"), detail === "full" ? 30000 : 5000),
    changedFiles: readJson(path.join(found.dir, "changed-files.json"), []),
    verification: readJson(path.join(found.dir, "verification-evidence.json"), null), legacyArtifact: found.legacy,
  };
  if (detail === "full") {
    result.diff = readText(path.join(found.dir, "worker.diff"), 50000);
    result.events = readText(path.join(found.dir, "events.jsonl"), 20000);
    result.usage = readJson(path.join(found.dir, "usage.json"), {});
  }
  return result;
}
function cancelJob(workspaceValue, id) {
  const workspace = safeWorkspace(workspaceValue);
  const found = locate(workspace, id);
  if (found.legacy) throw new Error("Legacy artifacts are read-only; cancel through their original runtime.");
  const status = readJson(path.join(found.dir, "status.json"), {});
  if (["completed", "failed", "cancelled", "rejected"].includes(status.state)) return { jobId: id, state: status.state, alreadyTerminal: true };
  const stopped = terminateTree(status.pid);
  const next = setStatus(found.dir, { state: "cancelled", finishedAt: utcNow(), blocker: "Cancelled by caller." });
  return { jobId: id, state: next.state, stopped };
}
function jobDirectory(workspace, id) { return locate(safeWorkspace(workspace), id).dir; }

module.exports = { cancelJob, createJob, event, jobDirectory, readJob, setStatus };
