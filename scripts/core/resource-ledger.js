"use strict";

const {
  BUDGET_SCHEMA_VERSION,
  fingerprint,
  knownMeasurement,
  normalizeMeasurement,
  normalizeQuotaPool,
  normalizeReservePolicy,
  reserveRowsForPool,
  unknownMeasurement,
} = require("./budget-contracts");
const { DEFAULT_PROFILE } = require("../lib/orchestrator-profile");

function hasOwn(value, key) {
  return Boolean(value && Object.prototype.hasOwnProperty.call(value, key));
}

function stateFromBoolean(value, positive, negative) {
  if (value === true) return positive;
  if (value === false) return negative;
  return "unknown";
}

function measurementFrom(value, unit, reason) {
  return value === null || value === undefined
    ? unknownMeasurement(unit, reason)
    : normalizeMeasurement(value, unit);
}

function quotaPoolKey(provider, poolId) {
  return `${String(provider || "").trim()}:${String(poolId || "").trim()}`;
}

function rawQuotaPools(provider = {}) {
  const rows = [];
  for (const row of provider.quotaPools || []) rows.push(row);
  for (const row of provider.capacity?.windows || []) {
    rows.push({
      ...row,
      id: row.quotaPoolId || row.limitId || row.id || row.scope,
      source: row.source || provider.capacity?.source,
    });
  }
  for (const row of provider.capacity?.models || []) {
    rows.push({
      ...row,
      id: row.quotaPoolId || row.id || row.displayName,
      scope: row.scope || row.id || row.displayName,
      source: row.source || provider.capacity?.source,
    });
  }
  if (!rows.length && (hasOwn(provider.capacity, "effectiveRemainingPercent") || hasOwn(provider.capacity, "remainingPercent"))) {
    rows.push({
      id: "all",
      scope: "all",
      remainingPercent: provider.capacity.effectiveRemainingPercent ?? provider.capacity.remainingPercent,
      resetAt: provider.capacity.resetAt || null,
      source: provider.capacity.source || "unknown",
    });
  }
  const unique = new Map();
  for (const row of rows) {
    const id = String(row.id || row.poolId || row.quotaPoolId || row.scope || "unknown-shared-pool").trim();
    const key = `${id}\u0000${row.scope || "all"}`;
    if (!unique.has(key)) unique.set(key, { ...row, id });
  }
  return [...unique.values()];
}

function normalizeModels(provider = {}) {
  if (!hasOwn(provider, "models")) return { state: "unknown", rows: [], reason: "provider model catalog was not observed" };
  if (!Array.isArray(provider.models)) return { state: "unknown", rows: [], reason: "provider model catalog is malformed" };
  return {
    state: "known",
    rows: provider.models.map((row) => ({
      id: String(row.id || row.model || row.displayName || "").trim(),
      displayName: String(row.displayName || row.id || "").trim(),
      capabilityTier: String(row.capabilityTier || "unknown"),
      quotaState: row.quota?.status || "unknown",
    })).filter((row) => row.id),
    reason: provider.models.length ? "observed provider catalog" : "observed empty provider catalog",
  };
}

function providerAccountingClass(providerId, authMode, provider = {}) {
  const explicit = String(provider.accountingClass || "").trim().toLowerCase();
  if (explicit) return explicit;
  const normalizedProvider = String(providerId || "").trim().toLowerCase();
  const normalizedAuth = String(authMode || "").trim().toLowerCase();
  if (normalizedAuth === "api-key") return "metered-api";
  if (normalizedProvider === "antigravity" && ["cli-session", "subscription", "chatgpt"].includes(normalizedAuth)) return "consumer-quota-session";
  if (["cli-session", "subscription", "chatgpt"].includes(normalizedAuth)) return "consumer-session";
  return "unknown";
}

