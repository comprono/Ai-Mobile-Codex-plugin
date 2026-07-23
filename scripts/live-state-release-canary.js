#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { backupSqliteSnapshot } = require("./core/sqlite-snapshot");

const TASK_ID = String(process.env.AI_MOBILE_CANARY_TASK_ID || "");
const SOURCE_STATE = path.resolve(process.env.AI_MOBILE_CANARY_SOURCE_STATE || path.join(process.env.LOCALAPPDATA || os.tmpdir(), "AI Mobile", "v1"));
const KEEP = process.env.AI_MOBILE_CANARY_KEEP === "1";
const TASK_PATTERN = /^task-[A-Za-z0-9._-]{8,100}$/;
const PREFLIGHT_ONLY = process.env.AI_MOBILE_CANARY_PREFLIGHT_ONLY === "1";
const CONTRACT_PREFLIGHT_ONLY = process.env.AI_MOBILE_CANARY_CONTRACT_PREFLIGHT_ONLY === "1";
const EXECUTION_PREFLIGHT_ONLY = process.env.AI_MOBILE_CANARY_EXECUTION_PREFLIGHT_ONLY === "1";
const OPERATION_REVISION_ONLY = process.env.AI_MOBILE_CANARY_OPERATION_REVISION_ONLY === "1";
const TERMINAL_COORDINATOR_STATES = new Set(["stopped", "completed", "failed", "cancelled", "interrupted", "superseded"]);

function expectedExecutorMap() {
  const text = String(process.env.AI_MOBILE_CANARY_EXPECTED_EXECUTORS_JSON || "").trim();
  if (!text) return {};
  const parsed = JSON.parse(text);
  assert.ok(parsed && typeof parsed === "object" && !Array.isArray(parsed), "Expected executor contract must be a JSON object.");
  assert.deepEqual(Object.keys(parsed).sort(), ["REQ-003", "REQ-004"], "The Job Vibhu release gate requires exact executor expectations for REQ-003 and REQ-004.");
  return Object.fromEntries(Object.entries(parsed).map(([requirementId, executors]) => {
    assert.ok(Array.isArray(executors) && executors.length, `Expected executor contract for ${requirementId} must be a non-empty array.`);
    return [String(requirementId), executors.map(String)];
  }));
}

function digestFile(file) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(file));
  return hash.digest("hex");
}

function directoryManifest(root) {
  const rows = [];
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name.endsWith(".lock")) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) rows.push([path.relative(root, full).replace(/\\/g, "/"), fs.statSync(full).size, digestFile(full)]);
    }
  }
  rows.sort((left, right) => left[0].localeCompare(right[0]));
  return crypto.createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}

function command(commandName, args, cwd, env = {}) {
  const result = spawnSync(commandName, args, { cwd, encoding: "utf8", windowsHide: true, timeout: 30000, env: { ...process.env, ...env } });
  assert.equal(result.status, 0, result.stderr || result.stdout || (result.error && result.error.message));
  return String(result.stdout || "").trim();
}

function contextGitStatusArgs(task, workspace) {
  const exclusions = [];
  for (const source of task.program?.sourceCatalog?.sources || []) {
    if (!["log", "database"].includes(source.type)) continue;
    const full = path.resolve(workspace, source.locator);
    const relative = path.relative(workspace, full).replace(/\\/g, "/");
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) continue;
    exclusions.push(relative);
    if (source.type === "database") exclusions.push(`${relative}-wal`, `${relative}-shm`, `${relative}-journal`);
  }
  return [
    "-C", workspace, "status", "--porcelain=v1", "--untracked-files=all", "--", ".",
    ...[...new Set(exclusions)].sort().map((relative) => `:(exclude,literal)${relative}`),
  ];
}

function workspaceManifest(task, mode = "static") {
  const workspace = path.resolve(task.workspace);
  const rows = [];
  const localTypes = mode === "dynamic"
    ? new Set(["log", "database"])
    : new Set(["project-outcome", "acceptance", "chat", "file"]);
  for (const source of task.program.sourceCatalog.sources || []) {
    if (!localTypes.has(source.type)) continue;
    const full = path.resolve(workspace, source.locator);
    const relative = path.relative(workspace, full);
    assert.ok(relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative)), "Source leaves workspace: " + source.locator);
    if (fs.existsSync(full) && fs.statSync(full).isFile()) rows.push([source.id, relative.replace(/\\/g, "/"), fs.statSync(full).size, digestFile(full)]);
    else rows.push([source.id, relative.replace(/\\/g, "/"), "missing"]);
  }
  if (mode !== "dynamic") {
    for (const locator of workspaceOverlayLocators()) {
      const overlay = containedProjectPath(workspace, locator, "Canary overlay manifest");
      rows.push([
        `overlay:${overlay.relative.replace(/\\/g, "/")}`,
        fs.existsSync(overlay.full) && fs.statSync(overlay.full).isFile() ? fs.statSync(overlay.full).size : "missing",
        fs.existsSync(overlay.full) && fs.statSync(overlay.full).isFile() ? digestFile(overlay.full) : "missing",
      ]);
    }
    const gitEnv = { GIT_OPTIONAL_LOCKS: "0" };
    rows.push(["git-head", command("git", ["-C", workspace, "rev-parse", "HEAD"], workspace, gitEnv)]);
    rows.push(["git-status", command("git", contextGitStatusArgs(task, workspace), workspace, gitEnv)]);
  }
  rows.sort((left, right) => String(left[0]).localeCompare(String(right[0])));
  return crypto.createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}

function cloneState(source, target) {
  const skippedRoots = new Set(["project-workspace", "worktrees", "worktree-metadata", "restart-handoffs"]);
  fs.cpSync(source, target, {
    recursive: true,
    filter: (candidate) => {
      const relative = path.relative(source, candidate);
      if (!relative) return true;
      const first = relative.split(path.sep)[0];
      if (skippedRoots.has(first)) return false;
      return !path.basename(candidate).endsWith(".lock");
    },
  });
}

function authorizedOperationRevisionInput() {
  const text = String(process.env.AI_MOBILE_CANARY_OPERATION_REVISION_JSON || "").trim();
  assert.ok(text, "Operation revision mode requires AI_MOBILE_CANARY_OPERATION_REVISION_JSON.");
  const parsed = JSON.parse(text);
  assert.ok(parsed && typeof parsed === "object" && !Array.isArray(parsed), "Operation revision input must be a JSON object.");
  return parsed;
}

function workspaceOverlayLocators() {
  const text = String(process.env.AI_MOBILE_CANARY_WORKSPACE_OVERLAY_JSON || "").trim();
  if (!text) return [];
  const parsed = JSON.parse(text);
  assert.ok(Array.isArray(parsed) && parsed.length <= 20, "Canary workspace overlay must be an array of at most 20 project-relative files.");
  return [...new Set(parsed.map((value) => String(value || "").trim()).filter(Boolean))];
}

function containedProjectPath(workspace, locator, label) {
  const full = path.resolve(workspace, String(locator || ""));
  const relative = path.relative(workspace, full);
  assert.ok(relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative)), `${label} leaves the project workspace: ${locator}`);
  return { full, relative };
}

