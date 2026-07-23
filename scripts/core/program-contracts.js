"use strict";

const crypto = require("node:crypto");

const CONTRACT_SCHEMA_VERSION = 2;
const SUPPORTED_SCHEMA_VERSIONS = new Set([1, CONTRACT_SCHEMA_VERSION]);
const IDENTIFIER_PATTERN = /^[A-Za-z][A-Za-z0-9._:-]{1,119}$/;
const FINGERPRINT_PATTERN = /^[a-f0-9]{16,64}$/;

const CONTRACT_KINDS = Object.freeze({
  mission: "Mission",
  contextDossier: "ContextDossier",
  masterPlan: "MasterPlan",
  resourceBudget: "ResourceBudget",
  campaign: "Campaign",
  workPackage: "WorkPackage",
  executionReceipt: "ExecutionReceipt",
  failurePacket: "FailurePacket",
  evidenceLedger: "EvidenceLedger",
  reportCursor: "ReportCursor",
});

const EVIDENCE_LEVELS = new Set(["activity", "process-health", "focused-test", "integration", "end-to-end", "user-visible"]);
const WORK_TYPES = new Set(["context", "strategy", "code", "operation", "browser", "external", "data", "monitoring", "verification", "reconciliation"]);
const DELIVERABLE_TYPES = new Set(["analysis", "plan", "patch", "operation-receipt", "browser-receipt", "external-receipt", "data-receipt", "monitor-report", "verification-report", "evidence"]);

class ContractValidationError extends Error {
  constructor(path, message) {
    super(`Invalid Director-CFO contract at ${path}: ${message}`);
    this.name = "ContractValidationError";
    this.code = "CONTRACT_INVALID";
    this.path = path;
  }
}

class StaleRevisionError extends Error {
  constructor(stage, differences) {
    super(`Stale ${stage} revision fence: ${differences.map((row) => row.component).join(", ")} changed.`);
    this.name = "StaleRevisionError";
    this.code = "STALE_REVISION_FENCE";
    this.stage = stage;
    this.differences = differences;
  }
}

function invalid(path, message) {
  throw new ContractValidationError(path, message);
}

function isObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function object(value, path) {
  if (!isObject(value)) invalid(path, "must be an object");
  return value;
}

function sourceVersion(input, path) {
  const raw = input.schemaVersion == null ? 1 : Number(input.schemaVersion);
  if (!Number.isInteger(raw) || !SUPPORTED_SCHEMA_VERSIONS.has(raw)) {
    invalid(`${path}.schemaVersion`, `must be one of ${[...SUPPORTED_SCHEMA_VERSIONS].join(", ")}`);
  }
  const migrated = input.sourceSchemaVersion == null ? raw : Number(input.sourceSchemaVersion);
  if (!Number.isInteger(migrated) || !SUPPORTED_SCHEMA_VERSIONS.has(migrated)) {
    invalid(`${path}.sourceSchemaVersion`, "is unsupported");
  }
  return { inputVersion: raw, sourceSchemaVersion: migrated };
}

function text(value, path, options = {}) {
  const required = options.required === true;
  if (value == null) {
    if (required) invalid(path, "is required");
    return options.default == null ? "" : String(options.default);
  }
  if (typeof value !== "string" && typeof value !== "number") invalid(path, "must be text");
  const result = String(value).trim();
  if (required && !result) invalid(path, "must not be empty");
  const maximum = Number(options.max || 6000);
  if (result.length > maximum) invalid(path, `must be at most ${maximum} characters`);
  return result;
}

function boolean(value, path, fallback = false) {
  if (value == null) return fallback;
  if (typeof value !== "boolean") invalid(path, "must be boolean");
  return value;
}

function integer(value, path, options = {}) {
  if (value == null || value === "") {
    if (options.required) invalid(path, "is required");
    return Number(options.default || 0);
  }
  const result = Number(value);
  if (!Number.isSafeInteger(result)) invalid(path, "must be a safe integer");
  const minimum = options.min == null ? 0 : Number(options.min);
  const maximum = options.max == null ? Number.MAX_SAFE_INTEGER : Number(options.max);
  if (result < minimum || result > maximum) invalid(path, `must be between ${minimum} and ${maximum}`);
  return result;
}

function number(value, path, options = {}) {
  if (value == null || value === "") {
    if (options.required) invalid(path, "is required");
    return Number(options.default || 0);
  }
  const result = Number(value);
  if (!Number.isFinite(result)) invalid(path, "must be finite");
  const minimum = options.min == null ? 0 : Number(options.min);
  const maximum = options.max == null ? Number.MAX_SAFE_INTEGER : Number(options.max);
  if (result < minimum || result > maximum) invalid(path, `must be between ${minimum} and ${maximum}`);
  return result;
}

function enumeration(value, allowed, path, fallback) {
  const result = value == null || value === "" ? fallback : String(value).trim();
  if (!allowed.has(result)) invalid(path, `must be one of ${[...allowed].join(", ")}`);
  return result;
}

function timestamp(value, path) {
  if (value == null || value === "") return null;
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) invalid(path, "must be an ISO-8601 timestamp");
  return new Date(value).toISOString();
}

function array(value, path, mapper, options = {}) {
  if (value == null) return [];
  if (!Array.isArray(value)) invalid(path, "must be an array");
  const maximum = Number(options.max || 100);
  if (value.length > maximum) invalid(path, `must contain at most ${maximum} items`);
  return value.map((row, index) => mapper(row, `${path}[${index}]`, index));
}

function stringList(value, path, options = {}) {
  const rows = array(value, path, (row, rowPath) => text(row, rowPath, { required: true, max: options.maxChars || 1000 }), { max: options.maxItems || 100 });
  if (new Set(rows).size !== rows.length) invalid(path, "must not contain duplicates");
  return rows;
}

function id(value, path, options = {}) {
  let result = value == null ? "" : String(value).trim();
  if (!result && options.legacySeed) {
    result = `${options.prefix || "record"}-${shortHash(options.legacySeed)}`;
  }
  if (!result) invalid(path, "is required");
  if (!IDENTIFIER_PATTERN.test(result)) invalid(path, "contains unsupported characters or has an invalid length");
  return result;
}

function fingerprint(value, path, options = {}) {
  const result = text(value, path, { required: options.required === true, max: 64 });
  if (result && !FINGERPRINT_PATTERN.test(result)) invalid(path, "must be a lowercase SHA-256 value");
  if (result && options.exact === true && result.length !== 64) invalid(path, "must be a complete lowercase SHA-256 value");
  return result;
}

function shortHash(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex").slice(0, 20);
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isObject(value)) return value;
  const output = {};
  for (const key of Object.keys(value).sort()) {
    if (key === "fingerprint") continue;
    output[key] = canonicalize(value[key]);
  }
  return output;
}

function stableStringify(value) {
  return JSON.stringify(canonicalize(value));
}

function fingerprintRecord(value) {
  if (!isObject(value)) invalid("record", "must be an object before fingerprinting");
  return crypto.createHash("sha256").update(stableStringify(value)).digest("hex");
}

function complete(record, input, path) {
  const calculated = fingerprintRecord(record);
  if (input.fingerprint != null) {
    const supplied = fingerprint(input.fingerprint, `${path}.fingerprint`, { required: true, exact: true });
    if (supplied !== calculated) invalid(`${path}.fingerprint`, "does not match normalized record content");
  }
  return Object.freeze({ ...record, fingerprint: calculated });
}

function base(input, path, kind) {
  object(input, path);
  const versions = sourceVersion(input, path);
  if (input.contractKind != null && input.contractKind !== kind) invalid(`${path}.contractKind`, `must equal ${kind}`);
  return {
    ...versions,
    record: {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      sourceSchemaVersion: versions.sourceSchemaVersion,
      contractKind: kind,
    },
  };
}

