"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { commandResult, fileSha256, processAlive, readJson, safeRelativePath, safeWorkspace, utcNow, withDirectoryLock, writeJson } = require("./utils");
const { stateRoot } = require("./state-store");
const { readProfile } = require("../lib/orchestrator-profile");
const { boundaryAllows } = require("./git-evidence");
const {
  buildContextScoutPrompt,
  contextGitStatusArgs,
  fingerprintSourceSnapshots,
  sourceSnapshotTarget,
} = require("./context-dossier");
const { assertDirectorWorkerContract, contractFingerprint: directorContractFingerprint } = require("./director-worker-contract");
const { fingerprint: catalogFingerprint } = require("./source-catalog");
const { releaseResourceLease } = require("./resource-leases");

const { trustedPrimaryDecision } = require("./trusted-models");
const TRANSIENT_PATHS = [
  "node_modules", ".pnpm-store", ".yarn", ".cache", ".pytest_cache", ".mypy_cache", ".ruff_cache",
  "__pycache__", ".venv", "venv", "env", "logs", "log", "coverage", ".coverage", "dist", "build",
  ".next", ".nuxt", "target", "tmp", "temp",
];

function normalized(value) {
  let resolved = path.resolve(String(value || ""));
  try {
    resolved = (fs.realpathSync.native || fs.realpathSync)(resolved);
  } catch { /* compare the resolved input when the path does not exist yet */ }
  return resolved.replace(/\\/g, "/").replace(/\/$/, "").toLowerCase();
}

function disposableCanaryWorkspace(workspace, contract) {
  if (process.env.AI_MOBILE_CANARY_POLICY !== "disposable-project") return null;
  const rootValue = String(process.env.AI_MOBILE_CANARY_WORKSPACE_ROOT || "").trim();
  if (!rootValue) throw new Error("Disposable canary workspace root is missing.");
  const root = path.resolve(rootValue);
  const relative = path.relative(root, workspace);
  if (relative !== "" && (relative.startsWith("..") || path.isAbsolute(relative))) {
    throw new Error("Disposable canary contract workspace escaped its isolated project root.");
  }
  if (!contract.directorProgram || !["code-change", "operational-transaction"].includes(String(contract.executorKind || ""))) {
    throw new Error("Disposable canary direct workspace is limited to plan-fenced code and local operations.");
  }
  if (contract.readOnly === true || contract.mutatesExternalState === true) {
    throw new Error("Disposable canary direct workspace cannot admit a read-only or external-state contract.");
  }
  const gitRoot = commandResult("git", ["-C", workspace, "rev-parse", "--show-toplevel"], { timeout: 5000 });
  if (gitRoot.status !== 0 || normalized(String(gitRoot.stdout || "").trim()) !== normalized(root)) {
    throw new Error("Disposable canary workspace must be the root of its isolated Git clone.");
  }
  if (contract.executorKind === "code-change") {
    return null;
  }
  return {
    mode: "disposable-canary-project",
    executionWorkspace: workspace,
    sourceWorkspace: workspace,
    cleanupRequired: false,
    skipModelReview: false,
    createdAt: utcNow(),
  };
}

function worktreeRoot() { return path.join(stateRoot(), "worktrees"); }
function metadataRoot() { return path.join(stateRoot(), "worktree-metadata"); }
function metadataFile(jobId) { return path.join(metadataRoot(), `${jobId}.json`); }

const CONTEXT_SNAPSHOT_TYPES = new Set(["project-outcome", "acceptance", "chat", "file", "log", "database"]);
const LOCAL_CONTEXT_TYPES = new Set([...CONTEXT_SNAPSHOT_TYPES, "git"]);
const MB = 1024 * 1024;
const SQLITE_OBSERVATION_SCHEMA_VERSION = "director-cfo/sqlite-observation-receipt@1";
const SQLITE_OBSERVATION_RECEIPT_MAX_BYTES = 256 * 1024;

