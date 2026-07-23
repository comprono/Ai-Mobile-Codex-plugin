"use strict";

const crypto = require("node:crypto");
const { bounded, boundedList } = require("./utils");

const EXECUTION_BY_WORK_TYPE = Object.freeze({
  context: ["context-scout", "context-dossier"],
  strategy: ["strategist", "master-plan"],
  code: ["code-change", "patch"],
  data: ["code-change", "patch"],
  operation: ["operational-transaction", "operation-receipt"],
  browser: ["browser-action", "browser-receipt"],
  external: ["external-transaction", "external-transaction-receipt"],
  monitoring: ["evidence-observer", "monitoring-evidence"],
  verification: ["verification", "verification-result"],
  reconciliation: ["reconciliation", "reconciliation-decision"],
  generic: ["code-change", "patch"],
});
const CANONICAL_CALLABLE_CAPABILITIES = Object.freeze([
  "source", "local-files", "git", "tests", "browser", "github", "api",
  "command", "database", "service-control", "external-write",
]);
const CALLABLE_CAPABILITIES = new Set(CANONICAL_CALLABLE_CAPABILITIES);
const CAPABILITY_ALIASES = Object.freeze({
  "file-read": "local-files",
  "local-exec": "command",
  "project-tools": "command",
  "service-operations": "service-control",
  verification: "tests",
});
const CANONICAL_PERMISSIONS = Object.freeze([
  "read-project", "read-files", "write-files", "run-tests", "run-command", "database",
  "service-control", "browser", "github", "api", "external-write",
]);
const PERMISSION_NAMES = new Set(CANONICAL_PERMISSIONS);
const PERMISSION_ALIASES = Object.freeze({
  command: "run-command",
  "file-read": "read-files",
  "file-write": "write-files",
  "local-exec": "run-command",
  "project-read": "read-project",
  tests: "run-tests",
});

function canonicalName(value, names, aliases) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return "";
  if (names.has(normalized)) return normalized;
  return aliases[normalized] || "";
}

function canonicalCapabilityName(value) {
  return canonicalName(value, CALLABLE_CAPABILITIES, CAPABILITY_ALIASES);
}

function canonicalPermissionName(value) {
  return canonicalName(value, PERMISSION_NAMES, PERMISSION_ALIASES);
}

function canonicalDeclaredNames(values, normalize, label) {
  return [...new Set((values || []).map((value) => {
    const canonical = normalize(value);
    if (!canonical) throw new Error(`master-plan-assurance-failed: unsupported ${label} ${String(value || "").trim() || "missing"}`);
    return canonical;
  }))];
}

function hash(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value || {})).digest("hex");
}

function permissionNames(permission = {}) {
  const capability = String(permission.capability || "").toLowerCase();
  const mode = String(permission.mode || "").toLowerCase();
  const names = [];
  if (mode === "read" || mode === "observe") names.push("read-project", "read-files");
  if (mode === "write") names.push("write-files");
  if (mode === "execute" || mode === "admin") names.push("run-command");
  if (/database/.test(capability)) names.push("database");
  if (/service/.test(capability)) names.push("service-control");
  if (/browser/.test(capability)) names.push("browser");
  if (/github/.test(capability)) names.push("github");
  if (/\bapi\b/.test(capability)) names.push("api");
  if (mode === "external" || /external|submit|publish|payment/.test(capability)) names.push("external-write");
  return [...new Set(names)];
}

function capabilityNames(workstream = {}, roles = []) {
  const declared = canonicalDeclaredNames(
    workstream.execution?.requiredCapabilities || workstream.requiredCapabilities || [],
    canonicalCapabilityName,
    "callable capability",
  );
  return [...new Set([
    ...declared,
    ...roles.flatMap((role) => role.capabilities || []).map(canonicalCapabilityName).filter(Boolean),
    "source",
    "local-files",
  ])];
}