async function cloneProjectWorkspace(task, cloneRoot) {
  const sourceWorkspace = path.resolve(task.workspace);
  const targetWorkspace = path.join(cloneRoot, "project-workspace");
  const gitEnv = { GIT_OPTIONAL_LOCKS: "0" };
  const sourceRoot = command("git", ["-C", sourceWorkspace, "rev-parse", "--show-toplevel"], sourceWorkspace, gitEnv);
  assert.equal(path.resolve(sourceRoot), sourceWorkspace, "The release canary requires the task workspace to be the Git repository root.");
  command("git", ["clone", "--quiet", "--no-hardlinks", sourceWorkspace, targetWorkspace], cloneRoot, gitEnv);
  assert.equal(
    command("git", ["-C", targetWorkspace, "rev-parse", "HEAD"], targetWorkspace, gitEnv),
    command("git", ["-C", sourceWorkspace, "rev-parse", "HEAD"], sourceWorkspace, gitEnv),
    "The disposable project clone did not preserve the exact Git revision.",
  );

  for (const source of task.program?.sourceCatalog?.sources || []) {
    if (["git", "service", "browser", "external"].includes(source.type)) continue;
    const from = containedProjectPath(sourceWorkspace, source.locator, `Source ${source.id}`);
    const to = containedProjectPath(targetWorkspace, source.locator, `Cloned source ${source.id}`);
    if (!fs.existsSync(from.full) || !fs.statSync(from.full).isFile()) continue;
    fs.mkdirSync(path.dirname(to.full), { recursive: true });
    if (source.type === "database") await backupSqliteSnapshot(from.full, to.full);
    else fs.copyFileSync(from.full, to.full);
  }
  for (const locator of workspaceOverlayLocators()) {
    const from = containedProjectPath(sourceWorkspace, locator, "Canary overlay source");
    const to = containedProjectPath(targetWorkspace, locator, "Canary overlay target");
    assert.ok(fs.existsSync(from.full) && fs.statSync(from.full).isFile(), `Canary overlay is not a regular project file: ${locator}`);
    fs.mkdirSync(path.dirname(to.full), { recursive: true });
    fs.copyFileSync(from.full, to.full);
  }
  return targetWorkspace;
}

function readJsonFile(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { return fallback; }
}

function activePackages(task) {
  return (task.program?.workPackages || []).filter((row) => ["pending", "ready", "running"].includes(row.state));
}

