"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { boundaryAllows, changedFingerprints, collectDiff, fingerprint, statusPaths } = require("./git-evidence");
const { event, setStatus } = require("./job-store");
const { runVerification, verificationPlanningGuidance } = require("./verification");
const { clearInventoryCache } = require("./capacity");
const { bounded, readJson, redact, safeWorkspace, utcNow, writeJson } = require("./utils");
const { jobDirectory } = require("./state-store");
const { releaseResourceLease } = require("./resource-leases");
const { cleanTransientOutputs, rollbackPrimaryWorkspace } = require("./workspace-isolation");
const { providerExecutionAccess, runProvider } = require("../providers");
const { normalizeModelId } = require("./trusted-models");
const { artifactFingerprint } = require("./observation-plan");
const { applyProviderPatch } = require("./provider-patch");
const { normalizeContextScoutArtifact } = require("./context-dossier");
const {
  deliverableKind,
  executorKind,
  promptContractFor,
  validateTypedDeliverable,
} = require("./typed-deliverables");
const { permissionSet } = require("./permission-preflight");
const { fingerprint: budgetFingerprint } = require("./budget-contracts");
const { assertDirectorAllocationBinding, assertDirectorWorkerContract } = require("./director-worker-contract");

function communicationContract(mode = "smart-compact") {
  if (mode === "detailed") return "Explain the result and material reasoning clearly, without greetings, task repetition, tool narration, waiting commentary, or offers for more work.";
  if (mode === "standard") return "Use concise complete prose. Lead with the result and omit greetings, task repetition, tool narration, waiting commentary, and postambles.";
  return "Think deeply and communicate compactly. Lead with the result. Preserve exact facts, paths, commands, errors, caveats, and evidence. Omit greetings, repeated context, tool narration, waiting commentary, and postambles.";
}

