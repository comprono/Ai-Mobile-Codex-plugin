"use strict";

const crypto = require("node:crypto");

const BUDGET_SCHEMA_VERSION = 2;
const BUDGET_CATEGORIES = Object.freeze([
  "context",
  "strategy",
  "execution",
  "verification",
  "integration",
  "reconciliation",
]);
const RESERVE_CATEGORIES = Object.freeze([
  "context",
  "strategy",
  "verification",
  "reconciliation",
  "emergency",
]);
const MEASUREMENT_STATES = new Set(["known", "unknown", "not-applicable"]);
const QUOTA_UNITS = new Set(["percent", "tokens", "requests"]);
const COST_METRICS = Object.freeze({
  tokens: "tokens",
  wallTimeSeconds: "seconds",
  opportunityCostSeconds: "seconds",
  ramMb: "megabytes",
  diskMb: "megabytes",
  apiUsd: "usd",
});
const DEFAULT_RESERVE_PERCENT = Object.freeze({
  context: 3,
  strategy: 5,
  verification: 8,
  reconciliation: 8,
  emergency: 5,
});

class BudgetContractError extends Error {
  constructor(message, code = "invalid-budget-contract") {
    super(message);
    this.name = "BudgetContractError";
    this.code = code;
  }
}

function hasOwn(value, key) {
  return Boolean(value && Object.prototype.hasOwnProperty.call(value, key));
}