function classifyCanaryStart(task, coordinator, taskRoot) {
  assert.equal(task.program?.mode, "director-cfo", "The canary requires the already-migrated canonical Director task.");
  assert.ok(TERMINAL_COORDINATOR_STATES.has(coordinator?.state), "The canary coordinator must begin terminal.");
  assert.equal(coordinator?.pid ?? null, null, "The canary coordinator must not inherit a live process owner.");
  const active = activePackages(task);

  if (task.program.masterPlan) {
    assert.ok(["execution", "verification"].includes(task.program.phase), "A canary with an accepted Master Plan must resume execution or verification.");
    assert.ok(active.length > 0, "Execution-stage recovery requires at least one dependency-ready or running work package.");
    return {
      mode: "execution-resume",
      executors: [...new Set(active.map((row) => row.executorKind).filter(Boolean))],
      phases: [task.program.phase],
      maxRounds: 2,
      maxMinutes: 90,
      initialFailureMemoryLength: (task.program.failureMemory || []).length,
    };
  }
  assert.equal(task.program.masterPlan, null, "A pre-plan canary cannot carry a partial Master Plan.");

  if (task.program.phase === "context") {
    assert.equal(task.program.contextDossier, null, "Context bootstrap must not inherit a completed context dossier.");
    assert.equal(task.program.activeCampaign, null, "The guarded canary must not inherit an active campaign.");
    assert.equal(active.length, 1, "The guarded canary requires exactly one active bootstrap package.");
    assert.equal(active[0].executorKind, "context-scout", "The only initial package must be the context scout.");
    assert.equal(active[0].state, "pending", "The initial context scout must be pending and unowned.");
    assert.equal(String(active[0].jobId || ""), "", "The initial context scout must have no worker owner.");
    return {
      mode: "context",
      executors: ["context-scout", "strategist"],
      phases: ["context", "strategy"],
      maxRounds: 2,
      maxMinutes: 30,
      initialFailureMemoryLength: (task.program.failureMemory || []).length,
    };
  }

  if (task.program.phase === "reconciliation" && task.program.contextDossier) {
    assert.equal(task.program.activeCampaign, null, "Plan recovery must not retain an active campaign owner.");
    assert.equal(active.length, 1, "Plan recovery requires exactly one active reconciliation package.");
    const reconciliation = active[0];
    assert.equal(reconciliation.executorKind, "reconciliation", "Plan recovery must begin with a strong reconciler.");
    assert.equal(reconciliation.state, "pending", "Plan recovery reconciliation must be pending and unowned.");
    assert.equal(String(reconciliation.jobId || ""), "", "Plan recovery reconciliation must not inherit a worker owner.");
    assert.equal(reconciliation.policy?.revisePlan, true, "Plan-invalid recovery must require a revised plan.");
    const failedStrategy = (task.program.workPackages || []).find((row) => row.workPackageId === reconciliation.failedWorkPackageId);
    assert.equal(failedStrategy?.executorKind, "strategist", "Plan recovery must trace to the rejected strategist package.");
    assert.equal(failedStrategy?.state, "failed", "The rejected strategist must remain failed until reconciliation integrates.");
    assert.ok((reconciliation.priorAssuranceErrors || []).length, "Plan recovery must preserve exact assurance errors.");
    const fullContextRefresh = reconciliation.policy?.fullContextRefresh === true;
    return {
      mode: fullContextRefresh ? "plan-reconciliation" : "plan-revision-reconciliation",
      executors: fullContextRefresh
        ? ["reconciliation", "context-scout", "strategist"]
        : ["reconciliation", "strategist"],
      phases: fullContextRefresh
        ? ["reconciliation", "context", "strategy"]
        : ["reconciliation", "strategy"],
      maxRounds: 3,
      maxMinutes: 90,
      stalledWorkPackageId: reconciliation.workPackageId,
      completedJobId: "",
      initialFailureMemoryLength: (task.program.failureMemory || []).length,
      initialContextRevision: Number(task.program.contextDossier.contextRevision || 0),
    };
  }

  if (task.program.phase === "reconciliation" && !task.program.contextDossier && active.length === 1 && active[0].state === "pending") {
    assert.equal(task.program.activeCampaign, null, "Post-failure recovery must not retain an active campaign owner.");
    const latestRound = (task.rounds || []).at(-1);
    assert.equal(latestRound?.state, "needs-correction", "The exact post-failure clone must retain the stale unconsumed round.");
    const reconciliation = active[0];
    assert.equal(reconciliation.executorKind, "reconciliation", "Post-failure recovery must own one pending reconciliation package.");
    assert.equal(String(reconciliation.jobId || ""), "", "The replacement reconciliation must be unowned before resume.");
    const failedPackage = (task.program.workPackages || []).find((row) => row.workPackageId === reconciliation.failedWorkPackageId);
    assert.equal(failedPackage?.state, "failed", "The replacement reconciliation must trace to a settled failed package.");
    assert.ok(reconciliation.failurePacket?.failureFingerprint, "The replacement reconciliation must retain a typed failure packet.");
    return {
      mode: "post-failure-reconciliation",
      executors: ["reconciliation", "context-scout", "strategist"],
      phases: ["reconciliation", "context", "strategy"],
      maxRounds: 3,
      maxMinutes: 90,
      staleRoundId: latestRound.roundId,
      stalledWorkPackageId: failedPackage.workPackageId,
      completedJobId: failedPackage.jobId || "",
      initialFailureMemoryLength: (task.program.failureMemory || []).length,
    };
  }

  if (task.program.phase === "strategy" && task.program.contextDossier && !task.program.masterPlan
    && active.length === 1 && active[0].state === "pending") {
    const strategy = active[0];
    assert.equal(strategy.executorKind, "strategist", "Strategy-stage recovery must own one pending strategist package.");
    assert.equal(String(strategy.jobId || ""), "", "Strategy-stage recovery must begin with an unowned strategist package.");
    assert.ok(Number(strategy.resourceEstimate?.tokens || strategy.estimatedDirectTokens || 0) > 0,
      "Strategy-stage recovery must retain a bounded token estimate.");
    assert.ok(Number(strategy.resourceEstimate?.wallTimeSeconds || strategy.timeoutSeconds || 0) > 0,
      "Strategy-stage recovery must retain a bounded duration estimate.");
    return {
      mode: "strategy-resume",
      executors: ["strategist", "context-scout"],
      phases: ["strategy", "execution"],
      maxRounds: 3,
      maxMinutes: 90,
      stalledWorkPackageId: strategy.workPackageId,
      completedJobId: "",
      initialFailureMemoryLength: (task.program.failureMemory || []).length,
      initialContextRevision: Number(task.program.contextDossier.contextRevision || 0),
    };
  }

  assert.equal(task.program.contextDossier, null, "Pre-plan reconciliation must not inherit a completed context dossier.");
  assert.equal(task.program.phase, "reconciliation", "The guarded canary must begin at context bootstrap or a bounded reconciliation recovery.");
  assert.equal(task.program.contracts?.campaign ?? null, null, "Pre-plan recovery must not inherit a canonical campaign.");
  assert.equal(task.program.activeCampaign?.state, "active", "The observed stale runtime campaign must remain active.");
  assert.equal(active.length, 1, "The pre-plan stall requires exactly one active reconciliation package.");
  const reconciliation = active[0];
  assert.equal(reconciliation.executorKind, "reconciliation", "The stalled package must be reconciliation.");
  assert.equal(reconciliation.state, "running", "The stalled reconciliation package must retain the observed running state.");
  assert.equal(reconciliation.revisionFence ?? null, null, "Pre-plan reconciliation must not claim a canonical revision fence.");
  assert.ok(reconciliation.jobId, "The stalled reconciliation package must retain its completed worker job id.");
  const packet = reconciliation.failurePacket;
  assert.ok(packet?.failureFingerprint, "The stalled reconciliation package must retain a typed failure packet.");
  assert.equal(packet.taskId, task.taskId, "The reconciliation failure packet must belong to the exact task.");
  assert.equal(packet.missionId, task.program.mission?.missionId, "The reconciliation failure packet must belong to the current mission.");
  assert.equal(reconciliation.failedWorkPackageId, packet.workPackageId, "The reconciliation package must target its recorded failed work package.");
  const failedContext = (task.program.workPackages || []).find((row) => row.workPackageId === packet.workPackageId);
  assert.equal(failedContext?.executorKind, "context-scout", "The pre-plan reconciliation must trace to the failed context scout.");
  assert.equal(failedContext?.state, "failed", "The context scout must remain failed until reconciliation integrates.");
  assert.ok((task.program.failureMemory || []).some((row) => (
    row.failureFingerprint === packet.failureFingerprint
    && row.workPackageId === packet.workPackageId
    && row.attemptId === packet.attemptId
  )), "Failure memory must own the exact reconciliation lineage.");
  const jobRoot = path.join(taskRoot, "jobs", reconciliation.jobId);
  const status = readJsonFile(path.join(jobRoot, "status.json"));
  const handoff = readJsonFile(path.join(jobRoot, "handoff.json"));
  const contract = readJsonFile(path.join(jobRoot, "contract.json"));
  assert.equal(status?.state, "completed", "The stalled reconciliation worker must already be terminal completed.");
  assert.ok(status?.collectedAt, "The stalled reconciliation worker must already be collected.");
  assert.equal(handoff?.state, "completed", "The stalled reconciliation worker must retain a completed typed handoff.");
  assert.equal(contract?.directorProgram?.workPackageId, reconciliation.workPackageId, "The persisted reconciliation contract must own the stalled package.");
  assert.equal(contract?.directorProgram?.revisionFence ?? null, null, "The pre-plan job contract must not claim a Director revision fence.");
  assert.equal(contract?.revisionFence ?? null, null, "The pre-plan job contract must not claim a top-level revision fence.");
  return {
    mode: "reconciliation",
    executors: ["reconciliation", "context-scout", "strategist"],
    phases: ["reconciliation", "context", "strategy"],
    maxRounds: 3,
    maxMinutes: 90,
    stalledWorkPackageId: reconciliation.workPackageId,
    completedJobId: reconciliation.jobId,
    initialFailureMemoryLength: (task.program.failureMemory || []).length,
  };
}

