"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { appendJsonl, bounded, processAlive, readJson, readText, safeWorkspace, terminateTree, utcNow, writeJson } = require("./utils");
const { boundariesOverlap, goalOverlap } = require("./lane-policy");

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

function activeJobs(workspace) {
  const root = primaryRoot(workspace);
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => {
    const dir = path.join(root, entry.name);
    const status = repairStale(dir, readJson(path.join(dir, "status.json"), {}));
    const contract = readJson(path.join(dir, "contract.json"), {});
    return { id: entry.name, dir, status, contract };
  }).filter((row) => ["queued", "starting", "running"].includes(row.status.state));
}

function conflictFor(workspace, contract) {
  const active = activeJobs(workspace);
  const maximum = Math.max(1, Math.min(2, Number(contract.maxExternalWorkers || 2)));
  if (active.length >= maximum) return `Maximum external worker concurrency (${maximum}) is already active.`;
  const incomingPaths = [...(contract.relevantFiles || []), ...(contract.expectedFiles || [])];
  for (const row of active) {
    if (contract.laneKey && row.contract.laneKey === contract.laneKey) return `Duplicate lane is already running as ${row.id}.`;
    const activePaths = [...(row.contract.relevantFiles || []), ...(row.contract.expectedFiles || [])];
    if (boundariesOverlap(incomingPaths, activePaths).length) return `Lane overlaps active job ${row.id}; serialize or choose disjoint files.`;
    if (goalOverlap(contract.goal, row.contract.goal).overlaps) return `A substantially similar lane is already running as ${row.id}.`;
  }
  return "";
}

function createJob(contract, entrypoint) {
  const workspace = safeWorkspace(contract.workspace);
  const conflict = conflictFor(workspace, contract);
  if (conflict) throw new Error(conflict);
  const id = `job-${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`;
  const dir = path.join(primaryRoot(workspace), id);
  fs.mkdirSync(dir, { recursive: true });
  const stored = { ...contract, id, workspace, createdAt: utcNow(), schemaVersion: 2 };
  writeJson(path.join(dir, "contract.json"), stored);
  writeJson(path.join(dir, "status.json"), { id, state: "queued", provider: contract.provider, model: contract.model || "", taskKind: contract.taskKind || "generic", laneKey: contract.laneKey, createdAt: stored.createdAt, updatedAt: stored.createdAt, pid: null, blocker: "", collectedAt: null, collectionCount: 0 });
  fs.writeFileSync(path.join(dir, "request.md"), `${contract.goal}\n`, "utf8");
  event(dir, "job.queued", { provider: contract.provider });
  const payloadFile = path.join(dir, "worker-payload.json");
  writeJson(payloadFile, { workspace, id });
  setStatus(dir, { state: "starting", startedAt: utcNow() });
  const child = spawn(process.execPath, [entrypoint, "worker", "--json-file", payloadFile], { cwd: workspace, detached: true, stdio: "ignore", windowsHide: true });
  child.unref();
  const afterSpawn = readJson(path.join(dir, "status.json"), {});
  if (!["completed", "failed", "cancelled", "rejected"].includes(afterSpawn.state)) setStatus(dir, { state: "running", pid: child.pid, startedAt: afterSpawn.startedAt || utcNow() });
  return { jobId: id, state: readJson(path.join(dir, "status.json"), {}).state || "running", provider: contract.provider, artifactDirectory: dir };
}
function repairStale(dir, status) {
  if (["queued", "starting", "running"].includes(status.state) && status.pid && !processAlive(status.pid)) {
    return setStatus(dir, { state: "failed", finishedAt: utcNow(), blocker: "Worker process exited without a terminal status." });
  }
  return status;
}

function sleep(milliseconds) {
  if (milliseconds <= 0) return;
  const signal = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(signal, 0, 0, milliseconds);
}

function readStatus(found) {
  const current = readJson(path.join(found.dir, "status.json"), {});
  return found.legacy ? current : repairStale(found.dir, current);
}

