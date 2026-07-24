"use strict";

const crypto = require("node:crypto");
const { bounded, boundedList } = require("./utils");

const EXECUTOR_KINDS = Object.freeze([
  "context-scout",
  "strategist",
  "code-change",
  "operational-transaction",
  "browser-action",
  "external-transaction",
  "evidence-observer",
  "verification",
  "reconciliation",
]);

const DELIVERABLE_BY_EXECUTOR = Object.freeze({
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

const RECEIPT_KINDS = new Set([
  "operation-receipt",
  "browser-receipt",
  "external-transaction-receipt",
  "monitoring-evidence",
  "verification-result",
]);

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

function deliverableFingerprint(value) {
  return crypto.createHash("sha256").update(JSON.stringify(stable(value || {}))).digest("hex");
}

function executorKind(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return EXECUTOR_KINDS.includes(normalized) ? normalized : "code-change";
}

function deliverableKind(contract = {}) {
  const explicit = String(contract.deliverableKind || contract.artifactKind || "").trim().toLowerCase();
  return explicit || DELIVERABLE_BY_EXECUTOR[executorKind(contract.executorKind || contract.kind)] || "patch";
}

function rows(values, maxItems = 30) {
  return (Array.isArray(values) ? values : []).slice(0, maxItems).map((row, index) => ({
    name: bounded(row?.name || row?.description || "check-" + (index + 1), 160),
    passed: row?.passed === true,
    evidence: bounded(row?.evidence || row?.receipt || row?.summary || "", 1200),
  }));
}

function renderedCommand(command = {}) {
  const executable = String(command.command || "").trim();
  const args = (Array.isArray(command.args) ? command.args : []).map((arg) => {
    const value = String(arg);
    return /\s|"/.test(value) ? JSON.stringify(value) : value;
  });
  return [executable, ...args].filter(Boolean).join(" ");
}

function exactStringRows(values) {
  return (Array.isArray(values) ? values : []).map((value) => String(value || "").trim());
}

function legacyOperationReceipt(value = {}, contract = {}, handoff = {}) {
  if (value.schemaVersion !== "director-cfo/operation-receipt@1") return null;
  const expectedCommands = (Array.isArray(contract.commands) ? contract.commands : []).map(renderedCommand);
  const actions = Array.isArray(value.actions) ? value.actions : [];
  const expectedPreconditions = exactStringRows(contract.preconditions);
  const expectedPostconditions = exactStringRows(contract.postconditions);
  const actualPreconditions = exactStringRows(value.preconditions);
  const actualPostconditions = exactStringRows(value.postconditions);
  const allocationId = String(contract.allocation?.allocationId || "").trim();
  const workPackageId = String(contract.directorProgram?.workPackageId || contract.workPackageId || "").trim();
  const sideEffectKey = String(contract.sideEffectKey || "").trim();
  const observedFingerprint = String(contract.observedStateFingerprint || "").trim();
  const idempotency = value.idempotencyState && typeof value.idempotencyState === "object"
    ? value.idempotencyState
    : {};
  const wrapperVerification = handoff.verification && typeof handoff.verification === "object"
    ? handoff.verification
    : {};
  const providerPreflight = value.authoritativeEvidence?.preflightVerification;
  const exactActions = expectedCommands.length > 0
    && actions.length === expectedCommands.length
    && actions.every((action, index) => (
      String(action?.command || "").trim() === expectedCommands[index]
      && Number(action?.exitCode) === 0
    ));
  const exactContract = (
    String(value.workPackageId || "").trim() === workPackageId
    && String(value.allocationId || "").trim() === allocationId
    && String(value.executorKind || "").trim() === String(contract.executorKind || "").trim()
    && String(value.deliverableKind || "").trim() === String(contract.deliverableKind || contract.artifactKind || "").trim()
    && value.status === "SUCCEEDED"
    && !value.blocker
    && idempotency.executed === true
    && String(idempotency.sideEffectKey || "").trim() === sideEffectKey
    && String(idempotency.observedStateFingerprint || "").trim() === observedFingerprint
    && JSON.stringify(actualPreconditions) === JSON.stringify(expectedPreconditions)
    && JSON.stringify(actualPostconditions) === JSON.stringify(expectedPostconditions)
  );
  const verified = (
    wrapperVerification.required === true
    && wrapperVerification.passed === true
    && wrapperVerification.state === "passed"
    && Array.isArray(wrapperVerification.checks)
    && wrapperVerification.checks.length > 0
    && wrapperVerification.checks.every((check) => check?.passed === true && Number(check?.exitCode) === Number(check?.expectedExitCode || 0))
  );
  const providerPreflightValid = !providerPreflight || (
    Number(providerPreflight.exitCode) === 0
    && providerPreflight.safeToStart === true
  );
  if (!exactContract || !exactActions || !verified || !providerPreflightValid) return null;

  const verificationEvidence = wrapperVerification.checks.map((check) => ({
    name: check.name,
    command: check.command,
    args: check.args,
    exitCode: check.exitCode,
    passed: check.passed,
  }));
  const afterFingerprint = deliverableFingerprint({
    authoritativeEvidence: value.authoritativeEvidence || {},
    verification: verificationEvidence,
  });
  const rollbackValue = value.rollbackOrRecovery && typeof value.rollbackOrRecovery === "object"
    ? value.rollbackOrRecovery
    : {};
  const rollbackEvidence = rollbackValue.backupPath
    || rollbackValue.description
    || rollbackValue.recoveryAction
    || contract.rollback?.description
    || "";
  return {
    schemaVersion: 2,
    kind: "operation-receipt",
    state: "applied",
    sideEffectKey,
    observedStateFingerprintBefore: observedFingerprint,
    observedStateFingerprintAfter: afterFingerprint,
    userAuthorizationRef: bounded(contract.userAuthorizationRef, 500),
    idempotency: {
      checked: true,
      duplicate: false,
      key: sideEffectKey,
      evidence: bounded(`Matched immutable allocation ${allocationId} and its exact side-effect key before adopting the verified result.`, 1200),
    },
    preconditions: actualPreconditions.map((name) => ({
      name: bounded(name, 160),
      passed: true,
      evidence: "Matched the authorized work-package precondition.",
    })),
    actions: actions.map((action) => ({
      name: bounded(action.command, 160),
      passed: true,
      evidence: bounded(action.summary || `Command exited ${action.exitCode}.`, 1200),
    })),
    postconditions: actualPostconditions.map((name) => ({
      name: bounded(name, 160),
      passed: true,
      evidence: bounded(`Confirmed by ${wrapperVerification.checks.length} deterministic verification check(s).`, 1200),
    })),
    rollback: {
      available: Boolean(rollbackEvidence),
      executed: false,
      evidence: bounded(rollbackEvidence, 1200),
    },
    evidence: [
      bounded(`Deterministic verification passed (${afterFingerprint}).`, 1200),
      ...(rollbackValue.backupPath ? [bounded(`Backup: ${rollbackValue.backupPath}`, 1200)] : []),
    ],
    acceptanceEvidence: [],
    blocker: "",
  };
}

function normalizeReceipt(value = {}, expectedKind = "", contract = {}, handoff = {}) {
  const legacy = expectedKind === "operation-receipt"
    ? legacyOperationReceipt(value, contract, handoff)
    : null;
  if (legacy) return legacy;
  const kind = String(value.kind || expectedKind || "").trim().toLowerCase();
  return {
    schemaVersion: 2,
    kind,
    state: ["applied", "no-op", "observed", "verified", "failed"].includes(value.state) ? value.state : "failed",
    sideEffectKey: bounded(value.sideEffectKey, 240),
    observedStateFingerprintBefore: bounded(value.observedStateFingerprintBefore || value.beforeFingerprint, 160),
    observedStateFingerprintAfter: bounded(value.observedStateFingerprintAfter || value.afterFingerprint, 160),
    userAuthorizationRef: bounded(value.userAuthorizationRef, 500),
    idempotency: {
      checked: value.idempotency?.checked === true,
      duplicate: value.idempotency?.duplicate === true,
      key: bounded(value.idempotency?.key || value.sideEffectKey, 240),
      evidence: bounded(value.idempotency?.evidence, 1200),
    },
    preconditions: rows(value.preconditions),
    actions: rows(value.actions || value.steps, 60),
    postconditions: rows(value.postconditions),
    rollback: value.rollback && typeof value.rollback === "object" ? {
      available: value.rollback.available === true,
      executed: value.rollback.executed === true,
      evidence: bounded(value.rollback.evidence || value.rollback.receipt, 1200),
    } : null,
    evidence: boundedList(value.evidence, 30, 1200),
    acceptanceEvidence: (Array.isArray(value.acceptanceEvidence) ? value.acceptanceEvidence : []).slice(0, 30).map((row) => ({
      requirementId: bounded(row?.requirementId, 120),
      level: bounded(row?.level, 40),
      ref: bounded(row?.ref, 1000),
      summary: bounded(row?.summary, 1200),
      passed: row?.passed === true,
    })),
    blocker: bounded(value.blocker, 1200),
  };
}

function receiptValidation(receipt, contract = {}) {
  const reasons = [];
  if (!RECEIPT_KINDS.has(receipt.kind)) reasons.push("unsupported receipt kind");
  if (["operation-receipt", "external-transaction-receipt"].includes(receipt.kind)) {
    if (!receipt.sideEffectKey) reasons.push("sideEffectKey is required");
    if (!receipt.idempotency.checked) reasons.push("idempotency must be checked");
    if (!receipt.observedStateFingerprintBefore) reasons.push("before fingerprint is required");
    if (!receipt.observedStateFingerprintAfter) reasons.push("after fingerprint is required");
  }
  if (receipt.kind === "external-transaction-receipt" && !receipt.userAuthorizationRef) {
    reasons.push("userAuthorizationRef is required");
  }
  if (!receipt.preconditions.length || receipt.preconditions.some((row) => !row.passed)) {
    reasons.push("all preconditions must be recorded and pass");
  }
  if (!receipt.postconditions.length || receipt.postconditions.some((row) => !row.passed)) {
    reasons.push("all postconditions must be recorded and pass");
  }
  if (receipt.state === "failed" || receipt.blocker) reasons.push(receipt.blocker || "receipt state is failed");
  if (String(contract.sideEffectKey || "").trim() && receipt.sideEffectKey !== String(contract.sideEffectKey).trim()) {
    reasons.push("side-effect key does not match the work package");
  }
  return {
    ok: reasons.length === 0,
    blocker: reasons.join("; "),
    reasons,
    fingerprint: deliverableFingerprint(receipt),
  };
}

function validateTypedDeliverable(contract = {}, handoff = {}) {
  const kind = deliverableKind(contract);
  if (kind === "patch") {
    const reasons = [];
    if (handoff.patchAvailable !== true && contract.skipModelReview !== true) reasons.push("patch is required");
    if (handoff.verification?.required === true && handoff.verification?.passed !== true) reasons.push("deterministic verification did not pass");
    return { ok: reasons.length === 0, kind, blocker: reasons.join("; "), deliverable: null };
  }
  if (!RECEIPT_KINDS.has(kind)) {
    const artifact = handoff.artifact || handoff.deliverable || null;
    return {
      ok: Boolean(artifact),
      kind,
      blocker: artifact ? "" : kind + " structured artifact is missing",
      deliverable: artifact,
      fingerprint: artifact ? deliverableFingerprint(artifact) : "",
    };
  }
  const receipt = normalizeReceipt(handoff.deliverable || handoff.artifact || {}, kind, contract, handoff);
  return { ...receiptValidation(receipt, contract), kind, deliverable: receipt };
}

function promptContractFor(contract = {}) {
  const kind = deliverableKind(contract);
  if (kind === "patch") return "";
  if (kind === "context-dossier") {
    return "Return exactly one JSON Context Dossier matching the supplied schema and source catalog. Separate verified facts, assumptions, unknowns, current gaps, constraints, source pointers, and source fingerprints. Do not propose implementation work.";
  }
  if (kind === "master-plan") {
    return "Return exactly one JSON Master Plan with milestones, timeline, dependencies, workstreams, team roles, permissions, risks, recovery alternatives, acceptance evidence, and resource estimates. Every work package must advance named acceptance evidence.";
  }
  if (kind === "reconciliation-decision") {
    return "Return exactly one JSON reconciliation decision with rootCause, failureClass, evidence, contextRefresh, planRevision, budgetRevision, changedContract, changedWorkerRequirements, changedPermissions, retryEligibility, and userDecision. planRevision must be null or a non-empty JSON object containing machine-actionable plan corrections; never return a number, string, empty object, or narrative wrapper. An unchanged retry is forbidden.";
  }
  return "Return exactly one JSON " + kind + " with these exact fields: kind, state, sideEffectKey, observedStateFingerprintBefore, observedStateFingerprintAfter, userAuthorizationRef, idempotency { checked, duplicate, key, evidence }, preconditions [{ name, passed, evidence }], actions [{ name, passed, evidence }], postconditions [{ name, passed, evidence }], rollback { available, executed, evidence }, evidence, acceptanceEvidence [{ requirementId, level, ref, summary, passed }], and blocker. For a successful mutation, state must be applied and every precondition, action, and postcondition must have passed=true. Do not rename fields or return a patch.";
}

module.exports = {
  DELIVERABLE_BY_EXECUTOR,
  EXECUTOR_KINDS,
  RECEIPT_KINDS,
  deliverableFingerprint,
  deliverableKind,
  executorKind,
  legacyOperationReceipt,
  normalizeReceipt,
  promptContractFor,
  receiptValidation,
  validateTypedDeliverable,
};
