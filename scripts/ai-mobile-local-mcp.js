#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { inventory } = require("./core/capacity");
const { createJob } = require("./core/job-store");
const { providerHistory } = require("./core/provider-history");
const { cleanupStaleLeases, resourceLeaseSnapshot } = require("./core/resource-leases");
const { cancelTask, collectRound, compactCapacity, completeTask, dispatchRound, recordEvidence, startTask, taskSummary } = require("./core/task-orchestrator");
const { cleanupAbandonedWorktrees, storageStatus } = require("./core/workspace-isolation");
const { executeWorker } = require("./core/worker");
const { readProfile, writeProfile } = require("./lib/orchestrator-profile");
const { serve } = require("./mcp/server");
const { run: selfTest } = require("./self-test");

const action = process.argv[2] || "serve";
const entrypoint = path.resolve(__filename);
function arg(name, fallback = "") { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : fallback; }
function jsonInput() { const file = arg("--json-file"); return file ? JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "")) : {}; }
function output(value) { process.stdout.write(`${JSON.stringify(value, null, 2)}\n`); }
function taskOrPortfolioArgs() {
  const portfolioId = arg("--portfolio-id");
  return portfolioId ? { portfolioId } : { taskId: arg("--task-id") };
}

async function main() {
  if (action !== "worker") {
    cleanupStaleLeases();
    cleanupAbandonedWorktrees();
  }
  if (action === "serve") return serve(entrypoint);
  if (action === "self-test") return output(await selfTest());
  if (action === "resource-inventory-cli") {
    const resources = await inventory({ refresh: process.argv.includes("--refresh") });
    return output({ generatedAt: resources.generatedAt, cached: resources.cached, passive: true, machine: resources.machine || null, providers: compactCapacity(resources), leases: resourceLeaseSnapshot(), worktreeStorage: storageStatus() });
  }
  if (action === "start-task-cli") {
    const input = jsonInput();
    return output(startTask(input, await inventory({ refresh: false })));
  }
  if (action === "dispatch-round-cli") {
    const input = jsonInput();
    return output(dispatchRound(input, await inventory({ forDispatch: true }), providerHistory(), (contract) => createJob(contract, entrypoint)));
  }
  if (action === "collect-round-cli") return output(collectRound(jsonInput()));
  if (action === "record-evidence-cli") return output(recordEvidence(jsonInput()));
  if (action === "task-summary-cli") return output(taskSummary(taskOrPortfolioArgs()));
  if (action === "complete-task-cli") return output(completeTask(taskOrPortfolioArgs()));
  if (action === "cancel-task-cli") return output(cancelTask(taskOrPortfolioArgs()));
  if (action === "orchestrator-profile-cli") return output(arg("--patch") ? writeProfile(JSON.parse(arg("--patch"))) : readProfile());
  if (action === "worker") { process.exitCode = executeWorker(jsonInput()); return; }
  throw new Error(`Unknown action: ${action}`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
