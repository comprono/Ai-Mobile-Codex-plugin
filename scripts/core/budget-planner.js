"use strict";

const { boundariesOverlap } = require("./lane-policy");
const {
  BUDGET_SCHEMA_VERSION,
  finite,
  fingerprint,
  normalizeBudgetPlan,
  normalizeCostVector,
  normalizeQuotaDemand,
} = require("./budget-contracts");
const { allocationAccountingBasis, permissionState, providerResource, quotaPoolKey, quotaPoolResource } = require("./resource-ledger");

function normalizedName(value) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9.]+/g, "-").replace(/^-|-$/g, "");
}

function measurementNumber(measurement, allowNotApplicable = true) {
  if (measurement?.state === "known") return measurement.value;
  if (allowNotApplicable && measurement?.state === "not-applicable") return 0;
  return null;
}

function uniqueStrings(values) {
  return [...new Set((Array.isArray(values) ? values : []).map((value) => String(value || "").trim()).filter(Boolean))];
}

function candidateRows(item, supplied = []) {
  const external = (Array.isArray(supplied) ? supplied : []).filter((row) => row.workPackageId === item.workPackageId);
  const rows = external.length ? external : (item.candidates || []);
  return rows.map((row, index) => ({
    ...row,
    candidateId: String(row.candidateId || `${item.workPackageId}:${row.provider || "provider"}:${row.model || index + 1}`),
    provider: String(row.provider || row.providerId || "").trim(),
    model: String(row.model || row.modelId || "").trim(),
    quotaPoolIds: uniqueStrings(row.quotaPoolIds || row.quotaPools),
  }));
}

function candidatePreferenceRank(candidate = {}) {
  return Math.max(0, Math.floor(finite(candidate.preferenceRank) ?? 0));
}

function authorizedForProject(input, projectId) {
  const source = input.authorizedPermissions;
  if (Array.isArray(source)) return new Set(source.map(String));
  if (source && typeof source === "object") return new Set((source[projectId] || source["*"] || []).map(String));
  return null;
}

const CAPABILITY_AUTHORIZATION_ALIASES = Object.freeze({
  source: ["read-project"],
  "local-files": ["read-files", "write-files"],
  tests: ["run-tests"],
  command: ["run-command"],
  "read-project": ["source"],
  "read-files": ["local-files"],
  "run-tests": ["tests"],
});

function projectAuthorizes(authorized, permission) {
  if (!authorized) return false;
  if (authorized.has(permission)) return true;
  return (CAPABILITY_AUTHORIZATION_ALIASES[permission] || []).some((alias) => authorized.has(alias));
}

function modelGate(provider, candidate) {
  if (!candidate.model) return candidate.modelOptional === true || provider.id === "cursor"
    ? ""
    : "candidate-model-not-specified";
  if (provider.models.state !== "known") return candidate.allowUnknownModel === true ? "" : "model-catalog-unknown";
  const wanted = normalizedName(candidate.model);
  const present = provider.models.rows.some((row) => [row.id, row.displayName].some((value) => normalizedName(value) === wanted));
  return present ? "" : "model-not-in-observed-catalog";
}

function dependencyGate(item, completed) {
  const missing = (item.dependsOn || []).filter((id) => !completed.has(id));
  return missing.length ? `dependencies-not-complete:${missing.join(",")}` : "";
}

function permissionGate(item, candidate, ledger, input) {
  const required = uniqueStrings([
    ...(item.requiredCapabilities || []),
    ...(item.requiredPermissions || []),
    ...(candidate.requiredPermissions || []),
  ]);
  const authorized = authorizedForProject(input, item.projectId);
  for (const permission of required) {
    if (permissionState(ledger, candidate.provider, permission) !== "available") return `permission-unavailable:${permission}`;
    if (!projectAuthorizes(authorized, permission)) return `permission-not-authorized:${permission}`;
  }
  return "";
}

function costForCandidate(item, candidate) {
  if (!candidate.cost && !candidate.estimatedCost && !candidate.quotaDemands) return item.cost;
  const override = candidate.cost || candidate.estimatedCost || {};
  return normalizeCostVector({
    ...item.cost,
    ...override,
    quotaDemands: override.quotaDemands || override.quota || candidate.quotaDemands || item.cost?.quotaDemands || [],
  }, { provider: candidate.provider, reason: `candidate ${candidate.candidateId} estimate is incomplete` });
}

