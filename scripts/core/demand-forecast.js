"use strict";

const {
  BUDGET_CATEGORIES,
  BUDGET_SCHEMA_VERSION,
  cleanId,
  finite,
  fingerprint,
  normalizeCostVector,
  sumCostVectors,
  unknownMeasurement,
} = require("./budget-contracts");

const TYPE_CATEGORY = Object.freeze({
  context: "context",
  "context-scout": "context",
  observation: "context",
  "repository-scan": "context",
  research: "context",
  strategy: "strategy",
  planning: "strategy",
  architecture: "strategy",
  verification: "verification",
  review: "verification",
  tests: "verification",
  integration: "integration",
  reconciliation: "reconciliation",
  recovery: "reconciliation",
});

function uniqueStrings(values, max = 100) {
  return [...new Set((Array.isArray(values) ? values : []).map((value) => String(value || "").trim()).filter(Boolean))].slice(0, max);
}

function categoryForWorkPackage(workPackage = {}) {
  const declared = String(workPackage.budgetCategory || workPackage.category || "").trim().toLowerCase();
  if (BUDGET_CATEGORIES.includes(declared)) return declared;
  return TYPE_CATEGORY[String(workPackage.type || workPackage.kind || "").trim().toLowerCase()] || "execution";
}

function collectWorkPackages(masterPlan = {}) {
  const rows = [];
  const seen = new Set();
  const add = (value, inherited = {}) => {
    if (!value || typeof value !== "object") return;
    const candidate = { ...inherited, ...value };
    const id = String(candidate.workPackageId || candidate.id || "").trim();
    if (!id || seen.has(id)) return;
    seen.add(id);
    rows.push(candidate);
  };
  for (const row of masterPlan.workPackages || []) add(row);
  for (const workstream of masterPlan.workstreams || []) {
    for (const row of workstream.workPackages || workstream.packages || []) {
      add(row, { workstreamId: workstream.workstreamId || workstream.id || "" });
    }
  }
  for (const milestone of masterPlan.milestones || []) {
    for (const row of milestone.workPackages || milestone.packages || []) {
      add(row, { milestoneId: milestone.milestoneId || milestone.id || "" });
    }
  }
  return rows;
}

function costSource(workPackage = {}) {
  const explicit = workPackage.resourceEstimate || workPackage.resourceDemand || workPackage.estimatedCost || workPackage.cost || {};
  return {
    tokens: workPackage.estimatedTokens,
    wallTimeSeconds: workPackage.estimatedDurationSeconds,
    opportunityCostSeconds: workPackage.opportunityCostSeconds,
    ramMb: workPackage.estimatedRamMb,
    diskMb: workPackage.estimatedDiskMb,
    apiUsd: workPackage.estimatedApiUsd,
    ...explicit,
    quotaDemands: explicit.quotaDemands || explicit.quota || workPackage.quotaDemands || [],
  };
}

function normalizeCandidate(candidate = {}) {
  return {
    provider: String(candidate.provider || candidate.providerId || "").trim(),
    model: String(candidate.model || candidate.modelId || "").trim(),
    preferenceRank: Math.max(0, Math.floor(finite(candidate.preferenceRank) ?? 0)),
    preferenceReason: String(candidate.preferenceReason || "").trim().slice(0, 500),
    successProbability: finite(candidate.successProbability),
    opportunityCostSeconds: finite(candidate.opportunityCostSeconds),
    quotaPoolIds: uniqueStrings(candidate.quotaPoolIds || candidate.quotaPools, 12),
    requiredPermissions: uniqueStrings(candidate.requiredPermissions, 40),
    authorizedPermissions: uniqueStrings(candidate.authorizedPermissions, 40),
    allowUnknownQuota: candidate.allowUnknownQuota === true,
    allowUnknownCapacity: candidate.allowUnknownCapacity === true,
    selectionAuthority: String(candidate.selectionAuthority || "director").trim(),
    ...(candidate.cost || candidate.estimatedCost ? { cost: candidate.cost || candidate.estimatedCost } : {}),
    ...((candidate.quotaDemands || candidate.quota || []).length ? { quotaDemands: candidate.quotaDemands || candidate.quota } : {}),
  };
}

function normalizeForecastItem(workPackage, defaults = {}) {
  const workPackageId = cleanId(workPackage.workPackageId || workPackage.id, "work package id");
  const expectedAcceptanceGain = finite(workPackage.expectedAcceptanceGain ?? workPackage.acceptanceGain);
  const successProbability = finite(workPackage.successProbability);
  if (successProbability !== null && (successProbability < 0 || successProbability > 1)) {
    throw new Error(`Work package ${workPackageId} successProbability must be between 0 and 1.`);
  }
  return {
    workPackageId,
    projectId: String(workPackage.projectId || defaults.projectId || "default").trim() || "default",
    milestoneId: String(workPackage.milestoneId || "").trim(),
    workstreamId: String(workPackage.workstreamId || "").trim(),
    category: categoryForWorkPackage(workPackage),
    type: String(workPackage.type || workPackage.kind || "generic").trim() || "generic",
    goal: String(workPackage.goal || workPackage.objective || "").trim().slice(0, 4000),
    acceptanceIds: uniqueStrings(workPackage.acceptanceIds || workPackage.requirementIds || workPackage.acceptanceCriteriaIds, 40),
    dependsOn: uniqueStrings(workPackage.dependsOn || workPackage.dependencies, 80),
    requiredPermissions: uniqueStrings(workPackage.requiredPermissions, 40),
    requiredCapabilities: uniqueStrings(workPackage.requiredCapabilities, 40),
    ownershipKeys: uniqueStrings(workPackage.ownershipKeys || workPackage.expectedFiles || workPackage.resources, 100),
    expectedAcceptanceGain,
    successProbability,
    criticalPath: workPackage.criticalPath === true,
    criticalPathWeight: Math.max(0, finite(workPackage.criticalPathWeight) ?? (workPackage.criticalPath === true ? 0.5 : 0)),
    deadlineAt: workPackage.deadlineAt || workPackage.dueAt || null,
    cost: normalizeCostVector(costSource(workPackage), {
      provider: String(workPackage.provider || "").trim(),
      reason: `work package ${workPackageId} resource estimate is incomplete`,
    }),
    candidates: (workPackage.candidates || workPackage.routingCandidates || workPackage.providerCandidates || []).map(normalizeCandidate),
  };
}

