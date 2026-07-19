"use strict";

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
    const freeRamMb = Math.floor(os.freemem() / (1024 * 1024));
    if (freeRamMb < profile.minimumFreeRamMb) {
      throw new Error(`Machine free RAM (${freeRamMb} MB) is below the configured ${profile.minimumFreeRamMb} MB worker floor.`);
    }
    if (record.active.length >= profile.maxGlobalWorkers) {
      throw new Error(`Machine-wide worker limit (${profile.maxGlobalWorkers}) is already in use.`);
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
    const before = (record.active || []).length;
    record.active = liveRows(record).filter((lease) => lease.jobId !== jobId);
    record.updatedAt = utcNow();
    writeJson(leaseFile(), record);
    return { released: record.active.length < before, active: record.active.length };
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
