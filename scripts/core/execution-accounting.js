"use strict";

const {
  BUDGET_SCHEMA_VERSION,
  cleanId,
  fingerprint,
  finite,
  normalizeCostVector,
  normalizeQuotaDemand,
  sumCostVectors,
} = require("./budget-contracts");

const TERMINAL_STATES = new Set(["completed", "failed", "cancelled", "rejected"]);

function createExecutionAccounting(input = {}) {
  return {
    schemaVersion: BUDGET_SCHEMA_VERSION,
    accountingId: cleanId(input.accountingId || `${input.budgetId || "budget"}:accounting`, "accounting id"),
    budgetId: cleanId(input.budgetId || "budget", "budget id"),
    budgetRevision: Math.max(1, Math.floor(finite(input.budgetRevision) ?? 1)),
    createdAt: input.createdAt || new Date().toISOString(),
    updatedAt: input.createdAt || new Date().toISOString(),
    receipts: [],
    totals: sumCostVectors([]),
  };
}

function actualCostSource(receipt = {}) {
  const explicit = receipt.actualCost || receipt.usage || {};
  return {
    tokens: receipt.actualTokens,
    wallTimeSeconds: receipt.elapsedSeconds ?? receipt.actualDurationSeconds,
    opportunityCostSeconds: receipt.actualOpportunityCostSeconds,
    ramMb: receipt.peakRamMb ?? receipt.actualRamMb,
    diskMb: receipt.diskDeltaMb ?? receipt.actualDiskMb,
    apiUsd: receipt.actualApiUsd,
    ...explicit,
    quotaDemands: explicit.quotaDemands || explicit.quota || receipt.quotaUsage || [],
  };
}

function normalizeExecutionReceipt(receipt = {}) {
  const state = String(receipt.state || receipt.status || "").trim().toLowerCase();
  if (!TERMINAL_STATES.has(state)) throw new Error(`Execution receipt state must be terminal: ${[...TERMINAL_STATES].join(", ")}.`);
  const normalized = {
    schemaVersion: BUDGET_SCHEMA_VERSION,
    receiptId: cleanId(receipt.receiptId || receipt.id, "execution receipt id"),
    workPackageId: cleanId(receipt.workPackageId, "work package id"),
    allocationId: String(receipt.allocationId || "").trim(),
    projectId: String(receipt.projectId || "default").trim() || "default",
    provider: String(receipt.provider || "").trim(),
    model: String(receipt.model || "").trim(),
    category: String(receipt.category || "execution").trim(),
    state,
    startedAt: receipt.startedAt || null,
    finishedAt: receipt.finishedAt || receipt.receivedAt || null,
    actualCost: normalizeCostVector(actualCostSource(receipt), {
      provider: String(receipt.provider || "").trim(),
      reason: `receipt ${receipt.receiptId || receipt.id || "unknown"} did not measure this actual`,
    }),
    evidence: {
      acceptanceImproved: receipt.acceptanceImproved === true || receipt.evidence?.acceptanceImproved === true,
      gain: Math.max(0, finite(receipt.acceptanceEvidenceGain ?? receipt.evidence?.gain) ?? 0),
      fingerprint: String(receipt.evidenceFingerprint || receipt.evidence?.fingerprint || ""),
    },
    failure: state === "failed" || state === "rejected" ? {
      classification: String(receipt.failure?.classification || receipt.failureClass || "unknown"),
      fingerprint: String(receipt.failure?.fingerprint || receipt.failureFingerprint || ""),
      managerCaused: receipt.failure?.managerCaused === true || receipt.managerCaused === true,
    } : null,
  };
  normalized.fingerprint = fingerprint(normalized);
  return normalized;
}

function measurementVariance(forecast, actual) {
  if (forecast?.unit !== actual?.unit) return { state: "unknown", reason: "unit-mismatch" };
  if (forecast?.state !== "known" || actual?.state !== "known") return { state: "unknown", reason: "forecast-or-actual-unmeasured" };
  const delta = actual.value - forecast.value;
  const percent = forecast.value === 0 ? (actual.value === 0 ? 0 : null) : (delta / forecast.value) * 100;
  return { state: "known", unit: actual.unit, forecast: forecast.value, actual: actual.value, delta, percent };
}

