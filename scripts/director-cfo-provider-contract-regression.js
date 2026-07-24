#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  assessMasterPlan,
  createStrategyWorkPackage,
  masterPlanJsonSchema,
} = require("./core/plan-assurance");
const {
  assertDirectorWorkerContract,
} = require("./core/director-worker-contract");
const { programJobContract } = require("./core/director-cfo-orchestrator");
const { promptFor } = require("./core/worker");
const {
  buildAntigravityArgs,
  buildClaudeArgs,
  claudeInvocation,
  claudeResultSchema,
  codexReadOnlyMode,
  prepareAntigravityInvocation,
} = require("./providers");

const sentinel = "DIRECTOR_CONTEXT_AFTER_ROUTER_LIMIT_7f4cf95e";
const mission = {
  id: "mission-provider-contract",
  revision: 4,
  outcome: "Carry the complete, immutable Director contract into every provider worker.",
};
const contextDossier = {
  schemaVersion: "director-cfo/context-dossier@1",
  contextRevision: 9,
  contextFingerprint: "context-fingerprint-provider-contract",
  mission: {
    id: mission.id,
    revision: mission.revision,
    outcome: mission.outcome,
  },
  realGoal: mission.outcome,
  executiveSummary: "bounded-context-segment ".repeat(650) + sentinel,
  currentState: [],
  sourceObservations: [],
  facts: [],
  assumptions: [],
  unknowns: [],
  constraints: [],
  decisions: [],
  failures: [],
  risks: [],
  acceptanceState: [],
};

const requirements = [{
  id: "REQ-PROVIDER-CONTRACT",
  description: "The immutable Director contract reaches the selected worker without truncation.",
  required: true,
  status: "failing",
  minimumEvidenceLevel: "integration",
}];
const strategyContract = createStrategyWorkPackage({ mission, contextDossier, requirements });
assert.ok(strategyContract.prompt.length > 8000, "Strategy prompt must exercise the former router limit.");
assert.ok(strategyContract.prompt.indexOf(sentinel) > 8000, "Sentinel must live beyond the old 8k boundary.");
assert.ok(JSON.stringify(strategyContract.artifactContract.jsonSchema).length > 8000, "Canonical Master Plan schema must also exercise long contracts.");
assert.equal(Object.prototype.hasOwnProperty.call(strategyContract, "minimumPlanRevision"), false, "Ordinary strategy contracts must not gain revision-only state.");
assert.equal(Object.prototype.hasOwnProperty.call(strategyContract, "reconciliationDirective"), false, "Ordinary strategy contracts must not gain reconciliation-only state.");
assert.equal(strategyContract.artifactContract.jsonSchema.properties.planRevision.minimum, 1);
const evidenceFloorClauses = strategyContract.artifactContract.jsonSchema.properties.evidenceRequirements.allOf;
assert.equal(evidenceFloorClauses.length, 1);
assert.deepEqual(evidenceFloorClauses[0].contains.properties.level.enum, ["integration", "end-to-end", "user-visible"]);
assert.equal(evidenceFloorClauses[0].contains.properties.acceptanceRequirementIds.contains.const, "REQ-PROVIDER-CONTRACT");
assert.match(strategyContract.prompt, /REQ-PROVIDER-CONTRACT=integration/);
const workstreamSchema = strategyContract.artifactContract.jsonSchema.properties.workstreams.items;
assert.equal(workstreamSchema.allOf[0].then.properties.execution.properties.expectedFiles.minItems, 1);
assert.equal(workstreamSchema.allOf[0].then.properties.execution.properties.verificationCommands.minItems, 1);
assert.equal(workstreamSchema.allOf[0].else.properties.execution.properties.expectedFiles.maxItems, 0);
assert.equal(strategyContract.artifactContract.jsonSchema.properties.milestones.items.properties.id.minLength, 2);
assert.equal(strategyContract.artifactContract.jsonSchema.properties.milestones.items.properties.id.pattern, "^[A-Za-z][A-Za-z0-9._:-]{1,99}$");
assert.match(strategyContract.prompt, /Every ID and every ID reference must be 2-100 characters/);
assert.match(strategyContract.prompt, /Every non-code-change typed workstream.*must use expectedFiles: \[\]/);
assert.match(strategyContract.prompt, /never emit a code-change execution contract with empty expectedFiles or verificationCommands/);
const fileBoundStrategyContract = createStrategyWorkPackage({
  mission,
  contextDossier,
  requirements,
  availableSourceFiles: ["Jobs Harness/db.py", "Jobs Harness/runner.py"],
});
assert.deepEqual(
  fileBoundStrategyContract.artifactContract.jsonSchema.properties.workstreams.items.properties.execution.properties.relevantFiles.items.enum,
  ["Jobs Harness/db.py", "Jobs Harness/runner.py"],
  "Provider JSON Schema must constrain relevantFiles to the real project manifest.",
);
assert.equal(
  fileBoundStrategyContract.artifactContract.jsonSchema.properties.workstreams.items.properties.execution.properties.relevantFiles.items.enum.includes("Jobs Harness/test_gate_resolver.py"),
  false,
  "The provider schema must reject synthesized plausible paths before spending reconciliation work.",
);
assert.match(fileBoundStrategyContract.prompt, /Copy relevantFiles values verbatim/);
const endToEndEvidenceSchema = masterPlanJsonSchema({
  authoritativeRequirements: [{ id: "REQ-E2E", required: true, status: "failing", minimumEvidenceLevel: "end-to-end", requiredExecutorKinds: ["operational-transaction"] }],
});
assert.deepEqual(endToEndEvidenceSchema.properties.evidenceRequirements.allOf[0].contains.properties.level.enum, ["end-to-end", "user-visible"], "An end-to-end acceptance floor must be encoded into the worker schema, not left to prose.");
assert.equal(endToEndEvidenceSchema.properties.workstreams.allOf[0].contains.properties.execution.properties.executorKind.const, "operational-transaction", "A required operational route must be encoded into the worker schema.");

