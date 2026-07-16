"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

async function run() {
  const started = Date.now();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-mobile-v1-self-"));
  const workspace = path.join(root, "workspace");
  const savedDataRoot = process.env.AI_MOBILE_DATA_ROOT;
  const savedLocalAppData = process.env.LOCALAPPDATA;
  process.env.AI_MOBILE_DATA_ROOT = path.join(root, "state");
  process.env.LOCALAPPDATA = path.join(root, "local");
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(path.join(workspace, "src", "ui"), { recursive: true });
  fs.mkdirSync(path.join(workspace, "src", "api"), { recursive: true });
  try {
    const { TOOLS, handle } = require("./mcp/server");
    const { requirementRows, startTask, recordEvidence, completeTask, taskSummary } = require("./core/task-orchestrator");
    const { economicEstimate } = require("./core/lane-policy");
    const { normalizeRequest, route } = require("./core/router");
    const { runVerification } = require("./core/verification");
    const { communicationContract, promptFor } = require("./core/worker");
    const { normalizeProfile } = require("./lib/orchestrator-profile");
    const { buildAntigravityArgs, buildClaudeArgs, classifyFailure } = require("./providers");

    const resources = { generatedAt: new Date().toISOString(), cached: false, providers: {
      codex: { available: true, authenticated: true, authMode: "chatgpt", observedAt: new Date().toISOString(), models: [{ id: "gpt-fixture", description: "balanced capable model", supportedReasoningEfforts: ["low", "medium", "high"] }], capacity: { effectiveRemainingPercent: 80, source: "fixture" }, quotaPools: [] },
      claude: { available: true, authenticated: true, authMode: "subscription", observedAt: new Date().toISOString(), models: [{ id: "sonnet" }], capacity: { remainingPercent: 75, source: "fixture" }, quotaPools: [] },
      antigravity: { available: true, authenticated: true, authMode: "cli-session", observedAt: new Date().toISOString(), models: [{ id: "gemini-flash", displayName: "Gemini Flash" }], capacity: { remainingPercent: 90, source: "fixture" }, quotaPools: [] },
      cursor: { available: false, authenticated: false, reason: "not installed", models: [], quotaPools: [] },
    } };

    assert.equal(TOOLS.length, 9);
    assert.deepEqual(TOOLS.map((tool) => tool.name), ["start-task", "dispatch-round", "collect-round", "record-evidence", "task-summary", "complete-task", "cancel-task", "resource-inventory", "orchestrator-profile"]);
    assert.equal(handle({ jsonrpc: "2.0", id: 1, method: "tools/list" }, __filename).result.tools.length, 9);

    const task = startTask({ workspace, outcome: "Ship verified fixture", acceptanceEvidence: ["Fixture passes end to end"] }, resources);
    assert.match(task.taskId, /^task-/);
    assert.equal(task.requirements[0].id, "A1");
    assert.equal(task.currentCodex.reservePercent, 15);
    assert.equal(fs.existsSync(path.join(workspace, ".ai-mobile")), false);
    assert.equal(taskSummary({ taskId: task.taskId }).completionAllowed, false);
    assert.equal(completeTask({ taskId: task.taskId }).completionAllowed, false);
    assert.throws(() => recordEvidence({ taskId: task.taskId, evidence: [{ requirementId: "A1", level: "activity", ref: "worker", summary: "worker ran", passed: true }] }), /requires end-to-end/);
    const evidenced = recordEvidence({ taskId: task.taskId, evidence: [{ requirementId: "A1", level: "end-to-end", ref: "fixture", summary: "fixture result verified", passed: true }] });
    assert.equal(evidenced.progress.passing, 1);
    assert.equal(completeTask({ taskId: task.taskId }).completionAllowed, true);

    assert.equal(requirementRows(["Positive proof"])[0].minimumEvidenceLevel, "end-to-end");
    assert.throws(() => requirementRows(["Done or blocked"]), /positive observable proof/);
    const normalized = normalizeRequest({ workspace, projectGoal: "ship", goal: "Review UI accessibility", currentCodexGoal: "Implement API validation", independenceReason: "Separate files", currentCodexFiles: ["src/api"], relevantFiles: ["src/ui"], readOnly: true, complexity: "large", taskKind: "review", estimatedDirectTokens: 12000 });
    assert.equal(normalized.readOnly, true);
    assert.ok(economicEstimate(normalized).positive);
    assert.equal(route(normalized, resources, {}).action, "delegate");
    assert.equal(route({ ...normalized, complexity: "small" }, resources, {}).action, "direct");
    assert.equal(route({ ...normalized, relevantFiles: ["src/api"] }, resources, {}).action, "direct");

    const profile = normalizeProfile({});
    assert.equal(profile.schemaVersion, 8);
    assert.equal(profile.role, "AI resource orchestrator");
    assert.equal(profile.codexReservePercent, 15);
    assert.equal(profile.maxExternalWorkers, 2);
    assert.equal(profile.maxGlobalWorkers, 2);
    assert.equal(profile.maxWorkersPerProvider, 1);
    assert.equal(profile.worktreeDiskQuotaMb, 2048);
    assert.equal(profile.subscriptionOnlyClaude, true);
    assert.equal(profile.antigravityReadOnlyConsent, false);

    const antigravityArgs = buildAntigravityArgs({ workspace, readOnly: true, timeoutSeconds: 60 }, "inspect");
    assert.equal(antigravityArgs.includes("--dangerously-skip-permissions"), false);
    assert.equal(antigravityArgs.includes("--sandbox"), true);
    const claudeArgs = buildClaudeArgs({ readOnly: true, maxWorkerOutputTokens: 800 }, "inspect");
    assert.equal(claudeArgs.includes("--no-chrome"), true);
    assert.equal(classifyFailure("Transport closed", 1), "transport-unavailable");
    assert.equal(classifyFailure("rate limit", 1), "capacity-unavailable");

    const contract = { projectGoal: "ship", goal: "Review UI", currentCodexGoal: "Implement API", independenceReason: "Separate ownership", executionWorkspace: workspace, readOnly: true, relevantFiles: ["src/ui"], expectedFiles: [], acceptanceCriteria: ["Find issue"], maxWorkerOutputTokens: 800, communicationMode: "smart-compact" };
    assert.match(promptFor(contract), /bounded worker/);
    assert.match(communicationContract(), /communicate compactly/);
    const verification = runVerification(workspace, root, [{ name: "node-version", command: "node", args: ["--version"] }]);
    assert.equal(verification.passed, true);

    const serverSource = fs.readFileSync(path.join(__dirname, "mcp", "server.js"), "utf8");
    const skillSource = fs.readFileSync(path.join(__dirname, "..", "skills", "ai-mobile", "SKILL.md"), "utf8");
    for (const forbidden of ["run-project-manager", "project-manager-status", "continuous-cycle"]) {
      assert.equal(serverSource.includes(forbidden), false);
      assert.equal(skillSource.includes(forbidden), false);
    }
    return { ok: true, assertions: 43, durationMs: Date.now() - started, tools: TOOLS.length };
  } finally {
    if (savedDataRoot === undefined) delete process.env.AI_MOBILE_DATA_ROOT; else process.env.AI_MOBILE_DATA_ROOT = savedDataRoot;
    if (savedLocalAppData === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = savedLocalAppData;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

module.exports = { run };

if (require.main === module) run().then((value) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)).catch((error) => { process.stderr.write(`${error.stack || error.message}\n`); process.exitCode = 1; });
