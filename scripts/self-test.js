"use strict";

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { TOOLS, handle } = require("./mcp/server");
const { conflictFor, readJob } = require("./core/job-store");
const { providerHistory } = require("./core/provider-history");
const { route } = require("./core/router");
const { runVerification } = require("./core/verification");
const { communicationContract } = require("./core/worker");
const { normalizeProfile } = require("./lib/orchestrator-profile");
const { buildAntigravityArgs, buildClaudeArgs, claudeResultSchema, classifyFailure } = require("./providers");
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
  fs.writeFileSync(path.join(dir, "contract.json"), `${JSON.stringify({ id, provider: "claude", model: "sonnet", goal: "Review dashboard accessibility.", currentCodexGoal: "Implement backend execution.", relevantFiles: ["src/dashboard"], expectedFiles: [] }, null, 2)}\n`);
  fs.writeFileSync(path.join(dir, "status.json"), `${JSON.stringify({ id, state, provider: "claude", pid: state === "running" ? process.pid : null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }, null, 2)}\n`);
  fs.writeFileSync(path.join(dir, "result.md"), "Dashboard review completed.\n");
  fs.writeFileSync(path.join(dir, "changed-files.json"), "[]\n");
  fs.writeFileSync(path.join(dir, "usage.json"), `${JSON.stringify({ provider: "claude", model: "claude-sonnet-5", outputTokens: 700, equivalentUsd: 0.04, billingNote: "Equivalent only." }, null, 2)}\n`);
  return dir;
}

function run() {
  const started = Date.now();
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-mobile-test-"));
  try {
    assert.deepEqual(TOOLS.map((tool) => tool.name), ["orchestrator-profile", "resource-inventory", "run-efficient-task", "read-job", "verify-job", "cancel-job"]);
    const dispatchSchema = TOOLS.find((tool) => tool.name === "run-efficient-task").inputSchema;
    assert.deepEqual(dispatchSchema.required, ["workspace", "goal", "currentCodexGoal", "independenceReason"]);
    assert.equal(TOOLS.find((tool) => tool.name === "read-job").inputSchema.properties.waitSeconds.maximum, 60);

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

    const capacitySensitive = inventory();
    capacitySensitive.providers.codex.capacity.effectiveRemainingPercent = 100;
    capacitySensitive.providers.claude.capacity = { remainingPercent: 3, source: "test" };
    const capacityRoute = route(base(temp, { taskKind: "architecture" }), capacitySensitive);
    assert.equal(capacityRoute.provider, "codex");

    const cheapScan = route(base(temp, { taskKind: "repository-scan", allowAntigravity: true, preferredProvider: "auto" }), inventory());
    assert.equal(cheapScan.provider, "antigravity");
    assert.equal(cheapScan.request.model, "gemini-3.5-flash-medium");

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
    fs.rmSync(temp, { recursive: true, force: true });
  }
  return { ok: true, assertions: 60, durationMs: Date.now() - started, tools: TOOLS.length };
}

module.exports = { run };