function reserveFloor(pool, category) {
  let total = 0;
  for (const row of pool.reserves || []) {
    if (row.measurement.unit !== pool.remaining.unit) return { known: false, value: null, reason: `reserve-unit-mismatch:${row.measurement.unit}->${pool.remaining.unit}` };
    const value = measurementNumber(row.measurement);
    if (value === null) return { known: false, value: null, reason: `reserve-unknown:${row.category}` };
    total += value;
  }
  return { known: true, value: total, category };
}

function effectiveQuotaDemands(item, candidate, cost, provider) {
  const rows = (cost.quotaDemands || []).filter((row) => !row.provider || row.provider === candidate.provider);
  const normalized = rows.map((row) => normalizeQuotaDemand(row.measurement ? row : { ...row, provider: candidate.provider }, { provider: candidate.provider }));
  const covered = new Set(normalized.map((row) => row.poolId));
  for (const poolId of candidate.quotaPoolIds || []) {
    if (!covered.has(poolId)) normalized.push(normalizeQuotaDemand({ provider: candidate.provider, poolId, unit: quotaPoolResource({ providers: { [candidate.provider]: provider } }, candidate.provider, poolId)?.remaining?.unit || "percent", reason: "candidate quota consumption was not measured" }));
  }
  return normalized;
}

function quotaGate(item, candidate, cost, ledger, selectionState) {
  const provider = providerResource(ledger, candidate.provider);
  const demands = effectiveQuotaDemands(item, candidate, cost, provider);
  const reservations = [];
  for (const demand of demands) {
    const pool = quotaPoolResource(ledger, candidate.provider, demand.poolId);
    if (!pool) return { reason: `quota-pool-not-observed:${demand.poolId}` };
    const key = quotaPoolKey(candidate.provider, demand.poolId);
    if (ledger.active.leasedPoolKeys.includes(key) || selectionState.leasedPoolKeys.has(key)) return { reason: `quota-pool-already-leased:${demand.poolId}` };
    const remaining = measurementNumber(pool.remaining);
    if (remaining === null) {
      if (candidate.provider === "codex") return { reason: `codex-quota-unknown:${demand.poolId}` };
      if (candidate.allowUnknownCapacity !== true) return { reason: `quota-capacity-unknown:${demand.poolId}` };
      if (demand.measurement.state !== "known" || Number(demand.measurement.value) <= 0) return { reason: `bounded-quota-demand-required:${demand.poolId}` };
      reservations.push({
        poolKey: key,
        poolId: demand.poolId,
        provider: candidate.provider,
        measurement: demand.measurement,
        remainingBefore: pool.remaining,
        reserveFloor: null,
        exclusive: true,
        unknownCapacity: true,
        policy: "one-bounded-read-only-attempt",
      });
      continue;
    }
    const floor = reserveFloor(pool, item.category);
    if (!floor.known) return { reason: floor.reason };
    const amount = measurementNumber(demand.measurement);
    if (amount === null) {
      if (candidate.allowUnknownQuota !== true) return { reason: `quota-demand-unknown:${demand.poolId}` };
      if (remaining <= floor.value) return { reason: `protected-reserve-reached:${demand.poolId}` };
      reservations.push({ poolKey: key, poolId: demand.poolId, provider: candidate.provider, measurement: demand.measurement, exclusive: true, remainingBefore: pool.remaining, reserveFloor: floor.value });
      continue;
    }
    if (demand.measurement.unit !== pool.remaining.unit) return { reason: `quota-unit-mismatch:${demand.poolId}` };
    if (remaining - amount < floor.value) return { reason: `protected-reserve-would-be-crossed:${demand.poolId}` };
    reservations.push({ poolKey: key, poolId: demand.poolId, provider: candidate.provider, measurement: demand.measurement, exclusive: true, remainingBefore: pool.remaining, reserveFloor: floor.value });
  }
  return { reservations };
}

