"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { bounded, boundedList, commandResult, fileSha256, safeRelativePath, safeWorkspace } = require("./utils");
const { assertCatalog, fingerprint } = require("./source-catalog");

const OBSERVATION_STATES = new Set(["observed", "unchanged", "unavailable"]);
const LOCAL_SNAPSHOT_TYPES = new Set(["project-outcome", "acceptance", "chat", "file", "git", "log", "database"]);
const GIT_DYNAMIC_TYPES = new Set(["log", "database"]);

function cleanId(value, fallback) {
  return String(value || fallback || "item").trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-|-$/g, "").slice(0, 100) || fallback || "item";
}

function contextGitStatusArgs(workspace, catalog) {
  const exclusions = [];
  for (const source of catalog.sources || []) {
    if (!GIT_DYNAMIC_TYPES.has(source.type)) continue;
    try {
      const relative = safeRelativePath(workspace, source.locator).replace(/\\/g, "/");
      if (!relative || relative === ".") continue;
      exclusions.push(relative);
      if (source.type === "database") exclusions.push(`${relative}-wal`, `${relative}-shm`, `${relative}-journal`);
    } catch { /* an unavailable/out-of-scope dynamic source cannot affect repository status */ }
  }
  return [
    "-C", workspace, "status", "--porcelain=v1", "--untracked-files=all", "--", ".",
    ...[...new Set(exclusions)].sort().map((relative) => `:(exclude,literal)${relative}`),
  ];
}

function normalizeClaims(values, allowedSourceIds, requireCitation) {
  const rows = Array.isArray(values) ? values : values == null ? [] : [values];
  return rows.slice(0, 60).map((value, index) => {
    const row = typeof value === "string" ? { text: value } : value || {};
    const text = bounded(
      row.text || row.claim || row.decision || row.failure || row.summary || row.observation || row.description || "",
      1200,
    ).trim();
    if (!text) return null;
    const sourceValues = row.sourceIds || row.sources || (row.sourceId ? [row.sourceId] : null) || row.sourcesInspected || [];
    const sourceIds = boundedList(Array.isArray(sourceValues) ? sourceValues : [sourceValues], 20, 100);
    const unknown = sourceIds.filter((id) => !allowedSourceIds.has(id));
    if (unknown.length) throw new Error(`Context claim cites an undeclared source: ${unknown[0]}`);
    if (requireCitation && !sourceIds.length) throw new Error(`Context claim ${index + 1} requires at least one authorized source citation.`);
    return { text, sourceIds };
  }).filter(Boolean);
}

