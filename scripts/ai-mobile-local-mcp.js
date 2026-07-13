#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { inventory } = require("./core/capacity");
const { cancelJob, createJob, jobDirectory, readJob } = require("./core/job-store");
const { providerHistory } = require("./core/provider-history");
const { compactCapacity, orchestrateTask } = require("./core/task-orchestrator");
const { executeWorker } = require("./core/worker");
const { runVerification } = require("./core/verification");
const { readJson, safeWorkspace } = require("./core/utils");
const { readProfile, writeProfile } = require("./lib/orchestrator-profile");
const { serve } = require("./mcp/server");
const { run: selfTest } = require("./self-test");

const action = process.argv[2] || "serve";
const entrypoint = path.resolve(__filename);
function arg(name, fallback = "") { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : fallback; }
function jsonInput() { const file = arg("--json-file"); return file ? JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "")) : {}; }
function output(value) { process.stdout.write(`${JSON.stringify(value, null, 2)}\n`); }

try {
  if (action === "serve") serve(entrypoint);
  else if (action === "self-test") output(selfTest());
  else if (action === "resource-inventory-cli") {
    const resources = inventory({ refresh: process.argv.includes("--refresh") });
    output({ generatedAt: resources.generatedAt, cached: resources.cached, passive: true, providers: compactCapacity(resources) });
  }
  else if (action === "orchestrate-task-cli") {
    const input = jsonInput(); const workspace = safeWorkspace(input.workspace); const resources = inventory({});
    output(orchestrateTask({ ...input, workspace }, resources, providerHistory(workspace), (contract) => createJob(contract, entrypoint)));
  }
  else if (action === "read-job-cli") output(readJob(arg("--workspace"), arg("--job-id"), arg("--detail", "compact"), Number(arg("--wait-seconds", "0"))));
  else if (action === "verify-job-cli") { const workspace = safeWorkspace(arg("--workspace")); const dir = jobDirectory(workspace, arg("--job-id")); const contract = readJson(path.join(dir, "contract.json"), {}); output(runVerification(workspace, dir, contract.verificationCommands || [])); }
  else if (action === "cancel-job-cli") output(cancelJob(arg("--workspace"), arg("--job-id")));
  else if (action === "orchestrator-profile-cli") output(arg("--patch") ? writeProfile(JSON.parse(arg("--patch"))) : readProfile());
  else if (action === "worker") process.exitCode = executeWorker(jsonInput());
  else throw new Error(`Unknown action: ${action}`);
} catch (error) {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
}
