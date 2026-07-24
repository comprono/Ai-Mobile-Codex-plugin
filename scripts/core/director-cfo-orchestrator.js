"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const { decideIntake } = require("./intake-gate");
const { createSourceCatalog } = require("./source-catalog");
const { createContextScoutWorkPackage, decideContextRefresh, normalizeContextScoutArtifact } = require("./context-dossier");
const { verifyContextSnapshotFreshness } = require("./context-freshness");
const { assessMasterPlan, createStrategyWorkPackage } = require("./plan-assurance");
const { canonicalCapabilityName, dependencyReadyPackages, planWorkPackages } = require("./team-compiler");
const { forecastPlanDemand } = require("./demand-forecast");
const { buildResourceLedger } = require("./resource-ledger");
const { selectConcurrentBundle } = require("./budget-planner");
const { normalizeReservePolicy } = require("./budget-contracts");
const { preflightAllocation } = require("./permission-preflight");
const {
  adaptContextDossierV1,
  assertIntegrationFence,
  createRevisionFence,
  normalizeCampaign,
  normalizeMasterPlan,
  normalizeMission,
  normalizeResourceBudget,
  normalizeExecutionReceipt,
  normalizeWorkPackage,
} = require("./program-contracts");
const { assertExecutionReceiptIntegrable, createProgramState, normalizeProgramState } = require("./program-state");
const {
  contextRefreshRequested,
  createFailurePacket,
  reconciliationWorkPackage,
  recoveryPolicy,
  validateReconciliationDecision,
} = require("./failure-reconciler");
const { buildProgramReport, reportTransition } = require("./program-reporting");
const { createCampaign, startCampaign } = require("./campaign-engine");
const { assertDirectorWorkerContract, createDirectorWorkerContract } = require("./director-worker-contract");
const { normalizeCommands } = require("./verification");
const { validateTypedDeliverable } = require("./typed-deliverables");
const { cancelTaskJobs } = require("./job-store");
const { integrateJob } = require("./patch-integration");
const {
  createTaskRecord,
  jobDirectory,
  listTaskIds,
  readRound,
  readTask,
  updateRound,
  updateTask,
  withWorkspaceLock,
  workspaceKey,
} = require("./state-store");
const { resourceLeaseSnapshot } = require("./resource-leases");
const { readProfile } = require("../lib/orchestrator-profile");
const { runtimeFingerprint } = require("../lib/runtime-identity");
const { boundedList, commandResult, readJson, safeRelativePath, utcNow, writeJson } = require("./utils");

const PROGRAM_SCHEMA_VERSION = 2;
const PROGRAM_MODE = "director-cfo";
const DEFAULT_AUTHORIZED_PERMISSIONS = Object.freeze([
  "source", "local-files", "git", "tests", "read-project", "read-files", "write-files",
]);
const EXECUTOR_TO_TYPE = Object.freeze({
  "context-scout": "context",
  strategist: "strategy",
  "code-change": "code",
  "operational-transaction": "operation",
  "browser-action": "browser",
  "external-transaction": "external",
  "evidence-observer": "monitoring",
  verification: "verification",
  reconciliation: "reconciliation",
});
const DELIVERABLE_TO_CONTRACT = Object.freeze({
  "context-dossier": "analysis",
  "master-plan": "plan",
  patch: "patch",
  "operation-receipt": "operation-receipt",
  "browser-receipt": "browser-receipt",
  "external-transaction-receipt": "external-receipt",
  "monitoring-evidence": "monitor-report",
  "verification-result": "verification-report",
  "reconciliation-decision": "plan",
});
const BLOCKING_CONTEXT_SOURCE_TYPES = new Set(["project-outcome", "acceptance", "chat", "file", "git"]);
// Real Codex frontier invocations include substantial host and tool context; budget observed full invocation exposure.
const STRONG_CONTEXT_RECOVERY_TOKEN_ESTIMATE = 300000;
const STRONG_STRATEGY_TOKEN_ESTIMATE = 100000;
const STRONG_RECONCILIATION_TOKEN_ESTIMATE = 150000;

function hash(value, length = 24) {
  return crypto.createHash("sha256").update(JSON.stringify(value || {})).digest("hex").slice(0, length);
}

function clip(value, maximum) {
  return String(value ?? "").slice(0, maximum);
}

function cleanId(value, prefix = "item") {
  const cleaned = String(value || "").trim().replace(/[^A-Za-z0-9._:-]+/g, "-").replace(/^-|-$/g, "").slice(0, 100);
  return cleaned && /^[A-Za-z]/.test(cleaned) ? cleaned : `${prefix}-${hash(value || prefix, 20)}`;
}

function frontierRequirementId(requirements = []) {
  const rows = Array.isArray(requirements) ? requirements : [];
  const frontier = rows.find((row) => row?.required !== false && String(row.status || "failing").toLowerCase() !== "passing")
    || rows.find((row) => row?.required !== false)
    || rows[0];
  return frontier?.id || "requirement-frontier";
}

function failureAcceptanceIds(task, workPackage = {}) {
  const unresolved = new Set((task.requirements || [])
    .filter((row) => row?.required !== false && String(row.status || "failing").toLowerCase() !== "passing")
    .map((row) => row.id));
  const owned = (workPackage.acceptanceIds || []).filter((id) => unresolved.has(id));
  return owned.length ? owned : [frontierRequirementId(task.requirements)];
}

function acceptanceRows(values, outcome) {
  const rows = Array.isArray(values) && values.length ? values : [{ description: outcome, minimumEvidenceLevel: "end-to-end" }];
  return rows.slice(0, 250).map((value, index) => {
    const row = typeof value === "string" ? { description: value } : value || {};
    return {
      id: cleanId(row.id || row.requirementId || `requirement-${index + 1}`, "requirement"),
      description: clip(row.description || row.outcome || outcome, 2000).trim(),
      required: row.required !== false,
      status: ["passing", "failing", "blocked", "waived"].includes(row.status) ? row.status : "failing",
      minimumEvidenceLevel: ["activity", "process-health", "focused-test", "integration", "end-to-end", "user-visible"].includes(row.minimumEvidenceLevel) ? row.minimumEvidenceLevel : "end-to-end",
      evidence: Array.isArray(row.evidence) ? row.evidence : [],
      blocker: row.blocker || null,
    };
  });
}

function missionRequirements(requirements) {
  return requirements.map((row) => ({
    requirementId: row.id,
    description: row.description,
    required: row.required,
    status: row.status,
    minimumEvidenceLevel: row.minimumEvidenceLevel,
    evidenceRefs: (row.evidence || []).map((item) => item.ref).filter(Boolean),
  }));
}

function descriptorInputs(args = {}) {
  const descriptors = args.sourceDescriptors || {};
  const keys = ["chats", "files", "git", "logs", "databases", "services", "browsers", "external"];
  const typeFor = { chats: "chat", files: "file", git: "git", logs: "log", databases: "database", services: "service", browsers: "browser", external: "external" };
  const suppliedTypes = keys
    .filter((key) => Array.isArray(descriptors[key]) ? descriptors[key].length : Boolean(descriptors[key]))
    .map((key) => typeFor[key]);
  return {
    projectContract: args.projectContract === false ? false : (args.projectContract || true),
    authorization: {
      scopeId: args.authorization?.scopeId || "project",
      authorizedBy: args.authorization?.authorizedBy || "explicit-program-request",
      grantRef: args.authorization?.grantRef || "start-program",
      allowedTypes: [...new Set([
        ...(args.authorization?.allowedTypes || []),
        "project-outcome", "acceptance", ...suppliedTypes,
      ])],
    },
    ...Object.fromEntries(keys.map((key) => [key, descriptors[key] || []])),
  };
}

function descriptorsFromCatalog(catalog = {}) {
  const result = { chats: [], files: [], git: [], logs: [], databases: [], services: [], browsers: [], external: [] };
  const keyByType = {
    chat: "chats",
    file: "files",
    git: "git",
    log: "logs",
    database: "databases",
    service: "services",
    browser: "browsers",
    external: "external",
  };
  let projectContract = false;
  for (const source of catalog.sources || []) {
    if (source.type === "project-outcome" || source.type === "acceptance") {
      projectContract = projectContract || {};
      if (source.type === "project-outcome") projectContract.outcomePath = source.locator;
      if (source.type === "acceptance") projectContract.acceptancePath = source.locator;
      continue;
    }
    const key = keyByType[source.type];
    if (!key) continue;
    result[key].push({
      id: source.id,
      locator: source.locator,
      access: source.access,
      required: source.required,
      authorized: true,
      authority: source.authority,
      description: source.description,
      revisionHint: source.revisionHint,
      capabilities: source.capabilities,
    });
  }
  return { projectContract, sourceDescriptors: result };
}

function localSourceFiles(workspace, catalog) {
  const files = [];
  for (const source of catalog.sources || []) {
    if (!["project-outcome", "acceptance", "chat", "file", "log", "database"].includes(source.type)) continue;
    let relative;
    try { relative = safeRelativePath(workspace, source.locator); } catch { continue; }
    if (!relative || relative === ".") continue;
    try {
      const absolute = path.join(workspace, relative);
      if (fs.existsSync(absolute) && fs.statSync(absolute).isFile()) files.push(relative);
    } catch { /* descriptor remains an explicit context limitation */ }
  }
  const unique = [...new Set(files)];
  if (unique.length > 80) throw new Error(`context-source-file-limit-exceeded:${unique.length}:maximum=80`);
  return unique;
}

