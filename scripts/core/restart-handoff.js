"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { readProfile } = require("../lib/orchestrator-profile");
const { readTask } = require("./state-store");
const { safeWorkspace, utcNow, writeJson } = require("./utils");
const { stateRoot } = require("./state-store");
const { pluginVersion } = require("../lib/version");

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

function createRestartHandoff(args = {}) {
  const profile = readProfile();
  if (args.userAuthorized !== true && profile.allowCodexRestartHandoff !== true) {
    throw new Error("Codex restart handoff is not authorized in the private profile or this call.");
  }
  const workspace = safeWorkspace(args.workspace);
  const threadId = safeThreadId(args.threadId);
  const resumeModel = safeResumeModel(args.resumeModel || "");
  const resumeEffort = safeReasoningEffort(args.resumeEffort, "low");
  const verificationModel = safeResumeModel(args.verificationModel || "");
  const verificationEffort = safeReasoningEffort(args.verificationEffort || "");
  const task = args.taskId ? readTask(args.taskId) : null;
  const nextAction = String(args.nextAction || task?.currentCodex?.goal || "").trim().slice(0, 4000);
  if (!nextAction) throw new Error("Restart handoff requires the exact next action.");
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
  const createdAt = utcNow();
  const handoff = {
    schemaVersion: 2,
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
    verificationModel,
    verificationEffort,
    resumeModel,
    resumeEffort,
    cleanupPluginIds,
    refreshPluginIds: ["ai-mobile@ai-mobile"],
    taskId: task?.taskId || String(args.taskId || ""),
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
      task?.taskId ? "Reconcile durable task " + task.taskId + " once; do not create another task." : "",
      task?.outcome ? "Outcome: " + task.outcome : "",
      priorities.length ? "Priorities: " + priorities.join(" | ") : "",
      "Start now: " + nextAction,
      "Invoke run-task-cycle exactly once for this task with maxRounds 3, maxMinutes 15, noProgressLimit 2, and horizonHours 5. It starts or reuses one finite detached event-driven coordinator. Do not poll or call it again in this turn. Report the returned durable execution receipt as one compact Done / Active / Blocked / Resources / Next update; later user status requests use material-status once.",
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

module.exports = { createRestartHandoff, safeReasoningEffort, safeResumeModel, safeThreadId };
