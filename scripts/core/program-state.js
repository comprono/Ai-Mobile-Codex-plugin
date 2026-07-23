"use strict";

const crypto = require("node:crypto");
const {
  CONTRACT_SCHEMA_VERSION,
  ContractValidationError,
  adaptContextDossierV1,
  assertDispatchFence,
  assertIntegrationFence,
  createRevisionFence,
  fingerprintRecord,
  makeRevisionTuple,
  normalizeCampaign,
  normalizeContextDossier,
  normalizeEvidenceLedger,
  normalizeExecutionReceipt,
  normalizeFailurePacket,
  normalizeMasterPlan,
  normalizeMission,
  normalizeReportCursor,
  normalizeResourceBudget,
  normalizeWorkPackage,
} = require("./program-contracts");

const PROGRAM_STATE_SCHEMA_VERSION = 2;
const STATE_ID_PATTERN = /^[A-Za-z][A-Za-z0-9._:-]{2,119}$/;

function invalid(path, message) {
  throw new ContractValidationError(path, message);
}

function isObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function object(value, path) {
  if (!isObject(value)) invalid(path, "must be an object");
  return value;
}

function integer(value, path, fallback = 1) {
  const result = value == null ? fallback : Number(value);
  if (!Number.isSafeInteger(result) || result < 1) invalid(path, "must be a positive safe integer");
  return result;
}

function timestamp(value, path) {
  if (value == null || value === "") return null;
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) invalid(path, "must be an ISO-8601 timestamp");
  return new Date(value).toISOString();
}

function stateId(value, missionId, legacy) {
  let result = value == null ? "" : String(value).trim();
  if (!result && legacy) {
    const suffix = crypto.createHash("sha256").update(missionId).digest("hex").slice(0, 20);
    result = `program-${suffix}`;
  }
  if (!result || !STATE_ID_PATTERN.test(result)) invalid("programState.programId", "is required and must be a safe identifier");
  return result;
}

function normalizeRows(value, path, normalizer, maximum = 5000) {
  if (value == null) return [];
  if (!Array.isArray(value)) invalid(path, "must be an array");
  if (value.length > maximum) invalid(path, `must contain at most ${maximum} records`);
  return value.map((row) => normalizer(row));
}

function unique(rows, key, path) {
  const seen = new Set();
  for (const row of rows) {
    if (seen.has(row[key])) invalid(path, `contains duplicate ${key} ${row[key]}`);
    seen.add(row[key]);
  }
  return seen;
}

function same(value, expected, path) {
  if (value !== expected) invalid(path, `must equal ${expected}`);
}