function availableProjectFiles(workspace, catalog) {
  const files = [...localSourceFiles(workspace, catalog)];
  const tracked = commandResult("git", ["-C", workspace, "ls-files", "-z"], {
    timeout: 10000,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (tracked.status === 0) {
    for (const relative of String(tracked.stdout || "").split("\0").filter(Boolean)) {
      try {
        const safe = safeRelativePath(workspace, relative);
        const absolute = path.join(workspace, safe);
        if (fs.existsSync(absolute) && fs.statSync(absolute).isFile()) files.push(safe);
      } catch { /* an unsafe or concurrently removed path is not advertised */ }
    }
  } else {
    const excluded = new Set([
      ".git", "node_modules", ".venv", "venv", "env", "__pycache__", ".pytest_cache",
      ".mypy_cache", ".ruff_cache", ".cache", "dist", "build", "coverage", "target",
    ]);
    const stack = [workspace];
    while (stack.length) {
      const current = stack.pop();
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        if (excluded.has(entry.name)) continue;
        const absolute = path.join(current, entry.name);
        if (entry.isDirectory()) stack.push(absolute);
        else if (entry.isFile()) {
          const relative = safeRelativePath(workspace, absolute);
          files.push(relative);
          if (files.length > 500) throw new Error(`strategy-project-file-limit-exceeded:${files.length}:maximum=500`);
        }
      }
    }
  }
  const unique = [...new Set(files.map((row) => String(row).replace(/\\/g, "/")))].sort();
  if (unique.length > 500) throw new Error(`strategy-project-file-limit-exceeded:${unique.length}:maximum=500`);
  return unique;
}

function readOnlySnapshotDiskMb(workspace, relativeFiles = [], catalog = {}) {
  let bytes = 0;
  const databaseFiles = new Set((catalog.sources || []).filter((row) => row.type === "database").flatMap((row) => {
    try { return [safeRelativePath(workspace, row.locator).toLowerCase()]; } catch { return []; }
  }));
  for (const relative of relativeFiles) {
    try {
      const absolute = path.join(workspace, safeRelativePath(workspace, relative));
      const stat = fs.statSync(absolute);
      if (!stat.isFile()) continue;
      if (databaseFiles.has(String(relative).toLowerCase())) {
        let walBytes = 0;
        try { walBytes = fs.statSync(`${absolute}-wal`).size; } catch { /* a checkpointed database may have no WAL */ }
        bytes += 2 * (stat.size + walBytes);
      } else {
        bytes += stat.size;
      }
    } catch { /* unavailable sources remain represented in the context contract */ }
  }
  return 16 + Math.ceil(bytes / (1024 * 1024));
}

function workGraphNode(workPackage, requirementId) {
  return {
    id: workPackage.workPackageId,
    goal: workPackage.goal,
    dependsOn: workPackage.dependencies || workPackage.dependsOn || [],
    priority: Number(workPackage.priority || 80),
    state: workPackage.state === "completed" ? "completed" : workPackage.state === "running" ? "running" : "pending",
    owner: null,
    evidenceRefs: [],
    acceptanceRequirementId: workPackage.acceptanceIds?.[0] || requirementId,
    relevantFiles: workPackage.relevantFiles || [],
    expectedFiles: workPackage.expectedFiles || [],
    acceptanceCriteria: workPackage.acceptanceCriteria || [],
    verificationCommands: workPackage.verificationCommands || [],
    taskKind: workPackage.taskKind || "generic",
    complexity: workPackage.complexity || "medium",
    readOnly: workPackage.readOnly === true,
    requiredCapabilities: workPackage.requiredCapabilities || [],
    programWorkPackageId: workPackage.workPackageId,
  };
}

function bootstrapPackage(kind, contract, workspace, requirementId) {
  const context = kind === "context";
  const contextCapabilities = ["source", "local-files"];
  const contextPermissions = ["read-project", "read-files"];
  const workPackageId = context
    ? `context-${contract.mission.revision}-${Number(contract.previousContext?.revision || 0) + 1}`
    : `strategy-${contract.mission.revision}-${contract.context.revision}`;
  const relevantFiles = context
    ? localSourceFiles(workspace, contract.sourceCatalog)
    : localSourceFiles(workspace, { sources: contract.contextDossier?.sourceObservations?.map((row) => ({ type: "file", locator: row.sourceId })) || [] });
  const snapshotDiskMb = context ? readOnlySnapshotDiskMb(workspace, relevantFiles, contract.sourceCatalog) : 16;
  return {
    schemaVersion: PROGRAM_SCHEMA_VERSION,
    workPackageId,
    type: context ? "context-scout" : "strategist",
    budgetCategory: context ? "context" : "strategy",
    goal: contract.prompt,
    prompt: contract.prompt,
    state: "pending",
    dependencies: [],
    acceptanceIds: [requirementId],
    acceptanceCriteria: context
      ? ["Return a cited context dossier for every required authorized source."]
      : ["Return a complete assured master plan tied to the current context revision."],
    executorKind: context ? "context-scout" : "strategist",
    deliverableKind: context ? "context-dossier" : "master-plan",
    readOnly: true,
    relevantFiles,
    ...(context ? {
      databaseObservation: {
        mode: "immutable-sqlite-receipt",
        sourceIds: (contract.sourceCatalog?.sources || []).filter((row) => row.type === "database").map((row) => row.id).sort(),
      },
    } : {}),
    expectedFiles: [],
    verificationCommands: [],
    requiredCapabilities: context ? [...new Set(contextCapabilities)] : ["source", "local-files"],
    requiredPermissions: context ? [...new Set(contextPermissions)] : ["read-project", "read-files"],
    permissionGrant: context ? [...new Set(contextPermissions)] : ["read-project", "read-files"],
    taskKind: context ? "repository-scan" : "architecture",
    complexity: context ? "medium" : "large",
    minimumCapabilityTier: context ? "efficient" : "frontier",
    preferredProvider: "auto",
    timeoutSeconds: context ? 900 : 1200,
    estimatedDirectTokens: context ? 12000 : STRONG_STRATEGY_TOKEN_ESTIMATE,
    maxWorkerOutputTokens: context ? 3000 : 4000,
    expectedAcceptanceGain: context ? 2 : 4,
    successProbability: context ? 0.85 : 0.75,
    criticalPath: true,
    ownershipKeys: [],
    resourceEstimate: {
      tokens: context ? 12000 : STRONG_STRATEGY_TOKEN_ESTIMATE,
      wallTimeSeconds: context ? 900 : 1200,
      opportunityCostSeconds: context ? 60 : 180,
      ramMb: 512,
      diskMb: snapshotDiskMb,
      apiUsd: 0,
      quotaDemands: [],
    },
    bootstrapContract: contract,
  };
}

function uniqueRetryWorkPackageId(program, baseWorkPackageId, discriminator) {
  const existing = new Set((program?.workPackages || []).map((row) => row.workPackageId));
  const prefix = cleanId(baseWorkPackageId, "work-package-retry").slice(0, 60);
  const retryHash = hash(discriminator || baseWorkPackageId, 12);
  let sequence = 1;
  let candidate;
  do {
    const suffix = sequence === 1 ? retryHash : `${retryHash}-${sequence}`;
    candidate = cleanId(`${prefix}-retry-${suffix}`, "work-package-retry");
    sequence += 1;
  } while (existing.has(candidate));
  return candidate;
}

const SAFE_CONTEXT_RETRY_FIELDS = new Set([
  "complexity", "estimatedDirectTokens", "minimumCapabilityTier", "resourceEstimate",
  "successProbability", "taskKind", "timeoutSeconds", "maxWorkerOutputTokens",
]);

function rootFailedWorkPackage(task, candidate) {
  const packages = new Map((task.program?.workPackages || []).map((row) => [row.workPackageId, row]));
  const seen = new Set();
  let current = candidate || null;
  while (current?.executorKind === "reconciliation" && current.failedWorkPackageId && !seen.has(current.workPackageId)) {
    seen.add(current.workPackageId);
    const next = packages.get(current.failedWorkPackageId);
    if (!next) break;
    current = next;
  }
  return current || candidate;
}

function safeContextRetryPackage(task, basePackage, transition, reconciliationPackage, decisionFingerprint) {
  const requested = transition.revised?.patch || {};
  const applied = Object.fromEntries(Object.entries(requested).filter(([key]) => SAFE_CONTEXT_RETRY_FIELDS.has(key)));
  const rootFailure = rootFailedWorkPackage(task, transition.failedPackage);
  const failureClass = String(reconciliationPackage.failurePacket?.failureClass || rootFailure?.lastFailure?.failureClass || "");
  const strongRetry = failureClass !== "context-stale"
    || reconciliationPackage.policy?.fullContextRefresh === true
    || reconciliationPackage.policy?.revisePlan === true
    || rootFailure?.executorKind !== "context-scout";
  const requestedTier = ["efficient", "balanced", "frontier"].includes(applied.minimumCapabilityTier)
    ? applied.minimumCapabilityTier
    : basePackage.minimumCapabilityTier;
  const minimumCapabilityTier = strongRetry ? "frontier" : requestedTier;
  const preferredProvider = strongRetry ? "antigravity" : (basePackage.preferredProvider || "auto");
  const timeoutSeconds = Math.min(3600, Math.max(
    Number(basePackage.timeoutSeconds || 0),
    Number(applied.timeoutSeconds || 0),
    strongRetry ? 1200 : 0,
  ));
  const maxWorkerOutputTokens = Math.min(8000, Math.max(
    Number(basePackage.maxWorkerOutputTokens || 0),
    Number(applied.maxWorkerOutputTokens || 0),
    strongRetry ? 4000 : 0,
  ));
  const requestedEstimate = applied.resourceEstimate && typeof applied.resourceEstimate === "object" ? applied.resourceEstimate : {};
  const resourceEstimate = {
    ...(basePackage.resourceEstimate || {}),
    ...requestedEstimate,
    tokens: Math.max(Number(basePackage.resourceEstimate?.tokens || 0), Number(requestedEstimate.tokens || 0), strongRetry ? STRONG_CONTEXT_RECOVERY_TOKEN_ESTIMATE : 0),
    wallTimeSeconds: Math.max(Number(basePackage.resourceEstimate?.wallTimeSeconds || 0), Number(requestedEstimate.wallTimeSeconds || 0), strongRetry ? 1200 : 0),
  };
  const reconciledContract = {
    ...applied,
    complexity: strongRetry ? "large" : applied.complexity || basePackage.complexity,
    estimatedDirectTokens: Math.max(Number(basePackage.estimatedDirectTokens || 0), Number(applied.estimatedDirectTokens || 0), strongRetry ? STRONG_CONTEXT_RECOVERY_TOKEN_ESTIMATE : 0),
    minimumCapabilityTier,
    preferredProvider,
    timeoutSeconds,
    maxWorkerOutputTokens,
    resourceEstimate,
    requiredCapabilities: [...(basePackage.requiredCapabilities || [])],
    requiredPermissions: [...(basePackage.requiredPermissions || [])],
    permissionGrant: [...(basePackage.permissionGrant || [])],
  };
  return {
    ...basePackage,
    ...reconciledContract,
    workPackageId: uniqueRetryWorkPackageId(task.program, basePackage.workPackageId, decisionFingerprint),
    state: "pending",
    executorKind: "context-scout",
    deliverableKind: "context-dossier",
    readOnly: true,
    mutatesExternalState: false,
    commands: [],
    requiredCapabilities: [...(basePackage.requiredCapabilities || [])],
    requiredPermissions: [...(basePackage.requiredPermissions || [])],
    permissionGrant: [...(basePackage.permissionGrant || [])],
    relevantFiles: [...(basePackage.relevantFiles || [])],
    bootstrapContract: basePackage.bootstrapContract,
    databaseObservation: basePackage.databaseObservation,
    reconciledContract,
    requestedReconciliationPatch: requested,
    reconciliationAdjustments: {
      safeContextTransport: "immutable-sqlite-receipt",
      strongRetry,
      ignoredRequestedFields: Object.keys(requested).filter((key) => !SAFE_CONTEXT_RETRY_FIELDS.has(key)).sort(),
    },
    retryOfWorkPackageId: rootFailure?.workPackageId || transition.failedPackage.workPackageId,
    reconciliationWorkPackageId: reconciliationPackage.workPackageId,
    reconciliationDecisionFingerprint: decisionFingerprint,
    allocation: null,
    permissionPreflight: null,
    revisionFence: null,
    canonicalContract: null,
  };
}


function safeStrategyRetryPackage(task, basePackage, directive) {
  const requested = directive?.revisedPackagePatch || {};
  const applied = Object.fromEntries(Object.entries(requested).filter(([key]) => SAFE_CONTEXT_RETRY_FIELDS.has(key)));
  const requestedEstimate = applied.resourceEstimate && typeof applied.resourceEstimate === "object" ? applied.resourceEstimate : {};
  const timeoutSeconds = Math.min(3600, Math.max(
    Number(basePackage.timeoutSeconds || 0),
    Number(applied.timeoutSeconds || 0),
    1200,
  ));
  const maxWorkerOutputTokens = Math.min(8000, Math.max(
    Number(basePackage.maxWorkerOutputTokens || 0),
    Number(applied.maxWorkerOutputTokens || 0),
    4000,
  ));
  const resourceEstimate = {
    ...(basePackage.resourceEstimate || {}),
    ...requestedEstimate,
    tokens: Math.max(Number(basePackage.resourceEstimate?.tokens || 0), Number(requestedEstimate.tokens || 0), STRONG_STRATEGY_TOKEN_ESTIMATE),
    wallTimeSeconds: Math.max(Number(basePackage.resourceEstimate?.wallTimeSeconds || 0), Number(requestedEstimate.wallTimeSeconds || 0), 1200),
  };
  const reconciledContract = {
    ...applied,
    complexity: "large",
    estimatedDirectTokens: Math.max(Number(basePackage.estimatedDirectTokens || 0), Number(applied.estimatedDirectTokens || 0), STRONG_STRATEGY_TOKEN_ESTIMATE),
    minimumCapabilityTier: "frontier",
    timeoutSeconds,
    maxWorkerOutputTokens,
    resourceEstimate,
    requiredCapabilities: [...(basePackage.requiredCapabilities || [])],
    requiredPermissions: [...(basePackage.requiredPermissions || [])],
    permissionGrant: [...(basePackage.permissionGrant || [])],
  };
  return {
    ...basePackage,
    ...reconciledContract,
    workPackageId: uniqueRetryWorkPackageId(task.program, basePackage.workPackageId, directive?.reconciliationDecisionFingerprint),
    state: "pending",
    executorKind: "strategist",
    deliverableKind: "master-plan",
    readOnly: true,
    requiredCapabilities: [...(basePackage.requiredCapabilities || [])],
    requiredPermissions: [...(basePackage.requiredPermissions || [])],
    permissionGrant: [...(basePackage.permissionGrant || [])],
    reconciledContract,
    requestedReconciliationPatch: requested,
    retryOfWorkPackageId: directive?.failedWorkPackageId || "",
    reconciliationWorkPackageId: directive?.reconciliationWorkPackageId || "",
    reconciliationDecisionFingerprint: directive?.reconciliationDecisionFingerprint || "",
    reconciliationDirective: directive || null,
    allocation: null,
    permissionPreflight: null,
    revisionFence: null,
    canonicalContract: null,
  };
}
function planRevisionDirective(task, transition, reconciliationPackage, decision, decisionFingerprint, force = false) {
  if (!decision.planRevision && !force) return null;
  const failedPackage = transition.rootFailedPackage || transition.failedPackage;
  const observedPlanRevision = Math.max(
    Number(task.program.masterPlan?.planRevision || 0),
    Number(failedPackage?.revisions?.plan || 0),
    Number(failedPackage?.bootstrapContract?.minimumPlanRevision || 0),
  );
  const priorPlanRevision = failedPackage?.executorKind === "strategist"
    ? Math.max(1, observedPlanRevision)
    : observedPlanRevision;
  return {
    schemaVersion: "director-cfo/plan-revision-directive@1",
    failureFingerprint: reconciliationPackage.failurePacket?.failureFingerprint || decision.failureFingerprint || "",
    reconciliationWorkPackageId: reconciliationPackage.workPackageId,
    reconciliationDecisionFingerprint: decisionFingerprint,
    failedWorkPackageId: failedPackage?.workPackageId || transition.failedPackage?.workPackageId || "",
    failedWorkstreamId: failedPackage?.workstreamId || "",
    priorPlanRevision,
    minimumPlanRevision: Math.max(1, priorPlanRevision + (priorPlanRevision > 0 ? 1 : 0)),
    rootCause: clip(decision.rootCause, 2000),
    evidence: boundedList(decision.evidence, 30, 1200),
    requestedPlanRevision: decision.planRevision || {
      reason: "The prior plan was invalidated by a full-context recovery decision.",
    },
    requestedPackageChanges: {
      changedContract: decision.changedContract || null,
      changedWorkerRequirements: decision.changedWorkerRequirements || null,
      changedPermissions: decision.changedPermissions || null,
    },
    revisedPackagePatch: transition.revised?.changed ? transition.revised.patch : {},
      userDecision: decision.userDecision || null,
  };
}

function supersededRebuildPackages(program, reconciliationWorkPackageId, decision, now) {
  return (program.workPackages || []).map((row) => {
    if (row.workPackageId === reconciliationWorkPackageId) {
      return { ...row, state: "completed", completedAt: now, reconciliationDecision: decision };
    }
    if (row.state === "completed") return row;
    return {
      ...row,
      state: "superseded",
      supersededAt: now,
      ...(row.jobId ? { supersededJobId: row.jobId } : {}),
      jobId: null,
      allocation: null,
      permissionPreflight: null,
      revisionFence: null,
      canonicalContract: null,
    };
  });
}

function supersededRebuildGraph(workGraph, reconciliationWorkPackageId, replacement, requirementId, now) {
  const retired = (workGraph || []).map((node) => {
    if (node.id === reconciliationWorkPackageId) return { ...node, state: "completed", owner: null };
    if (node.state === "completed") return node;
    return { ...node, state: "superseded", owner: null, supersededAt: now };
  });
  return [...retired, workGraphNode(replacement, requirementId)];
}

function stoppedCampaignHistory(program, reason, now) {
  const active = program.activeCampaign || program.contracts?.campaign || null;
  const activeId = active?.campaignId || "";
  const stopped = (program.campaigns || []).map((row) => {
    const shouldStop = (activeId && row.campaignId === activeId) || ["active", "running"].includes(String(row.state || "").toLowerCase());
    return shouldStop ? { ...row, state: "stopped", finishedAt: now, stopReason: reason } : row;
  });
  if (active && activeId && !stopped.some((row) => row.campaignId === activeId)) {
    stopped.push({ ...active, state: "stopped", finishedAt: now, stopReason: reason });
  }
  return stopped.slice(-100);
}

function revisedStrategyPackage(task, strategyContract, transition, reconciliationPackage, decisionFingerprint) {
  const base = bootstrapPackage("strategy", strategyContract, task.workspace, frontierRequirementId(task.requirements));
  return safeStrategyRetryPackage(task, base, strategyContract.reconciliationDirective);
}

function compactInventory(resources = {}) {
  return {
    generatedAt: resources.generatedAt || null,
    machine: resources.machine || null,
    worktreeStorage: resources.worktreeStorage || null,
    providers: Object.fromEntries(Object.entries(resources.providers || {}).map(([id, row]) => [id, {
      available: row.available === true,
      authenticated: row.authenticated === true,
      headless: row.headless !== false,
      reason: row.reason || "",
      models: (row.models || []).slice(0, 100),
      capacity: row.capacity || null,
      surfaces: row.surfaces || {},
      permissions: row.permissions || {},
    }])),
  };
}

function sameRequirementMeaning(left, right) {
  const normalized = (value) => String(value || "").trim().replace(/\s+/g, " ").toLowerCase();
  return normalized(left?.description) === normalized(right?.description);
}

function migrationRequirements(task, args, outcome) {
  const existing = acceptanceRows(task.requirements, outcome);
  if (!Array.isArray(args.acceptanceEvidence) || !args.acceptanceEvidence.length) return existing;
  const byId = new Map(existing.map((row) => [row.id, row]));
  return acceptanceRows(args.acceptanceEvidence, outcome).map((row) => {
    const prior = byId.get(row.id);
    if (!prior || !sameRequirementMeaning(prior, row)) return row;
    const evidence = [...(prior.evidence || []), ...(row.evidence || [])]
      .filter((entry, index, values) => index === values.findIndex((candidate) => (
        String(candidate?.ref || "") === String(entry?.ref || "")
        && String(candidate?.level || "") === String(entry?.level || "")
      )))
      .slice(-100);
    return {
      ...row,
      status: prior.status === "passing" && evidence.length ? "passing" : row.status,
      evidence,
      blocker: row.blocker || prior.blocker || null,
    };
  });
}

function assertReadableRequiredChatSnapshots(workspace, catalog) {
  for (const source of (catalog.sources || []).filter((row) => row.type === "chat" && row.required !== false)) {
    let relative;
    try {
      relative = safeRelativePath(workspace, source.locator);
    } catch {
      throw new Error(`Required chat source must be a readable workspace snapshot: ${source.id}.`);
    }
    const absolute = path.join(workspace, relative);
    let readable = false;
    try {
      readable = fs.statSync(absolute).isFile();
      if (readable) fs.accessSync(absolute, fs.constants.R_OK);
    } catch {
      readable = false;
    }
    if (!readable) throw new Error(`Required chat source must be a readable workspace snapshot: ${source.id}.`);
  }
}

function compactLegacyMigration(task, cancelledWorkers, invalidatedRoundIds, migratedAt) {
  const cancelledJobIds = cancelledWorkers
    .filter((row) => row.state === "cancelled")
    .map((row) => row.jobId)
    .filter(Boolean)
    .slice(-100);
  return {
    schemaVersion: 1,
    mode: "legacy-to-director-cfo",
    migratedAt,
    sourceTaskId: task.taskId,
    sourceContractVersion: Number(task.contractVersion || 1),
    sourceCreatedAt: task.createdAt || null,
    cancelledJobIds,
    invalidatedRoundIds: invalidatedRoundIds.slice(-100),
    legacyRounds: (task.rounds || []).slice(-100).map((row) => ({
      roundId: row.roundId,
      state: row.state,
      createdAt: row.createdAt || null,
      updatedAt: row.updatedAt || null,
    })),

    legacyWorkGraph: (task.workGraph || []).slice(-200).map((row) => ({
      id: clip(row.id, 160),
      state: clip(row.state, 80),
      acceptanceRequirementId: clip(row.acceptanceRequirementId, 160),
      lastFailure: clip(row.lastFailure, 500),
    })),
    legacyEvidenceRefs: (task.evidence || []).slice(-500).map((row) => ({
      requirementId: clip(row.requirementId, 160),
      level: clip(row.level, 80),
      ref: clip(row.ref, 500),
    })),
  };
}

function repairDirectorLegacyRounds(taskValue) {
  let task = typeof taskValue === "string" ? readTask(taskValue) : taskValue;
  if (!isDirectorTask(task) || task.program.migration?.mode !== "legacy-to-director-cfo") return task;
  task = repairDirectorExecutionEvidence(task);
  const legacyRoundIds = [...new Set((task.program.migration.legacyRounds || []).map((row) => String(row.roundId || "")).filter(Boolean))];
  if (!legacyRoundIds.length) return task;

  const invalidatedRoundIds = new Set(task.program.migration.invalidatedRoundIds || []);
  const repairedRoundIds = [];
  for (const roundId of legacyRoundIds) {
    const round = readRound(task.taskId, roundId);
    if (round.state === "integrated") continue;
    if (round.state === "invalidated") {
      invalidatedRoundIds.add(roundId);
      continue;
    }
    updateRound(task.taskId, roundId, {
      state: "invalidated",
      invalidatedAt: utcNow(),
      invalidatedReason: "Legacy round repaired before Director-CFO campaign dispatch.",
    });
    invalidatedRoundIds.add(roundId);
    repairedRoundIds.push(roundId);
  }
  if (!repairedRoundIds.length) return readTask(task.taskId);

  return updateTask(task.taskId, (current) => {
    current.program = {
      ...current.program,
      migration: {
        ...current.program.migration,
        invalidatedRoundIds: [...invalidatedRoundIds].slice(-100),
        legacyRoundRepair: {
          schemaVersion: 1,
          repairedRoundIds: [...new Set([...(current.program.migration.legacyRoundRepair?.repairedRoundIds || []), ...repairedRoundIds])].slice(-100),
          repairedAt: utcNow(),
        },
      },
      updatedAt: utcNow(),
    };
    return current;
  });
}

function migrateLegacyTaskToDirector(args = {}, resources = {}) {
  if (args.migrateToDirector !== true) throw new Error("Legacy migration requires migrateToDirector:true.");
  const initial = readTask(args.taskId);
  if (isDirectorTask(initial)) return initial;
  if (!["active", "blocked"].includes(String(initial.state || ""))) {
    throw new Error(`Only an active legacy task can migrate to Director-CFO mode: ${initial.taskId}.`);
  }

  const outcome = clip(args.outcome || initial.outcome || initial.requestedOutcome, 10000).trim();
  const latestUserRequest = clip(args.userRequest || args.latestUserRequest || initial.latestUserRequest || outcome, 10000).trim();
  if (!outcome) throw new Error("Legacy migration requires an outcome.");
  const requirements = migrationRequirements(initial, args, outcome);
  const constraints = Object.prototype.hasOwnProperty.call(args, "constraints")
    ? boundedList(args.constraints, 100, 2000)
    : boundedList(initial.constraints, 100, 2000);
  const missionId = cleanId(args.missionId || `mission-${hash({ taskId: initial.taskId, outcome }, 20)}`, "mission");
  const mission = normalizeMission({
    schemaVersion: PROGRAM_SCHEMA_VERSION,
    missionId,
    revision: 1,
    state: "active",
    outcome,
    requestedOutcome: outcome,
    latestUserRequest,
    authority: "user",
    requirements: missionRequirements(requirements),
    successDefinition: requirements.filter((row) => row.required).map((row) => row.description),
    constraints,
  });
  const sourceCatalog = createSourceCatalog({ missionId, ...descriptorInputs(args) });
  assertReadableRequiredChatSnapshots(initial.workspace, sourceCatalog);
  const contextContract = createContextScoutWorkPackage({
    mission: { id: missionId, revision: mission.revision, outcome: mission.outcome },
    sourceCatalog,
    workspace: initial.workspace,
    refreshDecision: decideContextRefresh({ sourceCatalog, previousDossier: null }),
  });
  const contextPackage = bootstrapPackage("context", contextContract, initial.workspace, frontierRequirementId(requirements));

  const cancelledWorkers = cancelTaskJobs(initial.taskId);
  const invalidatedRoundIds = [];
  for (const reference of initial.rounds || []) {
    const round = readRound(initial.taskId, reference.roundId);
    if (["integrated", "invalidated"].includes(round.state)) continue;
    updateRound(initial.taskId, round.roundId, {
      state: "invalidated",
      invalidatedAt: utcNow(),
      invalidatedReason: "Legacy task migrated in place to Director-CFO mode.",
    });
    invalidatedRoundIds.push(round.roundId);
  }

  const basis = readTask(initial.taskId);
  const migratedAt = utcNow();
  const programId = cleanId(args.programId || `program-${hash(missionId, 20)}`, "program");
  const contracts = createProgramState({
    programId,
    mission,
    state: "active",
    createdAt: migratedAt,
    updatedAt: migratedAt,
  });
  const authorizedPermissions = [...new Set([
    ...DEFAULT_AUTHORIZED_PERMISSIONS,
    ...(args.authorizedPermissions || []),
  ].map((value) => String(value).trim().toLowerCase()).filter(Boolean))];
  const inventory = Object.keys(resources || {}).length ? resources : (basis.capacitySnapshot || {});
  const migration = compactLegacyMigration(initial, cancelledWorkers, invalidatedRoundIds, migratedAt);
  const intake = decideIntake({
    mode: "program",
    request: latestUserRequest || outcome,
    sourceDescriptors: args.sourceDescriptors,
    expectedDurationSeconds: Number(args.expectedDurationSeconds || 3600),
  });
  const program = {
    schemaVersion: PROGRAM_SCHEMA_VERSION,
    mode: PROGRAM_MODE,
    programId,
    phase: "context",
    state: "active",
    intake,
    mission,
    contracts,
    sourceCatalog,
    contextDossier: null,
    masterPlan: null,
    resourceBudget: null,
    activeCampaign: null,
    campaigns: [],
    workPackages: [contextPackage],
    executionReceipts: [],
    failureMemory: [],
    evidenceLedger: { entries: [...(basis.evidence || [])].slice(-1000) },
    reportCursor: {},
    authorizedPermissions,
    contextSourceFingerprints: args.contextSourceFingerprints || {},
    migration,
    runtime: {
      inventory: compactInventory(inventory),
      forecast: null,
      ledger: null,
      budget: null,
      bootstrapFence: {
        missionFingerprint: mission.fingerprint,
        catalogFingerprint: sourceCatalog.catalogFingerprint,
      },
    },
    policy: {
      campaignHours: Math.max(1, Math.min(4, Number(args.campaignHours || 4))),
      noProgressLimit: Math.max(1, Math.min(5, Number(args.noProgressLimit || 2))),
      maxWorkers: Math.max(1, Math.min(20, Number(args.maxWorkers || readProfile().maxGlobalWorkers || 2))),
    },
    nextAction: "Budget and assign the context scout for the migrated canonical task.",
    createdAt: migratedAt,
    updatedAt: migratedAt,
  };

  return updateTask(initial.taskId, (current) => {
    if (isDirectorTask(current)) return current;
    if (Number(current.contractVersion || 1) !== Number(basis.contractVersion || 1)
      || String(current.updatedAt || "") !== String(basis.updatedAt || "")) {
      throw new Error("Legacy task changed during Director migration; retry from fresh authoritative state.");
    }
    current.state = "active";
    current.outcome = outcome;
    current.requestedOutcome = outcome;
    current.latestUserRequest = latestUserRequest;
    current.outcomeAuthority = "user";
    current.contractVersion = Number(current.contractVersion || 1) + 1;
    current.revisedAt = migratedAt;
    current.requirements = requirements;
    current.constraints = constraints;
    current.blockers = [];
    current.workGraph = [workGraphNode(contextPackage, frontierRequirementId(requirements))];
    current.currentCodex = {
      ...(current.currentCodex || {}),
      role: "project-console",
      model: args.consoleModel || "gpt-5.3-codex-spark",
      effort: args.consoleEffort || "medium",
      reservePercent: Number(args.codexReservePercent || readProfile().codexReservePercent || 15),
      goal: "Report Director-CFO goals, milestones, evidence, blockers, budget, and next action. Own no project implementation files.",
      files: [],
      ownsProjectFiles: false,
    };
    current.capacitySnapshot = compactInventory(inventory);
    current.program = program;
    current.legacyMigration = migration;
    return current;
  });
}

function startDirectorProgram(args = {}, resources = {}) {
  const intake = decideIntake({
    ...args,
    request: args.userRequest || args.request || args.outcome,
    sourceDescriptors: args.sourceDescriptors,
  });
  if (intake.mode === "direct") {
    return {
      mode: "direct",
      orchestrationStarted: false,
      intake,
      action: "Handle this bounded task directly in the visible Codex task.",
      taskId: null,
    };
  }

  const workspace = String(args.workspace || "").trim();
  const outcome = clip(args.outcome || args.userRequest || args.request, 10000).trim();
  if (!workspace) throw new Error("start-program requires workspace.");
  if (!outcome) throw new Error("start-program requires outcome or userRequest.");
  return withWorkspaceLock(workspace, () => startDirectorProgramLocked(args, resources, intake, workspace, outcome));
}

function startDirectorProgramLocked(args, resources, intake, workspace, outcome) {
  const duplicateProgramTestBypass = args.allowDuplicateProgramForTest === true
    && process.env.AI_MOBILE_TEST_ALLOW_DUPLICATE_PROGRAM === "1";
  if (!duplicateProgramTestBypass) {
    const active = listTaskIds()
      .map((taskId) => {
        try { return readTask(taskId); } catch { return null; }
      })
      .filter((task) => task
        && task.workspaceKey === workspaceKey(workspace)
        && isDirectorTask(task)
        && !["cancelled", "completed"].includes(task.state)
        && !["cancelled", "completed"].includes(task.program.state))
      .sort((left, right) => Number(right.contractVersion || 0) - Number(left.contractVersion || 0)
        || String(right.updatedAt || "").localeCompare(String(left.updatedAt || ""))
        || left.taskId.localeCompare(right.taskId));
    if (active.length > 1) {
      throw new Error(`Multiple active Director-CFO programs exist for this workspace: ${active.map((task) => task.taskId).join(", ")}. Cancel the accidental duplicate or pass an explicit taskId to reconcile-task.`);
    }
    if (active.length === 1) {
      const task = active[0];
      const outcomeChanged = outcome !== String(task.outcome || "").trim();
      return {
        mode: PROGRAM_MODE,
        orchestrationStarted: false,
        reused: true,
        requestedOutcomeDiffers: outcomeChanged,
        outcomePreserved: true,
        reconciliationRequired: false,
        taskId: task.taskId,
        programId: task.program.programId,
        intake,
        phase: task.program.phase,
        mission: {
          missionId: task.program.mission?.missionId || null,
          outcome: task.outcome,
        },
        requestedOutcome: outcome,
        sources: {
          authorized: task.program.sourceCatalog?.sources?.length || 0,
          rejected: task.program.sourceCatalog?.rejectedSources || [],
        },
        console: task.currentCodex,
        correctionAction: outcomeChanged
          ? `Only if the user explicitly intended to replace the canonical outcome, call reconcile-task with taskId ${task.taskId}.`
          : null,
        nextAction: task.program.nextAction,
      };
    }
  }
  const requirements = acceptanceRows(args.acceptanceEvidence || args.requirements, outcome);
  const missionId = cleanId(args.missionId || `mission-${hash({ workspace: path.resolve(workspace), outcome, at: utcNow() }, 20)}`, "mission");
  const mission = normalizeMission({
    schemaVersion: PROGRAM_SCHEMA_VERSION,
    missionId,
    revision: 1,
    state: "active",
    outcome,
    requestedOutcome: outcome,
    latestUserRequest: args.userRequest || args.request || outcome,
    authority: args.outcomeAuthority === "project-contract" ? "project-contract" : "user",
    requirements: missionRequirements(requirements),
    successDefinition: requirements.filter((row) => row.required).map((row) => row.description),
    constraints: boundedList(args.constraints, 100, 2000),
  });
  const sourceCatalog = createSourceCatalog({ missionId, ...descriptorInputs(args) });
  const contextContract = createContextScoutWorkPackage({
    mission: { id: missionId, revision: mission.revision, outcome: mission.outcome },
    sourceCatalog,
    workspace,
    refreshDecision: decideContextRefresh({ sourceCatalog, previousDossier: null }),
  });
  const contextPackage = bootstrapPackage("context", contextContract, workspace, frontierRequirementId(requirements));
  const contractState = createProgramState({
    programId: cleanId(args.programId || `program-${hash(missionId, 20)}`, "program"),
    mission,
    state: "active",
    createdAt: utcNow(),
  });
  const record = createTaskRecord({
    workspace,
    outcome,
    requestedOutcome: outcome,
    latestUserRequest: mission.latestUserRequest,
    outcomeAuthority: "user",
    requirements,
    constraints: mission.constraints,
    blockers: [],
    workGraph: [workGraphNode(contextPackage, frontierRequirementId(requirements))],
    currentCodex: {
      model: args.consoleModel || "gpt-5.3-codex-spark",
      effort: args.consoleEffort || "medium",
      reservePercent: Number(args.codexReservePercent || readProfile().codexReservePercent || 15),
      goal: "Report Director-CFO goals, milestones, evidence, blockers, budget, and next action. Own no project implementation files.",
      files: [],
    },
    capacitySnapshot: compactInventory(resources),
  });
  const authorizedPermissions = [...new Set([
    ...DEFAULT_AUTHORIZED_PERMISSIONS,
    ...(args.authorizedPermissions || []),
  ].map((value) => String(value).trim().toLowerCase()).filter(Boolean))];
  const program = {
    schemaVersion: PROGRAM_SCHEMA_VERSION,
    mode: PROGRAM_MODE,
    programId: contractState.programId,
    phase: "context",
    state: "active",
    intake,
    mission,
    contracts: contractState,
    sourceCatalog,
    contextDossier: null,
    masterPlan: null,
    resourceBudget: null,
    activeCampaign: null,
    campaigns: [],
    workPackages: [contextPackage],
    executionReceipts: [],
    failureMemory: [],
    evidenceLedger: { entries: [] },
    reportCursor: {},
    authorizedPermissions,
    contextSourceFingerprints: args.contextSourceFingerprints || {},
    runtime: {
      inventory: compactInventory(resources),
      forecast: null,
      ledger: null,
      budget: null,
      bootstrapFence: {
        missionFingerprint: mission.fingerprint,
        catalogFingerprint: sourceCatalog.catalogFingerprint,
      },
    },
    policy: {
      campaignHours: Math.max(1, Math.min(4, Number(args.campaignHours || 4))),
      noProgressLimit: Math.max(1, Math.min(5, Number(args.noProgressLimit || 2))),
      maxWorkers: Math.max(1, Math.min(20, Number(args.maxWorkers || readProfile().maxGlobalWorkers || 2))),
    },
    nextAction: "Budget and assign the context scout.",
    createdAt: utcNow(),
    updatedAt: utcNow(),
  };
  const task = updateTask(record.taskId, (current) => ({ ...current, program }));
  return {
    mode: PROGRAM_MODE,
    orchestrationStarted: true,
    taskId: task.taskId,
    programId: program.programId,
    intake,
    phase: program.phase,
    mission: { missionId, outcome },
    sources: { authorized: sourceCatalog.sources.length, rejected: sourceCatalog.rejectedSources },
    console: task.currentCodex,
    nextAction: program.nextAction,
  };
}

function reconcileDirectorProgram(taskValue, args = {}) {
  const task = typeof taskValue === "string" ? readTask(taskValue) : taskValue;
  if (!isDirectorTask(task)) throw new Error("Task is not a Director-CFO program.");
  const program = task.program;
  const has = (key) => Object.prototype.hasOwnProperty.call(args, key);
  const latestUserRequest = clip(args.userRequest || args.latestUserRequest || task.latestUserRequest || task.outcome, 10000).trim();
  const outcome = clip(has("outcome") ? args.outcome : task.outcome, 10000).trim();
  const acceptanceChanged = Array.isArray(args.acceptanceEvidence) && args.acceptanceEvidence.length > 0;
  const materialChange = outcome !== task.outcome
    || latestUserRequest !== String(task.latestUserRequest || "").trim()
    || acceptanceChanged
    || has("constraints")
    || Boolean(args.sourceDescriptors)
    || Boolean(args.authorization)
    || has("projectContract")
    || Array.isArray(args.authorizedPermissions);
  if (!materialChange) return task;

  const requirements = acceptanceChanged
    ? acceptanceRows(args.acceptanceEvidence, outcome)
    : task.requirements.map((row) => ({ ...row, evidence: [...(row.evidence || [])] }));
  const mission = normalizeMission({
    schemaVersion: PROGRAM_SCHEMA_VERSION,
    missionId: program.mission.missionId,
    revision: Number(program.mission.revision || 1) + 1,
    state: "active",
    outcome,
    requestedOutcome: outcome,
    latestUserRequest,
    authority: "user",
    requirements: missionRequirements(requirements),
    successDefinition: requirements.filter((row) => row.required).map((row) => row.description),
    constraints: has("constraints") ? boundedList(args.constraints, 100, 2000) : program.mission.constraints,
  });
  const inherited = descriptorsFromCatalog(program.sourceCatalog);
  const catalogArgs = {
    projectContract: has("projectContract") ? args.projectContract : inherited.projectContract,
    sourceDescriptors: args.sourceDescriptors || inherited.sourceDescriptors,
    authorization: args.authorization,
  };
  const sourceCatalog = createSourceCatalog({ missionId: mission.missionId, ...descriptorInputs(catalogArgs) });
  const contextContract = createContextScoutWorkPackage({
    mission: { id: mission.missionId, revision: mission.revision, outcome: mission.outcome },
    sourceCatalog,
    workspace: task.workspace,
    previousDossier: program.contextDossier,
    refreshDecision: decideContextRefresh({
      sourceCatalog,
      previousDossier: program.contextDossier,
      missionRevision: mission.revision,
      forceFull: true,
    }),
  });
  const contextPackage = bootstrapPackage("context", contextContract, task.workspace, frontierRequirementId(requirements));
  const contracts = createProgramState({
    programId: program.programId,
    state: "active",
    mission,
    evidenceLedger: program.contracts?.evidenceLedger,
    reportCursors: program.contracts?.reportCursors || [],
    createdAt: program.createdAt,
    updatedAt: utcNow(),
  });
  const now = utcNow();
  return updateTask(task.taskId, (current) => {
    const prior = current.program;
    const authorizedPermissions = Array.isArray(args.authorizedPermissions)
      ? [...new Set([...DEFAULT_AUTHORIZED_PERMISSIONS, ...args.authorizedPermissions].map((value) => String(value).trim().toLowerCase()).filter(Boolean))]
      : prior.authorizedPermissions;
    current.state = "active";
    current.completedAt = null;
    current.cancelledAt = null;
    current.outcome = outcome;
    current.requestedOutcome = outcome;
    current.latestUserRequest = latestUserRequest;
    current.outcomeAuthority = "user";
    current.outcomeReconciliation = {
      source: "director-cfo-user-correction",
      contractChanged: true,
      previousMissionRevision: prior.mission.revision,
      missionRevision: mission.revision,
      revisedAt: now,
    };
    current.contractVersion = Number(current.contractVersion || 1) + 1;
    current.revisedAt = now;
    current.requirements = requirements;
    current.evidence = requirements.flatMap((requirement) => (requirement.evidence || []).map((evidence) => ({ requirementId: requirement.id, ...evidence }))).slice(-100);
    current.constraints = mission.constraints;
    current.blockers = [];
    current.workGraph = [workGraphNode(contextPackage, frontierRequirementId(requirements))];
    current.program = {
      ...prior,
      phase: "context",
      state: "active",
      mission,
      missionHistory: [...(prior.missionHistory || []), prior.mission].slice(-50),
      sourceCatalog,
      contextHistory: prior.contextDossier ? [...(prior.contextHistory || []), prior.contextDossier].slice(-50) : prior.contextHistory || [],
      contextDossier: null,
      masterPlan: null,
      resourceBudget: null,
      activeCampaign: null,
      contracts,
      authorizedPermissions,
      workPackages: [
        ...(prior.workPackages || []).map((row) => ["pending", "ready", "running", "failed"].includes(row.state) ? { ...row, state: "superseded", supersededAt: now } : row),
        contextPackage,
      ],
      runtime: {
        ...prior.runtime,
        forecast: null,
        ledger: null,
        budget: null,
        bootstrapFence: {
          missionFingerprint: mission.fingerprint,
          catalogFingerprint: sourceCatalog.catalogFingerprint,
        },
      },
      nextAction: "Rebuild authoritative context for the revised mission before creating a new plan or budget.",
      updatedAt: now,
    };
    return current;
  });
}

function isDirectorTask(task) {
  return task?.program?.mode === PROGRAM_MODE;
}

function activeRuntimePackages(program) {
  return (program?.workPackages || []).filter((row) => !["completed", "cancelled", "superseded"].includes(row.state));
}

function tierScore(tier, wanted) {
  const rank = { unknown: 0, efficient: 1, balanced: 2, frontier: 3 };
  const value = rank[String(tier || "unknown").toLowerCase()] || 0;
  if (wanted === "frontier") return value === 3 ? 100 : value === 2 ? 40 : value === 1 ? 5 : 0;
  if (wanted === "efficient") return value === 1 ? 100 : value === 2 ? 70 : value === 3 ? 20 : 0;
  return value === 2 ? 100 : value === 3 ? 75 : value === 1 ? 45 : 0;
}

function estimatedAntigravityQuotaPercent(capabilityTier) {
  if (capabilityTier === "frontier") return 10;
  if (capabilityTier === "balanced") return 5;
  return 2;
}

function routingCandidates(workPackage, ledger, histories = {}) {
  const wanted = workPackage.minimumCapabilityTier || (workPackage.complexity === "large" ? "frontier" : "balanced");
  const preferredProvider = ["codex", "claude", "antigravity"].includes(String(workPackage.preferredProvider || "").trim().toLowerCase())
    ? String(workPackage.preferredProvider).trim().toLowerCase()
    : "";
  const requiresGranularReadOnlyCommand = workPackage.readOnly === true
    && ((workPackage.requiredCapabilities || []).includes("command")
      || (workPackage.requiredPermissions || []).includes("run-command"));
  const rows = [];
  for (const provider of Object.values(ledger.providers || {})) {
    if (!["codex", "claude", "antigravity"].includes(provider.id)) continue;
    if (histories[provider.id]?.cooledDown) continue;
    if (provider.id === "antigravity" && requiresGranularReadOnlyCommand) continue;
    if (provider.availability !== "available" || provider.authentication !== "authenticated" || provider.headless !== "available") continue;
    const models = provider.models?.state === "known" ? provider.models.rows : [];
    if (!models.length) continue;
    for (const model of [...models].sort((left, right) => tierScore(right.capabilityTier, wanted) - tierScore(left.capabilityTier, wanted)).slice(0, 3)) {
      if (wanted === "frontier" && tierScore(model.capabilityTier, wanted) < 40) continue;
      const pools = (provider.quotaPools || [])
        .filter((row) => !(row.modelIds || []).length || row.modelIds.includes(model.id) || row.modelIds.includes(model.displayName))
        .map((row) => row.id)
        .filter(Boolean);
      let quotaDemands = (Array.isArray(workPackage.resourceEstimate?.quotaDemands)
        ? workPackage.resourceEstimate.quotaDemands
        : []).filter((row) => (
        (!row?.provider || String(row.provider).trim() === provider.id)
        && (!row?.poolId || pools.includes(String(row.poolId).trim()))
      ));
      if (provider.id === "antigravity" && pools.length && quotaDemands.length === 0) {
        quotaDemands = pools.map((poolId) => ({
          provider: provider.id,
          poolId,
          percent: estimatedAntigravityQuotaPercent(model.capabilityTier),
          reason: `bounded-${model.capabilityTier || "unknown"}-worker-reservation`,
        }));
      }
      rows.push({
        provider: provider.id,
        model: model.id || model.displayName,
        preferenceRank: preferredProvider && provider.id !== preferredProvider ? 1 : 0,
        preferenceReason: preferredProvider ? `work-package-preferred-provider:${preferredProvider}` : "",
        successProbability: Math.max(0.2, Math.min(0.98, Number(workPackage.successProbability || 0.7) + tierScore(model.capabilityTier, wanted) / 1000)),
        quotaPoolIds: pools,
        allowUnknownQuota: Number(workPackage.timeoutSeconds || workPackage.resourceEstimate?.wallTimeSeconds || 0) > 0
          && Number(workPackage.estimatedDirectTokens || workPackage.resourceEstimate?.tokens || 0) > 0,
        allowUnknownCapacity: Number(workPackage.timeoutSeconds || workPackage.resourceEstimate?.wallTimeSeconds || 0) > 0
          && Number(workPackage.estimatedDirectTokens || workPackage.resourceEstimate?.tokens || 0) > 0,
        quotaDemands,
        maxAttempts: Math.max(1, Number(workPackage.resourceEstimate?.attempts || 1)),
      });
    }
  }
  return rows;
}

function knownPhaseEstimate(tokens, seconds) {
  return {
    tokens,
    wallTimeSeconds: seconds,
    opportunityCostSeconds: Math.ceil(seconds * 0.1),
    ramMb: 256,
    diskMb: 16,
    apiUsd: 0,
    quotaDemands: [],
  };
}

function forecastInput(task, packages) {
  const program = task.program;
  return {
    planId: program.masterPlan?.planFingerprint
      ? `plan-${program.masterPlan.planFingerprint.slice(0, 20)}`
      : `bootstrap-${program.programId}`,
    missionId: program.mission.missionId,
    projectId: task.taskId,
    contextRevision: Number(program.contextDossier?.contextRevision || 1),
    revision: Number(program.masterPlan?.planRevision || 1),
    workPackages: packages,
    resourceEstimates: {
      context: knownPhaseEstimate(12000, 900),
      strategy: knownPhaseEstimate(STRONG_STRATEGY_TOKEN_ESTIMATE, 1200),
      verification: knownPhaseEstimate(8000, 900),
      integration: knownPhaseEstimate(2000, 300),
      reconciliation: knownPhaseEstimate(STRONG_RECONCILIATION_TOKEN_ESTIMATE, 1200),
    },
  };
}

function completedPackageIds(program) {
  return (program.workPackages || []).filter((row) => row.state === "completed").map((row) => row.workPackageId);
}

function readyPackageRows(program) {
  if (program.phase === "awaiting-evidence") {
    return (program.workPackages || []).filter((row) => row.state === "pending" && (row.evidenceRecovery || row.executorKind === "reconciliation"));
  }
  if (["context", "strategy", "reconciliation"].includes(program.phase)) {
    return (program.workPackages || []).filter((row) => row.state === "pending" && (
      program.phase !== "reconciliation" || row.executorKind === "reconciliation"
    ));
  }
  return dependencyReadyPackages(program.workPackages || []);
}

function allocationPermissionGrant(workPackage) {
  return [...new Set((workPackage.permissionGrant || workPackage.requiredPermissions || []).map((value) => String(value).toLowerCase()))];
}

function canonicalPlan(program, dossier) {
  const plan = program.masterPlan;
  const evidenceById = new Map((plan.evidenceRequirements || []).map((row) => [row.id, row]));
  const estimates = new Map((plan.resourceEstimates || []).map((row) => [row.id, row]));
  return normalizeMasterPlan({
    schemaVersion: PROGRAM_SCHEMA_VERSION,
    planId: cleanId(`plan-${plan.planFingerprint || hash(plan)}`, "plan"),
    missionId: program.mission.missionId,
    dossierId: dossier.dossierId,
    revision: plan.planRevision,
    contextRevision: dossier.revision,
    state: "approved",
    objective: plan.objective,
    strategy: plan.objective,
    milestones: (plan.milestones || []).map((row) => ({
      milestoneId: row.id,
      title: row.outcome,
      outcome: row.outcome,
      state: "pending",
      dependsOn: row.dependsOn,
      evidenceCriteria: row.acceptanceCriteria,
      requirementIds: row.evidenceRequirementIds,
    })),
    workstreams: (plan.workstreams || []).map((row) => {
      const estimate = estimates.get(row.resourceEstimateId) || {};
      return {
        workstreamId: row.id,
        title: row.outcome,
        goal: row.outcome,
        state: row.dependsOn?.length ? "pending" : "ready",
        dependsOn: row.dependsOn,
        milestoneIds: row.milestoneIds,
        parallelizable: (row.milestoneIds || []).length > 0,
        capabilities: row.execution?.requiredCapabilities || [],
        permissions: row.execution?.requiredPermissions || [],
        evidenceCriteria: (row.evidenceRequirementIds || []).map((id) => evidenceById.get(id)?.description).filter(Boolean),
        estimatedDemand: {
          tokens: Number(estimate.inputTokens || 0) + Number(estimate.outputTokens || 0),
          durationMinutes: Math.max(1, Math.ceil(Number(estimate.wallClockMinutes || 1))),
          attempts: Math.max(1, Number(estimate.attempts || 1)),
          concurrency: Math.max(1, Number(estimate.concurrency || 1)),
          premiumCalls: /frontier|strong|ultra/i.test(estimate.modelClass || "") ? 1 : 0,
        },
      };
    }),
    timeline: (plan.timeline?.windows || []).map((row, index) => ({
      milestoneId: row.milestoneId,
      sequence: index + 1,
      durationHours: Math.max(0.01, Number(row.durationMinutes || 1) / 60),
    })),
    risks: (plan.risks || []).map((row) => ({
      riskId: row.id,
      description: row.description,
      probability: ["low", "medium", "high"].includes(row.likelihood) ? row.likelihood : "unknown",
      impact: ["low", "medium", "high", "critical"].includes(row.impact) ? row.impact : "unknown",
      mitigation: row.mitigation,
      trigger: row.trigger,
    })),
    assumptions: plan.timeline?.assumptions || [],
    approval: "director-cfo plan assurance passed",
  });
}

function canonicalBudget(program, dossier, plan, budget) {
  const reserveValues = budget.reserves || {};
  const reserveTotal = ["contextTokens", "strategyTokens", "verificationTokens", "reconciliationTokens", "emergencyTokens"]
    .reduce((sum, key) => sum + Number(reserveValues[key] || 0), 0);
  const allocationTokens = (budget.allocations || []).reduce((sum, row) => sum + Number(row.tokenLimit || 0), 0);
  return normalizeResourceBudget({
    schemaVersion: PROGRAM_SCHEMA_VERSION,
    budgetId: cleanId(budget.budgetId || budget.planId, "budget"),
    missionId: program.mission.missionId,
    dossierId: dossier.dossierId,
    planId: plan.planId,
    revision: budget.budgetRevision || 1,
    contextRevision: dossier.revision,
    planRevision: plan.revision,
    state: "active",
    inventoryFingerprint: budget.inventoryFingerprint,
    forecastFingerprint: budget.forecastFingerprint,
    limits: {
      ...budget.limits,
      maxTokens: Math.max(1, Number(budget.limits?.maxTokens || 0), reserveTotal + allocationTokens),
      maxDurationMs: Math.max(1000, Number(budget.limits?.maxDurationMs || 0)),
      maxConcurrentWorkers: Math.max(1, Number(budget.limits?.maxConcurrentWorkers || 1)),
      maxAttempts: Math.max(1, Number(budget.limits?.maxAttempts || budget.allocations?.length || 1)),
    },
    reserves: reserveValues,
    allocations: budget.allocations,
    resetSchedule: budget.resetSchedule || [],
    effectiveAt: utcNow(),
  });
}

function campaignMilestoneIds(packages, plan) {
  const valid = new Set((plan.milestones || []).map((row) => row.milestoneId));
  return [...new Set(packages.flatMap((row) => row.milestoneIds || [row.milestoneId]).filter((id) => valid.has(id)))];
}

function canonicalCampaign(program, dossier, plan, budget, packages, task) {
  const milestones = campaignMilestoneIds(packages, plan);
  const allocationTokens = (budget.allocations || []).reduce((sum, row) => sum + Number(row.tokenLimit || 0), 0);
  const allocationDuration = (budget.allocations || []).reduce((sum, row) => Math.max(sum, Number(row.durationLimitMs || 0)), 0);
  const reserveFloorTokens = Number(budget.reserves?.reconciliationTokens || 0) + Number(budget.reserves?.emergencyTokens || 0);
  return normalizeCampaign({
    schemaVersion: PROGRAM_SCHEMA_VERSION,
    campaignId: cleanId(`campaign-${program.programId}-${program.campaigns.length + 1}`, "campaign"),
    missionId: program.mission.missionId,
    dossierId: dossier.dossierId,
    planId: plan.planId,
    budgetId: budget.budgetId,
    revision: program.campaigns.length + 1,
    contextRevision: dossier.revision,
    planRevision: plan.revision,
    budgetRevision: budget.revision,
    state: "running",
    milestoneIds: milestones,
    workPackageIds: packages.map((row) => row.workPackageId),
    acceptanceTargets: task.requirements.filter((row) => row.required && row.status !== "passing").map((row) => row.description),
    progressSignal: {
      metric: "required-acceptance-passing",
      baseline: task.requirements.filter((row) => row.required && row.status === "passing").length,
      target: task.requirements.filter((row) => row.required).length,
      minimumDelta: 1,
      evidenceLevel: "end-to-end",
    },
    resourceCap: {
      ...budget.limits,
      maxTokens: Math.max(1, allocationTokens + reserveFloorTokens),
      maxDurationMs: Math.max(1000, allocationDuration),
      maxConcurrentWorkers: Math.max(1, packages.length),
      maxAttempts: Math.max(1, packages.length),
    },
    reserveFloorTokens,
    noProgressLimit: program.policy.noProgressLimit,
    cadence: { checkIntervalMs: 60000, backoffMs: 30000, maxBackoffMs: 900000 },
    idempotencyKey: `${program.programId}:${dossier.revision}:${plan.revision}:${budget.revision}:${program.campaigns.length + 1}`,
  });
}

function verificationRows(workPackage) {
  const commands = (workPackage.verificationCommands || []).map((row) => ({
    type: "command",
    instruction: [row.command, ...(row.args || [])].join(" "),
    expected: row.name || "command passes",
  }));
  if (commands.length) return commands;
  const postconditions = (workPackage.postconditions || []).map((row) => ({
    type: "assertion",
    instruction: typeof row === "string" ? row : row.description || row.name || JSON.stringify(row),
    expected: "verified true",
  }));
  if (postconditions.length) return postconditions;
  return (workPackage.acceptanceCriteria || ["The bounded deliverable is verified."]).slice(0, 20).map((value) => ({
    type: "evidence",
    instruction: value,
    expected: "authoritative evidence is attached",
  }));
}

function canonicalWorkPackage(program, dossier, plan, budget, campaign, runtimePackage, allocation, fence) {
  const type = EXECUTOR_TO_TYPE[runtimePackage.executorKind] || "code";
  const deliverableType = DELIVERABLE_TO_CONTRACT[runtimePackage.deliverableKind] || "analysis";
  const milestoneId = runtimePackage.milestoneId || runtimePackage.milestoneIds?.[0];
  const rollback = runtimePackage.rollback ? {
    required: runtimePackage.rollback.required === true || runtimePackage.mutatesExternalState === true,
    instruction: runtimePackage.rollback.instruction || runtimePackage.rollback.description || JSON.stringify(runtimePackage.rollback),
    idempotencyKey: runtimePackage.rollback.idempotencyKey || `rollback-${runtimePackage.sideEffectKey || runtimePackage.workPackageId}`,
  } : null;
  return normalizeWorkPackage({
    schemaVersion: PROGRAM_SCHEMA_VERSION,
    workPackageId: runtimePackage.workPackageId,
    missionId: program.mission.missionId,
    dossierId: dossier.dossierId,
    planId: plan.planId,
    budgetId: budget.budgetId,
    campaignId: campaign.campaignId,
    revision: 1,
    state: "ready",
    type,
    title: String(runtimePackage.title || runtimePackage.goal || "").slice(0, 300),
    goal: String(runtimePackage.goal || "").slice(0, 6000),
    workstreamId: runtimePackage.workstreamId,
    milestoneId,
    dependsOn: runtimePackage.dependencies || [],
    assignee: {
      provider: allocation.provider,
      model: allocation.model,
      role: allocation.role || type,
    },
    requiredCapabilities: runtimePackage.requiredCapabilities || [],
    requiredPermissions: runtimePackage.requiredPermissions || [],
    requiredTools: runtimePackage.commands?.length ? ["structured-command"] : [],
    contextRefs: runtimePackage.relevantFiles || [],
    deliverable: {
      type: deliverableType,
      required: true,
      artifactPaths: runtimePackage.expectedFiles || [],
      description: runtimePackage.deliverableKind,
    },
    acceptanceCriteria: runtimePackage.acceptanceCriteria || [],
    verification: verificationRows(runtimePackage),
    rollback,
    idempotencyKey: ["operation", "browser", "external", "data"].includes(type)
      ? runtimePackage.sideEffectKey || `effect-${runtimePackage.workPackageId}`
      : "",
    limits: {
      maxTokens: Math.max(0, Number(allocation.tokenLimit || 0)),
      maxDurationMs: Math.max(0, Number(allocation.durationLimitMs || 0)),
      maxConcurrentWorkers: 1,
      maxAttempts: Math.max(1, Number(allocation.maxAttempts || 1)),
      maxDiskBytes: 0,
      maxRamMb: 0,
    },
    revisionFence: fence,
  });
}

function buildCanonicalState(task, program, selectedPackages, budget) {
  const dossier = adaptProgramContextDossier(program);
  if (dossier.state !== "ready") throw new Error("context-dossier-incomplete: required authorized sources were unavailable or uncited");
  const plan = canonicalPlan(program, dossier);
  const resourceBudget = canonicalBudget(program, dossier, plan, budget);
  const campaign = canonicalCampaign(program, dossier, plan, resourceBudget, selectedPackages, task);
  const records = { mission: program.mission, contextDossier: dossier, masterPlan: plan, resourceBudget, campaign };
  const fence = createRevisionFence(records, "dispatch");
  const packages = selectedPackages.map((runtimePackage) => {
    const allocation = budget.allocations.find((row) => row.workPackageId === runtimePackage.workPackageId);
    return canonicalWorkPackage(program, dossier, plan, resourceBudget, campaign, runtimePackage, allocation, fence);
  });
  const state = createProgramState({
    programId: program.programId,
    state: "active",
    mission: program.mission,
    contextDossier: dossier,
    masterPlan: plan,
    resourceBudget,
    campaign,
    workPackages: packages,
    evidenceLedger: program.contracts?.evidenceLedger,
    reportCursors: program.contracts?.reportCursors || [],
    createdAt: program.createdAt,
    updatedAt: utcNow(),
  });
  return { state, fence, dossier, plan, resourceBudget, campaign, packages };
}

function refreshPendingContextBootstrap(task) {
  if (!isDirectorTask(task) || task.program.phase !== "context") return task;
  const currentPackage = (task.program.workPackages || []).find((row) => row.executorKind === "context-scout" && row.state === "pending");
  if (!currentPackage) return task;
  const previousContext = currentPackage.bootstrapContract?.previousContext;
  const contextContract = createContextScoutWorkPackage({
    mission: { id: task.program.mission.missionId, revision: task.program.mission.revision, outcome: task.program.mission.outcome },
    sourceCatalog: task.program.sourceCatalog,
    workspace: task.workspace,
    previousDossier: previousContext ? { contextRevision: previousContext.revision, contextFingerprint: previousContext.fingerprint } : task.program.contextDossier,
    refreshDecision: currentPackage.bootstrapContract?.refresh,
  });
  if (currentPackage.bootstrapContract?.contractFingerprint === contextContract.contractFingerprint) return task;
  const refreshedBase = bootstrapPackage("context", contextContract, task.workspace, frontierRequirementId(task.requirements));
  const retryPatch = currentPackage.reconciledContract || {};
  const refreshed = {
    ...refreshedBase,
    ...retryPatch,
    workPackageId: currentPackage.workPackageId,
    state: "pending",
    executorKind: "context-scout",
    deliverableKind: "context-dossier",
    readOnly: true,
    mutatesExternalState: false,
    prompt: refreshedBase.prompt,
    relevantFiles: [...new Set([...(refreshedBase.relevantFiles || []), ...(retryPatch.relevantFiles || [])])],
    requiredCapabilities: [...new Set([...(refreshedBase.requiredCapabilities || []), ...(retryPatch.requiredCapabilities || [])])],
    requiredPermissions: [...new Set([...(refreshedBase.requiredPermissions || []), ...(retryPatch.requiredPermissions || [])])],
    permissionGrant: [...new Set([...(refreshedBase.permissionGrant || []), ...(retryPatch.permissionGrant || [])])],
    bootstrapContract: refreshedBase.bootstrapContract,
    databaseObservation: refreshedBase.databaseObservation,
    reconciledContract: retryPatch,
    requestedReconciliationPatch: currentPackage.requestedReconciliationPatch,
    reconciliationAdjustments: currentPackage.reconciliationAdjustments,
    retryOfWorkPackageId: currentPackage.retryOfWorkPackageId,
    reconciliationWorkPackageId: currentPackage.reconciliationWorkPackageId,
    reconciliationDecisionFingerprint: currentPackage.reconciliationDecisionFingerprint,
    allocation: null,
    permissionPreflight: null,
    revisionFence: null,
    canonicalContract: null,
  };
  return updateTask(task.taskId, (current) => {
    current.program = {
      ...current.program,
      workPackages: current.program.workPackages.map((row) => row.workPackageId === currentPackage.workPackageId ? refreshed : row),
      runtime: {
        ...current.program.runtime,
        bootstrapFence: {
          ...current.program.runtime?.bootstrapFence,
          missionFingerprint: current.program.mission.fingerprint,
          catalogFingerprint: current.program.sourceCatalog.catalogFingerprint,
          sourceSnapshotFingerprint: contextContract.sourceSnapshotManifest?.fingerprint || "",
        },
      },
      updatedAt: utcNow(),
    };
    current.workGraph = current.workGraph.map((node) => node.id === currentPackage.workPackageId ? workGraphNode(refreshed, frontierRequirementId(current.requirements)) : node);
    return current;
  });
}

function refreshPendingStrategyBootstrap(task) {
  if (!isDirectorTask(task) || task.program.phase !== "strategy" || !task.program.contextDossier) return task;
  const currentPackage = (task.program.workPackages || []).find((row) => row.executorKind === "strategist" && row.state === "pending");
  if (!currentPackage) return task;
  const directive = currentPackage.reconciliationDirective || task.program.pendingPlanDirective || null;
  const strategyContract = createStrategyWorkPackage({
    mission: {
      id: task.program.mission.missionId,
      revision: task.program.mission.revision,
      outcome: task.program.mission.outcome,
    },
    contextDossier: task.program.contextDossier,
    requirements: task.requirements,
    availableSourceFiles: availableProjectFiles(task.workspace, task.program.sourceCatalog),
    ...(directive ? {
      minimumPlanRevision: directive.minimumPlanRevision,
      reconciliationDirective: directive,
    } : {}),
  });
  if (currentPackage.bootstrapContract?.contractFingerprint === strategyContract.contractFingerprint) return task;
  const refreshedBase = bootstrapPackage("strategy", strategyContract, task.workspace, frontierRequirementId(task.requirements));
  const refreshedCandidate = directive
    ? safeStrategyRetryPackage(task, refreshedBase, directive)
    : refreshedBase;
  const refreshed = {
    ...refreshedCandidate,
    workPackageId: currentPackage.workPackageId,
    state: "pending",
    retryOfWorkPackageId: currentPackage.retryOfWorkPackageId || refreshedCandidate.retryOfWorkPackageId || "",
    reconciliationWorkPackageId: currentPackage.reconciliationWorkPackageId || refreshedCandidate.reconciliationWorkPackageId || "",
    reconciliationDecisionFingerprint: currentPackage.reconciliationDecisionFingerprint || refreshedCandidate.reconciliationDecisionFingerprint || "",
    allocation: null,
    permissionPreflight: null,
    revisionFence: null,
    canonicalContract: null,
  };
  return updateTask(task.taskId, (current) => {
    current.program = {
      ...current.program,
      workPackages: current.program.workPackages.map((row) => row.workPackageId === currentPackage.workPackageId ? refreshed : row),
      updatedAt: utcNow(),
    };
    current.workGraph = current.workGraph.map((node) => node.id === currentPackage.workPackageId
      ? workGraphNode(refreshed, frontierRequirementId(current.requirements))
      : node);
    return current;
  });
}

function refreshRuntimeCapabilityAliases(task) {
  if (!isDirectorTask(task)) return task;
  let changed = false;
  const changedIds = new Set();
  const planWorkstreams = new Map((task.program.masterPlan?.workstreams || []).map((row) => [row.id, row]));
  const workPackages = (task.program.workPackages || []).map((row) => {
    if (!["pending", "ready"].includes(row.state)) return row;
    const current = boundedList(row.requiredCapabilities, 30, 120);
    const migrated = [...new Set(current.map((value) => canonicalCapabilityName(value) || value))];
    const planWorkstream = planWorkstreams.get(row.workstreamId);
    const planExecution = planWorkstream?.execution || {};
    const migratedExternalState = planWorkstream
      ? row.executorKind === "external-transaction" || planExecution.mutatesExternalState === true
      : row.mutatesExternalState === true;
    if (JSON.stringify(current) === JSON.stringify(migrated) && row.mutatesExternalState === migratedExternalState) return row;
    changed = true;
    changedIds.add(row.workPackageId);
    return {
      ...row,
      requiredCapabilities: migrated,
      mutatesExternalState: migratedExternalState,
      state: "pending",
      allocation: null,
      permissionPreflight: null,
      revisionFence: null,
      canonicalContract: null,
    };
  });
  if (!changed) return task;
  return updateTask(task.taskId, (current) => {
    const byId = new Map(workPackages.map((row) => [row.workPackageId, row]));
    current.program = {
      ...current.program,
      workPackages: current.program.workPackages.map((row) => byId.get(row.workPackageId) || row),
      runtime: {
        ...current.program.runtime,
        capabilityAliasMigration: {
          schemaVersion: 1,
          migratedAt: utcNow(),
          reason: "non-callable capability aliases and local/external mutation semantics normalized",
        },
      },
      updatedAt: utcNow(),
    };
    current.workGraph = (current.workGraph || []).map((node) => {
      const migrated = changedIds.has(node.id) ? byId.get(node.id) : null;
      return migrated ? { ...node, state: "pending", owner: null } : node;
    });
    return current;
  });
}

function prepareProgramDispatch(taskValue, resources = {}, histories = {}) {
  let task = typeof taskValue === "string" ? readTask(taskValue) : taskValue;
  if (!isDirectorTask(task)) return task;
  task = refreshPendingContextBootstrap(task);
  task = refreshPendingStrategyBootstrap(task);
  task = refreshRuntimeCapabilityAliases(task);
  const program = task.program;
  const alreadyReady = (program.workPackages || []).filter((row) => row.state === "ready" && row.allocation);
  if (alreadyReady.length) return task;
  const ready = readyPackageRows(program);
  if (!ready.length) return task;

  const profile = readProfile();
  const reservePolicy = normalizeReservePolicy({
    codexReservePercent: task.currentCodex?.reservePercent || profile.codexReservePercent,
  }, profile);
  const ledger = buildResourceLedger(resources, {
    profile,
    reservePolicy,
    activeReservations: resourceLeaseSnapshot().active,
    maxGlobalConcurrency: Math.min(program.policy.maxWorkers, profile.maxGlobalWorkers),
  });
  const allPackages = activeRuntimePackages(program).map((row) => ({
    ...row,
    projectId: task.taskId,
    milestoneId: row.milestoneId || row.milestoneIds?.[0] || "",
    dependsOn: row.dependencies || row.dependsOn || [],
    candidates: routingCandidates(row, ledger, histories),
  }));
  const forecast = forecastPlanDemand(forecastInput(task, allPackages), { generatedAt: resources.generatedAt || utcNow() });
  const readyIds = new Set(ready.map((row) => row.workPackageId));
  const completedIds = completedPackageIds(program);
  const budget = selectConcurrentBundle({
    forecast,
    ledger,
    items: forecast.items.filter((row) => row.synthetic || readyIds.has(row.workPackageId)),
    authorizedPermissions: program.authorizedPermissions,
    completedWorkPackageIds: completedIds,
    budgetId: cleanId(`budget-${program.programId}-${(program.campaigns || []).length + 1}`, "budget"),
    budgetRevision: (program.campaigns || []).length + 1,
    missionId: program.mission.missionId,
    dossierId: program.contracts?.contextDossier?.dossierId || cleanId(`dossier-${program.programId}`, "dossier"),
    state: program.masterPlan ? "active" : "draft",
  });
  const accountedIds = new Set([
    ...(budget.allocations || []).map((row) => row.workPackageId),
    ...(budget.deferred || []).map((row) => row.workPackageId),
  ]);
  const completedIdSet = new Set(completedIds);
  budget.deferred = [
    ...(budget.deferred || []),
    ...forecast.items.filter((row) => !row.synthetic && !accountedIds.has(row.workPackageId)).map((row) => {
      const incomplete = (row.dependsOn || []).filter((dependencyId) => !completedIdSet.has(dependencyId));
      return {
        workPackageId: row.workPackageId,
        projectId: row.projectId,
        reasons: incomplete.length
          ? [`dependencies-not-complete:${incomplete.join(",")}`]
          : [`not-dispatchable-in-current-program-phase:${program.phase}`],
      };
    }),
  ];

  const prepared = [];
  const preflightFailures = [];
  for (const allocation of budget.allocations || []) {
    const runtimePackage = ready.find((row) => row.workPackageId === allocation.workPackageId);
    if (!runtimePackage) continue;
    const permissionGrant = allocationPermissionGrant(runtimePackage);
    const preflight = preflightAllocation({
      workPackage: runtimePackage,
      allocation: { ...allocation, permissionGrant },
      provider: resources.providers?.[allocation.provider] || {},
      authorizedPermissions: program.authorizedPermissions,
    });
    if (!preflight.ok) {
      preflightFailures.push({ workPackageId: runtimePackage.workPackageId, reasons: [preflight.blocker], failureClass: preflight.failureClass });
      continue;
    }
    prepared.push({
      ...runtimePackage,
      projectId: task.taskId,
      milestoneId: runtimePackage.milestoneId || runtimePackage.milestoneIds?.[0] || "",
      state: "ready",
      allocation,
      preferredProvider: allocation.provider,
      model: allocation.model,
      permissionGrant,
      permissionPreflight: preflight,
      budgetRevision: budget.budgetRevision,
    });
  }
  const preparedIds = new Set(prepared.map((row) => row.workPackageId));
  budget.allocations = (budget.allocations || []).filter((row) => preparedIds.has(row.workPackageId));
  budget.deferred = [...(budget.deferred || []), ...preflightFailures];

  let canonical = null;
  if (prepared.length && program.masterPlan) canonical = buildCanonicalState(task, program, prepared, budget);
  const runtimeCampaign = prepared.length
    ? startCampaign(createCampaign({
        campaignId: canonical?.campaign.campaignId,
        missionId: program.mission.missionId,
        epoch: (program.campaigns || []).length + 1,
        revisions: {
          context: Number(program.contextDossier?.contextRevision || 0),
          plan: Number(program.masterPlan?.planRevision || 0),
          budget: Number(budget.budgetRevision || 0),
          campaign: (program.campaigns || []).length + 1,
        },
        milestoneIds: prepared.flatMap((row) => row.milestoneIds || [row.milestoneId]).filter(Boolean),
        allocationIds: budget.allocations.map((row) => row.allocationId),
        evidence: task.evidence,
        maxHours: program.policy.campaignHours,
        maxWorkers: program.policy.maxWorkers,
        noProgressLimit: program.policy.noProgressLimit,
      }))
    : null;

  return updateTask(task.taskId, (current) => {
    const currentProgram = current.program;
    const byId = new Map(prepared.map((row) => [row.workPackageId, row]));
    const workPackages = (currentProgram.workPackages || []).map((row) => {
      const selected = byId.get(row.workPackageId);
      if (!selected) return row;
      const canonicalPackage = canonical?.packages.find((item) => item.workPackageId === row.workPackageId);
      return { ...selected, revisionFence: canonicalPackage?.revisionFence || null, canonicalContract: canonicalPackage || null };
    });
    current.program = {
      ...currentProgram,
      contracts: canonical?.state || currentProgram.contracts,
      resourceBudget: canonical?.resourceBudget || budget,
      activeCampaign: runtimeCampaign,
      campaigns: runtimeCampaign ? [...(currentProgram.campaigns || []), runtimeCampaign] : currentProgram.campaigns || [],
      contractHistory: canonical ? [...(currentProgram.contractHistory || []), {
        campaignId: canonical.campaign.campaignId,
        fingerprint: canonical.state.fingerprint,
        recordedAt: utcNow(),
      }].slice(-100) : currentProgram.contractHistory || [],
      workPackages,
      runtime: {
        ...currentProgram.runtime,
        inventory: compactInventory(resources),
        ledger,
        forecast,
        budget,
      },
      phase: prepared.length ? currentProgram.phase : currentProgram.phase,
      nextAction: prepared.length
        ? `Dispatch ${prepared.length} budgeted dependency-ready work package(s).`
        : `No package passed the current budget and permission gates: ${budget.deferred.map((row) => `${row.workPackageId}: ${(row.reasons || []).join(", ")}`).join(" | ")}`,
      updatedAt: utcNow(),
    };
    current.capacitySnapshot = compactInventory(resources);
    current.workGraph = (current.workGraph || []).map((node) => {
      const selected = byId.get(node.id);
      return selected ? { ...node, state: "pending", owner: null } : node;
    });
    return current;
  });
}

function programRecommendedWorkUnits(task) {
  if (!isDirectorTask(task)) return [];
  return (task.program.workPackages || []).filter((row) => row.state === "ready" && row.allocation).map((row) => ({
    ...row,
    workGraphNodeId: row.workPackageId,
    independenceReason: "The Director-CFO selected this dependency-ready package from the plan-wide budget.",
    workPlaneRequired: true,
    readOnly: row.deliverableKind !== "patch" && row.executorKind !== "operational-transaction",
    localFileAccess: row.deliverableKind === "patch" || row.executorKind === "operational-transaction"
      ? "bounded-write"
      : "read-only",
    effectKind: row.mutatesExternalState === true || ["operational-transaction", "external-transaction"].includes(row.executorKind)
      ? row.executorKind : "",
    artifactKind: row.deliverableKind,
    selectionAuthority: "router",
    allowPremiumModel: row.minimumCapabilityTier === "frontier",
    directorBudgetAuthority: true,
    integrationAction: `Integrate only against revision fence ${row.revisionFence?.fingerprint || "bootstrap"}.`,
    directorProgram: {
      programId: task.program.programId,
      workPackageId: row.workPackageId,
      phase: task.program.phase,
      revisionFence: row.revisionFence || null,
    },
  }));
}

function programJobContract(task, unit) {
  if (!isDirectorTask(task) || !unit?.directorProgram) return {};
  const expected = unit.directorProgram.revisionFence ? { revisionFence: unit.directorProgram.revisionFence } : {};
  const workPackage = selectDirectorPackage(task.program.workPackages, unit.directorProgram.workPackageId, expected);
  if (workPackage.state !== "ready") throw new Error(`Director work package is not dispatch-ready: ${workPackage.workPackageId}.`);
  const directorWorkerContract = createDirectorWorkerContract(workPackage);
  return {
    executorKind: workPackage.executorKind,
    deliverableKind: workPackage.deliverableKind,
    artifactKind: workPackage.deliverableKind,
    requiredCapabilities: workPackage.requiredCapabilities || [],
    requiredPermissions: workPackage.requiredPermissions || [],
    permissionGrant: workPackage.permissionGrant,
    permissionPreflight: workPackage.permissionPreflight,
    resourceEstimate: workPackage.resourceEstimate || null,
    acceptanceIds: workPackage.acceptanceIds || [],
    evidenceRequirementIds: workPackage.evidenceRequirementIds || workPackage.planEvidenceRequirementIds || [],
    evidenceRequirements: workPackage.evidenceRequirements || [],
    acceptanceCriteria: workPackage.acceptanceCriteria || [],
    allocation: workPackage.allocation || null,
    commands: workPackage.commands || [],
    preconditions: workPackage.preconditions || [],
    postconditions: workPackage.postconditions || [],
    rollback: workPackage.rollback || null,
    recoveryAction: workPackage.recoveryAction || "",
    mutatesExternalState: workPackage.mutatesExternalState === true,
    sideEffectKey: workPackage.sideEffectKey || "",
    observedStateFingerprint: workPackage.observedStateFingerprint || "",
    userAuthorizationRef: workPackage.userAuthorizationRef || "",
    directorProgram: unit.directorProgram,
    directorWorkerContract,
    revisionFence: workPackage.revisionFence || null,
  };
}

function appendProgramEvidence(program, entry) {
  return {
    ...(program.evidenceLedger || {}),
    entries: [...(program.evidenceLedger?.entries || []), entry].slice(-1000),
  };
}

function sourceCoverageBlocker(dossier, catalog) {
  const required = new Set(blockingContextSourceIds(catalog));
  const unavailable = (dossier.sourceObservations || []).filter((row) => required.has(row.sourceId) && row.status === "unavailable");
  return unavailable.length ? `Required context sources unavailable: ${unavailable.map((row) => row.sourceId).join(", ")}` : "";
}

function blockingContextSourceIds(catalog) {
  return (catalog?.sources || [])
    .filter((row) => row.required && BLOCKING_CONTEXT_SOURCE_TYPES.has(row.type))
    .map((row) => row.id);
}

function adaptProgramContextDossier(program, dossier = program.contextDossier) {
  return adaptContextDossierV1(dossier, {
    missionId: program.mission.missionId,
    requiredSourceIds: blockingContextSourceIds(program.sourceCatalog),
  });
}

function contextFreshnessScope(program, bootstrapContract) {
  return hash({
    missionFingerprint: program.mission.fingerprint,
    catalogFingerprint: program.sourceCatalog.catalogFingerprint,
    previousContextFingerprint: bootstrapContract.previousContext?.fingerprint || "",
  });
}

function scheduleContextSnapshotRecovery(task, workPackage, bootstrapContract, freshness, integrationExpectation = {}) {
  const program = task.program;
  const scopeFingerprint = contextFreshnessScope(program, bootstrapContract);
  const previous = program.runtime?.contextFreshness;
  const priorRefreshes = previous?.scopeFingerprint === scopeFingerprint
    ? Number(previous.postWorkerRefreshCount || 0)
    : 0;
  const checkedAt = utcNow();
  const blocker = `context-static-snapshot-stale:${freshness.changedSourceIds.join(",")}`;
  if (priorRefreshes >= 1) {
    const updated = updateTask(task.taskId, (current) => {
      assertDirectorIntegrationReady(current, workPackage.workPackageId, integrationExpectation);
      current.program = {
        ...current.program,
        phase: "blocked",
        state: "blocked",
        workPackages: current.program.workPackages.map((row) => sameDirectorPackage(row, workPackage)
          ? { ...row, state: "failed", blocker: "context-snapshot-unstable", completedAt: checkedAt }
          : row),
        runtime: {
          ...current.program.runtime,
          contextFreshness: {
            scopeFingerprint,
            postWorkerRefreshCount: priorRefreshes,
            instabilityCount: Number(previous?.instabilityCount || 0) + 1,
            changedSourceIds: freshness.changedSourceIds,
            staleJobId: integrationExpectation.jobId || "",
            checkedAt,
            stateFingerprint: freshness.stateFingerprint,
          },
        },
        nextAction: "context-snapshot-unstable: static project sources changed during two consecutive context-worker attempts.",
        updatedAt: checkedAt,
      };
      current.workGraph = current.workGraph.map((node) => node.id === workPackage.workPackageId
        ? { ...node, state: "blocked", owner: null, lastFailure: "context-snapshot-unstable" }
        : node);
      return current;
    });
    return {
      blocked: true,
      refreshScheduled: false,
      blocker: updated.program.nextAction,
      scopeFingerprint,
      changedSourceIds: freshness.changedSourceIds,
    };
  }

  const refreshDecision = {
    schemaVersion: "director-cfo/context-refresh-decision@1",
    mode: "incremental",
    refreshRequired: true,
    reasonCodes: ["post-worker-static-source-changed"],
    changedSourceIds: freshness.changedSourceIds,
  };
  const previousContext = bootstrapContract.previousContext;
  const contextContract = createContextScoutWorkPackage({
    mission: { id: program.mission.missionId, revision: program.mission.revision, outcome: program.mission.outcome },
    sourceCatalog: program.sourceCatalog,
    workspace: task.workspace,
    previousDossier: previousContext
      ? { contextRevision: previousContext.revision, contextFingerprint: previousContext.fingerprint }
      : program.contextDossier,
    refreshDecision,
    sourceSnapshotManifest: freshness.currentManifest,
  });
  const replacement = bootstrapPackage("context", contextContract, task.workspace, frontierRequirementId(task.requirements));
  replacement.workPackageId = `${replacement.workPackageId}-snapshot-refresh-1-${freshness.stateFingerprint.slice(0, 8)}`;
  replacement.contextFreshnessScope = scopeFingerprint;
  const updated = updateTask(task.taskId, (current) => {
    assertDirectorIntegrationReady(current, workPackage.workPackageId, integrationExpectation);
    current.program = {
      ...current.program,
      phase: "context",
      state: "active",
      masterPlan: null,
      resourceBudget: null,
      workPackages: [
        ...current.program.workPackages.map((row) => sameDirectorPackage(row, workPackage)
          ? { ...row, state: "superseded", blocker, completedAt: checkedAt }
          : row),
        replacement,
      ],
      activeCampaign: null,
      runtime: {
        ...current.program.runtime,
        forecast: null,
        ledger: null,
        budget: null,
        bootstrapFence: {
          ...current.program.runtime?.bootstrapFence,
          missionFingerprint: current.program.mission.fingerprint,
          catalogFingerprint: current.program.sourceCatalog.catalogFingerprint,
          sourceSnapshotFingerprint: contextContract.sourceSnapshotManifest?.fingerprint || "",
        },
        contextFreshness: {
          scopeFingerprint,
          postWorkerRefreshCount: 1,
          instabilityCount: 0,
          changedSourceIds: freshness.changedSourceIds,
          staleJobId: integrationExpectation.jobId || "",
          checkedAt,
          stateFingerprint: freshness.stateFingerprint,
          refreshWorkPackageId: replacement.workPackageId,
        },
      },
      nextAction: "Static project context changed during the worker run; one fresh immutable context snapshot is queued automatically.",
      updatedAt: checkedAt,
    };
    const replacementNode = workGraphNode(replacement, frontierRequirementId(current.requirements));
    current.workGraph = current.workGraph.some((node) => node.id === workPackage.workPackageId)
      ? current.workGraph.map((node) => node.id === workPackage.workPackageId ? replacementNode : node)
      : [...current.workGraph, replacementNode];
    return current;
  });
  return {
    blocked: false,
    refreshScheduled: true,
    blocker,
    scopeFingerprint,
    changedSourceIds: freshness.changedSourceIds,
    refreshWorkPackageId: updated.program.runtime.contextFreshness.refreshWorkPackageId,
  };
}

function integrateContextArtifact(task, workPackage, artifact, jobId, integrationExpectation = {}) {
  const program = task.program;
  if (program.runtime.bootstrapFence?.missionFingerprint !== program.mission.fingerprint
    || program.runtime.bootstrapFence?.catalogFingerprint !== program.sourceCatalog.catalogFingerprint) {
    throw new Error("stale-context-bootstrap-fence");
  }
  if (workPackage.bootstrapContract?.sourceCatalog?.catalogFingerprint !== program.sourceCatalog.catalogFingerprint) {
    throw new Error("stale-context-snapshot-catalog");
  }
  const dossier = normalizeContextScoutArtifact(artifact, workPackage.bootstrapContract, {
    databaseObservationReceipts: workPackage.contextObservationReceiptExpectations || {},
  });
  const coverageBlocker = sourceCoverageBlocker(dossier, program.sourceCatalog);
  if (coverageBlocker) {
    return updateTask(task.taskId, (current) => {
      assertDirectorIntegrationReady(current, workPackage.workPackageId, integrationExpectation);
      current.program = {
        ...current.program,
        phase: "blocked",
        state: "blocked",
        contextDossier: dossier,
        workPackages: current.program.workPackages.map((row) => row.workPackageId === workPackage.workPackageId
          ? { ...row, bootstrapContract: workPackage.bootstrapContract, state: "failed", blocker: coverageBlocker }
          : row),
        nextAction: coverageBlocker,
        updatedAt: utcNow(),
      };
      current.workGraph = current.workGraph.map((node) => node.id === workPackage.workPackageId ? { ...node, state: "blocked", owner: null, lastFailure: coverageBlocker } : node);
      return current;
    });
  }
  const canonicalDossier = adaptProgramContextDossier(program, dossier);
  const pendingPlanDirective = program.pendingPlanDirective || null;
  const strategyContract = createStrategyWorkPackage({
    mission: { id: program.mission.missionId, revision: program.mission.revision, outcome: program.mission.outcome },
    contextDossier: dossier,
    requirements: task.requirements,
    availableSourceFiles: availableProjectFiles(task.workspace, program.sourceCatalog),
    ...(pendingPlanDirective ? {
      minimumPlanRevision: pendingPlanDirective.minimumPlanRevision,
      reconciliationDirective: pendingPlanDirective,
    } : {}),
  });
  const baseStrategyPackage = bootstrapPackage("strategy", strategyContract, task.workspace, frontierRequirementId(task.requirements));
  const strategyPackage = pendingPlanDirective
    ? safeStrategyRetryPackage(task, baseStrategyPackage, pendingPlanDirective)
    : baseStrategyPackage;
  return updateTask(task.taskId, (current) => {
    assertDirectorIntegrationReady(current, workPackage.workPackageId, integrationExpectation);
    const now = utcNow();
    const evidence = {
      requirementId: frontierRequirementId(task.requirements),
      level: "activity",
      ref: `director-context:${jobId || workPackage.workPackageId}:${dossier.contextFingerprint}`,
      summary: "Authorized project sources were consolidated into a cited durable context dossier.",
      passed: false,
      verifiedAt: now,
    };
    current.program = {
      ...current.program,
      phase: "strategy",
      state: "active",
      contextDossier: dossier,
      pendingPlanDirective: null,
      contracts: createProgramState({
        programId: current.program.programId,
        state: "active",
        mission: current.program.mission,
        contextDossier: canonicalDossier,
        evidenceLedger: current.program.contracts?.evidenceLedger,
        createdAt: current.program.createdAt,
        updatedAt: now,
      }),
      workPackages: [
        ...current.program.workPackages.map((row) => row.workPackageId === workPackage.workPackageId
          ? { ...row, bootstrapContract: workPackage.bootstrapContract, state: "completed", completedAt: now }
          : row),
        strategyPackage,
      ],
      evidenceLedger: appendProgramEvidence(current.program, evidence),
      activeCampaign: null,
      runtime: {
        ...current.program.runtime,
        bootstrapFence: {
          missionFingerprint: current.program.mission.fingerprint,
          catalogFingerprint: current.program.sourceCatalog.catalogFingerprint,
          contextFingerprint: dossier.contextFingerprint,
        },
      },
      nextAction: "Budget and assign a strong strategist against the durable context dossier.",
      updatedAt: now,
    };
    current.evidence = [...(current.evidence || []), evidence].slice(-50);
    current.workGraph = [
      ...current.workGraph.map((node) => node.id === workPackage.workPackageId ? { ...node, state: "completed", owner: null, evidenceRefs: [...(node.evidenceRefs || []), evidence.ref] } : node),
      workGraphNode(strategyPackage, frontierRequirementId(current.requirements)),
    ];
    return current;
  });
}

function linkPackagesToRequirements(packages, task, plan) {
  const unresolved = task.requirements.filter((row) => row.required && row.status !== "passing");
  const unresolvedById = new Map(unresolved.map((row) => [row.id, row]));
  const evidence = new Map((plan.evidenceRequirements || []).map((row) => [row.id, row]));
  return packages.map((workPackage) => {
    const evidenceRequirementIds = workPackage.evidenceRequirementIds?.length
      ? workPackage.evidenceRequirementIds
      : (workPackage.acceptanceIds || []).filter((id) => evidence.has(id));
    const planEvidence = evidenceRequirementIds.map((id) => evidence.get(id)).filter(Boolean);
    const selectedIds = [...new Set([
      ...(workPackage.acceptanceIds || []).filter((id) => unresolvedById.has(id)),
      ...planEvidence.flatMap((row) => row.acceptanceRequirementIds || []),
    ])];
    const selected = selectedIds.map((id) => unresolvedById.get(id)).filter(Boolean);
    if (!selected.length) throw new Error(`master-plan-assurance-failed: work package ${workPackage.workPackageId} has no exact unresolved acceptance requirement link`);
    return {
      ...workPackage,
      evidenceRequirementIds,
      planEvidenceRequirementIds: evidenceRequirementIds,
      acceptanceIds: selected.map((row) => row.id),
      acceptanceCriteria: [...new Set([...selected.map((row) => row.description), ...planEvidence.map((row) => row.description)])],
    };
  });
}

function advancePlanState(plan, runtimePackages) {
  if (!plan) return plan;
  const packages = runtimePackages || [];
  const workstreams = (plan.workstreams || []).map((row) => {
    const owned = packages.filter((item) => item.workstreamId === row.id);
    const states = owned.map((item) => item.state);
    const state = owned.length && states.every((value) => value === "completed")
      ? "completed"
      : states.some((value) => value === "running")
        ? "running"
        : states.some((value) => ["failed", "blocked"].includes(value))
          ? "blocked"
          : states.some((value) => value === "ready")
            ? "ready"
            : row.state || "pending";
    return { ...row, state };
  });
  const byId = new Map(workstreams.map((row) => [row.id, row]));
  const milestones = (plan.milestones || []).map((row) => {
    const owned = (row.workstreamIds || []).map((id) => byId.get(id)).filter(Boolean);
    const state = owned.length && owned.every((item) => item.state === "completed")
      ? "completed"
      : owned.some((item) => item.state === "running")
        ? "running"
        : owned.some((item) => item.state === "blocked")
          ? "blocked"
          : row.state || "pending";
    return { ...row, state };
  });
  return { ...plan, workstreams, milestones };
}

function integratePlanArtifact(task, workPackage, artifact, jobId, integrationExpectation = {}) {
  const program = task.program;
  const assessment = assessMasterPlan(artifact, {
    missionId: program.mission.missionId,
    missionRevision: program.mission.revision,
    contextRevision: program.contextDossier.contextRevision,
    contextFingerprint: program.contextDossier.contextFingerprint,
    authoritativeRequirements: task.requirements,
    availableSourceFiles: availableProjectFiles(task.workspace, program.sourceCatalog),
    minimumPlanRevision: workPackage.bootstrapContract?.minimumPlanRevision || 1,
  });
  if (!assessment.valid) {
    const error = new Error(`master-plan-assurance-failed: ${assessment.errors.join(" | ")}`);
    error.assurance = assessment;
    throw error;
  }
  const rawPackages = planWorkPackages({
    masterPlan: assessment.plan,
    mission: { id: program.mission.missionId, missionId: program.mission.missionId },
    contextDossier: program.contextDossier,
  });
  const packages = linkPackagesToRequirements(rawPackages, task, assessment.plan);
  const dossier = adaptProgramContextDossier(program);
  const plan = canonicalPlan({ ...program, masterPlan: assessment.plan }, dossier);
  return updateTask(task.taskId, (current) => {
    assertDirectorIntegrationReady(current, workPackage.workPackageId, integrationExpectation);
    const evidence = {
      requirementId: frontierRequirementId(current.requirements),
      level: "activity",
      ref: `director-plan:${jobId || workPackage.workPackageId}:${assessment.plan.planFingerprint}`,
      summary: "A complete cross-linked master plan passed deterministic plan assurance.",
      passed: false,
      verifiedAt: utcNow(),
    };
    const completedBootstrap = current.program.workPackages.map((row) => row.workPackageId === workPackage.workPackageId ? { ...row, state: "completed", completedAt: utcNow() } : row);
    current.program = {
      ...current.program,
      phase: "execution",
      masterPlan: assessment.plan,
      pendingPlanDirective: null,
      contracts: createProgramState({
        programId: current.program.programId,
        state: "active",
        mission: current.program.mission,
        contextDossier: dossier,
        masterPlan: plan,
        evidenceLedger: current.program.contracts?.evidenceLedger,
        createdAt: current.program.createdAt,
        updatedAt: utcNow(),
      }),
      workPackages: [...completedBootstrap, ...packages],
      evidenceLedger: appendProgramEvidence(current.program, evidence),
      activeCampaign: null,
      runtime: { ...current.program.runtime, forecast: null, ledger: null, budget: null },
      nextAction: "Forecast the whole plan, protect reserves, and fund the best dependency-ready team bundle.",
      updatedAt: utcNow(),
    };
    current.evidence = [...(current.evidence || []), evidence].slice(-50);
    current.workGraph = [
      ...current.workGraph.map((node) => node.id === workPackage.workPackageId ? { ...node, state: "completed", owner: null, evidenceRefs: [...(node.evidenceRefs || []), evidence.ref] } : node),
      ...packages.map((row) => workGraphNode(row, row.acceptanceIds[0] || frontierRequirementId(current.requirements))),
    ];
    return current;
  });
}

function reviseAuthorizedOperation(taskValue, input = {}) {
  const task = typeof taskValue === "string" ? readTask(taskValue) : taskValue;
  if (!isDirectorTask(task) || !task.program.masterPlan || task.program.phase !== "execution") {
    throw new Error("Authorized operation revision requires an execution-stage Director program with an accepted Master Plan.");
  }
  const workPackageId = String(input.workPackageId || "").trim();
  const expectedPlanRevision = Number(input.expectedPlanRevision || 0);
  if (!workPackageId || expectedPlanRevision !== Number(task.program.masterPlan.planRevision || 0)) {
    throw new Error("Authorized operation revision requires the exact current work package and plan revision.");
  }
  const target = (task.program.workPackages || []).find((row) => row.workPackageId === workPackageId);
  if (!target || target.executorKind !== "operational-transaction" || !["pending", "ready"].includes(target.state) || target.jobId) {
    throw new Error("Authorized operation revision target must be one unowned pending operational transaction.");
  }
  const planWorkstreamIds = new Set((task.program.masterPlan.workstreams || []).map((row) => row.id));
  const activePlanPackages = (task.program.workPackages || []).filter((row) => planWorkstreamIds.has(row.workstreamId));
  if (activePlanPackages.some((row) => row.state === "running" || row.state === "completed")) {
    throw new Error("Authorized operation revision cannot replace a plan after plan-derived execution has started or completed.");
  }
  const commands = Array.isArray(input.commands) ? input.commands : [];
  const verificationCommands = Array.isArray(input.verificationCommands) ? input.verificationCommands : target.verificationCommands || [];
  const userAuthorizationRef = String(input.userAuthorizationRef || "").trim();
  const evidence = boundedList(input.evidence, 20, 1200);
  if (!commands.length || !verificationCommands.length || !userAuthorizationRef || !evidence.length) {
    throw new Error("Authorized operation revision requires exact commands, deterministic verification, user authorization, and observed evidence.");
  }
  if (JSON.stringify(commands) === JSON.stringify(target.commands || [])) {
    throw new Error("Authorized operation revision must materially change the failed command contract.");
  }

  const revisedPlan = JSON.parse(JSON.stringify(task.program.masterPlan));
  revisedPlan.planRevision = expectedPlanRevision + 1;
  revisedPlan.workstreams = revisedPlan.workstreams.map((workstream) => {
    if (workstream.id !== target.workstreamId) return workstream;
    const requiredCapabilities = [...new Set([
      ...(input.requiredCapabilities || target.requiredCapabilities || []),
      "command",
      "database",
      "local-files",
    ].map((value) => canonicalCapabilityName(value) || String(value || "").trim()).filter(Boolean))];
    const requiredPermissions = [...new Set([
      ...(input.requiredPermissions || target.requiredPermissions || []),
      "run-command",
      "database",
      "read-project",
      "read-files",
    ].filter(Boolean))];
    const relevantFiles = [...new Set([
      ...(input.relevantFiles || workstream.execution?.relevantFiles || target.relevantFiles || []),
    ].map(String).filter(Boolean))];
    return {
      ...workstream,
      permissionIds: [...new Set([...(workstream.permissionIds || []), "perm-database"])],
      execution: {
        ...(workstream.execution || {}),
        commands,
        verificationCommands,
        requiredCapabilities,
        requiredPermissions,
        relevantFiles,
        mutatesExternalState: false,
        sideEffectKey: String(input.sideEffectKey || target.sideEffectKey || "").trim(),
        observedStateFingerprint: String(input.observedStateFingerprint || target.observedStateFingerprint || "").trim(),
        userAuthorizationRef,
        rollback: input.rollback === undefined ? workstream.execution?.rollback || null : input.rollback,
        recoveryAction: String(input.recoveryAction || workstream.execution?.recoveryAction || target.recoveryAction || "").trim(),
      },
    };
  });
  if (!revisedPlan.workstreams.some((row) => row.id === target.workstreamId)) {
    throw new Error("Authorized operation revision could not find the target plan workstream.");
  }
  if (!(revisedPlan.permissions || []).some((row) => row.id === "perm-database")) {
    revisedPlan.permissions = [...(revisedPlan.permissions || []), {
      id: "perm-database",
      capability: "database",
      mode: "execute",
      scope: "the plan-declared local project database inside the disposable continuation",
      reason: "Apply the explicitly confirmed plan-integrity repair and verify its postcondition.",
      required: true,
    }];
  }
  revisedPlan.team = {
    ...revisedPlan.team,
    roles: (revisedPlan.team?.roles || []).map((role) => role.workstreamIds?.includes(target.workstreamId)
      ? { ...role, permissionIds: [...new Set([...(role.permissionIds || []), "perm-database"])] }
      : role),
  };

  const assessment = assessMasterPlan(revisedPlan, {
    missionId: task.program.mission.missionId,
    missionRevision: task.program.mission.revision,
    contextRevision: task.program.contextDossier.contextRevision,
    contextFingerprint: task.program.contextDossier.contextFingerprint,
    authoritativeRequirements: task.requirements,
    availableSourceFiles: availableProjectFiles(task.workspace, task.program.sourceCatalog),
    minimumPlanRevision: expectedPlanRevision + 1,
  });
  if (!assessment.valid) {
    const error = new Error(`authorized-operation-revision-invalid: ${assessment.errors.join(" | ")}`);
    error.assurance = assessment;
    throw error;
  }
  const compiled = linkPackagesToRequirements(planWorkPackages({
    masterPlan: assessment.plan,
    mission: { id: task.program.mission.missionId, missionId: task.program.mission.missionId },
    contextDossier: task.program.contextDossier,
  }), task, assessment.plan);
  const revisedTarget = compiled.find((row) => row.workstreamId === target.workstreamId);
  if (!revisedTarget || JSON.stringify(revisedTarget.commands) !== JSON.stringify(commands)) {
    throw new Error("Authorized operation revision did not compile the exact confirmed command.");
  }

  const updated = updateTask(task.taskId, (current) => {
    if (Number(current.program.masterPlan?.planRevision || 0) !== expectedPlanRevision) {
      throw new Error("Authorized operation revision fence changed before persistence.");
    }
    const now = utcNow();
    const oldWorkstreamIds = new Set((current.program.masterPlan.workstreams || []).map((row) => row.id));
    const superseded = current.program.workPackages.map((row) => oldWorkstreamIds.has(row.workstreamId)
      ? { ...row, state: "superseded", allocation: null, jobId: null, supersededAt: now, supersededByPlanRevision: assessment.plan.planRevision }
      : row);
    const dossier = adaptProgramContextDossier(current.program);
    const canonical = canonicalPlan({ ...current.program, masterPlan: assessment.plan }, dossier);
    const revisionEvidence = {
      requirementId: target.acceptanceIds?.[0] || frontierRequirementId(current.requirements),
      level: "activity",
      ref: `authorized-operation-revision:${expectedPlanRevision}->${assessment.plan.planRevision}:${revisedTarget.workPackageId}`,
      summary: "The user-authorized confirmed operation command replaced the deterministically disproven dry-run contract without repeating context or strategy.",
      passed: false,
      verifiedAt: now,
    };
    current.program = {
      ...current.program,
      masterPlan: assessment.plan,
      planHistory: [...(current.program.planHistory || []), current.program.masterPlan].slice(-50),
      contracts: createProgramState({
        programId: current.program.programId,
        state: "active",
        mission: current.program.mission,
        contextDossier: dossier,
        masterPlan: canonical,
        evidenceLedger: current.program.contracts?.evidenceLedger,
        createdAt: current.program.createdAt,
        updatedAt: now,
      }),
      workPackages: [...superseded, ...compiled],
      evidenceLedger: appendProgramEvidence(current.program, revisionEvidence),
      activeCampaign: null,
      resourceBudget: null,
      runtime: {
        ...current.program.runtime,
        forecast: null,
        ledger: null,
        budget: null,
        authorizedOperationRevision: {
          schemaVersion: 1,
          priorPlanRevision: expectedPlanRevision,
          planRevision: assessment.plan.planRevision,
          priorWorkPackageId: target.workPackageId,
          workPackageId: revisedTarget.workPackageId,
          userAuthorizationRef,
          evidence,
          appliedAt: now,
        },
      },
      nextAction: "Budget and dispatch the revised confirmed operational transaction without repeating context or strategy.",
      updatedAt: now,
    };
    current.evidence = [...(current.evidence || []), revisionEvidence].slice(-50);
    current.workGraph = [
      ...(current.workGraph || []).map((node) => oldWorkstreamIds.has(
        current.program.workPackages.find((row) => row.workPackageId === node.id)?.workstreamId,
      ) ? { ...node, state: "superseded", owner: null } : node),
      ...compiled.map((row) => workGraphNode(row, row.acceptanceIds[0] || frontierRequirementId(current.requirements))),
    ];
    return current;
  });
  return {
    task: updated,
    priorPlanRevision: expectedPlanRevision,
    planRevision: assessment.plan.planRevision,
    priorWorkPackageId: target.workPackageId,
    workPackageId: revisedTarget.workPackageId,
  };
}

const EVIDENCE_RANK = { activity: 0, "process-health": 1, "focused-test": 2, integration: 3, "end-to-end": 4, "user-visible": 5 };

function sameVerificationCommand(expected, actual) {
  const actualArgs = Array.isArray(actual?.args) ? actual.args.map(String) : [];
  const direct = String(actual?.command || "") === expected.command
    && JSON.stringify(actualArgs) === JSON.stringify(expected.args);
  const pytestModuleFallback = /^pytest(?:\.exe)?$/i.test(expected.command)
    && /^pytest(?:\.exe)?$/i.test(String(actual?.fallbackFrom || ""))
    && /^(?:python|python3|py)(?:\.exe)?$/i.test(String(actual?.command || ""))
    && JSON.stringify(actualArgs) === JSON.stringify(["-m", "pytest", ...expected.args]);
  return (direct || pytestModuleFallback)
    && Number(actual?.expectedExitCode ?? 0) === expected.expectedExitCode
    && actual?.passed === true;
}

function deterministicPackageEvidence(workPackage, handoff, baseIntegration, jobId) {
  const expected = normalizeCommands(workPackage.verificationCommands || []);
  if (!expected.length) return null;
  const candidates = workPackage.deliverableKind === "patch"
    ? [{ kind: "primary-integration", verification: baseIntegration?.verification }]
    : [
        { kind: "package-verification", verification: handoff?.verification },
        { kind: "primary-integration", verification: baseIntegration?.verification },
      ];
  for (const candidate of candidates) {
    const verification = candidate.verification;
    if (verification?.required !== true || verification?.passed !== true || !Array.isArray(verification.checks)) continue;
    if (verification.checks.length !== expected.length) continue;
    if (!expected.every((command, index) => sameVerificationCommand(command, verification.checks[index]))) continue;
    const fingerprint = hash({
      jobId,
      workPackageId: workPackage.workPackageId,
      commands: expected,
      checks: verification.checks.map((row) => ({
        command: row.command,
        args: row.args,
        expectedExitCode: row.expectedExitCode,
        exitCode: row.exitCode,
        passed: row.passed,
      })),
    });
    return {
      kind: candidate.kind,
      ref: `director-verification:${jobId}:${workPackage.workPackageId}:${fingerprint}`,
      fingerprint,
      commandCount: expected.length,
    };
  }
  return null;
}

function handoffEvidence(workPackage, handoff, baseIntegration, jobId, packageProof = null) {
  const supplied = handoff?.deliverable?.acceptanceEvidence || handoff?.artifact?.acceptanceEvidence || [];
  const rows = [];
  for (const value of supplied) {
    const requirementId = String(value?.requirementId || "").trim();
    if (!workPackage.acceptanceIds?.includes(requirementId)) continue;
    const level = String(value.level || "").trim();
    if (EVIDENCE_RANK[level] === undefined || !String(value.ref || "").trim() || !String(value.summary || "").trim()) continue;
    const proofRequired = value.passed === true && EVIDENCE_RANK[level] >= EVIDENCE_RANK["focused-test"];
    const accepted = !proofRequired || Boolean(packageProof);
    const sourceRef = clip(value.ref, 1000);
    const ref = proofRequired && packageProof
      ? `director-acceptance:${jobId}:${workPackage.workPackageId}:${hash({ requirementId, level, sourceRef, proofRef: packageProof.ref })}`
      : sourceRef;
    rows.push({
      requirementId,
      level,
      ref,
      sourceRef,
      summary: clip(value.summary, 1200),
      passed: value.passed === true && accepted,
      accepted,
      workPackageId: workPackage.workPackageId,
      jobId,
      proofRef: packageProof?.ref || "",
      rejectionReason: accepted ? "" : "deterministic-or-integration-package-proof-missing",
      verifiedAt: utcNow(),
    });
  }
  if (workPackage.deliverableKind === "patch") {
    if (!packageProof) return rows;
    for (const requirementId of workPackage.acceptanceIds || []) {
      rows.push({
        requirementId,
        level: "integration",
        ref: `director-patch:${jobId}`,
        summary: "The bounded patch was integrated once and passed its deterministic primary-workspace checks.",
        passed: true,
        accepted: true,
        workPackageId: workPackage.workPackageId,
        jobId,
        proofRef: packageProof.ref,
        verifiedAt: utcNow(),
      });
    }
  }
  return rows;
}

function executionReceiptEvidence(workPackage, receipt) {
  const packageFence = String(workPackage?.revisionFence?.fingerprint || "");
  const receiptFence = String(receipt?.revisionFence?.fingerprint || "");
  if (
    workPackage?.state !== "completed"
    || receipt?.state !== "succeeded"
    || receipt?.workPackageId !== workPackage.workPackageId
    || workPackage.executionReceiptId !== receipt.receiptId
    || !packageFence
    || packageFence !== receiptFence
  ) {
    return [];
  }
  const receiptFingerprint = String(receipt.fingerprint || hash(receipt));
  const ref = `director-execution-receipt:${receipt.receiptId}:${receiptFingerprint}`;
  return (workPackage.acceptanceIds || []).map((requirementId) => ({
    requirementId,
    level: "integration",
    ref,
    summary: "The completed revision-fenced execution receipt was accepted by the Director-CFO integration path.",
    passed: true,
    accepted: true,
    workPackageId: workPackage.workPackageId,
    jobId: workPackage.jobId || "",
    proofRef: `director-receipt:${receipt.receiptId}:${receiptFingerprint}`,
    verifiedAt: receipt.completedAt || workPackage.completedAt || utcNow(),
  }));
}

function canonicalExecutionReceipt(task, workPackage, canonicalPackage, handoff, jobId) {
  const program = task.program;
  const typed = handoff?.deliverable || handoff?.artifact || {};
  const isPatch = workPackage.deliverableKind === "patch";
  const artifacts = isPatch ? [{
    ref: `ai-mobile-patch:${jobId}`,
    fingerprint: hash({ jobId, changedFiles: handoff?.changedFiles || [] }, 24),
    kind: "patch",
  }] : [];
  const operations = isPatch ? [] : (typed.actions || []).slice(0, 100).map((row, index) => ({
    operationId: cleanId(`operation-${jobId}-${index + 1}`, "operation"),
    type: workPackage.executorKind,
    target: workPackage.sideEffectKey || workPackage.goal,
    status: row.passed === false ? "failed" : "verified",
    idempotencyKey: typed.idempotency?.key || workPackage.sideEffectKey || "",
    receiptRef: `ai-mobile-job:${jobId}`,
    rollbackRef: typed.rollback?.executed ? `ai-mobile-rollback:${jobId}` : "",
  }));
  const evidenceRefs = [
    `ai-mobile-job:${jobId}`,
    ...(typed.evidence || []),
    ...(typed.acceptanceEvidence || []).map((row) => row.ref),
  ].filter(Boolean).map(String).slice(0, 500);
  const handoffUsage = handoff?.usage && typeof handoff.usage === "object" ? handoff.usage : {};
  const inputTokens = Math.max(0, Number(handoffUsage.inputTokens || 0));
  const cacheCreationInputTokens = Math.max(0, Number(handoffUsage.cacheCreationInputTokens || 0));
  const cacheReadInputTokens = Math.max(0, Number(handoffUsage.cacheReadInputTokens || handoffUsage.cachedInputTokens || 0));
  const outputTokens = Math.max(0, Number(handoffUsage.outputTokens || 0));
  const totalTokens = Math.max(0, Number(handoffUsage.totalTokens || (inputTokens + cacheCreationInputTokens + cacheReadInputTokens + outputTokens)));
  const allocationAttempt = Math.max(1, Math.floor(Number(handoffUsage.allocationAttempt || workPackage.allocationAttempt || 1)));
  const attempts = Math.max(1, Math.floor(Number(handoffUsage.attempts || allocationAttempt)));
  return normalizeExecutionReceipt({
    schemaVersion: PROGRAM_SCHEMA_VERSION,
    receiptId: cleanId(`receipt-${jobId}`, "receipt"),
    missionId: program.mission.missionId,
    campaignId: program.contracts.campaign.campaignId,
    workPackageId: workPackage.workPackageId,
    attemptId: cleanId(`attempt-${jobId}`, "attempt"),
    revision: 1,
    state: "succeeded",
    provider: workPackage.allocation?.provider || "",
    model: workPackage.allocation?.model || "",
    deliverableType: canonicalPackage.deliverable.type,
    summary: clip(handoff?.summary || `${workPackage.deliverableKind} completed`, 12000),
    artifacts,
    operations,
    evidenceRefs,
    usage: {
      inputTokens,
      cacheCreationInputTokens,
      cacheReadInputTokens,
      outputTokens,
      totalTokens,
      durationMs: Math.max(0, Number(handoffUsage.durationMs || 0)),
      attempts,
      allocationAttempt,
    },
    revisionFence: canonicalPackage.revisionFence,
    completedAt: utcNow(),
  });
}

function recordAcceptanceEvidence(current, evidenceRows) {
  for (const evidence of evidenceRows) {
    const requirement = current.requirements.find((row) => row.id === evidence.requirementId);
    if (!requirement) continue;
    if (evidence.accepted !== false) {
      requirement.evidence = [...(requirement.evidence || []), {
        level: evidence.level,
        ref: evidence.ref,
        sourceRef: evidence.sourceRef || "",
        proofRef: evidence.proofRef || "",
        workPackageId: evidence.workPackageId || "",
        summary: evidence.summary,
        passed: evidence.passed === true,
        verifiedAt: evidence.verifiedAt,
      }].slice(-20);
    }
    const packageProofAccepted = evidence.accepted !== false
      && evidence.passed === true
      && Boolean(evidence.workPackageId)
      && Boolean(evidence.proofRef)
      && EVIDENCE_RANK[evidence.level] >= EVIDENCE_RANK["focused-test"];
    if (
      packageProofAccepted
      && requirement.status === "blocked"
      && EVIDENCE_RANK[evidence.level] < EVIDENCE_RANK[requirement.minimumEvidenceLevel]
    ) {
      requirement.status = "failing";
      requirement.blocker = null;
    }
    if (evidence.accepted !== false && evidence.passed && EVIDENCE_RANK[evidence.level] >= EVIDENCE_RANK[requirement.minimumEvidenceLevel]) {
      requirement.status = "passing";
      requirement.blocker = null;
    }
    current.evidence = [...(current.evidence || []), evidence].slice(-100);
  }
}

function repairDirectorExecutionEvidence(task) {
  const receiptsById = new Map((task.program.executionReceipts || []).map((row) => [row.receiptId, row]));
  const candidates = (task.program.workPackages || []).flatMap((workPackage) => (
    executionReceiptEvidence(workPackage, receiptsById.get(workPackage.executionReceiptId))
  ));
  if (!candidates.length) return task;

  const needsRepair = candidates.some((evidence) => {
    const requirement = task.requirements.find((row) => row.id === evidence.requirementId);
    if (!requirement) return false;
    const requirementProof = (requirement.evidence || []).find((row) => (
      row.accepted !== false
      && row.passed === true
      && row.workPackageId === evidence.workPackageId
      && EVIDENCE_RANK[row.level] >= EVIDENCE_RANK.integration
    ));
    const effectiveEvidence = requirementProof || evidence;
    const taskHasProof = (task.evidence || []).some((row) => (
      row.accepted !== false
      && row.passed === true
      && row.requirementId === evidence.requirementId
      && row.workPackageId === evidence.workPackageId
      && EVIDENCE_RANK[row.level] >= EVIDENCE_RANK.integration
    ));
    const ledgerHasProof = (task.program.evidenceLedger?.entries || []).some((row) => (
      row.accepted !== false
      && row.passed === true
      && row.requirementId === evidence.requirementId
      && row.workPackageId === evidence.workPackageId
      && EVIDENCE_RANK[row.level] >= EVIDENCE_RANK.integration
    ));
    const graphHasProof = (task.workGraph || []).some((node) => (
      (node.id === evidence.workPackageId || node.programWorkPackageId === evidence.workPackageId)
      && (node.evidenceRefs || []).includes(effectiveEvidence.ref)
    ));
    const satisfiesMinimum = EVIDENCE_RANK[effectiveEvidence.level] >= EVIDENCE_RANK[requirement.minimumEvidenceLevel];
    const staleStatus = requirement.status === "passing"
      ? Boolean(requirement.blocker)
      : satisfiesMinimum || requirement.status === "blocked";
    return !requirementProof || !taskHasProof || !ledgerHasProof || !graphHasProof || staleStatus;
  });
  if (!needsRepair) return task;

  return updateTask(task.taskId, (current) => {
    const currentReceiptsById = new Map((current.program.executionReceipts || []).map((row) => [row.receiptId, row]));
    const currentCandidates = (current.program.workPackages || []).flatMap((workPackage) => (
      executionReceiptEvidence(workPackage, currentReceiptsById.get(workPackage.executionReceiptId))
    ));
    let evidenceLedger = current.program.evidenceLedger;
    const graphRefs = new Map();
    for (const evidence of currentCandidates) {
      const requirement = current.requirements.find((row) => row.id === evidence.requirementId);
      if (!requirement) continue;
      let requirementProof = (requirement.evidence || []).find((row) => (
        row.accepted !== false
        && row.passed === true
        && row.workPackageId === evidence.workPackageId
        && EVIDENCE_RANK[row.level] >= EVIDENCE_RANK.integration
      ));
      if (!requirementProof) {
        recordAcceptanceEvidence(current, [evidence]);
        requirementProof = evidence;
      }
      const effectiveEvidence = {
        ...requirementProof,
        requirementId: evidence.requirementId,
        accepted: true,
        passed: true,
        workPackageId: evidence.workPackageId,
        jobId: requirementProof.jobId || evidence.jobId,
        proofRef: requirementProof.proofRef || evidence.proofRef,
        verifiedAt: requirementProof.verifiedAt || evidence.verifiedAt,
      };
      if (requirement.status !== "passing") {
        if (EVIDENCE_RANK[effectiveEvidence.level] >= EVIDENCE_RANK[requirement.minimumEvidenceLevel]) {
          requirement.status = "passing";
          requirement.blocker = null;
        } else if (requirement.status === "blocked") {
          requirement.status = "failing";
          requirement.blocker = null;
        }
      } else if (requirement.blocker) {
        requirement.blocker = null;
      }

      const taskHasProof = (current.evidence || []).some((row) => (
        row.accepted !== false
        && row.passed === true
        && row.requirementId === evidence.requirementId
        && row.workPackageId === evidence.workPackageId
        && EVIDENCE_RANK[row.level] >= EVIDENCE_RANK.integration
      ));
      if (!taskHasProof) current.evidence = [...(current.evidence || []), effectiveEvidence].slice(-100);
      const ledgerHasProof = (evidenceLedger?.entries || []).some((row) => (
        row.accepted !== false
        && row.passed === true
        && row.requirementId === evidence.requirementId
        && row.workPackageId === evidence.workPackageId
        && EVIDENCE_RANK[row.level] >= EVIDENCE_RANK.integration
      ));
      if (!ledgerHasProof) evidenceLedger = appendProgramEvidence({ evidenceLedger }, effectiveEvidence);
      const refs = graphRefs.get(evidence.workPackageId) || [];
      graphRefs.set(evidence.workPackageId, [...new Set([...refs, effectiveEvidence.ref])]);
    }
    current.program = { ...current.program, evidenceLedger, updatedAt: utcNow() };
    current.workGraph = (current.workGraph || []).map((node) => {
      const workPackageId = node.id || node.programWorkPackageId;
      const refs = graphRefs.get(workPackageId);
      return refs?.length
        ? { ...node, evidenceRefs: [...new Set([...(node.evidenceRefs || []), ...refs])].slice(-20) }
        : node;
    });
    return current;
  });
}

function staleDirectorResult(message) {
  const error = new Error(message);
  error.code = "STALE_DIRECTOR_RESULT";
  return error;
}

function selectDirectorPackage(rows, workPackageId, expected = {}) {
  const candidates = (rows || []).filter((row) => row.workPackageId === workPackageId);
  if (!candidates.length) throw staleDirectorResult("director-work-package-missing");
  let matched = candidates;
  if (expected.jobId) {
    matched = matched.filter((row) => row.jobId === expected.jobId);
    if (!matched.length) throw staleDirectorResult("director-job-ownership-mismatch");
  }
  if (expected.revisionFence) {
    matched = matched.filter((row) => row.revisionFence?.fingerprint === expected.revisionFence.fingerprint);
    if (!matched.length) throw staleDirectorResult("director-job-revision-fence-mismatch");
  }
  return matched.find((row) => ["ready", "running"].includes(row.state)) || matched.at(-1);
}

function sameDirectorPackage(row, selected) {
  if (row.workPackageId !== selected.workPackageId) return false;
  if (selected.jobId) return row.jobId === selected.jobId;
  if (selected.revisionFence?.fingerprint) return row.revisionFence?.fingerprint === selected.revisionFence.fingerprint;
  return row === selected;
}

function ownedPrePlanReconciliation(task, workPackage, expected = {}) {
  if (workPackage.executorKind !== "reconciliation") return false;
  if (task.program.masterPlan || task.program.contracts?.campaign) return false;
  if (!expected.jobId || workPackage.jobId !== expected.jobId) return false;
  const packet = workPackage.failurePacket;
  if (!packet?.failureFingerprint || packet.missionId !== task.program.mission?.missionId) return false;
  if (workPackage.failedWorkPackageId !== packet.workPackageId) return false;
  return (task.program.failureMemory || []).some((row) => (
    row.failureFingerprint === packet.failureFingerprint
    && row.workPackageId === packet.workPackageId
    && row.attemptId === packet.attemptId
  ));
}

function assertDirectorIntegrationReady(taskValue, workPackageId, expected = {}) {
  const task = typeof taskValue === "string" ? readTask(taskValue) : taskValue;
  if (!isDirectorTask(task)) throw new Error("Task is not a Director-CFO program.");
  const workPackage = selectDirectorPackage(task.program.workPackages, workPackageId, expected);
  if (!["ready", "running"].includes(workPackage.state)) {
    throw staleDirectorResult(`director-work-package-not-integrable:${workPackage.state}`);
  }
  if (expected.jobId && workPackage.jobId && workPackage.jobId !== expected.jobId) {
    throw staleDirectorResult(`director-job-ownership-mismatch:${workPackage.jobId}`);
  }
  if (!workPackage.revisionFence) {
    if (
      ["context-scout", "strategist"].includes(workPackage.executorKind)
      || ownedPrePlanReconciliation(task, workPackage, expected)
    ) {
      return { bootstrap: true, workPackage, canonicalPackage: null, state: null };
    }
    throw new Error("director-revision-fence-missing");
  }
  const state = normalizeProgramState(task.program.contracts);
  let canonicalPackage;
  try {
    canonicalPackage = selectDirectorPackage(state.workPackages, workPackage.workPackageId, { revisionFence: expected.revisionFence || workPackage.revisionFence });
  } catch (error) {
    if (isStaleDirectorResult(error)) throw error;
    throw staleDirectorResult("canonical-work-package-missing");
  }
  const currentContracts = {
    mission: state.mission,
    contextDossier: state.contextDossier,
    masterPlan: state.masterPlan,
    resourceBudget: state.resourceBudget,
    campaign: state.campaign,
  };
  assertIntegrationFence(canonicalPackage.revisionFence, currentContracts);
  if (Object.hasOwn(expected, "revisionFence")) {
    if (!expected.revisionFence) throw staleDirectorResult("director-job-revision-fence-missing");
    assertIntegrationFence(expected.revisionFence, currentContracts);
    if (expected.revisionFence.fingerprint !== workPackage.revisionFence.fingerprint
      || expected.revisionFence.fingerprint !== canonicalPackage.revisionFence.fingerprint) {
      throw staleDirectorResult("director-job-revision-fence-mismatch");
    }
  }
  return { bootstrap: false, workPackage, canonicalPackage, state };
}

function isStaleDirectorResult(error) {
  return error?.code === "STALE_REVISION_FENCE" || error?.code === "STALE_DIRECTOR_RESULT";
}

function terminalDirectorContracts(program, requirements, terminalState) {
  if (!["completed", "cancelled"].includes(terminalState)) throw new Error("Unsupported Director-CFO terminal state.");
  const current = normalizeProgramState(program.contracts);
  const now = utcNow();
  const mission = normalizeMission({
    ...current.mission,
    fingerprint: undefined,
    revision: current.mission.revision + 1,
    state: terminalState,
    requirements: missionRequirements(requirements),
    updatedAt: now,
  });
  const campaign = current.campaign ? normalizeCampaign({
    ...current.campaign,
    fingerprint: undefined,
    revision: current.campaign.revision + 1,
    state: terminalState,
    updatedAt: now,
  }) : null;
  const workPackages = current.workPackages.map((row) => normalizeWorkPackage({
    ...row,
    fingerprint: undefined,
    revision: row.revision + 1,
    state: row.state === "completed" ? "completed" : "cancelled",
    updatedAt: now,
  }));
  const contracts = createProgramState({
    programId: current.programId,
    revision: current.revision + 1,
    state: terminalState,
    mission,
    contextDossier: current.contextDossier,
    masterPlan: current.masterPlan,
    resourceBudget: current.resourceBudget,
    campaign,
    workPackages,
    executionReceipts: current.executionReceipts,
    failurePackets: current.failurePackets,
    evidenceLedger: current.evidenceLedger,
    reportCursors: current.reportCursors,
    createdAt: current.createdAt,
    updatedAt: now,
  });
  return { mission, contracts, campaign, terminalAt: now };
}

function materialDeltaForFailure(packet) {
  const contextWorkerCorrection = packet.executorKind === "context-scout" && packet.failureClass !== "context-stale";
  const contractOrCapabilityFailure = contextWorkerCorrection || ["director-contract", "worker-capability"].includes(packet.failureClass);
  const anyOf = contractOrCapabilityFailure
    ? ["changedContract", "changedWorkerRequirements", "changedPermissions"]
    : packet.failureClass === "verification"
      ? ["changedContract", "changedWorkerRequirements", "planRevision"]
    : packet.failureClass === "plan-invalid" || packet.assuranceErrors?.length
      ? ["planRevision", "changedContract"]
      : packet.failureClass === "permission-or-tool"
        ? ["changedPermissions", "changedWorkerRequirements", "userDecision"]
        : ["contextRefresh", "planRevision", "changedContract", "changedWorkerRequirements", "changedPermissions", "userDecision"];
  return {
    mustDifferFromContractFingerprint: packet.contractFingerprint,
    failureFingerprint: packet.failureFingerprint,
    anyOf,
    reason: "A retry is eligible only after one listed contract axis materially changes.",
  };
}

function contextualizeFailurePacket(packet, task, workPackage, result = {}) {
  const historyErrors = (task.program.failureMemory || []).flatMap((row) => row.assuranceErrors || []);
  const assuranceErrors = [...new Set([
    ...(Array.isArray(result.assurance?.errors) ? result.assurance.errors : []),
    ...(Array.isArray(result.assuranceErrors) ? result.assuranceErrors : []),
    ...(Array.isArray(workPackage.assuranceErrors) ? workPackage.assuranceErrors : []),
    ...historyErrors,
  ].map((row) => clip(row, 1200)).filter(Boolean))].slice(-50);
  packet.assuranceErrors = assuranceErrors;
  packet.materialDeltaRequired = materialDeltaForFailure(packet);
  return packet;
}

function evidenceRecoveryKey(current, requirements) {
  return hash({
    mission: current.program.mission.fingerprint,
    requirements: requirements.map((row) => row.id).sort(),
  }, 20);
}

function evidenceRecoveryVerificationPackage(current, workPackages, requirements) {
  const requirementIds = requirements.map((row) => row.id);
  const sources = workPackages.filter((row) => (row.acceptanceIds || []).some((id) => requirementIds.includes(id)));
  const commands = [];
  const commandKeys = new Set();
  for (const source of sources) {
    for (const command of normalizeCommands(source.verificationCommands || [])) {
      const key = JSON.stringify(command);
      if (!commandKeys.has(key)) {
        commandKeys.add(key);
        commands.push(command);
      }
    }
  }
  const key = evidenceRecoveryKey(current, requirements);
  const sourceIds = sources.map((row) => row.workPackageId);
  const anchor = sources.find((row) => row.milestoneId || row.milestoneIds?.length) || sources.at(-1) || {};
  const milestoneIds = [...new Set([
    ...(anchor.milestoneIds || []),
    anchor.milestoneId || current.program.masterPlan?.milestones?.[0]?.id || "",
  ].filter(Boolean))];
  const workstreamId = anchor.workstreamId || current.program.masterPlan?.workstreams?.[0]?.id || "";
  return {
    schemaVersion: PROGRAM_SCHEMA_VERSION,
    workPackageId: `verify-evidence-${key}`,
    type: "verification",
    budgetCategory: "verification",
    goal: "Independently verify the still-failing authoritative requirements. Accept no worker claim unless the package-linked deterministic checks below pass.",
    state: "pending",
    workstreamId,
    milestoneId: milestoneIds[0] || "",
    milestoneIds,
    dependencies: [],
    acceptanceIds: requirementIds,
    acceptanceCriteria: requirements.map((row) => row.description),
    executorKind: "verification",
    deliverableKind: "verification-result",
    readOnly: true,
    relevantFiles: [...new Set(sources.flatMap((row) => row.relevantFiles || []))].slice(0, 80),
    expectedFiles: [],
    verificationCommands: commands,
    preconditions: [],
    postconditions: requirements.map((row) => row.description),
    commands: [],
    rollback: null,
    recoveryAction: "If package-linked proof still cannot be produced, dispatch strong reconciliation and materially revise the verification contract.",
    requiredCapabilities: ["source", "local-files", ...(commands.length ? ["tests"] : [])],
    requiredPermissions: ["read-project", "read-files"],
    permissionGrant: ["read-project", "read-files"],
    taskKind: "verification",
    complexity: commands.length ? "medium" : "large",
    minimumCapabilityTier: commands.length ? "balanced" : "frontier",
    timeoutSeconds: 900,
    estimatedDirectTokens: 10000,
    maxWorkerOutputTokens: 2500,
    expectedAcceptanceGain: Math.max(1, requirements.length),
    successProbability: commands.length ? 0.85 : 0.55,
    criticalPath: true,
    ownershipKeys: requirementIds.map((id) => `acceptance:${id}`),
    resourceEstimate: knownPhaseEstimate(10000, 900),
    evidenceRecovery: {
      key,
      owner: "director",
      trigger: "all-planned-packages-complete-with-required-acceptance-gap",
      transition: "dispatch-package-linked-verification",
      requirementIds,
      sourceWorkPackageIds: sourceIds,
      deterministicCommandCount: commands.length,
    },
  };
}
function integrateExecutionResult(task, workPackage, handoff, baseIntegration, jobId, integrationExpectation = {}) {
  if (baseIntegration?.integrated !== true) throw new Error(baseIntegration?.blocker || "project-deliverable-integration-failed");
  const updated = updateTask(task.taskId, (current) => {
    const ready = assertDirectorIntegrationReady(current, workPackage.workPackageId, integrationExpectation);
    const activePackage = ready.workPackage;
    const packageProof = deterministicPackageEvidence(activePackage, handoff, baseIntegration, jobId);
    if (activePackage.deliverableKind === "patch" && !packageProof) {
      throw new Error("verified-primary-patch-integration-receipt-required");
    }
    const receipt = canonicalExecutionReceipt(current, activePackage, ready.canonicalPackage, handoff, jobId);
    assertExecutionReceiptIntegrable(ready.state, ready.canonicalPackage, receipt);
    const evidenceRows = handoffEvidence(activePackage, handoff, baseIntegration, jobId, packageProof);
    const receiptRows = executionReceiptEvidence(
      { ...activePackage, state: "completed", executionReceiptId: receipt.receiptId },
      receipt,
    );
    for (const row of receiptRows) {
      const alreadyRepresented = evidenceRows.some((existing) => (
        existing.accepted !== false
        && existing.passed === true
        && existing.requirementId === row.requirementId
        && existing.workPackageId === row.workPackageId
        && EVIDENCE_RANK[existing.level] >= EVIDENCE_RANK.integration
      ));
      if (!alreadyRepresented) evidenceRows.push(row);
    }
    recordAcceptanceEvidence(current, evidenceRows);
    const now = utcNow();
    let workPackages = current.program.workPackages.map((row) => sameDirectorPackage(row, activePackage)
      ? { ...row, state: "completed", completedAt: now, executionReceiptId: receipt.receiptId }
      : row);
    current.program = {
      ...current.program,
      workPackages,
      masterPlan: advancePlanState(current.program.masterPlan, workPackages),
      executionReceipts: [...(current.program.executionReceipts || []), receipt].slice(-1000),
      evidenceLedger: evidenceRows.reduce((ledger, row) => appendProgramEvidence({ evidenceLedger: ledger }, row), current.program.evidenceLedger),
      nextAction: "Continue with the highest-value dependency-ready package under a fresh resource check.",
      updatedAt: now,
    };
    current.workGraph = current.workGraph.map((node) => node.id === activePackage.workPackageId
      ? { ...node, state: "completed", owner: null, evidenceRefs: [...(node.evidenceRefs || []), ...evidenceRows.filter((row) => row.accepted !== false).map((row) => row.ref)].slice(-20) }
      : node);
    const campaignIds = new Set(current.program.contracts?.campaign?.workPackageIds || []);
    const campaignComplete = [...campaignIds].every((id) => current.program.workPackages.find((row) => row.workPackageId === id)?.state === "completed");
    if (campaignComplete && current.program.activeCampaign) {
      current.program.activeCampaign = { ...current.program.activeCampaign, state: "completed", finishedAt: now, stopReason: "campaign-work-packages-completed" };
    }
    const required = current.requirements.filter((row) => row.required);
    if (required.length && required.every((row) => row.status === "passing")) {
      const terminal = terminalDirectorContracts(current.program, current.requirements, "completed");
      current.state = "completed";
      current.completedAt = now;
      current.program.state = "completed";
      current.program.phase = "completed";
      current.program.mission = terminal.mission;
      current.program.contracts = terminal.contracts;
      current.program.workPackages = current.program.workPackages.map((row) => row.state === "completed"
        ? row
        : { ...row, state: "cancelled", cancelledAt: now });
      current.program.activeCampaign = current.program.activeCampaign
        ? { ...current.program.activeCampaign, state: "completed", finishedAt: now, stopReason: "acceptance-evidence-complete" }
        : null;
      current.program.nextAction = "All required acceptance evidence passed.";
      current.workGraph = current.workGraph.map((node) => node.state === "completed"
        ? node
        : { ...node, state: "cancelled", owner: null });
    } else if (!workPackages.some((row) => ["pending", "ready", "running"].includes(row.state))) {
      const missing = required.filter((row) => row.status !== "passing");
      const recoveryKey = evidenceRecoveryKey(current, missing);
      const priorRecovery = workPackages.find((row) => row.evidenceRecovery?.key === recoveryKey);
      if (!priorRecovery) {
        const recovery = evidenceRecoveryVerificationPackage(current, workPackages, missing);
        workPackages = [...workPackages, recovery];
        current.program.workPackages = workPackages;
        current.program.masterPlan = advancePlanState(current.program.masterPlan, workPackages);
        current.program.phase = "awaiting-evidence";
        current.program.state = "active";
        current.program.nextAction = "The Director owns the evidence gap: budget and dispatch the package-linked verification package.";
        current.workGraph = [...current.workGraph, workGraphNode(recovery, missing[0]?.id || frontierRequirementId(current.requirements))];
      } else {
        const packet = contextualizeFailurePacket(createFailurePacket({
          taskId: current.taskId,
          projectId: current.projectId || current.taskId,
          missionId: current.program.mission.missionId,
          campaignId: current.program.contracts?.campaign?.campaignId || "campaign-evidence-recovery",
          workPackage: priorRecovery,
          attemptId: `${jobId}:evidence-gap`,
          result: { blocker: "evidence-insufficient: package-linked deterministic verification did not close authoritative acceptance", verification: handoff?.verification || null },
          revisions: {
            context: Number(current.program.contextDossier?.contextRevision || 0),
            plan: Number(current.program.masterPlan?.planRevision || 0),
            budget: Number(current.program.runtime?.budget?.budgetRevision || 0),
            campaign: Number(current.program.activeCampaign?.epoch || 0),
          },
          stateFingerprint: current.program.contextDossier?.contextFingerprint || "",
        }), current, priorRecovery, {});
        const reconciliation = enrichedReconciliationPackage(current, priorRecovery, packet);
        current.program.failureMemory = [...(current.program.failureMemory || []), packet].slice(-500);
        current.program.workPackages = [...workPackages, reconciliation];
        current.program.phase = "reconciliation";
        current.program.state = "active";
        current.program.nextAction = "A strong reconciler owns the remaining evidence gap and must materially revise the verification contract.";
        current.workGraph = [...current.workGraph, workGraphNode(reconciliation, missing[0]?.id || frontierRequirementId(current.requirements))];
      }
    }
    return current;
  });
  if (updated.state === "completed") cancelTaskJobs(updated.taskId);
  return updated;
}

function enrichedReconciliationPackage(task, failedPackage, packet) {
  const base = reconciliationWorkPackage(packet, task.program.failureMemory || []);
  const priorAssuranceErrors = packet.assuranceErrors || [];
  const materialDeltaRequired = packet.materialDeltaRequired || materialDeltaForFailure(packet);
  const requiredContextRefresh = !task.program.contextDossier || base.policy?.fullContextRefresh === true;
  const preserveAcceptedContext = Boolean(task.program.contextDossier)
    && packet.failureClass === "plan-invalid"
    && !requiredContextRefresh;
  const rootFailure = rootFailedWorkPackage(task, failedPackage);
  const contextTransportNote = rootFailure?.executorKind === "context-scout"
    ? "Current Director runtime constraint: database sources are already exposed through bounded immutable JSON observation receipts readable with source/local-files. Do not request Bash, shell-readonly, sqlite-readonly, database-readonly, or direct SQLite commands. For a worker-capability correction, set minimumCapabilityTier=frontier and adjust bounded token/time fields."
    : "";
  const goal = [
    base.goal,
    "Prior plan-assurance errors:",
    JSON.stringify(priorAssuranceErrors),
    "Required material delta before retry:",
    "Return machine-actionable fields, not narrative {changed,delta} wrappers. changedContract and changedWorkerRequirements must contain exact work-package fields; changedPermissions must contain exact requiredPermissions and permissionGrant arrays.",
    preserveAcceptedContext
      ? "The accepted context dossier remains current. Set contextRefresh=false and correct the plan or strategist contract directly. Do not spend another context worker."
      : task.program.contextDossier
        ? "An accepted context dossier exists."
        : "No context dossier is accepted. Director policy requires contextRefresh=true; false is invalid and a planRevision cannot run without accepted context.",
    contextTransportNote,
    JSON.stringify(materialDeltaRequired),
    "Use this exact failure packet and return a materially changed reconciliation decision:",
    `Copy this exact current failureFingerprint verbatim; never select or retype one from failure history: ${packet.failureFingerprint}`,
    JSON.stringify(packet),
  ].join("\n");
  return {
    ...base,
    goal,
    state: "pending",
    type: "reconciliation",
    budgetCategory: "reconciliation",
    workstreamId: failedPackage.workstreamId || task.program.masterPlan?.workstreams?.[0]?.id || "",
    milestoneId: failedPackage.milestoneId || failedPackage.milestoneIds?.[0] || task.program.masterPlan?.milestones?.[0]?.id || "",
    milestoneIds: failedPackage.milestoneIds || [failedPackage.milestoneId].filter(Boolean),
    taskKind: "debug",
    relevantFiles: failedPackage.relevantFiles || localSourceFiles(task.workspace, task.program.sourceCatalog),
    expectedFiles: [],
    verificationCommands: [],
    readOnly: true,
    requiredCapabilities: ["source", "local-files"],
    requiredPermissions: ["read-project", "read-files"],
    permissionGrant: ["read-project", "read-files"],
    minimumCapabilityTier: "frontier",
    timeoutSeconds: 1200,
    estimatedDirectTokens: STRONG_RECONCILIATION_TOKEN_ESTIMATE,
    maxWorkerOutputTokens: 3500,
    expectedAcceptanceGain: 4,
    successProbability: 0.8,
    criticalPath: true,
    ownershipKeys: [],
    resourceEstimate: knownPhaseEstimate(STRONG_RECONCILIATION_TOKEN_ESTIMATE, 1200),
    artifactContract: {
      kind: "reconciliation-decision",
      requiredFailureFingerprint: packet.failureFingerprint,
      requiredContextRefresh,
    },
    failurePacket: packet,
    policy: { ...base.policy, fullContextRefresh: requiredContextRefresh, priorAssuranceErrors, materialDeltaRequired },
    priorAssuranceErrors,
    materialDeltaRequired,
    acceptanceCriteria: [
      ...(base.acceptanceCriteria || []),
      "Address every prior plan-assurance error explicitly.",
      "Change at least one required material-delta axis before retry.",
    ],
    failedWorkPackageId: failedPackage.workPackageId,
  };
}

function recordProgramFailure(taskValue, workPackage, blocker, result = {}) {
  const task = typeof taskValue === "string" ? readTask(taskValue) : taskValue;
  const program = task.program;
  const handled = (program.failureMemory || []).find((row) => row.attemptId && row.attemptId === result.jobId && row.workPackageId === workPackage.workPackageId);
  if (handled) return task;
  const packet = createFailurePacket({
    taskId: task.taskId,
    projectId: task.projectId || task.taskId,
    missionId: program.mission.missionId,
    campaignId: program.activeCampaign?.campaignId || program.contracts?.campaign?.campaignId || "campaign-bootstrap",
    workPackage,
    acceptanceIds: failureAcceptanceIds(task, workPackage),
    attemptId: result.jobId,
    result: { ...result, blocker },
    allocation: workPackage.allocation,
    revisions: {
      context: Number(program.contextDossier?.contextRevision || 0),
      plan: Number(program.masterPlan?.planRevision || 0),
      budget: Number(program.runtime?.budget?.budgetRevision || 0),
      campaign: Number(program.activeCampaign?.epoch || 0),
    },
    stateFingerprint: workPackage.observedStateFingerprint || program.contextDossier?.contextFingerprint || "",
  });
  contextualizeFailurePacket(packet, task, workPackage, result);
  const policy = recoveryPolicy(packet, program.failureMemory || []);
  if (policy.action === "bounded-backoff-retry") {
    return updateTask(task.taskId, (current) => {
      current.program = {
        ...current.program,
        failureMemory: [...(current.program.failureMemory || []), packet].slice(-500),
        workPackages: current.program.workPackages.map((row) => row.workPackageId === workPackage.workPackageId
          ? { ...row, state: "pending", allocation: null, permissionPreflight: null, lastFailure: packet }
          : row),
        activeCampaign: null,
        nextAction: `Retry is eligible after ${policy.backoffSeconds}s because the failure is transient and idempotent.`,
        updatedAt: utcNow(),
      };
      current.workGraph = current.workGraph.map((node) => node.id === workPackage.workPackageId ? { ...node, state: "pending", owner: null, lastFailure: blocker } : node);
      return current;
    });
  }
  if (policy.action === "request-user-decision") {
    return updateTask(task.taskId, (current) => {
      current.program = {
        ...current.program,
        phase: "blocked",
        state: "blocked",
        failureMemory: [...(current.program.failureMemory || []), packet].slice(-500),
        workPackages: current.program.workPackages.map((row) => row.workPackageId === workPackage.workPackageId ? { ...row, state: "failed", lastFailure: packet } : row),
        nextAction: blocker,
        updatedAt: utcNow(),
      };
      current.workGraph = current.workGraph.map((node) => node.id === workPackage.workPackageId ? { ...node, state: "blocked", owner: null, lastFailure: blocker } : node);
      return current;
    });
  }
  const reconciliation = enrichedReconciliationPackage(task, workPackage, packet);
  return updateTask(task.taskId, (current) => {
    current.program = {
      ...current.program,
      phase: "reconciliation",
      state: "active",
      failureMemory: [...(current.program.failureMemory || []), packet].slice(-500),
      workPackages: [
        ...current.program.workPackages.map((row) => row.workPackageId === workPackage.workPackageId ? { ...row, state: "failed", lastFailure: packet } : row),
        reconciliation,
      ],
      activeCampaign: null,
      nextAction: policy.fullContextRefresh
        ? "A strong reconciler must trace the failure, then refresh full context and revise the plan."
        : "A strong reconciler must identify root cause and materially change the contract before another attempt.",
      updatedAt: utcNow(),
    };
    current.workGraph = [
      ...current.workGraph.map((node) => node.id === workPackage.workPackageId ? { ...node, state: "blocked", owner: null, lastFailure: blocker } : node),
      workGraphNode(reconciliation, frontierRequirementId(current.requirements)),
    ];
    return current;
  });
}

const RECONCILABLE_PACKAGE_FIELDS = Object.freeze([
  "goal", "executorKind", "deliverableKind", "budgetCategory", "taskKind", "minimumCapabilityTier",
  "requiredCapabilities", "requiredPermissions", "permissionGrant", "relevantFiles", "expectedFiles",
  "verificationCommands", "preconditions", "postconditions", "rollback", "recoveryAction", "commands",
  "mutatesExternalState", "sideEffectKey", "observedStateFingerprint", "userAuthorizationRef",
  "resourceEstimate", "successProbability", "timeoutSeconds", "maxWorkerOutputTokens", "readOnly",
]);
const EXECUTOR_DELIVERABLE = Object.freeze({
  "context-scout": "context-dossier",
  strategist: "master-plan",
  "code-change": "patch",
  "operational-transaction": "operation-receipt",
  "browser-action": "browser-receipt",
  "external-transaction": "external-transaction-receipt",
  "evidence-observer": "monitoring-evidence",
  verification: "verification-result",
  reconciliation: "reconciliation-decision",
});

function reconciledPackage(failedPackage, decision) {
  const requested = {
    ...(decision.changedContract && typeof decision.changedContract === "object" ? decision.changedContract : {}),
    ...(decision.changedWorkerRequirements && typeof decision.changedWorkerRequirements === "object" ? decision.changedWorkerRequirements : {}),
  };
  if (Array.isArray(decision.changedPermissions)) {
    requested.requiredPermissions = decision.changedPermissions;
    requested.permissionGrant = decision.changedPermissions;
  } else if (decision.changedPermissions && typeof decision.changedPermissions === "object") {
    if (Array.isArray(decision.changedPermissions.requiredPermissions)) requested.requiredPermissions = decision.changedPermissions.requiredPermissions;
    if (Array.isArray(decision.changedPermissions.permissionGrant)) requested.permissionGrant = decision.changedPermissions.permissionGrant;
  }
  const patch = {};
  for (const key of RECONCILABLE_PACKAGE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(requested, key)) patch[key] = requested[key];
  }
  const next = { ...failedPackage, ...patch };
  if (patch.executorKind || patch.deliverableKind) {
    const expected = EXECUTOR_DELIVERABLE[next.executorKind];
    if (!expected || expected !== next.deliverableKind) throw new Error("reconciliation-decision-invalid: executorKind and deliverableKind must remain compatible");
  }
  for (const key of ["requiredCapabilities", "requiredPermissions", "permissionGrant", "relevantFiles", "expectedFiles"]) {
    if (patch[key] && !Array.isArray(patch[key])) throw new Error(`reconciliation-decision-invalid: ${key} must be an array`);
  }
  const changed = Object.keys(patch).some((key) => JSON.stringify(failedPackage[key]) !== JSON.stringify(next[key]));
  return { next, changed, patch };
}

