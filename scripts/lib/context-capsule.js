"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const MAX_ITEMS = 12;
const MAX_LIST = 20;
const MAX_TEXT = 1600;

function boundedText(value, max = MAX_TEXT) {
  return String(value || "").trim().slice(0, max);
}

function boundedList(values, max = MAX_LIST, itemMax = 500) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => boundedText(value, itemMax))
    .filter(Boolean))].slice(0, max);
}

function safeRelativePath(workspace, value) {
  const raw = boundedText(value, 500);
  if (!raw) return "";
  const resolved = path.resolve(workspace, raw);
  const relative = path.relative(workspace, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return "";
  return relative || ".";
}

function fileEvidence(workspace, value) {
  const relativePath = safeRelativePath(workspace, value);
  if (!relativePath) return null;
  const absolutePath = path.resolve(workspace, relativePath);
  try {
    const stat = fs.statSync(absolutePath);
    const evidence = {
      path: relativePath.replace(/\\/g, "/"),
      type: stat.isDirectory() ? "directory" : stat.isFile() ? "file" : "other",
      bytes: stat.isFile() ? stat.size : null,
      modifiedAt: stat.mtime.toISOString(),
    };
    if (stat.isFile() && stat.size <= 1024 * 1024) {
      evidence.sha256 = crypto.createHash("sha256").update(fs.readFileSync(absolutePath)).digest("hex").slice(0, 20);
    }
    return evidence;
  } catch {
    return { path: relativePath.replace(/\\/g, "/"), type: "missing", bytes: null, modifiedAt: "" };
  }
}

function canonicalHash(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 24);
}