const reconciliationDirective = {
  rootCause: "The superseded strategy did not encode the failed postcondition.",
  evidence: ["RECONCILIATION_DIRECTIVE_SENTINEL_97d8fca2"],
  requiredMaterialChanges: ["Revise the affected workstream contract and its recovery path."],
  priorPlanRevision: 4,
};
const revisedStrategyContract = createStrategyWorkPackage({
  mission,
  contextDossier,
  requirements,
  reconciliationDirective,
  minimumPlanRevision: 5,
});
reconciliationDirective.rootCause = "caller mutation must not alter the persisted contract";
assert.equal(revisedStrategyContract.minimumPlanRevision, 5);
assert.equal(revisedStrategyContract.artifactContract.jsonSchema.properties.planRevision.minimum, 5);
assert.equal(revisedStrategyContract.reconciliationDirective.rootCause, "The superseded strategy did not encode the failed postcondition.");
assert.ok(revisedStrategyContract.prompt.includes("RECONCILIATION_DIRECTIVE_SENTINEL_97d8fca2"));
assert.ok(revisedStrategyContract.prompt.includes("Return planRevision at least 5"));
assert.ok(revisedStrategyContract.prompt.includes("do not repeat the superseded plan unchanged"));

const belowRevision = assessMasterPlan({ planRevision: 4 }, { minimumPlanRevision: 5 });
assert.equal(belowRevision.valid, false);
assert.ok(belowRevision.errors.includes("planRevision must be an integer at least 5."));
const minimumRevision = assessMasterPlan({ planRevision: 5 }, { minimumPlanRevision: 5 });
assert.equal(minimumRevision.errors.some((error) => error.startsWith("planRevision must")), false, "The assurance gate must accept the required revision boundary.");
assert.throws(
  () => createStrategyWorkPackage({ mission, contextDossier, requirements, minimumPlanRevision: 0 }),
  /minimumPlanRevision must be a positive integer/,
);