function canonicalContextRefreshDecision(decision) {
  const changedContract = decision.changedContract && typeof decision.changedContract === "object"
    ? { ...decision.changedContract }
    : decision.changedContract;
  const changedWorkerRequirements = decision.changedWorkerRequirements && typeof decision.changedWorkerRequirements === "object"
    ? { ...decision.changedWorkerRequirements }
    : decision.changedWorkerRequirements;
  for (const value of [changedContract, changedWorkerRequirements]) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    delete value.executorKind;
    delete value.deliverableKind;
  }
  if (changedWorkerRequirements && typeof changedWorkerRequirements === "object") {
    if (!Object.hasOwn(changedWorkerRequirements, "maxWorkerOutputTokens") && Number.isFinite(Number(changedWorkerRequirements.maxOutputTokens))) {
      changedWorkerRequirements.maxWorkerOutputTokens = Number(changedWorkerRequirements.maxOutputTokens);
    }
    if (!Object.hasOwn(changedWorkerRequirements, "timeoutSeconds") && Number.isFinite(Number(changedWorkerRequirements.maxWallClockSeconds))) {
      changedWorkerRequirements.timeoutSeconds = Number(changedWorkerRequirements.maxWallClockSeconds);
    }
  }
  return { ...decision, changedContract, changedWorkerRequirements };
}