function withholdLiveWorkspace(contract, prompt) {
  if (contract.isolation?.mode !== "read-only-snapshot") return prompt;
  const source = String(contract.isolation.sourceWorkspace || "").trim();
  if (!source) return prompt;
  const variants = [...new Set([source, source.replace(/\\/g, "/"), source.replace(/\//g, "\\")])]
    .sort((left, right) => right.length - left.length);
  return variants.reduce((text, variant) => {
    const escaped = variant.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return text.replace(new RegExp(escaped, "gi"), "[live-workspace-withheld]");
  }, prompt);
}

function assertCompleteSnapshotFingerprint(value) {
  if (Object.prototype.hasOwnProperty.call(value || {}, "__AI_MOBILE_FINGERPRINT_OVERFLOW__")) {
    throw new Error("read-only-snapshot-fingerprint-overflow: whole-snapshot mutation evidence exceeded the 5000-entry bound");
  }
}

function directorContractForPrompt(contract) {
  if (!contract.directorProgram) return "";
  const directorContract = assertDirectorWorkerContract(contract.directorWorkerContract);
  const contractInstruction = directorContract.bootstrapContract
    ? "Follow bootstrapContract.prompt in full. Match executionEnvelope.artifactContract exactly."
    : "Follow instructions in full. Reconcile from reconciliation.failurePacket and reconciliation.policy; an unchanged retry is forbidden. Match executionEnvelope.artifactContract exactly.";
  return [
    `Immutable Director worker contract (SHA-256 ${directorContract.contractFingerprint}):`,
    "This JSON is authoritative and must not be shortened, reinterpreted, or replaced by the unit summary.",
    contractInstruction,
    "For operations, execute only executionEnvelope.commands and preserve its preconditions, postconditions, side-effect key, observed-state fingerprint, rollback/recovery, and authorization references verbatim in the receipt.",
    JSON.stringify(directorContract),
  ].join("\n");
}

function promptFor(contract) {
  const executor = executorKind(contract.executorKind || contract.kind);
  const deliverable = deliverableKind(contract);
  const codexPatchWriter = contract.provider === "codex" && deliverable === "patch" && contract.readOnly !== true && contract.skipModelReview !== true;
  const maxWords = Math.max(220, Math.min(1400, Math.floor((contract.maxWorkerOutputTokens || 1000) * 0.7)));
  const workPlanContract = contract.artifactKind === "work-plan"
    ? 'Return exactly one JSON object and nothing else: no Markdown, code fences, commentary, or file URLs. Include every top-level key in this schema: {"outcome":"string","evidence":["string"],"checks":["string"],"blocker":"string","blockerOwner":"string","recoveryTrigger":"string","recoveryAction":"string","proposedWorkUnits":[{"goal":"string","relevantFiles":["relative/path"],"expectedFiles":["relative/path"],"acceptanceCriteria":["observable result"],"verificationCommands":[{"name":"string","command":"executable","args":["argument"],"timeoutSeconds":30}],"taskKind":"code|test|review|repository-scan","complexity":"small|medium|large","priority":100,"requiredCapabilities":["source","local-files","tests"]}]}. proposedWorkUnits must contain at most three exact dependency-ready units. Every source in relevantFiles must exist. Each expectedFiles entry must already exist or have an existing immediate parent directory. Paths must be bounded and relative; expectedFiles cannot be root-wide. Verification commands must be structured objects, never shell strings. If no safe unit exists, return an empty proposedWorkUnits array and fill blocker, blockerOwner, recoveryTrigger, and recoveryAction. ' + verificationPlanningGuidance()
    : "";
  const prompt = [
    "You are one bounded worker in a finite project round. Complete only the assigned unit.",
    contract.taskContext?.latestUserRequest ? `Latest user request: ${contract.taskContext.latestUserRequest}` : "",
    contract.taskContext?.constraints?.length ? `Project constraints:\n- ${contract.taskContext.constraints.join("\n- ")}` : "",
    contract.taskContext?.unresolvedAcceptance?.length ? `Unresolved project acceptance:\n${contract.taskContext.unresolvedAcceptance.map((item) => `- ${item.id}: ${item.description}${item.blocker ? ` (blocker: ${JSON.stringify(item.blocker)})` : ""}`).join("\n")}` : "",
    `Project outcome: ${contract.projectGoal}`,
    `Your unit summary: ${contract.goal}`,
    directorContractForPrompt(contract),
    `Visible console role (no project-file ownership): ${contract.currentCodexGoal}`,
    `Why this is independent: ${contract.independenceReason}`,
    `Execution workspace: ${contract.executionWorkspace}`,
    `Executor kind: ${executor}`,
    `Required deliverable: ${deliverable}`,
    `Mode: ${contract.readOnly ? "read-only" : contract.skipModelReview ? "trusted primary writer" : "isolated writer"}`,
    contract.readOnly ? "Read-only transport: never call write_file, create_file, edit, patch, apply_patch, or any shell-mutation tool. Return the complete required JSON artifact directly in your final stdout response; do not save the artifact to a file." : "",
    codexPatchWriter ? "Codex writer transport: read the bounded files, do not call write or shell-mutation tools, and return exactly one complete git-compatible unified diff in a ```diff fence. The coordinator will path-check and apply it only inside the isolated worktree. Include no prose outside the diff; if a safe patch is impossible, return one line beginning BLOCKER:." : "",
    contract.artifactKind === "work-plan" ? "The supplied outcome, unresolved acceptance, constraints, and bounded files are the authoritative resume context for this unit. Do not narrate setup or progress." : "",
    workPlanContract,
    contract.artifactKind !== "work-plan" ? promptContractFor(contract) : "",
    contract.relevantFiles?.length ? `Read scope: ${contract.relevantFiles.join(", ")}` : "",
    contract.expectedFiles?.length
      ? `Only allowed write boundaries: ${contract.expectedFiles.join(", ")}`
      : executor === "operational-transaction" && contract.relevantFiles?.length
        ? `Only allowed local operation boundaries: ${contract.relevantFiles.join(", ")}`
        : "Do not modify files.",
    contract.requiredCapabilities?.length ? `Required callable capabilities: ${contract.requiredCapabilities.join(", ")}` : "",
    contract.acceptanceCriteria?.length ? `Unit acceptance:\n- ${contract.acceptanceCriteria.join("\n- ")}` : "",
    contract.expectedContribution ? `Required contribution: ${contract.expectedContribution}` : "",
    contract.integrationAction ? `Coordinator integration action: ${contract.integrationAction}` : "",
    contract.skipModelReview ? "You are trusted to edit the bounded primary workspace directly. Finish the unit and run its deterministic checks; do not request another model review." : "",
    "Do not delegate, start another agent, create recurring work, interact with the visible console, or broaden scope.",
    "Read no more than 24 relevant files; stop with one exact blocker if the bounded scope is insufficient.",
    "Run only the deterministic verification commands listed in this contract. Never launch a repository-wide test suite unless that exact command is listed.",
    "Do not claim the project outcome is complete. Return only your unit result, evidence, checks, changed files, and one blocker if present.",
    communicationContract(contract.communicationMode),
    `Hard summary budget: ${contract.maxWorkerOutputTokens || 1000} output tokens, approximately ${maxWords} words. Code changes belong in files, not the summary.`,
  ].filter(Boolean).join("\n\n");
  return withholdLiveWorkspace(contract, prompt);
}

function parseStructuredValue(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  const text = String(value || "").trim();
  if (!text) return null;
  const candidates = [text];
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) candidates.push(fence[1].trim());
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first >= 0 && last > first) candidates.push(text.slice(first, last + 1));
  let depth = 0;
  let start = -1;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') {
      quoted = true;
      continue;
    }
    if (character === "{") {
      if (depth === 0) start = index;
      depth += 1;
    } else if (character === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) candidates.push(text.slice(start, index + 1));
    }
  }
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch { /* try the next bounded candidate */ }
  }
  return null;
}

function structuredArtifact(contract, response) {
  const kind = deliverableKind(contract);
  if (kind === "patch") return null;
  const value = parseStructuredValue(response.artifact) || parseStructuredValue(response.text);
  if (!value) return null;
  if (contract.artifactKind === "work-plan") {
    return {
      kind: "work-plan",
      summary: String(value.outcome || value.summary || "").trim().slice(0, 2000),
      evidence: (Array.isArray(value.evidence) ? value.evidence : []).slice(0, 8).map((item) => String(item).slice(0, 1000)),
      checks: (Array.isArray(value.checks) ? value.checks : []).slice(0, 8).map((item) => String(item).slice(0, 1000)),
      blocker: String(value.blocker || "").trim().slice(0, 1200),
      blockerOwner: String(value.blockerOwner || "").trim().slice(0, 160),
      recoveryTrigger: String(value.recoveryTrigger || "").trim().slice(0, 800),
      recoveryAction: String(value.recoveryAction || "").trim().slice(0, 1200),
      proposedWorkUnits: (Array.isArray(value.proposedWorkUnits) ? value.proposedWorkUnits : []).slice(0, 3),
    };
  }
  return value;
}