const strategyPackage = {
  workPackageId: "wp-strategy-provider-contract",
  executorKind: "strategist",
  deliverableKind: "master-plan",
  bootstrapContract: strategyContract,
  artifactContract: strategyContract.artifactContract,
  requiredCapabilities: ["source", "local-files"],
  requiredPermissions: ["read-files"],
  permissionGrant: ["read-files"],
  permissionPreflight: { ok: true, checkedAt: "fixture" },
  commands: [],
  verificationCommands: [],
  preconditions: ["Context dossier fingerprint matches the mission revision."],
  postconditions: ["Master Plan passes the canonical plan-assurance contract."],
  rollback: null,
  recoveryAction: "Reconcile against the authoritative dossier and regenerate a changed plan.",
  mutatesExternalState: false,
  sideEffectKey: "",
  observedStateFingerprint: contextDossier.contextFingerprint,
  userAuthorizationRef: "",
  revisionFence: {
    missionRevision: mission.revision,
    contextRevision: contextDossier.contextRevision,
    contextFingerprint: contextDossier.contextFingerprint,
    planRevision: 0,
    budgetRevision: 0,
  },
  budgetRevision: 0,
};
const strategyJobContract = programJobContract({
  program: {
    mode: "director-cfo",
    workPackages: [{ ...strategyPackage, state: "ready" }],
  },
}, {
  directorProgram: { workPackageId: strategyPackage.workPackageId },
});
const strategyWorkerContract = strategyJobContract.directorWorkerContract;
assert.equal(assertDirectorWorkerContract(strategyWorkerContract), strategyWorkerContract);

const routerSummary = strategyContract.prompt.slice(0, 8000);
assert.equal(routerSummary.includes(sentinel), false, "The simulated router summary must be incomplete.");
const workerContract = {
  taskId: "task-provider-contract",
  executionWorkspace: "C:\\fixture\\workspace",
  provider: "claude",
  model: "fixture-model",
  timeoutSeconds: 60,
  maxWorkerOutputTokens: 6000,
  projectGoal: mission.outcome,
  currentCodexGoal: "Report Director progress.",
  goal: routerSummary,
  independenceReason: "The strategist owns one bounded durable plan artifact.",
  relevantFiles: [],
  expectedFiles: [],
  acceptanceCriteria: ["Return a plan accepted by the canonical contract."],
  requiredCapabilities: ["source", "local-files"],
  executorKind: "strategist",
  deliverableKind: "master-plan",
  artifactKind: "master-plan",
  readOnly: true,
  ...strategyJobContract,
};
const completePrompt = promptFor(workerContract);
assert.ok(completePrompt.includes(sentinel), "Worker prompt lost context beyond the router summary.");
assert.ok(completePrompt.includes(strategyWorkerContract.contractFingerprint), "Worker prompt omitted the immutable contract fingerprint.");
assert.ok(completePrompt.includes('"jsonSchema"'), "Worker prompt omitted the strict artifact schema.");
assert.ok(completePrompt.includes("NON-NEGOTIABLE TRANSACTION RULE"));
assert.ok(completePrompt.includes("Empty arrays are invalid"));
assert.ok(completePrompt.includes("at most two unresolved acceptance requirements"));

const providerSchema = JSON.parse(claudeResultSchema(workerContract));
assert.deepEqual(providerSchema, strategyContract.artifactContract.jsonSchema, "Claude and plan assurance must share the exact Master Plan schema.");
assert.deepEqual(providerSchema, masterPlanJsonSchema({
  missionId: mission.id,
  missionRevision: mission.revision,
  contextRevision: contextDossier.contextRevision,
  contextFingerprint: contextDossier.contextFingerprint,
  authoritativeRequirements: requirements,
}));
assert.equal(providerSchema.additionalProperties, false);
assert.equal(providerSchema.properties.workstreams.items.additionalProperties, false);
assert.equal(providerSchema.properties.workstreams.items.properties.execution.additionalProperties, false);
for (const key of [
  "commands",
  "verificationCommands",
  "preconditions",
  "postconditions",
  "sideEffectKey",
  "observedStateFingerprint",
  "userAuthorizationRef",
]) {
  assert.ok(providerSchema.properties.workstreams.items.properties.execution.required.includes(key), "Execution schema omitted " + key + ".");
}

