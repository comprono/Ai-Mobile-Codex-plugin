"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { processAlive, readJson, utcNow, withDirectoryLock, writeJson } = require("./utils");
const { stateRoot } = require("./state-store");
const { readProfile } = require("../lib/orchestrator-profile");

function leaseFile() { return path.join(stateRoot(), "resource-leases.json"); }
function lockDirectory() { return path.join(stateRoot(), ".resource-leases-lock"); }

function withLeaseLock(action) {
  return withDirectoryLock(lockDirectory(), action, { timeoutMs: 5000, staleMs: 30000 });
}

function emptyRecord() {
  return { schemaVersion: 1, active: [], fairness: {}, updatedAt: utcNow() };
}

function boundedFairness(value = {}) {
  return Object.fromEntries(Object.entries(value)
    .sort((left, right) => Date.parse(right[1] || "") - Date.parse(left[1] || ""))
    .slice(0, 500));
}

function normalizePools(provider, values) {
  const pools = [...new Set((Array.isArray(values) ? values : []).map((value) => String(value || "").trim()).filter(Boolean))];
  return pools.length ? pools : [`${provider}:unknown-shared-pool`];
}

function measurementValue(value) {
  if (value && typeof value === "object") {
    if (value.state && value.state !== "known") return null;
    value = value.value;
  }
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.ceil(number) : null;
}

function reservationValue(contract, key) {
  const sources = [
    contract,
    contract.resourceReservation,
    contract.resourceEstimate,
    contract.resourceDemand,
    contract.demand,
    contract.allocation?.cost,
    contract.cost,
    contract.directorProgram?.resourceEstimate,
    contract.directorWorkerContract?.resourceEstimate,
    contract.directorWorkerContract?.executionEnvelope?.resourceEstimate,
  ];
  for (const source of sources) {
    if (!source || !Object.prototype.hasOwnProperty.call(source, key)) continue;
    const value = measurementValue(source[key]);
    if (value === null) throw new Error(`Resource lease requires a known non-negative planned ${key} value.`);
    return value;
  }
  return 0;
}

function plannedReservation(contract = {}) {
  return {
    ramMb: reservationValue(contract, "ramMb"),
    diskMb: reservationValue(contract, "diskMb"),
  };
}

function activeReservationTotal(rows, key) {
  return (rows || []).reduce((total, row) => total + (measurementValue(row?.[key]) || 0), 0);
}

function liveFreeDiskMb() {
  try {
    fs.mkdirSync(stateRoot(), { recursive: true });
    const stats = fs.statfsSync(stateRoot());
    const freeBytes = Number(stats.bavail) * Number(stats.bsize);
    return Number.isFinite(freeBytes) ? Math.floor(freeBytes / (1024 * 1024)) : null;
  } catch {
    return null;
  }
}

function assertReservationFits(label, freeMb, floorMb, activeMb, requestedMb) {
  const resource = String(label || "").toLowerCase();
  const floor = Math.max(0, Number(floorMb) || 0);
  if (!Number.isFinite(freeMb)) {
    if (activeMb + requestedMb > 0) throw new Error(`machine-free-${resource}-unknown`);
    return;
  }
  if (freeMb < floor) {
    throw new Error(`minimum-free-${resource}-floor-would-be-crossed:live=${freeMb};floor=${floor}`);
  }
  const afterReservation = freeMb - activeMb - requestedMb;
  if (afterReservation < floor) {
    throw new Error(`minimum-free-${resource}-floor-would-be-crossed:live=${freeMb};active=${activeMb};requested=${requestedMb};floor=${floor}`);
  }
}

function liveRows(record, now = Date.now()) {
  return (record.active || []).filter((lease) => {
    const expires = Date.parse(lease.expiresAt || "");
    if (Number.isFinite(expires) && expires <= now) return false;
    if (lease.pid && !processAlive(lease.pid)) return false;
    return true;
  });
}

function cleanupStaleLeases() {
  return withLeaseLock(() => {
    const record = readJson(leaseFile(), emptyRecord());
    const before = (record.active || []).length;
    record.active = liveRows(record);
    record.updatedAt = utcNow();
    writeJson(leaseFile(), record);
    return { removed: before - record.active.length, active: record.active.length };
  });
}