function receiptVariance(receipt, forecastCost = {}) {
  const actual = receipt.actualCost || normalizeExecutionReceipt(receipt).actualCost;
  const metrics = {};
  for (const key of ["tokens", "wallTimeSeconds", "opportunityCostSeconds", "ramMb", "diskMb", "apiUsd"]) {
    metrics[key] = measurementVariance(forecastCost[key], actual[key]);
  }
  const quota = [];
  const forecastDemands = forecastCost.quotaDemands || [];
  for (const actualDemandValue of actual.quotaDemands || []) {
    const actualDemand = normalizeQuotaDemand(actualDemandValue);
    const expected = forecastDemands.find((row) => row.provider === actualDemand.provider && row.poolId === actualDemand.poolId && row.measurement?.unit === actualDemand.measurement.unit);
    quota.push({
      provider: actualDemand.provider,
      poolId: actualDemand.poolId,
      variance: measurementVariance(expected?.measurement, actualDemand.measurement),
    });
  }
  return { metrics, quota };
}

function recordExecutionReceipt(accountingValue, receiptValue, forecastCost = null, options = {}) {
  const accounting = accountingValue?.accountingId
    ? { ...accountingValue, receipts: [...(accountingValue.receipts || [])] }
    : createExecutionAccounting(accountingValue || {});
  const receipt = normalizeExecutionReceipt(receiptValue);
  const existing = accounting.receipts.find((row) => row.receiptId === receipt.receiptId);
  if (existing) {
    if (existing.fingerprint !== receipt.fingerprint) throw new Error(`Execution receipt ${receipt.receiptId} conflicts with an already recorded receipt.`);
    return { accounting, receipt: existing, recorded: false, duplicate: true };
  }
  const allocation = options.allocations?.find?.((row) => row.workPackageId === receipt.workPackageId || row.allocationId === receipt.allocationId);
  const expected = forecastCost || allocation?.cost || null;
  receipt.variance = expected ? receiptVariance(receipt, expected) : null;
  accounting.receipts.push(receipt);
  accounting.receipts = accounting.receipts.slice(-Math.max(1, Math.min(10000, Number(options.maxReceipts || 2000))));
  accounting.updatedAt = options.recordedAt || receipt.finishedAt || new Date().toISOString();
  accounting.totals = sumCostVectors(accounting.receipts.map((row) => row.actualCost));
  accounting.counts = {
    total: accounting.receipts.length,
    completed: accounting.receipts.filter((row) => row.state === "completed").length,
    failed: accounting.receipts.filter((row) => row.state === "failed" || row.state === "rejected").length,
    acceptanceImproved: accounting.receipts.filter((row) => row.evidence.acceptanceImproved || row.evidence.gain > 0).length,
  };
  accounting.fingerprint = fingerprint({ budgetId: accounting.budgetId, budgetRevision: accounting.budgetRevision, receipts: accounting.receipts });
  return { accounting, receipt, recorded: true, duplicate: false };
}

function accountingSummary(accounting = {}) {
  return {
    accountingId: accounting.accountingId,
    budgetId: accounting.budgetId,
    budgetRevision: accounting.budgetRevision,
    counts: accounting.counts || { total: 0, completed: 0, failed: 0, acceptanceImproved: 0 },
    totals: accounting.totals || sumCostVectors([]),
    lastReceiptId: accounting.receipts?.at?.(-1)?.receiptId || null,
    fingerprint: accounting.fingerprint || fingerprint({ receipts: accounting.receipts || [] }),
  };
}

module.exports = {
  TERMINAL_STATES,
  accountingSummary,
  createExecutionAccounting,
  measurementVariance,
  normalizeExecutionReceipt,
  receiptVariance,
  recordExecutionReceipt,
};