const READ_ONLY_TYPED_ARTIFACT_FILES = Object.freeze({
  "context-dossier": "context-dossier.json",
  "master-plan": "master-plan.json",
  "reconciliation-decision": "reconciliation-decision.json",
  "verification-result": "verification-result.json",
  "monitoring-evidence": "monitoring-evidence.json",
  "work-plan": "work-plan.json",
});

function salvageTypedReadOnlyArtifact(contract, executionWorkspace, changedFiles) {
  if (contract.readOnly !== true || !Array.isArray(changedFiles) || changedFiles.length !== 1) return null;
  const kind = deliverableKind(contract);
  const expectedFile = READ_ONLY_TYPED_ARTIFACT_FILES[kind];
  const relativeFile = String(changedFiles[0] || "").replace(/\\/g, "/");
  if (!expectedFile || relativeFile !== expectedFile) return null;
  const workspace = path.resolve(executionWorkspace);
  const absoluteFile = path.resolve(workspace, relativeFile);
  if (path.dirname(absoluteFile) !== workspace) return null;
  try {
    const stat = fs.lstatSync(absoluteFile);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 2 || stat.size > 2 * 1024 * 1024) return null;
    const artifact = JSON.parse(fs.readFileSync(absoluteFile, "utf8"));
    if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) return null;
    const artifactContract = contract.directorWorkerContract?.executionEnvelope?.artifactContract || contract.artifactContract || {};
    const requiredKeys = [...new Set([
      ...(Array.isArray(artifactContract.required) ? artifactContract.required : []),
      ...(Array.isArray(artifactContract.jsonSchema?.required) ? artifactContract.jsonSchema.required : []),
    ])];
    if (requiredKeys.some((key) => !Object.prototype.hasOwnProperty.call(artifact, key))) return null;
    const validation = validateTypedDeliverable(contract, {
      artifact,
      deliverable: artifact,
      patchAvailable: false,
      verification: null,
    });
    if (!validation.ok) return null;
    return { artifact, validation, relativeFile };
  } catch {
    return null;
  }
}

function canonicalDirectorArtifact(contract, artifact) {
  if (!artifact || deliverableKind(contract) !== "context-dossier") return artifact;
  const bootstrap = contract.directorWorkerContract?.bootstrapContract;
  if (!bootstrap) return artifact;
  try {
    return normalizeContextScoutArtifact(artifact, bootstrap, {
      databaseObservationReceipts: contract.contextObservationReceiptExpectations || {},
    });
  } catch {
    return artifact;
  }
}

function runtimeAuthorizationBlocker(contract) {
  const executor = executorKind(contract.executorKind || contract.kind);
  const deliverable = deliverableKind(contract);
  const grants = permissionSet(Array.isArray(contract.permissionGrant) ? contract.permissionGrant : []);
  const access = providerExecutionAccess(contract);
  const operationalMutation = executor === "operational-transaction"
    && (contract.readOnly !== true || (contract.commands || []).length > 0);
  const browserMutation = executor === "browser-action" && contract.mutatesExternalState === true;
  const externalMutation = executor === "external-transaction" || deliverable === "external-transaction-receipt";

  if (operationalMutation && (!access.commandMutationEnabled || !grants.has("run-command"))) {
    return "permission-preflight-failed: operational command execution requires exact immutable Director authorization, structured commands, effect authorization, and a run-command grant";
  }
  if (browserMutation && (!access.browserMutationEnabled || !grants.has("browser") || !grants.has("external-write") || !String(contract.userAuthorizationRef || "").trim())) {
    return "permission-preflight-failed: mutating browser work requires passed preflight, exact browser and external-write grants, and userAuthorizationRef";
  }
  if (externalMutation && (!access.externalMutationEnabled || !grants.has("external-write") || !String(contract.userAuthorizationRef || "").trim())) {
    return "permission-preflight-failed: external transactions require passed preflight, an exact external-write grant, and userAuthorizationRef";
  }
  return "";
}

function finiteUsageNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, number) : null;
}