function resourceGate(cost, ledger, selectionState) {
  const required = [
    ["tokens", "token-demand-unknown"],
    ["wallTimeSeconds", "time-demand-unknown"],
    ["opportunityCostSeconds", "opportunity-cost-unknown"],
    ["ramMb", "ram-demand-unknown"],
    ["diskMb", "disk-demand-unknown"],
  ];
  const values = {};
  for (const [metric, reason] of required) {
    const value = measurementNumber(cost[metric]);
    if (value === null) return { reason };
    values[metric] = value;
  }
  const freeRam = measurementNumber(ledger.machine.freeRamMb);
  const freeDisk = measurementNumber(ledger.machine.freeDiskMb);
  const ramFloor = measurementNumber(ledger.limits.minimumFreeRamMb) || 0;
  const diskFloor = measurementNumber(ledger.limits.minimumFreeDiskMb) || 0;
  const diskCap = measurementNumber(ledger.limits.maxAllocationDiskMb);
  if (freeRam === null) return { reason: "machine-free-ram-unknown" };
  if (freeDisk === null) return { reason: "machine-free-disk-unknown" };
  if (diskCap !== null && values.diskMb > diskCap) return { reason: "per-allocation-disk-cap-exceeded" };
  if (freeRam - selectionState.ramMb - values.ramMb < ramFloor) return { reason: "minimum-free-ram-floor-would-be-crossed" };
  if (freeDisk - selectionState.diskMb - values.diskMb < diskFloor) return { reason: "minimum-free-disk-floor-would-be-crossed" };
  return { values };
}

function concurrencyGate(candidate, ledger, selectionState) {
  const globalUsed = ledger.active.globalConcurrency + selectionState.allocations.length;
  if (globalUsed >= ledger.limits.maxGlobalConcurrency) return "global-concurrency-cap-reached";
  const providerUsed = (ledger.active.byProvider[candidate.provider] || 0) + (selectionState.byProvider[candidate.provider] || 0);
  if (providerUsed >= ledger.limits.maxProviderConcurrency) return "provider-concurrency-cap-reached";
  return "";
}

function ownershipGate(item, selectionState) {
  for (const allocation of selectionState.allocations) {
    const overlap = boundariesOverlap(item.ownershipKeys || [], allocation.ownershipKeys || []);
    if (overlap.length) return `ownership-overlap:${allocation.workPackageId}`;
  }
  return "";
}

function resetFactor(quotaReservations, item, nowMs, options) {
  let factor = 1;
  const horizon = Math.max(60, Number(options.resetHorizonSeconds || 6 * 60 * 60));
  for (const reservation of quotaReservations) {
    const pool = quotaPoolResource(options.ledger, reservation.provider, reservation.poolId);
    const resetMs = Date.parse(pool?.resetAt || "");
    if (!Number.isFinite(resetMs) || resetMs <= nowMs || resetMs > nowMs + horizon * 1000) continue;
    const remaining = measurementNumber(pool.remaining);
    if (remaining !== null && remaining >= Number(reservation.reserveFloor || 0) + 15) factor *= 1.1;
    else if (item.deadlineAt && Date.parse(item.deadlineAt) > resetMs) factor *= 0.85;
  }
  return Math.max(0.5, Math.min(1.35, factor));
}

function deadlineFactor(item, totalSeconds, nowMs) {
  const deadlineMs = Date.parse(item.deadlineAt || "");
  if (!Number.isFinite(deadlineMs)) return 1;
  const remainingSeconds = Math.max(1, (deadlineMs - nowMs) / 1000);
  if (deadlineMs <= nowMs || totalSeconds >= remainingSeconds) return 2;
  return 1 + Math.min(0.75, totalSeconds / remainingSeconds);
}