function phaseEstimate(masterPlan, category) {
  const estimates = masterPlan.resourceEstimates || masterPlan.demandForecast || masterPlan.budgetEstimate || {};
  return estimates[category] || masterPlan[`${category}Estimate`] || null;
}

function syntheticPhaseItem(masterPlan, category, defaults) {
  const estimate = phaseEstimate(masterPlan, category);
  const planId = defaults.planId;
  return {
    workPackageId: `${planId}:${category}:reserve`,
    projectId: defaults.projectId,
    milestoneId: "",
    workstreamId: "",
    category,
    type: `${category}-reserve`,
    goal: `Plan-wide ${category} demand`,
    acceptanceIds: [],
    dependsOn: [],
    requiredPermissions: [],
    requiredCapabilities: [],
    ownershipKeys: [],
    expectedAcceptanceGain: null,
    successProbability: null,
    criticalPath: false,
    criticalPathWeight: 0,
    deadlineAt: null,
    cost: estimate
      ? normalizeCostVector(estimate, { reason: `${category} estimate is incomplete` })
      : normalizeCostVector({}, { reason: `${category} demand was not estimated by the master plan` }),
    candidates: [],
    synthetic: true,
  };
}

function peakMeasurement(items, metric, unit) {
  const values = items.map((item) => item.cost?.[metric]).filter(Boolean);
  if (!values.length) return { state: "known", unit, value: 0 };
  if (values.some((row) => row.state === "unknown")) return unknownMeasurement(unit, `${metric} peak includes unmeasured work`);
  const known = values.filter((row) => row.state === "known").map((row) => row.value);
  return { state: "known", unit, value: known.length ? Math.max(...known) : 0 };
}

function forecastPlanDemand(masterPlan = {}, options = {}) {
  const planId = cleanId(masterPlan.planId || masterPlan.id, "master plan id");
  const defaults = {
    planId,
    projectId: String(masterPlan.projectId || masterPlan.missionId || options.projectId || "default").trim() || "default",
  };
  const items = collectWorkPackages(masterPlan).map((row) => normalizeForecastItem(row, defaults));
  const categories = {};
  for (const category of BUDGET_CATEGORIES) {
    const categoryItems = items.filter((item) => item.category === category);
    if (!categoryItems.length) categoryItems.push(syntheticPhaseItem(masterPlan, category, defaults));
    categories[category] = {
      category,
      items: categoryItems,
      demand: sumCostVectors(categoryItems.map((item) => item.cost)),
      peakRamMb: peakMeasurement(categoryItems, "ramMb", "megabytes"),
      peakDiskMb: peakMeasurement(categoryItems, "diskMb", "megabytes"),
      estimated: !categoryItems.some((item) => Object.values(item.cost).some((value) => value?.state === "unknown")),
    };
  }
  const allItems = BUDGET_CATEGORIES.flatMap((category) => categories[category].items);
  const forecast = {
    schemaVersion: BUDGET_SCHEMA_VERSION,
    forecastId: String(options.forecastId || `${planId}:forecast:${masterPlan.revision || 1}`),
    planId,
    projectId: defaults.projectId,
    contextRevision: Math.max(1, Math.floor(finite(masterPlan.contextRevision) ?? 1)),
    planRevision: Math.max(1, Math.floor(finite(masterPlan.revision) ?? 1)),
    generatedAt: options.generatedAt || new Date().toISOString(),
    categories,
    items: allItems,
    totalDemand: sumCostVectors(allItems.map((item) => item.cost)),
    unknowns: [],
  };
  for (const item of allItems) {
    for (const [metric, measurement] of Object.entries(item.cost)) {
      if (metric !== "quotaDemands" && measurement?.state === "unknown") forecast.unknowns.push({ workPackageId: item.workPackageId, category: item.category, metric, reason: measurement.reason });
    }
    for (const demand of item.cost.quotaDemands || []) {
      if (demand.measurement.state === "unknown") forecast.unknowns.push({ workPackageId: item.workPackageId, category: item.category, metric: `quota:${demand.poolId}`, reason: demand.measurement.reason });
    }
  }
  forecast.fingerprint = fingerprint({
    planId: forecast.planId,
    projectId: forecast.projectId,
    contextRevision: forecast.contextRevision,
    planRevision: forecast.planRevision,
    categories: forecast.categories,
  });
  return forecast;
}

function forecastIndex(forecast) {
  return Object.fromEntries((forecast?.items || []).map((item) => [item.workPackageId, item]));
}

module.exports = {
  TYPE_CATEGORY,
  categoryForWorkPackage,
  collectWorkPackages,
  forecastIndex,
  forecastPlanDemand,
  normalizeForecastItem,
};
