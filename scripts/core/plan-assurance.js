"use strict";

const { bounded, boundedList } = require("./utils");
const { fingerprint } = require("./source-catalog");
const {
  CANONICAL_CALLABLE_CAPABILITIES,
  CANONICAL_PERMISSIONS,
  canonicalCapabilityName,
  canonicalPermissionName,
} = require("./team-compiler");

const WORK_TYPES = new Set(["context", "strategy", "code", "operation", "browser", "external", "data", "monitoring", "verification", "reconciliation", "generic"]);
const EVIDENCE_LEVELS = new Set(["activity", "process-health", "focused-test", "integration", "end-to-end", "user-visible"]);
const PERMISSION_MODES = new Set(["read", "write", "execute", "observe", "external", "admin"]);
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
const DELIVERABLE_BY_EXECUTOR = Object.freeze(Object.fromEntries(Object.values(EXECUTION_BY_WORK_TYPE).map(([executor, deliverable]) => [executor, deliverable])));
const EXECUTOR_KINDS = new Set(Object.keys(DELIVERABLE_BY_EXECUTOR));
const DELIVERABLE_KINDS = new Set(Object.values(DELIVERABLE_BY_EXECUTOR));

function schemaText(maxLength, options = {}) {
  const schema = { type: 'string', maxLength };
  if (options.required !== false) schema.minLength = 1;
  if (options.constValue) schema.const = options.constValue;
  if (options.enumValues) schema.enum = options.enumValues;
  return schema;
}

function schemaArray(items, options = {}) {
  const schema = { type: 'array', items };
  if (options.minItems !== undefined) schema.minItems = options.minItems;
  if (options.maxItems !== undefined) schema.maxItems = options.maxItems;
  if (options.contains) schema.contains = options.contains;
  return schema;
}

function strictObject(properties, required = Object.keys(properties)) {
  return { type: 'object', additionalProperties: false, properties, required };
}

function schemaStrings(maxItems, maxLength, options = {}) {
  return schemaArray(schemaText(maxLength, options.enumValues ? { enumValues: options.enumValues } : {}), { minItems: options.minItems || 0, maxItems });
}

function schemaCommands() {
  return schemaArray(strictObject({
    command: schemaText(500),
    args: schemaArray({ type: 'string', maxLength: 500 }, { maxItems: 40 }),
    timeoutSeconds: { type: 'number', exclusiveMinimum: 0, maximum: 3600 },
    cwd: schemaText(500, { required: false }),
  }, ['command', 'args', 'timeoutSeconds']), { maxItems: 12 });
}

function resolveMinimumPlanRevision(expected = {}) {
  const value = expected.minimumPlanRevision;
  if (value === undefined || value === null || value === "") return 1;
  const revision = Number(value);
  if (!Number.isInteger(revision) || revision < 1) throw new Error("minimumPlanRevision must be a positive integer.");
  return revision;
}

function requiredExecutorKindsForRequirement(row = {}) {
  const explicit = boundedList(row.requiredExecutorKinds || row.required_executor_kinds, 8, 80)
    .map((value) => String(value).trim().toLowerCase())
    .filter((value) => EXECUTOR_KINDS.has(value));
  if (explicit.length) return [...new Set(explicit)];
  const blocker = typeof row.blocker === "string" ? row.blocker : JSON.stringify(row.blocker || {});
  const text = String(row.description || "") + " " + blocker;
  if (/implementation(?:-and-test)?|code change|parser|fixture|focused test paths?/i.test(text)) return ["code-change"];
  if (/guarded (?:plan )?repair|restart (?:the )?(?:runner|service)|service control|database repair/i.test(text)) return ["operational-transaction"];
  return [];
}

function snapshotReconciliationDirective(value) {
  if (value === undefined || value === null) return undefined;
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch (error) {
    throw new Error(`reconciliationDirective must be JSON-serializable: ${error.message}`);
  }
  if (!serialized || serialized.length > 16000) {
    throw new Error("reconciliationDirective must be non-empty and no larger than 16000 serialized characters.");
  }
  return JSON.parse(serialized);
}