function buildProjectMap(workspace) {
  const ignored = new Set([".git", ".antigravity-bridge", "node_modules", "__pycache__", ".venv", "dist", "build"]);
  let topLevel = [];
  try {
    topLevel = fs.readdirSync(workspace, { withFileTypes: true })
      .filter((entry) => !ignored.has(entry.name))
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, 60)
      .map((entry) => ({ name: entry.name, type: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other" }));
  } catch {
    topLevel = [];
  }
  const manifestNames = [
    "package.json", "pyproject.toml", "requirements.txt", "Pipfile", "Cargo.toml", "go.mod",
    "pom.xml", "build.gradle", "composer.json", "Gemfile", ".codex-plugin/plugin.json", ".mcp.json",
  ];
  const manifests = manifestNames.map((name) => fileEvidence(workspace, name)).filter((entry) => entry?.type === "file");
  return { topLevel, manifests };
}

function normalizeWorkItem(item, index) {
  const complexity = ["low", "medium", "high", "critical"].includes(String(item?.complexity || "").toLowerCase())
    ? String(item.complexity).toLowerCase()
    : "medium";
  return {
    id: boundedText(item?.id || `item-${index + 1}`, 64).replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || `item-${index + 1}`,
    objective: boundedText(item?.objective, 900),
    kind: boundedText(item?.kind || "general", 100),
    complexity,
    readOnly: item?.readOnly !== false,
    dependsOn: boundedList(item?.dependsOn, 8, 64),
    expectedFiles: boundedList(item?.expectedFiles, 12, 500),
    requiredCapabilities: boundedList(item?.requiredCapabilities, 10, 100),
    acceptanceCriteria: boundedList(item?.acceptanceCriteria, 6, 400),
    verification: boundedList(item?.verification, 6, 400),
    contextBudgetChars: { low: 4000, medium: 7000, high: 11000, critical: 15000 }[complexity],
  };
}

function buildContextCapsule(args = {}) {
  const workspace = path.resolve(String(args.workspace || ""));
  const workItems = (Array.isArray(args.workItems) ? args.workItems : []).slice(0, MAX_ITEMS).map(normalizeWorkItem);
  const expectedFiles = boundedList(workItems.flatMap((item) => item.expectedFiles), 40, 500);
  const stable = {
    schemaVersion: 1,
    workspaceFingerprint: canonicalHash(workspace.toLowerCase()),
    goal: boundedText(args.goal, 1800),
    lifecycleStage: boundedText(args.lifecycleStage || "plan", 40),
    constraints: boundedList(args.constraints, 20, 500),
    decisions: boundedList(args.decisions, 20, 500),
    blockers: boundedList(args.blockers, 12, 500),
    acceptanceCriteria: boundedList(args.acceptanceCriteria, 12, 500),
    verification: boundedList(args.verification, 12, 500),
    projectMap: buildProjectMap(workspace),
    workItems,
    fileEvidence: expectedFiles.map((value) => fileEvidence(workspace, value)).filter(Boolean),
    continuity: {
      summary: boundedText(args.continuitySummary, 1200),
      artifactRefs: boundedList(args.artifactRefs, 20, 500),
    },
    policy: {
      transcriptIncluded: false,
      oneWriterPerWorkspace: true,
      orchestrationDepth: 1,
      broadLogsIncluded: false,
    },
  };
  return {
    ...stable,
    capsuleHash: canonicalHash(stable),
    generatedAt: new Date().toISOString(),
  };
}

function buildTaskCapsule(projectCapsule, workItem) {
  const expected = new Set((workItem.expectedFiles || []).map((value) => String(value).replace(/\\/g, "/").toLowerCase()));
  const stable = {
    schemaVersion: 1,
    parentCapsuleHash: projectCapsule.capsuleHash,
    workspaceFingerprint: projectCapsule.workspaceFingerprint,
    goal: projectCapsule.goal,
    lifecycleStage: projectCapsule.lifecycleStage,
    constraints: projectCapsule.constraints,
    decisions: projectCapsule.decisions,
    blockers: projectCapsule.blockers,
    workItem,
    fileEvidence: (projectCapsule.fileEvidence || []).filter((entry) => expected.has(String(entry.path || "").toLowerCase())),
    projectMap: projectCapsule.projectMap,
    continuity: projectCapsule.continuity,
    policy: projectCapsule.policy,
  };
  return { ...stable, capsuleHash: canonicalHash(stable), generatedAt: new Date().toISOString() };
}

function writeCapsuleFile(outputPath, capsule) {
  try {
    const existing = JSON.parse(fs.readFileSync(outputPath, "utf8"));
    if (existing?.capsuleHash === capsule.capsuleHash) return { capsule: existing, outputPath, reused: true };
  } catch {
    // Missing or incompatible cache; write a fresh capsule below.
  }
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const tempPath = `${outputPath}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(capsule, null, 2)}\n`, "utf8");
  fs.renameSync(tempPath, outputPath);
  return { capsule, outputPath, reused: false };
}

function writeContextCapsule(args = {}) {
  const workspace = path.resolve(String(args.workspace || ""));
  if (!fs.existsSync(workspace) || !fs.statSync(workspace).isDirectory()) throw new Error(`Workspace does not exist: ${workspace}`);
  const capsule = buildContextCapsule({ ...args, workspace });
  const outputPath = path.join(workspace, ".antigravity-bridge", "orchestrator", "project-capsule.json");
  const project = writeCapsuleFile(outputPath, capsule);
  const taskCapsules = Object.fromEntries(project.capsule.workItems.map((workItem) => {
    const taskCapsule = buildTaskCapsule(project.capsule, workItem);
    const taskPath = path.join(workspace, ".antigravity-bridge", "orchestrator", "task-capsules", `${workItem.id}.json`);
    const written = writeCapsuleFile(taskPath, taskCapsule);
    return [workItem.id, { path: written.outputPath, hash: written.capsule.capsuleHash, reused: written.reused }];
  }));
  return { ...project, taskCapsules };
}

module.exports = {
  buildContextCapsule,
  buildTaskCapsule,
  canonicalHash,
  buildProjectMap,
  normalizeWorkItem,
  writeContextCapsule,
};