function recordId(input, field, path, version, seed) {
  const aliases = Array.isArray(field) ? field : [field];
  const value = aliases.map((key) => input[key]).find((item) => item != null && String(item).trim());
  return id(value, `${path}.${aliases[0]}`, {
    prefix: aliases[0].replace(/Id$/, "").toLowerCase(),
    legacySeed: version === 1 ? seed : "",
  });
}

function revision(input, path) {
  return integer(input.revision, `${path}.revision`, { min: 1, default: 1 });
}

function lifecycle(input, path) {
  return {
    createdAt: timestamp(input.createdAt, `${path}.createdAt`),
    updatedAt: timestamp(input.updatedAt, `${path}.updatedAt`),
  };
}

function normalizeRequirement(row, path, index) {
  if (typeof row === "string") row = { description: row };
  object(row, path);
  const description = text(row.description || row.outcome, `${path}.description`, { required: true, max: 2000 });
  return {
    requirementId: id(row.requirementId || row.id, `${path}.requirementId`, { prefix: "req", legacySeed: `${index}:${description}` }),
    description,
    required: boolean(row.required, `${path}.required`, true),
    status: enumeration(row.status, new Set(["pending", "passing", "failing", "blocked", "waived"]), `${path}.status`, "pending"),
    minimumEvidenceLevel: enumeration(row.minimumEvidenceLevel || row.minimum_evidence_level, EVIDENCE_LEVELS, `${path}.minimumEvidenceLevel`, "end-to-end"),
    evidenceRefs: stringList(row.evidenceRefs || row.evidence, `${path}.evidenceRefs`, { maxItems: 50, maxChars: 1000 }),
  };
}

function normalizeMission(input) {
  const path = "mission";
  const meta = base(input, path, CONTRACT_KINDS.mission);
  const outcome = text(input.outcome || input.goal || input.requestedOutcome, `${path}.outcome`, { required: true, max: 10000 });
  const missionId = recordId(input, ["missionId", "taskId", "projectId", "id"], path, meta.inputVersion, outcome);
  const requirements = array(input.requirements, `${path}.requirements`, normalizeRequirement, { max: 250 });
  const record = {
    ...meta.record,
    missionId,
    revision: revision(input, path),
    state: enumeration(input.state, new Set(["draft", "active", "paused", "completed", "cancelled"]), `${path}.state`, meta.inputVersion === 1 ? "draft" : "active"),
    outcome,
    requestedOutcome: text(input.requestedOutcome, `${path}.requestedOutcome`, { max: 10000, default: outcome }),
    latestUserRequest: text(input.latestUserRequest, `${path}.latestUserRequest`, { max: 10000 }),
    authority: enumeration(input.authority || input.outcomeAuthority, new Set(["user", "project-contract", "auto"]), `${path}.authority`, "auto"),
    requirements,
    successDefinition: stringList(input.successDefinition, `${path}.successDefinition`, { maxItems: 100, maxChars: 2000 }),
    constraints: stringList(input.constraints, `${path}.constraints`, { maxItems: 100, maxChars: 2000 }),
    userDecisionNeeded: boolean(input.userDecisionNeeded, `${path}.userDecisionNeeded`, false),
    ...lifecycle(input, path),
  };
  if (record.state === "completed" && requirements.some((row) => row.required && row.status !== "passing" && row.status !== "waived")) {
    invalid(`${path}.state`, "cannot be completed while required requirements lack passing evidence");
  }
  return complete(record, input, path);
}

function normalizeContextSource(row, path, index) {
  if (typeof row === "string") row = { ref: row };
  object(row, path);
  const ref = text(row.ref || row.uri || row.path, `${path}.ref`, { required: true, max: 2000 });
  return {
    sourceId: id(row.sourceId || row.id, `${path}.sourceId`, { prefix: "source", legacySeed: `${index}:${ref}` }),
    type: enumeration(row.type, new Set(["chat", "file", "git", "log", "database", "service", "browser", "runtime", "external", "other"]), `${path}.type`, "other"),
    ref,
    fingerprint: row.fingerprint ? fingerprint(row.fingerprint, `${path}.fingerprint`, { required: true }) : "",
    authority: enumeration(row.authority, new Set(["authoritative", "supporting", "unverified"]), `${path}.authority`, "supporting"),
    observedAt: timestamp(row.observedAt, `${path}.observedAt`),
  };
}

function adaptContextDossierV1(input, options = {}) {
  object(input, "legacyContextDossier");
  if (input.schemaVersion !== "director-cfo/context-dossier@1") {
    invalid("legacyContextDossier.schemaVersion", "must equal director-cfo/context-dossier@1");
  }
  const mission = object(input.mission, "legacyContextDossier.mission");
  const observations = Array.isArray(input.sourceObservations) ? input.sourceObservations : [];
  const requiredSourceIdsSpecified = Object.prototype.hasOwnProperty.call(options, "requiredSourceIds");
  const requiredSourceIds = [...new Set((Array.isArray(options.requiredSourceIds) ? options.requiredSourceIds : [])
    .map((value) => String(value || "").trim()).filter(Boolean))];
  const observationsById = new Map(observations.map((row) => [String(row?.sourceId || ""), row]));
  const coverageRows = requiredSourceIdsSpecified
    ? requiredSourceIds.map((sourceId) => observationsById.get(sourceId))
    : observations;
  const coverageComplete = (requiredSourceIdsSpecified || coverageRows.length > 0)
    && coverageRows.every((row) => row && (row.status || row.state) !== "unavailable" && row.fingerprint);
  const claimText = (...groups) => [...new Set(groups.flatMap((values) => (
    Array.isArray(values) ? values : values == null ? [] : [values]
  ))
    .map((row) => typeof row === "string"
      ? row
      : row?.text || row?.claim || row?.decision || row?.failure || row?.summary || row?.observation || row?.description || "")
    .map((value) => String(value).trim()).filter(Boolean))];
  const missionId = String(options.missionId || mission.id || "").trim();
  const dossierSeed = `${missionId}:${input.contextRevision || 1}:${input.contextFingerprint || "legacy"}`;
  return normalizeContextDossier({
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    dossierId: options.dossierId || `dossier-${shortHash(dossierSeed)}`,
    missionId,
    revision: input.contextRevision || 1,
    state: options.state || (coverageComplete ? "ready" : "stale"),
    realGoal: input.realGoal || mission.outcome,
    executiveSummary: input.executiveSummary,
    sourceFingerprint: input.contextFingerprint || "",
    sources: observations.map((row, index) => ({
      sourceId: row.sourceId || `source-${index + 1}`,
      type: "other",
      ref: `source:${row.sourceId || index + 1}`,
      fingerprint: row.fingerprint || "",
      authority: row.status === "unavailable" ? "unverified" : "supporting",
    })),
    facts: claimText(input.currentState, input.facts, input.failures),
    assumptions: claimText(input.assumptions),
    unknowns: claimText(input.unknowns),
    decisions: claimText(input.decisions),
    limitations: claimText(input.constraints, input.risks, observations.filter((row) => row?.status === "unavailable").map((row) => row.error || `${row.sourceId} unavailable`)),
    coverageComplete,
  });
}

