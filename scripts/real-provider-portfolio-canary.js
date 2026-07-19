#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-mobile-real-portfolio-"));
process.env.AI_MOBILE_DATA_ROOT = path.join(root, "state");

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stderr || result.stdout || result.error?.message);
}

function project(name, testSource) {
  const workspace = path.join(root, name);
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(workspace, "test.js"), testSource, "utf8");
  fs.writeFileSync(path.join(workspace, "README.md"), `# ${name}\n\nImplement only the module required by test.js.\n`, "utf8");
  run("git", ["init"], workspace);
  run("git", ["config", "user.email", "portfolio-canary@example.invalid"], workspace);
  run("git", ["config", "user.name", "AI Mobile Portfolio Canary"], workspace);
  run("git", ["add", "."], workspace);
  run("git", ["commit", "-m", "fixture"], workspace);
  return workspace;
}

const alpha = project("alpha", [
  'const assert=require("node:assert/strict");',
  'const {slug}=require("./normalize");',
  'assert.equal(slug("  AI Governance  "),"ai-governance");',
  'assert.equal(slug("A__B / C"),"a-b-c");',
  'assert.equal(slug("---"),"");',
].join("\n") + "\n");
const beta = project("beta", [
  'const assert=require("node:assert/strict");',
  'const {rank}=require("./rank");',
  'assert.deepEqual(rank([{id:"b",score:7},{id:"a",score:7},{id:"c",score:9}]).map(x=>x.id),["c","a","b"]);',
  'assert.deepEqual(rank([]),[]);',
].join("\n") + "\n");

const { inventory } = require("./core/capacity");
const { runCoordinator } = require("./core/coordinator");
const { readMaterialEvents } = require("./core/material-events");
const { readJson } = require("./core/utils");
const { jobDirectory, readPortfolio, readPortfolioRound } = require("./core/state-store");
const { startTask, taskSummary } = require("./core/task-orchestrator");
const { storageStatus } = require("./core/workspace-isolation");
const entrypoint = path.join(__dirname, "ai-mobile-local-mcp.js");

