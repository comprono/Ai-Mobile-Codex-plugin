"use strict";

const crypto = require("node:crypto");
const { bounded, boundedList, utcNow } = require("./utils");

const WAKE_REASONS = new Set([
  "worker-terminal",
  "dependency-change",
  "evidence-change",
  "quota-reset",
  "scheduled-observation",
  "retry-eligible",
  "cancel",
  "user-correction",
]);

function hash(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value || {})).digest("hex");
}

function boundedNumber(value, fallback, minimum, maximum) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(minimum, Math.min(maximum, number)) : fallback;
}

function evidenceFingerprint(evidence = []) {
  return hash((Array.isArray(evidence) ? evidence : []).map((row) => ({
    requirementId: row.requirementId || row.id || "",
    level: row.level || "",
    ref: row.ref || "",
    passed: row.passed === true || row.status === "passing",
  })));
}

function createCampaign(input = {}) {
  const epoch = Math.max(1, Number(input.epoch || input.previousCampaign?.epoch + 1 || 1));
  const missionId = bounded(input.missionId || input.program?.mission?.missionId, 140);
  const revisions = {
    context: Number(input.revisions?.context || input.program?.contextDossier?.revision || 0),
    plan: Number(input.revisions?.plan || input.program?.masterPlan?.revision || 0),
    budget: Number(input.revisions?.budget || input.program?.resourceBudget?.revision || 0),
    campaign: epoch,
  };
  const campaignId = input.campaignId || "campaign-" + hash({ missionId, revisions, epoch }).slice(0, 20);
  const maxHours = boundedNumber(input.maxHours, 4, 1, 4);
  const maxWorkers = Math.floor(boundedNumber(input.maxWorkers, 4, 1, 20));
  const noProgressLimit = Math.floor(boundedNumber(input.noProgressLimit, 2, 1, 5));
  const baselineEvidenceFingerprint = evidenceFingerprint(input.evidence || input.program?.evidenceLedger?.entries);
  return {
    schemaVersion: 2,
    campaignId,
    missionId,
    epoch,
    revisions,
    state: "planned",
    milestoneIds: boundedList(input.milestoneIds, 20, 140),
    allocationIds: boundedList(input.allocationIds || input.budget?.allocations?.map((row) => row.allocationId), 100, 140),
    limits: {
      maxHours,
      maxWorkers,
      noProgressLimit,
      maxEvents: Math.floor(boundedNumber(input.maxEvents, 200, 20, 2000)),
      maxArtifacts: Math.floor(boundedNumber(input.maxArtifacts, 100, 10, 1000)),
      maxArtifactBytes: Math.floor(boundedNumber(input.maxArtifactBytes, 100 * 1024 * 1024, 1024 * 1024, 2 * 1024 * 1024 * 1024)),
    },
    protectedReserves: input.protectedReserves || input.budget?.reserves || {},
    baselineEvidenceFingerprint,
    lastEvidenceFingerprint: baselineEvidenceFingerprint,
    noProgressCount: 0,
    wakeCursor: "",
    wakeCount: 0,
    wakeHistory: [],
    nextWakeAt: input.nextWakeAt || null,
    startedAt: null,
    finishedAt: null,
    stopReason: "",
    createdAt: input.createdAt || utcNow(),
  };
}

function startCampaign(campaign, now = utcNow()) {
  if (!campaign || campaign.state !== "planned") throw new Error("Only a planned campaign can start.");
  return { ...campaign, state: "active", startedAt: now, stopReason: "" };
}

function recordCampaignWake(campaign, input = {}) {
  if (!campaign || !["active", "waiting"].includes(campaign.state)) return { campaign, changed: false, reason: "campaign-not-wakeable" };
  const reason = String(input.reason || "").toLowerCase();
  if (!WAKE_REASONS.has(reason)) return { campaign, changed: false, reason: "unknown-wake-reason" };
  const stateFingerprint = bounded(input.stateFingerprint, 240);
  const cursor = hash({ campaignId: campaign.campaignId, reason, stateFingerprint, at: input.scheduledKey || "" });
  if (cursor === campaign.wakeCursor) return { campaign, changed: false, reason: "duplicate-wake" };
  const evidence = input.evidenceFingerprint || campaign.lastEvidenceFingerprint;
  const improved = Boolean(input.acceptanceImproved) && evidence !== campaign.lastEvidenceFingerprint;
  const noProgressCount = improved ? 0 : campaign.noProgressCount + (input.countForNoProgress === false ? 0 : 1);
  const wakeCount = Number(campaign.wakeCount || (campaign.wakeHistory || []).length) + 1;
  const next = {
    ...campaign,
    state: reason === "cancel" ? "cancelled" : "active",
    wakeCursor: cursor,
    wakeCount,
    wakeHistory: [...(campaign.wakeHistory || []), {
      reason,
      stateFingerprint,
      acceptanceImproved: improved,
      at: input.at || utcNow(),
    }].slice(-50),
    lastEvidenceFingerprint: evidence,
    noProgressCount,
    nextWakeAt: null,
  };
  if (reason === "cancel") return { campaign: { ...next, finishedAt: input.at || utcNow(), stopReason: "cancelled" }, changed: true, acceptanceImproved: false };
  if (noProgressCount >= campaign.limits.noProgressLimit) {
    return {
      campaign: { ...next, state: "stopped", finishedAt: input.at || utcNow(), stopReason: "no-acceptance-progress" },
      changed: true,
      acceptanceImproved: improved,
    };
  }
  return { campaign: next, changed: true, acceptanceImproved: improved };
}

function finishCampaign(campaign, input = {}) {
  if (!campaign) throw new Error("Campaign is required.");
  const state = input.completed === true ? "completed" : input.cancelled === true ? "cancelled" : "stopped";
  return {
    ...campaign,
    state,
    finishedAt: input.finishedAt || utcNow(),
    stopReason: bounded(input.stopReason || (state === "completed" ? "milestone-complete" : state), 240),
    nextWakeAt: null,
  };
}

function campaignContinuation(campaign, input = {}) {
  if (!campaign) return { allowed: false, reason: "campaign-missing" };
  if (!["active", "waiting"].includes(campaign.state)) return { allowed: false, reason: `campaign-${campaign.state || "not-active"}` };
  if (input.userDecisionRequired === true) return { allowed: false, reason: "user-decision-required" };
  if (input.reserveSafe !== true) return { allowed: false, reason: "protected-reserve-floor" };
  if (input.acceptanceImproved !== true) return { allowed: false, reason: "no-acceptance-improvement" };
  if (input.remainingWork !== true) return { allowed: false, reason: "program-complete" };
  return { allowed: true, reason: "evidence-improved-and-budget-safe", nextEpoch: Number(campaign.epoch || 0) + 1 };
}

function campaignExpired(campaign, now = Date.now()) {
  if (!campaign?.startedAt) return false;
  const deadline = Date.parse(campaign.startedAt) + Number(campaign.limits?.maxHours || 4) * 60 * 60 * 1000;
  return Number.isFinite(deadline) && now >= deadline;
}

module.exports = {
  WAKE_REASONS,
  campaignContinuation,
  campaignExpired,
  createCampaign,
  evidenceFingerprint,
  finishCampaign,
  recordCampaignWake,
  startCampaign,
};