function exactUserDecisionRequest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.required === false) return "";
  const direct = String(value.question || value.action || value.exactQuestion || value.exactActionIfYes || value.decision || "").trim();
  if (direct) return direct;
  return (Array.isArray(value.asks) ? value.asks : [])
    .map((row) => String(row?.question || row?.action || row?.exactQuestion || row?.exactActionIfYes || row?.decision || "").trim())
    .filter(Boolean)
    .join(" | ");
}

function actionableReconciliationTransition(task, workPackage, decision) {
  const acceptedDossier = task.program.contextDossier?.schemaVersion === "director-cfo/context-dossier@1";
  const failedPackage = (task.program.workPackages || []).find((row) => row.workPackageId === workPackage.failedWorkPackageId);
  if (!failedPackage) throw new Error("reconciliation-decision-invalid: failed work package is missing");
  const requestedContextRefresh = contextRefreshRequested(decision.contextRefresh);
  const failureClass = String(workPackage.failurePacket?.failureClass || failedPackage.lastFailure?.failureClass || "");
  const policyRequiresContextRefresh = workPackage.policy?.fullContextRefresh === true;
  const contextRefreshAllowed = !acceptedDossier || policyRequiresContextRefresh || failureClass === "context-stale";
  const forceContextRefresh = policyRequiresContextRefresh || (requestedContextRefresh && contextRefreshAllowed);
  const structuralReset = forceContextRefresh || Boolean(decision.planRevision);
  const revisionTarget = forceContextRefresh ? rootFailedWorkPackage(task, failedPackage) : failedPackage;
  const effectiveDecision = structuralReset ? canonicalContextRefreshDecision(decision) : decision;
  const packageDeltaRequested = Boolean(
    effectiveDecision.changedContract
    || effectiveDecision.changedWorkerRequirements
    || (Array.isArray(effectiveDecision.changedPermissions) ? effectiveDecision.changedPermissions.length : effectiveDecision.changedPermissions),
  );
  const revised = packageDeltaRequested
    ? reconciledPackage(revisionTarget, effectiveDecision)
    : { next: revisionTarget, changed: false, patch: {} };
  const exactUserDecision = exactUserDecisionRequest(decision.userDecision);
  if (!structuralReset && !revised.changed && exactUserDecision) {
    return { kind: "user-decision", exactUserDecision };
  }
  if (!structuralReset && !revised.changed && decision.userDecision && !exactUserDecision) {
    throw new Error("reconciliation-decision-invalid: userDecision requires an exact question, action, or decision ask");
  }
  if (packageDeltaRequested && !revised.changed && !structuralReset) {
    throw new Error("reconciliation-decision-invalid: a machine-actionable work-package delta is required; narrative change descriptions are not applied");
  }

  const appliedAxes = new Set();
  if (forceContextRefresh) appliedAxes.add("contextRefresh");
  if (decision.planRevision) appliedAxes.add("planRevision");
  if (revised.changed) {
    if (decision.changedContract) appliedAxes.add("changedContract");
    if (decision.changedWorkerRequirements) appliedAxes.add("changedWorkerRequirements");
    if (decision.changedPermissions) appliedAxes.add("changedPermissions");
  }
  const requiredAxes = workPackage.materialDeltaRequired?.anyOf
    || workPackage.policy?.materialDeltaRequired?.anyOf
    || [];
  if (requiredAxes.length && !requiredAxes.some((axis) => appliedAxes.has(axis))) {
    throw new Error(`reconciliation-decision-invalid: this failure requires one applied material delta: ${requiredAxes.join(", ")}`);
  }
  if (forceContextRefresh) return { kind: "context-refresh", failedPackage, rootFailedPackage: revisionTarget, revised };
  if (!acceptedDossier) {
    throw new Error("reconciliation-decision-invalid: contextRefresh=true is required when no accepted context dossier exists");
  }
  if (decision.planRevision) return { kind: "plan-revision", failedPackage, rootFailedPackage: revisionTarget, revised };
  if (!revised.changed) {
    throw new Error("reconciliation-decision-invalid: a machine-actionable work-package delta is required; narrative change descriptions are not applied");
  }
  return { kind: "package-revision", failedPackage, revised };
}