const invocation = claudeInvocation(workerContract, completePrompt);
assert.equal(invocation.input, completePrompt, "Claude stdin must receive the complete prompt byte-for-byte.");
assert.equal(invocation.args.includes(completePrompt), false, "Claude prompt must not be a Windows argv item.");
assert.equal(invocation.args.some((value) => String(value).includes(sentinel)), false, "Long project context leaked into Claude argv.");
const antigravitySecretSentinel = "PRIVATE_LONG_PROMPT_SENTINEL_38b361e7";
const antigravityPrompt = completePrompt + "\n" + antigravitySecretSentinel + "\n" + "多言語".repeat(20000);
const antigravityInvocation = prepareAntigravityInvocation({
  ...workerContract,
  provider: "antigravity",
  workspace: process.cwd(),
}, antigravityPrompt);
try {
  assert.equal(antigravityInvocation.transport, "isolated-prompt-file");
  assert.equal(fs.readFileSync(antigravityInvocation.promptFile, "utf8"), antigravityPrompt, "Antigravity prompt-file transport must preserve the complete Unicode prompt byte-for-byte.");
  assert.equal(antigravityInvocation.args.some((value) => String(value).includes(antigravitySecretSentinel)), false, "Long project context leaked into Antigravity argv.");
  assert.ok(antigravityInvocation.args.join(" ").length < 8000, "Antigravity argv must remain below the conservative Windows command-line boundary.");

  const antigravityAddDirs = antigravityInvocation.args.reduce((rows, value, index) => value === "--add-dir" ? [...rows, antigravityInvocation.args[index + 1]] : rows, []);
  assert.deepEqual(antigravityAddDirs, [path.dirname(antigravityInvocation.promptFile), process.cwd()], "The instruction directory must precede the real project workspace so it cannot become the active execution root.");
} finally {
  const promptFile = antigravityInvocation.promptFile;
  antigravityInvocation.cleanup();
  assert.equal(fs.existsSync(promptFile), false, "Antigravity prompt-file transport must clean up after the synchronous provider call.");
}

const readOnlyCommandContract = {
  readOnly: true,
  executorKind: "context-scout",
  deliverableKind: "context-dossier",
  permissionPreflight: { ok: true },
  permissionGrant: ["run-command"],
  timeoutSeconds: 60,
};
assert.equal(codexReadOnlyMode(readOnlyCommandContract), true, "A read-only context scout must not receive a mutable Codex sandbox merely to run observation commands.");
const readOnlyClaudeArgs = buildClaudeArgs(readOnlyCommandContract);
assert.equal(readOnlyClaudeArgs[readOnlyClaudeArgs.indexOf("--permission-mode") + 1], "plan");
assert.equal(readOnlyClaudeArgs[readOnlyClaudeArgs.indexOf("--tools") + 1].includes("Bash"), false, "An unbound preflight must never elevate to command tools.");

const databaseReceiptContract = {
  readOnly: true,
  executorKind: "context-scout",
  deliverableKind: "context-dossier",
  artifactKind: "context-dossier",
  permissionPreflight: { ok: true },
  permissionGrant: ["read-project", "read-files"],
  contextObservationPreflight: { ok: true, mode: "immutable-sqlite-receipt", databaseSourceIds: ["project-db"] },
  timeoutSeconds: 60,
  maxWorkerOutputTokens: 3000,
};
const databaseReceiptClaudeArgs = buildClaudeArgs(databaseReceiptContract);
assert.equal(databaseReceiptClaudeArgs[databaseReceiptClaudeArgs.indexOf("--tools") + 1], "Read,Glob,Grep", "A receipt-backed database scout must not need Bash or a database permission it cannot call.");
const databaseReceiptSchema = JSON.parse(claudeResultSchema(databaseReceiptContract));
const observationSchema = databaseReceiptSchema.properties.sourceObservations.items;
assert.ok(observationSchema.required.includes("queryReceiptFingerprint"));
assert.ok(observationSchema.required.includes("queryReceiptSnapshotHash"));
const readOnlyAntigravityArgs = buildAntigravityArgs(readOnlyCommandContract, "observe");
assert.equal(readOnlyAntigravityArgs[readOnlyAntigravityArgs.indexOf("--mode") + 1], "plan");
assert.equal(readOnlyAntigravityArgs.includes("--dangerously-skip-permissions"), false);