function normalizeSourceObservations(values, catalog, expectedSnapshots = {}, databaseObservationReceipts = {}) {
  const allowed = new Map(catalog.sources.map((source) => [source.id, source]));
  const supplied = new Map();
  for (const value of Array.isArray(values) ? values : []) {
    const sourceId = String(value?.sourceId || "").trim();
    if (!allowed.has(sourceId)) throw new Error(`Context scout returned undeclared source: ${sourceId || "missing"}`);
    if (supplied.has(sourceId)) throw new Error(`Context scout returned duplicate source observation: ${sourceId}`);
    const suppliedStatus = String(value?.status || value?.state || "observed").trim().toLowerCase();
    const status = suppliedStatus === "available" ? "observed" : suppliedStatus;
    if (!OBSERVATION_STATES.has(status)) throw new Error(`Invalid source observation status for ${sourceId}: ${status}`);
    const sourceFingerprint = bounded(value?.fingerprint || value?.sourceFingerprint || "", 128).trim();
    const expected = expectedSnapshots[sourceId];
    const sourceType = allowed.get(sourceId).type;
    let queryReceiptFingerprint = bounded(value?.queryReceiptFingerprint || value?.databaseReceiptFingerprint || "", 128).trim();
    const queryReceiptSnapshotHash = bounded(value?.queryReceiptSnapshotHash || value?.databaseSnapshotHash || "", 128).trim().toLowerCase();
    if (expected?.state === "available" && status === "unavailable") throw new Error("Deterministically available source was reported unavailable: " + sourceId);
    if (expected?.state === "available" && sourceFingerprint !== expected.fingerprint) throw new Error("Source observation fingerprint does not match the Director snapshot: " + sourceId);
    if (expected?.state === "unavailable" && status !== "unavailable") throw new Error("Deterministically unavailable source was reported as observed: " + sourceId);
    if (!expected && !LOCAL_SNAPSHOT_TYPES.has(allowed.get(sourceId).type) && status !== "unavailable") {
      throw new Error("Dynamic source " + sourceId + " requires a typed collection receipt before it can be reported as observed.");
    }
    if (status !== "unavailable" && !sourceFingerprint) throw new Error(`Source observation ${sourceId} requires a source fingerprint.`);
    if (sourceType === "database" && expected?.state === "available") {
      const receipt = databaseObservationReceipts[sourceId];
      if (!receipt) throw new Error(`Database source ${sourceId} has no Director query receipt expectation.`);
      const expectedSnapshotHash = String(expected.contentHash || "").trim().toLowerCase();
      const receiptSnapshotHash = String(receipt.snapshotContentHash || "").trim().toLowerCase();
      if (!/^[a-f0-9]{64}$/.test(receiptSnapshotHash) || receiptSnapshotHash !== expectedSnapshotHash) {
        throw new Error(`Database query receipt snapshot does not match the Director snapshot: ${sourceId}`);
      }
      const expectedReceiptFingerprint = String(receipt.receiptFingerprint || "").trim();
      if (status !== "unavailable" && queryReceiptSnapshotHash !== receiptSnapshotHash) {
        throw new Error("Database query receipt snapshot hash does not match the Director snapshot: " + sourceId);
      }
      const descriptorFingerprint = String(allowed.get(sourceId).descriptorFingerprint || "").trim();
      if (status !== "unavailable" && queryReceiptFingerprint && queryReceiptFingerprint !== expectedReceiptFingerprint && queryReceiptFingerprint !== descriptorFingerprint && queryReceiptFingerprint !== sourceFingerprint) {
        throw new Error("Database query receipt does not match the Director receipt: " + sourceId);
      }
      if (status !== "unavailable") {
        queryReceiptFingerprint = expectedReceiptFingerprint;
      }
    }
    supplied.set(sourceId, {
      sourceId,
      status,
      fingerprint: sourceFingerprint,
      queryReceiptFingerprint: sourceType === "database" ? queryReceiptFingerprint : "",
      queryReceiptSnapshotHash: sourceType === "database" ? queryReceiptSnapshotHash : "",
      revision: bounded(value?.revision || "", 240),
      summary: bounded(value?.summary || value?.observation || "", 1200),
      error: status === "unavailable" ? bounded(value?.error || value?.reason || value?.observation || "unavailable", 600) : "",
    });
  }
  for (const source of catalog.sources) {
    if (source.required && !supplied.has(source.id)) throw new Error(`Context scout omitted required source: ${source.id}`);
  }
  return [...supplied.values()].sort((left, right) => left.sourceId.localeCompare(right.sourceId));
}

function buildContextScoutPrompt(contract) {
  const sourceLines = contract.sourceCatalog.sources.map((source) => (
    `- ${source.id} [${source.type}/${source.access}] ${source.locator}${source.required ? " (required)" : ""}${source.observationReceipt?.path ? `; read-only observation receipt ${source.observationReceipt.path}` : ""}`
  ));
  return [
    "You are the context team, not a project implementation worker.",
    `Recover the real project context for mission ${contract.mission.id} revision ${contract.mission.revision}.`,
    "Inspect only the authorized descriptors below. Do not discover, infer access to, or cite another chat, file, service, browser, database, or external source.",
    ...sourceLines,
    "Separate cited facts and decisions from assumptions and unknowns. Mark inaccessible required sources as unavailable; never fabricate their contents.",
    "For every Director-snapshotted source, copy the exact supplied fingerprint into sourceObservations. Dynamic sources without a Director snapshot must be marked unavailable; never invent a fingerprint or claim a live observation.",
    "For a database source, do not parse the SQLite binary and do not run a command. Read its authorized JSON observation receipt with file tools. Copy receiptFingerprint into queryReceiptFingerprint and snapshot.contentHash into queryReceiptSnapshotHash. Cite that database source in at least one currentState, facts, decisions, or failures claim that states something learned from the receipt.",
    "Use exactly these item keys: sourceObservations entries are {sourceId,status,fingerprint,queryReceiptFingerprint,queryReceiptSnapshotHash,revision,summary,error}, where status is observed, unchanged, or unavailable; every claim entry is {text,sourceIds:[...]}. Use empty receipt fields for non-database or unavailable sources.",
    "Director source snapshot manifest:\n" + JSON.stringify(contract.sourceSnapshotManifest),
    "Return one JSON context-scout artifact matching artifactContract. Keep it compact and source every fact, decision, current-state claim, and recorded failure by source id.",
  ].join("\n");
}