function masterPlanJsonSchema(expected = {}) {
  const minimumPlanRevision = resolveMinimumPlanRevision(expected);
  const availableSourceFiles = boundedList(expected.availableSourceFiles, 500, 500);
  const identifier = (constValue) => ({
    type: 'string',
    minLength: 2,
    maxLength: 100,
    pattern: '^[A-Za-z][A-Za-z0-9._:-]{1,99}$',
    ...(constValue ? { const: constValue } : {}),
  });
  const authoritativeRequirements = (expected.authoritativeRequirements || [])
    .filter((row) => row && row.required !== false && String(row.status || "").toLowerCase() !== "passing")
    .map((row) => ({
      id: cleanId(row.id),
      minimumEvidenceLevel: String(row.minimumEvidenceLevel || row.minimum_evidence_level || "integration").trim().toLowerCase(),
      requiredExecutorKinds: requiredExecutorKindsForRequirement(row),
    }))
    .filter((row) => row.id);
  const authoritativeRequirementIds = authoritativeRequirements.map((row) => row.id);
  const acceptanceRequirementRef = authoritativeRequirementIds.length
    ? schemaText(100, { enumValues: authoritativeRequirementIds })
    : identifier();
  const execution = strictObject({
    executorKind: schemaText(80, { enumValues: [...EXECUTOR_KINDS] }),
    deliverableKind: schemaText(80, { enumValues: [...DELIVERABLE_KINDS] }),
    relevantFiles: schemaStrings(80, 500, availableSourceFiles.length ? { enumValues: availableSourceFiles } : {}),
    expectedFiles: schemaStrings(80, 500),
    verificationCommands: schemaCommands(),
    requiredCapabilities: schemaStrings(30, 120, { enumValues: CANONICAL_CALLABLE_CAPABILITIES }),
    requiredPermissions: schemaStrings(30, 120, { enumValues: CANONICAL_PERMISSIONS }),
    preconditions: schemaStrings(30, 1000),
    postconditions: schemaStrings(30, 1000),
    commands: schemaCommands(),
    rollback: {
      anyOf: [
        { type: 'null' },
        strictObject({
          description: schemaText(1200, { required: false }),
          commands: schemaCommands(),
        }),
      ],
    },
    recoveryAction: schemaText(1200, { required: false }),
    mutatesExternalState: { type: 'boolean' },
    sideEffectKey: schemaText(240, { required: false }),
    observedStateFingerprint: schemaText(180, { required: false }),
    userAuthorizationRef: schemaText(500, { required: false }),
    successProbability: { type: 'number', exclusiveMinimum: 0, maximum: 1 },
  });
  const workstream = strictObject({
    id: identifier(),
    outcome: schemaText(2000),
    workType: schemaText(80, { enumValues: [...WORK_TYPES] }),
    milestoneIds: schemaStrings(30, 100, { minItems: 1 }),
    dependsOn: schemaStrings(30, 100),
    teamRoleIds: schemaStrings(30, 100, { minItems: 1 }),
    permissionIds: schemaStrings(30, 100, { minItems: 1 }),
    evidenceRequirementIds: schemaStrings(30, 100, { minItems: 1 }),
    resourceEstimateId: identifier(),
    execution,
  });
  workstream.allOf = [{
    if: {
      anyOf: [
        { required: ["workType"], properties: { workType: { const: "code" } } },
        { required: ["execution"], properties: { execution: { required: ["executorKind"], properties: { executorKind: { const: "code-change" } } } } },
      ],
    },
    then: {
      properties: {
        execution: {
          required: ["expectedFiles", "verificationCommands"],
          properties: {
            expectedFiles: { minItems: 1 },
            verificationCommands: { minItems: 1 },
          },
        },
      },
    },
    else: {
      properties: {
        execution: {
          required: ["expectedFiles"],
          properties: {
            expectedFiles: { maxItems: 0 },
          },
        },
      },
    },
  }];
  const resourceEstimate = strictObject({
    id: identifier(),
    workstreamId: identifier(),
    modelClass: schemaText(100),
    attempts: { type: 'integer', minimum: 1 },
    inputTokens: { type: 'number', minimum: 0 },
    outputTokens: { type: 'number', minimum: 0 },
    wallClockMinutes: { type: 'number', exclusiveMinimum: 0 },
    concurrency: { type: 'integer', minimum: 1 },
    ramMb: { type: 'number', minimum: 0 },
    diskMb: { type: 'number', minimum: 0 },
    includesVerification: { type: 'boolean' },
    includesReconciliationReserve: { type: 'boolean' },
  });
  const evidenceRequirementSchema = strictObject({
    id: identifier(),
    milestoneId: identifier(),
    description: schemaText(1200),
    level: schemaText(40, { enumValues: [...EVIDENCE_LEVELS] }),
    proofType: schemaText(160),
    verifierRoleId: identifier(),
    acceptanceRequirementIds: schemaArray(acceptanceRequirementRef, { minItems: 1, maxItems: 30 }),
  });
  const evidenceRequirementsSchema = schemaArray(evidenceRequirementSchema, { minItems: 1 });
  const workstreamsSchema = schemaArray(workstream, { minItems: 1 });
  workstreamsSchema.allOf = authoritativeRequirements.flatMap((requirement) => requirement.requiredExecutorKinds.map((executorKind) => ({
    contains: {
      type: "object",
      required: ["execution"],
      properties: {
        execution: {
          type: "object",
          required: ["executorKind"],
          properties: { executorKind: { const: executorKind } },
        },
      },
    },
  })));
  const evidenceLevels = [...EVIDENCE_LEVELS];
  evidenceRequirementsSchema.allOf = authoritativeRequirements.map((requirement) => {
    const minimumRank = evidenceLevels.indexOf(requirement.minimumEvidenceLevel);
    const allowedLevels = minimumRank < 0 ? [] : evidenceLevels.slice(minimumRank);
    return {
      contains: {
        type: "object",
        required: ["level", "acceptanceRequirementIds"],
        properties: {
          level: { enum: allowedLevels },
          acceptanceRequirementIds: { type: "array", contains: { const: requirement.id } },
        },
      },
    };
  });
  return strictObject({
    schemaVersion: { type: 'string', const: 'director-cfo/master-plan@1' },
    planRevision: { type: 'integer', minimum: minimumPlanRevision },
    mission: strictObject({
      id: identifier(expected.missionId),
      revision: expected.missionRevision
        ? { type: 'integer', const: Number(expected.missionRevision) }
        : { type: 'integer', minimum: 1 },
      outcome: schemaText(6000),
    }),
    context: strictObject({
      revision: expected.contextRevision
        ? { type: 'integer', const: Number(expected.contextRevision) }
        : { type: 'integer', minimum: 1 },
      fingerprint: schemaText(128, expected.contextFingerprint ? { constValue: expected.contextFingerprint } : {}),
    }),
    objective: schemaText(6000),
    timeline: strictObject({
      totalEstimatedMinutes: { type: 'number', exclusiveMinimum: 0 },
      assumptions: schemaStrings(20, 600),
      windows: schemaArray(strictObject({
        milestoneId: identifier(),
        startAfterMinute: { type: 'number', minimum: 0 },
        durationMinutes: { type: 'number', exclusiveMinimum: 0 },
      }), { minItems: 1 }),
    }),
    milestones: schemaArray(strictObject({
      id: identifier(),
      outcome: schemaText(2000),
      dependsOn: schemaStrings(30, 100),
      workstreamIds: schemaStrings(30, 100, { minItems: 1 }),
      evidenceRequirementIds: schemaStrings(30, 100, { minItems: 1 }),
      acceptanceCriteria: schemaStrings(20, 1000, { minItems: 1 }),
    }), { minItems: 1 }),
    dependencies: schemaArray(strictObject({
      id: identifier(),
      fromMilestoneId: identifier(),
      toMilestoneId: identifier(),
      condition: schemaText(1000),
    })),
    workstreams: workstreamsSchema,
    team: strictObject({
      roles: schemaArray(strictObject({
        id: identifier(),
        title: schemaText(200),
        modelClass: schemaText(100),
        capabilities: schemaStrings(30, 120, { minItems: 1 }),
        responsibilities: schemaStrings(30, 600, { minItems: 1 }),
        workstreamIds: schemaStrings(30, 100, { minItems: 1 }),
        permissionIds: schemaStrings(30, 100, { minItems: 1 }),
      }), { minItems: 1 }),
    }),
    permissions: schemaArray(strictObject({
      id: identifier(),
      capability: schemaText(200),
      mode: schemaText(40, { enumValues: [...PERMISSION_MODES] }),
      scope: schemaText(1000),
      reason: schemaText(1000),
      required: { type: 'boolean' },
    }), { minItems: 1 }),
    risks: schemaArray(strictObject({
      id: identifier(),
      description: schemaText(1200),
      likelihood: schemaText(40),
      impact: schemaText(40),
      ownerRoleId: identifier(),
      trigger: schemaText(1000),
      mitigation: schemaText(1200),
    }), { minItems: 1 }),
    recovery: schemaArray(strictObject({
      id: identifier(),
      trigger: schemaText(1000),
      failureClasses: schemaStrings(20, 100, { minItems: 1 }),
      action: schemaText(1600),
      ownerRoleId: identifier(),
      evidenceRequirementId: identifier(),
    }), { minItems: 1 }),
    evidenceRequirements: evidenceRequirementsSchema,
    resourceEstimates: schemaArray(resourceEstimate, {
      minItems: 1,
      contains: {
        type: 'object',
        required: ['includesReconciliationReserve'],
        properties: { includesReconciliationReserve: { const: true } },
      },
    }),
  });
}
function cleanId(value) {
  const cleaned = String(value || "").trim().replace(/[^A-Za-z0-9._:-]+/g, "-").replace(/^-|-$/g, "");
  if (!cleaned) return "";
  const prefixed = /^[A-Za-z]/.test(cleaned) ? cleaned : `id-${cleaned}`;
  return prefixed.slice(0, 100);
}