function acquireResourceLease(contract, jobId, profileValue) {
  const profile = profileValue || readProfile();
  return withLeaseLock(() => {
    const record = readJson(leaseFile(), emptyRecord());
    record.active = liveRows(record);
    const reservation = plannedReservation(contract);
    const freeRamMb = Math.floor(os.freemem() / (1024 * 1024));
    const freeDiskMb = liveFreeDiskMb();
    assertReservationFits("RAM", freeRamMb, profile.minimumFreeRamMb, activeReservationTotal(record.active, "ramMb"), reservation.ramMb);
    assertReservationFits("disk", freeDiskMb, profile.worktreeMinFreeMb, activeReservationTotal(record.active, "diskMb"), reservation.diskMb);
    const programLimits = contract.programResourceLimits || {};
    const supervisorGlobalLimit = Math.floor(Number(programLimits.maxGlobalWorkers || 0));
    const effectiveGlobalLimit = Number.isFinite(supervisorGlobalLimit) && supervisorGlobalLimit > 0
      ? Math.min(profile.maxGlobalWorkers, supervisorGlobalLimit)
      : profile.maxGlobalWorkers;
    if (record.active.length >= effectiveGlobalLimit) {
      throw new Error(`Machine-wide worker limit (${effectiveGlobalLimit}) is already in use. global-worker-cap-exhausted:${record.active.length}>=${effectiveGlobalLimit}`);
    }
    const supervisorProgramLimit = Math.floor(Number(programLimits.maxWorkers || 0));
    const sameProgramRows = record.active.filter((lease) => lease.taskId === contract.taskId);
    if (Number.isFinite(supervisorProgramLimit) && supervisorProgramLimit > 0 && sameProgramRows.length >= supervisorProgramLimit) {
      throw new Error(`Program worker limit (${supervisorProgramLimit}) is already in use. program-worker-cap-exhausted:${sameProgramRows.length}>=${supervisorProgramLimit}`);
    }
    const provider = String(contract.provider || "").trim();
    const providerRows = record.active.filter((lease) => lease.provider === provider);
    if (providerRows.length >= profile.maxWorkersPerProvider) {
      throw new Error(`Provider worker limit (${profile.maxWorkersPerProvider}) is already in use for ${provider}.`);
    }
    const quotaPoolIds = normalizePools(provider, contract.quotaPoolIds);
    const quotaConflict = record.active.find((lease) => (lease.quotaPoolIds || []).some((pool) => quotaPoolIds.includes(pool)));
    if (quotaConflict) {
      throw new Error(`Quota pool is already leased by job ${quotaConflict.jobId}: ${(quotaConflict.quotaPoolIds || []).filter((pool) => quotaPoolIds.includes(pool)).join(", ")}.`);
    }
    const fairnessKey = String(contract.fairnessKey || contract.projectId || contract.taskId || "default");
    const lease = {
      jobId,
      taskId: contract.taskId,
      portfolioId: contract.portfolioId || null,
      projectId: contract.projectId || null,
      fairnessKey,
      provider,
      model: contract.model || "",
      quotaPoolIds,
      workspace: contract.workspace,
      ramMb: reservation.ramMb,
      diskMb: reservation.diskMb,
      pid: null,
      acquiredAt: utcNow(),
      expiresAt: new Date(Date.now() + (Math.max(30, Number(contract.timeoutSeconds || 900)) + 120) * 1000).toISOString(),
    };
    record.active.push(lease);
    record.fairness = boundedFairness({ ...(record.fairness || {}), [fairnessKey]: lease.acquiredAt });
    record.updatedAt = utcNow();
    writeJson(leaseFile(), record);
    return lease;
  });
}

function bindLeasePid(jobId, pid) {
  return withLeaseLock(() => {
    const record = readJson(leaseFile(), emptyRecord());
    record.active = liveRows(record).map((lease) => lease.jobId === jobId ? { ...lease, pid: Number(pid) || null } : lease);
    record.updatedAt = utcNow();
    writeJson(leaseFile(), record);
    return record.active.find((lease) => lease.jobId === jobId) || null;
  });
}

function releaseResourceLease(jobId) {
  return withLeaseLock(() => {
    const record = readJson(leaseFile(), emptyRecord());
    const rows = record.active || [];
    const released = rows.some((lease) => lease.jobId === jobId);
    record.active = liveRows(record).filter((lease) => lease.jobId !== jobId);
    record.updatedAt = utcNow();
    writeJson(leaseFile(), record);
    return { released, active: record.active.length };
  });
}

function resourceLeaseSnapshot() {
  return withLeaseLock(() => {
    const record = readJson(leaseFile(), emptyRecord());
    record.active = liveRows(record);
    record.updatedAt = utcNow();
    writeJson(leaseFile(), record);
    return { active: record.active, fairness: record.fairness || {} };
  });
}

module.exports = {
  acquireResourceLease,
  bindLeasePid,
  cleanupStaleLeases,
  leaseFile,
  releaseResourceLease,
  resourceLeaseSnapshot,
};
