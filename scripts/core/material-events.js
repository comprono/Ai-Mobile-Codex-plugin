"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const {
  portfolioDirectory,
  readPortfolio,
  readTask,
  safeId,
  taskDirectory,
} = require("./state-store");
const { bounded, readJson, utcNow, withDirectoryLock, writeJson } = require("./utils");

const MAX_EVENTS = 200;
const MAX_EVENT_BYTES = 24 * 1024;

function target(input = {}) {
  if (input.portfolioId) {
    const portfolioId = safeId(input.portfolioId, "portfolio");
    readPortfolio(portfolioId);
    return { type: "portfolio", id: portfolioId, root: portfolioDirectory(portfolioId), portfolioId };
  }
  const taskId = safeId(input.taskId, "task");
  readTask(taskId);
  return { type: "task", id: taskId, root: taskDirectory(taskId), taskId };
}

function eventPath(input) {
  return path.join(target(input).root, "material-events.jsonl");
}

function eventStatePath(input) {
  return path.join(target(input).root, "material-events-state.json");
}

function fingerprint(event) {
  const stable = {
    type: event.type || "transition",
    state: event.state || "",
    roundId: event.roundId || "",
    jobId: event.jobId || "",
    projectId: event.projectId || "",
    requirementId: event.requirementId || "",
    provider: event.provider || "",
    model: event.model || "",
    summary: bounded(event.summary, 1200),
    blocker: bounded(event.blocker, 1200),
    nextAction: bounded(event.nextAction, 1200),
    evidenceRefs: Array.isArray(event.evidenceRefs) ? event.evidenceRefs.slice(0, 12) : [],
  };
  return crypto.createHash("sha256").update(JSON.stringify(stable)).digest("hex").slice(0, 24);
}

function readLines(file) {
  try {
    return fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean);
  } catch {
    return [];
  }
}

function compactJournal(file) {
  const lines = readLines(file);
  if (lines.length <= MAX_EVENTS) return;
  const kept = lines.slice(-MAX_EVENTS);
  fs.writeFileSync(file, `${kept.join("\n")}\n`, "utf8");
}

function appendMaterialEvent(input, value = {}) {
  const descriptor = target(input);
  const stateFile = path.join(descriptor.root, "material-events-state.json");
  return withDirectoryLock(`${stateFile}.lock`, () => appendMaterialEventLocked(descriptor, value));
}

function appendMaterialEventLocked(descriptor, value = {}) {
  const file = path.join(descriptor.root, "material-events.jsonl");
  const stateFile = path.join(descriptor.root, "material-events-state.json");
  const current = readJson(stateFile, {});
  const candidate = {
    eventId: `event-${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`,
    at: utcNow(),
    targetType: descriptor.type,
    targetId: descriptor.id,
    type: String(value.type || "transition").slice(0, 80),
    level: String(value.level || "material").slice(0, 40),
    state: String(value.state || "").slice(0, 80),
    executionId: String(value.executionId || "").slice(0, 100),
    roundId: String(value.roundId || "").slice(0, 120),
    jobId: String(value.jobId || "").slice(0, 120),
    projectId: String(value.projectId || "").slice(0, 120),
    requirementId: String(value.requirementId || "").slice(0, 120),
    provider: String(value.provider || "").slice(0, 80),
    model: String(value.model || "").slice(0, 180),
    summary: bounded(value.summary, 2000),
    blocker: bounded(value.blocker, 2000),
    nextAction: bounded(value.nextAction, 2000),
    evidenceRefs: (Array.isArray(value.evidenceRefs) ? value.evidenceRefs : []).slice(0, 12).map((item) => bounded(item, 1000)),
    data: value.data && typeof value.data === "object" ? value.data : undefined,
  };
  const eventFingerprint = fingerprint(candidate);
  if (eventFingerprint === current.lastFingerprint) {
    return { appended: false, fingerprint: eventFingerprint, event: current.lastEvent || null };
  }
  const encoded = JSON.stringify({ ...candidate, fingerprint: eventFingerprint });
  if (Buffer.byteLength(encoded, "utf8") > MAX_EVENT_BYTES) {
    candidate.data = undefined;
    candidate.summary = bounded(candidate.summary, 1200);
    candidate.blocker = bounded(candidate.blocker, 1200);
    candidate.nextAction = bounded(candidate.nextAction, 1200);
  }
  fs.mkdirSync(descriptor.root, { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify({ ...candidate, fingerprint: eventFingerprint })}\n`, "utf8");
  compactJournal(file);
  const nextState = {
    schemaVersion: 1,
    count: Math.min(MAX_EVENTS, Number(current.count || 0) + 1),
    lastFingerprint: eventFingerprint,
    lastEvent: { ...candidate, fingerprint: eventFingerprint },
    updatedAt: candidate.at,
  };
  writeJson(stateFile, nextState);
  return { appended: true, fingerprint: eventFingerprint, event: nextState.lastEvent };
}

function readMaterialEvents(input = {}) {
  const descriptor = target(input);
  const limit = Math.max(1, Math.min(50, Number(input.maxEvents || 8)));
  const rows = readLines(path.join(descriptor.root, "material-events.jsonl"))
    .slice(-limit)
    .map((line) => {
      try { return JSON.parse(line); }
      catch { return null; }
    })
    .filter(Boolean);
  return {
    targetType: descriptor.type,
    targetId: descriptor.id,
    events: rows,
    lastEvent: rows.at(-1) || null,
    generatedAt: utcNow(),
  };
}

module.exports = {
  MAX_EVENTS,
  appendMaterialEvent,
  eventPath,
  eventStatePath,
  readMaterialEvents,
  target,
};