function normalizeContextDossier(input) {
  const path = "contextDossier";
  const meta = base(input, path, CONTRACT_KINDS.contextDossier);
  const realGoal = text(input.realGoal || input.projectOutcome || input.outcome, `${path}.realGoal`, { required: true, max: 10000 });
  const dossierId = recordId(input, ["dossierId", "id"], path, meta.inputVersion, realGoal);
  const sources = array(input.sources, `${path}.sources`, normalizeContextSource, { max: 500 });
  const record = {
    ...meta.record,
    dossierId,
    missionId: recordId(input, ["missionId", "taskId"], path, meta.inputVersion, `mission:${realGoal}`),
    revision: revision(input, path),
    state: enumeration(input.state, new Set(["building", "ready", "stale", "failed"]), `${path}.state`, meta.inputVersion === 1 ? "stale" : "building"),
    realGoal,
    executiveSummary: text(input.executiveSummary || input.summary, `${path}.executiveSummary`, { max: 12000 }),
    sourceFingerprint: input.sourceFingerprint ? fingerprint(input.sourceFingerprint, `${path}.sourceFingerprint`, { required: true }) : "",
    sources,
    facts: stringList(input.facts, `${path}.facts`, { maxItems: 500, maxChars: 2000 }),
    assumptions: stringList(input.assumptions, `${path}.assumptions`, { maxItems: 250, maxChars: 2000 }),
    unknowns: stringList(input.unknowns, `${path}.unknowns`, { maxItems: 250, maxChars: 2000 }),
    decisions: stringList(input.decisions, `${path}.decisions`, { maxItems: 250, maxChars: 2000 }),
    limitations: stringList(input.limitations, `${path}.limitations`, { maxItems: 100, maxChars: 2000 }),
    coverageComplete: boolean(input.coverageComplete, `${path}.coverageComplete`, false),
    refreshedAt: timestamp(input.refreshedAt, `${path}.refreshedAt`),
    ...lifecycle(input, path),
  };
  if (record.state === "ready" && (!record.sourceFingerprint || !record.coverageComplete || record.sources.length === 0)) {
    invalid(`${path}.state`, "ready context requires complete coverage, sources, and a source fingerprint");
  }
  return complete(record, input, path);
}

function normalizeMilestone(row, path, index) {
  object(row, path);
  const outcome = text(row.outcome || row.goal || row.title, `${path}.outcome`, { required: true, max: 3000 });
  return {
    milestoneId: id(row.milestoneId || row.id, `${path}.milestoneId`, { prefix: "milestone", legacySeed: `${index}:${outcome}` }),
    title: text(row.title, `${path}.title`, { max: 300, default: outcome.slice(0, 300) }),
    outcome,
    state: enumeration(row.state || row.status, new Set(["pending", "ready", "running", "awaiting-evidence", "completed", "blocked", "cancelled"]), `${path}.state`, "pending"),
    dependsOn: stringList(row.dependsOn, `${path}.dependsOn`, { maxItems: 50, maxChars: 120 }),
    evidenceCriteria: stringList(row.evidenceCriteria || row.acceptanceCriteria, `${path}.evidenceCriteria`, { maxItems: 50, maxChars: 2000 }),
    requirementIds: stringList(row.requirementIds, `${path}.requirementIds`, { maxItems: 100, maxChars: 120 }),
  };
}

function normalizeDemand(value, path) {
  const row = value == null ? {} : object(value, path);
  return {
    tokens: integer(row.tokens, `${path}.tokens`, { min: 0, default: 0 }),
    durationMinutes: integer(row.durationMinutes, `${path}.durationMinutes`, { min: 0, default: 0 }),
    attempts: integer(row.attempts, `${path}.attempts`, { min: 0, default: 0 }),
    concurrency: integer(row.concurrency, `${path}.concurrency`, { min: 0, default: 0 }),
    premiumCalls: integer(row.premiumCalls, `${path}.premiumCalls`, { min: 0, default: 0 }),
  };
}

function normalizeWorkstream(row, path, index) {
  object(row, path);
  const goal = text(row.goal || row.outcome || row.title, `${path}.goal`, { required: true, max: 3000 });
  return {
    workstreamId: id(row.workstreamId || row.id, `${path}.workstreamId`, { prefix: "workstream", legacySeed: `${index}:${goal}` }),
    title: text(row.title, `${path}.title`, { max: 300, default: goal.slice(0, 300) }),
    goal,
    state: enumeration(row.state, new Set(["pending", "ready", "running", "completed", "blocked", "cancelled"]), `${path}.state`, "pending"),
    dependsOn: stringList(row.dependsOn, `${path}.dependsOn`, { maxItems: 50, maxChars: 120 }),
    milestoneIds: stringList(row.milestoneIds, `${path}.milestoneIds`, { maxItems: 100, maxChars: 120 }),
    parallelizable: boolean(row.parallelizable, `${path}.parallelizable`, false),
    capabilities: stringList(row.capabilities, `${path}.capabilities`, { maxItems: 100, maxChars: 200 }),
    permissions: stringList(row.permissions, `${path}.permissions`, { maxItems: 100, maxChars: 300 }),
    evidenceCriteria: stringList(row.evidenceCriteria || row.acceptanceCriteria, `${path}.evidenceCriteria`, { maxItems: 50, maxChars: 2000 }),
    estimatedDemand: normalizeDemand(row.estimatedDemand, `${path}.estimatedDemand`),
  };
}

function normalizeTimeline(row, path, index) {
  object(row, path);
  return {
    milestoneId: id(row.milestoneId, `${path}.milestoneId`),
    sequence: integer(row.sequence, `${path}.sequence`, { min: 1, default: index + 1 }),
    startsAt: timestamp(row.startsAt, `${path}.startsAt`),
    targetAt: timestamp(row.targetAt || row.endsAt, `${path}.targetAt`),
    durationHours: number(row.durationHours, `${path}.durationHours`, { min: 0, default: 0 }),
  };
}

function normalizeRisk(row, path, index) {
  if (typeof row === "string") row = { description: row };
  object(row, path);
  const description = text(row.description, `${path}.description`, { required: true, max: 2000 });
  return {
    riskId: id(row.riskId || row.id, `${path}.riskId`, { prefix: "risk", legacySeed: `${index}:${description}` }),
    description,
    probability: enumeration(row.probability, new Set(["low", "medium", "high", "unknown"]), `${path}.probability`, "unknown"),
    impact: enumeration(row.impact, new Set(["low", "medium", "high", "critical", "unknown"]), `${path}.impact`, "unknown"),
    mitigation: text(row.mitigation, `${path}.mitigation`, { max: 2000 }),
    trigger: text(row.trigger, `${path}.trigger`, { max: 1000 }),
  };
}

function assertUnique(rows, key, path) {
  const seen = new Set();
  for (const row of rows) {
    if (seen.has(row[key])) invalid(path, `contains duplicate ${key} ${row[key]}`);
    seen.add(row[key]);
  }
  return seen;
}

function assertGraph(rows, key, path) {
  const ids = assertUnique(rows, key, path);
  const visiting = new Set();
  const visited = new Set();
  const byId = new Map(rows.map((row) => [row[key], row]));
  function visit(current) {
    if (visiting.has(current)) invalid(path, `contains a dependency cycle at ${current}`);
    if (visited.has(current)) return;
    visiting.add(current);
    for (const dependency of byId.get(current)?.dependsOn || []) {
      if (!ids.has(dependency)) invalid(path, `${current} depends on unknown id ${dependency}`);
      if (dependency === current) invalid(path, `${current} cannot depend on itself`);
      visit(dependency);
    }
    visiting.delete(current);
    visited.add(current);
  }
  for (const value of ids) visit(value);
  return ids;
}