function normalizeProgramState(input) {
  const path = "programState";
  object(input, path);
  const inputVersion = input.schemaVersion == null ? 1 : Number(input.schemaVersion);
  if (![1, PROGRAM_STATE_SCHEMA_VERSION].includes(inputVersion)) invalid(`${path}.schemaVersion`, "is unsupported");
  if (input.contractKind != null && input.contractKind !== "ProgramState") invalid(`${path}.contractKind`, "must equal ProgramState");

  const missionInput = input.mission || input;
  const mission = normalizeMission(missionInput);
  const contextDossier = input.contextDossier == null
    ? null
    : input.contextDossier.schemaVersion === "director-cfo/context-dossier@1"
      ? adaptContextDossierV1(input.contextDossier, { missionId: mission.missionId })
      : normalizeContextDossier(input.contextDossier);
  const masterPlan = input.masterPlan == null ? null : normalizeMasterPlan(input.masterPlan);
  const resourceBudget = input.resourceBudget == null ? null : normalizeResourceBudget(input.resourceBudget);
  const campaign = input.campaign == null ? null : normalizeCampaign(input.campaign);
  const workPackages = normalizeRows(input.workPackages, `${path}.workPackages`, normalizeWorkPackage, 5000);
  const executionReceipts = normalizeRows(input.executionReceipts, `${path}.executionReceipts`, normalizeExecutionReceipt, 10000);
  const failurePackets = normalizeRows(input.failurePackets, `${path}.failurePackets`, normalizeFailurePacket, 5000);
  const evidenceLedger = input.evidenceLedger == null
    ? normalizeEvidenceLedger({ missionId: mission.missionId, ledgerId: `ledger-${crypto.createHash("sha256").update(mission.missionId).digest("hex").slice(0, 20)}`, entries: [] })
    : normalizeEvidenceLedger(input.evidenceLedger);
  const reportCursors = normalizeRows(input.reportCursors, `${path}.reportCursors`, normalizeReportCursor, 100);

  same(evidenceLedger.missionId, mission.missionId, `${path}.evidenceLedger.missionId`);
  if (contextDossier) same(contextDossier.missionId, mission.missionId, `${path}.contextDossier.missionId`);
  if (masterPlan) {
    if (!contextDossier) invalid(`${path}.masterPlan`, "requires an active context dossier");
    same(masterPlan.missionId, mission.missionId, `${path}.masterPlan.missionId`);
    same(masterPlan.dossierId, contextDossier.dossierId, `${path}.masterPlan.dossierId`);
    same(masterPlan.contextRevision, contextDossier.revision, `${path}.masterPlan.contextRevision`);
  }
  if (resourceBudget) {
    if (!contextDossier || !masterPlan) invalid(`${path}.resourceBudget`, "requires active context and plan records");
    same(resourceBudget.missionId, mission.missionId, `${path}.resourceBudget.missionId`);
    same(resourceBudget.dossierId, contextDossier.dossierId, `${path}.resourceBudget.dossierId`);
    same(resourceBudget.planId, masterPlan.planId, `${path}.resourceBudget.planId`);
    same(resourceBudget.contextRevision, contextDossier.revision, `${path}.resourceBudget.contextRevision`);
    same(resourceBudget.planRevision, masterPlan.revision, `${path}.resourceBudget.planRevision`);
  }
  if (campaign) {
    if (!contextDossier || !masterPlan || !resourceBudget) invalid(`${path}.campaign`, "requires active context, plan, and budget records");
    same(campaign.missionId, mission.missionId, `${path}.campaign.missionId`);
    same(campaign.dossierId, contextDossier.dossierId, `${path}.campaign.dossierId`);
    same(campaign.planId, masterPlan.planId, `${path}.campaign.planId`);
    same(campaign.budgetId, resourceBudget.budgetId, `${path}.campaign.budgetId`);
    same(campaign.contextRevision, contextDossier.revision, `${path}.campaign.contextRevision`);
    same(campaign.planRevision, masterPlan.revision, `${path}.campaign.planRevision`);
    same(campaign.budgetRevision, resourceBudget.revision, `${path}.campaign.budgetRevision`);
  }

  const packageIds = unique(workPackages, "workPackageId", `${path}.workPackages`);
  const receiptIds = unique(executionReceipts, "receiptId", `${path}.executionReceipts`);
  unique(failurePackets, "failureId", `${path}.failurePackets`);
  unique(reportCursors, "cursorId", `${path}.reportCursors`);
  void receiptIds;

  for (const row of workPackages) {
    if (!campaign) invalid(`${path}.workPackages`, "cannot exist without an active campaign");
    same(row.missionId, mission.missionId, `${path}.workPackages.${row.workPackageId}.missionId`);
    same(row.dossierId, contextDossier.dossierId, `${path}.workPackages.${row.workPackageId}.dossierId`);
    same(row.planId, masterPlan.planId, `${path}.workPackages.${row.workPackageId}.planId`);
    same(row.budgetId, resourceBudget.budgetId, `${path}.workPackages.${row.workPackageId}.budgetId`);
    same(row.campaignId, campaign.campaignId, `${path}.workPackages.${row.workPackageId}.campaignId`);
  }
  if (campaign) {
    for (const value of campaign.workPackageIds) {
      if (!packageIds.has(value)) invalid(`${path}.campaign.workPackageIds`, `references unknown work package ${value}`);
    }
  }
  for (const row of executionReceipts) {
    same(row.missionId, mission.missionId, `${path}.executionReceipts.${row.receiptId}.missionId`);
    if (!packageIds.has(row.workPackageId)) invalid(`${path}.executionReceipts`, `references unknown work package ${row.workPackageId}`);
    if (campaign) same(row.campaignId, campaign.campaignId, `${path}.executionReceipts.${row.receiptId}.campaignId`);
  }
  for (const row of failurePackets) {
    same(row.missionId, mission.missionId, `${path}.failurePackets.${row.failureId}.missionId`);
    if (campaign) same(row.campaignId, campaign.campaignId, `${path}.failurePackets.${row.failureId}.campaignId`);
    if (row.workPackageId && !packageIds.has(row.workPackageId)) invalid(`${path}.failurePackets`, `references unknown work package ${row.workPackageId}`);
  }
  for (const row of reportCursors) same(row.missionId, mission.missionId, `${path}.reportCursors.${row.cursorId}.missionId`);

  const sourceSchemaVersion = input.sourceSchemaVersion == null ? inputVersion : Number(input.sourceSchemaVersion);
  if (![1, PROGRAM_STATE_SCHEMA_VERSION].includes(sourceSchemaVersion)) invalid(`${path}.sourceSchemaVersion`, "is unsupported");
  const record = {
    schemaVersion: PROGRAM_STATE_SCHEMA_VERSION,
    sourceSchemaVersion,
    contractKind: "ProgramState",
    programId: stateId(input.programId || input.taskId, mission.missionId, inputVersion === 1),
    revision: integer(input.revision, `${path}.revision`, 1),
    state: (() => {
      const value = input.programState || (input.mission ? input.state : null) || (inputVersion === 1 ? "draft" : "active");
      if (!["draft", "active", "paused", "completed", "cancelled"].includes(value)) invalid(`${path}.state`, "has an unsupported value");
      return value;
    })(),
    mission,
    contextDossier,
    masterPlan,
    resourceBudget,
    campaign,
    workPackages,
    executionReceipts,
    failurePackets,
    evidenceLedger,
    reportCursors,
    createdAt: timestamp(input.createdAt, `${path}.createdAt`),
    updatedAt: timestamp(input.updatedAt, `${path}.updatedAt`),
  };
  if (record.state === "completed" && mission.state !== "completed") invalid(`${path}.state`, "completed program requires a completed mission");
  const calculated = fingerprintRecord(record);
  if (input.fingerprint != null && input.fingerprint !== calculated) invalid(`${path}.fingerprint`, "does not match normalized program state");
  return Object.freeze({ ...record, fingerprint: calculated });
}

