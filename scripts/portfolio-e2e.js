#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-mobile-v1-portfolio-"));
process.env.AI_MOBILE_DATA_ROOT = path.join(root, "state");
process.env.LOCALAPPDATA = path.join(root, "local");
const timeline = path.join(root, "timeline.jsonl");

function git(workspace, args) {
  const result = spawnSync("git", args, { cwd: workspace, encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

function project(name) {
  const workspace = path.join(root, name);
  fs.mkdirSync(path.join(workspace, "src"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "src", "codex.txt"), `${name}-codex\n`, "utf8");
  fs.writeFileSync(path.join(workspace, "src", "worker.txt"), `${name}-worker\n`, "utf8");
  git(workspace, ["init"]);
  git(workspace, ["config", "user.email", "ai-mobile@example.invalid"]);
  git(workspace, ["config", "user.name", "AI Mobile Test"]);
  git(workspace, ["add", "."]);
  git(workspace, ["commit", "-m", "fixture"]);
  return spawnSync("git", ["-C", workspace, "rev-parse", "--show-toplevel"], { encoding: "utf8", windowsHide: true }).stdout.trim();
}

const alpha = project("alpha");
const beta = project("beta");
const fake = path.join(root, "fake-provider.js");
fs.writeFileSync(fake, [
  '"use strict";',
  'const fs=require("node:fs"),path=require("node:path");',
  `const timeline=${JSON.stringify(timeline)};`,
  'const provider=process.argv[2];const started=Date.now();',
  'fs.appendFileSync(timeline,JSON.stringify({provider,started})+"\\n");',
  'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,1200);',
  'fs.appendFileSync(path.join(process.cwd(),"src","worker.txt"),provider+"-change\\n");',
  'fs.mkdirSync(path.join(process.cwd(),"node_modules","discard"),{recursive:true});',
  'fs.writeFileSync(path.join(process.cwd(),"node_modules","discard","cache.bin"),"discard");',
  'const finished=Date.now();fs.appendFileSync(timeline,JSON.stringify({provider,finished})+"\\n");',
  'process.stdout.write(provider+" completed bounded edit\\n");',
].join("\n"), "utf8");

function wrapper(name, provider) {
  if (process.platform === "win32") {
    const file = path.join(root, `${name}.cmd`);
    fs.writeFileSync(file, `@echo off\r\n"${process.execPath}" "${fake}" ${provider} %*\r\n`, "utf8");
    return file;
  }
  const file = path.join(root, name);
  fs.writeFileSync(file, `#!/bin/sh\n"${process.execPath}" "${fake}" ${provider} "$@"\n`, "utf8");
  fs.chmodSync(file, 0o755);
  return file;
}

const cursorCommand = wrapper("cursor-agent", "cursor");
const antigravityCommand = wrapper("agy", "antigravity");
const resources = { generatedAt: new Date().toISOString(), machine: { freeRamMb: 8192, totalRamMb: 16384, logicalCpuCount: 8 }, providers: {
  codex: { available: true, authenticated: true, authMode: "chatgpt", models: [{ id: "gpt-fixture", description: "balanced capable model" }], capacity: { effectiveRemainingPercent: 70 }, quotaPools: [{ id: "codex-shared", scope: "all", remainingPercent: 70 }] },
  claude: { available: false, authenticated: false, reason: "fixture", models: [], quotaPools: [] },
  antigravity: { available: true, authenticated: true, authMode: "cli-session", command: antigravityCommand, models: [{ id: "gemini-flash", displayName: "Gemini Flash" }], capacity: { remainingPercent: 90 }, quotaPools: [{ id: "ag-main", scope: "all", remainingPercent: 90 }] },
  cursor: { available: true, authenticated: true, authMode: "cli-session", command: cursorCommand, models: [], capacity: { remainingPercent: 80 }, quotaPools: [{ id: "cursor-main", scope: "all", remainingPercent: 80 }] },
} };

const { createJob } = require("./core/job-store");
const { collectRound, completeTask, dispatchRound, recordEvidence, startTask, taskSummary } = require("./core/task-orchestrator");
const entrypoint = path.join(__dirname, "ai-mobile-local-mcp.js");

try {
  const portfolio = startTask({
    outcome: "Ship independently verified improvements in alpha and beta",
    acceptanceEvidence: [{ description: "The complete portfolio integration passes", minimumEvidenceLevel: "integration" }],
    projects: [
      { projectId: "alpha", workspace: alpha, outcome: "Ship alpha improvement", priority: 90, acceptanceEvidence: [{ description: "Alpha end-to-end evidence passes", minimumEvidenceLevel: "integration" }], workGraph: [{ id: "alpha-worker", goal: "Implement alpha worker change", priority: 80 }] },
      { projectId: "beta", workspace: beta, outcome: "Ship beta improvement", priority: 70, acceptanceEvidence: [{ description: "Beta end-to-end evidence passes", minimumEvidenceLevel: "integration" }], workGraph: [{ id: "beta-worker", goal: "Implement beta worker change", priority: 80 }] },
    ],
  }, resources);
  assert.equal(portfolio.currentCodex.projectId, "alpha");
  assert.equal(portfolio.projects.length, 2);

  const round = dispatchRound({
    portfolioId: portfolio.portfolioId,
    currentCodex: { projectId: "alpha" },
    workUnits: [
      { projectId: "alpha", workGraphNodeId: "alpha-worker", goal: "Implement independent alpha worker file", independenceReason: "Worker file is disjoint from current Codex API file", relevantFiles: ["src/worker.txt"], expectedFiles: ["src/worker.txt"], readOnly: false, complexity: "medium", taskKind: "code", estimatedDirectTokens: 8000, preferredProvider: "cursor", selectionAuthority: "user" },
      { projectId: "beta", workGraphNodeId: "beta-worker", goal: "Implement independent beta worker file", independenceReason: "Beta is a separate Git project from alpha", relevantFiles: ["src/worker.txt"], expectedFiles: ["src/worker.txt"], readOnly: false, complexity: "medium", taskKind: "code", estimatedDirectTokens: 8000, preferredProvider: "antigravity", model: "Gemini Flash", selectionAuthority: "user", allowAntigravity: true },
    ],
  }, resources, {}, (contract) => createJob(contract, entrypoint));
  assert.equal(round.workers.length, 2, JSON.stringify(round.rejected));
  assert.equal(round.currentCodex.projectId, "alpha");
  assert.equal(taskSummary({ portfolioId: portfolio.portfolioId }).projects.find((row) => row.projectId === "alpha").workGraph[0].state, "running");

  const collected = collectRound({ portfolioId: portfolio.portfolioId, roundId: round.roundId, waitSeconds: 30, detail: "full" });
  assert.equal(collected.results.length, 2);
  assert.ok(collected.results.every((result) => result.state === "completed"), JSON.stringify(collected.results));
  assert.equal(taskSummary({ portfolioId: portfolio.portfolioId }).projects.find((row) => row.projectId === "beta").workGraph[0].state, "awaiting-evidence");
  assert.ok(collected.results.every((result) => !/node_modules|cache\.bin/.test(result.patch || "")), "transient outputs must not enter patches");
  assert.equal(fs.readFileSync(path.join(alpha, "src", "worker.txt"), "utf8"), "alpha-worker\n");
  assert.equal(fs.readFileSync(path.join(beta, "src", "worker.txt"), "utf8"), "beta-worker\n");

  const events = fs.readFileSync(timeline, "utf8").trim().split(/\r?\n/).map((line) => JSON.parse(line));
  const cursor = Object.assign({}, ...events.filter((row) => row.provider === "cursor"));
  const antigravity = Object.assign({}, ...events.filter((row) => row.provider === "antigravity"));
  assert.ok(cursor.started < antigravity.finished && antigravity.started < cursor.finished, "independent project workers must overlap in time");
  assert.deepEqual([...new Set(events.map((row) => row.provider))].sort(), ["antigravity", "cursor"], "only headless test providers should launch");

  recordEvidence({ portfolioId: portfolio.portfolioId, evidence: [{ projectId: "beta", requirementId: "A1", workGraphNodeId: "beta-worker", level: "integration", ref: "beta-fixture", summary: "Beta patch and integration fixture passed", passed: true }] });
  const incomplete = completeTask({ portfolioId: portfolio.portfolioId });
  assert.equal(incomplete.completionAllowed, false);
  assert.equal(incomplete.projects.find((row) => row.projectId === "beta").completionAllowed, true);
  assert.equal(incomplete.projects.find((row) => row.projectId === "alpha").completionAllowed, false, "beta evidence must not complete alpha");
  recordEvidence({ portfolioId: portfolio.portfolioId, evidence: [{ projectId: "alpha", requirementId: "A1", workGraphNodeId: "alpha-worker", level: "integration", ref: "alpha-fixture", summary: "Alpha patch and integration fixture passed", passed: true }] });
  assert.equal(completeTask({ portfolioId: portfolio.portfolioId }).completionAllowed, false, "portfolio-level acceptance must also pass");
  recordEvidence({ portfolioId: portfolio.portfolioId, evidence: [{ requirementId: "A1", level: "integration", ref: "portfolio-fixture", summary: "Combined portfolio integration passed", passed: true }] });
  const completed = completeTask({ portfolioId: portfolio.portfolioId });
  assert.equal(completed.completionAllowed, true);
  assert.equal(taskSummary({ portfolioId: portfolio.portfolioId }).progress.completedProjects, 2);

  const blockedPortfolio = startTask({
    outcome: "Advance any ready project without waiting for a blocked sibling",
    projects: [
      { projectId: "blocked", workspace: alpha, outcome: "Blocked outcome", priority: 100, blockers: ["External authorization is missing"], acceptanceEvidence: ["Blocked project eventually passes"] },
      { projectId: "ready", workspace: beta, outcome: "Ready outcome", priority: 50, acceptanceEvidence: ["Ready project passes"] },
    ],
  }, resources);
  assert.equal(blockedPortfolio.currentCodex.projectId, "ready", "a blocked high-priority project must not stall ready work");

  process.stdout.write(`${JSON.stringify({ ok: true, portfolioId: portfolio.portfolioId, concurrentProjects: 2, independentCompletion: true, blockedProjectDidNotStall: true, desktopAppsOpened: 0 }, null, 2)}\n`);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