function normalizeMasterPlan(input) {
  const path = "masterPlan";
  const meta = base(input, path, CONTRACT_KINDS.masterPlan);
  const objective = text(input.objective || input.outcome || input.goal, `${path}.objective`, { required: true, max: 10000 });
  const planId = recordId(input, ["planId", "id"], path, meta.inputVersion, objective);
  const milestones = array(input.milestones, `${path}.milestones`, normalizeMilestone, { max: 250 });
  const workstreams = array(input.workstreams, `${path}.workstreams`, normalizeWorkstream, { max: 250 });
  const milestoneIds = assertGraph(milestones, "milestoneId", `${path}.milestones`);
  const workstreamIds = assertGraph(workstreams, "workstreamId", `${path}.workstreams`);
  for (const row of workstreams) {
    for (const milestoneId of row.milestoneIds) if (!milestoneIds.has(milestoneId)) invalid(`${path}.workstreams`, `references unknown milestone ${milestoneId}`);
  }
  const timeline = array(input.timeline, `${path}.timeline`, normalizeTimeline, { max: 250 });
  assertUnique(timeline, "milestoneId", `${path}.timeline`);
  for (const row of timeline) if (!milestoneIds.has(row.milestoneId)) invalid(`${path}.timeline`, `references unknown milestone ${row.milestoneId}`);
  const record = {
    ...meta.record,
    planId,
    missionId: recordId(input, ["missionId", "taskId"], path, meta.inputVersion, `mission:${objective}`),
    dossierId: recordId(input, ["dossierId", "contextId"], path, meta.inputVersion, `dossier:${objective}`),
    revision: revision(input, path),
    contextRevision: integer(input.contextRevision, `${path}.contextRevision`, { min: 1, default: 1 }),
    state: enumeration(input.state, new Set(["draft", "review", "approved", "superseded", "rejected"]), `${path}.state`, "draft"),
    objective,
    strategy: text(input.strategy, `${path}.strategy`, { max: 15000 }),
    milestones,
    workstreams,
    timeline,
    risks: array(input.risks, `${path}.risks`, normalizeRisk, { max: 250 }),
    assumptions: stringList(input.assumptions, `${path}.assumptions`, { maxItems: 250, maxChars: 2000 }),
    approval: text(input.approval, `${path}.approval`, { max: 2000 }),
    ...lifecycle(input, path),
  };
  if (record.state === "approved") {
    if (!record.strategy || milestones.length === 0 || workstreams.length === 0) invalid(`${path}.state`, "approved plan requires strategy, milestones, and workstreams");
    if (milestones.some((row) => row.evidenceCriteria.length === 0)) invalid(`${path}.milestones`, "every approved milestone requires evidence criteria");
    if (workstreams.some((row) => row.evidenceCriteria.length === 0)) invalid(`${path}.workstreams`, "every approved workstream requires evidence criteria");
    if (timeline.length !== milestones.length || timeline.some((row) => !row.targetAt && row.durationHours <= 0)) invalid(`${path}.timeline`, "approved plan requires timing for every milestone");
  }
  if (workstreamIds.size !== workstreams.length) invalid(`${path}.workstreams`, "ids must be unique");
  return complete(record, input, path);
}

function normalizeLimits(value, path) {
  const row = value == null ? {} : object(value, path);
  return {
    maxTokens: integer(row.maxTokens, `${path}.maxTokens`, { min: 0, default: 0 }),
    maxDurationMs: integer(row.maxDurationMs, `${path}.maxDurationMs`, { min: 0, default: 0 }),
    maxConcurrentWorkers: integer(row.maxConcurrentWorkers, `${path}.maxConcurrentWorkers`, { min: 0, max: 1000, default: 0 }),
    maxAttempts: integer(row.maxAttempts, `${path}.maxAttempts`, { min: 0, max: 100000, default: 0 }),
    maxDiskBytes: integer(row.maxDiskBytes, `${path}.maxDiskBytes`, { min: 0, default: 0 }),
    maxRamMb: integer(row.maxRamMb, `${path}.maxRamMb`, { min: 0, default: 0 }),
  };
}

function normalizeReserves(value, path) {
  const row = value == null ? {} : object(value, path);
  return {
    contextTokens: integer(row.contextTokens, `${path}.contextTokens`, { min: 0, default: 0 }),
    strategyTokens: integer(row.strategyTokens, `${path}.strategyTokens`, { min: 0, default: 0 }),
    verificationTokens: integer(row.verificationTokens, `${path}.verificationTokens`, { min: 0, default: 0 }),
    reconciliationTokens: integer(row.reconciliationTokens, `${path}.reconciliationTokens`, { min: 0, default: 0 }),
    emergencyTokens: integer(row.emergencyTokens, `${path}.emergencyTokens`, { min: 0, default: 0 }),
    quotaPercent: number(row.quotaPercent, `${path}.quotaPercent`, { min: 0, max: 100, default: 0 }),
  };
}

function normalizeAllocation(row, path, index) {
  object(row, path);
  const workstreamId = id(row.workstreamId, `${path}.workstreamId`);
  return {
    allocationId: id(row.allocationId || row.id, `${path}.allocationId`, { prefix: "allocation", legacySeed: `${index}:${workstreamId}` }),
    workstreamId,
    role: text(row.role, `${path}.role`, { required: true, max: 200 }),
    provider: text(row.provider, `${path}.provider`, { required: true, max: 120 }),
    model: text(row.model, `${path}.model`, { required: true, max: 240 }),
    quotaPool: text(row.quotaPool, `${path}.quotaPool`, { max: 160 }),
    tokenLimit: integer(row.tokenLimit, `${path}.tokenLimit`, { min: 0, default: 0 }),
    durationLimitMs: integer(row.durationLimitMs, `${path}.durationLimitMs`, { min: 0, default: 0 }),
    maxAttempts: integer(row.maxAttempts, `${path}.maxAttempts`, { min: 1, max: 1000, default: 1 }),
    concurrency: integer(row.concurrency, `${path}.concurrency`, { min: 1, max: 1000, default: 1 }),
    permissions: stringList(row.permissions, `${path}.permissions`, { maxItems: 100, maxChars: 300 }),
  };
}

function normalizeResourceBudget(input) {
  const path = "resourceBudget";
  const meta = base(input, path, CONTRACT_KINDS.resourceBudget);
  const seed = `${input.missionId || input.taskId || "legacy"}:${input.planId || "plan"}`;
  const allocations = array(input.allocations, `${path}.allocations`, normalizeAllocation, { max: 500 });
  assertUnique(allocations, "allocationId", `${path}.allocations`);
  const limits = normalizeLimits(input.limits, `${path}.limits`);
  const reserves = normalizeReserves(input.reserves, `${path}.reserves`);
  const record = {
    ...meta.record,
    budgetId: recordId(input, ["budgetId", "id"], path, meta.inputVersion, seed),
    missionId: recordId(input, ["missionId", "taskId"], path, meta.inputVersion, `mission:${seed}`),
    dossierId: recordId(input, ["dossierId", "contextId"], path, meta.inputVersion, `dossier:${seed}`),
    planId: recordId(input, ["planId"], path, meta.inputVersion, `plan:${seed}`),
    revision: revision(input, path),
    contextRevision: integer(input.contextRevision, `${path}.contextRevision`, { min: 1, default: 1 }),
    planRevision: integer(input.planRevision, `${path}.planRevision`, { min: 1, default: 1 }),
    state: enumeration(input.state, new Set(["draft", "active", "paused", "exhausted", "superseded", "cancelled"]), `${path}.state`, "draft"),
    inventoryFingerprint: input.inventoryFingerprint ? fingerprint(input.inventoryFingerprint, `${path}.inventoryFingerprint`, { required: true }) : "",
    forecastFingerprint: input.forecastFingerprint ? fingerprint(input.forecastFingerprint, `${path}.forecastFingerprint`, { required: true }) : "",
    limits,
    reserves,
    allocations,
    resetSchedule: array(input.resetSchedule, `${path}.resetSchedule`, (row, rowPath) => {
      object(row, rowPath);
      return { pool: text(row.pool, `${rowPath}.pool`, { required: true, max: 160 }), resetAt: timestamp(row.resetAt, `${rowPath}.resetAt`) };
    }, { max: 100 }),
    effectiveAt: timestamp(input.effectiveAt, `${path}.effectiveAt`),
    expiresAt: timestamp(input.expiresAt, `${path}.expiresAt`),
    ...lifecycle(input, path),
  };
  const tokenReservations = allocations.reduce((sum, row) => sum + row.tokenLimit, 0)
    + reserves.contextTokens + reserves.strategyTokens + reserves.verificationTokens + reserves.reconciliationTokens + reserves.emergencyTokens;
  if (limits.maxTokens > 0 && tokenReservations > limits.maxTokens) invalid(`${path}.allocations`, "allocations plus reserves exceed maxTokens");
  if (record.state === "active" && (!record.inventoryFingerprint || limits.maxTokens <= 0 || limits.maxDurationMs <= 0 || limits.maxConcurrentWorkers <= 0 || limits.maxAttempts <= 0)) {
    invalid(`${path}.state`, "active budget requires inventory evidence and positive execution limits");
  }
  return complete(record, input, path);
}