function copy(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function replaceInsensitive(value, needle, replacement) {
  let output = String(value || "");
  const wanted = String(needle || "");
  if (!wanted) return output;
  let index = output.toLowerCase().indexOf(wanted.toLowerCase());
  while (index >= 0) {
    output = output.slice(0, index) + replacement + output.slice(index + wanted.length);
    index = output.toLowerCase().indexOf(wanted.toLowerCase(), index + replacement.length);
  }
  return output;
}

function scrubWorkspaceReferences(value, workspace) {
  const variants = [...new Set([
    path.resolve(workspace),
    path.resolve(workspace).replace(/\\/g, "/"),
    path.resolve(workspace).replace(/\//g, "\\"),
  ])].sort((left, right) => right.length - left.length);
  const scrub = (item) => {
    if (Array.isArray(item)) return item.map(scrub);
    if (item && typeof item === "object") return Object.fromEntries(Object.entries(item).map(([key, nested]) => [key, scrub(nested)]));
    if (typeof item !== "string") return item;
    return variants.reduce((text, variant) => replaceInsensitive(text, variant, "[live-workspace-withheld]"), item);
  };
  return scrub(value);
}

function sameObservedFile(stat, snapshot = {}) {
  if (!stat?.isFile?.()) return false;
  if (Number.isFinite(Number(snapshot.size)) && stat.size !== Number(snapshot.size)) return false;
  const expectedMtime = Date.parse(String(snapshot.modifiedAt || ""));
  return !Number.isFinite(expectedMtime) || Math.abs(stat.mtimeMs - expectedMtime) <= 2;
}

function pruneEmptySnapshotParents(target) {
  const root = path.resolve(worktreeRoot());
  let current = path.dirname(path.resolve(target));
  while (normalized(current).startsWith(`${normalized(root)}/`)) {
    try { fs.rmdirSync(current); } catch { break; }
    current = path.dirname(current);
  }
}

function contextBootstrap(contract = {}) {
  if (contract.readOnly !== true || contract.executorKind !== "context-scout" || !contract.directorProgram) return null;
  const bootstrap = contract.directorWorkerContract?.bootstrapContract;
  if (!bootstrap || bootstrap.schemaVersion !== "director-cfo/context-scout-work-package@1") return null;
  return bootstrap;
}

function containedRegularFile(workspace, relative, sourceId) {
  const candidate = path.join(workspace, relative);
  const linkStat = fs.lstatSync(candidate);
  if (linkStat.isSymbolicLink()) throw new Error(`context-source-link-refused:${sourceId}`);
  if (!linkStat.isFile()) throw new Error(`context-source-not-regular-file:${sourceId}`);
  const workspaceReal = (fs.realpathSync.native || fs.realpathSync)(workspace);
  const sourceReal = (fs.realpathSync.native || fs.realpathSync)(candidate);
  if (!normalized(sourceReal).startsWith(`${normalized(workspaceReal)}/`)) {
    throw new Error(`context-source-realpath-escaped:${sourceId}`);
  }
  return sourceReal;
}

function copyRegularSnapshot(sourceFile, destination, sourceId, appendOnly) {
  let sourceDescriptor;
  let destinationDescriptor;
  try {
    sourceDescriptor = fs.openSync(sourceFile, "r");
    const before = fs.fstatSync(sourceDescriptor);
    if (!before.isFile()) throw new Error(`context-source-not-regular-file:${sourceId}`);
    destinationDescriptor = fs.openSync(destination, "wx", 0o600);
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    while (position < before.size) {
      const wanted = Math.min(buffer.length, before.size - position);
      const count = fs.readSync(sourceDescriptor, buffer, 0, wanted, position);
      if (!count) throw new Error(`context-source-truncated-during-copy:${sourceId}`);
      fs.writeSync(destinationDescriptor, buffer, 0, count, position);
      position += count;
    }
    fs.fsyncSync(destinationDescriptor);
    const after = fs.fstatSync(sourceDescriptor);
    const identityChanged = Number.isFinite(before.ino) && Number.isFinite(after.ino) && before.ino !== after.ino;
    const staticChanged = after.size !== before.size || Math.abs(after.mtimeMs - before.mtimeMs) > 2;
    const appendSnapshotInvalidated = after.size < before.size || identityChanged;
    if ((!appendOnly && staticChanged) || (appendOnly && appendSnapshotInvalidated)) {
      throw new Error(`context-source-changed-during-copy:${sourceId}`);
    }
    return { sourceSize: before.size, sourceModifiedAt: before.mtime.toISOString() };
  } catch (error) {
    try { fs.rmSync(destination, { force: true }); } catch { /* enclosing snapshot cleanup is authoritative */ }
    throw error;
  } finally {
    if (destinationDescriptor !== undefined) fs.closeSync(destinationDescriptor);
    if (sourceDescriptor !== undefined) fs.closeSync(sourceDescriptor);
  }
}

function copyRegularSnapshotWithRetry(sourceFile, destination, sourceId, appendOnly) {
  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return copyRegularSnapshot(sourceFile, destination, sourceId, appendOnly);
    } catch (error) {
      lastError = error;
      if (!/^context-source-(?:changed|truncated)-during-copy:/.test(String(error.message || "")) || attempt === 1) throw error;
      fs.rmSync(destination, { force: true });
    }
  }
  throw lastError;
}

function copySqliteSnapshot(sourceFile, destination, sourceId) {
  const helper = path.join(__dirname, "sqlite-snapshot.js");
  const result = commandResult(process.execPath, [helper, sourceFile, destination], {
    timeout: 120000,
    maxBuffer: 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`context-sqlite-snapshot-failed:${sourceId}:${String(result.stderr || result.stdout || "unknown error").trim().slice(0, 500)}`);
  }
  let receipt;
  try { receipt = JSON.parse(String(result.stdout || "").trim()); }
  catch { throw new Error(`context-sqlite-snapshot-invalid-receipt:${sourceId}`); }
  if (receipt?.ok !== true || receipt.integrityCheck !== "ok") {
    throw new Error(`context-sqlite-snapshot-integrity-failed:${sourceId}`);
  }
  const stat = fs.statSync(sourceFile);
  return { sourceSize: stat.size, sourceModifiedAt: stat.mtime.toISOString() };
}

function captureSqliteObservation(snapshotFile, target, sourceId, snapshotContentHash) {
  const safeSourceId = String(sourceId || "database").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-|-$/g, "").slice(0, 100) || "database";
  const relative = path.join(".ai-mobile-director", "database-observations", `${safeSourceId}.json`);
  const destination = path.join(target, relative);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const helper = path.join(__dirname, "sqlite-observation.js");
  const result = commandResult(process.execPath, [helper, snapshotFile, destination, sourceId, snapshotContentHash], {
    timeout: 12000,
    maxBuffer: 1024 * 1024,
  });
  if (result.status !== 0) {
    try { fs.rmSync(destination, { force: true }); } catch { /* enclosing snapshot cleanup is authoritative */ }
    throw new Error(`context-sqlite-observation-failed:${sourceId}:${String(result.stderr || result.stdout || "unknown error").trim().slice(0, 500)}`);
  }
  let helperReceipt;
  try { helperReceipt = JSON.parse(String(result.stdout || "").trim()); }
  catch { throw new Error(`context-sqlite-observation-invalid-helper-receipt:${sourceId}`); }
  const receipt = readJson(destination, null);
  const stat = fs.statSync(destination);
  if (
    helperReceipt?.ok !== true
    || !receipt
    || receipt.schemaVersion !== SQLITE_OBSERVATION_SCHEMA_VERSION
    || receipt.sourceId !== sourceId
    || receipt.snapshot?.contentHash !== snapshotContentHash
    || receipt.receiptFingerprint !== helperReceipt.receiptFingerprint
    || stat.size > SQLITE_OBSERVATION_RECEIPT_MAX_BYTES
  ) {
    throw new Error(`context-sqlite-observation-binding-invalid:${sourceId}`);
  }
  return {
    sourceId,
    path: relative,
    schemaVersion: receipt.schemaVersion,
    snapshotContentHash,
    receiptFingerprint: receipt.receiptFingerprint,
    receiptFileHash: fileSha256(destination),
    bytes: stat.size,
    rowsIncluded: Number(receipt.rowsIncluded || 0),
    limits: receipt.limits,
  };
}

