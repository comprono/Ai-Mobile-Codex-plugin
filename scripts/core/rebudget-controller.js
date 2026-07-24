"use strict";

const { BUDGET_SCHEMA_VERSION, fingerprint, finite } = require("./budget-contracts");

const TRANSIENT_FAILURES = new Set(["provider-timeout", "rate-limit", "transport-unavailable", "temporary-5xx", "connection-reset"]);

function measurementValue(row) {
  return row?.state === "known" ? row.value : null;
}

function providerTransitions(previous = {}, next = {}) {
  const reasons = [];
  const ids = new Set([...Object.keys(previous.providers || {}), ...Object.keys(next.providers || {})]);
  for (const id of ids) {
    const before = previous.providers?.[id];
    const after = next.providers?.[id];
    if (!before || !after) {
      reasons.push({ code: "provider-inventory-changed", provider: id });
      continue;
    }
    if (before.availability !== after.availability) reasons.push({ code: "provider-availability-changed", provider: id, before: before.availability, after: after.availability });
    if (before.authentication !== after.authentication) reasons.push({ code: "provider-authentication-changed", provider: id, before: before.authentication, after: after.authentication });
    if (before.models?.state !== after.models?.state) reasons.push({ code: "model-catalog-state-changed", provider: id, before: before.models?.state, after: after.models?.state });
  }
  return reasons;
}

function reserveTotal(pool) {
  const unit = pool?.remaining?.unit;
  let total = 0;
  for (const row of pool?.reserves || []) {
    if (row.measurement?.unit !== unit || row.measurement?.state !== "known") return null;
    total += row.measurement.value;
  }
  return total;
}

function poolMap(ledger = {}) {
  const rows = [];
  for (const [provider, value] of Object.entries(ledger.providers || {})) {
    for (const pool of value.quotaPools || []) rows.push([pool.key || `${provider}:${pool.id}`, { ...pool, provider }]);
  }
  return new Map(rows);
}

function quotaTransitions(previous = {}, next = {}, options = {}) {
  const reasons = [];
  const beforePools = poolMap(previous);
  const afterPools = poolMap(next);
  const threshold = Math.max(1, Number(options.capacityDeltaPercent || 10));
  for (const key of new Set([...beforePools.keys(), ...afterPools.keys()])) {
    const before = beforePools.get(key);
    const after = afterPools.get(key);
    if (!before || !after) {
      reasons.push({ code: "quota-pool-set-changed", poolKey: key });
      continue;
    }
    if (before.remaining?.unit !== after.remaining?.unit || before.remaining?.state !== after.remaining?.state) {
      reasons.push({ code: "quota-measurement-state-changed", poolKey: key, before: before.remaining?.state, after: after.remaining?.state });
      continue;
    }
    const beforeValue = measurementValue(before.remaining);
    const afterValue = measurementValue(after.remaining);
    if (beforeValue !== null && afterValue !== null) {
      const beforeFloor = reserveTotal(before);
      const afterFloor = reserveTotal(after);
      if (beforeFloor !== null && afterFloor !== null && (beforeValue > beforeFloor) !== (afterValue > afterFloor)) {
        reasons.push({ code: "protected-reserve-boundary-crossed", poolKey: key, before: beforeValue, after: afterValue, reserve: afterFloor });
      } else if (before.remaining.unit === "percent" && Math.abs(afterValue - beforeValue) >= threshold) {
        reasons.push({ code: "quota-capacity-materially-changed", poolKey: key, before: beforeValue, after: afterValue, unit: "percent" });
      }
    }
    const beforeObserved = Date.parse(previous.observedAt || "");
    const afterObserved = Date.parse(next.observedAt || "");
    const resetAt = Date.parse(before.resetAt || "");
    if (Number.isFinite(resetAt) && Number.isFinite(beforeObserved) && Number.isFinite(afterObserved) && beforeObserved < resetAt && afterObserved >= resetAt) {
      reasons.push({ code: "quota-reset-passed", poolKey: key, resetAt: before.resetAt });
    }
  }
  return reasons;
}

function floorTransition(previousMeasurement, nextMeasurement, previousFloor, nextFloor, code) {
  const before = measurementValue(previousMeasurement);
  const after = measurementValue(nextMeasurement);
  const beforeMin = measurementValue(previousFloor);
  const afterMin = measurementValue(nextFloor);
  if ([before, after, beforeMin, afterMin].some((value) => value === null)) return null;
  return (before > beforeMin) !== (after > afterMin) ? { code, before, after, floor: afterMin } : null;
}

function machineTransitions(previous = {}, next = {}) {
  const reasons = [];
  const ram = floorTransition(previous.machine?.freeRamMb, next.machine?.freeRamMb, previous.limits?.minimumFreeRamMb, next.limits?.minimumFreeRamMb, "ram-reserve-boundary-crossed");
  const disk = floorTransition(previous.machine?.freeDiskMb, next.machine?.freeDiskMb, previous.limits?.minimumFreeDiskMb, next.limits?.minimumFreeDiskMb, "disk" + "-reserve-boundary-crossed");
  if (ram) reasons.push(ram);
  if (disk) reasons.push(disk);
  const beforeSaturated = Number(previous.active?.globalConcurrency || 0) >= Number(previous.limits?.maxGlobalConcurrency || 1);
  const afterSaturated = Number(next.active?.globalConcurrency || 0) >= Number(next.limits?.maxGlobalConcurrency || 1);
  if (beforeSaturated !== afterSaturated) reasons.push({ code: "concurrency-saturation-changed", before: beforeSaturated, after: afterSaturated });
  return reasons;
}