function integrateReconciliationArtifact(task, workPackage, artifact, jobId, integrationExpectation = {}) {
  if (workPackage.revisionFence && task.program.contracts?.campaign) {
    const state = normalizeProgramState(task.program.contracts);
    assertIntegrationFence(workPackage.revisionFence, {
      mission: state.mission,
      contextDossier: state.contextDossier,
      masterPlan: state.masterPlan,
      resourceBudget: state.resourceBudget,
      campaign: state.campaign,
    });
  }
  const decision = artifact?.artifact || artifact || {};
  const validation = validateReconciliationDecision(decision, workPackage.failurePacket);
  if (!validation.ok) throw new Error(`reconciliation-decision-invalid: ${validation.blocker}`);
  const transition = actionableReconciliationTransition(task, workPackage, decision);
  if (transition.kind === "user-decision") {
    return updateTask(task.taskId, (current) => {
      assertDirectorIntegrationReady(current, workPackage.workPackageId, integrationExpectation);
      current.program = {
        ...current.program,
        phase: "blocked",
        state: "blocked",
        workPackages: current.program.workPackages.map((row) => row.workPackageId === workPackage.workPackageId ? { ...row, state: "completed", completedAt: utcNow() } : row),
        nextAction: clip(transition.exactUserDecision, 1200),
        updatedAt: utcNow(),
      };
      current.workGraph = current.workGraph.map((node) => node.id === workPackage.workPackageId ? { ...node, state: "completed", owner: null } : node);
      return current;
    });
  }
  if (transition.kind === "context-refresh") {
    const refresh = decideContextRefresh({
      sourceCatalog: task.program.sourceCatalog,
      previousDossier: task.program.contextDossier,
      forceFull: true,
      repeatedFailureCount: workPackage.policy?.lineage?.acceptanceFailureCount || 0,
    });
    const contextContract = createContextScoutWorkPackage({
      mission: { id: task.program.mission.missionId, revision: task.program.mission.revision, outcome: task.program.mission.outcome },
      sourceCatalog: task.program.sourceCatalog,
      workspace: task.workspace,
      previousDossier: task.program.contextDossier,
      refreshDecision: refresh,
    });
    const baseContextPackage = bootstrapPackage("context", contextContract, task.workspace, frontierRequirementId(task.requirements));
    const contextPackage = safeContextRetryPackage(task, baseContextPackage, transition, workPackage, validation.fingerprint);
    const planDirective = planRevisionDirective(task, transition, workPackage, decision, validation.fingerprint, workPackage.policy?.revisePlan === true || workPackage.policy?.fullContextRefresh === true);
    const updated = updateTask(task.taskId, (current) => {
      assertDirectorIntegrationReady(current, workPackage.workPackageId, integrationExpectation);
      const now = utcNow();
      current.program = {
        ...current.program,
        phase: "context",
        state: "active",
        contextHistory: current.program.contextDossier
          ? [...(current.program.contextHistory || []), current.program.contextDossier].slice(-50)
          : current.program.contextHistory || [],
        contextDossier: null,
        masterPlan: null,
        resourceBudget: null,
        pendingPlanDirective: planDirective,
        campaigns: stoppedCampaignHistory(current.program, "reconciliation-context-refresh", now),
        contracts: createProgramState({
          programId: current.program.programId,
          state: "active",
          mission: current.program.mission,
          evidenceLedger: current.program.contracts?.evidenceLedger,
          reportCursors: current.program.contracts?.reportCursors || [],
          createdAt: current.program.createdAt,
          updatedAt: utcNow(),
        }),
        workPackages: [...supersededRebuildPackages(current.program, workPackage.workPackageId, decision, now), contextPackage],
        activeCampaign: null,
        runtime: {
          ...current.program.runtime,
          forecast: null,
          ledger: null,
          budget: null,
          bootstrapFence: {
            missionFingerprint: current.program.mission.fingerprint,
            catalogFingerprint: current.program.sourceCatalog.catalogFingerprint,
          },
        },
        nextAction: "Run a full authorized context refresh before revising strategy.",
        updatedAt: now,
      };
      current.workGraph = supersededRebuildGraph(current.workGraph, workPackage.workPackageId, contextPackage, frontierRequirementId(current.requirements), now);
      return current;
    });
    cancelTaskJobs(updated.taskId);
    return updated;
  }
  if (transition.kind === "plan-revision") {
    const directive = planRevisionDirective(task, transition, workPackage, decision, validation.fingerprint, true);
    const strategyContract = createStrategyWorkPackage({
      mission: { id: task.program.mission.missionId, revision: task.program.mission.revision, outcome: task.program.mission.outcome },
      contextDossier: task.program.contextDossier,
      requirements: task.requirements,
      availableSourceFiles: availableProjectFiles(task.workspace, task.program.sourceCatalog),
      minimumPlanRevision: directive.minimumPlanRevision,
      reconciliationDirective: directive,
    });
    const strategyPackage = revisedStrategyPackage(task, strategyContract, transition, workPackage, validation.fingerprint);
    const updated = updateTask(task.taskId, (current) => {
      assertDirectorIntegrationReady(current, workPackage.workPackageId, integrationExpectation);
      const now = utcNow();
      current.program = {
        ...current.program,
        phase: "strategy",
        state: "active",
        planHistory: current.program.masterPlan
          ? [...(current.program.planHistory || []), current.program.masterPlan].slice(-50)
          : current.program.planHistory || [],
        pendingPlanDirective: null,
        masterPlan: null,
        resourceBudget: null,
        contracts: createProgramState({
          programId: current.program.programId,
          state: "active",
          mission: current.program.mission,
          contextDossier: adaptProgramContextDossier(current.program),
          evidenceLedger: current.program.contracts?.evidenceLedger,
          reportCursors: current.program.contracts?.reportCursors || [],
          createdAt: current.program.createdAt,
          updatedAt: now,
        }),
        campaigns: stoppedCampaignHistory(current.program, "reconciliation-plan-revision", now),
        workPackages: [...supersededRebuildPackages(current.program, workPackage.workPackageId, decision, now), strategyPackage],
        activeCampaign: null,
        runtime: { ...current.program.runtime, forecast: null, ledger: null, budget: null },
        nextAction: "Build and assure a materially revised master plan.",
        updatedAt: now,
      };
      current.workGraph = supersededRebuildGraph(current.workGraph, workPackage.workPackageId, strategyPackage, frontierRequirementId(current.requirements), now);
      return current;
    });
    cancelTaskJobs(updated.taskId);
    return updated;
  }
  const revised = transition.revised;
  return updateTask(task.taskId, (current) => {
    assertDirectorIntegrationReady(current, workPackage.workPackageId, integrationExpectation);
    current.program = {
      ...current.program,
      phase: "execution",
      workPackages: current.program.workPackages.map((row) => {
        if (row.workPackageId === workPackage.workPackageId) return { ...row, state: "completed", completedAt: utcNow(), reconciliationDecision: decision };
        if (row.workPackageId === workPackage.failedWorkPackageId) return {
          ...revised.next,
          state: "pending",
          allocation: null,
          permissionPreflight: null,
          revisionFence: null,
          canonicalContract: null,
          reconciledContract: revised.patch,
        };
        return row;
      }),
      activeCampaign: null,
      nextAction: "Rebudget the materially changed work package before retry.",
      updatedAt: utcNow(),
    };
    current.workGraph = current.workGraph.map((node) => node.id === workPackage.workPackageId
      ? { ...node, state: "completed", owner: null, evidenceRefs: [...(node.evidenceRefs || []), `director-reconciliation:${jobId}:${validation.fingerprint}`] }
      : node.id === workPackage.failedWorkPackageId ? { ...node, state: "pending", owner: null } : node);
    return current;
  });
}