function captureGitSnapshot(workspace, target, source, catalog) {
  const gitEnv = { ...process.env, GIT_OPTIONAL_LOCKS: "0" };
  const rootProbe = commandResult("git", ["-C", workspace, "rev-parse", "--show-toplevel"], { timeout: 10000, maxBuffer: 1024 * 1024, env: gitEnv });
  if (rootProbe.status !== 0 || normalized(String(rootProbe.stdout || "").trim()) !== normalized(workspace)) {
    throw new Error(`context-git-snapshot-root-invalid:${source.id}`);
  }
  let receipt = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const headBefore = commandResult("git", ["-C", workspace, "rev-parse", "HEAD"], { timeout: 10000, maxBuffer: 1024 * 1024, env: gitEnv });
    const branch = commandResult("git", ["-C", workspace, "branch", "--show-current"], { timeout: 10000, maxBuffer: 1024 * 1024, env: gitEnv });
    const status = commandResult("git", contextGitStatusArgs(workspace, catalog), { timeout: 30000, maxBuffer: 4 * 1024 * 1024, env: gitEnv });
    const headAfter = commandResult("git", ["-C", workspace, "rev-parse", "HEAD"], { timeout: 10000, maxBuffer: 1024 * 1024, env: gitEnv });
    if ([headBefore, branch, status, headAfter].some((row) => row.status !== 0)) {
      throw new Error(`context-git-snapshot-command-failed:${source.id}`);
    }
    const before = String(headBefore.stdout || "").trim();
    const after = String(headAfter.stdout || "").trim();
    if (before !== after) {
      if (attempt === 0) continue;
      throw new Error(`context-git-head-changed-during-capture:${source.id}`);
    }
    const statusText = String(status.stdout || "");
    const stateFingerprint = catalogFingerprint({ head: before, branch: String(branch.stdout || "").trim(), status: statusText });
    receipt = {
      schemaVersion: "director-cfo/git-snapshot-receipt@1",
      sourceId: source.id,
      repository: ".",
      head: before,
      branch: String(branch.stdout || "").trim(),
      statusPorcelain: statusText.slice(0, 500000),
      statusSha256: crypto.createHash("sha256").update(statusText).digest("hex"),
      stateFingerprint,
      statusTruncated: statusText.length > 500000,
      capturedAt: utcNow(),
    };
    break;
  }
  if (!receipt) throw new Error(`context-git-snapshot-unavailable:${source.id}`);
  const safeName = String(source.id || "repository").replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 100) || "repository";
  const relative = path.posix.join(".ai-mobile-director", "git", `${safeName}.json`);
  const destination = path.join(target, relative);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  writeJson(destination, receipt);
  const stat = fs.statSync(destination);
  return {
    sourceId: source.id,
    sourceType: "git",
    relative,
    size: stat.size,
    contentHash: receipt.stateFingerprint,
    receiptHash: fileSha256(destination),
    sourceSize: stat.size,
    sourceModifiedAt: receipt.capturedAt,
    capturedAt: receipt.capturedAt,
  };
}