function databaseIntegrationProof(afterStrategy, cloneRoot, initialJobIds, requireNewContextOwner = true) {
  const databaseSources = (afterStrategy.program?.sourceCatalog?.sources || [])
    .filter((source) => source.type === "database" && source.required !== false);
  assert.ok(databaseSources.length > 0, "The guarded program must include at least one required database source.");
  const dossier = afterStrategy.program?.contextDossier;
  assert.ok(dossier, "Database proof requires the accepted context dossier.");
  const initial = initialJobIds instanceof Set ? initialJobIds : new Set(initialJobIds || []);
  const jobsRoot = path.join(cloneRoot, "tasks", afterStrategy.taskId, "jobs");
  const newContextJobs = fs.readdirSync(jobsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !initial.has(entry.name))
    .map((entry) => {
      const jobRoot = path.join(jobsRoot, entry.name);
      return {
        jobId: entry.name,
        contract: readJsonFile(path.join(jobRoot, "contract.json")),
        status: readJsonFile(path.join(jobRoot, "status.json")),
        handoff: readJsonFile(path.join(jobRoot, "handoff.json")),
      };
    })
    .filter((job) => (
      job.contract?.executorKind === "context-scout"
      && job.status?.state === "completed"
      && job.handoff?.state === "completed"
    ));
  if (requireNewContextOwner) assert.ok(newContextJobs.length > 0, "No newly completed persisted context-scout job was found.");

  const dossierObservations = new Map((dossier.sourceObservations || []).map((row) => [row.sourceId, row]));
  const claimGroups = ["currentState", "facts", "decisions", "failures"];
  const unavailableOrHashOnly = /\bunavailable\b|\bcould\s+not\b|\bcannot\b|\bnot\s+(?:query|inspect|read|observe)\b|\b(?:hash|fingerprint|receipt)\s+(?:only|alone)\b|\bbeyond\s+(?:the\s+)?(?:hash|fingerprint|receipt)\b/i;
  const domainVocabulary = /\b(?:applications?|attempts?|jobs?|workflows?|plans?|manual|gates?|submit|runner|portals?|integrity|status|tables?|rows?|decisions?|profiles?|evidence)\b/i;
  const hashPattern = /\b[a-f0-9]{64}\b/gi;
  const hex64 = /^[a-f0-9]{64}$/i;
  const sources = databaseSources.map((source) => {
    const dossierObservation = dossierObservations.get(source.id);
    assert.ok(dossierObservation, `The accepted dossier omitted database observation ${source.id}.`);
    assert.ok(["observed", "unchanged"].includes(dossierObservation.status), `The accepted dossier did not observe ${source.id}.`);
    assert.match(String(dossierObservation.queryReceiptFingerprint || ""), hex64, `The accepted dossier receipt fingerprint is invalid for ${source.id}.`);
    assert.match(String(dossierObservation.queryReceiptSnapshotHash || ""), hex64, `The accepted dossier snapshot hash is invalid for ${source.id}.`);
    if (!requireNewContextOwner) {
      return {
        sourceId: source.id,
        receiptFingerprint: dossierObservation.queryReceiptFingerprint,
        snapshotContentHash: dossierObservation.queryReceiptSnapshotHash,
        rowsIncluded: null,
        semanticClaimGroup: "preserved-accepted-dossier",
      };
    }
    const match = newContextJobs.find((job) => Boolean(job.contract?.contextObservationReceiptExpectations?.[source.id]));
    assert.ok(match, `No newly completed context-scout contract owns the database receipt for ${source.id}.`);
    const preflight = match.contract.contextObservationPreflight;
    assert.equal(preflight?.ok, true, `Database preflight did not pass for ${source.id}.`);
    assert.equal(preflight?.mode, "immutable-sqlite-receipt", `Database preflight mode drifted for ${source.id}.`);
    assert.ok((preflight?.databaseSourceIds || []).includes(source.id), `Database preflight omitted ${source.id}.`);
    const expectation = match.contract.contextObservationReceiptExpectations[source.id];
    assert.match(String(expectation.receiptFingerprint || ""), hex64, `Database receipt fingerprint is invalid for ${source.id}.`);
    assert.match(String(expectation.snapshotContentHash || ""), hex64, `Database snapshot hash is invalid for ${source.id}.`);
    assert.ok(Number(expectation.rowsIncluded) > 0, `Database receipt did not include rows for ${source.id}.`);

    assert.equal(dossierObservation.queryReceiptFingerprint, expectation.receiptFingerprint, `The accepted dossier receipt fingerprint drifted for ${source.id}.`);
    assert.equal(String(dossierObservation.queryReceiptSnapshotHash || "").toLowerCase(), String(expectation.snapshotContentHash).toLowerCase(), `The accepted dossier snapshot hash drifted for ${source.id}.`);

    const handoffArtifact = match.handoff.deliverable || match.handoff.artifact;
    const handoffObservation = (handoffArtifact?.sourceObservations || []).find((row) => row.sourceId === source.id);
    assert.ok(handoffObservation, `The persisted context handoff omitted database observation ${source.id}.`);
    assert.ok(["observed", "unchanged"].includes(handoffObservation.status), `The persisted context handoff did not observe ${source.id}.`);
    assert.equal(handoffObservation.queryReceiptFingerprint, expectation.receiptFingerprint, `The persisted context handoff receipt fingerprint drifted for ${source.id}.`);
    assert.equal(String(handoffObservation.queryReceiptSnapshotHash || "").toLowerCase(), String(expectation.snapshotContentHash).toLowerCase(), `The persisted context handoff snapshot hash drifted for ${source.id}.`);

    let semanticClaimGroup = "";
    for (const group of claimGroups) {
      const accepted = (dossier[group] || []).some((claim) => {
        const text = String(claim?.text || "").trim();
        if (!(claim?.sourceIds || []).includes(source.id) || text.length < 30 || unavailableOrHashOnly.test(text)) return false;
        const semanticText = text.split(source.id).join(" ").replace(hashPattern, " ");
        return domainVocabulary.test(semanticText);
      });
      if (accepted) {
        semanticClaimGroup = group;
        break;
      }
    }
    assert.ok(semanticClaimGroup, `The accepted dossier has no substantive receipt-backed database claim for ${source.id}.`);
    return {
      sourceId: source.id,
      jobId: match.jobId,
      receiptFingerprint: expectation.receiptFingerprint,
      snapshotContentHash: expectation.snapshotContentHash,
      rowsIncluded: Number(expectation.rowsIncluded),
      observationStatus: dossierObservation.status,
      semanticClaimGroup,
    };
  });
  return { mode: "persisted-contract-handoff-dossier", sources };
}

function waitForCoordinator(statusFn, taskId, deadlineMs) {
  while (Date.now() < deadlineMs) {
    const state = statusFn({ taskId }).execution;
    if (!state.active && ["completed", "stopped", "failed", "cancelled", "interrupted", "superseded"].includes(state.state)) return state;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
  }
  throw new Error("The cloned-state coordinator did not reach a finite boundary before the canary deadline.");
}

