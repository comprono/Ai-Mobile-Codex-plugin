"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { boundedList, safeWorkspace } = require("./utils");

const EVIDENCE_LEVELS = new Set(["activity", "process-health", "focused-test", "integration", "end-to-end", "user-visible"]);
const METHOD_TERMS = /\b(review|inspect|inspection|analyse|analyze|analysis|audit|diagnose|diagnostic|investigate|investigation|plan|planning|monitor|monitoring|report|scan|assessment|research)\b/i;
const OPERATIONAL_TERMS = /\b(restore|repair|fix|finish|complete|ship|implement|build|deliver|improve|resume|restart|apply|submit|deploy|publish|achieve|enable|make\s+\S+\s+capable|keep\s+\S+\s+running)\b/i;

function readBounded(file, maximumBytes) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > maximumBytes) return "";
    return fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
  } catch {
    return "";
  }
}

function readJsonBounded(file, maximumBytes) {
  const text = readBounded(file, maximumBytes);
  if (!text) return null;
  try { return JSON.parse(text); }
  catch { return null; }
}

function markdownSection(markdown, heading) {
  const lines = String(markdown || "").split(/\r?\n/);
  const target = String(heading || "").trim().toLowerCase();
  let collecting = false;
  const output = [];
  for (const line of lines) {
    const match = line.match(/^##\s+(.+?)\s*$/);
    if (match) {
      if (collecting) break;
      collecting = match[1].trim().toLowerCase() === target;
      continue;
    }
    if (collecting) output.push(line);
  }
  return output.join("\n").trim();
}

function compactSection(value, maximum = 6000) {
  return String(value || "")
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^[-*]\s+/, ""))
    .filter(Boolean)
    .join(" ")
    .slice(0, maximum);
}

function safeId(value, fallback) {
  return String(value || fallback || "A1")
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80) || fallback || "A1";
}

function normalizeEvidence(value) {
  const level = EVIDENCE_LEVELS.has(value?.level) ? value.level : "";
  const ref = String(value?.ref || "").trim().slice(0, 1000);
  const summary = String(value?.summary || "").trim().slice(0, 1200);
  if (!level || !ref || !summary) return null;
  return {
    level,
    ref,
    summary,
    verifiedAt: value.verifiedAt || value.verified_utc || null,
    imported: true,
  };
}

function normalizeBlocker(value) {
  if (!value || typeof value !== "object") return null;
  const reason = String(value.reason || value.description || "").trim().slice(0, 1200);
  const recoveryAction = String(value.recovery_action || value.recoveryAction || "").trim().slice(0, 1200);
  if (!reason && !recoveryAction) return null;
  return {
    owner: String(value.owner || "current-codex").trim().slice(0, 160),
    reason,
    recoveryTrigger: String(value.recovery_trigger || value.recoveryTrigger || "New authoritative evidence changes the blocker.").trim().slice(0, 800),
    recoveryAction: recoveryAction || "Inspect the authoritative blocker and continue with the smallest safe recovery action.",
  };
}

function normalizeRequirement(value, index, defaultLevel = "end-to-end") {
  const row = typeof value === "string" ? { description: value } : value || {};
  const description = String(row.description || "").trim().slice(0, 1200);
  if (!description) return null;
  const minimumEvidenceLevel = EVIDENCE_LEVELS.has(row.minimumEvidenceLevel)
    ? row.minimumEvidenceLevel
    : EVIDENCE_LEVELS.has(row.minimum_evidence_level)
      ? row.minimum_evidence_level
      : defaultLevel;
  const evidence = (Array.isArray(row.evidence) ? row.evidence : []).map(normalizeEvidence).filter(Boolean).slice(-10);
  const sourceStatus = ["passing", "failing", "blocked"].includes(row.status) ? row.status : "failing";
  const passing = sourceStatus === "passing" && evidence.length > 0;
  return {
    id: safeId(row.id, "A" + (index + 1)),
    description,
    required: row.required !== false,
    status: passing ? "passing" : sourceStatus === "blocked" ? "blocked" : "failing",
    minimumEvidenceLevel,
    evidence: passing ? evidence : [],
    sourceStatus,
    imported: true,
    blocker: sourceStatus === "blocked" ? normalizeBlocker(row.blocker) : null,
  };
}

