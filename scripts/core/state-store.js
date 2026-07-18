"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { localDataFile, readJson, safeWorkspace, utcNow, writeJson } = require("./utils");

const ID_PATTERN = /^(portfolio|task|round|job)-[A-Za-z0-9._-]{8,100}$/;

function stateRoot() {
  return process.env.AI_MOBILE_DATA_ROOT
    ? path.resolve(process.env.AI_MOBILE_DATA_ROOT)
    : localDataFile("v1");
}

function safeId(value, prefix) {
  const id = String(value || "").trim();
  if (!ID_PATTERN.test(id) || (prefix && !id.startsWith(`${prefix}-`))) {
    throw new Error(`Invalid ${prefix || "state"} id.`);
  }
  return id;
}

function newId(prefix) {
  const stamp = Date.now().toString(36);
  const random = crypto.randomBytes(6).toString("hex");
  return `${prefix}-${stamp}-${random}`;
}

function workspaceKey(workspaceValue) {
  const workspace = safeWorkspace(workspaceValue);
  return crypto.createHash("sha256").update(workspace.toLowerCase()).digest("hex").slice(0, 20);
}

function taskDirectory(taskId) {
  return path.join(stateRoot(), "tasks", safeId(taskId, "task"));
}

function taskFile(taskId) {
  return path.join(taskDirectory(taskId), "task.json");
}

function createTaskRecord(input) {
  const workspace = safeWorkspace(input.workspace);
  const taskId = newId("task");
  const now = utcNow();
  const record = {
    schemaVersion: 1,
    taskId,
    portfolioId: input.portfolioId || null,
    projectId: input.projectId || null,
    priority: Number.isFinite(Number(input.priority)) ? Number(input.priority) : 50,
    workspace,
    workspaceKey: workspaceKey(workspace),
    state: "active",
    outcome: String(input.outcome || "").trim(),
    requestedOutcome: String(input.requestedOutcome || input.outcome || "").trim(),
    latestUserRequest: String(input.latestUserRequest || "").trim(),
    outcomeReconciliation: input.outcomeReconciliation || null,
    outcomeAuthority: input.outcomeAuthority === "user" ? "user" : "auto",
    projectContext: input.projectContext || null,
    contractVersion: Number.isInteger(input.contractVersion) ? input.contractVersion : 1,
    revisedAt: input.revisedAt || null,
    requirements: input.requirements || [],
    constraints: input.constraints || [],
    currentCodex: input.currentCodex || {},
    capacitySnapshot: input.capacitySnapshot || null,
    rounds: [],
    evidence: [],
    blockers: input.blockers || [],
    workGraph: input.workGraph || [],
    createdAt: now,
    updatedAt: now,
  };
  fs.mkdirSync(taskDirectory(taskId), { recursive: true });
  writeJson(taskFile(taskId), record);
  return record;
}

function portfolioDirectory(portfolioId) {
  return path.join(stateRoot(), "portfolios", safeId(portfolioId, "portfolio"));
}

function portfolioFile(portfolioId) {
  return path.join(portfolioDirectory(portfolioId), "portfolio.json");
}

function createPortfolioRecord(input) {
  const portfolioId = newId("portfolio");
  const now = utcNow();
  const record = {
    schemaVersion: 1,
    portfolioId,
    state: "active",
    outcome: String(input.outcome || "").trim(),
    requirements: input.requirements || [],
    projects: input.projects || [],
    capacitySnapshot: input.capacitySnapshot || null,
    currentCodex: input.currentCodex || {},
    allocationPolicy: input.allocationPolicy || {},
    rounds: [],
    evidence: [],
    createdAt: now,
    updatedAt: now,
  };
  fs.mkdirSync(portfolioDirectory(portfolioId), { recursive: true });
  writeJson(portfolioFile(portfolioId), record);
  return record;
}

function readPortfolio(portfolioId) {
  const id = safeId(portfolioId, "portfolio");
  const record = readJson(portfolioFile(id), null);
  if (!record) throw new Error(`AI Mobile portfolio not found: ${id}`);
  return record;
}

function readTask(taskId) {
  const id = safeId(taskId, "task");
  const record = readJson(taskFile(id), null);
  if (!record) throw new Error(`AI Mobile task not found: ${id}`);
  return record;
}

function lockDirectory(taskId) {
  return path.join(taskDirectory(taskId), ".lock");
}

function acquireLock(taskId) {
  const dir = lockDirectory(taskId);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.mkdirSync(dir);
      writeJson(path.join(dir, "owner.json"), { pid: process.pid, acquiredAt: utcNow() });
      return dir;
    } catch (error) {
      if (String(error.code || "") !== "EEXIST") throw error;
      let stale = false;
      try { stale = Date.now() - fs.statSync(dir).mtimeMs > 2 * 60 * 1000; } catch { stale = true; }
      if (!stale) throw new Error(`AI Mobile task is busy: ${taskId}`);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  throw new Error(`Unable to lock AI Mobile task: ${taskId}`);
}