function normalizeProgressSignal(value, path) {
  const row = value == null ? {} : object(value, path);
  return {
    metric: text(row.metric, `${path}.metric`, { max: 500 }),
    baseline: number(row.baseline, `${path}.baseline`, { min: Number.MIN_SAFE_INTEGER, max: Number.MAX_SAFE_INTEGER, default: 0 }),
    target: number(row.target, `${path}.target`, { min: Number.MIN_SAFE_INTEGER, max: Number.MAX_SAFE_INTEGER, default: 0 }),
    minimumDelta: number(row.minimumDelta, `${path}.minimumDelta`, { min: 0, default: 0 }),
    evidenceLevel: enumeration(row.evidenceLevel, EVIDENCE_LEVELS, `${path}.evidenceLevel`, "end-to-end"),
  };
}

function normalizeCampaign(input) {
  const path = "campaign";
  const meta = base(input, path, CONTRACT_KINDS.campaign);
  const seed = `${input.missionId || input.taskId || "legacy"}:${input.planId || "plan"}:${input.revision || 1}`;
  const progressSignal = normalizeProgressSignal(input.progressSignal, `${path}.progressSignal`);
  const cadenceInput = input.cadence == null ? {} : object(input.cadence, `${path}.cadence`);
  const checkpointInput = input.checkpoint == null ? {} : object(input.checkpoint, `${path}.checkpoint`);
  const record = {
    ...meta.record,
    campaignId: recordId(input, ["campaignId", "roundId", "id"], path, meta.inputVersion, seed),
    missionId: recordId(input, ["missionId", "taskId"], path, meta.inputVersion, `mission:${seed}`),
    dossierId: recordId(input, ["dossierId", "contextId"], path, meta.inputVersion, `dossier:${seed}`),
    planId: recordId(input, ["planId"], path, meta.inputVersion, `plan:${seed}`),
    budgetId: recordId(input, ["budgetId"], path, meta.inputVersion, `budget:${seed}`),
    revision: revision(input, path),
    contextRevision: integer(input.contextRevision, `${path}.contextRevision`, { min: 1, default: 1 }),
    planRevision: integer(input.planRevision, `${path}.planRevision`, { min: 1, default: 1 }),
    budgetRevision: integer(input.budgetRevision, `${path}.budgetRevision`, { min: 1, default: 1 }),
    state: enumeration(input.state, new Set(["planned", "running", "paused", "completed", "failed", "cancelled"]), `${path}.state`, "planned"),
    milestoneIds: stringList(input.milestoneIds, `${path}.milestoneIds`, { maxItems: 250, maxChars: 120 }),
    workPackageIds: stringList(input.workPackageIds, `${path}.workPackageIds`, { maxItems: 1000, maxChars: 120 }),
    acceptanceTargets: stringList(input.acceptanceTargets, `${path}.acceptanceTargets`, { maxItems: 250, maxChars: 2000 }),
    progressSignal,
    resourceCap: normalizeLimits(input.resourceCap, `${path}.resourceCap`),
    reserveFloorTokens: integer(input.reserveFloorTokens, `${path}.reserveFloorTokens`, { min: 0, default: 0 }),
    noProgressLimit: integer(input.noProgressLimit, `${path}.noProgressLimit`, { min: 1, max: 1000, default: 3 }),
    cadence: {
      checkIntervalMs: integer(cadenceInput.checkIntervalMs, `${path}.cadence.checkIntervalMs`, { min: 1000, default: 60000 }),
      backoffMs: integer(cadenceInput.backoffMs, `${path}.cadence.backoffMs`, { min: 0, default: 0 }),
      maxBackoffMs: integer(cadenceInput.maxBackoffMs, `${path}.cadence.maxBackoffMs`, { min: 0, default: 0 }),
    },
    idempotencyKey: text(input.idempotencyKey, `${path}.idempotencyKey`, { max: 240 }),
    checkpoint: {
      sequence: integer(checkpointInput.sequence, `${path}.checkpoint.sequence`, { min: 0, default: 0 }),
      lastEvidenceFingerprint: checkpointInput.lastEvidenceFingerprint ? fingerprint(checkpointInput.lastEvidenceFingerprint, `${path}.checkpoint.lastEvidenceFingerprint`, { required: true }) : "",
      lastProgressAt: timestamp(checkpointInput.lastProgressAt, `${path}.checkpoint.lastProgressAt`),
    },
    ...lifecycle(input, path),
  };
  if (record.cadence.maxBackoffMs && record.cadence.maxBackoffMs < record.cadence.backoffMs) invalid(`${path}.cadence.maxBackoffMs`, "must be greater than or equal to backoffMs");
  if (record.reserveFloorTokens > record.resourceCap.maxTokens && record.resourceCap.maxTokens > 0) invalid(`${path}.reserveFloorTokens`, "cannot exceed campaign maxTokens");
  if (record.state === "running" && (!progressSignal.metric || record.resourceCap.maxTokens <= 0 || record.resourceCap.maxDurationMs <= 0 || !record.idempotencyKey || record.milestoneIds.length === 0)) {
    invalid(`${path}.state`, "running campaign requires milestones, progress signal, idempotency key, and positive resource caps");
  }
  return complete(record, input, path);
}

function normalizeRevisionStamp(value, path) {
  const row = object(value, path);
  return {
    id: id(row.id, `${path}.id`),
    revision: integer(row.revision, `${path}.revision`, { min: 1, required: true }),
    fingerprint: fingerprint(row.fingerprint, `${path}.fingerprint`, { required: true, exact: true }),
  };
}

function normalizeRevisionTuple(input) {
  const path = "revisionTuple";
  object(input, path);
  return Object.freeze({
    mission: Object.freeze(normalizeRevisionStamp(input.mission, `${path}.mission`)),
    context: Object.freeze(normalizeRevisionStamp(input.context, `${path}.context`)),
    plan: Object.freeze(normalizeRevisionStamp(input.plan, `${path}.plan`)),
    budget: Object.freeze(normalizeRevisionStamp(input.budget, `${path}.budget`)),
    campaign: Object.freeze(normalizeRevisionStamp(input.campaign, `${path}.campaign`)),
  });
}

function stamp(record, kind, idField) {
  if (!isObject(record) || record.contractKind !== kind) invalid(kind, `must be a normalized ${kind} record`);
  const expected = fingerprintRecord(record);
  if (record.fingerprint !== expected) invalid(`${kind}.fingerprint`, "does not match record content");
  return { id: record[idField], revision: record.revision, fingerprint: record.fingerprint };
}