(async () => {
  let passed = false;
  try {
    const resources = await inventory({ refresh: true, forDispatch: true });
    for (const providerId of ["codex", "claude"]) {
      const provider = resources.providers[providerId];
      assert.equal(provider?.available && provider?.authenticated, true, `${providerId} is required for the real portfolio canary: ${provider?.reason || "unavailable"}`);
    }
    const portfolio = startTask({
      outcome: "Complete two independently verified disposable projects with one capacity-aware portfolio",
      horizonHours: 5,
      codexReservePercent: 15,
      consoleModel: "gpt-5.6-luna",
      consoleEffort: "low",
      projects: [
        {
          projectId: "alpha",
          workspace: alpha,
          outcome: "Implement and verify deterministic slug normalization",
          priority: 90,
          acceptanceEvidence: [{ description: "Alpha slug normalization passes its deterministic primary-workspace test", minimumEvidenceLevel: "integration" }],
          workGraph: [{
            id: "alpha-implementation",
            goal: "Implement normalize.js exporting slug so every assertion in test.js passes without changing test.js",
            state: "pending",
            priority: 100,
            acceptanceRequirementId: "A1",
            relevantFiles: ["README.md", "test.js", "normalize.js"],
            expectedFiles: ["normalize.js"],
            acceptanceCriteria: ["node test.js exits zero", "test.js remains unchanged"],
            verificationCommands: [{ name: "alpha-test", command: "node", args: ["test.js"], timeoutSeconds: 30 }],
            taskKind: "code",
            complexity: "medium",
            requiredCapabilities: ["source", "local-files", "tests"],
          }],
        },
        {
          projectId: "beta",
          workspace: beta,
          outcome: "Implement and verify deterministic stable ranking",
          priority: 80,
          acceptanceEvidence: [{ description: "Beta stable ranking passes its deterministic primary-workspace test", minimumEvidenceLevel: "integration" }],
          workGraph: [{
            id: "beta-implementation",
            goal: "Implement rank.js exporting rank, sorting by descending score and then ascending id, without changing test.js",
            state: "pending",
            priority: 100,
            acceptanceRequirementId: "A1",
            relevantFiles: ["README.md", "test.js", "rank.js"],
            expectedFiles: ["rank.js"],
            acceptanceCriteria: ["node test.js exits zero", "test.js remains unchanged"],
            verificationCommands: [{ name: "beta-test", command: "node", args: ["test.js"], timeoutSeconds: 30 }],
            taskKind: "code",
            complexity: "medium",
            requiredCapabilities: ["source", "local-files", "tests"],
          }],
        },
      ],
    }, resources);
    assert.equal(portfolio.projects.length, 2);
    assert.equal(portfolio.currentCodex.files?.length || 0, 0);

    const result = await runCoordinator({ portfolioId: portfolio.portfolioId, executionId: "execution-real-provider-portfolio", config: { maxRounds: 4, maxMinutes: 12, noProgressLimit: 2, horizonHours: 5 } }, entrypoint);
    if (result.state !== "completed") {
      const diagnostic = {
        preservedRoot: root,
        result,
        summary: taskSummary({ portfolioId: portfolio.portfolioId }),
        events: readMaterialEvents({ portfolioId: portfolio.portfolioId }),
      };
      process.stderr.write(`${JSON.stringify(diagnostic, null, 2)}\n`);
      assert.equal(result.state, "completed", JSON.stringify(result));
    }
    run("node", ["test.js"], alpha);
    run("node", ["test.js"], beta);

    const persisted = readPortfolio(portfolio.portfolioId);
    const latest = readPortfolioRound(portfolio.portfolioId, persisted.rounds.at(-1).roundId);
    assert.equal(latest.jobs.length, 2, JSON.stringify(latest.rejected));
    const providers = [...new Set(latest.jobs.map((job) => job.provider))].sort();
    assert.deepEqual(providers, ["claude", "codex"], `Expected the per-provider lease-aware router to spread the two lanes: ${JSON.stringify(latest.jobs)}`);
    const statuses = latest.jobs.map((job) => readJson(path.join(jobDirectory(job.taskId, job.jobId), "status.json"), {}));
    const started = statuses.map((status) => Date.parse(status.startedAt));
    const finished = statuses.map((status) => Date.parse(status.finishedAt));
    assert.ok(started[0] < finished[1] && started[1] < finished[0], `Independent real-provider workers did not overlap: ${JSON.stringify(statuses)}`);
    assert.ok(statuses.every((status) => status.integrationState === "passed"), JSON.stringify(statuses));

    const summary = taskSummary({ portfolioId: portfolio.portfolioId });
    assert.equal(summary.completionAllowed, true);
    assert.equal(summary.progress.completedProjects, 2);
    assert.ok(summary.projects.every((project) => project.progress.passing === project.progress.required));
    assert.equal(fs.existsSync(path.join(alpha, "rank.js")), false, "beta output must never cross into alpha");
    assert.equal(fs.existsSync(path.join(beta, "normalize.js")), false, "alpha output must never cross into beta");
    const storage = storageStatus();
    assert.equal(storage.withinQuota, true, JSON.stringify(storage));
    assert.equal(storage.bytes, 0, JSON.stringify(storage));

    process.stdout.write(JSON.stringify({
      ok: true,
      portfolioId: portfolio.portfolioId,
      realProviders: providers,
      concurrentProjects: 2,
      independentAcceptance: true,
      isolatedEvidence: true,
      codexReservePercent: 15,
      worktreesCleaned: true,
      storageWithinLimit: true,
      desktopAppsOpened: 0,
    }, null, 2) + "\n");
    passed = true;
  } finally {
    if (passed) {
      fs.rmSync(root, { recursive: true, force: true });
    } else {
      process.stderr.write(`Preserved failed canary evidence at ${root}\n`);
    }
  }
})().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});