function directorAccountingBasis(contract, allocation, durationLimitMs) {
  const basis = allocation?.accountingBasis;
  const boundBasis = contract.directorWorkerContract?.executionEnvelope?.allocation?.accountingBasis;
  if (!basis) {
    if (String(contract.provider || "").trim().toLowerCase() === "antigravity"
      && ["cli-session", "subscription", "chatgpt"].includes(String(contract.providerAuthMode || "").trim().toLowerCase())) {
      throw new Error("resource-accounting-unavailable: immutable Antigravity accounting basis is missing");
    }
    return null;
  }
  if (!boundBasis || JSON.stringify(boundBasis) !== JSON.stringify(basis)) {
    throw new Error("director-allocation-contract-mismatch: accounting basis is not immutably bound");
  }
  const { fingerprint: suppliedFingerprint, ...fingerprintBasis } = basis;
  if (!suppliedFingerprint || suppliedFingerprint !== budgetFingerprint(fingerprintBasis)) {
    throw new Error("director-allocation-contract-mismatch: accounting basis fingerprint mismatch");
  }
  if (Number(basis.durationLimitMs || 0) !== durationLimitMs) {
    throw new Error("director-allocation-contract-mismatch: accounting duration does not match allocation");
  }
  const provider = String(contract.provider || "").trim().toLowerCase();
  const authMode = String(contract.providerAuthMode || "").trim().toLowerCase();
  if (provider !== "antigravity" || basis.accountingClass !== "consumer-quota-session") return basis;
  if (basis.schemaVersion !== "director-cfo/resource-accounting-basis@1"
    || basis.provider !== provider
    || basis.authMode !== authMode
    || !["wall-time-and-exclusive-quota-reservation", "bounded-wall-time-exclusive-unknown-quota"].includes(basis.mode)
    || basis.tokenUsageState !== "unavailable"
    || basis.postRunQuotaRefreshRequired !== true) {
    throw new Error("resource-accounting-unavailable: Antigravity accounting basis is incomplete");
  }
  if (basis.mode === "bounded-wall-time-exclusive-unknown-quota"
    && (basis.quotaCapacityState !== "unknown" || Number(basis.maxAttempts) !== 1 || Number(allocation.maxAttempts) !== 1)) {
    throw new Error("resource-accounting-unavailable: unknown-quota work must be a single bounded attempt");
  }
  const reservations = Array.isArray(basis.quotaReservations) ? basis.quotaReservations : [];
  if (!reservations.length || reservations.some((row) => (
    row?.provider !== provider
    || !row?.poolId
    || !row?.poolKey
    || row?.exclusive !== true
    || row?.measurement?.state !== "known"
    || !Number.isFinite(Number(row?.measurement?.value))
    || Number(row.measurement.value) <= 0
  ))) {
    throw new Error("resource-accounting-unavailable: Antigravity quota reservation is not authoritative");
  }
  const allocationPoolKeys = new Set((Array.isArray(allocation.quotaReservations) ? allocation.quotaReservations : [])
    .map((row) => String(row?.poolKey || "").trim()).filter(Boolean));
  if (reservations.some((row) => !allocationPoolKeys.has(row.poolKey))) {
    throw new Error("director-allocation-contract-mismatch: accounting quota reservation mismatch");
  }
  return basis;
}

function directorAllocationLimits(contract = {}) {
  if (!contract.directorProgram) return null;
  const binding = assertDirectorAllocationBinding(contract);
  const allocation = binding.allocation;
  if (!allocation || typeof allocation !== "object") throw new Error("director-allocation-missing");
  const allocationId = String(allocation.allocationId || "").trim();
  if (!allocationId) throw new Error("director-allocation-id-missing");
  const candidateId = String(allocation.candidateId || "").trim();
  if (!candidateId) throw new Error("director-allocation-candidate-missing");
  const allocationProvider = String(allocation.provider || "").trim().toLowerCase();
  const contractProvider = String(contract.provider || "").trim().toLowerCase();
  if (!allocationProvider || !contractProvider || allocationProvider !== contractProvider) {
    throw new Error("director-allocation-provider-mismatch");
  }
  const allocationModel = normalizeModelId(allocation.model);
  const contractModel = normalizeModelId(contract.model);
  if (!allocationModel || !contractModel || allocationModel !== contractModel) {
    throw new Error("director-allocation-model-mismatch");
  }
  const expectedWorkPackageId = String(contract.directorProgram.workPackageId || "").trim();
  if (!expectedWorkPackageId || String(allocation.workPackageId || "").trim() !== expectedWorkPackageId) {
    throw new Error("director-allocation-work-package-mismatch");
  }
  const boundAllocationId = String(contract.directorWorkerContract?.executionEnvelope?.revisions?.allocationId || "").trim();
  if (boundAllocationId && boundAllocationId !== allocationId) {
    throw new Error("director-allocation-contract-mismatch");
  }
  const tokenLimit = Math.floor(finiteUsageNumber(allocation.tokenLimit) || 0);
  const durationLimitMs = Math.floor(finiteUsageNumber(allocation.durationLimitMs) || 0);
  const maxAttempts = Math.floor(finiteUsageNumber(allocation.maxAttempts) || 0);
  if (tokenLimit <= 0 || durationLimitMs <= 0 || maxAttempts <= 0) {
    throw new Error("director-allocation-limits-invalid");
  }
  const apiMeasurement = allocation.cost?.apiUsd;
  let apiUsdLimit = null;
  const accountingBasis = directorAccountingBasis(contract, allocation, durationLimitMs);
  if (apiMeasurement && typeof apiMeasurement === "object"
    && apiMeasurement.state === "known" && apiMeasurement.unit === "usd") {
    apiUsdLimit = finiteUsageNumber(apiMeasurement.value);
  } else if (typeof apiMeasurement === "number") {
    apiUsdLimit = finiteUsageNumber(apiMeasurement);
  }
  if (contract.providerAuthMode === "api-key" && apiUsdLimit === null) {
    throw new Error("resource-accounting-unavailable: allocation apiUsd budget is unknown");
  }
  if (contract.providerAuthMode === "api-key" && apiUsdLimit <= 0) {
    throw new Error("director-allocation-api-budget-exhausted");
  }
  const attempt = Math.max(1, Math.floor(finiteUsageNumber(contract.allocationAttempt) || 1));
  if (attempt > maxAttempts) throw new Error("allocation-attempt-limit-exceeded:" + attempt + ">" + maxAttempts);
  return { allocationId, candidateId, provider: allocationProvider, model: allocationModel, tokenLimit, durationLimitMs, maxAttempts, attempt, apiUsdLimit, accountingBasis };
}

