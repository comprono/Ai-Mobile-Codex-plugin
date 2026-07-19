"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { setStatus, statusFor } = require("./job-store");
const { jobDirectory, readTask, safeId, updatePortfolio, updateTask } = require("./state-store");
const { bounded, isInside, readJson, safeRelativePath, utcNow, writeJson } = require("./utils");
const { validateCommands } = require("./verification");

const TASK_KINDS = new Set(["architecture", "browser", "code", "debug", "docs", "generic", "live-state", "repository-scan", "research", "review", "tests"]);

function artifactFingerprint(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value || {})).digest("hex").slice(0, 24);
}

function uniqueNodeId(nodes, sourceId, index) {
  const base = `${sourceId}-implementation-${index + 1}`.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 72);
  const used = new Set(nodes.map((row) => row.id));
  if (!used.has(base)) return base;
  for (let suffix = 2; suffix < 100; suffix += 1) {
    const candidate = `${base}-${suffix}`.slice(0, 80);
    if (!used.has(candidate)) return candidate;
  }
  throw new Error("Unable to allocate a unique observation-derived work node id.");
}

function invalidPlanPath(message) {
  const error = new Error(message);
  error.code = "STRUCTURED_WORK_PLAN_PATH_INVALID";
  throw error;
}

function assertExistingWorkspacePath(workspace, relative, label) {
  const absolute = path.resolve(workspace, relative);
  if (!fs.existsSync(absolute)) invalidPlanPath(`${label} does not exist in the workspace: ${relative}`);
  const realWorkspace = fs.realpathSync(workspace);
  const realCandidate = fs.realpathSync(absolute);
  if (!isInside(realWorkspace, realCandidate)) invalidPlanPath(`${label} resolves outside the workspace: ${relative}`);
}

function assertExpectedWorkspacePath(workspace, relative) {
  const absolute = path.resolve(workspace, relative);
  if (fs.existsSync(absolute)) {
    if (fs.statSync(absolute).isDirectory()) {
      invalidPlanPath(`expectedFiles must name a file, not a directory: ${relative}`);
    }
    const realWorkspace = fs.realpathSync(workspace);
    const realCandidate = fs.realpathSync(absolute);
    if (!isInside(realWorkspace, realCandidate)) invalidPlanPath(`expectedFiles resolves outside the workspace: ${relative}`);
    return;
  }
  const parent = path.dirname(absolute);
  if (!fs.existsSync(parent) || !fs.statSync(parent).isDirectory()) invalidPlanPath(`expectedFiles parent directory does not exist: ${relative}`);
  const realWorkspace = fs.realpathSync(workspace);
  const realParent = fs.realpathSync(parent);
  if (!isInside(realWorkspace, realParent)) invalidPlanPath(`expectedFiles resolves through a parent outside the workspace: ${relative}`);
}

function looksLikeProjectReference(value) {
  const reference = String(value || "").split("::", 1)[0].trim();
  if (!reference || /^https?:/i.test(reference) || /[?*\[\]]/.test(reference)) return false;
  return reference === "." || /[\\/]/.test(reference) || /\.(?:[cm]?[jt]sx?|py|ps1|rb|php|go|rs|java|cs|fs|sh|bat|cmd)$/i.test(reference);
}

function verificationFileReferences(command) {
  const executable = path.basename(String(command.command || "")).toLowerCase();
  const args = command.args || [];
  if (/^node(?:\.exe)?$/.test(executable)) {
    return args.filter((arg) => !String(arg).startsWith("-") && looksLikeProjectReference(arg)).slice(0, 1);
  }
  if (/^(?:python|python3|py)(?:\.exe)?$/.test(executable)) {
    if (String(args[0] || "").toLowerCase() === "-m") return [];
    return args.filter((arg) => !String(arg).startsWith("-") && looksLikeProjectReference(arg)).slice(0, 1);
  }
  if (/^pytest(?:\.exe)?$/.test(executable)) {
    return args.filter((arg) => !String(arg).startsWith("-") && looksLikeProjectReference(arg));
  }
  return [];
}

function validateWorkspacePaths(task, rawRelevantFiles, expectedFiles, commands, index) {
  const expected = new Set(expectedFiles);
  for (const file of expectedFiles) assertExpectedWorkspacePath(task.workspace, file);
  for (const file of rawRelevantFiles) {
    if (expected.has(file)) assertExpectedWorkspacePath(task.workspace, file);
    else assertExistingWorkspacePath(task.workspace, file, `proposedWorkUnits[${index}].relevantFiles`);
  }
  for (const command of commands) {
    for (const rawReference of verificationFileReferences(command)) {
      const reference = String(rawReference || "").split("::", 1)[0].trim();
      if (!reference || reference === ".") continue;
      const relative = safeRelativePath(task.workspace, reference);
      if (expected.has(relative)) assertExpectedWorkspacePath(task.workspace, relative);
      else assertExistingWorkspacePath(task.workspace, relative, `proposedWorkUnits[${index}].verificationCommands`);
    }
  }
}