function rows(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeCommand(row = {}) {
  return {
    command: bounded(row?.command || "", 500).trim(),
    args: rows(row?.args).slice(0, 40).map((value) => bounded(String(value), 500)),
    timeoutSeconds: Number(row?.timeoutSeconds || 0),
    cwd: bounded(row?.cwd || "", 500).trim(),
  };
}

function normalizeCommands(value) {
  return rows(value).slice(0, 12).map(normalizeCommand);
}

function normalizeRollback(value) {
  if (!value) return null;
  if (typeof value === "string") return { description: bounded(value, 1200).trim(), commands: [] };
  if (typeof value !== "object" || Array.isArray(value)) return null;
  return {
    description: bounded(value.description || value.action || "", 1200).trim(),
    commands: normalizeCommands(value.commands),
  };
}

function normalizeExecution(row = {}, workType = "generic") {
  const fallback = EXECUTION_BY_WORK_TYPE[workType] || EXECUTION_BY_WORK_TYPE.generic;
  const explicitExecutor = String(row.executorKind || row.executor || "").trim().toLowerCase();
  const executorKind = EXECUTOR_KINDS.has(explicitExecutor) ? explicitExecutor : fallback[0];
  const explicitDeliverable = String(row.deliverableKind || row.deliverable || "").trim().toLowerCase();
  const deliverableKind = DELIVERABLE_KINDS.has(explicitDeliverable) ? explicitDeliverable : DELIVERABLE_BY_EXECUTOR[executorKind];
  const intrinsicExternalSideEffect = workType === "external" || executorKind === "external-transaction";
  return {
    executorKind,
    deliverableKind,
    relevantFiles: boundedList(row.relevantFiles, 80, 500),
    expectedFiles: executorKind === "code-change" ? boundedList(row.expectedFiles, 80, 500) : [],
    verificationCommands: normalizeCommands(row.verificationCommands),
    requiredCapabilities: boundedList(row.requiredCapabilities, 30, 120).map((value) => value.toLowerCase()),
    requiredPermissions: boundedList(row.requiredPermissions, 30, 120).map((value) => value.toLowerCase()),
    preconditions: boundedList(row.preconditions, 30, 1000),
    postconditions: boundedList(row.postconditions, 30, 1000),
    commands: normalizeCommands(row.commands),
    rollback: normalizeRollback(row.rollback),
    recoveryAction: bounded(row.recoveryAction || "", 1200).trim(),
    mutatesExternalState: intrinsicExternalSideEffect || row.mutatesExternalState === true,
    sideEffectKey: bounded(row.sideEffectKey || "", 240).trim(),
    observedStateFingerprint: bounded(row.observedStateFingerprint || "", 180).trim(),
    userAuthorizationRef: bounded(row.userAuthorizationRef || "", 500).trim(),
    successProbability: Number.isFinite(Number(row.successProbability)) ? Number(row.successProbability) : 0.7,
  };
}

function normalizeMasterPlan(rawValue = {}) {
  const raw = rawValue?.artifact || rawValue;
  return {
    schemaVersion: "director-cfo/master-plan@1",
    planRevision: Number(raw.planRevision || 0),
    mission: {
      id: cleanId(raw.mission?.id),
      revision: Number(raw.mission?.revision || 0),
      outcome: bounded(raw.mission?.outcome || "", 6000).trim(),
    },
    context: {
      revision: Number(raw.context?.revision || 0),
      fingerprint: String(raw.context?.fingerprint || "").trim().slice(0, 128),
    },
    objective: bounded(raw.objective || "", 6000).trim(),
    timeline: {
      totalEstimatedMinutes: Number(raw.timeline?.totalEstimatedMinutes || 0),
      assumptions: boundedList(raw.timeline?.assumptions, 20, 600),
      windows: rows(raw.timeline?.windows).map((row) => ({
        milestoneId: cleanId(row?.milestoneId),
        startAfterMinute: Number(row?.startAfterMinute ?? 0),
        durationMinutes: Number(row?.durationMinutes || 0),
      })),
    },
    milestones: rows(raw.milestones).map((row) => ({
      id: cleanId(row?.id),
      outcome: bounded(row?.outcome || "", 2000).trim(),
      dependsOn: boundedList(row?.dependsOn, 30, 100).map(cleanId),
      workstreamIds: boundedList(row?.workstreamIds, 30, 100).map(cleanId),
      evidenceRequirementIds: boundedList(row?.evidenceRequirementIds, 30, 100).map(cleanId),
      acceptanceCriteria: boundedList(row?.acceptanceCriteria, 20, 1000),
    })),
    dependencies: rows(raw.dependencies).map((row) => ({
      id: cleanId(row?.id),
      fromMilestoneId: cleanId(row?.fromMilestoneId),
      toMilestoneId: cleanId(row?.toMilestoneId),
      condition: bounded(row?.condition || "", 1000).trim(),
    })),
    workstreams: rows(raw.workstreams).map((row) => ({
      id: cleanId(row?.id),
      outcome: bounded(row?.outcome || "", 2000).trim(),
      workType: String(row?.workType || "").trim().toLowerCase(),
      milestoneIds: boundedList(row?.milestoneIds, 30, 100).map(cleanId),
      dependsOn: boundedList(row?.dependsOn, 30, 100).map(cleanId),
      teamRoleIds: boundedList(row?.teamRoleIds, 30, 100).map(cleanId),
      permissionIds: boundedList(row?.permissionIds, 30, 100).map(cleanId),
      evidenceRequirementIds: boundedList(row?.evidenceRequirementIds, 30, 100).map(cleanId),
      resourceEstimateId: cleanId(row?.resourceEstimateId),
      execution: normalizeExecution(row?.execution, String(row?.workType || "").trim().toLowerCase()),
    })),
    team: {
      roles: rows(raw.team?.roles).map((row) => ({
        id: cleanId(row?.id),
        title: bounded(row?.title || "", 200).trim(),
        modelClass: bounded(row?.modelClass || "", 100).trim(),
        capabilities: boundedList(row?.capabilities, 30, 120),
        responsibilities: boundedList(row?.responsibilities, 30, 600),
        workstreamIds: boundedList(row?.workstreamIds, 30, 100).map(cleanId),
        permissionIds: boundedList(row?.permissionIds, 30, 100).map(cleanId),
      })),
    },
    permissions: rows(raw.permissions).map((row) => ({
      id: cleanId(row?.id),
      capability: bounded(row?.capability || "", 200).trim(),
      mode: String(row?.mode || "").trim().toLowerCase(),
      scope: bounded(row?.scope || "", 1000).trim(),
      reason: bounded(row?.reason || "", 1000).trim(),
      required: row?.required !== false,
    })),
    risks: rows(raw.risks).map((row) => ({
      id: cleanId(row?.id),
      description: bounded(row?.description || "", 1200).trim(),
      likelihood: String(row?.likelihood || "").trim().toLowerCase(),
      impact: String(row?.impact || "").trim().toLowerCase(),
      ownerRoleId: cleanId(row?.ownerRoleId),
      trigger: bounded(row?.trigger || "", 1000).trim(),
      mitigation: bounded(row?.mitigation || "", 1200).trim(),
    })),
    recovery: rows(raw.recovery).map((row) => ({
      id: cleanId(row?.id),
      trigger: bounded(row?.trigger || "", 1000).trim(),
      failureClasses: boundedList(row?.failureClasses, 20, 100),
      action: bounded(row?.action || "", 1600).trim(),
      ownerRoleId: cleanId(row?.ownerRoleId),
      evidenceRequirementId: cleanId(row?.evidenceRequirementId),
    })),
    evidenceRequirements: rows(raw.evidenceRequirements).map((row) => ({
      id: cleanId(row?.id),
      milestoneId: cleanId(row?.milestoneId),
      description: bounded(row?.description || "", 1200).trim(),
      level: String(row?.level || "").trim().toLowerCase(),
      proofType: bounded(row?.proofType || "", 160).trim(),
      verifierRoleId: cleanId(row?.verifierRoleId),
      acceptanceRequirementIds: boundedList(row?.acceptanceRequirementIds, 30, 100).map(cleanId),
    })),
    resourceEstimates: rows(raw.resourceEstimates).map((row) => ({
      id: cleanId(row?.id),
      workstreamId: cleanId(row?.workstreamId),
      modelClass: bounded(row?.modelClass || "", 100).trim(),
      attempts: Number(row?.attempts || 0),
      inputTokens: Number(row?.inputTokens || 0),
      outputTokens: Number(row?.outputTokens || 0),
      wallClockMinutes: Number(row?.wallClockMinutes || 0),
      concurrency: Number(row?.concurrency || 0),
      ramMb: Number(row?.ramMb || 0),
      diskMb: Number(row?.diskMb || 0),
      includesVerification: row?.includesVerification === true,
      includesReconciliationReserve: row?.includesReconciliationReserve === true,
    })),
  };
}

function completeMilestoneDependencyLinks(plan) {
  // A dependency edge already carries the authoritative predecessor and target.
  // Normalize the redundant milestone field without inventing or changing an edge.
  const milestones = new Map(plan.milestones.map((row) => [row.id, row]));
  const dependencyIds = new Map(plan.dependencies.map((row) => [row.id, row]));
  for (const milestone of plan.milestones) {
    milestone.dependsOn = [...new Set(milestone.dependsOn.map((id) => {
      const dependency = dependencyIds.get(id);
      return dependency?.toMilestoneId === milestone.id ? dependency.fromMilestoneId : id;
    }))];
  }
  for (const dependency of plan.dependencies) {
    const target = milestones.get(dependency.toMilestoneId);
    if (!target || !milestones.has(dependency.fromMilestoneId)) continue;
    if (!target.dependsOn.includes(dependency.fromMilestoneId)) target.dependsOn.push(dependency.fromMilestoneId);
  }
  return plan;
}
function completeIntermediateEvidenceLinks(plan) {
  // Preserve a strong plan when its only defect is omitted activity evidence
  // links on dependency steps. Final acceptance evidence and its levels are
  // never synthesized or upgraded here.
  const evidenceByMilestone = new Map();
  for (const evidence of plan.evidenceRequirements) {
    if (!evidenceByMilestone.has(evidence.milestoneId)) evidenceByMilestone.set(evidence.milestoneId, []);
    evidenceByMilestone.get(evidence.milestoneId).push(evidence);
  }
  const dependents = new Map(plan.milestones.map((row) => [row.id, []]));
  for (const milestone of plan.milestones) {
    for (const dependency of milestone.dependsOn) {
      if (dependents.has(dependency)) dependents.get(dependency).push(milestone.id);
    }
  }
  function downstreamEvidence(milestoneId) {
    const pending = [milestoneId];
    const seen = new Set();
    const result = [];
    while (pending.length) {
      const current = pending.shift();
      if (seen.has(current)) continue;
      seen.add(current);
      result.push(...(evidenceByMilestone.get(current) || []));
      pending.push(...(dependents.get(current) || []));
    }
    return result;
  }
  const usedEvidenceIds = new Set(plan.evidenceRequirements.map((row) => row.id));
  for (const milestone of plan.milestones) {
    if (milestone.evidenceRequirementIds.length) continue;
    const direct = evidenceByMilestone.get(milestone.id) || [];
    if (direct.length) {
      milestone.evidenceRequirementIds = direct.map((row) => row.id);
      continue;
    }
    const downstream = downstreamEvidence(milestone.id);
    const label = (milestone.id + " " + milestone.outcome).toLowerCase();
    const targeted = downstream.filter((row) => row.acceptanceRequirementIds.some((id) => label.includes(id.toLowerCase())));
    const basis = targeted.length ? targeted : downstream;
    const acceptanceRequirementIds = [...new Set(basis.flatMap((row) => row.acceptanceRequirementIds))];
    const workstreams = plan.workstreams.filter((row) => milestone.workstreamIds.includes(row.id) || row.milestoneIds.includes(milestone.id));
    const verifierRoleId = workstreams.flatMap((row) => row.teamRoleIds)[0] || plan.team.roles[0]?.id || "";
    if (!acceptanceRequirementIds.length || !verifierRoleId) continue;
    const baseId = cleanId("evidence-" + milestone.id + "-activity");
    let id = baseId;
    let suffix = 2;
    while (usedEvidenceIds.has(id)) id = cleanId(baseId + "-" + suffix++);
    usedEvidenceIds.add(id);
    const evidence = {
      id,
      milestoneId: milestone.id,
      description: "Verify completion of the intermediate milestone: " + milestone.outcome,
      level: "activity",
      proofType: "milestone-completion",
      verifierRoleId,
      acceptanceRequirementIds,
    };
    plan.evidenceRequirements.push(evidence);
    evidenceByMilestone.set(milestone.id, [evidence]);
    milestone.evidenceRequirementIds = [id];
  }
  for (const workstream of plan.workstreams) {
    if (workstream.evidenceRequirementIds.length) continue;
    workstream.evidenceRequirementIds = [...new Set(workstream.milestoneIds.flatMap((id) => (
      plan.milestones.find((row) => row.id === id)?.evidenceRequirementIds || []
    )))];
  }
  return plan;
}

function uniqueIds(values, section, errors) {
  const seen = new Set();
  for (const [index, row] of values.entries()) {
    if (!row.id) errors.push(`${section}[${index}].id is required.`);
    else if (seen.has(row.id)) errors.push(`${section} contains duplicate id ${row.id}.`);
    seen.add(row.id);
  }
  return seen;
}

function requireRefs(values, known, label, errors, options = {}) {
  if (options.nonEmpty && !values.length) errors.push(`${label} requires at least one reference.`);
  for (const id of values) if (!known.has(id)) errors.push(`${label} references unknown id ${id}.`);
}

function detectMilestoneCycle(milestones) {
  const graph = new Map(milestones.map((row) => [row.id, row.dependsOn]));
  const visiting = new Set();
  const visited = new Set();
  function visit(id) {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    for (const dependency of graph.get(id) || []) if (graph.has(dependency) && visit(dependency)) return true;
    visiting.delete(id);
    visited.add(id);
    return false;
  }
  return [...graph.keys()].some(visit);
}

function validateStringList(value, label, errors, limits = {}) {
  if (!Array.isArray(value)) {
    errors.push(label + " must be an array.");
    return;
  }
  const maxItems = Number(limits.maxItems || 30);
  const maxChars = Number(limits.maxChars || 500);
  if (value.length > maxItems) errors.push(label + " exceeds the " + maxItems + "-item bound.");
  value.forEach((item, index) => {
    if (typeof item !== "string" || !item.trim()) errors.push(label + "[" + index + "] must be a non-empty string.");
    else if (item.length > maxChars) errors.push(label + "[" + index + "] exceeds the " + maxChars + "-character bound.");
  });
}

function validateVocabulary(value, label, errors, canonicalize, kind) {
  if (!Array.isArray(value)) return;
  value.forEach((item, index) => {
    if (typeof item !== "string" || !item.trim()) return;
    if (!canonicalize(item)) {
      errors.push(`${label}[${index}] has unsupported ${kind} ${String(item).trim().toLowerCase()}.`);
    }
  });
}

function validateCommands(value, label, errors, options = {}) {
  if (!Array.isArray(value)) {
    errors.push(label + " must be an array of structured commands.");
    return;
  }
  if (options.nonEmpty && !value.length) errors.push(label + " requires at least one structured command.");
  if (value.length > 12) errors.push(label + " exceeds the 12-command bound.");
  value.forEach((command, index) => {
    const itemLabel = label + "[" + index + "]";
    if (!command || typeof command !== "object" || Array.isArray(command)) {
      errors.push(itemLabel + " must be an object.");
      return;
    }
    if (!String(command.command || "").trim() || String(command.command).length > 500) errors.push(itemLabel + ".command must be a bounded executable name.");
    if (!Array.isArray(command.args) || command.args.length > 40 || command.args.some((arg) => typeof arg !== "string" || arg.length > 500)) errors.push(itemLabel + ".args must be a bounded string array.");
    if (!(Number(command.timeoutSeconds) > 0) || Number(command.timeoutSeconds) > 3600) errors.push(itemLabel + ".timeoutSeconds must be between 1 and 3600.");
    if (command.cwd != null && (typeof command.cwd !== "string" || command.cwd.length > 500)) errors.push(itemLabel + ".cwd must be a bounded string.");
  });
}

function validateExpectedFiles(value, label, errors) {
  validateStringList(value, label, errors, { maxItems: 80, maxChars: 500 });
  for (const file of Array.isArray(value) ? value : []) {
    const target = String(file || "").trim();
    if (/[*?]/.test(target) || [".", "..", "/"].includes(target) || target === String.fromCharCode(92)) errors.push(label + " must contain explicit file targets, not roots or wildcards.");
  }
}

function normalizedProjectPath(value) {
  return String(value || "").trim().replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
}

function commandFileReferences(commands) {
  const filePattern = /\.(?:py|js|cjs|mjs|ts|tsx|jsx|ps1|sh|sql|json|ya?ml|toml|ini|cfg|db|sqlite3?)$/i;
  return (commands || []).flatMap((command) => (command?.args || [])
    .map((arg) => String(arg || "").trim())
    .filter((arg) => arg && !arg.startsWith("-") && filePattern.test(arg)));
}

function assessMasterPlan(rawValue, expected = {}) {
  const raw = rawValue?.artifact || rawValue || {};
  const plan = completeIntermediateEvidenceLinks(completeMilestoneDependencyLinks(normalizeMasterPlan(raw)));
  const errors = [];
  const warnings = [];
  const minimumPlanRevision = resolveMinimumPlanRevision(expected);
  if (raw.schemaVersion && raw.schemaVersion !== plan.schemaVersion) errors.push(`Unsupported master plan schema: ${raw.schemaVersion}.`);
  if (!Number.isInteger(plan.planRevision) || plan.planRevision < minimumPlanRevision) {
    errors.push(minimumPlanRevision === 1
      ? "planRevision must be a positive integer."
      : `planRevision must be an integer at least ${minimumPlanRevision}.`);
  }
  if (!plan.mission.id || !Number.isInteger(plan.mission.revision) || plan.mission.revision < 1 || !plan.mission.outcome) errors.push("mission id, positive revision, and outcome are required.");
  if (!Number.isInteger(plan.context.revision) || plan.context.revision < 1 || !plan.context.fingerprint) errors.push("context revision and fingerprint are required.");
  if (expected.missionId && plan.mission.id !== expected.missionId) errors.push("Plan mission id does not match the strategy contract.");
  if (expected.missionRevision && plan.mission.revision !== Number(expected.missionRevision)) errors.push("Plan mission revision is stale.");
  if (expected.contextRevision && plan.context.revision !== Number(expected.contextRevision)) errors.push("Plan context revision is stale.");
  if (expected.contextFingerprint && plan.context.fingerprint !== expected.contextFingerprint) errors.push("Plan context fingerprint is stale.");
  if (!plan.objective) errors.push("objective is required.");
  for (const section of ["milestones", "workstreams", "permissions", "risks", "recovery", "evidenceRequirements", "resourceEstimates"]) {
    if (!Object.prototype.hasOwnProperty.call(raw, section)) errors.push(`${section} section is required.`);
    if (!plan[section].length) errors.push(`${section} requires at least one entry.`);
  }
  if (!raw.timeline || !Array.isArray(raw.timeline.windows)) errors.push("timeline with milestone windows is required.");
  if (!raw.dependencies || !Array.isArray(raw.dependencies)) errors.push("dependencies must be an explicit array, even when empty.");
  if (!raw.team || !Array.isArray(raw.team.roles) || !plan.team.roles.length) errors.push("team.roles requires at least one role.");
  if (!(plan.timeline.totalEstimatedMinutes > 0)) errors.push("timeline.totalEstimatedMinutes must be positive.");

  const milestoneIds = uniqueIds(plan.milestones, "milestones", errors);
  const workstreamIds = uniqueIds(plan.workstreams, "workstreams", errors);
  const roleIds = uniqueIds(plan.team.roles, "team.roles", errors);
  const permissionIds = uniqueIds(plan.permissions, "permissions", errors);
  const evidenceIds = uniqueIds(plan.evidenceRequirements, "evidenceRequirements", errors);
  const estimateIds = uniqueIds(plan.resourceEstimates, "resourceEstimates", errors);
  const authoritativeRequirements = (expected.authoritativeRequirements || [])
    .filter((row) => row && row.required !== false && String(row.status || "").toLowerCase() !== "passing")
    .map((row) => ({
      id: cleanId(row.id),
      description: bounded(row.description || "", 2000).trim(),
      requiredExecutorKinds: requiredExecutorKindsForRequirement(row),
      minimumEvidenceLevel: String(row.minimumEvidenceLevel || row.minimum_evidence_level || "integration").trim().toLowerCase(),
    }))
    .filter((row) => row.id);
  const authoritativeRequirementIds = new Set(authoritativeRequirements.map((row) => row.id));
  uniqueIds(plan.risks, "risks", errors);
  uniqueIds(plan.recovery, "recovery", errors);
  uniqueIds(plan.dependencies, "dependencies", errors);
  const plannedOutputFiles = new Set(plan.workstreams
    .flatMap((row) => row.execution?.expectedFiles || [])
    .map(normalizedProjectPath));

  for (const milestone of plan.milestones) {
    if (!milestone.outcome) errors.push(`Milestone ${milestone.id || "missing"} requires an outcome.`);
    if (!milestone.acceptanceCriteria.length) errors.push(`Milestone ${milestone.id || "missing"} requires acceptanceCriteria.`);
    requireRefs(milestone.dependsOn, milestoneIds, `Milestone ${milestone.id}.dependsOn`, errors);
    requireRefs(milestone.workstreamIds, workstreamIds, `Milestone ${milestone.id}.workstreamIds`, errors, { nonEmpty: true });
    requireRefs(milestone.evidenceRequirementIds, evidenceIds, `Milestone ${milestone.id}.evidenceRequirementIds`, errors, { nonEmpty: true });
  }
  if (detectMilestoneCycle(plan.milestones)) errors.push("Milestone dependency graph contains a cycle.");

  for (const dependency of plan.dependencies) {
    requireRefs([dependency.fromMilestoneId, dependency.toMilestoneId], milestoneIds, `Dependency ${dependency.id}`, errors);
    if (!dependency.condition) errors.push(`Dependency ${dependency.id} requires a condition.`);
    const target = plan.milestones.find((row) => row.id === dependency.toMilestoneId);
    if (target && !target.dependsOn.includes(dependency.fromMilestoneId)) errors.push(`Dependency ${dependency.id} is not represented in milestone dependsOn.`);
  }
  for (const [workstreamIndex, workstream] of plan.workstreams.entries()) {
    const rawExecution = rows(raw.workstreams)[workstreamIndex]?.execution;
    const label = "Workstream " + workstream.id + ".execution";
    if (!rawExecution || typeof rawExecution !== "object" || Array.isArray(rawExecution)) {
      errors.push(label + " contract is required.");
    } else {
      const explicitExecutor = String(rawExecution.executorKind || rawExecution.executor || "").trim().toLowerCase();
      const explicitDeliverable = String(rawExecution.deliverableKind || rawExecution.deliverable || "").trim().toLowerCase();
      if (explicitExecutor && !EXECUTOR_KINDS.has(explicitExecutor)) errors.push(label + " has unsupported executorKind " + explicitExecutor + ".");
      if (explicitDeliverable && !DELIVERABLE_KINDS.has(explicitDeliverable)) errors.push(label + " has unsupported deliverableKind " + explicitDeliverable + ".");
      if (DELIVERABLE_BY_EXECUTOR[workstream.execution.executorKind] !== workstream.execution.deliverableKind) errors.push(label + " executorKind and deliverableKind are incompatible.");
      validateStringList(rawExecution.relevantFiles, label + ".relevantFiles", errors, { maxItems: 80, maxChars: 500 });
      validateExpectedFiles(rawExecution.expectedFiles, label + ".expectedFiles", errors);
      validateCommands(rawExecution.verificationCommands, label + ".verificationCommands", errors);
      validateStringList(rawExecution.requiredCapabilities, label + ".requiredCapabilities", errors, { maxItems: 30, maxChars: 120 });
      validateStringList(rawExecution.requiredPermissions, label + ".requiredPermissions", errors, { maxItems: 30, maxChars: 120 });
      validateVocabulary(rawExecution.requiredCapabilities, label + ".requiredCapabilities", errors, canonicalCapabilityName, "callable capability");
      validateVocabulary(rawExecution.requiredPermissions, label + ".requiredPermissions", errors, canonicalPermissionName, "permission");
      validateStringList(rawExecution.preconditions, label + ".preconditions", errors, { maxItems: 30, maxChars: 1000 });
      validateStringList(rawExecution.postconditions, label + ".postconditions", errors, { maxItems: 30, maxChars: 1000 });
      validateCommands(rawExecution.commands, label + ".commands", errors);
      if (rawExecution.rollback && typeof rawExecution.rollback === "object" && !Array.isArray(rawExecution.rollback) && rawExecution.rollback.commands != null) {
        validateCommands(rawExecution.rollback.commands, label + ".rollback.commands", errors);
      }
      if (typeof rawExecution.mutatesExternalState !== "boolean") errors.push(label + ".mutatesExternalState must be explicit.");
      if (!(Number(rawExecution.successProbability) > 0) || Number(rawExecution.successProbability) > 1) errors.push(label + ".successProbability must be greater than 0 and at most 1.");
    }
    const typedCoordinatorDelivery = workstream.execution.deliverableKind !== "patch";
    if (typedCoordinatorDelivery && workstream.execution.expectedFiles.length) {
      errors.push(label + ".expectedFiles must be empty for coordinator-integrated typed output.");
    }
    if (Array.isArray(expected.availableSourceFiles)) {
      const available = new Set(expected.availableSourceFiles.map(normalizedProjectPath));
      for (const file of workstream.execution.relevantFiles) {
        if (!available.has(normalizedProjectPath(file))) {
          errors.push(label + `.relevantFiles references unavailable or invented project file ${file}.`);
        }
      }
      const declared = new Set([
        ...workstream.execution.relevantFiles,
        ...workstream.execution.expectedFiles,
      ].map(normalizedProjectPath));
      for (const file of commandFileReferences([
        ...workstream.execution.commands,
        ...workstream.execution.verificationCommands,
        ...(workstream.execution.rollback?.commands || []),
      ])) {
        const normalized = normalizedProjectPath(file);
        if (!available.has(normalized) && !declared.has(normalized) && !plannedOutputFiles.has(normalized)) {
          errors.push(label + `.commands references unavailable or invented project file ${file}.`);
        }
      }
    }
    const codeDelivery = workstream.workType === "code" || workstream.execution.executorKind === "code-change";
    if (codeDelivery) {
      if (!workstream.execution.expectedFiles.length) errors.push(label + ".expectedFiles must bound code output to explicit files.");
      if (!workstream.execution.verificationCommands.length) errors.push(label + ".verificationCommands must define deterministic verification for code work.");
      if (Array.isArray(expected.availableSourceFiles)) {
        const available = new Set(expected.availableSourceFiles.map(normalizedProjectPath));
        const groundedDirectories = new Set(workstream.execution.relevantFiles
          .filter((file) => available.has(normalizedProjectPath(file)))
          .map((file) => normalizedProjectPath(file).split("/").slice(0, -1).join("/")));
        for (const file of workstream.execution.expectedFiles) {
          const normalized = normalizedProjectPath(file);
          const directory = normalized.split("/").slice(0, -1).join("/");
          if (!available.has(normalized) && !groundedDirectories.has(directory)) {
            errors.push(label + `.expectedFiles references invented output ${file}; bind new files to a directory grounded by relevantFiles.`);
          }
        }
      }
    }
    const guardedTransaction = workstream.execution.executorKind === "operational-transaction"
      || workstream.execution.mutatesExternalState;
    if (guardedTransaction) {
      const rollbackUsable = workstream.execution.rollback
        && (workstream.execution.rollback.description || workstream.execution.rollback.commands.length);
      if (!workstream.execution.preconditions.length) errors.push(label + ".preconditions are required before an external side effect.");
      if (!workstream.execution.postconditions.length) errors.push(label + ".postconditions are required after an external side effect.");
      if (!rollbackUsable && !workstream.execution.recoveryAction) errors.push(label + " requires rollback or recoveryAction.");
      if (!workstream.execution.sideEffectKey) errors.push(label + ".sideEffectKey is required.");
      if (!workstream.execution.observedStateFingerprint) errors.push(label + ".observedStateFingerprint is required.");
      if (!workstream.execution.userAuthorizationRef) errors.push(label + ".userAuthorizationRef is required for operational and external transactions.");
    }
    if (!workstream.outcome) errors.push(`Workstream ${workstream.id} requires an outcome.`);
    if (!WORK_TYPES.has(workstream.workType)) errors.push(`Workstream ${workstream.id} has unsupported workType ${workstream.workType || "missing"}.`);
    requireRefs(workstream.milestoneIds, milestoneIds, `Workstream ${workstream.id}.milestoneIds`, errors, { nonEmpty: true });
    requireRefs(workstream.dependsOn, workstreamIds, `Workstream ${workstream.id}.dependsOn`, errors);
    requireRefs(workstream.teamRoleIds, roleIds, `Workstream ${workstream.id}.teamRoleIds`, errors, { nonEmpty: true });
    requireRefs(workstream.permissionIds, permissionIds, `Workstream ${workstream.id}.permissionIds`, errors, { nonEmpty: true });
    requireRefs(workstream.evidenceRequirementIds, evidenceIds, `Workstream ${workstream.id}.evidenceRequirementIds`, errors, { nonEmpty: true });
    requireRefs([workstream.resourceEstimateId], estimateIds, `Workstream ${workstream.id}.resourceEstimateId`, errors);
  }
  for (const role of plan.team.roles) {
    if (!role.title || !role.modelClass || !role.capabilities.length || !role.responsibilities.length) errors.push(`Team role ${role.id} requires title, modelClass, capabilities, and responsibilities.`);
    requireRefs(role.workstreamIds, workstreamIds, `Team role ${role.id}.workstreamIds`, errors, { nonEmpty: true });
    requireRefs(role.permissionIds, permissionIds, `Team role ${role.id}.permissionIds`, errors, { nonEmpty: true });
  }
  for (const permission of plan.permissions) {
    if (!permission.capability || !permission.scope || !permission.reason || !PERMISSION_MODES.has(permission.mode)) errors.push(`Permission ${permission.id} requires capability, valid mode, scope, and reason.`);
  }
  for (const risk of plan.risks) {
    if (!risk.description || !risk.likelihood || !risk.impact || !risk.trigger || !risk.mitigation) errors.push(`Risk ${risk.id} is incomplete.`);
    requireRefs([risk.ownerRoleId], roleIds, `Risk ${risk.id}.ownerRoleId`, errors);
  }
  for (const recovery of plan.recovery) {
    if (!recovery.trigger || !recovery.failureClasses.length || !recovery.action) errors.push(`Recovery ${recovery.id} is incomplete.`);
    requireRefs([recovery.ownerRoleId], roleIds, `Recovery ${recovery.id}.ownerRoleId`, errors);
    requireRefs([recovery.evidenceRequirementId], evidenceIds, `Recovery ${recovery.id}.evidenceRequirementId`, errors);
  }
  for (const evidence of plan.evidenceRequirements) {
    if (!evidence.description || !evidence.proofType || !EVIDENCE_LEVELS.has(evidence.level)) errors.push(`Evidence requirement ${evidence.id} requires description, valid level, and proofType.`);
    requireRefs([evidence.milestoneId], milestoneIds, `Evidence ${evidence.id}.milestoneId`, errors);
    requireRefs([evidence.verifierRoleId], roleIds, `Evidence ${evidence.id}.verifierRoleId`, errors);
    if (authoritativeRequirementIds.size) {
      requireRefs(evidence.acceptanceRequirementIds, authoritativeRequirementIds, `Evidence ${evidence.id}.acceptanceRequirementIds`, errors, { nonEmpty: true });
    } else if (!evidence.acceptanceRequirementIds.length) {
      errors.push(`Evidence ${evidence.id}.acceptanceRequirementIds requires at least one authoritative requirement id.`);
    }
  }
  if (authoritativeRequirements.length) {
    const evidenceLevels = [...EVIDENCE_LEVELS];
    for (const requirement of authoritativeRequirements) {
      const linked = plan.evidenceRequirements.filter((row) => row.acceptanceRequirementIds.includes(requirement.id));
      if (!linked.length) {
        errors.push(`Master Plan omits authoritative acceptance requirement ${requirement.id}.`);
        continue;
      }
      const minimumRank = evidenceLevels.indexOf(requirement.minimumEvidenceLevel);
      if (minimumRank < 0) {
        errors.push(`Authoritative requirement ${requirement.id} has unsupported minimum evidence level ${requirement.minimumEvidenceLevel}.`);
      } else if (!linked.some((row) => evidenceLevels.indexOf(row.level) >= minimumRank)) {
        errors.push("Master Plan evidence for " + requirement.id + " does not meet minimum level " + requirement.minimumEvidenceLevel + ".");
      }
      if (requirement.requiredExecutorKinds.length) {
        const linkedEvidenceIds = new Set(linked.map((row) => row.id));
        const linkedWorkstreams = plan.workstreams.filter((row) => row.evidenceRequirementIds.some((id) => linkedEvidenceIds.has(id)));
        if (!linkedWorkstreams.some((row) => requirement.requiredExecutorKinds.includes(row.execution.executorKind))) {
          errors.push("Master Plan route for " + requirement.id + " requires an evidence-linked executor: " + requirement.requiredExecutorKinds.join(", ") + ".");
        }
      }
    }
  }
  for (const estimate of plan.resourceEstimates) {
    requireRefs([estimate.workstreamId], workstreamIds, `Resource estimate ${estimate.id}.workstreamId`, errors);
    if (!estimate.modelClass || !Number.isInteger(estimate.attempts) || estimate.attempts < 1 || estimate.inputTokens < 0 || estimate.outputTokens < 0 || estimate.wallClockMinutes <= 0 || !Number.isInteger(estimate.concurrency) || estimate.concurrency < 1 || estimate.ramMb < 0 || estimate.diskMb < 0) errors.push(`Resource estimate ${estimate.id} has invalid demand values.`);
    if (!estimate.includesVerification) warnings.push(`Resource estimate ${estimate.id} does not include verification cost.`);
  }
  const windowIds = new Set();
  for (const window of plan.timeline.windows) {
    if (!milestoneIds.has(window.milestoneId)) errors.push(`Timeline references unknown milestone ${window.milestoneId}.`);
    else windowIds.add(window.milestoneId);
    if (window.startAfterMinute < 0 || window.durationMinutes <= 0) errors.push(`Timeline window for ${window.milestoneId} has invalid timing.`);
    if (window.startAfterMinute + window.durationMinutes > plan.timeline.totalEstimatedMinutes) errors.push(`Timeline window for ${window.milestoneId} exceeds totalEstimatedMinutes.`);
  }
  for (const id of milestoneIds) if (!windowIds.has(id)) errors.push(`Timeline omits milestone ${id}.`);
  if (!plan.resourceEstimates.some((row) => row.includesReconciliationReserve)) errors.push("At least one resource estimate must protect reconciliation reserve.");

  return {
    schemaVersion: "director-cfo/plan-assurance-report@1",
    valid: errors.length === 0,
    errors: [...new Set(errors)],
    warnings: [...new Set(warnings)],
    plan: errors.length ? null : { ...plan, planFingerprint: fingerprint(plan) },
  };
}

function buildStrategyPrompt(contract) {
  const lines = [
    "You are the strong project strategist. Produce the durable program plan; do not execute project work.",
    `Mission ${contract.mission.id} revision ${contract.mission.revision}: ${contract.mission.outcome}`,
    `Use context dossier revision ${contract.context.revision}, fingerprint ${contract.context.fingerprint}.`,
    "Return one JSON object matching the immutable artifactContract.jsonSchema supplied in the Director worker envelope. Include every required key, including explicit empty arrays and empty strings.",
    "Every workstream must include an execution object: a compatible executorKind/deliverableKind, bounded relevantFiles and expectedFiles, structured verificationCommands and commands (command, args, timeoutSeconds, optional cwd), requiredCapabilities, requiredPermissions, preconditions, postconditions, rollback or recoveryAction, mutatesExternalState, sideEffectKey, observedStateFingerprint, userAuthorizationRef, and successProbability.",
    "Code delivery requires non-empty, explicit expectedFiles and non-empty deterministic verificationCommands. If exact bounded output files are not yet known, plan a dependency-ready read-only discovery workstream first; never emit a code-change execution contract with empty expectedFiles or verificationCommands. Any operation or external side effect requires preconditions, postconditions, rollback or recovery, a stable sideEffectKey, an observed-state fingerprint, and an exact userAuthorizationRef.",
    "Every workstream must link to its milestones, roles, permissions, evidence, and resource estimate. Protect verification and reconciliation resources. Do not name a provider unless availability evidence requires it; describe capability/model classes.",
    "Every evidenceRequirements entry must use acceptanceRequirementIds from the authoritative requirement list below. Cover every unresolved required ID exactly; never infer or invent a requirement ID from similar wording.",
    "For every unresolved required ID, include at least one linked evidence requirement whose level is equal to or stronger than that requirement's minimumEvidenceLevel. A lower-level planning, process, focused-test, or integration artifact does not satisfy an end-to-end or user-visible floor.",
    "Required evidence floors: " + contract.authoritativeRequirements.filter((row) => row.required && row.status !== "passing").map((row) => row.id + "=" + row.minimumEvidenceLevel).join(", "),
    "Required executor routes: " + contract.authoritativeRequirements.filter((row) => row.required && row.status !== "passing" && row.requiredExecutorKinds.length).map((row) => row.id + "=" + row.requiredExecutorKinds.join("|")).join(", ") + ". For each listed requirement, at least one evidence-linked workstream must use a listed executor; discovery alone does not satisfy an implementation or operational route.",
    "Every ID and every ID reference must be 2-100 characters, begin with a letter, and contain only letters, digits, dot, underscore, colon, or hyphen. Use each generated ID consistently in every reference.",
    "Milestone dependsOn entries must contain predecessor milestone IDs only, never dependency object IDs. Every dependencies edge from A to B must be mirrored by B.dependsOn containing A.",
    `Existing authorized files available to typed workstreams: ${JSON.stringify(contract.availableSourceFiles || [])}. Copy relevantFiles values verbatim from this list; never synthesize plausible or placeholder paths. A new code-change expectedFile must be grounded by an existing relevantFile in the same directory. Every non-code-change typed workstream, including context, strategy, operation, browser, external, monitoring, verification, and reconciliation, must use expectedFiles: []; its receipt or JSON artifact is returned directly to the coordinator. Only code-change work may declare files to write.`,
  ];
  if (Number.isInteger(contract.minimumPlanRevision)) {
    lines.push(`This is a plan revision. Return planRevision at least ${contract.minimumPlanRevision}; a lower revision is stale and will be rejected.`);
  }
  if (Object.prototype.hasOwnProperty.call(contract, "reconciliationDirective")) {
    lines.push("The reconciliation directive below is authoritative recovery input. Address its evidence-backed root cause and every required material change in the revised strategy; do not repeat the superseded plan unchanged.");
    lines.push(`Reconciliation directive:\n${JSON.stringify(contract.reconciliationDirective)}`);
  }
  lines.push(
    `Authoritative project requirements:\n${JSON.stringify(contract.authoritativeRequirements)}`,
    `Authoritative compact context dossier:\n${JSON.stringify(contract.contextDossier)}`,
  );
  return lines.join("\n");
}

function createStrategyWorkPackage(input = {}) {
  const mission = input.mission || {};
  const dossier = input.contextDossier || {};
  if (!mission.id || !Number.isInteger(Number(mission.revision)) || Number(mission.revision) < 1 || !mission.outcome) throw new Error("Strategy requires a complete mission contract.");
  if (dossier.schemaVersion !== "director-cfo/context-dossier@1" || !dossier.contextRevision || !dossier.contextFingerprint) throw new Error("Strategy requires a versioned context dossier.");
  if (dossier.mission?.id !== mission.id || dossier.mission?.revision !== Number(mission.revision)) throw new Error("Context dossier is stale for the requested mission.");
  const authoritativeRequirements = rows(input.requirements).slice(0, 200).map((row) => ({
    id: cleanId(row?.id),
    description: bounded(row?.description || "", 2000).trim(),
    required: row?.required !== false,
    status: String(row?.status || "failing").trim().toLowerCase(),
    minimumEvidenceLevel: String(row?.minimumEvidenceLevel || row?.minimum_evidence_level || "integration").trim().toLowerCase(),
    blocker: row?.blocker ? bounded(typeof row.blocker === "string" ? row.blocker : JSON.stringify(row.blocker), 2000) : "",
    requiredExecutorKinds: requiredExecutorKindsForRequirement(row),
  })).filter((row) => row.id && row.description);
  const outstanding = authoritativeRequirements.filter((row) => row.required && row.status !== "passing");
  if (!outstanding.length) throw new Error("Strategy requires at least one unresolved authoritative acceptance requirement.");
  const hasMinimumPlanRevision = input.minimumPlanRevision !== undefined && input.minimumPlanRevision !== null && input.minimumPlanRevision !== "";
  const minimumPlanRevision = resolveMinimumPlanRevision(input);
  const reconciliationDirective = snapshotReconciliationDirective(input.reconciliationDirective);
  const availableSourceFiles = boundedList(input.availableSourceFiles, 500, 500);
  const jsonSchema = masterPlanJsonSchema({
    missionId: mission.id,
    missionRevision: Number(mission.revision),
    contextRevision: dossier.contextRevision,
    contextFingerprint: dossier.contextFingerprint,
    authoritativeRequirements,
    availableSourceFiles,
    minimumPlanRevision,
  });
  const contract = {
    schemaVersion: "director-cfo/strategy-work-package@1",
    workType: "strategy",
    mission: { id: mission.id, revision: Number(mission.revision), outcome: mission.outcome },
    context: { revision: dossier.contextRevision, fingerprint: dossier.contextFingerprint },
    contextDossier: dossier,
    availableSourceFiles,
    authoritativeRequirements,
    outstandingRequirementIds: outstanding.map((row) => row.id),
    artifactContract: {
      kind: "master-plan",
      schemaVersion: "director-cfo/master-plan@1",
      requiredSections: ["mission", "context", "objective", "milestones", "timeline", "dependencies", "workstreams", "team", "permissions", "risks", "recovery", "evidenceRequirements", "resourceEstimates"],
      jsonSchema,
    },
  };
  if (hasMinimumPlanRevision) contract.minimumPlanRevision = minimumPlanRevision;
  if (reconciliationDirective !== undefined) contract.reconciliationDirective = reconciliationDirective;
  return { ...contract, prompt: buildStrategyPrompt(contract), contractFingerprint: fingerprint(contract) };
}

module.exports = {
  EVIDENCE_LEVELS,
  PERMISSION_MODES,
  WORK_TYPES,
  assessMasterPlan,
  buildStrategyPrompt,
  completeIntermediateEvidenceLinks,
  completeMilestoneDependencyLinks,
  createStrategyWorkPackage,
  masterPlanJsonSchema,
  normalizeMasterPlan,
  requiredExecutorKindsForRequirement,
};