function integrateDirectorArtifact(taskValue, workPackageId, artifact, options = {}) {
  const task = typeof taskValue === "string" ? readTask(taskValue) : taskValue;
  if (!isDirectorTask(task)) throw new Error("Task is not a Director-CFO program.");
  const integrationExpectation = options.integrationExpectation || {};
  const workPackage = selectDirectorPackage(task.program.workPackages, workPackageId, integrationExpectation);
  if (workPackage.state === "completed") return { integrated: true, alreadyIntegrated: true, workPackageId };
  const bootstrapContract = options.bootstrapContract || workPackage.bootstrapContract || null;
  if (workPackage.executorKind === "context-scout" && bootstrapContract) {
    const contextPackage = {
      ...workPackage,
      bootstrapContract,
      contextObservationReceiptExpectations: options.contextObservationReceiptExpectations || workPackage.contextObservationReceiptExpectations || {},
    };
    const updated = integrateContextArtifact(task, contextPackage, artifact, options.jobId || workPackageId, integrationExpectation);
    return { integrated: true, workPackageId, phase: updated.program.phase, artifactKind: "context-dossier" };
  }
  if (workPackage.executorKind === "strategist") {
    const updated = integratePlanArtifact(task, workPackage, artifact, options.jobId || workPackageId, integrationExpectation);
    return { integrated: true, workPackageId, phase: updated.program.phase, artifactKind: "master-plan" };
  }
  if (workPackage.executorKind === "reconciliation") {
    const updated = integrateReconciliationArtifact(task, workPackage, artifact, options.jobId || workPackageId, integrationExpectation);
    return { integrated: true, workPackageId, phase: updated.program.phase, artifactKind: "reconciliation-decision" };
  }
  const handoff = options.handoff || { state: "completed", summary: "Synthetic integration", artifact, deliverable: artifact, changedFiles: [] };
  const defaultIntegration = workPackage.deliverableKind === "patch"
    ? { integrated: false, blocker: "explicit-verified-patch-integration-receipt-required" }
    : { integrated: true, typedDeliverable: true };
  const updated = integrateExecutionResult(task, workPackage, handoff, options.baseIntegration || defaultIntegration, options.jobId || workPackageId, integrationExpectation);
  return { integrated: true, workPackageId, phase: updated.program.phase, artifactKind: workPackage.deliverableKind };
}