function normalizeUnit(task, sourceNode, row, index, currentNodes) {
  const goal = String(row?.goal || "").trim().slice(0, 2000);
  if (!goal) throw new Error(`proposedWorkUnits[${index}] requires a bounded goal.`);
  const expectedFiles = [...new Set((Array.isArray(row?.expectedFiles) ? row.expectedFiles : [])
    .map((value) => safeRelativePath(task.workspace, value))
    .filter((value) => value && value !== "."))].slice(0, 40);
  if (!expectedFiles.length) throw new Error(`proposedWorkUnits[${index}] requires exact expectedFiles; repository-root ownership is refused.`);
  const declaredRelevantFiles = [...new Set((Array.isArray(row?.relevantFiles) ? row.relevantFiles : [])
    .map((value) => safeRelativePath(task.workspace, value))
    .filter((value) => value && value !== "."))].slice(0, 60);
  const relevantFiles = [...new Set([...declaredRelevantFiles, ...expectedFiles])].slice(0, 60);
  const validation = validateCommands(task.workspace, row?.verificationCommands);
  if (!validation.valid) {
    throw new Error(`proposedWorkUnits[${index}] requires allowlisted deterministic verification: ${validation.errors.join("; ") || "no command supplied"}`);
  }
  const acceptanceCriteria = [...new Set((Array.isArray(row?.acceptanceCriteria) ? row.acceptanceCriteria : [])
    .map((value) => String(value || "").trim().slice(0, 1000))
    .filter(Boolean))].slice(0, 12);
  if (!acceptanceCriteria.length) throw new Error(`proposedWorkUnits[${index}] requires observable acceptanceCriteria.`);
  validateWorkspacePaths(task, declaredRelevantFiles, expectedFiles, validation.commands, index);
  return {
    id: uniqueNodeId(currentNodes, sourceNode.id, index),
    goal,
    dependsOn: [sourceNode.id],
    priority: Math.max(1, Math.min(100, Number(row?.priority || sourceNode.priority || 80) - index)),
    state: "pending",
    owner: null,
    evidenceRefs: [],
    acceptanceRequirementId: sourceNode.acceptanceRequirementId,
    relevantFiles,
    expectedFiles,
    acceptanceCriteria,
    verificationCommands: validation.commands,
    taskKind: TASK_KINDS.has(row?.taskKind) ? row.taskKind : "code",
    complexity: ["small", "medium", "large"].includes(row?.complexity) ? row.complexity : "medium",
    readOnly: false,
    requiredCapabilities: [...new Set((Array.isArray(row?.requiredCapabilities) ? row.requiredCapabilities : []).map((value) => String(value || "").trim().toLowerCase()).filter(Boolean))].slice(0, 12),
    sourceObservationJobId: String(row?.sourceObservationJobId || ""),
  };
}

function synchronizePortfolio(contract, task) {
  if (!contract.portfolioId || !contract.projectId) return;
  updatePortfolio(contract.portfolioId, (portfolio) => {
    portfolio.projects = (portfolio.projects || []).map((project) => project.projectId === contract.projectId
      ? { ...project, requirements: task.requirements, workGraph: task.workGraph, blockers: task.blockers || project.blockers || [] }
      : project);
    return portfolio;
  });
}

