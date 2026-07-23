"use strict";

const crypto = require("node:crypto");
const { bounded, boundedList, utcNow } = require("./utils");

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

function hash(value) {
  return crypto.createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
}

function classifyFailure(value, context = {}) {
  const text = String(value?.blocker || value?.reason || value || "").toLowerCase();
  if (context.ambiguousExternalWrite === true || /timeout after (?:submit|send|publish|payment)|ambiguous external/.test(text)) return "ambiguous-external-write";
  if (/provider-output-invalid|error_max_structured_output_retries|failed to provide valid structured output/.test(text)) return "director-contract";
  if (/resource-accounting(?:-basis)?-unavailable|allocation-(?:budget-exceeded|attempt-limit-exceeded|active-claim-conflict)|director-allocation-(?:missing|limits-invalid|id-missing|contract-mismatch|work-package-mismatch|candidate-missing|provider-mismatch|model-mismatch|model-unobserved|api-budget-exhausted)/.test(text)) return "resource-contract";
  const explicitTransientStatus = /(?:\bhttp(?:\/\d(?:\.\d)?)?\s*|\bstatus(?:\s*code)?\s*[:=]?\s*|\bserver(?:\s+(?:returned|responded(?:\s+with)?))?\s+)5\d{2}\b|\b5\d{2}\s+(?:internal server error|bad gateway|service unavailable|gateway timeout)\b/.test(text);
  const explicitRateLimitStatus = /(?:\bhttp(?:\/\d(?:\.\d)?)?\s*|\bstatus(?:\s*code)?\s*[:=]?\s*)429\b|\b429\s+too many requests\b/.test(text);
  if (explicitTransientStatus
    || explicitRateLimitStatus
    || /rate.?limit|connection reset|temporary|timed? ?out|provider-timeout/.test(text)) return "transient-provider";
  if (/permission|authorization|access denied|tool.*unavailable|missing callable|not authenticated/.test(text)) return "permission-or-tool";
  if (/master-plan-assurance-failed/.test(text)) return "plan-invalid";
  if (/no-patch-produced|artifact.*missing|context (?:scout )?artifact requires|schema|contract|invalid .*argument|path-invalid|deterministically available source.*unavailable|query receipt/.test(text)) return "director-contract";
  if (/verification|test.*fail|postcondition|evidence.*insufficient/.test(text)) return "verification";
  if (/model.*unavailable|capability|too (?:weak|small)|context window/.test(text)) return "worker-capability";
  if (/context.*stale|invented path|source.*changed|fingerprint/.test(text)) return "context-stale";
  if (/plan.*invalid|dependency|critical path|workstream/.test(text)) return "plan-invalid";
  if (/captcha|credential|login|user decision|irreversible|business choice/.test(text)) return "user-decision";
  return "project-semantic";
}

function createFailurePacket(input = {}) {
  const result = input.result || {};
  const workPackage = input.workPackage || {};
  const packet = {
    schemaVersion: 2,
    packetId: "",
    taskId: bounded(input.taskId, 140),
    projectId: bounded(input.projectId, 140),
    missionId: bounded(input.missionId, 140),
    campaignId: bounded(input.campaignId, 140),
    workPackageId: bounded(workPackage.workPackageId || input.workPackageId, 140),
    attemptId: bounded(input.attemptId || result.jobId, 140),
    acceptanceIds: boundedList(input.acceptanceIds || workPackage.acceptanceIds, 20, 120),
    revisions: {
      context: Number(input.revisions?.context || 0),
      plan: Number(input.revisions?.plan || 0),
      budget: Number(input.revisions?.budget || 0),
      campaign: Number(input.revisions?.campaign || 0),
    },
    executorKind: bounded(workPackage.executorKind || workPackage.kind, 80),
    deliverableKind: bounded(workPackage.deliverableKind, 80),
    provider: bounded(input.allocation?.provider || result.provider, 80),
    model: bounded(input.allocation?.model || result.model, 180),
    permissions: boundedList(input.allocation?.permissionGrant || workPackage.permissionGrant, 30, 100),
    contractFingerprint: hash(workPackage),
    stateFingerprint: bounded(input.stateFingerprint || workPackage.observedStateFingerprint, 180),
    blocker: bounded(result.blocker || input.blocker, 1600),
    output: bounded(result.summary || result.result, 4000),
    verification: input.verification || result.verification || null,
    resourceSnapshot: input.resourceSnapshot || null,
    priorAttemptIds: boundedList(input.priorAttemptIds, 20, 140),
    occurredAt: input.occurredAt || utcNow(),
  };
  packet.failureClass = classifyFailure(packet.blocker, input);
  packet.failureFingerprint = hash({
    acceptanceIds: packet.acceptanceIds,
    workPackageId: packet.workPackageId,
    executorKind: packet.executorKind,
    deliverableKind: packet.deliverableKind,
    contractFingerprint: packet.contractFingerprint,
    stateFingerprint: packet.stateFingerprint,
    failureClass: packet.failureClass,
    blocker: packet.blocker.replace(/\b\d{4}-\d\d-\d\d[^ ]*|\bpid\s*\d+|\bjob-[a-z0-9._-]+/gi, "<volatile>"),
  });
  packet.packetId = "failure-" + packet.failureFingerprint.slice(0, 20);
  return packet;
}