function enforceDirectorAllocation(contract = {}) {
  const limits = directorAllocationLimits(contract);
  if (!limits) return contract;
  const requestedTimeoutMs = Math.max(1000, Math.floor((finiteUsageNumber(contract.timeoutSeconds) || (limits.durationLimitMs / 1000)) * 1000));
  const requestedTokens = Math.max(1, Math.floor(finiteUsageNumber(contract.estimatedDirectTokens) || limits.tokenLimit));
  const requestedOutput = Math.max(1, Math.floor(finiteUsageNumber(contract.maxWorkerOutputTokens) || Math.min(4000, limits.tokenLimit)));
  const executor = executorKind(contract.executorKind || contract.kind);
  const strongDirectorRole = executor === "strategist"
    || executor === "reconciliation"
    || (executor === "context-scout" && (contract.minimumCapabilityTier === "frontier" || contract.complexity === "large"));
  return {
    ...contract,
    timeoutSeconds: Math.max(1, Math.floor(Math.min(requestedTimeoutMs, limits.durationLimitMs) / 1000)),
    estimatedDirectTokens: Math.min(requestedTokens, limits.tokenLimit),
    maxWorkerOutputTokens: Math.min(requestedOutput, limits.tokenLimit),
    effort: strongDirectorRole && contract.effortProvided !== true ? "high" : contract.effort,
    maxApiBudgetUsd: limits.apiUsdLimit === null ? contract.maxApiBudgetUsd : limits.apiUsdLimit,
    allocationLimits: limits,
  };
}

function normalizeWorkerUsage(contract, responseUsage = {}, elapsedMs = 0) {
  const usage = { provider: contract.provider, ...responseUsage, capturedAt: utcNow(), outputBudgetTokens: contract.maxWorkerOutputTokens };
  const inputTokens = finiteUsageNumber(usage.inputTokens ?? usage.input_tokens);
  const cacheCreationInputTokens = finiteUsageNumber(usage.cacheCreationInputTokens ?? usage.cache_creation_input_tokens);
  const cacheReadInputTokens = finiteUsageNumber(usage.cacheReadInputTokens ?? usage.cachedInputTokens ?? usage.cache_read_input_tokens ?? usage.cached_input_tokens);
  const outputTokens = finiteUsageNumber(usage.outputTokens ?? usage.output_tokens);
  const reportedTotalTokens = finiteUsageNumber(usage.totalTokens ?? usage.total_tokens);
  const componentTotal = contract.provider === "claude"
    ? [inputTokens, cacheCreationInputTokens, cacheReadInputTokens, outputTokens].every((value) => value !== null)
      ? inputTokens + cacheCreationInputTokens + cacheReadInputTokens + outputTokens
      : null
    : inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null;
  const totalTokens = reportedTotalTokens ?? componentTotal;
  const reportedDurationMs = finiteUsageNumber(usage.durationMs ?? usage.duration_ms);
  const durationMs = Math.max(reportedDurationMs || 0, Math.max(0, Math.floor(elapsedMs)));
  const equivalentUsd = finiteUsageNumber(usage.equivalentUsd ?? usage.total_cost_usd);
  const limits = directorAllocationLimits(contract);
  const totalBudgetTokens = limits?.tokenLimit
    || Math.max(2000, Math.min(200000, Math.floor(finiteUsageNumber(contract.estimatedDirectTokens) || 12000)));
  const durationBudgetMs = limits?.durationLimitMs || Math.max(1000, Number(contract.timeoutSeconds || 900) * 1000);
  const violations = [];
  if (totalTokens !== null && totalTokens > totalBudgetTokens) violations.push("tokens " + totalTokens + ">" + totalBudgetTokens);
  const apiBudgetUsd = limits?.apiUsdLimit ?? finiteUsageNumber(contract.maxApiBudgetUsd);
  const accountingBasis = limits?.accountingBasis || null;
  const quotaBasedAccounting = ["wall-time-and-exclusive-quota-reservation", "bounded-wall-time-exclusive-unknown-quota"].includes(accountingBasis?.mode);
  const tokenTelemetryUnavailable = usage.resourceAccountingComplete === false || totalTokens === null;
  const accountingUnavailableReasons = [];
  if (limits) {
    if (tokenTelemetryUnavailable && !quotaBasedAccounting) {
      accountingUnavailableReasons.push("token telemetry missing or partial");
    }
    if (contract.provider === "claude"
      && ![inputTokens, cacheCreationInputTokens, cacheReadInputTokens, outputTokens].every((value) => value !== null)) {
      accountingUnavailableReasons.push("Claude input/cache/output telemetry incomplete");
    }
    if (contract.providerAuthMode === "api-key" && equivalentUsd === null) {
      accountingUnavailableReasons.push("API spend telemetry unavailable");
    }
  }
  if (durationMs > durationBudgetMs) violations.push("durationMs " + durationMs + ">" + durationBudgetMs);
  if (contract.providerAuthMode === "api-key" && equivalentUsd !== null && equivalentUsd > Number(apiBudgetUsd || 0)) {
    violations.push("equivalentUsd " + equivalentUsd + ">" + Number(apiBudgetUsd || 0));
  }
  const resourceAccountingUnavailable = accountingUnavailableReasons.length > 0;
  const resourceLimitBreached = violations.length > 0;
  return {
    ...usage,
    inputTokens,
    cacheCreationInputTokens,
    cacheReadInputTokens,
    cachedInputTokens: cacheReadInputTokens,
    outputTokens,
    totalTokens,
    durationMs,
    effectiveInputTokens: inputTokens === null ? null : contract.provider === "claude"
      ? inputTokens + (cacheCreationInputTokens || 0) + (cacheReadInputTokens || 0)
      : inputTokens,
    effectiveTotalTokens: totalTokens,
    totalBudgetTokens,
    providerResourceAccountingComplete: usage.resourceAccountingComplete !== false,
    resourceAccountingComplete: !resourceAccountingUnavailable,
    accountingBasis,
    accountingMode: accountingBasis?.mode || "provider-token-telemetry",
    tokenTelemetryState: totalTokens === null ? "unavailable" : "observed",
    quotaRefreshRequiredBeforeReuse: accountingBasis?.postRunQuotaRefreshRequired === true,
    quotaPoolKeys: (accountingBasis?.quotaReservations || []).map((row) => row.poolKey),
    durationBudgetMs,
    apiBudgetUsd,
    allocationId: limits?.allocationId || "",
    allocationAttempt: limits?.attempt || 1,
    allocationMaxAttempts: limits?.maxAttempts || null,
    resourceAccountingUnavailable,
    accountingUnavailableReasons,
    resourceLimitBreached,
    budgetExceeded: resourceAccountingUnavailable || resourceLimitBreached,
    budgetViolationReasons: violations,
  };
}

