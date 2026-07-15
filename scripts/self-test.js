"use strict";

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { TOOLS, handle } = require("./mcp/server");
const { conflictFor, readJob } = require("./core/job-store");
const { providerHistory } = require("./core/provider-history");
const { applyProfileAuthorization, normalizeRequest, route } = require("./core/router");
const { compactCapacity, orchestrateTask } = require("./core/task-orchestrator");
const { runVerification } = require("./core/verification");
const { communicationContract, promptFor } = require("./core/worker");
const { normalizeProfile } = require("./lib/orchestrator-profile");
const { assertCurrentRuntime, comparePluginVersions, runtimeVersionInfo } = require("./lib/version");
const { antigravityRemaining, buildAntigravityArgs, buildClaudeArgs, claudeResultSchema, classifyFailure, numericOrNull } = require("./providers");
const { parseClaudeAuth, parseClaudeModels, parseClaudeUsage } = require("./providers/claude-usage");

function base(workspace, patch = {}) {
  return {
    workspace,
    projectGoal: "Ship a verified project outcome.",
    currentCodexGoal: "Implement the backend execution path.",
    independenceReason: "The worker reads only dashboard files while Codex owns backend execution files.",
    currentCodexFiles: ["src/backend"],
    goal: "Review dashboard accessibility and return exact findings.",
    relevantFiles: ["src/dashboard"],
    readOnly: true,
    complexity: "large",
    taskKind: "review",
    estimatedDirectTokens: 12000,
    ...patch,
  };
}

function inventory() {
  return { providers: {
    codex: { available: true, authenticated: true, authMode: "chatgpt", models: [{ id: "gpt-5.6-sol" }], capacity: { effectiveRemainingPercent: 80 } },
    claude: { available: true, authenticated: true, authMode: "subscription", models: [] },
    antigravity: { available: true, authenticated: true, authMode: "cli-session", models: [{ id: "gemini-3.5-flash-medium", displayName: "Gemini 3.5 Flash (Medium)" }] },
    cursor: { available: false, authenticated: false },
  } };
}

function writeFixtureJob(workspace, id, state = "completed") {
  const dir = path.join(workspace, ".ai-mobile", "jobs", id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "contract.json"), `${JSON.stringify({ id, taskId: "task-fixture", provider: "claude", model: "sonnet", projectGoal: "Ship a verified project outcome.", completionEvidence: ["End-to-end acceptance passes."], goal: "Review dashboard accessibility.", currentCodexGoal: "Implement backend execution.", relevantFiles: ["src/dashboard"], expectedFiles: [], expectedContribution: "Resolve the accessibility decision with exact evidence.", integrationAction: "Apply only confirmed accessibility fixes to the current implementation." }, null, 2)}\n`);
  fs.writeFileSync(path.join(dir, "status.json"), `${JSON.stringify({ id, state, provider: "claude", pid: state === "running" ? process.pid : null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }, null, 2)}\n`);
  fs.writeFileSync(path.join(dir, "result.md"), "Dashboard review completed.\n");
  fs.writeFileSync(path.join(dir, "changed-files.json"), "[]\n");
  fs.writeFileSync(path.join(dir, "usage.json"), `${JSON.stringify({ provider: "claude", model: "claude-sonnet-5", outputTokens: 700, equivalentUsd: 0.04, billingNote: "Equivalent only." }, null, 2)}\n`);
  return dir;
}