function normalizeProvider(providerId, provider = {}, reservePolicy) {
  const pools = rawQuotaPools(provider);
  const authMode = String(provider.authMode || "unknown").trim().toLowerCase();
  if (!pools.length) pools.push({ id: "unknown-shared-pool", scope: "all", unit: "percent", reason: "provider quota was not observed" });
  const callableSurfaces = {
    ...(provider.surfaces || {}),
    ...(provider.permissions || {}),
  };
  if (callableSurfaces.source === true) callableSurfaces["read-project"] = true;
  if (callableSurfaces["local-files"] === true) {
    callableSurfaces["read-files"] = true;
    callableSurfaces["write-files"] = true;
  }
  if (callableSurfaces.tests === true) callableSurfaces["run-tests"] = true;
  if (callableSurfaces.command === true) callableSurfaces["run-command"] = true;
  return {
    id: providerId,
    availability: stateFromBoolean(provider.available, "available", "unavailable"),
    authentication: stateFromBoolean(provider.authenticated, "authenticated", "unauthenticated"),
    headless: stateFromBoolean(provider.headless ?? provider.surfaces?.headless, "available", "unavailable"),
    authMode,
    accountingClass: providerAccountingClass(providerId, authMode, provider),
    reason: String(provider.reason || "").slice(0, 500),
    observedAt: provider.observedAt || null,
    models: normalizeModels(provider),
    surfaces: Object.fromEntries(Object.entries(callableSurfaces).map(([key, value]) => [key, value === true ? "available" : value === false ? "unavailable" : "unknown"])),
    capabilities: { ...(provider.capabilities || {}) },
    quotaPools: pools.map((row) => {
      const normalized = normalizeQuotaPool(row, providerId);
      return {
        ...normalized,
        key: quotaPoolKey(providerId, normalized.id),
        reserves: reserveRowsForPool(providerId, normalized.id, reservePolicy),
      };
    }),
  };
}

function normalizeReservation(row = {}, index = 0) {
  return {
    reservationId: String(row.reservationId || row.jobId || `reservation-${index + 1}`),
    projectId: String(row.projectId || row.taskId || "default"),
    provider: String(row.provider || ""),
    model: String(row.model || ""),
    quotaPoolIds: [...new Set((row.quotaPoolIds || []).map(String).filter(Boolean))],
    ramMb: measurementFrom(row.ramMb, "megabytes", "active reservation RAM was not recorded"),
    diskMb: measurementFrom(row.diskMb, "megabytes", "active reservation disk was not recorded"),
    expiresAt: row.expiresAt || null,
  };
}

function buildResourceLedger(inventory = {}, options = {}) {
  const profile = { ...DEFAULT_PROFILE, ...(options.profile || {}) };
  const reservePolicy = normalizeReservePolicy(options.reservePolicy || {}, profile);
  const providerIds = [...new Set([
    ...Object.keys(inventory.providers || {}),
    ...(options.providerIds || []),
  ])].sort();
  const providers = Object.fromEntries(providerIds.map((id) => [id, normalizeProvider(id, inventory.providers?.[id] || {}, reservePolicy)]));
  const rawReservations = options.activeReservations || options.leases?.active || options.leases || [];
  const activeReservations = (Array.isArray(rawReservations) ? rawReservations : []).map(normalizeReservation);
  const machine = inventory.machine || {};
  const freeRamMb = options.freeRamMb ?? machine.freeRamMb;
  const freeDiskMb = options.freeDiskMb ?? machine.freeDiskMb ?? inventory.worktreeStorage?.freeMb;
  const ledger = {
    schemaVersion: BUDGET_SCHEMA_VERSION,
    observedAt: options.observedAt || inventory.generatedAt || new Date().toISOString(),
    inventoryGeneratedAt: inventory.generatedAt || null,
    machine: {
      logicalCpuCount: Number.isFinite(Number(machine.logicalCpuCount)) ? Number(machine.logicalCpuCount) : null,
      freeRamMb: measurementFrom(freeRamMb, "megabytes", "free RAM was not observed"),
      totalRamMb: measurementFrom(machine.totalRamMb, "megabytes", "total RAM was not observed"),
      freeDiskMb: measurementFrom(freeDiskMb, "megabytes", "free disk was not observed"),
    },
    limits: {
      maxGlobalConcurrency: Math.max(1, Math.floor(Number(options.maxGlobalConcurrency ?? profile.maxGlobalWorkers ?? 1))),
      maxProviderConcurrency: Math.max(1, Math.floor(Number(options.maxProviderConcurrency ?? profile.maxWorkersPerProvider ?? 1))),
      minimumFreeRamMb: knownMeasurement("megabytes", Math.max(0, Number(options.minimumFreeRamMb ?? profile.minimumFreeRamMb ?? 0))),
      minimumFreeDiskMb: knownMeasurement("megabytes", Math.max(0, Number(options.minimumFreeDiskMb ?? profile.worktreeMinFreeMb ?? 0))),
      maxAllocationDiskMb: knownMeasurement("megabytes", Math.max(0, Number(options.maxAllocationDiskMb ?? profile.worktreeDiskQuotaMb ?? 0))),
    },
    reservePolicy,
    providers,
    activeReservations,
    fairness: { ...(options.fairness || {}) },
  };
  ledger.active = {
    globalConcurrency: activeReservations.length,
    byProvider: Object.fromEntries(providerIds.map((id) => [id, activeReservations.filter((row) => row.provider === id).length])),
    leasedPoolKeys: [...new Set(activeReservations.flatMap((row) => row.quotaPoolIds.map((poolId) => quotaPoolKey(row.provider, poolId))))],
  };
  ledger.fingerprint = fingerprint({
    machine: ledger.machine,
    limits: ledger.limits,
    reservePolicy: ledger.reservePolicy,
    providers: Object.fromEntries(Object.entries(ledger.providers).map(([id, provider]) => [id, { ...provider, observedAt: undefined }])),
    activeReservations: ledger.activeReservations,
    fairness: ledger.fairness,
  });
  return ledger;
}