function finite(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function cleanId(value, label = "identifier") {
  const text = String(value || "").trim();
  if (!text) throw new BudgetContractError(`${label} is required.`);
  return text.slice(0, 240);
}

function normalizeMeasurement(input, unit, options = {}) {
  const expectedUnit = String(unit || "").trim();
  if (!expectedUnit) throw new BudgetContractError("A measurement unit is required.");
  const source = input && typeof input === "object" && !Array.isArray(input) ? input : null;
  const state = source?.state || (input === null || input === undefined ? "unknown" : "known");
  if (!MEASUREMENT_STATES.has(state)) throw new BudgetContractError(`Unsupported measurement state: ${state}`);
  const suppliedUnit = String(source?.unit || expectedUnit).trim();
  if (suppliedUnit !== expectedUnit) {
    throw new BudgetContractError(`Measurement unit ${suppliedUnit} cannot be treated as ${expectedUnit}; explicit conversion evidence is required.`, "unit-mismatch");
  }
  if (state !== "known") {
    return {
      state,
      unit: expectedUnit,
      value: null,
      reason: String(source?.reason || options.reason || (state === "unknown" ? "not measured" : "not applicable")).slice(0, 500),
      ...(finite(source?.knownSubtotal) !== null ? { knownSubtotal: Math.max(0, finite(source.knownSubtotal)) } : {}),
    };
  }
  const raw = source ? source.value : input;
  const value = finite(raw);
  if (value === null || value < 0) throw new BudgetContractError(`Known ${expectedUnit} measurement must be a finite non-negative number.`);
  if (expectedUnit === "percent" && value > 100) throw new BudgetContractError("Percent measurements must be between 0 and 100.");
  return { state: "known", unit: expectedUnit, value };
}

function unknownMeasurement(unit, reason = "not measured") {
  return normalizeMeasurement({ state: "unknown", reason }, unit);
}

function knownMeasurement(unit, value) {
  return normalizeMeasurement(value, unit);
}

function notApplicableMeasurement(unit, reason = "not applicable") {
  return normalizeMeasurement({ state: "not-applicable", reason }, unit);
}

function sumMeasurements(values, unit) {
  const rows = (Array.isArray(values) ? values : []).map((value) => normalizeMeasurement(value, unit));
  if (!rows.length) return knownMeasurement(unit, 0);
  const knownSubtotal = rows.filter((row) => row.state === "known").reduce((sum, row) => sum + row.value, 0);
  const unknown = rows.filter((row) => row.state === "unknown");
  if (unknown.length) {
    return {
      state: "unknown",
      unit,
      value: null,
      knownSubtotal,
      reason: `${unknown.length} component${unknown.length === 1 ? " is" : "s are"} unmeasured`,
    };
  }
  return knownMeasurement(unit, knownSubtotal);
}

function explicitQuotaMeasurement(input = {}, mode = "demand") {
  const percentKeys = mode === "capacity"
    ? ["remainingPercent", "percent"]
    : ["percent", "estimatedPercent", "maxPercent"];
  const tokenKeys = mode === "capacity"
    ? ["remainingTokens", "tokens"]
    : ["tokens", "estimatedTokens", "maxTokens"];
  const requestKeys = mode === "capacity"
    ? ["remainingRequests", "requests"]
    : ["requests", "estimatedRequests", "maxRequests"];
  const groups = [
    ["percent", percentKeys],
    ["tokens", tokenKeys],
    ["requests", requestKeys],
  ].filter(([, keys]) => keys.some((key) => hasOwn(input, key) && input[key] !== null && input[key] !== undefined));
  if (groups.length > 1) {
    throw new BudgetContractError("A quota measurement cannot mix percent, token, and request units. Keep the provider's native unit.", "ambiguous-quota-unit");
  }
  if (groups.length === 1) {
    const [unit, keys] = groups[0];
    const key = keys.find((candidate) => hasOwn(input, candidate) && input[candidate] !== null && input[candidate] !== undefined);
    return normalizeMeasurement(input[key], unit);
  }
  if (hasOwn(input, "measurement")) {
    const unit = String(input.measurement?.unit || input.unit || "percent");
    if (!QUOTA_UNITS.has(unit)) throw new BudgetContractError(`Unsupported quota unit: ${unit}`);
    return normalizeMeasurement(input.measurement, unit);
  }
  const unit = String(input.unit || "percent");
  if (!QUOTA_UNITS.has(unit)) throw new BudgetContractError(`Unsupported quota unit: ${unit}`);
  return unknownMeasurement(unit, input.reason || "quota amount is unknown");
}

function normalizeQuotaDemand(input = {}, defaults = {}) {
  const provider = String(input.provider || defaults.provider || "").trim();
  const poolId = cleanId(input.poolId || input.quotaPoolId || defaults.poolId || `${provider || "provider"}:unknown-shared-pool`, "quota pool id");
  return {
    provider,
    poolId,
    measurement: explicitQuotaMeasurement(input, "demand"),
    exclusiveWhenUnknown: input.exclusiveWhenUnknown !== false,
  };
}

function normalizeQuotaPool(input = {}, provider = "") {
  const providerId = String(provider || input.provider || "").trim();
  const id = cleanId(input.id || input.poolId || input.quotaPoolId || `${providerId || "provider"}:unknown-shared-pool`, "quota pool id");
  const measurement = explicitQuotaMeasurement(input, "capacity");
  return {
    id,
    provider: providerId,
    scope: String(input.scope || "all").trim() || "all",
    modelIds: [...new Set((Array.isArray(input.modelIds) ? input.modelIds : []).map((value) => String(value || "").trim()).filter(Boolean))],
    remaining: measurement,
    resetAt: input.resetAt || null,
    source: String(input.source || "unknown").slice(0, 240),
  };
}

function metricInput(input, metric) {
  const aliases = {
    tokens: ["tokens", "estimatedTokens", "maxTokens"],
    wallTimeSeconds: ["wallTimeSeconds", "durationSeconds", "estimatedDurationSeconds"],
    opportunityCostSeconds: ["opportunityCostSeconds", "waitCostSeconds"],
    ramMb: ["ramMb", "estimatedRamMb", "maxRamMb"],
    diskMb: ["diskMb", "estimatedDiskMb", "maxDiskMb"],
    apiUsd: ["apiUsd", "estimatedApiUsd", "maxApiUsd"],
  }[metric];
  const key = aliases.find((candidate) => hasOwn(input, candidate));
  return key ? input[key] : undefined;
}

function normalizeCostVector(input = {}, options = {}) {
  const source = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const result = {};
  for (const [metric, unit] of Object.entries(COST_METRICS)) {
    const raw = metricInput(source, metric);
    result[metric] = raw === undefined
      ? unknownMeasurement(unit, options.reason || `${metric} was not estimated`)
      : normalizeMeasurement(raw, unit);
  }
  const quota = source.quotaDemands || source.quota || [];
  result.quotaDemands = (Array.isArray(quota) ? quota : []).map((row) => normalizeQuotaDemand(row, options));
  return result;
}

function zeroCostVector() {
  return {
    tokens: knownMeasurement("tokens", 0),
    wallTimeSeconds: knownMeasurement("seconds", 0),
    opportunityCostSeconds: knownMeasurement("seconds", 0),
    ramMb: knownMeasurement("megabytes", 0),
    diskMb: knownMeasurement("megabytes", 0),
    apiUsd: knownMeasurement("usd", 0),
    quotaDemands: [],
  };
}

function sumCostVectors(values) {
  const vectors = Array.isArray(values) ? values : [];
  const result = {};
  for (const [metric, unit] of Object.entries(COST_METRICS)) {
    result[metric] = sumMeasurements(vectors.map((vector) => vector?.[metric] ?? unknownMeasurement(unit)), unit);
  }
  const groups = new Map();
  for (const vector of vectors) {
    for (const demand of vector?.quotaDemands || []) {
      const normalized = normalizeQuotaDemand(demand.measurement ? demand : { ...demand, measurement: demand.measurement });
      const key = `${normalized.provider}\u0000${normalized.poolId}\u0000${normalized.measurement.unit}`;
      if (!groups.has(key)) groups.set(key, { ...normalized, rows: [] });
      groups.get(key).rows.push(normalized.measurement);
    }
  }
  result.quotaDemands = [...groups.values()].map((group) => ({
    provider: group.provider,
    poolId: group.poolId,
    measurement: sumMeasurements(group.rows, group.measurement.unit),
    exclusiveWhenUnknown: group.rows.some((row) => row.state === "unknown"),
  }));
  return result;
}

function normalizeReservePolicy(input = {}, profile = {}) {
  const supplied = input.categoryPercent || input.categories || input;
  const categoryPercent = {};
  for (const category of RESERVE_CATEGORIES) {
    const raw = hasOwn(supplied, category) ? supplied[category] : DEFAULT_RESERVE_PERCENT[category];
    const value = finite(raw);
    if (value === null || value < 0 || value > 100) throw new BudgetContractError(`Reserve ${category} must be a percent between 0 and 100.`);
    categoryPercent[category] = value;
  }
  const codexPercent = finite(input.codexPercent ?? input.codexReservePercent ?? profile.codexReservePercent ?? 15);
  if (codexPercent === null || codexPercent < 0 || codexPercent > 100) throw new BudgetContractError("Codex reserve must be a percent between 0 and 100.");
  const namedTotal = Object.values(categoryPercent).reduce((sum, value) => sum + value, 0);
  if (namedTotal > 95 || namedTotal + codexPercent > 95) {
    throw new BudgetContractError("Protected reserve percentages leave no usable headroom; named reserves plus the Codex reserve must not exceed 95%.");
  }
  const poolReserves = {};
  for (const [poolId, rows] of Object.entries(input.poolReserves || {})) {
    poolReserves[poolId] = (Array.isArray(rows) ? rows : [rows]).map((row) => ({
      category: String(row.category || "emergency"),
      measurement: explicitQuotaMeasurement(row, "demand"),
    }));
  }
  return {
    schemaVersion: BUDGET_SCHEMA_VERSION,
    categoryPercent,
    codexPercent,
    poolReserves,
  };
}

function spendReserveCategory(category) {
  if (category === "integration") return "verification";
  return RESERVE_CATEGORIES.includes(category) ? category : "";
}

function reserveRowsForPool(provider, poolId, policy, spendingCategory = "execution") {
  const normalized = normalizeReservePolicy(policy || {});
  const spendCategory = spendReserveCategory(spendingCategory);
  const rows = [];
  for (const [category, value] of Object.entries(normalized.categoryPercent)) {
    if (category !== spendCategory) rows.push({ category, measurement: knownMeasurement("percent", value) });
  }
  if (provider === "codex") rows.push({ category: "codex", measurement: knownMeasurement("percent", normalized.codexPercent) });
  for (const row of normalized.poolReserves[poolId] || []) rows.push(row);
  return rows;
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function fingerprint(value) {
  return crypto.createHash("sha256").update(JSON.stringify(stableValue(value))).digest("hex").slice(0, 24);
}

function normalizeBudgetPlan(input = {}) {
  const planId = cleanId(input.planId || input.id, "budget plan id");
  const allocations = (Array.isArray(input.allocations) ? input.allocations : []).map((row, index) => ({
    allocationId: cleanId(row.allocationId || `${planId}:allocation:${index + 1}`, "allocation id"),
    workPackageId: cleanId(row.workPackageId, "work package id"),
    projectId: cleanId(row.projectId || input.projectId || "default", "project id"),
    provider: cleanId(row.provider, "provider"),
    model: String(row.model || "").trim(),
    category: BUDGET_CATEGORIES.includes(row.category) ? row.category : "execution",
    cost: normalizeCostVector(row.cost || row.estimatedCost || {}),
    utility: finite(row.utility) ?? 0,
  }));
  if (new Set(allocations.map((row) => row.workPackageId)).size !== allocations.length) {
    throw new BudgetContractError("A budget plan cannot allocate the same work package twice.");
  }
  return {
    schemaVersion: BUDGET_SCHEMA_VERSION,
    planId,
    budgetRevision: Math.max(1, Math.floor(finite(input.budgetRevision) ?? 1)),
    contextRevision: Math.max(1, Math.floor(finite(input.contextRevision) ?? 1)),
    planRevision: Math.max(1, Math.floor(finite(input.planRevision ?? input.masterPlanRevision) ?? 1)),
    generatedAt: input.generatedAt || new Date().toISOString(),
    allocations,
    deferred: Array.isArray(input.deferred) ? input.deferred : [],
    reservePolicy: normalizeReservePolicy(input.reservePolicy || {}, input.profile || {}),
    ledgerFingerprint: String(input.ledgerFingerprint || ""),
  };
}

module.exports = {
  BUDGET_CATEGORIES,
  BUDGET_SCHEMA_VERSION,
  BudgetContractError,
  COST_METRICS,
  DEFAULT_RESERVE_PERCENT,
  QUOTA_UNITS,
  RESERVE_CATEGORIES,
  cleanId,
  explicitQuotaMeasurement,
  fingerprint,
  finite,
  knownMeasurement,
  normalizeBudgetPlan,
  normalizeCostVector,
  normalizeMeasurement,
  normalizeQuotaDemand,
  normalizeQuotaPool,
  normalizeReservePolicy,
  notApplicableMeasurement,
  reserveRowsForPool,
  spendReserveCategory,
  sumCostVectors,
  sumMeasurements,
  unknownMeasurement,
  zeroCostVector,
};