function acceptObservationJob(taskIdValue, jobIdValue) {
  const taskId = safeId(taskIdValue, "task");
  const jobId = safeId(jobIdValue, "job");
  const dir = jobDirectory(taskId, jobId);
  const status = statusFor(taskId, jobId);
  const contract = readJson(path.join(dir, "contract.json"), null);
  const handoff = readJson(path.join(dir, "handoff.json"), null);
  const existing = readJson(path.join(dir, "observation-evidence.json"), null);
  if (existing?.accepted === true || existing?.blocked === true || existing?.rejected === true) return { ...existing, alreadyEvaluated: true };
  if (!contract || contract.readOnly !== true) return { taskId, jobId, accepted: false, blocker: "observation-contract-missing-or-not-read-only" };
  if (status.state !== "completed") return { taskId, jobId, accepted: false, blocker: `worker-not-completed: ${status.state}` };
  if (contract.artifactKind !== "work-plan") return { taskId, jobId, accepted: false, blocker: "read-only-worker-result-requires-explicit-artifact-kind" };
  const artifact = handoff?.artifact;
  if (!artifact || artifact.kind !== "work-plan") return { taskId, jobId, accepted: false, blocker: "structured-work-plan-missing" };
  const fingerprint = handoff.artifactFingerprint || artifactFingerprint(artifact);
  const task = readTask(taskId);
  if ((task.observationFingerprints || []).includes(fingerprint)) {
    const duplicate = { taskId, jobId, accepted: true, unchanged: true, fingerprint, generatedAt: utcNow() };
    writeJson(path.join(dir, "observation-evidence.json"), duplicate);
    setStatus(taskId, jobId, { observationAcceptedAt: duplicate.generatedAt, integrationState: "observation-unchanged" });
    return duplicate;
  }
  const sourceNode = (task.workGraph || []).find((row) => row.id === contract.workGraphNodeId);
  if (!sourceNode) return { taskId, jobId, accepted: false, blocker: "observation-work-graph-node-missing" };
  const proposed = Array.isArray(artifact.proposedWorkUnits) ? artifact.proposedWorkUnits.slice(0, 3) : [];
  const blockerText = String(artifact.blocker || "").trim().slice(0, 1200);
  if (!proposed.length && !blockerText) return { taskId, jobId, accepted: false, blocker: "structured-work-plan-has-no-bounded-units-or-blocker" };

  let createdNodes = [];
  let updated;
  try {
    updated = updateTask(taskId, (current) => {
      if ((current.observationFingerprints || []).includes(fingerprint)) return current;
      const currentSource = (current.workGraph || []).find((row) => row.id === sourceNode.id);
      if (!currentSource) throw new Error("Observation source node disappeared during acceptance.");
      createdNodes = proposed.map((row, index) => normalizeUnit(current, currentSource, { ...row, sourceObservationJobId: jobId }, index, [...(current.workGraph || []), ...createdNodes]));
      const observationRef = `ai-mobile-observation:${jobId}:${fingerprint}`;
      current.observationFingerprints = [...(current.observationFingerprints || []), fingerprint].slice(-100);
      current.workGraph = (current.workGraph || []).map((node) => node.id === currentSource.id
        ? {
            ...node,
            state: blockerText && !createdNodes.length ? "blocked" : "completed",
            owner: null,
            evidenceRefs: [...(node.evidenceRefs || []), observationRef].slice(-10),
            observationFingerprint: fingerprint,
            observationSummary: bounded(artifact.summary || handoff.summary, 1200),
          }
        : node);
      current.workGraph.push(...createdNodes);
      current.evidence = [...(current.evidence || []), {
        requirementId: currentSource.acceptanceRequirementId,
        level: "activity",
        ref: observationRef,
        summary: createdNodes.length
          ? `Bounded observation produced ${createdNodes.length} exact implementation unit(s); this is planning evidence, not acceptance completion.`
          : `Bounded observation recorded blocker: ${blockerText}`,
        verifiedAt: utcNow(),
      }].slice(-50);
      if (blockerText && !createdNodes.length) {
        const requirement = (current.requirements || []).find((row) => row.id === currentSource.acceptanceRequirementId);
        if (requirement) {
          requirement.status = "blocked";
          requirement.blocker = {
            owner: String(artifact.blockerOwner || "user-or-project").slice(0, 160),
            reason: blockerText,
            recoveryTrigger: String(artifact.recoveryTrigger || "Authoritative project state changes.").slice(0, 800),
            recoveryAction: String(artifact.recoveryAction || "Resolve the recorded blocker, then reconcile this task once.").slice(0, 1200),
          };
        }
      }
      return current;
    });
  } catch (error) {
    const blocker = error.code === "STRUCTURED_WORK_PLAN_PATH_INVALID"
      ? `structured-work-plan-path-invalid: ${bounded(error.message, 800)}`
      : `invalid-structured-work-plan: ${bounded(error.message, 800)}`;
    const rejected = { taskId, jobId, accepted: false, blocked: false, rejected: true, fingerprint, blocker, generatedAt: utcNow() };
    writeJson(path.join(dir, "observation-evidence.json"), rejected);
    setStatus(taskId, jobId, { observationRejectedAt: rejected.generatedAt, integrationState: "observation-rejected" });
    return rejected;
  }
  synchronizePortfolio(contract, updated);
  const evidence = {
    taskId,
    jobId,
    accepted: createdNodes.length > 0,
    blocked: createdNodes.length === 0 && Boolean(blockerText),
    fingerprint,
    summary: bounded(artifact.summary || handoff.summary, 1200),
    createdWorkGraphNodeIds: createdNodes.map((row) => row.id),
    blocker: blockerText,
    generatedAt: utcNow(),
  };
  writeJson(path.join(dir, "observation-evidence.json"), evidence);
  setStatus(taskId, jobId, { observationAcceptedAt: evidence.generatedAt, integrationState: evidence.accepted ? "observation-accepted" : "observation-blocked" });
  return evidence;
}

module.exports = { acceptObservationJob, artifactFingerprint };