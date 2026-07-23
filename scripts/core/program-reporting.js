"use strict";

const crypto = require("node:crypto");
const { bounded, utcNow } = require("./utils");

function hash(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value || {})).digest("hex");
}

function currentMilestone(plan = {}) {
  const milestones = Array.isArray(plan.milestones) ? plan.milestones : [];
  return milestones.find((row) => !["completed", "accepted"].includes(row.state)) || milestones.at(-1) || null;
}

function compactBudget(budget = {}) {
  const allocations = Array.isArray(budget.allocations) ? budget.allocations : [];
  const receipts = Array.isArray(budget.executionReceipts) ? budget.executionReceipts : [];
  return {
    revision: Number(budget.revision || budget.budgetRevision || 0),
    horizon: budget.horizon || null,
    allocations: allocations.length,
    activeAllocations: allocations.filter((row) => ["reserved", "active"].includes(row.state)).length,
    completedAllocations: receipts.filter((row) => row.state === "completed" || row.evidenceAccepted === true).length,
    reserves: budget.reserves || {},
    unallocatable: (budget.unallocatable || []).slice(0, 8),
  };
}

function compactEvidence(program = {}, task = {}) {
  const entries = program.evidenceLedger?.entries || task.evidence || [];
  return entries.slice(-10).map((row) => ({
    requirementId: row.requirementId || row.id || "",
    level: row.level || "",
    ref: bounded(row.ref, 500),
    summary: bounded(row.summary, 500),
    passed: row.passed === true || row.status === "passing",
  }));
}

function buildProgramReport(task = {}, input = {}) {
  const program = task.program || input.program || {};
  const mission = program.mission || {};
  const plan = program.masterPlan || {};
  const milestone = currentMilestone(plan);
  const campaign = program.activeCampaign || (program.campaigns || []).at(-1) || null;
  const workstreams = (plan.workstreams || []).slice(0, 20).map((row) => ({
    id: row.workstreamId || row.id || "",
    name: bounded(row.name || row.goal, 240),
    state: row.state || "planned",
    ownerRole: row.ownerRole || row.leadRole || "",
  }));
  const failures = (program.failureMemory || []).slice(-5).map((row) => ({
    failureClass: row.failureClass || "",
    blocker: bounded(row.blocker, 500),
    reconciliation: bounded(row.reconciliation?.rootCause || row.recoveryAction, 500),
  }));
  const required = (task.requirements || []).filter((row) => row.required !== false);
  const blockers = required.filter((row) => row.status === "blocked").map((row) => ({
    requirementId: row.id,
    owner: row.blocker?.owner || "director",
    reason: bounded(row.blocker?.reason || row.description, 600),
    recoveryAction: bounded(row.blocker?.recoveryAction, 600),
  }));
  const report = {
    schemaVersion: 2,
    taskId: task.taskId || null,
    mission: {
      id: mission.missionId || "",
      outcome: bounded(mission.outcome || task.outcome, 1200),
      state: mission.state || task.state || "active",
    },
    milestone: milestone ? {
      id: milestone.milestoneId || milestone.id || "",
      name: bounded(milestone.name || milestone.outcome || milestone.goal, 500),
      state: milestone.state || "planned",
      targetAt: milestone.targetAt || milestone.endsAt || null,
    } : null,
    campaign: campaign ? {
      id: campaign.campaignId || "",
      epoch: Number(campaign.epoch || 0),
      state: campaign.state || "",
      stopReason: campaign.stopReason || "",
      nextWakeAt: campaign.nextWakeAt || null,
    } : null,
    progress: {
      passing: required.filter((row) => row.status === "passing").length,
      required: required.length,
    },
    acceptedEvidence: compactEvidence(program, task),
    workstreams,
    budget: compactBudget(program.resourceBudget || {}),
    failures,
    blockers,
    nextAction: bounded(input.nextAction || program.nextAction || task.nextAction || "", 1000),
    userDecisionRequired: blockers.some((row) => /user|human/i.test(row.owner)),
    generatedAt: input.generatedAt || utcNow(),
  };
  report.fingerprint = hash({ ...report, generatedAt: undefined });
  return report;
}

function reportTransition(cursor = {}, report = {}) {
  if (!report.fingerprint) throw new Error("A fingerprinted program report is required.");
  if (cursor.lastFingerprint === report.fingerprint) {
    return { emit: false, reason: "unchanged", cursor };
  }
  const next = {
    schemaVersion: 2,
    sequence: Number(cursor.sequence || 0) + 1,
    lastFingerprint: report.fingerprint,
    lastReportedAt: report.generatedAt || utcNow(),
  };
  return { emit: true, reason: "material-transition", cursor: next, report };
}

module.exports = {
  buildProgramReport,
  compactBudget,
  currentMilestone,
  reportTransition,
};

module.exports = require("./program-reporting-v3");