function successfulSideEffectReceipt(contract, response, artifact) {
  const executor = executorKind(contract.executorKind || contract.kind);
  const mutatingSideEffect = executor === "external-transaction"
    || (executor === "browser-action" && contract.mutatesExternalState === true)
    || (executor === "operational-transaction"
      && (contract.mutatesExternalState === true || (Array.isArray(contract.commands) && contract.commands.length > 0)));
  if (!mutatingSideEffect || response?.ok !== true || response?.typedBlocker || !artifact || typeof artifact !== "object") {
    return null;
  }
  if (!["applied", "verified"].includes(String(artifact.state || "").trim().toLowerCase())) return null;
  const validation = validateTypedDeliverable(contract, { artifact, deliverable: artifact });
  return validation.ok ? { receipt: validation.deliverable || artifact, validation } : null;
}

function resourceFailureOutcome(contract, response, artifact, usage = {}) {
  const accountingReasons = Array.isArray(usage.accountingUnavailableReasons)
    ? usage.accountingUnavailableReasons.filter(Boolean)
    : [];
  const violationReasons = Array.isArray(usage.budgetViolationReasons)
    ? usage.budgetViolationReasons.filter(Boolean)
    : [];
  const blockerParts = [];
  if (usage.resourceAccountingUnavailable === true) {
    blockerParts.push("resource-accounting-unavailable: " + (accountingReasons.join("; ") || "provider usage telemetry is missing or partial"));
  }
  if (usage.resourceLimitBreached === true) {
    blockerParts.push("allocation-budget-exceeded: " + (violationReasons.join("; ") || "allocated resource limit was exceeded"));
  }
  if (!blockerParts.length) {
    return {
      blocker: "",
      resourceBreach: null,
      authoritativeSideEffectReceipt: null,
      receiptValidation: null,
      retryForbidden: false,
      requiresAuthoritativeObservation: false,
    };
  }
  const successfulSideEffect = successfulSideEffectReceipt(contract, response, artifact);
  const authoritativeSideEffectReceipt = successfulSideEffect?.receipt || null;
  const requiresAuthoritativeObservation = Boolean(authoritativeSideEffectReceipt);
  const readOnlyValidation = contract.readOnly === true
    && response?.ok === true
    && !response?.typedBlocker
    && artifact && typeof artifact === "object"
    && usage.resourceLimitBreached === true
    && usage.resourceAccountingUnavailable !== true
    ? validateTypedDeliverable(contract, { artifact, deliverable: artifact, patchAvailable: false, verification: null }) : null;
  const preservedReadOnlyResult = readOnlyValidation?.ok === true;
  return {
    blocker: requiresAuthoritativeObservation
      ? "ambiguous external write: resource breach recorded after a verified side effect; preserve this receipt and observe authoritative state before any retry; " + blockerParts.join("; ")
      : preservedReadOnlyResult
        ? ""
        : blockerParts.join("; "),
    resourceBreach: {
      accountingUnavailable: usage.resourceAccountingUnavailable === true,
      accountingReasons,
      limitBreached: usage.resourceLimitBreached === true,
      violationReasons,
    },
    authoritativeSideEffectReceipt,
    receiptValidation: successfulSideEffect?.validation || readOnlyValidation || null,
    retryForbidden: requiresAuthoritativeObservation || preservedReadOnlyResult,
    requiresAuthoritativeObservation,
    preservedReadOnlyResult,
  };
}

function directorModelIdentityBlocker(contract, usage = {}) {
  if (!contract.directorProgram) return "";
  const expected = normalizeModelId(contract.allocation?.model);
  const actual = normalizeModelId(usage.actualModelId || usage.model);
  if (usage.principalModelObserved !== true || !actual || actual === "unknown") {
    return "director-allocation-model-unobserved: provider did not report an authoritative actual model";
  }
  if (!expected || actual !== expected) {
    return "director-allocation-model-mismatch: allocated " + (expected || "missing") + " but provider executed " + actual;
  }
  return "";
}