function createContextScoutWorkPackage(input = {}) {
  const catalog = assertCatalog(input.sourceCatalog);
  const mission = input.mission || {};
  const id = cleanId(mission.id || input.missionId, "mission");
  const revision = Number(mission.revision ?? input.missionRevision);
  const outcome = bounded(mission.outcome || input.outcome || "", 6000).trim();
  if (!Number.isInteger(revision) || revision < 1) throw new Error("Context scout requires a positive mission revision.");
  if (!outcome) throw new Error("Context scout requires the authoritative mission outcome.");
  if (catalog.missionId !== id) throw new Error("Source catalog mission id does not match the context mission.");
  const snapshotManifest = input.sourceSnapshotManifest || collectSourceSnapshots(input.workspace, catalog);
  const contract = {
    schemaVersion: "director-cfo/context-scout-work-package@1",
    workType: "context-investigation",
    mission: { id, revision, outcome },
    sourceCatalog: catalog,
    previousContext: input.previousDossier ? {
      revision: Number(input.previousDossier.contextRevision || 0),
      fingerprint: String(input.previousDossier.contextFingerprint || ""),
    } : null,
    refresh: input.refreshDecision || { mode: "full", changedSourceIds: catalog.sources.map((source) => source.id) },
    sourceSnapshotManifest: snapshotManifest,
    limits: {
      maxArtifactChars: Math.max(4000, Math.min(100000, Number(input.maxArtifactChars || 30000))),
      maxClaimsPerSection: 60,
    },
    artifactContract: {
      kind: "context-scout",
      required: ["realGoal", "executiveSummary", "currentState", "sourceObservations", "facts", "assumptions", "unknowns", "constraints", "decisions", "failures", "risks"],
      citedSections: ["currentState", "facts", "decisions", "failures"],
      allowedSourceIds: catalog.sources.map((source) => source.id),
    },
  };
  return { ...contract, prompt: buildContextScoutPrompt(contract), contractFingerprint: fingerprint(contract) };
}