function makeRevisionTuple(records) {
  object(records, "records");
  return normalizeRevisionTuple({
    mission: stamp(records.mission, CONTRACT_KINDS.mission, "missionId"),
    context: stamp(records.contextDossier, CONTRACT_KINDS.contextDossier, "dossierId"),
    plan: stamp(records.masterPlan, CONTRACT_KINDS.masterPlan, "planId"),
    budget: stamp(records.resourceBudget, CONTRACT_KINDS.resourceBudget, "budgetId"),
    campaign: stamp(records.campaign, CONTRACT_KINDS.campaign, "campaignId"),
  });
}

function normalizeRevisionFence(input) {
  const path = "revisionFence";
  object(input, path);
  const schemaVersion = input.schemaVersion == null ? CONTRACT_SCHEMA_VERSION : Number(input.schemaVersion);
  if (schemaVersion !== CONTRACT_SCHEMA_VERSION) invalid(`${path}.schemaVersion`, `must equal ${CONTRACT_SCHEMA_VERSION}`);
  const record = {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    contractKind: "RevisionFence",
    stage: enumeration(input.stage, new Set(["dispatch", "integration"]), `${path}.stage`, "dispatch"),
    tuple: normalizeRevisionTuple(input.tuple),
  };
  return complete(record, input, path);
}

function createRevisionFence(records, stage = "dispatch") {
  return normalizeRevisionFence({ schemaVersion: CONTRACT_SCHEMA_VERSION, stage, tuple: makeRevisionTuple(records) });
}

function currentTuple(recordsOrTuple) {
  if (isObject(recordsOrTuple?.mission) && Object.hasOwn(recordsOrTuple.mission, "contractKind")) return makeRevisionTuple(recordsOrTuple);
  return normalizeRevisionTuple(recordsOrTuple);
}

function assertRevisionFence(fenceValue, recordsOrTuple, options = {}) {
  const fence = normalizeRevisionFence(fenceValue);
  const allowedStages = new Set(options.allowedStages || ["dispatch", "integration"]);
  if (!allowedStages.has(fence.stage)) invalid("revisionFence.stage", `is not valid for ${options.operation || "this operation"}`);
  const current = currentTuple(recordsOrTuple);
  const differences = [];
  for (const component of ["mission", "context", "plan", "budget", "campaign"]) {
    const expected = fence.tuple[component];
    const actual = current[component];
    if (expected.id !== actual.id || expected.revision !== actual.revision || expected.fingerprint !== actual.fingerprint) {
      differences.push({ component, expected, actual });
    }
  }
  if (differences.length) throw new StaleRevisionError(options.operation || fence.stage, differences);
  return { valid: true, stage: fence.stage, fingerprint: fence.fingerprint, tuple: current };
}

function assertDispatchFence(fence, current) {
  return assertRevisionFence(fence, current, { allowedStages: ["dispatch"], operation: "dispatch" });
}

function assertIntegrationFence(fence, current) {
  return assertRevisionFence(fence, current, { allowedStages: ["dispatch", "integration"], operation: "integration" });
}

function normalizeDeliverable(value, path, fallbackType = "analysis") {
  const row = value == null ? {} : object(value, path);
  return {
    type: enumeration(row.type, DELIVERABLE_TYPES, `${path}.type`, fallbackType),
    required: boolean(row.required, `${path}.required`, true),
    artifactPaths: stringList(row.artifactPaths, `${path}.artifactPaths`, { maxItems: 250, maxChars: 1000 }),
    description: text(row.description, `${path}.description`, { max: 2000 }),
  };
}

function normalizeVerification(row, path) {
  if (typeof row === "string") row = { instruction: row };
  object(row, path);
  return {
    type: enumeration(row.type, new Set(["command", "evidence", "query", "browser", "assertion", "manual"]), `${path}.type`, "assertion"),
    instruction: text(row.instruction || row.command, `${path}.instruction`, { required: true, max: 3000 }),
    expected: text(row.expected, `${path}.expected`, { max: 2000 }),
  };
}

function normalizeWorkPackage(input) {
  const path = "workPackage";
  const meta = base(input, path, CONTRACT_KINDS.workPackage);
  const goal = text(input.goal || input.outcome || input.title, `${path}.goal`, { required: true, max: 6000 });
  const type = enumeration(input.type || input.taskKind, WORK_TYPES, `${path}.type`, "context");
  const fallbackDeliverable = ({ code: "patch", operation: "operation-receipt", browser: "browser-receipt", external: "external-receipt", data: "data-receipt", monitoring: "monitor-report", verification: "verification-report", strategy: "plan", reconciliation: "plan" })[type] || "analysis";
  const record = {
    ...meta.record,
    workPackageId: recordId(input, ["workPackageId", "jobId", "id"], path, meta.inputVersion, goal),
    missionId: recordId(input, ["missionId", "taskId"], path, meta.inputVersion, `mission:${goal}`),
    dossierId: recordId(input, ["dossierId", "contextId"], path, meta.inputVersion, `dossier:${goal}`),
    planId: recordId(input, ["planId"], path, meta.inputVersion, `plan:${goal}`),
    budgetId: recordId(input, ["budgetId"], path, meta.inputVersion, `budget:${goal}`),
    campaignId: recordId(input, ["campaignId", "roundId"], path, meta.inputVersion, `campaign:${goal}`),
    revision: revision(input, path),
    state: enumeration(input.state, new Set(["planned", "ready", "dispatched", "running", "completed", "failed", "cancelled"]), `${path}.state`, "planned"),
    type,
    title: text(input.title, `${path}.title`, { max: 300, default: goal.slice(0, 300) }),
    goal,
    workstreamId: input.workstreamId ? id(input.workstreamId, `${path}.workstreamId`) : null,
    milestoneId: input.milestoneId ? id(input.milestoneId, `${path}.milestoneId`) : null,
    dependsOn: stringList(input.dependsOn, `${path}.dependsOn`, { maxItems: 250, maxChars: 120 }),
    assignee: input.assignee == null ? null : {
      provider: text(object(input.assignee, `${path}.assignee`).provider, `${path}.assignee.provider`, { required: true, max: 120 }),
      model: text(input.assignee.model, `${path}.assignee.model`, { required: true, max: 240 }),
      role: text(input.assignee.role, `${path}.assignee.role`, { required: true, max: 200 }),
    },
    requiredCapabilities: stringList(input.requiredCapabilities, `${path}.requiredCapabilities`, { maxItems: 100, maxChars: 200 }),
    requiredPermissions: stringList(input.requiredPermissions, `${path}.requiredPermissions`, { maxItems: 100, maxChars: 300 }),
    requiredTools: stringList(input.requiredTools, `${path}.requiredTools`, { maxItems: 100, maxChars: 300 }),
    contextRefs: stringList(input.contextRefs, `${path}.contextRefs`, { maxItems: 250, maxChars: 1000 }),
    deliverable: normalizeDeliverable(input.deliverable, `${path}.deliverable`, fallbackDeliverable),
    acceptanceCriteria: stringList(input.acceptanceCriteria, `${path}.acceptanceCriteria`, { maxItems: 100, maxChars: 2000 }),
    verification: array(input.verification, `${path}.verification`, normalizeVerification, { max: 100 }),
    rollback: input.rollback == null ? null : {
      required: boolean(object(input.rollback, `${path}.rollback`).required, `${path}.rollback.required`, false),
      instruction: text(input.rollback.instruction, `${path}.rollback.instruction`, { max: 3000 }),
      idempotencyKey: text(input.rollback.idempotencyKey, `${path}.rollback.idempotencyKey`, { max: 240 }),
    },
    idempotencyKey: text(input.idempotencyKey, `${path}.idempotencyKey`, { max: 240 }),
    limits: normalizeLimits(input.limits, `${path}.limits`),
    revisionFence: input.revisionFence == null ? null : normalizeRevisionFence(input.revisionFence),
    ...lifecycle(input, path),
  };
  if (["ready", "dispatched", "running", "completed"].includes(record.state) && (!record.revisionFence || record.acceptanceCriteria.length === 0 || record.verification.length === 0)) {
    invalid(`${path}.state`, `${record.state} work requires a revision fence, acceptance criteria, and verification`);
  }
  if (["operation", "browser", "external", "data"].includes(type) && ["ready", "dispatched", "running"].includes(record.state) && !record.idempotencyKey) {
    invalid(`${path}.idempotencyKey`, `is required for ${type} work`);
  }
  if (record.rollback?.required && (!record.rollback.instruction || !record.rollback.idempotencyKey)) invalid(`${path}.rollback`, "required rollback needs an instruction and idempotency key");
  return complete(record, input, path);
}