function integrateDirectorJob(input = {}) {
  const task = readTask(input.taskId);
  if (!isDirectorTask(task)) return null;
  const dir = jobDirectory(task.taskId, input.jobId);
  const contract = readJson(path.join(dir, "contract.json"), {});
  const status = readJson(path.join(dir, "status.json"), {});
  const handoff = readJson(path.join(dir, "handoff.json"), {});
  handoff.usage = readJson(path.join(dir, "usage.json"), {});
  const workPackageId = contract.directorProgram?.workPackageId || input.workPackageId;
  const integrationExpectation = { jobId: input.jobId };
  if (Object.hasOwn(contract.directorProgram || {}, "revisionFence")) integrationExpectation.revisionFence = contract.directorProgram.revisionFence;
  else if (Object.hasOwn(contract, "revisionFence")) integrationExpectation.revisionFence = contract.revisionFence;
  let workPackage;
  try {
    workPackage = selectDirectorPackage(task.program.workPackages, workPackageId, integrationExpectation);
    if (workPackage.state === "completed") return { integrated: true, alreadyIntegrated: true, jobId: input.jobId, workPackageId };
    assertDirectorIntegrationReady(task, workPackageId, integrationExpectation);
  } catch (error) {
    if (isStaleDirectorResult(error)) return { integrated: false, stale: true, reconciled: false, blocker: error.message, jobId: input.jobId, workPackageId };
    return { integrated: false, reconciled: false, blocker: error.message, jobId: input.jobId, workPackageId };
  }
  if (status.state !== "completed" || handoff.state !== "completed") {
    const blocker = status.blocker || handoff.blocker || "worker-failed-without-typed-handoff";
    recordProgramFailure(task, workPackage, blocker, { jobId: input.jobId, provider: contract.provider, model: contract.model, summary: handoff.summary });
    return { integrated: false, reconciled: true, blocker, jobId: input.jobId, workPackageId };
  }
  try {
    let bootstrapContract = null;
    if (workPackage.executorKind === "context-scout") {
      const workerContract = assertDirectorWorkerContract(contract.directorWorkerContract);
      if (workerContract.executionEnvelope?.workPackageId !== workPackageId) {
        throw new Error("director-worker-contract-work-package-mismatch");
      }
      bootstrapContract = workerContract.bootstrapContract || null;
      if (bootstrapContract) {
        const freshness = verifyContextSnapshotFreshness({
          workspace: task.workspace,
          sourceCatalog: task.program.sourceCatalog,
          capturedManifest: bootstrapContract.sourceSnapshotManifest,
        });
        if (!freshness.fresh) {
          const transition = scheduleContextSnapshotRecovery(task, workPackage, bootstrapContract, freshness, integrationExpectation);
          return {
            integrated: false,
            stale: true,
            reconciled: false,
            managerTransition: true,
            artifactAccepted: false,
            jobId: input.jobId,
            workPackageId,
            ...transition,
          };
        }
      }
    }
    return {
      jobId: input.jobId,
      ...integrateDirectorArtifact(task, workPackageId, handoff.artifact || handoff.deliverable, {
        jobId: input.jobId,
        handoff,
        bootstrapContract,
        contextObservationReceiptExpectations: contract.contextObservationReceiptExpectations || {},
        integrationExpectation,
        baseIntegration: input.baseIntegration || (workPackage.deliverableKind === "patch"
          ? { integrated: false, blocker: "verified-primary-patch-integration-receipt-missing" }
          : { integrated: true, typedDeliverable: true }),
      }),
    };
  } catch (error) {
    if (isStaleDirectorResult(error)) {
      return { integrated: false, stale: true, reconciled: false, blocker: error.message, jobId: input.jobId, workPackageId };
    }
    recordProgramFailure(readTask(task.taskId), workPackage, error.message, {
      jobId: input.jobId,
      provider: contract.provider,
      model: contract.model,
      summary: handoff.summary,
      assurance: error.assurance || null,
    });
    return { integrated: false, reconciled: true, blocker: error.message, jobId: input.jobId, workPackageId };
  }
}