function failureLineage(history = [], packet = {}) {
  const rows = (Array.isArray(history) ? history : []).filter((row) => (
    row
    && (row.failureFingerprint === packet.failureFingerprint
      || (row.acceptanceIds || []).some((id) => (packet.acceptanceIds || []).includes(id)))
  ));
  const exact = rows.filter((row) => row.failureFingerprint === packet.failureFingerprint);
  return {
    acceptanceFailureCount: rows.length + 1,
    unchangedFailureCount: exact.length + 1,
    previous: rows.at(-1) || null,
  };
}

function recoveryPolicy(packet, history = []) {
  const lineage = failureLineage(history, packet);
  const idempotent = Boolean(packet.stateFingerprint || packet.executorKind === "context-scout" || packet.executorKind === "verification");
  if (packet.failureClass === "user-decision") {
    return { action: "request-user-decision", strongReconciler: false, retryEligible: false, fullContextRefresh: false, lineage };
  }
  if (packet.failureClass === "ambiguous-external-write") {
    return { action: "observe-authoritative-state", strongReconciler: true, retryEligible: false, fullContextRefresh: false, lineage };
  }
  if (packet.failureClass === "transient-provider" && idempotent && lineage.unchangedFailureCount <= 2) {
    return { action: "bounded-backoff-retry", strongReconciler: false, retryEligible: true, backoffSeconds: lineage.unchangedFailureCount * 30, fullContextRefresh: false, lineage };
  }
  const repeatedSameFailure = lineage.unchangedFailureCount >= 2;
  const fullContextRefresh = packet.failureClass === "context-stale" || repeatedSameFailure;
  return {
    action: fullContextRefresh ? "refresh-context-and-revise-plan" : "strong-reconciliation",
    strongReconciler: true,
    retryEligible: false,
    fullContextRefresh,
    revisePlan: repeatedSameFailure || packet.failureClass === "plan-invalid",
    lineage,
  };
}

function reconciliationWorkPackage(packet, history = []) {
  const policy = recoveryPolicy(packet, history);
  return {
    workPackageId: "reconcile-" + packet.failureFingerprint.slice(0, 20),
    executorKind: "reconciliation",
    deliverableKind: "reconciliation-decision",
    goal: "Determine the evidence-backed root cause and materially revise the context, plan, contract, permissions, or worker assignment before execution resumes.",
    acceptanceIds: packet.acceptanceIds,
    dependencies: [],
    minimumCapabilityTier: "frontier",
    complexity: "large",
    readOnly: true,
    requiredCapabilities: ["source", "local-files"],
    requiredPermissions: ["read-project", "read-files"],
    permissionGrant: ["read-project", "read-files"],
    failurePacket: packet,
    failureHistory: (Array.isArray(history) ? history : []).slice(-8),
    policy,
    acceptanceCriteria: [
      "Name one evidence-backed root cause.",
      "Specify the material change required before another attempt.",
      "Declare context, plan, permission, contract, and worker revisions explicitly.",
      "Request user action only for authority, authentication, irreversible action, missing fact, or genuine trade-off.",
    ],
  };
}
function contextRefreshRequested(value) {
  return value === true || Boolean(value && typeof value === "object" && !Array.isArray(value) && value.required === true);
}


function decisionFingerprint(decision = {}) {
  return hash({
    rootCause: decision.rootCause || "",
    contextRefresh: contextRefreshRequested(decision.contextRefresh),
    planRevision: decision.planRevision || null,
    changedContract: decision.changedContract || null,
    changedWorkerRequirements: decision.changedWorkerRequirements || null,
    changedPermissions: decision.changedPermissions || null,
    retryEligibility: decision.retryEligibility || null,
    userDecision: decision.userDecision || null,
  });
}

function validateReconciliationDecision(decision = {}, packet = {}) {
  const reasons = [];
  if (!String(decision.rootCause || "").trim()) reasons.push("rootCause is required");
  if (!Array.isArray(decision.evidence) || !decision.evidence.length) reasons.push("root-cause evidence is required");
  if (decision.planRevision && (typeof decision.planRevision !== "object" || Array.isArray(decision.planRevision) || !Object.keys(decision.planRevision).length)) reasons.push("planRevision must be a non-empty object");
  const materialChange = contextRefreshRequested(decision.contextRefresh)
    || decision.planRevision
    || decision.changedContract
    || decision.changedWorkerRequirements
    || decision.changedPermissions
    || decision.userDecision;
  if (!materialChange) reasons.push("a material change or exact user decision is required");
  if (decision.retryEligibility === true && !materialChange) reasons.push("unchanged retry is forbidden");
  if (decision.failureFingerprint && decision.failureFingerprint !== packet.failureFingerprint) reasons.push("failure fingerprint mismatch");
  return { ok: reasons.length === 0, blocker: reasons.join("; "), fingerprint: decisionFingerprint(decision) };
}

module.exports = {
  classifyFailure,
  contextRefreshRequested,
  createFailurePacket,
  decisionFingerprint,
  failureLineage,
  reconciliationWorkPackage,
  recoveryPolicy,
  validateReconciliationDecision,
};