function rebaseContextWorkerContract(contract, bootstrapValue, workspace, copiedRows) {
  let bootstrap = copy(bootstrapValue);
  const captured = new Map(copiedRows.map((row) => [row.sourceId, row]));
  bootstrap.sourceCatalog.sources = (bootstrap.sourceCatalog.sources || []).map((source) => {
    if (!LOCAL_CONTEXT_TYPES.has(String(source.type || ""))) return source;
    const rowCaptured = captured.get(source.id);
    if (rowCaptured) return {
      ...source,
      locator: rowCaptured.relative,
      ...(rowCaptured.observationReceiptExpectation ? {
        observationReceipt: {
          path: rowCaptured.observationReceiptExpectation.path,
          schemaVersion: rowCaptured.observationReceiptExpectation.schemaVersion,
        },
      } : {}),
    };
    try {
      const target = sourceSnapshotTarget(workspace, source);
      return { ...source, locator: target.relative };
    } catch {
      return { ...source, locator: `unavailable-source:${source.id}` };
    }
  });
  const originalSnapshots = bootstrap.sourceSnapshotManifest?.snapshots || [];
  const snapshotIds = new Set(originalSnapshots.map((row) => row.sourceId));
  const snapshots = originalSnapshots.map((row) => {
    const rowCaptured = captured.get(row.sourceId);
    return rowCaptured ? {
      ...row,
      state: "available",
      size: rowCaptured.size,
      modifiedAt: rowCaptured.sourceModifiedAt,
      contentHash: rowCaptured.contentHash,
      capturedAt: rowCaptured.capturedAt,
    } : row;
  });
  for (const row of copiedRows) {
    if (!snapshotIds.has(row.sourceId)) {
      snapshots.push({
        sourceId: row.sourceId,
        state: "available",
        size: row.size,
        modifiedAt: row.sourceModifiedAt,
        contentHash: row.contentHash,
        capturedAt: row.capturedAt,
      });
    }
  }
  const fingerprints = fingerprintSourceSnapshots(bootstrap.sourceCatalog, snapshots);
  const fingerprintedSnapshots = snapshots.map((row) => ({ ...row, fingerprint: fingerprints[row.sourceId] }));
  bootstrap.sourceSnapshotManifest = {
    ...bootstrap.sourceSnapshotManifest,
    workspace: ".",
    snapshots: fingerprintedSnapshots,
    fingerprint: catalogFingerprint({
      catalogFingerprint: bootstrap.sourceCatalog.catalogFingerprint,
      fingerprints,
    }),
  };
  bootstrap = scrubWorkspaceReferences(bootstrap, workspace);
  delete bootstrap.prompt;
  delete bootstrap.contractFingerprint;
  bootstrap.prompt = buildContextScoutPrompt(bootstrap);
  const bootstrapBasis = copy(bootstrap);
  delete bootstrapBasis.prompt;
  bootstrap.contractFingerprint = catalogFingerprint(bootstrapBasis);

  const previous = assertDirectorWorkerContract(contract.directorWorkerContract);
  const workerBasis = copy(previous);
  delete workerBasis.contractFingerprint;
  workerBasis.bootstrapContract = bootstrap;
  contract.directorWorkerContract = {
    ...workerBasis,
    contractFingerprint: directorContractFingerprint(workerBasis),
  };
  contract.goal = bootstrap.prompt;
  contract.relevantFiles = [...new Set(copiedRows.map((row) => row.relative))];
  const observationReceiptExpectations = Object.fromEntries(copiedRows
    .filter((row) => row.sourceType === "database" && row.observationReceiptExpectation)
    .map((row) => [row.sourceId, row.observationReceiptExpectation]));
  const missingRequiredDatabaseIds = (bootstrap.sourceCatalog?.sources || [])
    .filter((row) => row.type === "database" && row.required !== false && !observationReceiptExpectations[row.id])
    .map((row) => row.id);
  if (missingRequiredDatabaseIds.length) {
    throw new Error(`context-required-database-observation-receipt-missing:${missingRequiredDatabaseIds.join(",")}`);
  }
  contract.contextObservationReceiptExpectations = observationReceiptExpectations;
  contract.contextObservationPreflight = {
    ok: true,
    mode: "immutable-sqlite-receipt",
    databaseSourceIds: Object.keys(observationReceiptExpectations).sort(),
  };
  contract.contextSnapshotContractFingerprint = bootstrap.contractFingerprint;
  return bootstrap;
}

function plannedSnapshotBytes(contract, workspace, relevantFiles) {
  const direct = Number(contract.resourceEstimate?.diskMb ?? contract.diskMb);
  let bytes = 16 * MB;
  const bootstrap = contextBootstrap(contract);
  const targets = new Map((bootstrap?.sourceCatalog?.sources || []).flatMap((source) => {
    try {
      const target = sourceSnapshotTarget(workspace, source);
      return [[target.relative.toLowerCase(), { source, target }]];
    } catch { return []; }
  }));
  for (const relative of relevantFiles) {
    try {
      const entry = targets.get(String(relative).replace(/\\/g, "/").toLowerCase());
      const sourceFile = entry?.target.absolute || path.join(workspace, relative);
      const sourceBytes = fs.statSync(sourceFile).size;
      if (entry?.source.type === "database") {
        let walBytes = 0;
        try { walBytes = fs.statSync(`${sourceFile}-wal`).size; } catch { /* a checkpointed database may have no WAL */ }
        bytes += 2 * (sourceBytes + walBytes) + SQLITE_OBSERVATION_RECEIPT_MAX_BYTES;
      } else {
        bytes += sourceBytes;
      }
    } catch { /* actual capture reports the authoritative source error */ }
  }
  return Number.isFinite(direct) && direct > 0 ? Math.max(bytes, Math.ceil(direct * MB)) : bytes;
}

function assertSnapshotAllocation(profile, contract, workspace, relevantFiles) {
  const status = assertStorageAvailable(profile);
  const plannedBytes = plannedSnapshotBytes(contract, workspace, relevantFiles);
  if (status.bytes + plannedBytes > profile.worktreeDiskQuotaMb * MB) {
    throw new Error(`Read-only snapshot allocation would exceed the ${profile.worktreeDiskQuotaMb} MB storage quota.`);
  }
  if (status.freeMb !== null && status.freeMb * MB - plannedBytes < profile.worktreeMinFreeMb * MB) {
    throw new Error(`Read-only snapshot allocation would cross the ${profile.worktreeMinFreeMb} MB free-space floor.`);
  }
  return { status, plannedBytes };
}