function normalizeContextScoutArtifact(rawValue, workPackage, validation = {}) {
  if (!workPackage || workPackage.schemaVersion !== "director-cfo/context-scout-work-package@1") throw new Error("A context scout work package is required.");
  const raw = rawValue?.artifact || rawValue || {};
  if (raw.kind && !["context-scout", "context-dossier"].includes(raw.kind)) throw new Error(`Unexpected context artifact kind: ${raw.kind}`);
  const catalog = assertCatalog(workPackage.sourceCatalog);
  const allowedSourceIds = new Set(catalog.sources.map((source) => source.id));
  const realGoal = bounded(raw.realGoal || "", 6000).trim();
  const executiveSummary = bounded(raw.executiveSummary || raw.summary || "", 6000).trim();
  if (!realGoal || !executiveSummary) throw new Error("Context artifact requires realGoal and executiveSummary.");
  const expectedSnapshots = Object.fromEntries((workPackage.sourceSnapshotManifest?.snapshots || []).map((row) => [row.sourceId, row]));
  const databaseObservationReceipts = validation.databaseObservationReceipts || {};
  const sourceObservations = normalizeSourceObservations(raw.sourceObservations, catalog, expectedSnapshots, databaseObservationReceipts);
  const currentState = normalizeClaims(raw.currentState, allowedSourceIds, true);
  const facts = normalizeClaims(raw.facts, allowedSourceIds, true);
  const decisions = normalizeClaims(raw.decisions, allowedSourceIds, true);
  const failures = normalizeClaims(raw.failures, allowedSourceIds, true);
  const receiptBackedDatabaseIds = sourceObservations
    .filter((row) => row.queryReceiptFingerprint)
    .map((row) => row.sourceId);
  const citedClaimSourceIds = new Set([...currentState, ...facts, ...decisions, ...failures].flatMap((row) => row.sourceIds));
  const uncitedDatabaseId = receiptBackedDatabaseIds.find((sourceId) => !citedClaimSourceIds.has(sourceId));
  if (uncitedDatabaseId) {
    throw new Error(`Database source ${uncitedDatabaseId} requires a query-receipt-backed cited claim.`);
  }
  const dossierBasis = {
    mission: { ...workPackage.mission },
    catalogFingerprint: catalog.catalogFingerprint,
    realGoal,
    executiveSummary,
    currentState,
    facts,
    decisions,
    failures,
    assumptions: normalizeClaims(raw.assumptions, allowedSourceIds, false),
    unknowns: normalizeClaims(raw.unknowns, allowedSourceIds, false),
    constraints: normalizeClaims(raw.constraints, allowedSourceIds, false),
    risks: normalizeClaims(raw.risks, allowedSourceIds, false),
    acceptanceState: normalizeClaims(raw.acceptanceState, allowedSourceIds, false),
    sourceObservations,
  };
  const previousRevision = Number(workPackage.previousContext?.revision || 0);
  return {
    schemaVersion: "director-cfo/context-dossier@1",
    contextRevision: previousRevision + 1,
    ...dossierBasis,
    sourceFingerprints: Object.fromEntries(sourceObservations.filter((row) => row.fingerprint).map((row) => [row.sourceId, row.fingerprint])),
    contextFingerprint: fingerprint(dossierBasis),
    compact: true,
  };
}

function fingerprintSourceSnapshots(catalogValue, snapshots = []) {
  const catalog = assertCatalog(catalogValue);
  const allowed = new Set(catalog.sources.map((source) => source.id));
  const output = {};
  for (const snapshot of Array.isArray(snapshots) ? snapshots : []) {
    const sourceId = String(snapshot?.sourceId || "").trim();
    if (!allowed.has(sourceId)) throw new Error(`Cannot fingerprint undeclared source snapshot: ${sourceId || "missing"}`);
    if (Object.prototype.hasOwnProperty.call(output, sourceId)) throw new Error(`Duplicate source snapshot: ${sourceId}`);
    const declaredHash = String(snapshot?.contentHash || snapshot?.etag || snapshot?.fingerprint || "").trim();
    const basis = declaredHash ? { sourceId, declaredHash } : {
      sourceId,
      revision: String(snapshot?.revision || ""),
      modifiedAt: String(snapshot?.modifiedAt || snapshot?.mtime || ""),
      size: Number.isFinite(Number(snapshot?.size)) ? Number(snapshot.size) : null,
      state: String(snapshot?.state || "available"),
    };
    output[sourceId] = fingerprint(basis);
  }
  return output;
}