const operationPackage = {
  workPackageId: "wp-operation-provider-contract",
  executorKind: "operational-transaction",
  deliverableKind: "operation-receipt",
  artifactContract: {
    kind: "operation-receipt",
    schemaVersion: "director-cfo/operation-receipt@1",
  },
  prompt: "Apply the approved service configuration and return its authoritative receipt.",
  commands: [{
    command: "service-control-fixture",
    args: ["apply", "--target", "service-alpha"],
    timeoutSeconds: 90,
    cwd: "C:\\fixture\\workspace",
  }],
  verificationCommands: [{
    command: "service-control-fixture",
    args: ["status", "--target", "service-alpha"],
    timeoutSeconds: 30,
    cwd: "C:\\fixture\\workspace",
  }],
  preconditions: ["Observed service state fingerprint equals service-before-63."],
  postconditions: ["Authoritative service status reports healthy."],
  rollback: {
    description: "Restore the prior service configuration.",
    commands: [{
      command: "service-control-fixture",
      args: ["rollback", "--target", "service-alpha"],
      timeoutSeconds: 90,
    }],
  },
  recoveryAction: "Run rollback, observe state again, and reconcile before retrying.",
  mutatesExternalState: true,
  sideEffectKey: "service-alpha:configuration:v4",
  observedStateFingerprint: "service-before-63",
  userAuthorizationRef: "authorization://fixture/service-alpha/v4",
  requiredCapabilities: ["local-files", "service-control"],
  requiredPermissions: ["run-command", "service-control"],
  permissionGrant: ["run-command", "service-control"],
  permissionPreflight: {
    ok: true,
    checkedAt: "fixture",
    evidence: ["Exact target and grants verified."],
  },
  revisionFence: {
    missionRevision: 4,
    contextRevision: 9,
    contextFingerprint: contextDossier.contextFingerprint,
    planRevision: 3,
    budgetRevision: 2,
  },
  budgetRevision: 2,
  allocation: { allocationId: "allocation-operation-1" },
};
const operationJobContract = programJobContract({
  program: {
    mode: "director-cfo",
    workPackages: [{ ...operationPackage, state: "ready" }],
  },
}, {
  directorProgram: { workPackageId: operationPackage.workPackageId },
});
const operationWorkerContract = operationJobContract.directorWorkerContract;
const operationPrompt = promptFor({
  ...workerContract,
  goal: "Apply one bounded operation.",
  readOnly: false,
  ...operationJobContract,
});
for (const exactValue of [
  "service-control-fixture",
  "service-alpha:configuration:v4",
  "service-before-63",
  "authorization://fixture/service-alpha/v4",
  "allocation-operation-1",
]) {
  assert.ok(operationPrompt.includes(exactValue), "Worker prompt omitted " + exactValue + ".");
}
assert.ok(operationPrompt.includes('"permissionGrant":["run-command","service-control"]'));
assert.ok(operationPrompt.includes('"permissionPreflight":{"ok":true'));