function prepareDirectorReadOnlySnapshot(workspaceValue, contract, taskId, jobId, profileValue) {
  const workspace = safeWorkspace(workspaceValue);
  const bootstrap = contextBootstrap(contract);
  if (!bootstrap) throw new Error("Director context snapshot requires an immutable context-scout contract.");
  const profile = profileValue || readProfile();
  const target = path.join(worktreeRoot(), "read-only-snapshots", taskId, jobId);
  const root = normalized(worktreeRoot());
  if (!normalized(target).startsWith(`${root}/`)) throw new Error("Read-only snapshot target escaped AI Mobile storage.");
  const declaredRelevantFiles = [...new Set(contract.relevantFiles || [])];
  if (declaredRelevantFiles.length > 80) {
    throw new Error(`context-source-file-limit-exceeded:${declaredRelevantFiles.length}:maximum=80`);
  }
  const relevantFiles = declaredRelevantFiles.map((value) => safeRelativePath(workspace, value));
  if (relevantFiles.some((relative) => !relative || relative === ".")) {
    throw new Error("Read-only context snapshot requires bounded file paths.");
  }
  const allocation = assertSnapshotAllocation(profile, contract, workspace, relevantFiles);
  fs.rmSync(target, { recursive: true, force: true });

  const sourcesByPath = new Map();
  for (const source of bootstrap.sourceCatalog?.sources || []) {
    if (!CONTEXT_SNAPSHOT_TYPES.has(String(source.type || ""))) continue;
    try {
      const target = sourceSnapshotTarget(workspace, source);
      sourcesByPath.set(target.relative.toLowerCase(), { source, target });
    } catch { /* the bootstrap manifest already records unavailable sources */ }
  }
  const copied = [];
  let copiedBytes = 0;
  const provisional = {
    mode: "read-only-snapshot",
    state: "building",
    executionWorkspace: target,
    sourceWorkspace: workspace,
    taskId,
    jobId,
    metadataFile: metadataFile(jobId),
    cleanupRequired: true,
    plannedBytes: allocation.plannedBytes,
    createdAt: utcNow(),
  };
  try {
    writeJson(provisional.metadataFile, provisional);
    fs.mkdirSync(target, { recursive: true });
    for (const source of bootstrap.sourceCatalog?.sources || []) {
      if (source.type !== "git") continue;
      const row = captureGitSnapshot(workspace, target, source, bootstrap.sourceCatalog);
      copied.push(row);
      copiedBytes += row.size;
    }
    for (const relative of relevantFiles) {
      const entry = sourcesByPath.get(relative.toLowerCase());
      if (!entry) throw new Error(`Read-only context snapshot has no authorized source descriptor for ${relative}.`);
      const { source, target: sourceTarget } = entry;
      const sourceFile = sourceTarget.absolute;
      const destination = path.join(target, relative);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      const sourceObservation = source.type === "database"
        ? copySqliteSnapshot(sourceFile, destination, source.id)
        : copyRegularSnapshotWithRetry(sourceFile, destination, source.id, source.type === "log" && /\.log$/i.test(relative));
      const copiedStat = fs.statSync(destination);
      const contentHash = fileSha256(destination);
      const observationReceiptExpectation = source.type === "database"
        ? captureSqliteObservation(destination, target, source.id, contentHash)
        : null;
      copiedBytes += copiedStat.size + Number(observationReceiptExpectation?.bytes || 0);
      copied.push({
        sourceId: source.id,
        sourceType: source.type,
        relative: observationReceiptExpectation?.path || relative,
        ...(observationReceiptExpectation ? { snapshotRelative: relative, observationReceiptExpectation } : {}),
        size: copiedStat.size,
        contentHash,
        sourceSize: sourceObservation.sourceSize,
        sourceModifiedAt: sourceObservation.sourceModifiedAt,
        capturedAt: utcNow(),
      });
    }
    const capturedBootstrap = rebaseContextWorkerContract(contract, bootstrap, workspace, copied);
    const isolation = {
      ...provisional,
      state: "ready",
      sourceSnapshotFingerprint: capturedBootstrap.sourceSnapshotManifest?.fingerprint || "",
      contextSnapshotContractFingerprint: capturedBootstrap.contractFingerprint,
      copiedBytes,
      copied,
      readyAt: utcNow(),
    };
    writeJson(isolation.metadataFile, isolation);
    const after = storageStatus(profile);
    if (!after.withinQuota || !after.hasMinimumFree) {
      cleanupIsolatedWorkspace(isolation);
      throw new Error(`Creating the read-only snapshot would violate storage limits (${after.usedMb}/${after.quotaMb} MB used, ${after.freeMb ?? "unknown"} MB free).`);
    }
    return isolation;
  } catch (error) {
    removeTreeWithRetry(target);
    pruneEmptySnapshotParents(target);
    try { fs.rmSync(metadataFile(jobId), { force: true }); } catch { /* no-op */ }
    throw error;
  }
}

function prepareDirectorReadOnlyScratch(workspaceValue, contract, taskId, jobId, profileValue) {
  const workspace = safeWorkspace(workspaceValue);
  const profile = profileValue || readProfile();
  const target = path.join(worktreeRoot(), "read-only-snapshots", taskId, jobId);
  const root = normalized(worktreeRoot());
  if (!normalized(target).startsWith(`${root}/`)) throw new Error("Read-only scratch target escaped AI Mobile storage.");
  const declaredRelevantFiles = [...new Set(contract.relevantFiles || [])];
  if (declaredRelevantFiles.length > 80) {
    throw new Error(`director-read-source-file-limit-exceeded:${declaredRelevantFiles.length}:maximum=80`);
  }
  const relevantFiles = declaredRelevantFiles.map((value) => safeRelativePath(workspace, value));
  if (relevantFiles.some((relative) => !relative || relative === ".")) {
    throw new Error("Read-only Director snapshot requires bounded file paths.");
  }
  const grantedPermissions = new Set(contract.permissionGrant || []);
  if (relevantFiles.length && !grantedPermissions.has("read-files")) {
    throw new Error("Read-only Director snapshot requires an explicit read-files permission grant.");
  }
  const allocation = assertSnapshotAllocation(profile, contract, workspace, relevantFiles);
  fs.rmSync(target, { recursive: true, force: true });
  const provisional = {
    mode: "read-only-snapshot",
    state: "building",
    executionWorkspace: target,
    sourceWorkspace: workspace,
    taskId,
    jobId,
    metadataFile: metadataFile(jobId),
    cleanupRequired: true,
    plannedBytes: allocation.plannedBytes,
    createdAt: utcNow(),
  };
  try {
    writeJson(provisional.metadataFile, provisional);
    fs.mkdirSync(target, { recursive: true });
    const copied = [];
    let copiedBytes = 0;
    for (const relative of relevantFiles) {
      const sourceId = `director-read:${relative}`;
      const sourceFile = containedRegularFile(workspace, relative, sourceId);
      const destination = path.join(target, relative);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      const sourceObservation = copyRegularSnapshotWithRetry(sourceFile, destination, sourceId, false);
      const copiedStat = fs.statSync(destination);
      copiedBytes += copiedStat.size;
      copied.push({
        sourceId,
        sourceType: "file",
        relative,
        size: copiedStat.size,
        contentHash: fileSha256(destination),
        sourceSize: sourceObservation.sourceSize,
        sourceModifiedAt: sourceObservation.sourceModifiedAt,
        capturedAt: utcNow(),
      });
    }
    contract.relevantFiles = relevantFiles;
    const isolation = { ...provisional, state: "ready", copiedBytes, copied, readyAt: utcNow() };
    writeJson(isolation.metadataFile, isolation);
    const after = storageStatus(profile);
    if (!after.withinQuota || !after.hasMinimumFree) {
      cleanupIsolatedWorkspace(isolation);
      throw new Error(`Creating the read-only scratch would violate storage limits (${after.usedMb}/${after.quotaMb} MB used, ${after.freeMb ?? "unknown"} MB free).`);
    }
    return isolation;
  } catch (error) {
    removeTreeWithRetry(target);
    pruneEmptySnapshotParents(target);
    try { fs.rmSync(metadataFile(jobId), { force: true }); } catch { /* no-op */ }
    throw error;
  }
}

