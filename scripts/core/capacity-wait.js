"use strict";

const crypto = require("node:crypto");
const { resourceLeaseSnapshot } = require("./resource-leases");

const RECOVERABLE_CAPACITY_PATTERNS = [
  /^minimum-free-(?:ram|disk)-floor-would-be-crossed(?::.*)?$/i,
  /^machine-free-(?:ram|disk)-unknown$/i,
  /^(?:global|provider)-concurrency-cap-reached$/i,
  /^(?:program|global)-worker-cap-exhausted:/i,
  /^protected-reserve-(?:reached|would-be-crossed):/i,
  /^(?:quota-capacity|quota-demand|codex-quota)-unknown:/i,
  /^held for a later finite round by the machine-wide worker limit/i,
];

function numberValue(value) {
  const raw = value && typeof value === "object" && Object.hasOwn(value, "value") ? value.value : value;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function rejectionReasons(dispatched = {}) {
  return (dispatched.rejected || [])
    .flatMap((row) => String(row.reason || row.blocker || "").split(/\s+\|\s+|,\s*/))
    .map((value) => value.trim())
    .filter(Boolean);
}

function isRecoverableCapacityReason(reason) {
  return RECOVERABLE_CAPACITY_PATTERNS.some((pattern) => pattern.test(String(reason || "").trim()));
}

function isRecoverableCapacityWait(dispatched = {}) {
  const reasons = rejectionReasons(dispatched);
  return !(dispatched.workers || []).length && reasons.length > 0 && reasons.every(isRecoverableCapacityReason);
}

function quotaCapacity(provider = {}) {
  return (provider.quotaPools || provider.capacity?.windows || []).map((pool) => ({
    id: String(pool.id || pool.limitId || pool.name || ""),
    remainingPercent: numberValue(pool.remainingPercent ?? pool.remaining?.value),
    remainingTokens: numberValue(pool.remainingTokens),
    remainingRequests: numberValue(pool.remainingRequests),
    resetAt: pool.resetAt || null,
  })).sort((left, right) => left.id.localeCompare(right.id));
}

function targetedQuotaFingerprint(resources = {}, targets = []) {
  const rows = (targets || []).map((target) => {
    const providerId = String(target.provider || "").trim().toLowerCase();
    const poolKey = String(target.poolKey || "").trim();
    const poolId = poolKey.startsWith(providerId + ":") ? poolKey.slice(providerId.length + 1) : poolKey;
    const provider = resources.providers?.[providerId] || {};
    const pools = quotaCapacity(provider);
    const pool = pools.find((row) => row.id === poolId || `${providerId}:${row.id}` === poolKey) || null;
    return {
      provider: providerId,
      poolKey,
      available: provider.available === true,
      authenticated: provider.authenticated === true,
      quota: pool,
    };
  }).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  return crypto.createHash("sha256").update(JSON.stringify(rows)).digest("hex").slice(0, 24);
}
function targetedConcurrencyFingerprint(taskId = "") {
  const active = (resourceLeaseSnapshot().active || []).map((row) => ({
    jobId: String(row.jobId || ""),
    taskId: String(row.taskId || ""),
  })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  return crypto.createHash("sha256").update(JSON.stringify({ taskId: String(taskId || ""), active })).digest("hex").slice(0, 24);
}

function capacityFingerprint(resources = {}) {
  const providers = Object.fromEntries(Object.entries(resources.providers || {}).sort(([left], [right]) => left.localeCompare(right)).map(([id, row]) => [id, {
    available: row.available === true,
    authenticated: row.authenticated === true,
    activeCount: numberValue(row.activeWork?.activeCount),
    quota: quotaCapacity(row),
  }]));
  const value = {
    freeRamMb: numberValue(resources.machine?.freeRamMb),
    freeDiskMb: numberValue(resources.machine?.freeDiskMb ?? resources.worktreeStorage?.freeMb),
    storageWithinQuota: resources.worktreeStorage?.withinQuota ?? null,
    storageHasMinimumFree: resources.worktreeStorage?.hasMinimumFree ?? null,
    providers,
  };
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 24);
}

function minimumDemand(items, ids, metric) {
  const values = (items || [])
    .filter((row) => !ids.size || ids.has(String(row.workPackageId || "")))
    .map((row) => numberValue(row.cost?.[metric]))
    .filter((value) => value !== null);
  return values.length ? Math.min(...values) : null;
}

function capacityWaitDescriptor(task = {}, dispatched = {}, resources = {}, config = {}) {
  const reasons = rejectionReasons(dispatched);
  const relevantIds = new Set((dispatched.rejected || []).map((row) => String(row.goal || row.workPackageId || "")).filter(Boolean));
  const runtime = task.program?.runtime || {};
  const ledger = runtime.ledger || {};
  const items = runtime.forecast?.items || [];
  const needsRam = reasons.some((reason) => /ram/i.test(reason));
  const needsDisk = reasons.some((reason) => /disk/i.test(reason));
  const ramFloor = numberValue(ledger.limits?.minimumFreeRamMb);
  const diskFloor = numberValue(ledger.limits?.minimumFreeDiskMb);
  const ramDemand = minimumDemand(items, relevantIds, "ramMb");
  const diskDemand = minimumDemand(items, relevantIds, "diskMb");
  const observedFreeRamMb = numberValue(resources.machine?.freeRamMb);
  const observedFreeDiskMb = numberValue(resources.machine?.freeDiskMb ?? resources.worktreeStorage?.freeMb);
  const targetedConcurrency = reasons.some((reason) => /^(?:program|global)-worker-cap-exhausted:/i.test(reason))
    ? { taskId: String(task.taskId || "") }
    : null;
  return {
    kind: "capacity-wait",
    reasons,
    workPackageIds: [...relevantIds],
    targetedConcurrency,
    targetedConcurrencyInitialFingerprint: targetedConcurrency ? targetedConcurrencyFingerprint(targetedConcurrency.taskId) : "",
    observedFreeRamMb,
    observedFreeDiskMb,
    requiredFreeRamMb: needsRam && ramFloor !== null && ramDemand !== null ? ramFloor + ramDemand : null,
    requiredFreeDiskMb: needsDisk && diskFloor !== null && diskDemand !== null ? diskFloor + diskDemand : null,
    initialFingerprint: capacityFingerprint(resources),
    backoffSeconds: Math.max(1, Number(config.capacityBackoffSeconds || 5)),
    maxBackoffSeconds: Math.max(1, Number(config.capacityMaxBackoffSeconds || 60)),
    maximumChecks: Math.max(1, Number(config.capacityWaitChecks || 60)),
  };
}

function capacityRequirementSatisfied(descriptor = {}, resources = {}) {
  if (descriptor.targetedConcurrency) {
    return targetedConcurrencyFingerprint(descriptor.targetedConcurrency.taskId) !== descriptor.targetedConcurrencyInitialFingerprint;
  }
  if ((descriptor.targetedQuota || []).length) {
    return targetedQuotaFingerprint(resources, descriptor.targetedQuota) !== descriptor.targetedQuotaInitialFingerprint;
  }
  const freeRamMb = numberValue(resources.machine?.freeRamMb);
  const freeDiskMb = numberValue(resources.machine?.freeDiskMb ?? resources.worktreeStorage?.freeMb);
  if (descriptor.requiredFreeRamMb !== null && descriptor.requiredFreeRamMb !== undefined) {
    if (freeRamMb === null || freeRamMb < descriptor.requiredFreeRamMb) return false;
  }
  if (descriptor.requiredFreeDiskMb !== null && descriptor.requiredFreeDiskMb !== undefined) {
    if (freeDiskMb === null || freeDiskMb < descriptor.requiredFreeDiskMb) return false;
  }
  if (descriptor.requiredFreeRamMb !== null && descriptor.requiredFreeRamMb !== undefined) return true;
  if (descriptor.requiredFreeDiskMb !== null && descriptor.requiredFreeDiskMb !== undefined) return true;
  return capacityFingerprint(resources) !== descriptor.initialFingerprint;
}

function capacityWaitSummary(descriptor = {}) {
  const thresholds = [];
  if (descriptor.requiredFreeRamMb !== null && descriptor.requiredFreeRamMb !== undefined) thresholds.push(`free RAM reaches ${descriptor.requiredFreeRamMb} MB`);
  if (descriptor.requiredFreeDiskMb !== null && descriptor.requiredFreeDiskMb !== undefined) thresholds.push(`free disk reaches ${descriptor.requiredFreeDiskMb} MB`);
  return thresholds.length
    ? `Wait until ${thresholds.join(" and ")}; then refresh capacity and dispatch once.`
    : "Wait for a material capacity or quota transition; then refresh capacity and dispatch once.";
}

module.exports = {
  capacityFingerprint,
  capacityRequirementSatisfied,
  capacityWaitDescriptor,
  capacityWaitSummary,
  isRecoverableCapacityReason,
  isRecoverableCapacityWait,
  rejectionReasons,
  targetedConcurrencyFingerprint,
  targetedQuotaFingerprint,
};