function normalizeUsage(value, path) {
  const row = value == null ? {} : object(value, path);
  return {
    inputTokens: integer(row.inputTokens, `${path}.inputTokens`, { min: 0, default: 0 }),
    cacheCreationInputTokens: integer(row.cacheCreationInputTokens, `${path}.cacheCreationInputTokens`, { min: 0, default: 0 }),
    cacheReadInputTokens: integer(row.cacheReadInputTokens, `${path}.cacheReadInputTokens`, { min: 0, default: 0 }),
    outputTokens: integer(row.outputTokens, `${path}.outputTokens`, { min: 0, default: 0 }),
    totalTokens: integer(row.totalTokens, `${path}.totalTokens`, { min: 0, default: 0 }),
    durationMs: integer(row.durationMs, `${path}.durationMs`, { min: 0, default: 0 }),
    attempts: integer(row.attempts, `${path}.attempts`, { min: 0, default: 0 }),
    allocationAttempt: integer(row.allocationAttempt, `${path}.allocationAttempt`, { min: 1, default: 1 }),
  };
}

function normalizeArtifact(row, path) {
  if (typeof row === "string") row = { ref: row };
  object(row, path);
  return {
    ref: text(row.ref || row.path, `${path}.ref`, { required: true, max: 2000 }),
    fingerprint: row.fingerprint ? fingerprint(row.fingerprint, `${path}.fingerprint`, { required: true }) : "",
    kind: text(row.kind, `${path}.kind`, { max: 120 }),
  };
}

function normalizeOperation(row, path, index) {
  object(row, path);
  const target = text(row.target, `${path}.target`, { required: true, max: 2000 });
  return {
    operationId: id(row.operationId || row.id, `${path}.operationId`, { prefix: "operation", legacySeed: `${index}:${target}` }),
    type: text(row.type, `${path}.type`, { required: true, max: 160 }),
    target,
    status: enumeration(row.status, new Set(["planned", "applied", "verified", "rolled-back", "failed"]), `${path}.status`, "planned"),
    idempotencyKey: text(row.idempotencyKey, `${path}.idempotencyKey`, { max: 240 }),
    receiptRef: text(row.receiptRef, `${path}.receiptRef`, { max: 2000 }),
    rollbackRef: text(row.rollbackRef, `${path}.rollbackRef`, { max: 2000 }),
  };
}

function normalizeExecutionReceipt(input) {
  const path = "executionReceipt";
  const meta = base(input, path, CONTRACT_KINDS.executionReceipt);
  const workPackageSeed = input.workPackageId || input.jobId || "legacy-work";
  const artifacts = array(input.artifacts, `${path}.artifacts`, normalizeArtifact, { max: 500 });
  const operations = array(input.operations, `${path}.operations`, normalizeOperation, { max: 500 });
  const evidenceRefs = stringList(input.evidenceRefs, `${path}.evidenceRefs`, { maxItems: 500, maxChars: 2000 });
  const record = {
    ...meta.record,
    receiptId: recordId(input, ["receiptId", "id"], path, meta.inputVersion, `${workPackageSeed}:${input.attemptId || 1}`),
    missionId: recordId(input, ["missionId", "taskId"], path, meta.inputVersion, `mission:${workPackageSeed}`),
    campaignId: recordId(input, ["campaignId", "roundId"], path, meta.inputVersion, `campaign:${workPackageSeed}`),
    workPackageId: recordId(input, ["workPackageId", "jobId"], path, meta.inputVersion, workPackageSeed),
    attemptId: recordId(input, ["attemptId"], path, meta.inputVersion, `attempt:${workPackageSeed}`),
    revision: revision(input, path),
    state: enumeration(input.state || input.status, new Set(["pending", "succeeded", "failed", "rejected"]), `${path}.state`, "pending"),
    provider: text(input.provider, `${path}.provider`, { max: 120 }),
    model: text(input.model, `${path}.model`, { max: 240 }),
    deliverableType: enumeration(input.deliverableType, DELIVERABLE_TYPES, `${path}.deliverableType`, "analysis"),
    summary: text(input.summary || input.outputSummary, `${path}.summary`, { max: 12000 }),
    artifacts,
    operations,
    evidenceRefs,
    usage: normalizeUsage(input.usage, `${path}.usage`),
    revisionFence: input.revisionFence == null ? null : normalizeRevisionFence(input.revisionFence),
    startedAt: timestamp(input.startedAt, `${path}.startedAt`),
    completedAt: timestamp(input.completedAt, `${path}.completedAt`),
    ...lifecycle(input, path),
  };
  if (record.state === "succeeded" && (!record.revisionFence || !record.summary || artifacts.length + operations.length + evidenceRefs.length === 0)) {
    invalid(`${path}.state`, "successful receipt requires a fence, summary, and concrete artifact, operation, or evidence");
  }
  return complete(record, input, path);
}

function normalizeAttempt(row, path, index) {
  object(row, path);
  return {
    attemptId: id(row.attemptId || row.id, `${path}.attemptId`, { prefix: "attempt", legacySeed: `${index}:${row.provider || "unknown"}` }),
    provider: text(row.provider, `${path}.provider`, { max: 120 }),
    model: text(row.model, `${path}.model`, { max: 240 }),
    at: timestamp(row.at, `${path}.at`),
    outcome: enumeration(row.outcome, new Set(["failed", "rejected", "timed-out", "cancelled", "unknown"]), `${path}.outcome`, "unknown"),
    reason: text(row.reason, `${path}.reason`, { max: 3000 }),
  };
}

