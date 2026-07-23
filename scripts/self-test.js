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
    const { buildCodexExecArgs } = require("./lib/codex-cli");
    const { buildAntigravityArgs, buildClaudeArgs, classifyFailure } = require("./providers");

    const resources = { generatedAt: new Date().toISOString(), cached: false, providers: {
      codex: { available: true, authenticated: true, authMode: "chatgpt", observedAt: new Date().toISOString(), models: [{ id: "gpt-fixture", description: "balanced capable model", supportedReasoningEfforts: ["low", "medium", "high"] }], capacity: { effectiveRemainingPercent: 80, source: "fixture" }, quotaPools: [] },
      claude: { available: true, authenticated: true, authMode: "subscription", observedAt: new Date().toISOString(), models: [{ id: "sonnet" }], capacity: { remainingPercent: 75, source: "fixture" }, quotaPools: [] },
      antigravity: { available: true, authenticated: true, authMode: "cli-session", observedAt: new Date().toISOString(), models: [{ id: "gemini-flash", displayName: "Gemini Flash" }], capacity: { remainingPercent: 90, source: "fixture" }, quotaPools: [] },
      cursor: { available: false, authenticated: false, reason: "not installed", models: [], quotaPools: [] },
    } };

    assert.equal(TOOLS.length, 18);
    assert.deepEqual(TOOLS.map((tool) => tool.name), ["start-program", "run-program-campaign", "program-report", "start-task", "reconcile-task", "dispatch-round", "run-task-cycle", "collect-round", "integrate-round", "record-evidence", "task-summary", "material-status", "complete-task", "cancel-task", "resource-inventory", "provider-diagnostics", "orchestrator-profile", "prepare-restart-handoff"]);
    assert.equal(handle({ jsonrpc: "2.0", id: 1, method: "tools/list" }, __filename).result.tools.length, 18);
    const runProgramCampaignTool = TOOLS.find((tool) => tool.name === "run-program-campaign");
    const restartHandoffTool = TOOLS.find((tool) => tool.name === "prepare-restart-handoff");
    assert.equal(runProgramCampaignTool.inputSchema.properties.horizonHours.maximum, 168);
    assert.equal(restartHandoffTool.inputSchema.properties.horizonHours.maximum, 168);

    const task = startTask({ workspace, outcome: "Ship verified fixture", currentModel: "gpt-5.6-sol", acceptanceEvidence: ["Fixture passes end to end"] }, resources);
    assert.match(task.taskId, /^task-/);
    assert.equal(task.requirements[0].id, "A1");
    assert.equal(task.currentCodex.reservePercent, 15);
    assert.equal(task.currentCodex.model, "gpt-5.6-sol");
    assert.equal(task.currentCodex.role, "project-console");
    assert.deepEqual(task.currentCodex.files, []);
    assert.equal(task.execution.mustDispatchNow, true);
    assert.equal(task.execution.mustStartNow, false);
    assert.equal(task.workPlane.plan.requirementId, "A1");
    assert.deepEqual(task.workGraph.map((row) => row.id), ["R-A1"]);
    assert.equal(task.outcomeReconciliation.source, "supplied-outcome");
    assert.equal(taskSummary({ taskId: task.taskId }).progress.required, 1);
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
    assert.equal(profile.schemaVersion, 9);
    assert.equal(profile.role, "AI resource orchestrator");
    assert.equal(profile.codexReservePercent, 15);
    assert.equal(profile.maxExternalWorkers, 2);
    assert.equal(profile.maxGlobalWorkers, 2);
    assert.equal(profile.maxWorkersPerProvider, 1);
    assert.equal(profile.worktreeDiskQuotaMb, 2048);
    assert.equal(profile.subscriptionOnlyClaude, true);
    assert.equal(profile.antigravityReadOnlyConsent, false);
    assert.deepEqual(profile.trustedPrimaryWriteModels, []);
    assert.equal(profile.allowCodexRestartHandoff, false);

    const codexWriterArgs = buildCodexExecArgs({ workspace, model: "gpt-fixture", effort: "medium", readOnly: false });
    assert.deepEqual(codexWriterArgs.slice(0, 3), ["-a", "never", "exec"]);
    assert.equal(codexWriterArgs.includes("--skip-git-repo-check"), true);
    assert.equal(codexWriterArgs[codexWriterArgs.indexOf("--sandbox") + 1], "workspace-write");
    assert.equal(codexWriterArgs.includes("plugins"), true);

    const antigravityArgs = buildAntigravityArgs({ workspace, readOnly: true, timeoutSeconds: 60 }, "inspect");
    assert.equal(antigravityArgs.includes("--dangerously-skip-permissions"), false);
    assert.equal(antigravityArgs.includes("--sandbox"), true);
    const claudeArgs = buildClaudeArgs({ readOnly: true, maxWorkerOutputTokens: 800 }, "inspect");
    assert.equal(claudeArgs.includes("--no-chrome"), true);
    assert.doesNotThrow(() => JSON.parse(claudeArgs[claudeArgs.indexOf("--json-schema") + 1]));
    assert.equal(classifyFailure("Transport closed", 1), "transport-unavailable");
    assert.equal(classifyFailure("rate limit", 1), "capacity-unavailable");

    const contract = { projectGoal: "ship", goal: "Review UI", currentCodexGoal: "Implement API", independenceReason: "Separate ownership", executionWorkspace: workspace, readOnly: true, relevantFiles: ["src/ui"], expectedFiles: [], acceptanceCriteria: ["Find issue"], maxWorkerOutputTokens: 800, communicationMode: "smart-compact" };
    assert.match(promptFor(contract), /bounded worker/);
    const workPlanPrompt = promptFor({ ...contract, artifactKind: "work-plan" });
    assert.match(workPlanPrompt, /Return exactly one JSON object and nothing else/);
    assert.match(workPlanPrompt, /"verificationCommands":\[\{"name":"string","command":"executable","args":\["argument"\],"timeoutSeconds":30\}\]/);
    assert.match(workPlanPrompt, /Verification commands must be structured objects, never shell strings/);
    assert.match(workPlanPrompt, /no Markdown, code fences, commentary, or file URLs/);
    assert.match(communicationContract(), /communicate compactly/);
    const verification = runVerification(workspace, root, [{ name: "node-version", command: "node", args: ["--version"] }]);
    assert.equal(verification.passed, true, JSON.stringify(verification));

    const serverSource = fs.readFileSync(path.join(__dirname, "mcp", "server.js"), "utf8");
    const skillSource = fs.readFileSync(path.join(__dirname, "..", "skills", "ai-mobile", "SKILL.md"), "utf8");
    const projectAcceptance = JSON.parse(fs.readFileSync(path.join(__dirname, "..", ".codex", "ACCEPTANCE.json"), "utf8"));
    assert.equal(Array.isArray(projectAcceptance.requirements), true);
    for (const forbidden of ["run-project-manager", "project-manager-status", "continuous-cycle"]) {
      assert.equal(serverSource.includes(forbidden), false);
      assert.equal(skillSource.includes(forbidden), false);
    }
    return { ok: true, assertions: 57, durationMs: Date.now() - started, tools: TOOLS.length };
  } finally {
    if (savedDataRoot === undefined) delete process.env.AI_MOBILE_DATA_ROOT; else process.env.AI_MOBILE_DATA_ROOT = savedDataRoot;
    if (savedLocalAppData === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = savedLocalAppData;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

module.exports = { run };

if (require.main === module) run().then((value) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)).catch((error) => { process.stderr.write(`${error.stack || error.message}\n`); process.exitCode = 1; });