function assignmentUtility(item, candidate, cost, quotaReservations, input) {
  const gain = finite(item.expectedAcceptanceGain);
  const probability = finite(candidate.successProbability) ?? finite(item.successProbability);
  if (gain === null || gain <= 0) return { reason: "acceptance-gain-not-estimated" };
  if (probability === null || probability <= 0 || probability > 1) return { reason: "success-probability-not-estimated" };
  const duration = measurementNumber(cost.wallTimeSeconds);
  const baseOpportunity = measurementNumber(cost.opportunityCostSeconds);
  const candidateOpportunity = Math.max(0, finite(candidate.opportunityCostSeconds) ?? 0);
  if (duration === null || baseOpportunity === null) return { reason: "total-time-cost-unknown" };
  const totalTimeCostSeconds = Math.max(1, duration + baseOpportunity + candidateOpportunity);
  const criticalPathFactor = 1 + Math.max(0, finite(item.criticalPathWeight) ?? (item.criticalPath ? 0.5 : 0));
  const deadline = deadlineFactor(item, totalTimeCostSeconds, input.nowMs);
  const fairness = Math.max(0.1, finite(candidate.fairnessWeight ?? item.fairnessWeight) ?? 1);
  const reset = resetFactor(quotaReservations, item, input.nowMs, input);
  const utility = (gain * probability * criticalPathFactor * deadline * fairness * reset) / totalTimeCostSeconds;
  return {
    utility,
    totalTimeCostSeconds,
    expectedAcceptanceGain: gain,
    successProbability: probability,
    factors: { criticalPath: criticalPathFactor, deadline, fairness, reset },
  };
}

function evaluateAssignment(item, candidate, ledger, selectionState, input) {
  const provider = providerResource(ledger, candidate.provider);
  if (!provider) return { eligible: false, reason: "provider-not-observed" };
  if (provider.availability !== "available") return { eligible: false, reason: `provider-${provider.availability}` };
  if (provider.authentication !== "authenticated") return { eligible: false, reason: `provider-${provider.authentication}` };
  if (provider.headless !== "available") return { eligible: false, reason: `provider-headless-${provider.headless}` };
  const dependency = dependencyGate(item, input.completed);
  if (dependency) return { eligible: false, reason: dependency };
  const model = modelGate(provider, candidate);
  if (model) return { eligible: false, reason: model };
  const permission = permissionGate(item, candidate, ledger, input);
  if (permission) return { eligible: false, reason: permission };
  const concurrency = concurrencyGate(candidate, ledger, selectionState);
  if (concurrency) return { eligible: false, reason: concurrency };
  const ownership = ownershipGate(item, selectionState);
  if (ownership) return { eligible: false, reason: ownership };
  const cost = costForCandidate(item, candidate);
  if (provider.authMode === "api-key" && measurementNumber(cost.apiUsd) === null) return { eligible: false, reason: "api-cost-unknown" };
  const resources = resourceGate(cost, ledger, selectionState);
  if (resources.reason) return { eligible: false, reason: resources.reason };
  const quota = quotaGate(item, candidate, cost, ledger, selectionState);
  if (quota.reason) return { eligible: false, reason: quota.reason };
  const score = assignmentUtility(item, candidate, cost, quota.reservations, input);
  const accountingBasis = allocationAccountingBasis(provider, quota.reservations, {
    durationLimitMs: Math.ceil(resources.values.wallTimeSeconds * 1000),
  });
  if (accountingBasis.mode === "unavailable") return { eligible: false, reason: "resource-accounting-basis-unavailable:" + accountingBasis.reason };
  if (score.reason) return { eligible: false, reason: score.reason };
  return {
    eligible: true,
    allocation: {
      allocationId: `${input.budgetId}:${item.workPackageId}:${candidate.provider}`,
      workPackageId: item.workPackageId,
      projectId: item.projectId,
      milestoneId: item.milestoneId || "",
      workstreamId: item.workstreamId || item.workPackageId,
      role: String(candidate.role || item.type || item.category || "worker"),
      category: item.category,
      provider: candidate.provider,
      model: candidate.model,
      candidateId: candidate.candidateId,
      quotaPool: quota.reservations[0]?.poolId || "",
      tokenLimit: measurementNumber(cost.tokens) || 0,
      durationLimitMs: Math.ceil((measurementNumber(cost.wallTimeSeconds) || 0) * 1000),
      maxAttempts: quota.reservations.some((row) => row.unknownCapacity === true) ? 1 : Math.max(1, Math.floor(finite(candidate.maxAttempts) || 1)),
      concurrency: 1,
      permissions: uniqueStrings([...(item.requiredCapabilities || []), ...(item.requiredPermissions || []), ...(candidate.requiredPermissions || [])]),
      cost,
      quotaReservations: quota.reservations,
      ownershipKeys: item.ownershipKeys || [],
      expectedAcceptanceGain: score.expectedAcceptanceGain,
      accountingBasis,
      successProbability: score.successProbability,
      totalTimeCostSeconds: score.totalTimeCostSeconds,
      utility: score.utility,
      scoreFactors: score.factors,
    },
  };
}

