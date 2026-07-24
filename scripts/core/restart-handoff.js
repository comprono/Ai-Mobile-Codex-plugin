"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { readProfile } = require("../lib/orchestrator-profile");
const { readTask } = require("./state-store");
const { safeWorkspace, utcNow, writeJson } = require("./utils");
const { stateRoot } = require("./state-store");
const { assertCurrentRuntime, pluginVersion } = require("../lib/version");
const { runtimeFingerprint } = require("../lib/runtime-identity");

function safeThreadId(value) {
  const threadId = String(value || process.env.CODEX_THREAD_ID || "").trim();
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(threadId)) throw new Error("A valid Codex thread id is required for restart continuity.");
  return threadId;
}

function safeResumeModel(value) {
  const model = String(value || "").trim();
  if (!model) return "";
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(model)) throw new Error("Restart model must be an exact safe model id.");
  return model;
}

function safeReasoningEffort(value, fallback = "") {
  const effort = String(value || fallback).trim().toLowerCase();
  if (!effort) return "";
  if (!new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]).has(effort)) {
    throw new Error("Restart reasoning effort is invalid.");
  }
  return effort;
}

function safeEmbeddedContract(value, label) {
  let serialized;
  try {
    serialized = JSON.stringify(value || {});
  } catch {
    throw new Error(`Restart ${label} must be JSON serializable.`);
  }
  if (Buffer.byteLength(serialized, "utf8") > 128 * 1024) {
    throw new Error(`Restart ${label} exceeds the 128 KiB handoff limit.`);
  }
  return JSON.parse(serialized);
}

function assertRestartRuntimeCurrent(root) {
  return assertCurrentRuntime(root);
}