function normalizeFailurePacket(input) {
  const path = "failurePacket";
  const meta = base(input, path, CONTRACT_KINDS.failurePacket);
  const summary = text(input.summary || input.reason, `${path}.summary`, { required: true, max: 6000 });
  const record = {
    ...meta.record,
    failureId: recordId(input, ["failureId", "id"], path, meta.inputVersion, summary),
    missionId: recordId(input, ["missionId", "taskId"], path, meta.inputVersion, `mission:${summary}`),
    campaignId: recordId(input, ["campaignId", "roundId"], path, meta.inputVersion, `campaign:${summary}`),
    workPackageId: input.workPackageId || input.jobId ? id(input.workPackageId || input.jobId, `${path}.workPackageId`) : null,
    revision: revision(input, path),
    state: enumeration(input.state, new Set(["unclassified", "reconciling", "replanned", "resolved", "user-decision"]), `${path}.state`, "unclassified"),
    phase: enumeration(input.phase, new Set(["context", "planning", "budget", "preflight", "dispatch", "execution", "verification", "integration", "reporting"]), `${path}.phase`, "execution"),
    classification: enumeration(input.classification, new Set(["unknown", "transient-provider", "permission-tool", "contract-manager", "worker-capability", "verification", "project-semantic", "context-stale", "plan-invalid", "resource-budget", "external-write", "user-decision"]), `${path}.classification`, "unknown"),
    summary,
    rootCause: text(input.rootCause, `${path}.rootCause`, { max: 6000 }),
    recoveryAction: text(input.recoveryAction, `${path}.recoveryAction`, { max: 6000 }),
    repeatedOutcomeCount: integer(input.repeatedOutcomeCount, `${path}.repeatedOutcomeCount`, { min: 1, max: 1000, default: 1 }),
    attempts: array(input.attempts, `${path}.attempts`, normalizeAttempt, { max: 1000 }),
    evidenceRefs: stringList(input.evidenceRefs, `${path}.evidenceRefs`, { maxItems: 500, maxChars: 2000 }),
    logRefs: stringList(input.logRefs, `${path}.logRefs`, { maxItems: 500, maxChars: 2000 }),
    previousFailureIds: stringList(input.previousFailureIds, `${path}.previousFailureIds`, { maxItems: 250, maxChars: 120 }),
    revisionFence: input.revisionFence == null ? null : normalizeRevisionFence(input.revisionFence),
    ...lifecycle(input, path),
  };
  if (record.state !== "unclassified" && !record.rootCause) invalid(`${path}.rootCause`, "is required after classification begins");
  if (["replanned", "resolved"].includes(record.state) && !record.recoveryAction) invalid(`${path}.recoveryAction`, `is required when failure is ${record.state}`);
  return complete(record, input, path);
}

function normalizeEvidenceEntry(row, path, index) {
  object(row, path);
  const ref = text(row.ref, `${path}.ref`, { required: true, max: 2000 });
  const result = {
    evidenceId: id(row.evidenceId || row.id, `${path}.evidenceId`, { prefix: "evidence", legacySeed: `${index}:${ref}` }),
    requirementId: row.requirementId ? id(row.requirementId, `${path}.requirementId`) : null,
    milestoneId: row.milestoneId ? id(row.milestoneId, `${path}.milestoneId`) : null,
    workPackageId: row.workPackageId ? id(row.workPackageId, `${path}.workPackageId`) : null,
    level: enumeration(row.level, EVIDENCE_LEVELS, `${path}.level`, "activity"),
    state: enumeration(row.state || row.status, new Set(["candidate", "accepted", "rejected", "superseded"]), `${path}.state`, "candidate"),
    ref,
    summary: text(row.summary, `${path}.summary`, { required: true, max: 3000 }),
    verifier: text(row.verifier, `${path}.verifier`, { max: 240 }),
    sourceFingerprint: row.sourceFingerprint ? fingerprint(row.sourceFingerprint, `${path}.sourceFingerprint`, { required: true }) : "",
    verifiedAt: timestamp(row.verifiedAt, `${path}.verifiedAt`),
  };
  if (result.state === "accepted" && (!result.verifier || !result.sourceFingerprint || !result.verifiedAt)) invalid(path, "accepted evidence requires verifier, sourceFingerprint, and verifiedAt");
  return result;
}

function normalizeEvidenceLedger(input) {
  const path = "evidenceLedger";
  const meta = base(input, path, CONTRACT_KINDS.evidenceLedger);
  const seed = input.missionId || input.taskId || "legacy-evidence";
  const entries = array(input.entries || input.evidence, `${path}.entries`, normalizeEvidenceEntry, { max: 5000 });
  assertUnique(entries, "evidenceId", `${path}.entries`);
  const record = {
    ...meta.record,
    ledgerId: recordId(input, ["ledgerId", "id"], path, meta.inputVersion, seed),
    missionId: recordId(input, ["missionId", "taskId"], path, meta.inputVersion, `mission:${seed}`),
    revision: revision(input, path),
    state: enumeration(input.state, new Set(["active", "sealed", "superseded"]), `${path}.state`, "active"),
    entries,
    acceptedCount: entries.filter((row) => row.state === "accepted").length,
    highestAcceptedLevel: [...EVIDENCE_LEVELS].reverse().find((level) => entries.some((row) => row.state === "accepted" && row.level === level)) || null,
    ...lifecycle(input, path),
  };
  return complete(record, input, path);
}

function normalizeReportCursor(input) {
  const path = "reportCursor";
  const meta = base(input, path, CONTRACT_KINDS.reportCursor);
  const seed = `${input.missionId || input.taskId || "legacy"}:${input.channel || "codex"}`;
  const record = {
    ...meta.record,
    cursorId: recordId(input, ["cursorId", "id"], path, meta.inputVersion, seed),
    missionId: recordId(input, ["missionId", "taskId"], path, meta.inputVersion, `mission:${seed}`),
    revision: revision(input, path),
    state: enumeration(input.state, new Set(["active", "paused", "closed"]), `${path}.state`, "active"),
    channel: text(input.channel, `${path}.channel`, { required: meta.inputVersion !== 1, max: 200, default: "codex" }),
    sequence: integer(input.sequence, `${path}.sequence`, { min: 0, default: 0 }),
    lastEventId: text(input.lastEventId, `${path}.lastEventId`, { max: 160 }),
    lastEventFingerprint: input.lastEventFingerprint ? fingerprint(input.lastEventFingerprint, `${path}.lastEventFingerprint`, { required: true }) : "",
    lastReportedAt: timestamp(input.lastReportedAt, `${path}.lastReportedAt`),
    ...lifecycle(input, path),
  };
  if (record.sequence > 0 && (!record.lastEventId || !record.lastEventFingerprint)) invalid(`${path}.sequence`, "positive sequence requires an event id and fingerprint");
  return complete(record, input, path);
}

const NORMALIZERS = Object.freeze({
  Mission: normalizeMission,
  ContextDossier: normalizeContextDossier,
  MasterPlan: normalizeMasterPlan,
  ResourceBudget: normalizeResourceBudget,
  Campaign: normalizeCampaign,
  WorkPackage: normalizeWorkPackage,
  ExecutionReceipt: normalizeExecutionReceipt,
  FailurePacket: normalizeFailurePacket,
  EvidenceLedger: normalizeEvidenceLedger,
  ReportCursor: normalizeReportCursor,
});

function normalizeContract(kind, input) {
  const canonicalKind = CONTRACT_KINDS[kind] || kind;
  const normalizer = NORMALIZERS[canonicalKind];
  if (!normalizer) invalid("contractKind", `unsupported contract ${kind}`);
  return normalizer(input);
}

function validateContract(kind, input) {
  try {
    return { valid: true, record: normalizeContract(kind, input), errors: [] };
  } catch (error) {
    if (!(error instanceof ContractValidationError)) throw error;
    return { valid: false, record: null, errors: [{ code: error.code, path: error.path, message: error.message }] };
  }
}

module.exports = {
  CONTRACT_KINDS,
  CONTRACT_SCHEMA_VERSION,
  ContractValidationError,
  DELIVERABLE_TYPES,
  EVIDENCE_LEVELS,
  StaleRevisionError,
  WORK_TYPES,
  assertDispatchFence,
  assertIntegrationFence,
  assertRevisionFence,
  createRevisionFence,
  fingerprintRecord,
  makeRevisionTuple,
  normalizeCampaign,
  adaptContextDossierV1,
  normalizeContextDossier,
  normalizeContract,
  normalizeEvidenceLedger,
  normalizeExecutionReceipt,
  normalizeFailurePacket,
  normalizeMasterPlan,
  normalizeMission,
  normalizeReportCursor,
  normalizeResourceBudget,
  normalizeRevisionFence,
  normalizeRevisionTuple,
  normalizeWorkPackage,
  stableStringify,
  validateContract,
};