function providerResource(ledger, providerId) {
  return ledger?.providers?.[providerId] || null;
}

function quotaPoolResource(ledger, providerId, poolId) {
  return providerResource(ledger, providerId)?.quotaPools?.find((row) => row.id === poolId || row.key === quotaPoolKey(providerId, poolId)) || null;
}

function allocationAccountingBasis(provider = {}, reservations = [], options = {}) {
  const providerId = String(provider.id || "").trim().toLowerCase();
  const authMode = String(provider.authMode || "").trim().toLowerCase();
  const accountingClass = String(provider.accountingClass || "").trim().toLowerCase();
  const durationLimitMs = Math.max(0, Math.ceil(Number(options.durationLimitMs || 0)));
  const base = {
    schemaVersion: "director-cfo/resource-accounting-basis@1",
    provider: providerId,
    authMode,
    accountingClass,
    durationLimitMs,
  };
  if (providerId !== "antigravity" || accountingClass !== "consumer-quota-session") {
    const basis = {
      ...base,
      mode: "provider-token-telemetry",
      tokenUsageState: "required",
      postRunQuotaRefreshRequired: false,
      quotaReservations: [],
    };
    return { ...basis, fingerprint: fingerprint(basis) };
  }

  const rows = (Array.isArray(reservations) ? reservations : []).map((row) => ({
    provider: String(row?.provider || "").trim().toLowerCase(),
    poolId: String(row?.poolId || "").trim(),
    poolKey: String(row?.poolKey || "").trim(),
    exclusive: row?.exclusive === true,
    measurement: row?.measurement || null,
    remainingBefore: row?.remainingBefore || null,
    reserveFloor: Number(row?.reserveFloor),
  }));
  const invalid = rows.find((row) => (
    row.provider !== providerId
    || !row.poolId
    || !row.poolKey
    || row.exclusive !== true
    || row.measurement?.state !== "known"
    || !["percent", "tokens", "requests"].includes(row.measurement?.unit)
    || !Number.isFinite(Number(row.measurement?.value))
    || Number(row.measurement.value) <= 0
    || (row.remainingBefore?.state === "known" && (
      row.remainingBefore?.unit !== row.measurement.unit
      || !Number.isFinite(Number(row.remainingBefore?.value))
      || !Number.isFinite(row.reserveFloor)
      || Number(row.remainingBefore.value) - Number(row.measurement.value) < row.reserveFloor
    ))
    || (!["known", "unknown"].includes(row.remainingBefore?.state))
  ));
  if (!rows.length || invalid || durationLimitMs <= 0) {
    const basis = {
      ...base,
      mode: "unavailable",
      tokenUsageState: "unavailable",
      postRunQuotaRefreshRequired: true,
      quotaReservations: rows,
      reason: !rows.length
        ? "exclusive quota reservation missing"
        : durationLimitMs <= 0 ? "positive wall-time cap missing" : "quota reservation is incomplete or unsafe",
    };
    return { ...basis, fingerprint: fingerprint(basis) };
  }
  const unknownCapacity = rows.some((row) => row.remainingBefore?.state === "unknown");
  const basis = {
    ...base,
    mode: unknownCapacity ? "bounded-wall-time-exclusive-unknown-quota" : "wall-time-and-exclusive-quota-reservation",
    tokenUsageState: "unavailable",
    quotaCapacityState: unknownCapacity ? "unknown" : "known",
    maxAttempts: unknownCapacity ? 1 : undefined,
    postRunQuotaRefreshRequired: true,
    quotaReservations: rows,
  };
  return { ...basis, fingerprint: fingerprint(basis) };
}

function permissionState(ledger, providerId, permission) {
  const provider = providerResource(ledger, providerId);
  if (!provider) return "unknown";
  return provider.surfaces?.[permission] || "unknown";
}

module.exports = {
  allocationAccountingBasis,
  buildResourceLedger,
  normalizeModels,
  normalizeProvider,
  permissionState,
  providerResource,
  quotaPoolKey,
  quotaPoolResource,
  providerAccountingClass,
  rawQuotaPools,
};