function run() {
  const started = Date.now();
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-mobile-test-"));
  // Route decisions read the private local profile; pin LOCALAPPDATA so assertions run against documented defaults.
  const savedLocalAppData = process.env.LOCALAPPDATA;
  process.env.LOCALAPPDATA = path.join(temp, "localappdata");
  try {
    assert.deepEqual(TOOLS.map((tool) => tool.name), ["orchestrate-task", "read-job", "verify-job", "cancel-job", "resource-inventory", "orchestrator-profile"]);
    const dispatchSchema = TOOLS.find((tool) => tool.name === "orchestrate-task").inputSchema;
    assert.deepEqual(dispatchSchema.required, ["workspace", "rootOutcome", "completionEvidence", "currentCodexGoal", "candidateLanes"]);
    assert.equal(dispatchSchema.properties.candidateLanes.minItems, 1);
    assert.equal(dispatchSchema.properties.candidateLanes.maxItems, 2);
    assert.equal(dispatchSchema.properties.blockingConditions.maxItems, 8);
    assert.deepEqual(dispatchSchema.properties.candidateLanes.items.properties.selectionAuthority.enum, ["router", "user"]);
    assert.equal(TOOLS.find((tool) => tool.name === "read-job").inputSchema.properties.waitSeconds.maximum, 60);
    assert.ok(dispatchSchema.properties.candidateLanes.items.properties.expectedContribution);
    assert.ok(dispatchSchema.properties.candidateLanes.items.properties.integrationAction);
    assert.match(promptFor({ ...base(temp, { complexity: "small" }), maxWorkerOutputTokens: 300, expectedFiles: [], acceptanceCriteria: [] }), /Small read-only inspection cap/i);

    assert.equal(compactCapacity({ providers: { antigravity: { available: true, capacity: { remainingPercent: null } } } }).antigravity.remainingPercent, null);
    assert.equal(numericOrNull(null), null);
    assert.equal(numericOrNull(""), null);
    assert.equal(antigravityRemaining([{ status: "available", remainingPercent: null }]), null);
    assert.equal(antigravityRemaining([{ status: "exhausted", remainingPercent: 0 }]), 0);
    const savedAuthorization = applyProfileAuthorization(normalizeRequest(base(temp)), { antigravityAutoApprovePermissions: true });
    assert.equal(savedAuthorization.allowAntigravity, true);
    assert.equal(savedAuthorization.antigravityAutoApprovePermissions, true);
    const explicitDenial = applyProfileAuthorization(normalizeRequest(base(temp, { allowAntigravity: false })), { antigravityAutoApprovePermissions: true });
    assert.equal(explicitDenial.allowAntigravity, false);

    assert.ok(comparePluginVersions("0.5.1+codex.20260713222133", "0.5.2+codex.20260714070000") < 0);
    assert.ok(comparePluginVersions("0.5.2+codex.20260714070000", "0.5.2+codex.20260714080000") < 0);
    const cacheRoot = path.join(temp, "cache", "personal", "ai-mobile");
    const staleRoot = path.join(cacheRoot, "0.5.1+codex.20260713222133");
    const currentRoot = path.join(cacheRoot, "0.5.2+codex.20260714080000");
    for (const root of [staleRoot, currentRoot]) {
      fs.mkdirSync(path.join(root, ".codex-plugin"), { recursive: true });
      fs.writeFileSync(path.join(root, ".codex-plugin", "plugin.json"), `${JSON.stringify({ version: path.basename(root) })}\n`);
    }
    assert.deepEqual(runtimeVersionInfo(staleRoot), {
      stale: true,
      currentVersion: "0.5.1+codex.20260713222133",
      newestVersion: "0.5.2+codex.20260714080000",
    });
    assert.throws(() => assertCurrentRuntime(staleRoot), /STALE AI MOBILE TASK.*fresh Codex task/i);
    assert.equal(runtimeVersionInfo(currentRoot).stale, false);

    const workerContracts = [];
    const finiteArgs = {
      workspace: temp,
      rootOutcome: "Achieve one verified safe transaction every seven minutes.",
      completionEvidence: ["A transaction has an authoritative confirmation id.", "Cadence is sustained without duplicates."],
      blockingConditions: ["A required user-only truth answer has no verified local source and no dependency-ready local repair remains."],
      currentCodexGoal: "Repair and verify the live runtime path.",
      currentCodexFiles: ["src/runtime"],
      currentCodexAcceptanceCriteria: ["The runtime health check passes."],
      candidateLanes: [{
        goal: "Identify the eligibility-queue blocker and return exact evidence.",
        independenceReason: "The worker owns eligibility analysis while current Codex owns runtime recovery.",
        relevantFiles: ["src/eligibility"],
        readOnly: true,
        preferredProvider: "claude",
        complexity: "large",
        taskKind: "debug",
        estimatedDirectTokens: 12000,
      }],
    };
    const finite = orchestrateTask(finiteArgs, inventory(), {}, (contract) => {
      workerContracts.push(contract);
      return { jobId: "job-regression-001", state: "running", provider: contract.provider, artifactDirectory: path.join(temp, ".ai-mobile", "jobs", "job-regression-001") };
    });
    assert.equal(finite.workersStarted, 1);
    assert.equal(workerContracts.length, 1);
    assert.equal(finite.currentCodex.goal, finiteArgs.currentCodexGoal);
    assert.equal(finite.currentCodex.runtime.supported, false);
    assert.equal(finite.completionFirewall.projectCompleteAllowed, false);
    assert.equal(finite.turnExitFirewall.finalAnswerAllowedNow, false);
    assert.deepEqual(finite.blockingConditions, finiteArgs.blockingConditions);
    assert.equal(finite.workers[0].provider, "claude");
    assert.equal(Object.hasOwn(finite.capacity.claude, "command"), false);
    assert.ok(fs.existsSync(path.join(temp, ".ai-mobile", "tasks", `${finite.taskId}.json`)));
    const binding = JSON.parse(fs.readFileSync(path.join(temp, ".ai-mobile", "current-work.json"), "utf8"));
    assert.equal(binding.taskId, finite.taskId);
    assert.equal(binding.currentCodex.ownershipConfidence, "declared");
    assert.match(binding.handoffInbox, /handoffs\.jsonl$/);
    const duplicateDispatch = orchestrateTask(finiteArgs, inventory(), {}, () => { throw new Error("duplicate lane must not dispatch"); });
    assert.equal(duplicateDispatch.workersStarted, 0);
    assert.match(duplicateDispatch.rejectedLanes[0].reason, /already dispatched/i);
    assert.equal(duplicateDispatch.rejectedLanes[0].existingJobId, "job-regression-001");
    assert.throws(() => orchestrateTask({
      ...finiteArgs,
      rootOutcome: "Conditional evidence must fail.",
      completionEvidence: ["Live preflight shows eligible work or one documented genuine external gate."],
    }, inventory(), {}, () => null), /positive observable proof/i);
    assert.throws(() => orchestrateTask({
      ...finiteArgs,
      rootOutcome: "Eligibility escape must fail.",
      completionEvidence: ["A verified submission is recorded when an eligible canary exists."],
    }, inventory(), {}, () => null), /positive observable proof/i);

    assert.equal(route(base(temp, { complexity: "small" }), inventory()).action, "direct");
    const duplicate = route(base(temp, {
      currentCodexGoal: "Identify the exact cadence blocker and implement the smallest safe fix.",
      goal: "Trace the exact cadence blocker and propose the smallest safe fix with evidence.",
      currentCodexFiles: [], relevantFiles: [], taskKind: "debug",
    }), inventory());
    assert.equal(duplicate.action, "direct");
    assert.match(duplicate.reason, /goals overlap/i);

    const fileOverlap = route(base(temp, { currentCodexFiles: ["src"], relevantFiles: ["src/dashboard"] }), inventory());
    assert.equal(fileOverlap.action, "direct");
    assert.match(fileOverlap.reason, /file ownership overlaps/i);

    const architecture = route(base(temp, { taskKind: "architecture", preferredProvider: "auto" }), inventory());
    assert.equal(architecture.provider, "claude");
    assert.equal(architecture.request.model, "sonnet");
    assert.ok(architecture.economics.positive);
    assert.ok(architecture.considered.find((item) => item.provider === "claude").scoreFactors);

    // A reserved active Codex lane can accept a bounded read-only review of
    // the same outcome; the review must still have a concrete file boundary.
    const reservedReview = route(base(temp, {
      currentCodexReserved: true,
      currentCodexGoal: "Improve the Job Vibhu runtime task with Sol Ultra.",
      goal: "Use Claude Sonnet to review Job Vibhu runtime efficiency while Sol Ultra continues.",
      currentCodexFiles: [],
      relevantFiles: ["src/dashboard"],
      preferredProvider: "claude",
      model: "sonnet",
      selectionAuthority: "user",
      readOnly: true,
      taskKind: "review",
      complexity: "large",
    }), inventory());
    assert.equal(reservedReview.action, "delegate");
    assert.equal(reservedReview.provider, "claude");
    assert.equal(reservedReview.request.model, "sonnet");
    assert.ok(reservedReview.warnings.some((item) => /read-only evidence lane/i.test(item)));

    // Catalog order is not a policy. A generic metadata-based selector picks a
    // balanced row for ordinary work and a frontier row for hard work.
    const codexOnly = inventory();
    codexOnly.providers.claude.available = false;
    codexOnly.providers.antigravity.available = false;
    codexOnly.providers.codex.models = [
      { id: "gpt-frontier-row", description: "Frontier agentic coding model for complex ambitious work.", supportedReasoningEfforts: ["low", "medium", "high"], defaultReasoningEffort: "low" },
      { id: "gpt-fast-row", description: "Fast and affordable model for bounded tasks.", supportedReasoningEfforts: ["low", "medium"], defaultReasoningEffort: "low" },
      { id: "gpt-balanced-row", description: "Balanced model for everyday work.", supportedReasoningEfforts: ["low", "medium", "high"], defaultReasoningEffort: "medium" },
    ];
    const balancedCodex = route(base(temp, { taskKind: "code", complexity: "medium", preferredProvider: "auto" }), codexOnly);
    assert.equal(balancedCodex.provider, "codex");
    assert.equal(balancedCodex.request.model, "gpt-balanced-row");
    assert.equal(balancedCodex.request.effort, "medium");
    const hardCodex = route(base(temp, { taskKind: "architecture", complexity: "large", preferredProvider: "auto" }), codexOnly);
    assert.equal(hardCodex.provider, "codex");
    assert.equal(hardCodex.request.model, "gpt-frontier-row");
    assert.equal(hardCodex.request.effort, "high");

    const capacitySensitive = inventory();
    capacitySensitive.providers.codex.capacity.effectiveRemainingPercent = 100;
    capacitySensitive.providers.claude.capacity = { remainingPercent: 3, source: "test" };
    const capacityRoute = route(base(temp, { taskKind: "architecture" }), capacitySensitive);
    assert.equal(capacityRoute.provider, "codex");

    const cheapScan = route(base(temp, { taskKind: "repository-scan", allowAntigravity: true, preferredProvider: "auto" }), inventory());
    assert.equal(cheapScan.provider, "antigravity");
    assert.equal(cheapScan.request.model, "Gemini 3.5 Flash (Medium)");

    const noAntigravity = route(base(temp, { taskKind: "repository-scan", allowAntigravity: false, preferredProvider: "antigravity" }), inventory());
    assert.equal(noAntigravity.action, "direct");
    assert.match(noAntigravity.reason, /not authorized/i);

    const paygInventory = inventory();
    paygInventory.providers.claude.authMode = "api-key";
    const payg = route(base(temp, { preferredProvider: "claude" }), paygInventory);
    assert.equal(payg.action, "direct");
    assert.match(payg.reason, /PAYG/i);

    const uneconomic = route(base(temp, { estimatedDirectTokens: 2000, maxWorkerOutputTokens: 1800 }), inventory());
    assert.equal(uneconomic.action, "direct");
    assert.match(uneconomic.reason, /not economically positive/i);

    assert.throws(() => route(base(temp, { goal: "write", readOnly: false, expectedFiles: [] }), inventory()), /expectedFiles/);
    assert.equal(route(base(temp, { currentCodexGoal: "" }), inventory()).action, "direct");
    assert.equal(route(base(temp, { independenceReason: "" }), inventory()).action, "direct");

    // dev (2) regression: an explicit user Fable mandate must never target the wrong provider.
    const fableInventory = () => {
      const value = inventory();
      value.providers.claude.models = [{ id: "fable" }, { id: "sonnet" }];
      return value;
    };
    const wrongProvider = route(base(temp, { preferredProvider: "antigravity", model: "fable", selectionAuthority: "user", allowAntigravity: true }), fableInventory());
    assert.equal(wrongProvider.action, "delegate");
    assert.equal(wrongProvider.provider, "claude");
    assert.equal(wrongProvider.request.model, "fable");
    assert.match(wrongProvider.warnings.join(" "), /claude model/i);

    // dev (2) regression: economics may warn but cannot reject a user-mandated lane.
    const mandatedUneconomic = route(base(temp, { preferredProvider: "claude", model: "fable", selectionAuthority: "user", complexity: "small", estimatedDirectTokens: 900 }), fableInventory());
    assert.equal(mandatedUneconomic.action, "delegate");
    assert.equal(mandatedUneconomic.provider, "claude");
    assert.equal(mandatedUneconomic.economics.positive, false);
    assert.ok(mandatedUneconomic.warnings.some((item) => /Economic warning/i.test(item)));

    // Router-preference premium selection keeps the token-saving default gate.
    const premiumPreference = route(base(temp, { preferredProvider: "claude", model: "fable" }), fableInventory());
    assert.equal(premiumPreference.action, "direct");
    assert.match(premiumPreference.reason, /not policy-enabled/i);

    // Hard gates still beat a user mandate: authentication, quota, billing, ownership overlap.
    const mandateNoAuth = fableInventory();
    mandateNoAuth.providers.claude.authenticated = false;
    const mandatedNoAuth = route(base(temp, { preferredProvider: "claude", model: "fable", selectionAuthority: "user" }), mandateNoAuth);
    assert.equal(mandatedNoAuth.action, "direct");
    assert.equal(mandatedNoAuth.hardBlocker, true);
    assert.match(mandatedNoAuth.reason, /not authenticated/i);
    const mandateExhausted = fableInventory();
    mandateExhausted.providers.claude.capacity = { remainingPercent: 1, source: "test" };
    const mandatedExhausted = route(base(temp, { preferredProvider: "claude", model: "fable", selectionAuthority: "user" }), mandateExhausted);
    assert.equal(mandatedExhausted.action, "direct");
    assert.match(mandatedExhausted.reason, /exhausted/i);
    const mandatePayg = fableInventory();
    mandatePayg.providers.claude.authMode = "api-key";
    const mandatedPayg = route(base(temp, { preferredProvider: "claude", model: "fable", selectionAuthority: "user" }), mandatePayg);
    assert.equal(mandatedPayg.action, "direct");
    assert.match(mandatedPayg.reason, /PAYG/i);
    const mandatedOverlap = route(base(temp, { preferredProvider: "claude", model: "fable", selectionAuthority: "user", currentCodexFiles: ["src"], relevantFiles: ["src/dashboard"] }), fableInventory());
    assert.equal(mandatedOverlap.action, "direct");
    assert.equal(mandatedOverlap.hardBlocker, true);
    assert.match(mandatedOverlap.reason, /file ownership overlaps/i);

    // Canonical binding: Fable never dispatches through Antigravity, even in auto mode.
    const fableNoClaude = fableInventory();
    fableNoClaude.providers.claude.available = false;
    fableNoClaude.providers.claude.reason = "Claude Code CLI not found.";
    const fableAuto = route(base(temp, { preferredProvider: "auto", model: "fable", allowAntigravity: true }), fableNoClaude);
    assert.equal(fableAuto.action, "direct");
    assert.match(fableAuto.reason, /never dispatches through antigravity/i);

    // A mandate without a bindable provider/model returns one exact actionable error.
    const boundByModel = route(base(temp, { selectionAuthority: "user", model: "fable" }), fableInventory());
    assert.equal(boundByModel.provider, "claude");
    assert.throws(() => route(base(temp, { selectionAuthority: "user" }), inventory()), /requires the explicit preferredProvider/i);
    assert.throws(() => route(base(temp, { selectionAuthority: "user", model: "mystery-agent-7" }), inventory()), /cannot bind model/i);
    assert.throws(() => route(base(temp, { selectionAuthority: "manager" }), inventory()), /Unsupported selectionAuthority/i);

    // dev (2) regression: one corrected routing attempt either dispatches or returns one hard blocker; identical retries become final.
    const mandateArgs = {
      workspace: temp,
      rootOutcome: "Ship the user-mandated Fable dashboard improvement end to end.",
      completionEvidence: ["The mandated Fable review is integrated and verified."],
      currentCodexGoal: "Repair and verify the runtime execution path.",
      currentCodexFiles: ["src/runtime"],
      candidateLanes: [{
        goal: "Deliver the user-requested Fable dashboard accessibility review with exact findings.",
        independenceReason: "The worker owns dashboard analysis while current Codex owns runtime repair.",
        relevantFiles: ["src/dashboard"],
        readOnly: true,
        preferredProvider: "antigravity",
        model: "fable",
        selectionAuthority: "user",
        complexity: "small",
        taskKind: "review",
      }],
    };
    const mandateNoAuthResources = fableInventory();
    mandateNoAuthResources.providers.claude.authenticated = false;
    const firstMandate = orchestrateTask(mandateArgs, mandateNoAuthResources, {}, () => { throw new Error("a blocked mandate must not dispatch"); });
    assert.equal(firstMandate.workersStarted, 0);
    assert.equal(firstMandate.rejectedLanes[0].hardBlocker, true);
    assert.match(firstMandate.rejectedLanes[0].reason, /not authenticated/i);
    assert.notEqual(firstMandate.rejectedLanes[0].finalForThisLane, true);
    assert.match(firstMandate.userMandateRule, /Do not call orchestrate-task again/i);
    const secondMandate = orchestrateTask(mandateArgs, mandateNoAuthResources, {}, () => { throw new Error("a repeated mandate must not dispatch"); });
    assert.equal(secondMandate.rejectedLanes[0].finalForThisLane, true);
    assert.match(secondMandate.rejectedLanes[0].reason, /Do not call orchestrate-task again/i);
    const healedMandate = orchestrateTask(mandateArgs, fableInventory(), {}, (contract) => ({ jobId: "job-mandate-001", state: "running", provider: contract.provider, artifactDirectory: path.join(temp, ".ai-mobile", "jobs", "job-mandate-001") }));
    assert.equal(healedMandate.workersStarted, 1);
    assert.equal(healedMandate.workers[0].provider, "claude");
    assert.equal(healedMandate.workers[0].model, "fable");
    assert.ok(healedMandate.workers[0].warnings.some((item) => /Economic warning/i.test(item)));
    const mandateRecord = JSON.parse(fs.readFileSync(path.join(temp, ".ai-mobile", "tasks", `${healedMandate.taskId}.json`), "utf8"));
    assert.equal(mandateRecord.rejectionHistory.length, 0);
    assert.equal(mandateRecord.schemaVersion, 2);

    const claudeArgs = buildClaudeArgs({ readOnly: true, model: "sonnet", effort: "low", providerAuthMode: "subscription", maxApiBudgetUsd: 0.35, maxWorkerOutputTokens: 1200 }, "prompt");
    assert.ok(claudeArgs.includes("--safe-mode"));
    assert.ok(claudeArgs.includes("Read,Glob,Grep"));
    assert.ok(claudeArgs.includes("--system-prompt"));
    assert.ok(!claudeArgs.includes("--max-budget-usd"));
    assert.ok(!claudeArgs.includes("--dangerously-skip-permissions"));
    const schema = JSON.parse(claudeResultSchema(1200));
    assert.equal(schema.properties.evidence.maxItems, 5);
    assert.ok(schema.properties.outcome.maxLength < 2000);
    const paygArgs = buildClaudeArgs({ readOnly: true, model: "sonnet", effort: "low", providerAuthMode: "api-key", maxApiBudgetUsd: 0.35 }, "prompt");
    assert.ok(paygArgs.includes("--max-budget-usd"));
    const writerArgs = buildClaudeArgs({ readOnly: false, model: "sonnet", effort: "medium", providerAuthMode: "subscription", maxWorkerOutputTokens: 1200 }, "prompt");
    assert.ok(writerArgs.includes("Read,Glob,Grep,Edit,Write"));
    assert.ok(!writerArgs.some((value) => /Bash|Agent|WebSearch/.test(value)));
    const claudeWindows = parseClaudeUsage("Current session: 7% used · resets Jul 14, 9:10am (Australia/Perth)\nCurrent week (all models): 38% used · resets Jul 19, 12pm (Australia/Perth)\nCurrent week (Fable): 45% used · resets Jul 19, 12pm (Australia/Perth)", new Date("2026-07-14T00:00:00Z"));
    assert.equal(claudeWindows.length, 3);
    assert.equal(claudeWindows.find((window) => window.scope === "fable").remainingPercent, 55);
    assert.equal(parseClaudeAuth('{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"pro","email":"redacted"}', {}).authMode, "subscription");
    assert.ok(parseClaudeModels("Use fable, opus, or sonnet. Full model claude-fable-5").some((model) => model.id === "fable"));

    const agySafe = buildAntigravityArgs({ workspace: temp, readOnly: true, timeoutSeconds: 300, antigravityAutoApprovePermissions: true, model: "gemini-3.5-flash-medium" }, "prompt");
    assert.ok(agySafe.includes("--sandbox"));
    assert.ok(agySafe.includes("plan"));
    assert.ok(agySafe.includes("--dangerously-skip-permissions"));
    const agyWriter = buildAntigravityArgs({ workspace: temp, readOnly: false, timeoutSeconds: 300, antigravityAutoApprovePermissions: false }, "prompt");
    assert.ok(!agyWriter.includes("--dangerously-skip-permissions"));
    assert.equal(classifyFailure("tool call failed: Transport closed", 1), "transport-unavailable");
    assert.equal(classifyFailure("spawnSync ETIMEDOUT", null), "provider-timeout");

    const completedId = "job-test-completed";
    writeFixtureJob(temp, completedId);
    const firstRead = readJob(temp, completedId, "compact");
    assert.equal(firstRead.collectionReady, true);
    assert.equal(firstRead.alreadyCollected, false);
    assert.equal(firstRead.integration.required, true);
    assert.equal(firstRead.integration.projectCompleteAllowed, false);
    assert.equal(firstRead.integration.expectedContribution, "Resolve the accessibility decision with exact evidence.");
    assert.match(firstRead.integration.action, /Apply only confirmed accessibility fixes/i);
    assert.equal(firstRead.rootOutcome, "Ship a verified project outcome.");
    assert.deepEqual(firstRead.completionEvidence, ["End-to-end acceptance passes."]);
    assert.equal(firstRead.usage.outputTokens, 700);
    const repeatedRead = readJob(temp, completedId, "compact");
    assert.equal(repeatedRead.alreadyCollected, true);
    assert.equal(repeatedRead.result, "");

    const outageId = "job-test-outage";
    const outageDir = writeFixtureJob(temp, outageId, "failed");
    const outageStatus = JSON.parse(fs.readFileSync(path.join(outageDir, "status.json"), "utf8"));
    fs.writeFileSync(path.join(outageDir, "status.json"), `${JSON.stringify({ ...outageStatus, blocker: "transport-unavailable: Transport closed", finishedAt: new Date(Date.now() + 1000).toISOString() }, null, 2)}\n`);
    const history = providerHistory(temp);
    assert.equal(history.claude.cooledDown, true);
    assert.equal(history.claude.cooldownReason, "transport-unavailable");

    const activeId = "job-test-running";
    writeFixtureJob(temp, activeId, "running");
    assert.match(conflictFor(temp, { laneKey: "different", goal: "Review dashboard accessibility.", relevantFiles: ["src/dashboard"], expectedFiles: [], maxExternalWorkers: 2 }), /overlaps|similar/i);

    const expiredId = "job-test-expired";
    const expiredDir = writeFixtureJob(temp, expiredId, "running");
    const expiredStatusPath = path.join(expiredDir, "status.json");
    const expiredStatus = JSON.parse(fs.readFileSync(expiredStatusPath, "utf8"));
    fs.writeFileSync(expiredStatusPath, `${JSON.stringify({ ...expiredStatus, leaseExpiresAt: new Date(Date.now() - 1000).toISOString() }, null, 2)}\n`);
    const expired = readJob(temp, expiredId, "compact");
    assert.equal(expired.state, "failed");
    assert.match(expired.blocker, /lease expired/i);
    assert.equal(expired.handoff.state, "failed");

    const waitId = "job-test-local-wait";
    const waitDir = writeFixtureJob(temp, waitId, "running");
    const waitStatus = path.join(waitDir, "status.json");
    const finisher = path.join(temp, "finish-job.js");
    fs.writeFileSync(finisher, 'const fs=require("node:fs");const file=process.argv[2];setTimeout(()=>{const value=JSON.parse(fs.readFileSync(file,"utf8"));fs.writeFileSync(file,JSON.stringify({...value,state:"completed",finishedAt:new Date().toISOString()}));},200);');
    const child = spawn(process.execPath, [finisher, waitStatus], { stdio: "ignore", windowsHide: true });
    child.unref();
    const waited = readJob(temp, waitId, "compact", 2);
    assert.equal(waited.state, "completed");
    assert.ok(waited.waitedSeconds >= 0.1);
    assert.equal(waited.collectionReady, true);

    const evidence = runVerification(temp, temp, [{ name: "node-version", command: "node", args: ["--version"] }]);
    assert.equal(evidence.passed, true);
    const source = fs.readFileSync(path.join(__dirname, "mcp", "server.js"), "utf8");
    for (const forbidden of ["run-project-manager", "project-manager-status", "heartbeat", "continuous-cycle"]) assert.equal(source.includes(forbidden), false);
    assert.equal(normalizeProfile({}).communicationMode, "smart-compact");
    assert.equal(normalizeProfile({}).subscriptionOnlyClaude, true);
    assert.equal(normalizeProfile({}).codexReservePercent, 15);
    assert.equal(normalizeProfile({}).useExpiringPremiumCapacity, false);
    assert.match(communicationContract("smart-compact"), /Think deeply; communicate compactly/);
    assert.match(communicationContract("smart-compact"), /Preserve exact facts/);
    assert.match(communicationContract("smart-compact"), /safety/);
    const response = handle({ jsonrpc: "2.0", id: 1, method: "tools/list" }, __filename);
    assert.equal(response.result.tools.length, 6);
  } finally {
    if (savedLocalAppData === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = savedLocalAppData;
    fs.rmSync(temp, { recursive: true, force: true });
  }
  return { ok: true, assertions: 139, durationMs: Date.now() - started, tools: TOOLS.length };
}

module.exports = { run };
