"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { setStatus, statusFor } = require("./job-store");
const { jobDirectory, readTask, safeId, updatePortfolio, updateTask } = require("./state-store");
const { bounded, readJson, safeRelativePath, utcNow, writeJson } = require("./utils");
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

function normalizeUnit(task, sourceNode, row, index, currentNodes) {
  const goal = String(row?.goal || "").trim().slice(0, 2000);
  if (!goal) throw new Error(`proposedWorkUnits[${index}] requires a bounded goal.`);
  const expectedFiles = [...new Set((Array.isArray(row?.expectedFiles) ? row.expectedFiles : [])
    .map((value) => safeRelativePath(task.workspace, value))
    .filter((value) => value && value !== "."))].slice(0, 40);
  if (!expectedFiles.length) throw new Error(`proposedWorkUnits[${index}] requires exact expectedFiles; repository-root ownership is refused.`);
  const relevantFiles = [...new Set([...(Array.isArray(row?.relevantFiles) ? row.relevantFiles : []), ...expectedFiles]
    .map((value) => safeRelativePath(task.workspace, value))
    .filter((value) => value && value !== "."))].slice(0, 60);
  const validation = validateCommands(task.workspace, row?.verificationCommands);
  if (!validation.valid) {
    throw new Error(`proposedWorkUnits[${index}] requires allowlisted deterministic verification: ${validation.errors.join("; ") || "no command supplied"}`);
  }
  const acceptanceCriteria = [...new Set((Array.isArray(row?.acceptanceCriteria) ? row.acceptanceCriteria : [])
    .map((value) => String(value || "").trim().slice(0, 1000))
    .filter(Boolean))].slice(0, 12);
  if (!acceptanceCriteria.length) throw new Error(`proposedWorkUnits[${index}] requires observable acceptanceCriteria.`);
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
  if (existing?.accepted === true || existing?.blocked === true) return { ...existing, alreadyAccepted: true };
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
    return { taskId, jobId, accepted: false, blocker: `invalid-structured-work-plan: ${bounded(error.message, 800)}` };
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