function directoryBytes(root) {
  if (!fs.existsSync(root)) return 0;
  let total = 0;
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) {
        try { total += fs.statSync(full).size; } catch { /* raced cleanup */ }
      }
    }
  }
  return total;
}

function storageStatus(profileValue) {
  const profile = profileValue || readProfile();
  fs.mkdirSync(stateRoot(), { recursive: true });
  const bytes = directoryBytes(worktreeRoot());
  let freeBytes = Number.POSITIVE_INFINITY;
  try {
    const stats = fs.statfsSync(stateRoot());
    freeBytes = Number(stats.bavail) * Number(stats.bsize);
  } catch { /* old Node versions retain quota enforcement only */ }
  return {
    bytes,
    usedMb: Math.ceil(bytes / (1024 * 1024)),
    freeMb: Number.isFinite(freeBytes) ? Math.floor(freeBytes / (1024 * 1024)) : null,
    quotaMb: profile.worktreeDiskQuotaMb,
    minimumFreeMb: profile.worktreeMinFreeMb,
    withinQuota: bytes <= profile.worktreeDiskQuotaMb * 1024 * 1024,
    hasMinimumFree: !Number.isFinite(freeBytes) || freeBytes >= profile.worktreeMinFreeMb * 1024 * 1024,
  };
}

function assertStorageAvailable(profile) {
  const status = storageStatus(profile);
  if (!status.withinQuota || status.usedMb >= profile.worktreeDiskQuotaMb) {
    throw new Error(`Worktree storage quota (${profile.worktreeDiskQuotaMb} MB) is exhausted; collect or clean existing worker worktrees first.`);
  }
  if (!status.hasMinimumFree) {
    throw new Error(`Disk free space (${status.freeMb} MB) is below the configured ${profile.worktreeMinFreeMb} MB worktree floor.`);
  }
  return status;
}

function preparePrimaryWorkspace(workspaceValue, contract, profileValue) {
  const workspace = safeWorkspace(workspaceValue);
  const profile = profileValue || readProfile();
  const decision = trustedPrimaryDecision(contract, profile);
  if (!decision.trusted) throw new Error(`Trusted primary workspace denied: ${decision.reason}.`);

  const rootProbe = commandResult("git", ["-C", workspace, "rev-parse", "--show-toplevel"], { timeout: 5000 });
  const root = String(rootProbe.stdout || "").trim();
  if (rootProbe.status !== 0 || normalized(root) !== normalized(workspace)) {
    throw new Error("Trusted primary writing requires the declared workspace to be a Git repository root.");
  }
  const ownedPaths = Array.isArray(contract.expectedFiles) ? contract.expectedFiles : [];
  if (!ownedPaths.length) throw new Error("Trusted primary writing requires explicit expectedFiles boundaries.");
  const dirty = commandResult("git", ["-C", workspace, "status", "--porcelain=v1", "--untracked-files=all"], { timeout: 10000, maxBuffer: 1024 * 1024 });
  if (dirty.status !== 0) throw new Error("Unable to verify trusted primary file ownership.");
  if (String(dirty.stdout || "").trim()) {
    throw new Error("Trusted primary writing requires a completely clean repository; use an isolated worktree or finish existing owners first.");
  }
  const head = commandResult("git", ["-C", workspace, "rev-parse", "HEAD"], { timeout: 5000 });
  return {
    mode: "trusted-primary-workspace",
    executionWorkspace: workspace,
    sourceWorkspace: workspace,
    cleanupRequired: false,
    trustedModel: decision.model,
    skipModelReview: true,
    baselineHead: String(head.stdout || "").trim(),
    ownedPaths,
    createdAt: utcNow(),
  };
}