function collectSourceSnapshots(workspaceValue, catalogValue) {
  const catalog = assertCatalog(catalogValue);
  const workspace = safeWorkspace(workspaceValue);
  const snapshots = [];
  for (const source of catalog.sources) {
    if (!LOCAL_SNAPSHOT_TYPES.has(source.type)) continue;
    if (source.type === "git") {
      const gitEnv = { ...process.env, GIT_OPTIONAL_LOCKS: "0" };
      const head = commandResult("git", ["-C", workspace, "rev-parse", "HEAD"], { timeout: 5000, env: gitEnv });
      const branch = commandResult("git", ["-C", workspace, "branch", "--show-current"], { timeout: 5000, env: gitEnv });
      const status = commandResult("git", contextGitStatusArgs(workspace, catalog), { timeout: 30000, maxBuffer: 4 * 1024 * 1024, env: gitEnv });
      if (head.status === 0 && branch.status === 0 && status.status === 0) {
        snapshots.push({
          sourceId: source.id,
          state: "available",
          contentHash: fingerprint({ head: head.stdout.trim(), branch: branch.stdout.trim(), status: status.stdout }),
          revision: head.stdout.trim(),
        });
      } else {
        snapshots.push({ sourceId: source.id, state: "unavailable", error: bounded(head.stderr || branch.stderr || status.stderr || "git snapshot unavailable", 600) });
      }
      continue;
    }
    let relative;
    try {
      relative = safeRelativePath(workspace, source.locator);
    } catch {
      snapshots.push({ sourceId: source.id, state: "unavailable", error: "source locator is outside the authorized workspace" });
      continue;
    }
    const absolute = path.join(workspace, relative);
    try {
      const stat = fs.statSync(absolute);
      if (!stat.isFile()) throw new Error("source is not a file");
      snapshots.push({
        sourceId: source.id,
        state: "available",
        size: stat.size,
        modifiedAt: stat.mtime.toISOString(),
        revision: source.revisionHint || "",
        contentHash: fileSha256(absolute),
      });
    } catch (error) {
      snapshots.push({ sourceId: source.id, state: "unavailable", error: bounded(error.message, 600) });
    }
  }
  const fingerprints = fingerprintSourceSnapshots(catalog, snapshots);
  return {
    schemaVersion: "director-cfo/source-snapshot-manifest@1",
    workspace,
    snapshots: snapshots.map((row) => ({ ...row, fingerprint: fingerprints[row.sourceId] })),
    fingerprint: fingerprint({ catalogFingerprint: catalog.catalogFingerprint, fingerprints }),
  };
}

function decideContextRefresh(input = {}) {
  const catalog = assertCatalog(input.sourceCatalog);
  const previous = input.previousDossier || null;
  const current = input.currentSourceFingerprints || {};
  const allCurrentIds = Object.keys(current).sort();
  const full = (reasonCodes, changedSourceIds = catalog.sources.map((source) => source.id)) => ({
    schemaVersion: "director-cfo/context-refresh-decision@1",
    mode: "full",
    refreshRequired: true,
    reasonCodes,
    changedSourceIds: [...new Set(changedSourceIds)].sort(),
  });
  if (!previous) return full(["no-previous-dossier"]);
  if (input.forceFull === true) return full(["explicit-full-refresh"]);
  if (Number(input.repeatedFailureCount || 0) >= 2 || input.strategicFailure === true) return full(["repeated-or-strategic-failure"]);
  if (Number(previous.mission?.revision || 0) !== Number(input.missionRevision || previous.mission?.revision || 0)) return full(["mission-revision-changed"]);

  const previousCatalogIds = new Set(Object.keys(previous.sourceFingerprints || {}));
  const catalogIds = new Set(catalog.sources.map((source) => source.id));
  const removed = [...previousCatalogIds].filter((id) => !catalogIds.has(id));
  if (removed.length) return full(["source-authorization-removed"], removed);
  const added = [...catalogIds].filter((id) => !previousCatalogIds.has(id));
  const changed = allCurrentIds.filter((id) => previous.sourceFingerprints?.[id] !== current[id]);
  const changedSourceIds = [...new Set([...added, ...changed])].sort();
  const catalogChanged = previous.catalogFingerprint !== catalog.catalogFingerprint;
  if (changedSourceIds.length || catalogChanged) {
    return {
      schemaVersion: "director-cfo/context-refresh-decision@1",
      mode: "incremental",
      refreshRequired: true,
      reasonCodes: [...(added.length ? ["authorized-source-added"] : []), ...(changed.length ? ["source-fingerprint-changed"] : []), ...(catalogChanged ? ["catalog-descriptor-changed"] : [])],
      changedSourceIds,
    };
  }
  return {
    schemaVersion: "director-cfo/context-refresh-decision@1",
    mode: "none",
    refreshRequired: false,
    reasonCodes: ["context-fingerprints-current"],
    changedSourceIds: [],
  };
}

module.exports = {
  buildContextScoutPrompt,
  collectSourceSnapshots,
  contextGitStatusArgs,
  createContextScoutWorkPackage,
  decideContextRefresh,
  fingerprintSourceSnapshots,
  normalizeContextScoutArtifact,
};
