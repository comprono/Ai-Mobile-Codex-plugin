"use strict";

const { finite, fingerprint } = require("./budget-contracts");
const { selectConcurrentBundle } = require("./budget-planner");

function fairnessAdjustment(program = {}, ledger = {}, nowMs = Date.now()) {
  const projectId = String(program.projectId || program.forecast?.projectId || "default");
  const active = (ledger.activeReservations || []).filter((row) => row.projectId === projectId).length;
  const historical = ledger.fairness?.[projectId];
  const lastServedAt = typeof historical === "string" ? historical : historical?.lastServedAt || program.lastServedAt;
  const lastMs = Date.parse(lastServedAt || "");
  const waitHours = Number.isFinite(lastMs) ? Math.max(0, (nowMs - lastMs) / (60 * 60 * 1000)) : null;
  const starvationBoost = waitHours === null ? 1.25 : 1 + Math.min(0.75, waitHours / 48);
  const recentAllocations = Math.max(0, finite(historical?.recentAllocations ?? program.recentAllocations) ?? 0);
  const servicePenalty = 1 / (1 + 0.2 * recentAllocations + 0.35 * active);
  const explicit = Math.max(0.25, finite(program.fairnessWeight) ?? 1);
  return {
    projectId,
    weight: Math.max(0.25, Math.min(2, starvationBoost * servicePenalty * explicit)),
    waitHours,
    active,
    recentAllocations,
  };
}

function arbitratePortfolio(input = {}) {
  const programs = (input.programs || []).filter((row) => row?.forecast);
  if (!programs.length) throw new Error("At least one forecasted program is required for portfolio arbitration.");
  const nowMs = Number.isFinite(Number(input.nowMs)) ? Number(input.nowMs) : Date.now();
  const fairness = programs.map((program) => fairnessAdjustment(program, input.ledger, nowMs));
  const fairnessByProject = Object.fromEntries(fairness.map((row) => [row.projectId, row]));
  const items = [];
  const candidates = [];
  const completed = new Set(input.completedWorkPackageIds || []);
  const authorizedPermissions = { ...(input.authorizedPermissions || {}) };
  for (const program of programs) {
    const projectId = String(program.projectId || program.forecast.projectId || "default");
    const factor = fairnessByProject[projectId]?.weight || 1;
    for (const item of program.forecast.items || []) {
      if (item.synthetic) continue;
      const adjusted = { ...item, projectId, fairnessWeight: Math.max(0.1, (finite(item.fairnessWeight) ?? 1) * factor) };
      items.push(adjusted);
      for (const candidate of item.candidates || []) {
        candidates.push({ ...candidate, workPackageId: item.workPackageId, fairnessWeight: Math.max(0.1, (finite(candidate.fairnessWeight) ?? 1) * factor) });
      }
    }
    for (const id of program.completedWorkPackageIds || []) completed.add(id);
    if (program.authorizedPermissions) authorizedPermissions[projectId] = program.authorizedPermissions;
  }
  const baseForecast = {
    planId: String(input.portfolioId || "portfolio"),
    projectId: "portfolio",
    contextRevision: Math.max(...programs.map((row) => Number(row.forecast.contextRevision || 1))),
    planRevision: Math.max(...programs.map((row) => Number(row.forecast.planRevision || 1))),
    items,
  };
  const budget = selectConcurrentBundle({
    ...input,
    forecast: baseForecast,
    items,
    candidates,
    completedWorkPackageIds: [...completed],
    authorizedPermissions,
    budgetId: input.budgetId || `${input.portfolioId || "portfolio"}:budget:${input.budgetRevision || 1}`,
    nowMs,
  });
  const projectIds = [...new Set(programs.map((row) => String(row.projectId || row.forecast.projectId || "default")))];
  budget.portfolioId = String(input.portfolioId || "portfolio");
  budget.fairness = fairness;
  budget.projects = projectIds.map((projectId) => ({
    projectId,
    allocated: budget.allocations.filter((row) => row.projectId === projectId).map((row) => row.workPackageId),
    deferred: budget.deferred.filter((row) => row.projectId === projectId).map((row) => row.workPackageId),
  }));
  budget.portfolioFingerprint = fingerprint({
    portfolioId: budget.portfolioId,
    bundleFingerprint: budget.bundleFingerprint,
    fairness,
    projects: budget.projects,
  });
  return budget;
}

module.exports = {
  arbitratePortfolio,
  fairnessAdjustment,
};