function withTaskLock(taskId, action) {
  const dir = acquireLock(taskId);
  try { return action(); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

function portfolioLockDirectory(portfolioId) {
  return path.join(portfolioDirectory(portfolioId), ".lock");
}

function withPortfolioLock(portfolioId, action) {
  const dir = portfolioLockDirectory(portfolioId);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.mkdirSync(dir);
      writeJson(path.join(dir, "owner.json"), { pid: process.pid, acquiredAt: utcNow() });
      break;
    } catch (error) {
      if (String(error.code || "") !== "EEXIST") throw error;
      let stale = false;
      try { stale = Date.now() - fs.statSync(dir).mtimeMs > 2 * 60 * 1000; } catch { stale = true; }
      if (!stale || attempt === 1) throw new Error(`AI Mobile portfolio is busy: ${portfolioId}`);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  try { return action(); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

function updateTask(taskId, mutator) {
  return withTaskLock(taskId, () => {
    const record = readTask(taskId);
    const next = mutator({ ...record }) || record;
    next.updatedAt = utcNow();
    writeJson(taskFile(taskId), next);
    return next;
  });
}

function updatePortfolio(portfolioId, mutator) {
  return withPortfolioLock(portfolioId, () => {
    const record = readPortfolio(portfolioId);
    const next = mutator({ ...record }) || record;
    next.updatedAt = utcNow();
    writeJson(portfolioFile(portfolioId), next);
    return next;
  });
}

function roundDirectory(taskId) {
  return path.join(taskDirectory(taskId), "rounds");
}

function roundFile(taskId, roundId) {
  return path.join(roundDirectory(taskId), `${safeId(roundId, "round")}.json`);
}

function createRoundRecord(taskId, input) {
  const roundId = newId("round");
  const now = utcNow();
  const record = { schemaVersion: 1, roundId, taskId: safeId(taskId, "task"), state: "running", createdAt: now, updatedAt: now, ...input };
  fs.mkdirSync(roundDirectory(taskId), { recursive: true });
  writeJson(roundFile(taskId, roundId), record);
  updateTask(taskId, (task) => {
    task.rounds = [...(task.rounds || []), { roundId, state: record.state, createdAt: now }].slice(-50);
    return task;
  });
  return record;
}

function readRound(taskId, roundId) {
  const record = readJson(roundFile(taskId, roundId), null);
  if (!record) throw new Error(`AI Mobile round not found: ${roundId}`);
  return record;
}

function updateRound(taskId, roundId, patch) {
  const current = readRound(taskId, roundId);
  const next = { ...current, ...patch, updatedAt: utcNow() };
  writeJson(roundFile(taskId, roundId), next);
  updateTask(taskId, (task) => {
    task.rounds = (task.rounds || []).map((row) => row.roundId === roundId ? { ...row, state: next.state, updatedAt: next.updatedAt } : row);
    return task;
  });
  return next;
}

function portfolioRoundDirectory(portfolioId) {
  return path.join(portfolioDirectory(portfolioId), "rounds");
}

function portfolioRoundFile(portfolioId, roundId) {
  return path.join(portfolioRoundDirectory(portfolioId), `${safeId(roundId, "round")}.json`);
}

function createPortfolioRoundRecord(portfolioId, input) {
  const roundId = newId("round");
  const now = utcNow();
  const record = { schemaVersion: 1, roundId, portfolioId: safeId(portfolioId, "portfolio"), state: "running", createdAt: now, updatedAt: now, ...input };
  fs.mkdirSync(portfolioRoundDirectory(portfolioId), { recursive: true });
  writeJson(portfolioRoundFile(portfolioId, roundId), record);
  updatePortfolio(portfolioId, (portfolio) => {
    portfolio.rounds = [...(portfolio.rounds || []), { roundId, state: record.state, createdAt: now }].slice(-50);
    return portfolio;
  });
  return record;
}

function readPortfolioRound(portfolioId, roundId) {
  const record = readJson(portfolioRoundFile(portfolioId, roundId), null);
  if (!record) throw new Error(`AI Mobile portfolio round not found: ${roundId}`);
  return record;
}

function updatePortfolioRound(portfolioId, roundId, patch) {
  const current = readPortfolioRound(portfolioId, roundId);
  const next = { ...current, ...patch, updatedAt: utcNow() };
  writeJson(portfolioRoundFile(portfolioId, roundId), next);
  updatePortfolio(portfolioId, (portfolio) => {
    portfolio.rounds = (portfolio.rounds || []).map((row) => row.roundId === roundId ? { ...row, state: next.state, updatedAt: next.updatedAt } : row);
    return portfolio;
  });
  return next;
}

function jobsDirectory(taskId) {
  return path.join(taskDirectory(taskId), "jobs");
}

function jobDirectory(taskId, jobId) {
  return path.join(jobsDirectory(taskId), safeId(jobId, "job"));
}

function listJobIds(taskId) {
  const root = jobsDirectory(taskId);
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && ID_PATTERN.test(entry.name))
    .map((entry) => entry.name);
}

function listTaskIds() {
  const root = path.join(stateRoot(), "tasks");
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && ID_PATTERN.test(entry.name) && entry.name.startsWith("task-"))
    .map((entry) => entry.name);
}

function listPortfolioIds() {
  const root = path.join(stateRoot(), "portfolios");
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && ID_PATTERN.test(entry.name) && entry.name.startsWith("portfolio-"))
    .map((entry) => entry.name);
}

module.exports = {
  createRoundRecord,
  createPortfolioRecord,
  createPortfolioRoundRecord,
  createTaskRecord,
  jobDirectory,
  jobsDirectory,
  listJobIds,
  listPortfolioIds,
  listTaskIds,
  newId,
  readRound,
  readPortfolio,
  readPortfolioRound,
  readTask,
  safeId,
  stateRoot,
  taskDirectory,
  portfolioDirectory,
  updateRound,
  updatePortfolio,
  updatePortfolioRound,
  updateTask,
  workspaceKey,
};