function normalizeManifestGraph(values) {
  return (Array.isArray(values) ? values : []).slice(0, 100).map((row, index) => ({
    id: safeId(row?.id, "W" + (index + 1)),
    goal: String(row?.goal || "").trim().slice(0, 2000),
    dependsOn: boundedList(row?.dependsOn, 20, 80),
    priority: Math.max(1, Math.min(100, Number(row?.priority || 50))),
    state: ["pending", "running", "awaiting-evidence", "completed", "blocked"].includes(row?.state) ? row.state : "pending",
    acceptanceRequirementId: row?.acceptanceRequirementId ? safeId(row.acceptanceRequirementId) : null,
  })).filter((row) => row.goal);
}

function normalizeDiagnostics(values) {
  return (Array.isArray(values) ? values : []).slice(0, 12).map((row, index) => ({
    name: String(row?.name || "diagnostic-" + (index + 1)).trim().slice(0, 100),
    command: String(row?.command || "").trim().slice(0, 260),
    args: boundedList(row?.args, 30, 500),
    purpose: String(row?.purpose || "").trim().slice(0, 600),
  })).filter((row) => row.command);
}

function discoverProjectContext(workspaceValue) {
  const workspace = safeWorkspace(workspaceValue);
  const outcomeFile = path.join(workspace, ".codex", "PROJECT_OUTCOME.md");
  const acceptanceFile = path.join(workspace, ".codex", "ACCEPTANCE.json");
  const manifestFiles = [
    path.join(workspace, ".ai-mobile", "project.json"),
    path.join(workspace, ".ai-mobile.json"),
  ];
  const outcomeMarkdown = readBounded(outcomeFile, 128 * 1024);
  const acceptance = readJsonBounded(acceptanceFile, 512 * 1024);
  const manifestFile = manifestFiles.find((file) => fs.existsSync(file)) || "";
  const manifest = manifestFile ? readJsonBounded(manifestFile, 256 * 1024) : null;
  const northStar = compactSection(markdownSection(outcomeMarkdown, "North Star"));
  const userIntent = compactSection(markdownSection(outcomeMarkdown, "User Intent"), 3000);
  const projectOutcome = northStar || String(manifest?.outcome || "").trim().slice(0, 6000);
  const acceptanceValues = Array.isArray(acceptance?.requirements) && acceptance.requirements.length
    ? acceptance.requirements
    : Array.isArray(manifest?.acceptanceEvidence)
      ? manifest.acceptanceEvidence
      : [];
  const requirements = acceptanceValues.map((row, index) => normalizeRequirement(row, index)).filter(Boolean);
  const manifestGraph = normalizeManifestGraph(manifest?.workGraph);
  const sources = [];
  if (outcomeMarkdown) sources.push(".codex/PROJECT_OUTCOME.md");
  if (acceptance) sources.push(".codex/ACCEPTANCE.json");
  if (manifest) sources.push(path.relative(workspace, manifestFile).replace(/\\/g, "/"));
  return {
    workspace,
    projectOutcome,
    userIntent,
    projectState: String(acceptance?.project_state || "").trim(),
    currentSliceRequirementId: String(acceptance?.current_slice_requirement_id || "").trim(),
    requirements,
    workGraph: manifestGraph,
    diagnostics: normalizeDiagnostics(manifest?.diagnostics),
    sources,
  };
}

function methodOnly(value) {
  const text = String(value || "").trim();
  return Boolean(text && METHOD_TERMS.test(text) && !OPERATIONAL_TERMS.test(text));
}

function resolveOutcome(args, context) {
  const requestedOutcome = String(args?.outcome || "").trim().slice(0, 6000);
  const latestUserRequest = String(args?.userRequest || args?.latestUserRequest || "").trim().slice(0, 6000);
  const projectOutcome = String(context?.projectOutcome || "").trim().slice(0, 6000);
  const authority = String(args?.outcomeAuthority || "auto").trim().toLowerCase();
  if (!["auto", "user"].includes(authority)) throw new Error("outcomeAuthority must be auto or user.");
  if (authority === "user" && !requestedOutcome) throw new Error("outcomeAuthority user requires an explicit outcome.");

  if (!requestedOutcome && projectOutcome) {
    return {
      requestedOutcome: "",
      resolvedOutcome: projectOutcome,
      changed: true,
      source: "project-contract",
      reason: "No final outcome was supplied, so AI Mobile recovered the bounded project north star.",
      latestUserRequest,
      projectOutcome,
    };
  }
  if (!requestedOutcome) throw new Error("No outcome was supplied and no bounded project outcome was discoverable.");

  const explicitMethodDeliverable = methodOnly(latestUserRequest);
  const narrowMethod = methodOnly(requestedOutcome);
  const operationalProject = projectOutcome && !methodOnly(projectOutcome);
  if (authority !== "user" && narrowMethod && operationalProject && !explicitMethodDeliverable) {
    return {
      requestedOutcome,
      resolvedOutcome: projectOutcome,
      changed: true,
      source: "project-contract",
      reason: "The supplied outcome is a diagnostic method, while the project contract defines a broader operational outcome.",
      latestUserRequest,
      projectOutcome,
    };
  }
  return {
    requestedOutcome,
    resolvedOutcome: requestedOutcome,
    changed: false,
    source: authority === "user" || explicitMethodDeliverable ? "latest-user-request" : "supplied-outcome",
    reason: explicitMethodDeliverable
      ? "The latest user request explicitly makes the diagnostic artifact the final deliverable."
      : "The supplied outcome does not conflict with the bounded project contract.",
    latestUserRequest,
    projectOutcome,
  };
}