const reconciliationSentinel = "RECONCILIATION_CONTEXT_AFTER_ROUTER_LIMIT_56e169d2";
const reconciliationPackage = {
  workPackageId: "wp-reconciliation-provider-contract",
  executorKind: "reconciliation",
  deliverableKind: "reconciliation-decision",
  artifactContract: {
    kind: "reconciliation-decision",
    schemaVersion: "director-cfo/reconciliation-decision@1",
    requiredContextRefresh: true,
  },
  prompt: "Diagnose the failed acceptance outcome from evidence. " + "failed-plan-and-assurance-context ".repeat(400) + reconciliationSentinel,
  failedWorkPackageId: operationPackage.workPackageId,
  failurePacket: {
    schemaVersion: "director-cfo/failure-packet@1",
    failureFingerprint: "failure-fingerprint-9981",
    classification: "verification-failure",
    failedContract: {
      sideEffectKey: operationPackage.sideEffectKey,
      observedStateFingerprint: operationPackage.observedStateFingerprint,
    },
    assuranceErrors: [
      "Postcondition did not establish authoritative service health.",
      "Acceptance evidence remained below integration level.",
    ],
    evidence: ["receipt://fixture/failed-operation"],
  },
  policy: {
    schemaVersion: "director-cfo/recovery-policy@1",
    unchangedRetryForbidden: true,
    contextRefreshAfterRepeatedFailure: true,
    minimumReasoningTier: "frontier",
  },
  commands: [],
  verificationCommands: [],
  preconditions: ["Failure packet fingerprint is current."],
  postconditions: ["Decision changes at least one failed invariant or stops."],
  rollback: null,
  recoveryAction: "Refresh authoritative context and revise the failed contract.",
  mutatesExternalState: false,
  sideEffectKey: "",
  observedStateFingerprint: "failure-fingerprint-9981",
  userAuthorizationRef: "",
  requiredCapabilities: ["source", "local-files"],
  requiredPermissions: ["read-files"],
  permissionGrant: ["read-files"],
  permissionPreflight: { ok: true, checkedAt: "fixture" },
  revisionFence: operationPackage.revisionFence,
  budgetRevision: 2,
};
const reconciliationJobContract = programJobContract({
  program: {
    mode: "director-cfo",
    workPackages: [{ ...reconciliationPackage, state: "ready" }],
  },
}, {
  directorProgram: { workPackageId: reconciliationPackage.workPackageId },
});
assert.ok(reconciliationJobContract.directorWorkerContract.instructions.includes(reconciliationSentinel));
assert.equal(reconciliationJobContract.directorWorkerContract.reconciliation.failurePacket.failureFingerprint, "failure-fingerprint-9981");
assert.equal(reconciliationJobContract.directorWorkerContract.reconciliation.policy.unchangedRetryForbidden, true);
const reconciliationProviderContract = {
  ...workerContract,
  goal: reconciliationPackage.prompt.slice(0, 8000),
  readOnly: true,
  ...reconciliationJobContract,
};
const reconciliationPrompt = promptFor(reconciliationProviderContract);
assert.ok(reconciliationPrompt.includes(reconciliationSentinel), "Reconciliation prompt lost failure context beyond the router summary.");
assert.ok(reconciliationPrompt.includes("failure-fingerprint-9981"));
assert.ok(reconciliationPrompt.includes("unchanged retry is forbidden"));
assert.ok(reconciliationPrompt.includes("planRevision must be null or a non-empty JSON object"));
const reconciliationSchema = JSON.parse(claudeResultSchema(reconciliationProviderContract));
assert.equal(reconciliationSchema.properties.contextRefresh.const, true, "A pre-context reconciliation schema must reject contextRefresh=false.");
assert.equal(
  reconciliationSchema.properties.failureFingerprint.const,
  reconciliationProviderContract.directorWorkerContract.reconciliation.failurePacket.failureFingerprint,
  "Reconciliation output must be const-bound to the dispatched failure packet.",
);
const fallbackReconciliationSchema = JSON.parse(claudeResultSchema({ artifactKind: "reconciliation-decision" }));
assert.equal(fallbackReconciliationSchema.properties.failureFingerprint.type, "string");
assert.equal(Object.prototype.hasOwnProperty.call(fallbackReconciliationSchema.properties.failureFingerprint, "const"), false, "A reconciliation schema without a failure packet must retain its generic string fingerprint contract.");

const tampered = JSON.parse(JSON.stringify(operationWorkerContract));
tampered.executionEnvelope.sideEffectKey = "tampered-side-effect";
assert.throws(() => assertDirectorWorkerContract(tampered), /fingerprint-mismatch/);
assert.throws(() => promptFor({
  ...workerContract,
  executorKind: operationPackage.executorKind,
  deliverableKind: operationPackage.deliverableKind,
  artifactKind: operationPackage.deliverableKind,
  directorWorkerContract: tampered,
}), /fingerprint-mismatch/);

process.stdout.write(JSON.stringify({
  ok: true,
  strategyPromptChars: strategyContract.prompt.length,
  masterPlanSchemaChars: JSON.stringify(strategyContract.artifactContract.jsonSchema).length,
  completeWorkerPromptChars: completePrompt.length,
  longContextSurvivedRouterSummary: true,
  immutableExecutionEnvelopePresent: true,
  fullReconciliationContractPresent: true,
  strictMasterPlanSchemaShared: true,
  claudePromptUsesStdin: true,
  antigravityLongPromptUsesIsolatedFile: true,
  databaseReceiptUsesFileToolsOnly: true,
  databaseReceiptFieldsRequired: true,
  tamperingRejected: true,
}, null, 2) + "\n");