function planWorkPackages(input = {}) {
  const plan = input.masterPlan || input.plan || {};
  const mission = input.mission || {};
  const dossier = input.contextDossier || {};
  const planNamespace = hash({
    missionId: mission.missionId || mission.id,
    contextFingerprint: dossier.contextFingerprint,
    planRevision: plan.planRevision,
    planFingerprint: plan.planFingerprint,
    workstreams: plan.workstreams,
  }).slice(0, 10);
  const packageId = (workstreamId) => `wp-${planNamespace}-${hash(String(workstreamId || "workstream")).slice(0, 12)}`;
  const roles = new Map((plan.team?.roles || []).map((row) => [row.id, row]));
  const permissions = new Map((plan.permissions || []).map((row) => [row.id, row]));
  const estimates = new Map((plan.resourceEstimates || []).map((row) => [row.id, row]));
  const evidence = new Map((plan.evidenceRequirements || []).map((row) => [row.id, row]));
  const packages = (plan.workstreams || []).map((workstream) => {
    const execution = workstream.execution || {};
    const fallback = EXECUTION_BY_WORK_TYPE[workstream.workType] || EXECUTION_BY_WORK_TYPE.generic;
    const executorKind = execution.executorKind || fallback[0];
    const deliverableKind = execution.deliverableKind || fallback[1];
    const assignedRoles = (workstream.teamRoleIds || []).map((id) => roles.get(id)).filter(Boolean);
    const assignedPermissions = (workstream.permissionIds || []).map((id) => permissions.get(id)).filter(Boolean);
    const requiredPermissions = [...new Set([
      ...assignedPermissions.flatMap(permissionNames),
      ...canonicalDeclaredNames(execution.requiredPermissions || [], canonicalPermissionName, "permission"),
    ])];
    const acceptance = (workstream.evidenceRequirementIds || []).map((id) => evidence.get(id)).filter(Boolean);
    const evidenceRequirementIds = acceptance.map((row) => row.id);
    const acceptanceIds = [...new Set(acceptance.flatMap((row) => row.acceptanceRequirementIds || []))];
    const estimate = estimates.get(workstream.resourceEstimateId) || {};
    const guardedTransaction = ["operational-transaction", "external-transaction"].includes(executorKind) || execution.mutatesExternalState === true;
    const mutatesExternalState = executorKind === "external-transaction" || execution.mutatesExternalState === true;
    const workPackageId = packageId(workstream.id || hash(workstream).slice(0, 12));
    return {
      schemaVersion: 2,
      workPackageId,
      type: executorKind,
      budgetCategory: ["context-scout"].includes(executorKind)
        ? "context"
        : executorKind === "strategist"
          ? "strategy"
          : executorKind === "verification"
            ? "verification"
            : executorKind === "reconciliation"
              ? "reconciliation"
              : "execution",
      workstreamId: workstream.id,
      milestoneIds: boundedList(workstream.milestoneIds, 30, 100),
      dependencies: boundedList(workstream.dependsOn, 30, 100).map(packageId),
      goal: bounded(workstream.outcome, 3000),
      executorKind,
      deliverableKind,
      state: "pending",
      acceptanceIds,
      evidenceRequirementIds,
      acceptanceCriteria: acceptance.map((row) => row.description),
      evidenceRequirements: acceptance,
      teamRoles: assignedRoles.map((role) => ({
        roleId: role.id,
        title: role.title,
        modelClass: role.modelClass,
        responsibilities: role.responsibilities,
      })),
      minimumCapabilityTier: assignedRoles.some((role) => /frontier|strong|ultra/i.test(role.modelClass)) ? "frontier" : "balanced",
      requiredCapabilities: capabilityNames(workstream, assignedRoles),
      requiredPermissions,
      permissionGrant: requiredPermissions,
      relevantFiles: boundedList(execution.relevantFiles || workstream.relevantFiles, 80, 500),
      expectedFiles: boundedList(execution.expectedFiles || workstream.expectedFiles, 80, 500),
      verificationCommands: Array.isArray(execution.verificationCommands || workstream.verificationCommands)
        ? (execution.verificationCommands || workstream.verificationCommands).slice(0, 12)
        : [],
      preconditions: (execution.preconditions || workstream.preconditions || []).slice(0, 30),
      postconditions: (execution.postconditions || workstream.postconditions || []).slice(0, 30),
      rollback: execution.rollback || workstream.rollback || null,
      recoveryAction: bounded(execution.recoveryAction || workstream.recoveryAction, 1200),
      commands: (execution.commands || workstream.commands || []).slice(0, 12),
      mutatesExternalState,
      sideEffectKey: guardedTransaction ? bounded(execution.sideEffectKey || "effect-" + hash({ missionId: mission.missionId || mission.id, planRevision: plan.planRevision, workstreamId: workstream.id }).slice(0, 24), 240) : "",
      observedStateFingerprint: guardedTransaction ? bounded(execution.observedStateFingerprint || dossier.contextFingerprint, 180) : "",
      userAuthorizationRef: bounded(execution.userAuthorizationRef, 500),
      demand: {
        inputTokens: Number(estimate.inputTokens || 0),
        outputTokens: Number(estimate.outputTokens || 0),
        wallMinutes: Number(estimate.wallClockMinutes || 0),
        ramMb: Number(estimate.ramMb || 0),
        diskMb: Number(estimate.diskMb || 0),
        attempts: Number(estimate.attempts || 1),
        concurrency: Number(estimate.concurrency || 1),
      },
      resourceEstimate: {
        tokens: Number(estimate.inputTokens || 0) + Number(estimate.outputTokens || 0),
        wallTimeSeconds: Number(estimate.wallClockMinutes || 0) * 60,
        opportunityCostSeconds: Number(estimate.reviewMinutes || estimate.verificationMinutes || 0) * 60,
        ramMb: Number(estimate.ramMb || 0),
        diskMb: Number(estimate.diskMb || 0),
        apiUsd: 0,
        quotaDemands: Array.isArray(estimate.quotaDemands) ? estimate.quotaDemands : [],
      },
      expectedAcceptanceGain: Math.max(1, acceptanceIds.length),
      successProbability: Number.isFinite(Number(execution.successProbability)) ? Number(execution.successProbability) : 0.7,
      criticalPath: (workstream.dependsOn || []).length === 0,
      ownershipKeys: boundedList(execution.expectedFiles || workstream.expectedFiles, 80, 500),
      revisions: {
        context: Number(dossier.contextRevision || 0),
        plan: Number(plan.planRevision || 0),
        budget: 0,
        campaign: 0,
      },
    };
  });
  return packages;
}

function dependencyReadyPackages(workPackages = []) {
  const completed = new Set(workPackages.filter((row) => row.state === "completed").map((row) => row.workPackageId));
  return workPackages.filter((row) => row.state === "pending" && (row.dependencies || []).every((id) => completed.has(id)));
}

module.exports = {
  CANONICAL_CALLABLE_CAPABILITIES,
  CANONICAL_PERMISSIONS,
  EXECUTION_BY_WORK_TYPE,
  canonicalCapabilityName,
  canonicalPermissionName,
  dependencyReadyPackages,
  permissionNames,
  planWorkPackages,
};