function createProgramState(input) {
  object(input, "programStateInput");
  const mission = normalizeMission(input.mission || input);
  const programId = input.programId || `program-${crypto.createHash("sha256").update(mission.missionId).digest("hex").slice(0, 20)}`;
  return normalizeProgramState({
    schemaVersion: PROGRAM_STATE_SCHEMA_VERSION,
    contractKind: "ProgramState",
    programId,
    revision: input.revision || 1,
    state: input.state || "active",
    mission,
    contextDossier: input.contextDossier || null,
    masterPlan: input.masterPlan || null,
    resourceBudget: input.resourceBudget || null,
    campaign: input.campaign || null,
    workPackages: input.workPackages || [],
    executionReceipts: input.executionReceipts || [],
    failurePackets: input.failurePackets || [],
    evidenceLedger: input.evidenceLedger,
    reportCursors: input.reportCursors || [],
    createdAt: input.createdAt || null,
    updatedAt: input.updatedAt || null,
  });
}

function activeContracts(stateValue) {
  const state = normalizeProgramState(stateValue);
  if (!state.contextDossier || !state.masterPlan || !state.resourceBudget || !state.campaign) {
    invalid("programState", "does not yet have context, plan, budget, and campaign contracts");
  }
  return {
    mission: state.mission,
    contextDossier: state.contextDossier,
    masterPlan: state.masterPlan,
    resourceBudget: state.resourceBudget,
    campaign: state.campaign,
  };
}

function assertProgramDispatchReady(stateValue) {
  const state = normalizeProgramState(stateValue);
  const contracts = activeContracts(state);
  if (state.state !== "active") invalid("programState.state", "must be active before dispatch");
  if (contracts.mission.state !== "active") invalid("mission.state", "must be active before dispatch");
  if (contracts.contextDossier.state !== "ready") invalid("contextDossier.state", "must be ready before dispatch");
  if (contracts.masterPlan.state !== "approved") invalid("masterPlan.state", "must be approved before dispatch");
  if (contracts.resourceBudget.state !== "active") invalid("resourceBudget.state", "must be active before dispatch");
  if (contracts.campaign.state !== "running") invalid("campaign.state", "must be running before dispatch");
  return contracts;
}

function issueDispatchFence(stateValue) {
  return createRevisionFence(assertProgramDispatchReady(stateValue), "dispatch");
}

function issueIntegrationFence(stateValue) {
  return createRevisionFence(activeContracts(stateValue), "integration");
}

function assertPackageIdentity(contracts, workPackage, path = "workPackage") {
  same(workPackage.missionId, contracts.mission.missionId, `${path}.missionId`);
  same(workPackage.dossierId, contracts.contextDossier.dossierId, `${path}.dossierId`);
  same(workPackage.planId, contracts.masterPlan.planId, `${path}.planId`);
  same(workPackage.budgetId, contracts.resourceBudget.budgetId, `${path}.budgetId`);
  same(workPackage.campaignId, contracts.campaign.campaignId, `${path}.campaignId`);
}