function executeWorker(payload) {
  const taskId = String(payload.taskId || "");
  const jobId = String(payload.jobId || "");
  const dir = jobDirectory(taskId, jobId);
  const contract = readJson(path.join(dir, "contract.json"), null);
  if (!contract) throw new Error("Missing job contract.");
  const executionWorkspace = safeWorkspace(contract.executionWorkspace || contract.workspace);
  const immutableSnapshot = contract.isolation?.mode === "read-only-snapshot";
  const localOperation = executorKind(contract.executorKind || contract.kind) === "operational-transaction";
  const observedBoundaries = immutableSnapshot
    ? ["."]
    : contract.readOnly || localOperation
      ? contract.relevantFiles
      : contract.expectedFiles;
  const fingerprintOptions = immutableSnapshot ? { strong: true } : {};
  const beforeStatus = immutableSnapshot ? { available: false, paths: [] } : statusPaths(executionWorkspace);
  const before = fingerprint(executionWorkspace, observedBoundaries, 5000, fingerprintOptions);
  try {
    setStatus(taskId, jobId, { state: "running", pid: process.pid, startedAt: readJson(path.join(dir, "status.json"), {}).startedAt || utcNow() });
    if (immutableSnapshot) assertCompleteSnapshotFingerprint(before);
    const providerState = { [contract.provider]: { available: true, authenticated: true, command: contract.providerCommand } };
    const runtimeContract = enforceDirectorAllocation({ ...contract, workspace: executionWorkspace });
    if (runtimeContract.directorProgram) assertDirectorWorkerContract(runtimeContract.directorWorkerContract);
    const authorizationBlocker = runtimeAuthorizationBlocker(runtimeContract);
    const providerStartedAt = Date.now();
    const response = authorizationBlocker
      ? { ok: false, typedBlocker: "authorization-required", text: authorizationBlocker, usage: {}, exitCode: null }
      : runProvider(providerState, runtimeContract, promptFor(runtimeContract));
    const providerElapsedMs = Date.now() - providerStartedAt;
    const requiredDeliverableKind = deliverableKind(contract);
    const requiredExecutorKind = executorKind(contract.executorKind || contract.kind);
    const codexPatchWriter = contract.provider === "codex" && requiredDeliverableKind === "patch" && contract.readOnly !== true && contract.skipModelReview !== true;
    const providerPatch = response.ok && codexPatchWriter
      ? applyProviderPatch(executionWorkspace, dir, response.text, contract.expectedFiles)
      : null;
    if (providerPatch && !providerPatch.applied) response.typedBlocker = response.typedBlocker || providerPatch.blocker;
    if (providerPatch) writeJson(path.join(dir, "provider-patch-evidence.json"), providerPatch);
    let artifact = structuredArtifact(contract, response);
    if (!response.ok || response.typedBlocker) clearInventoryCache();
    const resultLimit = Math.max(1600, Math.min(12000, Number(contract.maxWorkerOutputTokens || 1000) * 4));
    fs.writeFileSync(path.join(dir, "provider-output.txt"), redact(bounded(response.text, resultLimit)), "utf8");

    const transientCleanup = cleanTransientOutputs(contract.isolation || {});
    writeJson(path.join(dir, "transient-cleanup.json"), transientCleanup);
    const afterStatus = immutableSnapshot ? { available: false, paths: [] } : statusPaths(executionWorkspace);
    const after = fingerprint(executionWorkspace, observedBoundaries, 5000, fingerprintOptions);
    if (immutableSnapshot) assertCompleteSnapshotFingerprint(after);
    const statusChanges = afterStatus.paths.filter((file) => !beforeStatus.paths.includes(file));
    const changed = [...new Set([...changedFingerprints(before, after), ...statusChanges])];
    const salvagedArtifact = response.ok && !response.typedBlocker
      ? salvageTypedReadOnlyArtifact(contract, executionWorkspace, changed)
      : null;
    if (salvagedArtifact) artifact = salvagedArtifact.artifact;
    artifact = canonicalDirectorArtifact(runtimeContract, artifact);
    const effectiveChanged = salvagedArtifact ? [] : changed;
    const outside = effectiveChanged.filter((file) => !boundaryAllows(file, observedBoundaries));
    const mutationViolation = contract.readOnly && effectiveChanged.length > 0;
    const patch = contract.readOnly ? "" : collectDiff(executionWorkspace, changed);
    writeJson(path.join(dir, "changed-files.json"), changed);
    fs.writeFileSync(path.join(dir, "worker.diff"), patch, "utf8");

    const usage = normalizeWorkerUsage(runtimeContract, response.usage, providerElapsedMs);
    writeJson(path.join(dir, "usage.json"), usage);
    if (usage.quotaRefreshRequiredBeforeReuse) {
      clearInventoryCache();
    }
    const resourceFailure = resourceFailureOutcome(runtimeContract, response, artifact, usage);

    let blocker = response.typedBlocker ? `${response.typedBlocker}: ${bounded(response.text, 500)}` : "";
    if (!blocker && response.ok && contract.artifactKind === "work-plan" && !artifact) blocker = "structured-work-plan-missing";
    if (!blocker && response.ok && contract.artifactKind === "work-plan" && artifact && !artifact.proposedWorkUnits.length && !artifact.blocker) blocker = "structured-work-plan-has-no-bounded-units-or-blocker";
    const expectedTrustedModel = contract.isolation?.trustedModel || "";
    const directorModelBlocker = directorModelIdentityBlocker(runtimeContract, usage);
    const actualModel = normalizeModelId(usage.model);
    if (expectedTrustedModel && actualModel !== normalizeModelId(expectedTrustedModel)) {
      blocker = `model-identity-mismatch: trusted primary writing required ${expectedTrustedModel}, but the provider receipt reported ${usage.model || "unknown"}.`;
    }
    if (outside.length) blocker = `Writer boundary violation: ${outside.join(", ")}`;
    if (mutationViolation) blocker = `Read-only worker modified files: ${changed.join(", ")}`;
    if (!blocker && response.ok && requiredDeliverableKind === "patch" && !contract.readOnly && changed.length === 0) {
      blocker = "no-patch-produced: the editing worker changed no files; deterministic verification was skipped.";
    }
    if (directorModelBlocker) {
      blocker = blocker ? blocker + "; " + directorModelBlocker : directorModelBlocker;
    }
    if (resourceFailure.blocker) {
      blocker = blocker ? blocker + "; " + resourceFailure.blocker : resourceFailure.blocker;
    }
    let verification = null;
    if (!blocker && response.ok) {
      verification = runVerification(executionWorkspace, dir, contract.verificationCommands);
      if (verification.required && !verification.passed) blocker = verification.blocker;
    }

    let deliverableValidation = resourceFailure.receiptValidation;
    if (!blocker && response.ok) {
      deliverableValidation = validateTypedDeliverable(contract, {
        artifact,
        deliverable: artifact,
        patchAvailable: Boolean(patch),
        verification,
      });
      if (!deliverableValidation.ok) blocker = `typed-deliverable-invalid: ${deliverableValidation.blocker}`;
    }

    let rollback = null;
    if (contract.skipModelReview === true && (!response.ok || blocker)) {
      rollback = rollbackPrimaryWorkspace(contract.isolation || {}, changed);
      if (!rollback.rolledBack) blocker = `${blocker || "trusted-primary-worker-failed"}; rollback-incomplete: ${JSON.stringify(rollback.failures || rollback.reason)}`;
    }
    const state = !response.ok || blocker ? "failed" : "completed";
    const summary = bounded(response.text, resultLimit);
    fs.writeFileSync(path.join(dir, "result.md"), `${summary}\n`, "utf8");
    writeJson(path.join(dir, "handoff.json"), {
      schemaVersion: 1,
      state,
      summary,
      artifact,
      artifactFingerprint: artifact ? artifactFingerprint(artifact) : "",
      executorKind: requiredExecutorKind,
      deliverableKind: requiredDeliverableKind,
      deliverable: resourceFailure.authoritativeSideEffectReceipt || deliverableValidation?.deliverable || artifact,
      deliverableValidation,
      changedFiles: effectiveChanged,
      transientArtifactFile: salvagedArtifact?.relativeFile || "",
      patchAvailable: Boolean(patch),
      patchPath: path.join(dir, "worker.diff"),
      verification,
      usage,
      blocker,
      authoritativeSideEffectReceipt: resourceFailure.authoritativeSideEffectReceipt,
      resourceBreach: resourceFailure.resourceBreach,
      retryForbidden: resourceFailure.retryForbidden,
      requiresAuthoritativeObservation: resourceFailure.requiresAuthoritativeObservation,
      preservedReadOnlyResult: resourceFailure.preservedReadOnlyResult === true || Boolean(salvagedArtifact),
      integrationAction: contract.integrationAction || "",
      skipModelReview: contract.skipModelReview === true,
      alreadyInPrimaryWorkspace: contract.skipModelReview === true,
      rollback,
      projectCompleteAllowed: false,
    });
    setStatus(taskId, jobId, {
      state,
      finishedAt: utcNow(),
      blocker,
      warning: usage.resourceAccountingUnavailable
        ? "resource-accounting-unavailable"
        : usage.resourceLimitBreached ? "worker-budget-exceeded" : "",
      exitCode: response.exitCode ?? null,
      verificationState: verification?.state || "not-requested",
    });
    event(dir, "worker.finished", { state, changedCount: changed.length });
    return state === "completed" ? 0 : 1;
  } catch (error) {
    clearInventoryCache();
    const blocker = `worker-runtime-failed: ${bounded(error.message, 600)}`;
    writeJson(path.join(dir, "handoff.json"), { schemaVersion: 1, state: "failed", summary: "", changedFiles: [], patchAvailable: false, verification: null, blocker, projectCompleteAllowed: false });
    setStatus(taskId, jobId, { state: "failed", finishedAt: utcNow(), blocker });
    event(dir, "worker.failed", { blocker });
    return 1;
  } finally {
    try { writeJson(path.join(dir, "lease-release.json"), releaseResourceLease(jobId)); }
    catch (error) { writeJson(path.join(dir, "lease-release.json"), { released: false, warning: bounded(error.message, 300) }); }
  }
}

module.exports = { assertCompleteSnapshotFingerprint, canonicalDirectorArtifact, communicationContract, directorAllocationLimits, directorContractForPrompt, directorModelIdentityBlocker, enforceDirectorAllocation, executeWorker, normalizeWorkerUsage, parseStructuredValue, promptFor, resourceFailureOutcome, runtimeAuthorizationBlocker, salvageTypedReadOnlyArtifact, structuredArtifact, successfulSideEffectReceipt };