function defaultWorkGraph(requirements, currentSliceRequirementId = "") {
  return (requirements || [])
    .filter((row) => row.required !== false && row.status !== "passing")
    .map((row, index) => ({
      id: "R-" + safeId(row.id, "A" + (index + 1)),
      goal: "Satisfy " + row.id + ": " + row.description,
      dependsOn: [],
      priority: row.id === currentSliceRequirementId ? 100 : Math.max(1, 90 - index),
      state: row.status === "blocked" ? "blocked" : "pending",
      owner: null,
      evidenceRefs: [],
      acceptanceRequirementId: row.id,
    }));
}

function criticalPath(requirements, workGraph) {
  const graph = Array.isArray(workGraph) ? workGraph : [];
  const completed = new Set(graph.filter((row) => row.state === "completed").map((row) => row.id));
  const awaitingEvidence = graph
    .filter((row) => row.state === "awaiting-evidence")
    .sort((left, right) => Number(right.priority || 50) - Number(left.priority || 50))[0];
  const ready = awaitingEvidence || graph
    .filter((row) => row.state === "pending" && (row.dependsOn || []).every((id) => completed.has(id)))
    .sort((left, right) => Number(right.priority || 50) - Number(left.priority || 50))[0];
  const requirement = ready
    ? (requirements || []).find((row) => row.id === ready.acceptanceRequirementId)
    : (requirements || []).find((row) => row.required !== false && row.status !== "passing" && row.status !== "blocked");
  if (!ready && !requirement) {
    const blocked = (requirements || []).find((row) => row.required !== false && row.status === "blocked");
    return blocked ? {
      state: "blocked",
      requirementId: blocked.id,
      goal: "Recover blocked acceptance " + blocked.id + ": " + blocked.description,
      acceptanceCriteria: [blocked.description],
      reason: "No dependency-ready acceptance item exists until the recorded blocker changes.",
    } : {
      state: "verification",
      requirementId: null,
      goal: "Run final project acceptance verification.",
      acceptanceCriteria: [],
      reason: "All recorded requirements currently pass.",
    };
  }
  return {
    state: ready?.state === "awaiting-evidence" ? "awaiting-evidence" : "ready",
    requirementId: requirement?.id || ready?.acceptanceRequirementId || null,
    workGraphNodeId: ready?.id || null,
    goal: ready?.state === "awaiting-evidence"
      ? "Integrate and verify " + (requirement?.id || ready.acceptanceRequirementId || ready.id) + ": " + (requirement?.description || ready.goal)
      : ready?.goal || "Satisfy " + requirement.id + ": " + requirement.description,
    acceptanceCriteria: requirement ? [requirement.description] : [],
    reason: ready?.state === "awaiting-evidence"
      ? "A completed worker handoff must be integrated and verified before more work is delegated."
      : "Highest-priority dependency-ready unresolved acceptance item.",
  };
}

function compactProjectContext(context) {
  return {
    sources: context.sources,
    projectOutcome: context.projectOutcome,
    userIntent: context.userIntent,
    projectState: context.projectState,
    currentSliceRequirementId: context.currentSliceRequirementId,
    acceptance: {
      required: context.requirements.filter((row) => row.required !== false).length,
      passing: context.requirements.filter((row) => row.required !== false && row.status === "passing").length,
      blocked: context.requirements.filter((row) => row.required !== false && row.status === "blocked").length,
    },
    diagnostics: context.diagnostics,
  };
}

module.exports = {
  compactProjectContext,
  criticalPath,
  defaultWorkGraph,
  discoverProjectContext,
  methodOnly,
  normalizeRequirement,
  resolveOutcome,
  safeId,
};