function readJob(workspaceValue, id, detail = "compact", waitSeconds = 0) {
  const workspace = safeWorkspace(workspaceValue);
  const found = locate(workspace, id);
  const waitLimitMs = Math.max(0, Math.min(60, Number(waitSeconds || 0))) * 1000;
  const waitStarted = Date.now();
  let status = readStatus(found);
  while (!["completed", "failed", "cancelled", "rejected"].includes(status.state) && Date.now() - waitStarted < waitLimitMs) {
    sleep(Math.min(1000, waitLimitMs - (Date.now() - waitStarted)));
    status = readStatus(found);
  }
  const terminal = ["completed", "failed", "cancelled", "rejected"].includes(status.state);
  const alreadyCollected = Boolean(status.collectedAt);
  if (!found.legacy && terminal && !alreadyCollected) {
    status.collectedAt = utcNow();
    status.collectionCount = 1;
    status.integrationState = status.state === "completed" ? "awaiting-current-codex" : "terminal-blocker-collected";
    status.updatedAt = status.collectedAt;
    writeJson(path.join(found.dir, "status.json"), status);
    event(found.dir, "job.collected", { provider: status.provider, state: status.state });
  }
  const contract = readJson(path.join(found.dir, "contract.json"), {});
  const usage = readJson(path.join(found.dir, "usage.json"), {});
  const changedFiles = readJson(path.join(found.dir, "changed-files.json"), null);
  const provider = status.provider || contract.provider || "unknown";
  const includeResult = terminal && (!alreadyCollected || detail === "full" || found.legacy);
  const result = {
    jobId: id, state: status.state || "unknown", provider,
    taskId: contract.taskId || null,
    rootOutcome: contract.projectGoal || "",
    completionEvidence: contract.completionEvidence || [],
    blocker: status.blocker || "", startedAt: status.startedAt || null, finishedAt: status.finishedAt || null,
    waitedSeconds: Number(((Date.now() - waitStarted) / 1000).toFixed(1)),
    collectionReady: terminal,
    alreadyCollected,
    result: includeResult ? readText(path.join(found.dir, "result.md"), detail === "full" ? 30000 : 5000) : "",
    changedFiles: changedFiles || readText(path.join(found.dir, "changed-files.txt"), 4000).split(/\r?\n/).filter(Boolean),
    verification: readJson(path.join(found.dir, "verification-evidence.json"), null), legacyArtifact: found.legacy,
    usage: {
      model: usage.model || status.model || contract.model || "unknown",
      billingMode: contract.providerAuthMode || "unknown",
      inputTokens: usage.inputTokens ?? usage.input_tokens ?? null,
      cachedInputTokens: usage.cachedInputTokens ?? usage.cacheReadInputTokens ?? usage.cache_read_input_tokens ?? null,
      outputTokens: usage.outputTokens ?? usage.output_tokens ?? null,
      apiCostUsd: contract.providerAuthMode === "api-key" ? (usage.equivalentUsd ?? usage.total_cost_usd ?? usage.costUsdEquivalent ?? null) : null,
      billingNote: contract.providerAuthMode === "subscription" ? "Included subscription usage; no dollar balance or PAYG cap is shown." : (usage.billingNote || ""),
      budgetExceeded: usage.budgetExceeded === true,
    },
    ownership: { currentCodex: contract.currentCodexGoal || "", worker: contract.goal || "", workerFiles: [...(contract.relevantFiles || []), ...(contract.expectedFiles || [])] },
    integration: terminal
      ? { required: status.state === "completed", projectCompleteAllowed: false, expectedContribution: contract.expectedContribution || "", action: contract.integrationAction || "", instruction: alreadyCollected && detail !== "full" && !found.legacy ? "This result was already collected, so compact mode did not repeat it. Use the prior result; request full detail only to recover from an interrupted integration." : (status.state === "completed" ? "Apply the declared integration action once, then continue the root outcome. Worker completion alone never completes the project." : "Use this blocker once; either take the lane into current Codex or fail over once to a materially different provider.") }
      : { required: false, instruction: "Continue the disjoint current-Codex lane. Do not poll this job; collect it once at the declared integration point or lease." },
  };
  if (detail === "full") {
    result.diff = readText(path.join(found.dir, "worker.diff"), 50000);
    result.events = readText(path.join(found.dir, "events.jsonl"), 20000);
    result.rawUsage = usage;
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

module.exports = { activeJobs, cancelJob, conflictFor, createJob, event, jobDirectory, readJob, setStatus };