function assertWorkPackageDispatchable(stateValue, workPackageValue) {
  const state = normalizeProgramState(stateValue);
  const contracts = assertProgramDispatchReady(state);
  const workPackage = normalizeWorkPackage(workPackageValue);
  assertPackageIdentity(contracts, workPackage);
  if (workPackage.state !== "ready") invalid("workPackage.state", "must be ready before dispatch");
  if (!contracts.campaign.workPackageIds.includes(workPackage.workPackageId)) invalid("campaign.workPackageIds", "must own the work package before dispatch");
  if (!workPackage.workstreamId || !workPackage.milestoneId) invalid("workPackage", "dispatch requires workstream and milestone ownership");
  const workstream = contracts.masterPlan.workstreams.find((row) => row.workstreamId === workPackage.workstreamId);
  if (!workstream) invalid("workPackage.workstreamId", "is not present in the active plan");
  if (!workstream.milestoneIds.includes(workPackage.milestoneId)) invalid("workPackage.milestoneId", "is not owned by the selected workstream");
  if (!contracts.campaign.milestoneIds.includes(workPackage.milestoneId)) invalid("workPackage.milestoneId", "is outside the active campaign");
  if (!workPackage.assignee) invalid("workPackage.assignee", "is required before dispatch");
  const allocation = contracts.resourceBudget.allocations.find((row) => (
    row.workstreamId === workPackage.workstreamId
    && row.provider === workPackage.assignee.provider
    && row.model === workPackage.assignee.model
  ));
  if (!allocation) invalid("workPackage.assignee", "has no matching active budget allocation");
  for (const permission of workPackage.requiredPermissions) {
    if (!allocation.permissions.includes(permission)) invalid("workPackage.requiredPermissions", `permission ${permission} is not budget-authorized`);
  }
  if (workPackage.limits.maxTokens > allocation.tokenLimit) invalid("workPackage.limits.maxTokens", "exceeds its allocation");
  if (workPackage.limits.maxDurationMs > allocation.durationLimitMs) invalid("workPackage.limits.maxDurationMs", "exceeds its allocation");
  if (workPackage.limits.maxAttempts > allocation.maxAttempts) invalid("workPackage.limits.maxAttempts", "exceeds its allocation");
  assertDispatchFence(workPackage.revisionFence, contracts);
  return { state, contracts, workPackage, allocation, revisionTuple: makeRevisionTuple(contracts) };
}

function assertExecutionReceiptIntegrable(stateValue, workPackageValue, receiptValue) {
  const state = normalizeProgramState(stateValue);
  const contracts = activeContracts(state);
  const workPackage = normalizeWorkPackage(workPackageValue);
  const receipt = normalizeExecutionReceipt(receiptValue);
  assertPackageIdentity(contracts, workPackage);
  if (!state.workPackages.some((row) => row.workPackageId === workPackage.workPackageId)) invalid("workPackage.workPackageId", "is not recorded in the program state");
  if (receipt.state !== "succeeded") invalid("executionReceipt.state", "must be succeeded before integration");
  same(receipt.missionId, workPackage.missionId, "executionReceipt.missionId");
  same(receipt.campaignId, workPackage.campaignId, "executionReceipt.campaignId");
  same(receipt.workPackageId, workPackage.workPackageId, "executionReceipt.workPackageId");
  same(receipt.deliverableType, workPackage.deliverable.type, "executionReceipt.deliverableType");
  if (!workPackage.revisionFence || !receipt.revisionFence) invalid("executionReceipt.revisionFence", "work and receipt fences are required");
  same(receipt.revisionFence.fingerprint, workPackage.revisionFence.fingerprint, "executionReceipt.revisionFence.fingerprint");
  assertIntegrationFence(workPackage.revisionFence, contracts);
  assertIntegrationFence(receipt.revisionFence, contracts);
  return { state, contracts, workPackage, receipt, revisionTuple: makeRevisionTuple(contracts) };
}

function reviseProgramState(stateValue, patch) {
  const current = normalizeProgramState(stateValue);
  object(patch, "programStatePatch");
  const nextInput = {
    ...current,
    ...patch,
    schemaVersion: PROGRAM_STATE_SCHEMA_VERSION,
    sourceSchemaVersion: current.sourceSchemaVersion,
    contractKind: "ProgramState",
    programId: current.programId,
    revision: current.revision + 1,
    fingerprint: undefined,
  };
  const next = normalizeProgramState(nextInput);
  for (const key of ["mission", "contextDossier", "masterPlan", "resourceBudget", "campaign"]) {
    const before = current[key];
    const after = next[key];
    if (!before || !after || before.fingerprint === after.fingerprint) continue;
    if (after.revision <= before.revision) invalid(`programStatePatch.${key}.revision`, "must increase when contract content changes");
  }
  return next;
}

module.exports = {
  PROGRAM_STATE_SCHEMA_VERSION,
  activeContracts,
  assertExecutionReceiptIntegrable,
  assertProgramDispatchReady,
  assertWorkPackageDispatchable,
  createProgramState,
  issueDispatchFence,
  issueIntegrationFence,
  normalizeProgramState,
  reviseProgramState,
};