function prepareWorkspaceForContract(contract, taskId, jobId, profileValue) {
  const workspace = safeWorkspace(contract.workspace);
  if (contract.readOnly === true) {
    if (contextBootstrap(contract)) return prepareDirectorReadOnlySnapshot(workspace, contract, taskId, jobId, profileValue);
    if (contract.directorProgram) return prepareDirectorReadOnlyScratch(workspace, contract, taskId, jobId, profileValue);
    return { mode: "shared-read-only", executionWorkspace: workspace, cleanupRequired: false };
  }
  const profile = profileValue || readProfile();
  const canary = disposableCanaryWorkspace(workspace, contract);
  if (canary) return canary;
  if (contract.directorProgram && contract.deliverableKind === "patch") {
    return prepareIsolatedWorkspace(workspace, taskId, jobId, false, profile);
  }
  const decision = trustedPrimaryDecision(contract, profile);
  if (decision.trusted) return preparePrimaryWorkspace(workspace, contract, profile);
  return prepareIsolatedWorkspace(workspace, taskId, jobId, false, profile);
}
function rollbackPrimaryWorkspace(isolation = {}, changedPaths = []) {
  if (isolation.mode !== "trusted-primary-workspace") return { rolledBack: false, reason: "not-trusted-primary" };
  const workspace = safeWorkspace(isolation.executionWorkspace);
  const baselineHead = String(isolation.baselineHead || "").trim();
  if (!baselineHead) return { rolledBack: false, reason: "missing-baseline-head" };
  const changed = [...new Set((changedPaths || []).map((item) => String(item || "").replace(/\\/g, "/")).filter(Boolean))];
  const ownedPaths = Array.isArray(isolation.ownedPaths) ? isolation.ownedPaths : [];
  const paths = changed.filter((relative) => boundaryAllows(relative, ownedPaths));
  const outsidePaths = changed.filter((relative) => !boundaryAllows(relative, ownedPaths));
  const failures = [];
  for (const relative of paths) {
    const full = path.resolve(workspace, relative);
    if (!normalized(full).startsWith(`${normalized(workspace)}/`)) {
      failures.push({ path: relative, reason: "outside-workspace" });
      continue;
    }
    const tracked = commandResult("git", ["-C", workspace, "ls-files", "--error-unmatch", "--", relative], { timeout: 5000 });
    if (tracked.status === 0) {
      const restore = commandResult("git", ["-C", workspace, "restore", "--source", baselineHead, "--staged", "--worktree", "--", relative], { timeout: 10000 });
      if (restore.status !== 0) failures.push({ path: relative, reason: String(restore.stderr || restore.stdout).trim().slice(0, 300) });
    } else {
      try { fs.rmSync(full, { recursive: true, force: true }); }
      catch (error) { failures.push({ path: relative, reason: String(error.message).slice(0, 300) }); }
    }
  }
  return { rolledBack: failures.length === 0 && outsidePaths.length === 0, paths, outsidePaths, failures };
}

function prepareIsolatedWorkspace(workspaceValue, taskId, jobId, readOnly, profileValue) {
  const workspace = safeWorkspace(workspaceValue);
  if (readOnly) return { mode: "shared-read-only", executionWorkspace: workspace, cleanupRequired: false };
  const profile = profileValue || readProfile();
  assertStorageAvailable(profile);

  const rootProbe = commandResult("git", ["-C", workspace, "rev-parse", "--show-toplevel"], { timeout: 5000 });
  if (rootProbe.status !== 0) throw new Error("Writer delegation requires a Git repository; use a read-only worker or define a testable isolated writer boundary.");
  const prefixProbe = commandResult("git", ["-C", workspace, "rev-parse", "--show-prefix"], { timeout: 5000 });
  if (prefixProbe.status !== 0 || String(prefixProbe.stdout || "").trim()) {
    throw new Error("Writer delegation requires the task workspace to be the Git repository root.");
  }

  const target = path.join(worktreeRoot(), taskId, jobId);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.rmSync(target, { recursive: true, force: true });
  const result = commandResult("git", ["-C", workspace, "worktree", "add", "--detach", target, "HEAD"], { timeout: 30000, maxBuffer: 2 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`Unable to create isolated writer worktree: ${(result.stderr || result.stdout).trim().slice(0, 500)}`);
  const isolation = {
    mode: "isolated-git-worktree",
    executionWorkspace: target,
    sourceWorkspace: workspace,
    taskId,
    jobId,
    metadataFile: metadataFile(jobId),
    cleanupRequired: true,
    createdAt: utcNow(),
  };
  writeJson(isolation.metadataFile, isolation);
  const after = storageStatus(profile);
  if (!after.withinQuota || !after.hasMinimumFree) {
    cleanupIsolatedWorkspace(isolation);
    throw new Error(`Creating the writer worktree would violate storage limits (${after.usedMb}/${after.quotaMb} MB used, ${after.freeMb ?? "unknown"} MB free).`);
  }
  return isolation;
}

function cleanTransientOutputs(isolation = {}) {
  if (isolation.mode !== "isolated-git-worktree" || !isolation.executionWorkspace) return { cleaned: false, reason: "not-isolated" };
  const workspace = isolation.executionWorkspace;
  commandResult("git", ["-C", workspace, "clean", "-fdX"], { timeout: 30000, maxBuffer: 1024 * 1024 });
  const result = commandResult("git", ["-C", workspace, "clean", "-fd", "--", ...TRANSIENT_PATHS], { timeout: 30000, maxBuffer: 1024 * 1024 });
  const transientNames = new Set(TRANSIENT_PATHS.map((value) => path.basename(value).toLowerCase()));
  const stack = [workspace];
  while (stack.length) {
    const current = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (entry.name === ".git") continue;
      const full = path.join(current, entry.name);
      if (transientNames.has(entry.name.toLowerCase())) fs.rmSync(full, { recursive: true, force: true });
      else if (entry.isDirectory()) stack.push(full);
    }
  }
  return { cleaned: result.status === 0, paths: TRANSIENT_PATHS };
}

function removeTreeWithRetry(target, attempts = 8) {
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      fs.rmSync(target, { recursive: true, force: true });
      if (!fs.existsSync(target)) return { removed: true, attempts: attempt + 1 };
    } catch (error) {
      lastError = error;
      if (!["EACCES", "EBUSY", "ENOTEMPTY", "EPERM"].includes(String(error.code || "").toUpperCase())) break;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50 * (attempt + 1));
  }
  return { removed: !fs.existsSync(target), attempts, error: String(lastError?.message || "").slice(0, 300) };
}