function latestReceipt(accounting = {}) {
  return accounting.receipts?.[accounting.receipts.length - 1] || null;
}

function receiptTransitions(previous = {}, next = {}, options = {}) {
  const before = latestReceipt(previous.accounting || previous.executionAccounting);
  const after = latestReceipt(next.accounting || next.executionAccounting);
  if (!after || before?.receiptId === after.receiptId) return [];
  const reasons = [];
  if (after.evidence?.acceptanceImproved || Number(after.evidence?.gain || 0) > 0) reasons.push({ code: "acceptance-evidence-improved", receiptId: after.receiptId });
  if (after.failure) {
    const transientCount = (next.accounting?.receipts || []).filter((row) => row.failure?.fingerprint && row.failure.fingerprint === after.failure.fingerprint).length;
    if (!TRANSIENT_FAILURES.has(after.failure.classification) || transientCount >= 2) reasons.push({ code: "classified-failure", receiptId: after.receiptId, classification: after.failure.classification, failureFingerprint: after.failure.fingerprint });
  }
  const threshold = Math.max(1, Number(options.forecastVariancePercent || 25));
  for (const [metric, variance] of Object.entries(after.variance?.metrics || {})) {
    if (variance.state === "known" && variance.percent !== null && Math.abs(variance.percent) >= threshold) reasons.push({ code: "forecast-variance-material", receiptId: after.receiptId, metric, percent: variance.percent });
  }
  return reasons;
}

function evaluateRebudget(previous = {}, next = {}, options = {}) {
  const reasons = [];
  if (String(previous.contextRevision ?? "") !== String(next.contextRevision ?? "")) reasons.push({ code: "context-revision-changed", before: previous.contextRevision, after: next.contextRevision });
  if (String(previous.planRevision ?? "") !== String(next.planRevision ?? "")) reasons.push({ code: "plan-revision-changed", before: previous.planRevision, after: next.planRevision });
  if (previous.demandFingerprint && next.demandFingerprint && previous.demandFingerprint !== next.demandFingerprint) reasons.push({ code: "plan-demand-changed" });
  const beforeEvidence = finite(previous.evidenceScore);
  const afterEvidence = finite(next.evidenceScore);
  if ((afterEvidence !== null && (beforeEvidence === null || afterEvidence > beforeEvidence)) || (next.evidenceFingerprint && previous.evidenceFingerprint !== next.evidenceFingerprint && next.evidenceImproved === true)) {
    reasons.push({ code: "acceptance-evidence-improved", before: beforeEvidence, after: afterEvidence });
  }
  if (String(previous.deadlineAt || "") !== String(next.deadlineAt || "")) reasons.push({ code: "deadline-changed", before: previous.deadlineAt || null, after: next.deadlineAt || null });
  if (previous.ledger && next.ledger) {
    reasons.push(...providerTransitions(previous.ledger, next.ledger));
    reasons.push(...quotaTransitions(previous.ledger, next.ledger, options));
    reasons.push(...machineTransitions(previous.ledger, next.ledger));
  }
  reasons.push(...receiptTransitions(previous, next, options));
  const unique = [...new Map(reasons.map((reason) => [fingerprint(reason), reason])).values()];
  const result = {
    schemaVersion: BUDGET_SCHEMA_VERSION,
    material: unique.length > 0,
    reasons: unique,
    evaluatedAt: options.evaluatedAt || new Date().toISOString(),
  };
  result.fingerprint = fingerprint({ reasons: result.reasons, nextContextRevision: next.contextRevision, nextPlanRevision: next.planRevision, nextLedger: next.ledger?.fingerprint });
  return result;
}

function createRebudgetJournal(input = {}) {
  return {
    schemaVersion: BUDGET_SCHEMA_VERSION,
    budgetId: String(input.budgetId || "budget"),
    budgetRevision: Math.max(1, Math.floor(finite(input.budgetRevision) ?? 1)),
    triggers: [],
  };
}

function recordMaterialRebudgetTrigger(journalValue, transition, options = {}) {
  const journal = journalValue?.triggers ? { ...journalValue, triggers: [...journalValue.triggers] } : createRebudgetJournal(journalValue || {});
  if (!transition?.material) return { journal, recorded: false, reason: "non-material-transition" };
  if (journal.triggers.some((row) => row.fingerprint === transition.fingerprint)) return { journal, recorded: false, reason: "duplicate-transition" };
  journal.triggers.push({ fingerprint: transition.fingerprint, reasons: transition.reasons, recordedAt: options.recordedAt || transition.evaluatedAt || new Date().toISOString() });
  journal.triggers = journal.triggers.slice(-Math.max(1, Math.min(1000, Number(options.maxTriggers || 200))));
  journal.updatedAt = options.recordedAt || transition.evaluatedAt || new Date().toISOString();
  return { journal, recorded: true, reason: "material-transition" };
}

module.exports = {
  TRANSIENT_FAILURES,
  createRebudgetJournal,
  evaluateRebudget,
  machineTransitions,
  providerTransitions,
  quotaTransitions,
  receiptTransitions,
  recordMaterialRebudgetTrigger,
};