function emptySelection() {
  return { allocations: [], ramMb: 0, diskMb: 0, byProvider: {}, leasedPoolKeys: new Set(), utility: 0 };
}

function addAllocation(state, allocation) {
  const next = {
    allocations: [...state.allocations, allocation],
    ramMb: state.ramMb + measurementNumber(allocation.cost.ramMb),
    diskMb: state.diskMb + measurementNumber(allocation.cost.diskMb),
    byProvider: { ...state.byProvider, [allocation.provider]: (state.byProvider[allocation.provider] || 0) + 1 },
    leasedPoolKeys: new Set(state.leasedPoolKeys),
    utility: state.utility + allocation.utility,
  };
  for (const reservation of allocation.quotaReservations) next.leasedPoolKeys.add(reservation.poolKey);
  return next;
}

function selectConcurrentBundle(input = {}) {
  const forecast = input.forecast || {};
  const ledger = input.ledger;
  if (!ledger?.providers || !ledger?.limits) throw new Error("A normalized resource ledger is required.");
  const items = (input.items || forecast.items || []).filter((item) => !item.synthetic && input.excludedWorkPackageIds?.includes?.(item.workPackageId) !== true);
  const budgetId = String(input.budgetId || `${forecast.planId || "plan"}:budget:${input.budgetRevision || 1}`);
  const evaluationInput = {
    ...input,
    ledger,
    budgetId,
    nowMs: Number.isFinite(Number(input.nowMs)) ? Number(input.nowMs) : Date.now(),
    completed: new Set(input.completedWorkPackageIds || []),
  };
  const initialReasons = new Map();
  const alternatives = items.map((item) => ({ item, candidates: candidateRows(item, input.candidates) }));
  let states = [emptySelection()];
  const maxStates = Math.max(16, Math.min(8192, Number(input.maxSearchStates || 1024)));
  for (const row of alternatives) {
    const next = [...states];
    if (!row.candidates.length) initialReasons.set(row.item.workPackageId, ["no-provider-candidate"]);
    for (const state of states) {
      const eligible = [];
      for (const candidate of row.candidates) {
        const evaluated = evaluateAssignment(row.item, candidate, ledger, state, evaluationInput);
        if (!evaluated.eligible) {
          if (state.allocations.length === 0) {
            const reasons = initialReasons.get(row.item.workPackageId) || [];
            reasons.push(evaluated.reason);
            initialReasons.set(row.item.workPackageId, reasons);
          }
          continue;
        }
        eligible.push({ candidate, allocation: evaluated.allocation });
      }
      if (eligible.length) {
        const bestPreferenceRank = Math.min(...eligible.map((entry) => candidatePreferenceRank(entry.candidate)));
        for (const entry of eligible.filter((candidate) => candidatePreferenceRank(candidate.candidate) === bestPreferenceRank)) {
          next.push(addAllocation(state, entry.allocation));
        }
      }
    }
    states = next.sort((left, right) => right.utility - left.utility || right.allocations.length - left.allocations.length).slice(0, maxStates);
  }
  const selected = states[0] || emptySelection();
  const selectedIds = new Set(selected.allocations.map((row) => row.workPackageId));
  const deferred = items.filter((item) => !selectedIds.has(item.workPackageId)).map((item) => ({
    workPackageId: item.workPackageId,
    projectId: item.projectId,
    reasons: [...new Set(initialReasons.get(item.workPackageId) || ["lower-utility-than-selected-bundle"])],
  }));
  const rawPlan = {
    planId: budgetId,
    budgetRevision: input.budgetRevision || 1,
    contextRevision: forecast.contextRevision || input.contextRevision || 1,
    planRevision: forecast.planRevision || input.planRevision || 1,
    allocations: selected.allocations,
    deferred,
    reservePolicy: ledger.reservePolicy,
    ledgerFingerprint: ledger.fingerprint,
    generatedAt: input.generatedAt || new Date(evaluationInput.nowMs).toISOString(),
  };
  const normalized = normalizeBudgetPlan(rawPlan);
  normalized.allocations = selected.allocations;
  normalized.deferred = deferred;
  normalized.budgetId = budgetId;
  normalized.missionId = String(input.missionId || forecast.missionId || forecast.projectId || "default");
  normalized.dossierId = String(input.dossierId || forecast.dossierId || "");
  normalized.planId = String(forecast.planId || input.planId || "");
  normalized.revision = normalized.budgetRevision;
  normalized.state = String(input.state || "draft");
  normalized.inventoryFingerprint = ledger.fingerprint;
  normalized.forecastFingerprint = forecast.fingerprint || fingerprint(forecast);
  const totalTokens = measurementNumber(forecast.totalDemand?.tokens) || 0;
  const totalSeconds = measurementNumber(forecast.totalDemand?.wallTimeSeconds) || 0;
  const knownDemandDurationMs = (forecast.items || []).reduce((sum, item) => {
    const seconds = measurementNumber(item.cost?.wallTimeSeconds);
    return seconds === null ? sum : sum + Math.ceil(seconds * 1000);
  }, 0);
  const allocatedDurationMs = selected.allocations.reduce((sum, allocation) => (
    sum + Number(allocation.durationLimitMs || 0) * Math.max(1, Number(allocation.maxAttempts || 1))
  ), 0);
  normalized.limits = {
    maxTokens: Math.ceil(totalTokens),
    maxDurationMs: Math.max(Math.ceil(totalSeconds * 1000), knownDemandDurationMs, allocatedDurationMs),
    maxConcurrentWorkers: ledger.limits.maxGlobalConcurrency,
    maxAttempts: Math.max(1, Number(input.maxAttempts || selected.allocations.length || 1)),
    maxDiskBytes: Math.ceil((measurementNumber(ledger.limits.maxAllocationDiskMb) || 0) * 1024 * 1024),
    maxRamMb: Math.max(0, (measurementNumber(ledger.machine.freeRamMb) || 0) - (measurementNumber(ledger.limits.minimumFreeRamMb) || 0)),
  };
  const phaseTokens = (category) => measurementNumber(forecast.categories?.[category]?.demand?.tokens) || 0;
  const namedQuotaReserve = Object.values(ledger.reservePolicy.categoryPercent || {}).reduce((sum, value) => sum + Number(value || 0), 0);
  normalized.reserves = {
    contextTokens: Math.ceil(phaseTokens("context")),
    strategyTokens: Math.ceil(phaseTokens("strategy")),
    verificationTokens: Math.ceil(phaseTokens("verification") + phaseTokens("integration")),
    reconciliationTokens: Math.ceil(phaseTokens("reconciliation")),
    emergencyTokens: Math.max(0, Math.ceil(Number(input.emergencyTokens || 0))),
    quotaPercent: Math.min(100, namedQuotaReserve + Number(ledger.reservePolicy.codexPercent || 0)),
  };
  const reservedTokens = normalized.reserves.contextTokens + normalized.reserves.strategyTokens + normalized.reserves.verificationTokens + normalized.reserves.reconciliationTokens + normalized.reserves.emergencyTokens;
  const allocatedTokens = selected.allocations.reduce((sum, allocation) => sum + Number(allocation.tokenLimit || 0), 0);
  normalized.limits.maxTokens = Math.max(normalized.limits.maxTokens, reservedTokens + allocatedTokens);
  normalized.resetSchedule = [...new Map(Object.values(ledger.providers).flatMap((provider) => provider.quotaPools.map((pool) => [`${provider.id}:${pool.id}`, { pool: `${provider.id}:${pool.id}`, resetAt: pool.resetAt }])).filter(([, row]) => row.resetAt)).values()];
  normalized.totalUtility = selected.utility;
  normalized.bundleFingerprint = fingerprint({ allocations: selected.allocations, ledgerFingerprint: ledger.fingerprint, budgetRevision: normalized.budgetRevision });
  return normalized;
}

module.exports = {
  assignmentUtility,
  candidateRows,
  evaluateAssignment,
  projectAuthorizes,
  reserveFloor,
  selectConcurrentBundle,
};