function cleanupIsolatedWorkspace(isolation = {}) {
  if (!isolation.cleanupRequired || !isolation.executionWorkspace || !isolation.sourceWorkspace) return { cleaned: false, reason: "not-required" };
  const root = normalized(worktreeRoot());
  const target = normalized(isolation.executionWorkspace);
  if (!target.startsWith(`${root}/`)) return { cleaned: false, reason: "worktree-cleanup-boundary-refused" };

  if (isolation.mode === "read-only-snapshot") {
    const removal = fs.existsSync(isolation.executionWorkspace)
      ? removeTreeWithRetry(isolation.executionWorkspace)
      : { removed: true, attempts: 0 };
    const cleaned = removal.removed && !fs.existsSync(isolation.executionWorkspace);
    if (cleaned) {
      try { fs.rmSync(isolation.metadataFile || metadataFile(isolation.jobId), { force: true }); } catch { /* startup cleanup can remove stale metadata */ }
      pruneEmptySnapshotParents(isolation.executionWorkspace);
    }
    return {
      cleaned,
      attempts: removal.attempts,
      ...(removal.error ? { warning: removal.error } : {}),
      ...(cleaned ? {} : { recoveryAction: "Keep the snapshot metadata and retry cleanup during startup or cancellation recovery." }),
    };
  }

  const result = commandResult("git", ["-C", isolation.sourceWorkspace, "worktree", "remove", "--force", isolation.executionWorkspace], { timeout: 30000, maxBuffer: 1024 * 1024 });
  const removal = fs.existsSync(isolation.executionWorkspace)
    ? removeTreeWithRetry(isolation.executionWorkspace)
    : { removed: true, attempts: 0 };
  if (result.status !== 0 || !removal.removed) {
    commandResult("git", ["-C", isolation.sourceWorkspace, "worktree", "prune"], { timeout: 10000 });
  }
  const cleaned = removal.removed && !fs.existsSync(isolation.executionWorkspace);
  if (cleaned) {
    try { fs.rmSync(isolation.metadataFile || metadataFile(isolation.jobId), { force: true }); } catch { /* startup cleanup can remove stale metadata */ }
    pruneEmptySnapshotParents(isolation.executionWorkspace);
  }
  const warning = [String(result.stderr || result.stdout).trim(), removal.error].filter(Boolean).join(" | ").slice(0, 500);
  return { cleaned, attempts: removal.attempts, ...(warning ? { warning } : {}), ...(cleaned ? {} : { recoveryAction: "Keep the worktree metadata and retry cleanup during startup or cancellation recovery." }) };
}

function jobStatusFor(meta) {
  return readJson(path.join(stateRoot(), "tasks", String(meta.taskId || ""), "jobs", String(meta.jobId || ""), "status.json"), null);
}

function failAbandonedQueuedJob(meta, graceMs = 60000) {
  const file = path.join(stateRoot(), "tasks", String(meta.taskId || ""), "jobs", String(meta.jobId || ""), "status.json");
  return withDirectoryLock(`${file}.lock`, () => {
    const current = readJson(file, null);
    const ageMs = Date.now() - Date.parse(current?.updatedAt || current?.createdAt || meta.createdAt || "");
    if (!current || current.state !== "queued" || current.pid || !Number.isFinite(ageMs) || ageMs <= graceMs) return false;
    const now = utcNow();
    writeJson(file, {
      ...current,
      taskId: meta.taskId,
      jobId: meta.jobId,
      state: "failed",
      pid: null,
      blocker: "worker-spawn-lost: queued job never received a worker process",
      recoverable: true,
      finishedAt: now,
      updatedAt: now,
      revision: Number(current.revision || 0) + 1,
    });
    return true;
  });
}

function cleanupAbandonedWorktrees(profileValue) {
  const profile = profileValue || readProfile();
  const root = metadataRoot();
  if (!fs.existsSync(root)) return { inspected: 0, cleaned: 0, reasons: {} };
  const files = fs.readdirSync(root).filter((name) => name.endsWith(".json"));
  const result = { inspected: files.length, cleaned: 0, reasons: {} };
  const terminal = new Set(["completed", "failed", "cancelled", "rejected"]);
  const maxAgeMs = profile.worktreeMaxAgeHours * 60 * 60 * 1000;
  for (const name of files) {
    const meta = readJson(path.join(root, name), null);
    if (!meta) { fs.rmSync(path.join(root, name), { force: true }); continue; }
    const status = jobStatusFor(meta);
    const ageMs = Date.now() - Date.parse(meta.createdAt || "");
    let reason = "";
    if (!status) reason = "missing-job";
    else if (terminal.has(status.state)) reason = "terminal-job";
    else if (status.pid && !processAlive(status.pid)) reason = "lost-worker";
    else if (status.state === "queued" && !status.pid && failAbandonedQueuedJob(meta)) reason = "queued-without-worker";
    else if (Number.isFinite(ageMs) && ageMs > maxAgeMs) reason = "maximum-age";
    if (!reason) continue;
    const cleanup = cleanupIsolatedWorkspace(meta);
    if (cleanup.cleaned) {
      releaseResourceLease(meta.jobId);
      result.cleaned += 1;
      result.reasons[reason] = (result.reasons[reason] || 0) + 1;
    }
  }
  return result;
}

module.exports = {
  TRANSIENT_PATHS,
  assertStorageAvailable,
  cleanTransientOutputs,
  cleanupAbandonedWorktrees,
  cleanupIsolatedWorkspace,
  directoryBytes,
  metadataFile,
  prepareDirectorReadOnlySnapshot,
  prepareDirectorReadOnlyScratch,
  preparePrimaryWorkspace,
  prepareWorkspaceForContract,
  prepareIsolatedWorkspace,
  rollbackPrimaryWorkspace,
  storageStatus,
  worktreeRoot,
};