function adoptPreservedOperationResult(input = {}) {
  const taskId = String(input.taskId || "").trim();
  const jobId = String(input.jobId || "").trim();
  if (!taskId || !jobId) throw new Error("taskId and jobId are required");
  const task = readTask(taskId);
  if (!isDirectorTask(task)) throw new Error("Task is not a Director-CFO program.");
  const dir = jobDirectory(taskId, jobId);
  const contract = readJson(path.join(dir, "contract.json"), {});
  const status = readJson(path.join(dir, "status.json"), {});
  const handoff = readJson(path.join(dir, "handoff.json"), {});
  const workPackageId = contract.directorProgram?.workPackageId || input.workPackageId;
  const priorRecovery = (task.program.resultRecoveries || []).find((row) => (
    row.jobId === jobId && row.workPackageId === workPackageId && row.state === "adopted"
  ));
  if (priorRecovery) {
    return { adopted: true, alreadyAdopted: true, taskId, jobId, workPackageId, recovery: priorRecovery };
  }
  const originalBlocker = String(status.blocker || handoff.blocker || "");
  if (status.state !== "failed" || handoff.state !== "failed" || !originalBlocker.startsWith("typed-deliverable-invalid:")) {
    throw new Error("preserved-operation-not-eligible: expected a typed-deliverable terminal failure");
  }
  const validation = validateTypedDeliverable(contract, {
    artifact: handoff.artifact,
    deliverable: handoff.artifact,
    verification: handoff.verification,
  });
  if (!validation.ok || validation.kind !== "operation-receipt") {
    throw new Error(`preserved-operation-invalid: ${validation.blocker || "operation receipt did not validate"}`);
  }
  const revisionFence = contract.directorProgram?.revisionFence || contract.revisionFence;
  const adoptedAt = utcNow();
  const updated = updateTask(taskId, (current) => {
    const activePackage = selectDirectorPackage(current.program.workPackages, workPackageId, { jobId, revisionFence });
    if (activePackage.state !== "failed") {
      throw new Error(`preserved-operation-not-eligible: work package is ${activePackage.state}`);
    }
    const currentState = normalizeProgramState(current.program.contracts);
    const canonicalPackage = selectDirectorPackage(currentState.workPackages, workPackageId, { revisionFence });
    assertIntegrationFence(revisionFence, {
      mission: currentState.mission,
      contextDossier: currentState.contextDossier,
      masterPlan: currentState.masterPlan,
      resourceBudget: currentState.resourceBudget,
      campaign: currentState.campaign,
    });
    const generatedReconciliations = current.program.workPackages.filter((row) => (
      row.executorKind === "reconciliation"
      && row.failedWorkPackageId === workPackageId
      && row.failurePacket?.attemptId === jobId
      && ["pending", "ready"].includes(row.state)
    ));
    if (generatedReconciliations.length !== 1) {
      throw new Error("preserved-operation-not-eligible: exact untouched reconciliation package is required");
    }
    const laterExecution = current.program.workPackages.find((row) => (
      row.workPackageId !== workPackageId
      && row.state === "completed"
      && (row.dependencies || []).includes(workPackageId)
    ));
    if (laterExecution) {
      throw new Error(`preserved-operation-not-eligible: dependent package already completed (${laterExecution.workPackageId})`);
    }
    const adoptedHandoff = {
      ...handoff,
      state: "completed",
      blocker: "",
      artifact: validation.deliverable,
      deliverable: validation.deliverable,
      deliverableValidation: validation,
      usage: readJson(path.join(dir, "usage.json"), {}),
    };
    const integratingPackage = { ...activePackage, state: "running" };
    const executionReceipt = canonicalExecutionReceipt(current, integratingPackage, canonicalPackage, adoptedHandoff, jobId);
    assertExecutionReceiptIntegrable(currentState, canonicalPackage, executionReceipt);
    const evidenceRows = executionReceiptEvidence(
      { ...integratingPackage, state: "completed", executionReceiptId: executionReceipt.receiptId },
      executionReceipt,
    );
    recordAcceptanceEvidence(current, evidenceRows);
    const reconciliationIds = new Set(generatedReconciliations.map((row) => row.workPackageId));
    let workPackages = current.program.workPackages
      .filter((row) => !reconciliationIds.has(row.workPackageId))
      .map((row) => sameDirectorPackage(row, activePackage)
        ? {
          ...row,
          state: "completed",
          blocker: "",
          lastFailure: null,
          completedAt: adoptedAt,
          executionReceiptId: executionReceipt.receiptId,
          resultAdoption: { jobId, fingerprint: validation.fingerprint, adoptedAt },
        }
        : row);
    current.program = {
      ...current.program,
      phase: "execution",
      state: "active",
      workPackages,
      masterPlan: advancePlanState(current.program.masterPlan, workPackages),
      executionReceipts: [...(current.program.executionReceipts || []), executionReceipt].slice(-1000),
      evidenceLedger: evidenceRows.reduce(
        (ledger, row) => appendProgramEvidence({ evidenceLedger: ledger }, row),
        current.program.evidenceLedger,
      ),
      failureMemory: (current.program.failureMemory || []).filter((row) => !(row.workPackageId === workPackageId && row.attemptId === jobId)),
      resultRecoveries: [...(current.program.resultRecoveries || []), {
        state: "adopted",
        taskId,
        jobId,
        workPackageId,
        originalBlocker,
        validationFingerprint: validation.fingerprint,
        revisionFenceFingerprint: revisionFence?.fingerprint || "",
        adoptedAt,
      }].slice(-100),
      activeCampaign: null,
      nextAction: "Continue with the highest-value dependency-ready package under a fresh resource check.",
      updatedAt: adoptedAt,
    };
    current.workGraph = (current.workGraph || [])
      .filter((node) => !reconciliationIds.has(node.id))
      .map((node) => node.id === workPackageId
        ? {
          ...node,
          state: "completed",
          owner: null,
          lastFailure: "",
          evidenceRefs: [
            ...(node.evidenceRefs || []),
            `director-result-adoption:${jobId}:${validation.fingerprint}`,
            ...evidenceRows.map((row) => row.ref),
          ].slice(-20),
        }
        : node);
    return current;
  });

  let recoveredRoundId = "";
  for (const row of [...(updated.rounds || [])].reverse()) {
    let round;
    try {
      round = readRound(taskId, row.roundId);
    } catch {
      continue;
    }
    if (!(round.jobs || []).some((job) => job.jobId === jobId)) continue;
    recoveredRoundId = round.roundId;
    updateRound(taskId, round.roundId, {
      state: "integrated",
      integratedAt: adoptedAt,
      settledAt: adoptedAt,
      integrationResults: (round.integrationResults || []).map((result) => result.jobId === jobId
        ? {
          ...result,
          integrated: true,
          reconciled: false,
          recovered: true,
          blocker: "",
          adoptionFingerprint: validation.fingerprint,
        }
        : result),
    });
    break;
  }
  const adoption = {
    schemaVersion: 1,
    state: "adopted",
    taskId,
    jobId,
    workPackageId,
    roundId: recoveredRoundId,
    originalBlocker,
    validation,
    adoptedAt,
  };
  writeJson(path.join(dir, "operation-result-adoption.json"), adoption);
  return {
    adopted: true,
    alreadyAdopted: false,
    taskId,
    jobId,
    workPackageId,
    roundId: recoveredRoundId,
    validationFingerprint: validation.fingerprint,
    contextRevision: updated.program.contextDossier?.contextRevision || 0,
    planRevision: updated.program.masterPlan?.planRevision || 0,
    nextAction: updated.program.nextAction,
  };
}

function recoverFailedPackageAfterRuntimeRepair(input = {}) {
  const taskId = String(input.taskId || "").trim();
  const jobId = String(input.jobId || "").trim();
  const repairEvidence = boundedList(input.repairEvidence, 20, 1200);
  if (!taskId || !jobId) throw new Error("taskId and jobId are required");
  if (!repairEvidence.length) throw new Error("runtime repair evidence is required");
  const task = readTask(taskId);
  if (!isDirectorTask(task)) throw new Error("Task is not a Director-CFO program.");
  const priorRecovery = (task.program.runtimeRecoveries || []).find((row) => row.jobId === jobId && row.state === "retry-admitted");
  if (priorRecovery) return { recovered: true, alreadyRecovered: true, ...priorRecovery };
  const dir = jobDirectory(taskId, jobId);
  const contract = readJson(path.join(dir, "contract.json"), {});
  const status = readJson(path.join(dir, "status.json"), {});
  const handoff = readJson(path.join(dir, "handoff.json"), {});
  const workPackageId = contract.directorProgram?.workPackageId || input.workPackageId;
  const blocker = String(status.blocker || handoff.blocker || "");
  if (
    status.state !== "failed"
    || handoff.state !== "failed"
    || !/^authorization-required:/i.test(blocker)
    || !/no output produced|auto-denied|cannot prompt/i.test(blocker)
    || (handoff.changedFiles || []).length
  ) {
    throw new Error("runtime-repair-recovery-ineligible: expected an authorization failure before any output or project change");
  }
  const preflight = contract.permissionPreflight || {};
  const grants = new Set(contract.permissionGrant || []);
  if (
    preflight.ok !== true
    || String(preflight.blocker || "").trim()
    || ["missingCapabilities", "missingAuthorization", "missingGrant", "missingProviderPermissions", "invalidSideEffectContract"]
      .some((field) => (preflight[field] || []).length)
    || (contract.requiredPermissions || []).some((permission) => !grants.has(permission))
  ) {
    throw new Error("runtime-repair-recovery-ineligible: original Director permission preflight was not exact and successful");
  }
  const priorRuntimeFingerprint = String(
    input.priorRuntimeFingerprint
    || task.program.runtime?.programSupervisor?.recoveryFence?.runtimeBuildFingerprint
    || "",
  ).trim();
  const repairedRuntimeFingerprint = runtimeFingerprint();
  if (!priorRuntimeFingerprint || priorRuntimeFingerprint === repairedRuntimeFingerprint) {
    throw new Error("runtime-repair-recovery-ineligible: runtime build fingerprint did not materially change");
  }
  const recoveredAt = utcNow();
  const updated = updateTask(taskId, (current) => {
    const failedPackage = selectDirectorPackage(current.program.workPackages, workPackageId, { jobId });
    if (failedPackage.state !== "failed") throw new Error(`runtime-repair-recovery-ineligible: work package is ${failedPackage.state}`);
    const generatedReconciliations = current.program.workPackages.filter((row) => (
      row.executorKind === "reconciliation"
      && row.failedWorkPackageId === workPackageId
      && row.failurePacket?.attemptId === jobId
      && row.failurePacket?.failureClass === "permission-or-tool"
      && ["pending", "ready"].includes(row.state)
    ));
    if (generatedReconciliations.length !== 1) {
      throw new Error("runtime-repair-recovery-ineligible: exact untouched permission reconciliation package is required");
    }
    const reconciliationIds = new Set(generatedReconciliations.map((row) => row.workPackageId));
    let workPackages = current.program.workPackages
      .filter((row) => !reconciliationIds.has(row.workPackageId))
      .map((row) => sameDirectorPackage(row, failedPackage)
        ? {
          ...row,
          state: "pending",
          jobId: null,
          allocation: null,
          permissionPreflight: null,
          revisionFence: null,
          canonicalContract: null,
          blocker: "",
          lastFailure: null,
          runtimeRepair: {
            priorRuntimeFingerprint,
            repairedRuntimeFingerprint,
            failedJobId: jobId,
            evidence: repairEvidence,
            recoveredAt,
          },
        }
        : row);
    current.program = {
      ...current.program,
      phase: "execution",
      state: "active",
      workPackages,
      masterPlan: advancePlanState(current.program.masterPlan, workPackages),
      failureMemory: (current.program.failureMemory || []).filter((row) => !(row.workPackageId === workPackageId && row.attemptId === jobId)),
      runtimeRecoveries: [...(current.program.runtimeRecoveries || []), {
        schemaVersion: 1,
        state: "retry-admitted",
        taskId,
        workPackageId,
        jobId,
        priorRuntimeFingerprint,
        repairedRuntimeFingerprint,
        evidence: repairEvidence,
        recoveredAt,
      }].slice(-100),
      activeCampaign: null,
      nextAction: "Rebudget and retry only the failed package against the repaired runtime.",
      updatedAt: recoveredAt,
    };
    current.workGraph = (current.workGraph || [])
      .filter((node) => !reconciliationIds.has(node.id))
      .map((node) => node.id === workPackageId
        ? { ...node, state: "pending", owner: null, lastFailure: "" }
        : node);
    return current;
  });
  return {
    recovered: true,
    alreadyRecovered: false,
    taskId,
    workPackageId,
    jobId,
    priorRuntimeFingerprint,
    repairedRuntimeFingerprint,
    contextRevision: updated.program.contextDossier?.contextRevision || 0,
    planRevision: updated.program.masterPlan?.planRevision || 0,
    nextAction: updated.program.nextAction,
  };
}

function adoptPreservedPatchAfterVerificationRepair(input = {}) {
  const taskId = String(input.taskId || "").trim();
  const jobId = String(input.jobId || "").trim();
  const repairEvidence = boundedList(input.repairEvidence, 20, 1200);
  if (!taskId || !jobId) throw new Error("taskId and jobId are required");
  if (!repairEvidence.length) throw new Error("verification repair evidence is required");
  let task = readTask(taskId);
  if (!isDirectorTask(task)) throw new Error("Task is not a Director-CFO program.");
  const priorRecovery = (task.program.resultRecoveries || []).find((row) => row.jobId === jobId && row.state === "patch-adopted");
  if (priorRecovery) return { adopted: true, alreadyAdopted: true, ...priorRecovery };
  const dir = jobDirectory(taskId, jobId);
  const contract = readJson(path.join(dir, "contract.json"), {});
  const status = readJson(path.join(dir, "status.json"), {});
  const handoff = readJson(path.join(dir, "handoff.json"), {});
  const workPackageId = contract.directorProgram?.workPackageId || input.workPackageId;
  const revisionFence = contract.directorProgram?.revisionFence || contract.revisionFence;
  const priorRuntimeFingerprint = String(
    input.priorRuntimeFingerprint
    || task.program.runtime?.programSupervisor?.recoveryFence?.runtimeBuildFingerprint
    || "",
  ).trim();
  const repairedRuntimeFingerprint = runtimeFingerprint();
  const preservedVerificationRecovery = {
    priorRuntimeFingerprint,
    repairedRuntimeFingerprint,
    evidence: repairEvidence,
  };
  if (!priorRuntimeFingerprint || priorRuntimeFingerprint === repairedRuntimeFingerprint) {
    throw new Error("preserved-patch-ineligible: verification runtime fingerprint did not materially change");
  }
  const recoveredAt = utcNow();
  updateTask(taskId, (current) => {
    const failedPackage = selectDirectorPackage(current.program.workPackages, workPackageId, { jobId, revisionFence });
    if (failedPackage.state !== "failed") throw new Error(`preserved-patch-ineligible: work package is ${failedPackage.state}`);
    const generatedReconciliations = current.program.workPackages.filter((row) => (
      row.executorKind === "reconciliation"
      && row.failedWorkPackageId === workPackageId
      && row.failurePacket?.attemptId === jobId
      && (
        row.failurePacket?.failureClass === "verification"
        || String(row.failurePacket?.blocker || "") === "integration-finalization-failed: verified-primary-patch-integration-receipt-required"
      )
      && ["pending", "ready"].includes(row.state)
    ));
    if (generatedReconciliations.length !== 1) {
      throw new Error("preserved-patch-ineligible: exact untouched verification reconciliation package is required");
    }
    const reconciliationIds = new Set(generatedReconciliations.map((row) => row.workPackageId));
    current.program = {
      ...current.program,
      phase: "execution",
      state: "active",
      workPackages: current.program.workPackages
        .filter((row) => !reconciliationIds.has(row.workPackageId))
        .map((row) => sameDirectorPackage(row, failedPackage)
          ? { ...row, state: "running", blocker: "", lastFailure: null }
          : row),
      failureMemory: (current.program.failureMemory || []).filter((row) => !(row.workPackageId === workPackageId && row.attemptId === jobId)),
      activeCampaign: null,
      nextAction: "Integrate the preserved patch after repaired deterministic verification.",
      updatedAt: recoveredAt,
    };
    current.workGraph = (current.workGraph || [])
      .filter((node) => !reconciliationIds.has(node.id))
      .map((node) => node.id === workPackageId
        ? { ...node, state: "running", owner: jobId, lastFailure: "" }
        : node);
    return current;
  });

  let directorIntegration = null;
  const baseIntegration = integrateJob(taskId, jobId, {
    preservedVerificationRecovery,
    beforeApply: () => assertDirectorIntegrationReady(taskId, workPackageId, { jobId, revisionFence }),
    finalize: (verifiedIntegration) => {
      const current = readTask(taskId);
      const activePackage = selectDirectorPackage(current.program.workPackages, workPackageId, { jobId, revisionFence });
      const adoptedHandoff = {
        ...handoff,
        state: "completed",
        blocker: "",
        verification: verifiedIntegration.verification,
        usage: readJson(path.join(dir, "usage.json"), {}),
      };
      const updated = integrateExecutionResult(
        current,
        activePackage,
        adoptedHandoff,
        verifiedIntegration,
        jobId,
        { jobId, revisionFence },
      );
      directorIntegration = { integrated: true, phase: updated.program.phase };
    },
  });
  if (baseIntegration.integrated !== true || directorIntegration?.integrated !== true) {
    task = readTask(taskId);
    const activePackage = task.program.workPackages.find((row) => row.workPackageId === workPackageId && row.jobId === jobId);
    if (activePackage && activePackage.state === "running") {
      recordProgramFailure(task, activePackage, baseIntegration.blocker || "preserved-patch-integration-failed", {
        jobId,
        provider: contract.provider,
        model: contract.model,
        summary: handoff.summary,
        verification: baseIntegration.verification || null,
      });
    }
    throw new Error(baseIntegration.blocker || "preserved-patch-integration-failed");
  }

  const completedAt = utcNow();
  const updated = updateTask(taskId, (current) => {
    current.program = {
      ...current.program,
      resultRecoveries: [...(current.program.resultRecoveries || []), {
        schemaVersion: 1,
        state: "patch-adopted",
        taskId,
        workPackageId,
        jobId,
        priorRuntimeFingerprint,
        repairedRuntimeFingerprint,
        evidence: repairEvidence,
        integratedFiles: baseIntegration.changedFiles || [],
        completedAt,
      }].slice(-100),
      updatedAt: completedAt,
    };
    return current;
  });
  let recoveredRoundId = "";
  for (const row of [...(updated.rounds || [])].reverse()) {
    let round;
    try {
      round = readRound(taskId, row.roundId);
    } catch {
      continue;
    }
    if (!(round.jobs || []).some((job) => job.jobId === jobId)) continue;
    recoveredRoundId = round.roundId;
    updateRound(taskId, round.roundId, {
      state: "integrated",
      integratedAt: completedAt,
      settledAt: completedAt,
      integrationResults: (round.integrationResults || []).map((result) => result.jobId === jobId
        ? { ...result, integrated: true, reconciled: false, recovered: true, blocker: "" }
        : result),
    });
    break;
  }
  const adoption = {
    schemaVersion: 1,
    state: "patch-adopted",
    taskId,
    jobId,
    workPackageId,
    roundId: recoveredRoundId,
    priorRuntimeFingerprint,
    repairedRuntimeFingerprint,
    repairEvidence,
    integration: baseIntegration,
    completedAt,
  };
  writeJson(path.join(dir, "patch-result-adoption.json"), adoption);
  return {
    adopted: true,
    alreadyAdopted: false,
    taskId,
    jobId,
    workPackageId,
    roundId: recoveredRoundId,
    changedFiles: baseIntegration.changedFiles || [],
    verification: baseIntegration.verification,
    phase: updated.program.phase,
    nextAction: updated.program.nextAction,
  };
}

function programRecommendedOrPending(task) {
  const ready = programRecommendedWorkUnits(task);
  if (ready.length) return ready;
  if (!isDirectorTask(task) || ["blocked", "completed"].includes(task.program.phase)) return [];
  return readyPackageRows(task.program).map((row) => ({
    ...row,
    workGraphNodeId: row.workPackageId,
    independenceReason: "This package is dependency-ready and awaits current capacity budgeting.",
    workPlaneRequired: true,
    budgetPending: true,
  }));
}

function directorExecution(task) {
  const program = task.program;
  const units = programRecommendedOrPending(task);
  const blocked = program.state === "blocked" || program.phase === "blocked" || (program.phase === "awaiting-evidence" && units.length === 0);
  return {
    mode: PROGRAM_MODE,
    status: task.state === "completed" ? "completed" : units.length ? "dispatch-required" : blocked ? "blocked" : "waiting",
    owner: blocked ? "director" : "coordinator",
    action: program.nextAction,
    workPlaneAction: units.map((row) => row.goal).join(" | "),
    mustDispatchNow: task.state !== "completed" && units.length > 0,
    mustStartNow: false,
    userActionRequired: blocked && /user|authorization|credential|decision/i.test(program.nextAction || ""),
    mayEndTurn: units.length === 0,
    reporting: {
      when: ["assignment", "accepted evidence", "new blocker", "reconciliation", "campaign boundary"],
      format: "Goal / Milestone / Progress / Blockers / Budget / Next",
    },
  };
}

function directorProgramSummary(taskValue) {
  const task = typeof taskValue === "string" ? readTask(taskValue) : taskValue;
  if (!isDirectorTask(task)) return null;
  const report = buildProgramReport(task, { nextAction: task.program.nextAction });
  return {
    programId: task.program.programId,
    mode: PROGRAM_MODE,
    phase: task.program.phase,
    state: task.program.state,
    mission: {
      missionId: task.program.mission.missionId,
      revision: task.program.mission.revision,
      outcome: task.program.mission.outcome,
    },
    context: task.program.contextDossier ? {
      revision: task.program.contextDossier.contextRevision,
      fingerprint: task.program.contextDossier.contextFingerprint,
    } : null,
    plan: task.program.masterPlan ? {
      revision: task.program.masterPlan.planRevision,
      fingerprint: task.program.masterPlan.planFingerprint,
      milestones: task.program.masterPlan.milestones.length,
      workstreams: task.program.masterPlan.workstreams.length,
    } : null,
    budget: task.program.runtime?.budget ? {
      revision: task.program.runtime.budget.budgetRevision,
      allocations: task.program.runtime.budget.allocations.length,
      deferred: task.program.runtime.budget.deferred,
      reserves: task.program.runtime.budget.reserves,
    } : null,
    campaign: task.program.activeCampaign,
    workPackages: (task.program.workPackages || []).map((row) => ({
      workPackageId: row.workPackageId,
      executorKind: row.executorKind,
      deliverableKind: row.deliverableKind,
      state: row.state,
      provider: row.allocation?.provider || null,
      model: row.allocation?.model || null,
      blocker: row.blocker || row.lastFailure?.blocker || null,
    })),
    failures: (task.program.failureMemory || []).slice(-5),
    execution: directorExecution(task),
    report,
    nextAction: task.program.nextAction,
  };
}

function emitProgramReport(taskId) {
  const task = readTask(taskId);
  if (!isDirectorTask(task)) throw new Error("Task is not a Director-CFO program.");
  const report = buildProgramReport(task, { nextAction: task.program.nextAction });
  const transition = reportTransition(task.program.reportCursor || {}, report);
  if (!transition.emit) return transition;
  updateTask(task.taskId, (current) => {
    current.program = { ...current.program, reportCursor: transition.cursor, updatedAt: utcNow() };
    return current;
  });
  return transition;
}

module.exports = {
  PROGRAM_MODE,
  adoptPreservedPatchAfterVerificationRepair,
  adoptPreservedOperationResult,
  directorExecution,
  directorProgramSummary,
  emitProgramReport,
  estimatedAntigravityQuotaPercent,
  assertDirectorIntegrationReady,
  integrateDirectorArtifact,
  integrateDirectorJob,
  isDirectorTask,
  migrateLegacyTaskToDirector,
  prepareProgramDispatch,
  programJobContract,
  programRecommendedWorkUnits,
  programRecommendedOrPending,
  recoverFailedPackageAfterRuntimeRepair,
  reviseAuthorizedOperation,
  reconcileDirectorProgram,
  repairDirectorLegacyRounds,
  recordProgramFailure,
  startDirectorProgram,
  terminalDirectorContracts,
};