async function main() {
  assert.ok(TASK_PATTERN.test(TASK_ID), "Set AI_MOBILE_CANARY_TASK_ID to the exact durable task under test.");
  assert.ok(fs.existsSync(SOURCE_STATE), "Production AI Mobile state root was not found: " + SOURCE_STATE);
  const sourceTaskRoot = path.join(SOURCE_STATE, "tasks", TASK_ID);
  assert.ok(fs.existsSync(sourceTaskRoot), "Canary task was not found: " + TASK_ID);
  const sourceTask = JSON.parse(fs.readFileSync(path.join(sourceTaskRoot, "task.json"), "utf8"));
  assert.equal(sourceTask.program && sourceTask.program.mode, "director-cfo", "The canary requires the already-migrated canonical Director task.");
  const sourceCoordinator = JSON.parse(fs.readFileSync(path.join(sourceTaskRoot, "coordinator.json"), "utf8"));
  assert.ok(["stopped", "completed", "failed", "cancelled", "interrupted", "superseded"].includes(sourceCoordinator.state), "Production coordinator must be terminal before cloning.");

  const productionTaskBefore = directoryManifest(sourceTaskRoot);
  const expectedExecutors = expectedExecutorMap();
  const tempParent = path.resolve(process.env.AI_MOBILE_CANARY_TEMP_PARENT || path.join(os.tmpdir(), "ai-mobile-release-canary"));
  fs.mkdirSync(tempParent, { recursive: true });
  const cloneRoot = fs.mkdtempSync(path.join(tempParent, "ai-mobile-live-state-"));
  assert.equal(path.dirname(cloneRoot), tempParent, "Canary clone escaped the explicit temporary parent.");
  let successReceipt = null;
  let coordinator = null;
  let runtimeLaunched = false;
  let quiesceCanary = null;
  let clonedTask = null;
  let productionWorkspaceBefore = null;
  let sandboxWorkspaceBefore = null;
  let sandboxWorkspace = null;
  let primaryError = null;
  try {
  cloneState(SOURCE_STATE, cloneRoot);
  const clonedTaskRoot = path.join(cloneRoot, "tasks", TASK_ID);
  assert.equal(directoryManifest(clonedTaskRoot), productionTaskBefore, "The disposable task copy does not exactly match the guarded production task snapshot.");
  clonedTask = JSON.parse(fs.readFileSync(path.join(clonedTaskRoot, "task.json"), "utf8"));
  const clonedCoordinator = JSON.parse(fs.readFileSync(path.join(clonedTaskRoot, "coordinator.json"), "utf8"));
  productionWorkspaceBefore = workspaceManifest(sourceTask, "static");
  const dynamicWorkspaceBefore = workspaceManifest(clonedTask, "dynamic");
  const start = classifyCanaryStart(clonedTask, clonedCoordinator, clonedTaskRoot);
  if (PREFLIGHT_ONLY) {
    assert.equal(directoryManifest(sourceTaskRoot), productionTaskBefore, "Production AI Mobile task state changed during preflight.");
    assert.equal(workspaceManifest(sourceTask, "static"), productionWorkspaceBefore, "Static project state changed during preflight.");
    successReceipt = {
      ok: true,
      preflightOnly: true,
      taskId: TASK_ID,
      startMode: start.mode,
      providerWorkersLaunched: 0,
      productionStateUnchanged: true,
      workspaceUnchanged: true,
      cloneRetained: KEEP,
    };
    return successReceipt;
  }

  sandboxWorkspace = await cloneProjectWorkspace(clonedTask, cloneRoot);
  clonedTask = { ...clonedTask, workspace: sandboxWorkspace };
  fs.writeFileSync(path.join(clonedTaskRoot, "task.json"), JSON.stringify(clonedTask, null, 2) + "\n", "utf8");
  sandboxWorkspaceBefore = [
    workspaceManifest(clonedTask, "static"),
    workspaceManifest(clonedTask, "dynamic"),
  ].join(":");
  process.env.AI_MOBILE_DATA_ROOT = cloneRoot;
  delete process.env.AI_MOBILE_CANARY_EXECUTOR_ALLOWLIST;
  process.env.AI_MOBILE_CANARY_PHASE_ALLOWLIST = "context,strategy,reconciliation,execution,verification";
  process.env.AI_MOBILE_CANARY_POLICY = "disposable-project";
  process.env.AI_MOBILE_CANARY_WORKSPACE_ROOT = sandboxWorkspace;
  process.env.AI_MOBILE_CANARY_FAIL_FAST = "1";
  const entrypoint = path.join(__dirname, "ai-mobile-local-mcp.js");
  const { inventory } = require("./core/capacity");
  const { coordinatorStatus, requestCoordinatorCancel } = require("./core/coordinator");
  const { invoke } = require("./mcp/server");
  const {
    prepareProgramDispatch,
    programRecommendedWorkUnits,
    reviseAuthorizedOperation,
  } = require("./core/director-cfo-orchestrator");
  const { cancelJob, disposableCanaryDecision, statusFor } = require("./core/job-store");
  const { providerHistory } = require("./core/provider-history");
  const { listJobIds, readRound, readTask } = require("./core/state-store");
  const { dispatchRound } = require("./core/task-orchestrator");
  const { processAlive, terminateTree } = require("./core/utils");
  const initialJobIds = new Set(listJobIds(TASK_ID));
  const initialRoundIds = new Set((readTask(TASK_ID).rounds || []).map((row) => row.roundId));

  if (OPERATION_REVISION_ONLY) {
    const beforeRevision = readTask(TASK_ID);
    const revisionInput = authorizedOperationRevisionInput();
    const target = (beforeRevision.program?.workPackages || []).find((row) => row.workPackageId === revisionInput.workPackageId);
    assert.ok(target, "Operation revision target was not found in the preserved plan.");
    const priorContext = JSON.stringify(beforeRevision.program.contextDossier);
    const priorNonTargetWorkstreams = beforeRevision.program.masterPlan.workstreams
      .filter((row) => row.id !== target.workstreamId);
    const revision = reviseAuthorizedOperation(beforeRevision, revisionInput);
    const afterRevision = revision.task;
    const revisedTarget = afterRevision.program.workPackages.find((row) => (
      row.workPackageId === revision.workPackageId
    ));
    assert.equal(revision.priorPlanRevision, revisionInput.expectedPlanRevision);
    assert.equal(revision.planRevision, Number(revisionInput.expectedPlanRevision) + 1);
    assert.equal(JSON.stringify(afterRevision.program.contextDossier), priorContext,
      "Operation-only revision changed the accepted context dossier.");
    assert.deepEqual(
      afterRevision.program.masterPlan.workstreams.filter((row) => row.id !== target.workstreamId),
      priorNonTargetWorkstreams,
      "Operation-only revision changed another workstream.",
    );
    assert.deepEqual(revisedTarget.commands, revisionInput.commands,
      "Operation-only revision did not compile the exact confirmed-write command.");
    assert.deepEqual(revisedTarget.verificationCommands, revisionInput.verificationCommands,
      "Operation-only revision did not compile the exact verification command.");
    assert.equal(listJobIds(TASK_ID).filter((jobId) => !initialJobIds.has(jobId)).length, 0,
      "Operation-only revision launched a provider worker.");
    assert.equal(directoryManifest(sourceTaskRoot), productionTaskBefore,
      "Source canary task state changed during operation-only revision.");
    assert.equal(workspaceManifest(sourceTask, "static"), productionWorkspaceBefore,
      "Source project state changed during operation-only revision.");
    successReceipt = {
      ok: true,
      operationRevisionOnly: true,
      taskId: TASK_ID,
      cloneRoot,
      contextRevision: afterRevision.program.contextDossier.contextRevision,
      priorPlanRevision: revision.priorPlanRevision,
      planRevision: revision.planRevision,
      priorWorkPackageId: revision.priorWorkPackageId,
      workPackageId: revision.workPackageId,
      commands: revisedTarget.commands,
      verificationCommands: revisedTarget.verificationCommands,
      providerWorkersLaunched: 0,
      productionStateUnchanged: true,
      workspaceUnchanged: true,
      cloneRetained: KEEP,
    };
    return successReceipt;
  }

  if (CONTRACT_PREFLIGHT_ONLY) {
    const beforeRefresh = readTask(TASK_ID);
    const priorStrategy = (beforeRefresh.program?.workPackages || []).find((row) => row.executorKind === "strategist" && row.state === "pending");
    assert.ok(priorStrategy, "Contract preflight requires one pending strategist.");
    const resources = await inventory({ refresh: true, forDispatch: true, timeoutMs: 30000 });
    const prepared = prepareProgramDispatch(beforeRefresh, resources);
    const currentStrategy = (prepared.program?.workPackages || []).find((row) => row.workPackageId === priorStrategy.workPackageId);
    assert.ok(currentStrategy?.bootstrapContract, "The pending strategist was not rebuilt against the current runtime.");
    assert.notEqual(currentStrategy.bootstrapContract.contractFingerprint, priorStrategy.bootstrapContract?.contractFingerprint,
      "The stale pending strategist contract did not change after the project-manifest contract update.");
    assert.ok((currentStrategy.bootstrapContract.availableSourceFiles || []).length > (priorStrategy.bootstrapContract?.availableSourceFiles || []).length,
      "The rebuilt strategist contract did not gain the real project file manifest.");
    assert.equal(listJobIds(TASK_ID).filter((jobId) => !initialJobIds.has(jobId)).length, 0);
    assert.equal(directoryManifest(sourceTaskRoot), productionTaskBefore, "Production AI Mobile task state changed during contract preflight.");
    assert.equal(workspaceManifest(sourceTask, "static"), productionWorkspaceBefore, "Production project state changed during contract preflight.");
    successReceipt = {
      ok: true,
      contractPreflightOnly: true,
      taskId: TASK_ID,
      startMode: start.mode,
      priorAvailableProjectFiles: (priorStrategy.bootstrapContract?.availableSourceFiles || []).length,
      currentAvailableProjectFiles: (currentStrategy.bootstrapContract.availableSourceFiles || []).length,
      providerWorkersLaunched: 0,
      productionStateUnchanged: true,
      workspaceUnchanged: true,
      cloneRetained: KEEP,
    };
    return successReceipt;
  }

  if (EXECUTION_PREFLIGHT_ONLY) {
    const beforePrepare = readTask(TASK_ID);
    assert.ok(beforePrepare.program?.masterPlan, "Execution preflight requires an accepted Master Plan.");
    assert.ok(["execution", "verification"].includes(beforePrepare.program?.phase), "Execution preflight requires an execution-stage task.");
    const resources = await inventory({ refresh: true, forDispatch: true, timeoutMs: 30000 });
    const prepared = prepareProgramDispatch(beforePrepare, resources);
    const readyUnits = programRecommendedWorkUnits(prepared);
    assert.ok(readyUnits.length > 0, "Execution preflight found no budgeted dependency-ready package: " + prepared.program?.nextAction);
    for (const unit of readyUnits) {
      const admission = disposableCanaryDecision({
        ...unit,
        workspace: prepared.workspace,
        directorProgram: {
          phase: prepared.program.phase,
          workPackageId: unit.workPackageId,
        },
      });
      assert.equal(admission.allowed, true, `Execution preflight rejected ${unit.workPackageId}: ${admission.reason}`);
    }
    assert.equal(listJobIds(TASK_ID).filter((jobId) => !initialJobIds.has(jobId)).length, 0);
    assert.equal(directoryManifest(sourceTaskRoot), productionTaskBefore, "Source canary task state changed during execution preflight.");
    assert.equal(workspaceManifest(sourceTask, "static"), productionWorkspaceBefore, "Source project state changed during execution preflight.");
    successReceipt = {
      ok: true,
      executionPreflightOnly: true,
      taskId: TASK_ID,
      startMode: start.mode,
      readyWorkPackages: readyUnits.map((unit) => ({
        workPackageId: unit.workPackageId,
        executorKind: unit.executorKind,
        provider: unit.allocation?.provider || unit.preferredProvider || "",
        model: unit.allocation?.model || unit.model || "",
        requiredCapabilities: unit.requiredCapabilities,
      })),
      providerWorkersLaunched: 0,
      productionStateUnchanged: true,
      workspaceUnchanged: true,
      cloneRetained: KEEP,
    };
    return successReceipt;
  }

  quiesceCanary = function quiesceCanaryRuntime() {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      const execution = coordinatorStatus({ taskId: TASK_ID }).execution;
      if (execution.active) requestCoordinatorCancel({ taskId: TASK_ID });
      const newJobIds = listJobIds(TASK_ID).filter((jobId) => !initialJobIds.has(jobId));
      let activeJobs = 0;
      for (const jobId of newJobIds) {
        let status;
        try { status = statusFor(TASK_ID, jobId, false); } catch { continue; }
        if (status.pid && processAlive(status.pid)) {
          activeJobs += 1;
          terminateTree(status.pid);
          continue;
        }
        if (["completed", "failed", "cancelled", "rejected"].includes(status.state)) continue;
        activeJobs += 1;
        try { cancelJob(TASK_ID, jobId); } catch { /* retry until the bounded deadline */ }
      }
      if (!coordinatorStatus({ taskId: TASK_ID }).execution.active && activeJobs === 0) return;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
    }
    throw new Error("The disposable canary coordinator or one of its newly launched workers did not quiesce after cancellation.");
  };

    runtimeLaunched = true;
    const supervisorBefore = readTask(TASK_ID).program?.runtime?.programSupervisor || null;
    const publicCampaign = await invoke("run-program-campaign", {
      taskId: TASK_ID,
      maxRounds: 3,
      maxMinutes: 90,
      noProgressLimit: 2,
      horizonHours: 5,
      awaitBoundarySeconds: 30,
    }, entrypoint);
    assert.ok(publicCampaign.executionId, "The public campaign tool did not create one coordinator execution.");
    assert.equal(publicCampaign.reused, false, "A terminal production execution must become one new cloned execution.");
    coordinator = waitForCoordinator(coordinatorStatus, TASK_ID, Date.now() + 91 * 60 * 1000);
    const coordinatorRuns = [coordinator];
    const afterStrategy = readTask(TASK_ID);
    const freshCampaignRounds = (afterStrategy.rounds || []).filter((row) => !initialRoundIds.has(row.roundId));
    const freshIntegratedRounds = freshCampaignRounds.filter((row) => row.state === "integrated");
    assert.ok(freshIntegratedRounds.length > 0,
      "The public campaign must integrate at least one fresh round without a manual coordinator retry.");
    assert.ok(Number(coordinator.roundsStarted || 0) <= 3,
      "No finite coordinator slice may exceed the public three-round cap.");

    const supervisorAfter = afterStrategy.program?.runtime?.programSupervisor || null;
    const recoveryCycles = Math.max(0, Number(supervisorAfter?.supervisorEpoch || 0) - Number(supervisorBefore?.supervisorEpoch || 0));
    assert.equal(recoveryCycles, 1, "The stopped production supervisor must admit exactly one idempotent recovery epoch.");
    const expectedAdmissionIncrease = start.mode === "strategy-resume" ? 0 : 1;
    assert.equal((supervisorAfter?.recoveryAdmissionHistory || []).length,
      Number((supervisorBefore?.recoveryAdmissionHistory || []).length) + expectedAdmissionIncrease,
      start.mode === "strategy-resume"
        ? "A verified runtime-build recovery must not fabricate another read-only admission."
        : "The public path must persist exactly one bounded recovery admission.");
    const newJobRecords = fs.readdirSync(path.join(clonedTaskRoot, "jobs"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !initialJobIds.has(entry.name))
      .map((entry) => {
        const jobRoot = path.join(clonedTaskRoot, "jobs", entry.name);
        return {
          jobId: entry.name,
          contract: readJsonFile(path.join(jobRoot, "contract.json")),
          status: readJsonFile(path.join(jobRoot, "status.json")),
          handoff: readJsonFile(path.join(jobRoot, "handoff.json")),
        };
      })
      .filter((row) => row.contract);
    const newJobContracts = newJobRecords.map((row) => row.contract);
    const newJobExecutorKinds = newJobContracts.map((contract) => contract.executorKind).filter(Boolean).sort();
    if (start.mode === "execution-resume") {
      assert.ok(!newJobExecutorKinds.some((kind) => ["context-scout", "strategist"].includes(kind)),
        "Execution resume repeated context or strategy instead of continuing the accepted plan.");
    }
    for (const contract of newJobContracts) {
      const admission = disposableCanaryDecision(contract);
      assert.equal(admission.allowed, true, `The canary launched work outside its disposable safety policy: ${admission.reason || contract.executorKind}.`);
    }
    for (const kind of new Set(newJobExecutorKinds)) {
      const contracts = newJobContracts.filter((contract) => contract.executorKind === kind);
      assert.ok(contracts.length <= 3, `The canary repeated ${kind} beyond two bounded corrections.`);
      const fingerprints = contracts.map((contract) => contract.contractFingerprint || contract.directorWorkerContract?.fingerprint || "").filter(Boolean);
      assert.equal(new Set(fingerprints).size, fingerprints.length, `The canary repeated an unchanged ${kind} contract.`);
    }
    const stageDiagnostic = {
      phase: afterStrategy.program?.phase || null,
      nextAction: String(afterStrategy.program?.nextAction || "").slice(0, 300) || null,
      recentFailures: (afterStrategy.program?.failureMemory || []).slice(-3).map((row) => ({
        workPackageId: row.workPackageId || null,
        executorKind: row.executorKind || null,
        failureClass: row.failureClass || null,
        blocker: String(row.blocker || row.reason || "").slice(0, 300) || null,
      })),
    };
    const acceptanceLinkedExecutionResults = newJobRecords.filter((row) => (
      row.contract?.directorProgram?.phase === "execution"
      && (
        row.contract?.readOnly === true
        || row.contract?.executorKind === "code-change"
        || row.contract?.executorKind === "operational-transaction"
      )
      && row.status?.state === "completed"
      && row.handoff?.state === "completed"
      && (row.contract?.acceptanceIds || []).length > 0
    ));
    assert.ok(acceptanceLinkedExecutionResults.length > 0,
      "The public canary never produced a real sandbox-safe acceptance-linked execution result: " + JSON.stringify(stageDiagnostic));
    for (const result of acceptanceLinkedExecutionResults) {
      const integratedPackage = (afterStrategy.program?.workPackages || []).find((row) => row.workPackageId === result.contract.directorProgram.workPackageId);
      assert.equal(integratedPackage?.state, "completed", `Execution result ${result.jobId} was not integrated into its fenced work package.`);
      assert.equal(integratedPackage?.jobId, result.jobId);
    }
    if (!afterStrategy.program.contextDossier || !afterStrategy.program.masterPlan) {
      throw new Error("Read-only Director stages did not complete. Coordinator: " + JSON.stringify(coordinator) + "; next: " + afterStrategy.program.nextAction + "; failures: " + JSON.stringify((afterStrategy.program.failureMemory || []).slice(-3)));
    }
    assert.equal(afterStrategy.program.phase, "execution", "Context and strategy must integrate before the safe execution boundary.");
    let reconciliationProof = null;
    if (["reconciliation", "plan-reconciliation", "plan-revision-reconciliation", "post-failure-reconciliation"].includes(start.mode)) {
      const stalled = (afterStrategy.program.workPackages || []).find((row) => row.workPackageId === start.stalledWorkPackageId);
      assert.notEqual(stalled?.state, "running", "The originally stalled reconciliation package remained running.");
      const completed = (afterStrategy.program.workPackages || []).filter((row) => (
        row.executorKind === "reconciliation"
        && row.state === "completed"
        && row.jobId
        && row.jobId !== start.completedJobId
      ));
      assert.ok(completed.length > 0, "No fresh reconciliation completed after rejecting the stale invalid handoff.");
      const failureMemoryGrowth = (afterStrategy.program.failureMemory || []).length - start.initialFailureMemoryLength;
      if (start.mode === "reconciliation") {
        assert.ok(failureMemoryGrowth > 0, "Pre-plan reconciliation recovery did not materially grow failure memory.");
      } else if (start.mode === "plan-reconciliation") {
        assert.ok(Number(afterStrategy.program.contextDossier?.contextRevision || 0) > start.initialContextRevision, "Plan reconciliation did not complete its required full-context refresh.");
        const completedStrategy = (afterStrategy.program.workPackages || []).find((row) => row.executorKind === "strategist" && row.state === "completed" && row.reconciliationDecisionFingerprint);
        assert.ok(completedStrategy?.bootstrapContract?.minimumPlanRevision >= 2, "Plan reconciliation did not launch a revision-fenced strategist.");
        assert.ok(completedStrategy?.bootstrapContract?.reconciliationDirective, "The exact reconciliation directive was lost before strategy.");
      } else if (start.mode === "plan-revision-reconciliation") {
        assert.equal(Number(afterStrategy.program.contextDossier?.contextRevision || 0), start.initialContextRevision, "A first plan-invalid correction unnecessarily spent another context worker.");
        const completedStrategy = (afterStrategy.program.workPackages || []).find((row) => row.executorKind === "strategist" && row.state === "completed" && row.reconciliationDecisionFingerprint);
        assert.ok(completedStrategy?.bootstrapContract?.minimumPlanRevision >= 2, "Direct plan revision did not launch a revision-fenced strategist.");
        assert.ok(completedStrategy?.bootstrapContract?.reconciliationDirective, "The exact reconciliation directive was lost before direct strategy revision.");
      }
      if (start.mode === "post-failure-reconciliation") {
        const settledRound = readRound(TASK_ID, start.staleRoundId);
        assert.equal(settledRound.state, "correction-scheduled", "The stale failed round must be consumed exactly once before replacement work advances.");
        assert.ok(settledRound.settledAt, "The consumed stale round must retain a durable settlement timestamp.");
      }
      reconciliationProof = {
        stalledWorkPackageId: start.stalledWorkPackageId,
        stalledFinalState: stalled?.state || "absent",
        freshCompletedWorkPackageIds: completed.map((row) => row.workPackageId),
        failureMemoryGrowth,
      };
    }
    const databaseProof = databaseIntegrationProof(
      afterStrategy,
      cloneRoot,
      initialJobIds,
      !["strategy-resume", "execution-resume"].includes(start.mode),
    );

    const resources = await inventory({ refresh: true, forDispatch: true, timeoutMs: 30000 });
    assert.ok(Number.isFinite(Number(resources.worktreeStorage && resources.worktreeStorage.freeMb)), "Internal coordinator inventory must carry free disk.");
    const budgeted = prepareProgramDispatch(afterStrategy, resources);
    const ready = programRecommendedWorkUnits(budgeted);
    assert.ok(budgeted.program.runtime && budgeted.program.runtime.budget, "The whole-plan budget was not persisted.");
    assert.ok((budgeted.program.runtime.budget.allocations || []).length > 0, "No acceptance-linked execution package passed the real budget.");
    assert.ok(ready.length > 0, "The Master Plan did not compile a dispatch-ready team package.");
    const plannedPackages = budgeted.program.workPackages || [];
    const unresolvedRequirementIds = clonedTask.requirements.filter((row) => row.required && row.status !== "passing").map((row) => row.id);
    assert.deepEqual([...unresolvedRequirementIds].sort(), Object.keys(expectedExecutors).sort(), "The guarded production requirement set drifted from the exact Job Vibhu executor contract.");
    const compiledExecutionPackages = plannedPackages.filter((row) => !["context-scout", "strategist", "reconciliation"].includes(row.executorKind) && !["superseded", "cancelled"].includes(row.state));
    const forecastIds = new Set((budgeted.program.runtime.forecast?.items || []).filter((row) => !row.synthetic).map((row) => row.workPackageId));
    const allocationIds = new Set((budgeted.program.runtime.budget.allocations || []).map((row) => row.workPackageId));
    const deferredIds = new Set((budgeted.program.runtime.budget.deferred || []).map((row) => row.workPackageId));
    for (const row of compiledExecutionPackages) {
      assert.ok(forecastIds.has(row.workPackageId), `Plan-wide forecast omitted ${row.workPackageId}.`);
      assert.notEqual(allocationIds.has(row.workPackageId), deferredIds.has(row.workPackageId), `Budget must account for ${row.workPackageId} exactly once as allocated or deferred.`);
    }
    const exactRequirementPackages = Object.fromEntries(unresolvedRequirementIds.map((requirementId) => [
      requirementId,
      plannedPackages.filter((row) => (row.acceptanceIds || []).includes(requirementId)),
    ]));
    for (const requirementId of unresolvedRequirementIds) {
      assert.ok(exactRequirementPackages[requirementId].length, `Master Plan omitted exact work-package ownership for ${requirementId}.`);
      const allowedExecutors = expectedExecutors[requirementId] || [];
      if (allowedExecutors.length) {
        assert.ok(exactRequirementPackages[requirementId].some((row) => allowedExecutors.includes(row.executorKind)), `${requirementId} has no workstream using an expected executor: ${allowedExecutors.join(", ")}.`);
      }
      assert.ok(exactRequirementPackages[requirementId].some((row) => allocationIds.has(row.workPackageId) || deferredIds.has(row.workPackageId)), `${requirementId} has no plan-wide budget disposition.`);
    }

    const captured = [];
    const finalRoute = dispatchRound({ taskId: TASK_ID, horizonHours: 5 }, resources, providerHistory(), (contract) => {
      captured.push(contract);
      throw new Error("release-canary-captured-before-execution");
    });
    assert.ok(captured.length > 0, "No package reached the final provider route: " + JSON.stringify(finalRoute.rejected));
    assert.ok(captured.every((contract) => contract.directorProgram && contract.workGraphNodeId), "Captured work was not fenced to the Director plan.");
    assert.ok(captured.every((contract) => contract.directorProgram.phase === "execution"), "Canary did not reach a plan-derived execution-phase package.");
    assert.ok(captured.every((contract) => !["context-1-1", "strategy-1-1"].includes(contract.directorProgram.workPackageId)), "Canary recaptured a bootstrap package instead of plan-derived work.");
    assert.ok((finalRoute.workers || []).length === 0, "The release canary must not launch execution workers.");

    const cloneWorktrees = path.join(cloneRoot, "worktrees");
    assert.ok(!fs.existsSync(cloneWorktrees) || fs.readdirSync(cloneWorktrees).length === 0, "The canary left a disposable worker worktree behind.");
    const dynamicWorkspaceAfter = workspaceManifest(sourceTask, "dynamic");
    const sandboxWorkspaceAfter = [
      workspaceManifest(clonedTask, "static"),
      workspaceManifest(clonedTask, "dynamic"),
    ].join(":");

    successReceipt = {
      ok: true,
      taskId: TASK_ID,
      startMode: start.mode,
      cloneRoot,
      coordinator,
      coordinatorRuns,
      freshIntegratedRoundCount: freshIntegratedRounds.length,
      recoveryCycles,
      boundedWorkerExecutors: newJobExecutorKinds,
      reconciliationProof,
      databaseIntegrationProof: databaseProof,
      contextRevision: afterStrategy.program.contextDossier.contextRevision,
      planRevision: afterStrategy.program.masterPlan.planRevision,
      milestones: afterStrategy.program.masterPlan.milestones.length,
      workstreams: afterStrategy.program.masterPlan.workstreams.length,
      budgetAllocations: budgeted.program.runtime.budget.allocations.length,
      exactRequirementWorkstreams: Object.fromEntries(Object.entries(exactRequirementPackages).map(([requirementId, packages]) => [
        requirementId,
        packages.map((row) => ({ workPackageId: row.workPackageId, executorKind: row.executorKind })),
      ])),
      acceptanceLinkedExecutionResults: acceptanceLinkedExecutionResults.map((row) => ({
        jobId: row.jobId,
        workPackageId: row.contract.directorProgram.workPackageId,
        executorKind: row.contract.executorKind,
        acceptanceIds: row.contract.acceptanceIds,
        handoffFingerprint: row.handoff.fingerprint || row.handoff.contractFingerprint || "",
      })),      capturedExecutionPackages: captured.map((contract) => ({
        workGraphNodeId: contract.workGraphNodeId,
        provider: contract.provider,
        model: contract.model,
        executorKind: contract.executorKind,
        deliverableKind: contract.deliverableKind,
      })),
      productionStateUnchanged: true,
      workspaceUnchanged: true,
      sandboxWorkspaceChanged: sandboxWorkspaceAfter !== sandboxWorkspaceBefore,
      liveRuntimeSourcesChangedDuringCanary: dynamicWorkspaceAfter !== dynamicWorkspaceBefore,
    };
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    const finalizationErrors = [];
    let quiesced = !runtimeLaunched;
    if (runtimeLaunched && quiesceCanary) {
      try {
        quiesceCanary();
        quiesced = true;
      } catch (error) {
        finalizationErrors.push(error);
      }
    }
    try {
      assert.equal(directoryManifest(sourceTaskRoot), productionTaskBefore, "Production AI Mobile task state changed during the clone canary.");
    } catch (error) {
      finalizationErrors.push(error);
    }
    if (sourceTask && productionWorkspaceBefore) {
      try {
        assert.equal(workspaceManifest(sourceTask, "static"), productionWorkspaceBefore, "Production project state changed during the disposable clone canary.");
      } catch (error) {
        finalizationErrors.push(error);
      }
    }
    if (!KEEP && quiesced && !primaryError) {
      try { fs.rmSync(cloneRoot, { recursive: true, force: true }); }
      catch (error) { finalizationErrors.push(error); }
    } else {
      process.stderr.write("Preserved cloned canary state at " + cloneRoot + "\n");
    }
    if (successReceipt && finalizationErrors.length === 0) process.stdout.write(JSON.stringify(successReceipt, null, 2) + "\n");
    if (finalizationErrors.length > 0) {
      const finalizationError = new Error("Canary finalization failed: " + finalizationErrors.map((error) => error.message).join(" | "));
      if (primaryError) process.stderr.write(finalizationError.message + "\n");
      else throw finalizationError;
    }
  }
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write((error.stack || error.message) + "\n");
    process.exitCode = 1;
  });
}

module.exports = {
  activePackages,
  classifyCanaryStart,
  cloneProjectWorkspace,
  databaseIntegrationProof,
};
