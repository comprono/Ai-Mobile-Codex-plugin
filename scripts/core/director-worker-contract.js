"use strict";

const crypto = require("node:crypto");
const { normalizeModelId } = require("./trusted-models");

const DIRECTOR_WORKER_SCHEMA_VERSION = "director-cfo/worker-contract@1";
const MAX_DIRECTOR_WORKER_CONTRACT_CHARS = 200000;

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

function contractFingerprint(value) {
  return crypto.createHash("sha256").update(JSON.stringify(stable(value || {}))).digest("hex");
}

function copy(value) {
  return value == null ? null : JSON.parse(JSON.stringify(value));
}

function createDirectorWorkerContract(workPackage = {}) {
  const bootstrapContract = copy(workPackage.bootstrapContract);
  const reconciliation = workPackage.failurePacket ? {
    failurePacket: copy(workPackage.failurePacket),
    policy: copy(workPackage.policy),
    failedWorkPackageId: String(workPackage.failedWorkPackageId || ""),
  } : null;
  const executionEnvelope = {
    workPackageId: String(workPackage.workPackageId || ""),
    allocation: copy(workPackage.allocation),
    executorKind: String(workPackage.executorKind || ""),
    deliverableKind: String(workPackage.deliverableKind || ""),
    artifactContract: copy(bootstrapContract?.artifactContract || workPackage.artifactContract),
    acceptanceIds: copy(workPackage.acceptanceIds || []),
    evidenceRequirementIds: copy(workPackage.evidenceRequirementIds || workPackage.planEvidenceRequirementIds || []),
    evidenceRequirements: copy(workPackage.evidenceRequirements || []),
    acceptanceCriteria: copy(workPackage.acceptanceCriteria || []),
    commands: copy(workPackage.commands || []),
    verificationCommands: copy(workPackage.verificationCommands || []),
    preconditions: copy(workPackage.preconditions || []),
    postconditions: copy(workPackage.postconditions || []),
    rollback: copy(workPackage.rollback),
    recoveryAction: String(workPackage.recoveryAction || ""),
    mutatesExternalState: workPackage.mutatesExternalState === true,
    sideEffectKey: String(workPackage.sideEffectKey || ""),
    observedStateFingerprint: String(workPackage.observedStateFingerprint || ""),
    userAuthorizationRef: String(workPackage.userAuthorizationRef || ""),
    authorization: {
      requiredCapabilities: copy(workPackage.requiredCapabilities || []),
      requiredPermissions: copy(workPackage.requiredPermissions || []),
      permissionGrant: copy(workPackage.permissionGrant || []),
      permissionPreflight: copy(workPackage.permissionPreflight),
    },
    revisions: {
      revisionFence: copy(workPackage.revisionFence),
      budgetRevision: Number(workPackage.budgetRevision || 0),
      allocationId: String(workPackage.allocation?.allocationId || ""),
      allocationCandidateId: String(workPackage.allocation?.candidateId || ""),
      allocationProvider: String(workPackage.allocation?.provider || ""),
      allocationModel: String(workPackage.allocation?.model || ""),
      allocationTokenLimit: Number(workPackage.allocation?.tokenLimit || 0),
      allocationDurationLimitMs: Number(workPackage.allocation?.durationLimitMs || 0),
      allocationMaxAttempts: Number(workPackage.allocation?.maxAttempts || 0),
    },
  };
  const basis = {
    schemaVersion: DIRECTOR_WORKER_SCHEMA_VERSION,
    instructions: bootstrapContract ? "" : String(workPackage.prompt || workPackage.goal || ""),
    bootstrapContract,
    reconciliation,
    executionEnvelope,
  };
  const serialized = JSON.stringify(basis);
  if (serialized.length > MAX_DIRECTOR_WORKER_CONTRACT_CHARS) {
    throw new Error(`director-worker-contract-too-large:${serialized.length}`);
  }
  return { ...basis, contractFingerprint: contractFingerprint(basis) };
}

function assertDirectorWorkerContract(value) {
  if (!value || value.schemaVersion !== DIRECTOR_WORKER_SCHEMA_VERSION) {
    throw new Error("director-worker-contract-missing-or-unsupported");
  }
  const { contractFingerprint: supplied, ...basis } = value;
  const serialized = JSON.stringify(basis);
  if (serialized.length > MAX_DIRECTOR_WORKER_CONTRACT_CHARS) {
    throw new Error(`director-worker-contract-too-large:${serialized.length}`);
  }
  const expected = contractFingerprint(basis);
  if (!supplied || supplied !== expected) throw new Error("director-worker-contract-fingerprint-mismatch");
  return value;
}

function assertDirectorAllocationBinding(contract = {}) {
  if (!contract.directorProgram) return null;
  const workerContract = assertDirectorWorkerContract(contract.directorWorkerContract);
  const allocation = contract.allocation;
  if (!allocation || typeof allocation !== "object") throw new Error("director-allocation-missing");

  const allocationId = String(allocation.allocationId || "").trim();
  const candidateId = String(allocation.candidateId || "").trim();
  const workPackageId = String(allocation.workPackageId || "").trim();
  const expectedWorkPackageId = String(contract.directorProgram.workPackageId || "").trim();
  const allocationProvider = String(allocation.provider || "").trim().toLowerCase();
  const contractProvider = String(contract.provider || "").trim().toLowerCase();
  const allocationModel = normalizeModelId(allocation.model);
  const contractModel = normalizeModelId(contract.model);

  if (!allocationId) throw new Error("director-allocation-id-missing");
  if (!candidateId) throw new Error("director-allocation-candidate-missing");
  if (!allocationProvider || !contractProvider || allocationProvider !== contractProvider) {
    throw new Error("director-allocation-provider-mismatch");
  }
  if (!allocationModel || !contractModel || allocationModel !== contractModel) {
    throw new Error("director-allocation-model-mismatch");
  }
  if (!workPackageId || !expectedWorkPackageId || workPackageId !== expectedWorkPackageId) {
    throw new Error("director-allocation-work-package-mismatch");
  }

  const envelope = workerContract.executionEnvelope;
  const immutableAllocation = envelope?.allocation;
  const revisions = envelope?.revisions;
  if (!immutableAllocation || typeof immutableAllocation !== "object"
    || JSON.stringify(stable(immutableAllocation)) !== JSON.stringify(stable(allocation))
    || String(envelope.workPackageId || "").trim() !== workPackageId
    || String(revisions?.allocationId || "").trim() !== allocationId
    || String(revisions?.allocationCandidateId || "").trim() !== candidateId
    || String(revisions?.allocationProvider || "").trim().toLowerCase() !== allocationProvider
    || normalizeModelId(revisions?.allocationModel) !== allocationModel
    || Number(revisions?.allocationTokenLimit || 0) !== Number(allocation.tokenLimit || 0)
    || Number(revisions?.allocationDurationLimitMs || 0) !== Number(allocation.durationLimitMs || 0)
    || Number(revisions?.allocationMaxAttempts || 0) !== Number(allocation.maxAttempts || 0)) {
    throw new Error("director-allocation-contract-mismatch");
  }

  return {
    allocation,
    allocationId,
    candidateId,
    workPackageId,
    provider: allocationProvider,
    model: allocationModel,
    workerContract,
  };
}

module.exports = {
  DIRECTOR_WORKER_SCHEMA_VERSION,
  MAX_DIRECTOR_WORKER_CONTRACT_CHARS,
  assertDirectorAllocationBinding,
  assertDirectorWorkerContract,
  contractFingerprint,
  createDirectorWorkerContract,
};