function createRestartHandoff(args = {}) {
  const profile = readProfile();
  if (args.userAuthorized !== true && profile.allowCodexRestartHandoff !== true) {
    throw new Error("Codex restart handoff is not authorized in the private profile or this call.");
  }
  // A loaded older cache cannot safely describe or verify a newer installed
  // release. Prepare the handoff from the candidate source or newest cache.
  assertRestartRuntimeCurrent();
  const workspace = safeWorkspace(args.workspace);
  const threadId = safeThreadId(args.threadId);
  const resumeModel = safeResumeModel(args.resumeModel || "");
  const resumeEffort = safeReasoningEffort(args.resumeEffort, "low");
  const verificationModel = safeResumeModel(args.verificationModel || "");
  const verificationEffort = safeReasoningEffort(args.verificationEffort || "");
  const task = args.taskId ? readTask(args.taskId) : null;
  if (!task) throw new Error("Restart handoff requires an existing durable AI Mobile task.");
  const directorProgram = task.program?.mode === "director-cfo";
  if (!directorProgram && args.migrateToDirector !== true) {
    throw new Error("A legacy task requires migrateToDirector true before restart continuation.");
  }
  const nextAction = String(args.nextAction || task?.currentCodex?.goal || "").trim().slice(0, 4000);
  if (!nextAction) throw new Error("Restart handoff requires the exact next action.");
  if (/\bresource[\s_-]*inventory\b/i.test(nextAction)) {
    throw new Error("Restart continuation nextAction must not repeat resource-inventory; the capable verification turn owns the single runtime proof call.");
  }
  const priorities = (Array.isArray(args.priorities) ? args.priorities : []).slice(0, 12).map((item) => String(item).trim().slice(0, 500)).filter(Boolean);
  const rawCleanup = Array.isArray(args.cleanupPluginIds) ? args.cleanupPluginIds : [];
  const cleanupPluginIds = rawCleanup.slice(0, 5).map((item) => String(item || "").trim()).filter(Boolean);
  if (cleanupPluginIds.length !== rawCleanup.length || cleanupPluginIds.some((item) => !/^[a-z0-9][a-z0-9-]*@[a-z0-9][a-z0-9-]*$/i.test(item))) {
    throw new Error("Restart cleanup accepts at most five exact plugin@marketplace identifiers.");
  }
  const evidence = (task?.requirements || []).map((item) => ({
    id: item.id,
    status: item.status,
    evidence: (item.evidence || []).slice(-2).map((entry) => ({ level: entry.level, ref: entry.ref, summary: entry.summary })),
  }));
  const reconcileContract = directorProgram ? null : safeEmbeddedContract({
    taskId: task.taskId,
    migrateToDirector: true,
    cancelActiveWorkers: true,
    outcome: String(args.outcome || task.outcome || "").slice(0, 10000),
    userRequest: String(args.latestUserRequest || task.latestUserRequest || "").slice(0, 10000),
    constraints: Array.isArray(args.constraints) ? args.constraints : task.constraints || [],
    projectContract: args.projectContract === undefined ? true : args.projectContract,
    sourceDescriptors: args.sourceDescriptors || {},
    authorization: args.authorization || {},
    authorizedPermissions: args.authorizedPermissions || [],
    consoleModel: resumeModel,
    consoleEffort: resumeEffort,
    codexReservePercent: args.codexReservePercent,
  }, "migration contract");
  const campaignContract = safeEmbeddedContract({
    taskId: task.taskId,
    awaitBoundarySeconds: Math.max(0, Math.min(120, Number(args.awaitBoundarySeconds ?? 30))),
    maxRounds: Math.max(1, Math.min(50, Number(args.maxRounds || 3))),
    maxMinutes: Math.max(1, Math.min(300, Number(args.maxMinutes || 15))),
    noProgressLimit: Math.max(1, Math.min(5, Number(args.noProgressLimit || 2))),
    horizonHours: Math.max(1, Math.min(168, Number(args.horizonHours || 5))),
  }, "campaign contract");
  const createdAt = utcNow();
  const handoff = {
    schemaVersion: 4,
    oneShot: true,
    userAuthorized: true,
    createdAt,
    restartState: "prepared",
    restartUpdatedAt: createdAt,
    restartMessage: "Authorized one-shot restart handoff prepared; no process has been started.",
    restartLog: [{ At: createdAt, State: "prepared", Message: "Authorized one-shot restart handoff prepared; no process has been started." }],
    threadId,
    workspace,
    expectedRuntimeVersion: pluginVersion(),
    expectedRuntimeFingerprint: runtimeFingerprint(),
    verificationModel,
    verificationEffort,
    resumeModel,
    resumeEffort,
    cleanupPluginIds,
    refreshPluginIds: ["ai-mobile@ai-mobile"],
    taskId: task?.taskId || String(args.taskId || ""),
    handoffMode: directorProgram ? "resume-program" : "migrate-program",
    reconcileContract,
    campaignContract,
    outcome: String(task?.outcome || args.outcome || "").slice(0, 6000),
    latestUserRequest: String(task?.latestUserRequest || args.latestUserRequest || "").slice(0, 6000),
    priorities,
    evidence,
    nextAction,
    resumePrompt: [
      "Continue in this exact existing Codex task using the freshly verified AI Mobile runtime.",
      resumeModel ? "Visible console model: " + resumeModel + " at " + resumeEffort + " effort." : "",
      "The visible task is a lightweight project console only: invoke coordinator tools, take user direction, and report verified material transitions.",
      "Do not bulk-read repositories, perform heavy planning, edit project files, review patches, create a duplicate Codex task, AI Mobile task, Goal, automation, manager loop, or hidden CLI continuation.",
      "The immediately preceding capable-model turn already completed the one permitted resource-inventory runtime proof. Do not call resource-inventory again.",
      directorProgram
        ? "Resume durable Director-CFO task " + task.taskId + " in place. Do not call reconcile-task, start-program, start-task, or any legacy orchestration tool."
        : "Migrate durable task " + task.taskId + " exactly once with reconcile-task using this JSON contract; do not create another task: " + JSON.stringify(reconcileContract),
      task?.outcome ? "Outcome: " + task.outcome : "",
      priorities.length ? "Priorities: " + priorities.join(" | ") : "",
      "Start now: " + nextAction,
      !directorProgram ? "The migration must return the same taskId with program.mode director-cfo. Stop if it does not; never fall back to legacy orchestration tools." : "The existing program.mode must remain director-cfo.",
      "Then invoke run-program-campaign exactly once using this JSON contract: " + JSON.stringify(campaignContract) + ". It starts or resumes one bounded Director-CFO program supervisor across finite slices and budget-campaign epochs. Do not poll or call it again in this turn. You may call program-report once after the campaign receipt to produce one compact Goal / Milestone / Evidence / Teams / Budget / Blockers / Next update; later user status requests also use program-report once.",
    ].filter(Boolean).join("\n"),
  };
  const root = path.join(stateRoot(), "restart-handoffs");
  fs.mkdirSync(root, { recursive: true });
  const file = path.join(root, `${threadId}-${Date.now()}.json`);
  writeJson(file, handoff);
  return {
    ...handoff,
    file,
    launcher: {
      command: "powershell",
      args: ["-ExecutionPolicy", "Bypass", "-File", path.resolve(__dirname, "..", "restart-codex-handoff.ps1"), "-HandoffFile", file, "-Schedule"],
    },
  };
}

module.exports = { assertRestartRuntimeCurrent, createRestartHandoff, safeReasoningEffort, safeResumeModel, safeThreadId };
