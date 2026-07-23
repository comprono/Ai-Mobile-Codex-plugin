"use strict";

const { collectSourceSnapshots } = require("./context-dossier");
const { assertCatalog, fingerprint } = require("./source-catalog");

const STATIC_CONTEXT_TYPES = new Set(["project-outcome", "acceptance", "chat", "file", "git"]);

function rowsBySource(manifest = {}) {
  return new Map((manifest.snapshots || []).map((row) => [String(row?.sourceId || ""), row]));
}

function verifyContextSnapshotFreshness(input = {}) {
  const catalog = assertCatalog(input.sourceCatalog);
  const capturedManifest = input.capturedManifest;
  if (!capturedManifest || capturedManifest.schemaVersion !== "director-cfo/source-snapshot-manifest@1") {
    throw new Error("context-static-freshness-missing-captured-manifest");
  }
  const currentManifest = collectSourceSnapshots(input.workspace, catalog);
  const captured = rowsBySource(capturedManifest);
  const current = rowsBySource(currentManifest);
  const changes = [];
  const capturedStatic = {};
  const currentStatic = {};
  for (const source of catalog.sources || []) {
    if (!STATIC_CONTEXT_TYPES.has(source.type)) continue;
    const expected = captured.get(source.id);
    const observed = current.get(source.id);
    capturedStatic[source.id] = { state: String(expected?.state || ""), fingerprint: String(expected?.fingerprint || "") };
    currentStatic[source.id] = { state: String(observed?.state || ""), fingerprint: String(observed?.fingerprint || "") };
    let reason = "";
    if (!expected) reason = "missing-captured-snapshot";
    else if (!observed) reason = "missing-current-snapshot";
    else if (String(expected.state || "") !== String(observed.state || "")) reason = "availability-changed";
    else if (String(expected.fingerprint || "") !== String(observed.fingerprint || "")) reason = "content-changed";
    if (reason) {
      changes.push({
        sourceId: source.id,
        sourceType: source.type,
        reason,
        capturedFingerprint: String(expected?.fingerprint || ""),
        currentFingerprint: String(observed?.fingerprint || ""),
      });
    }
  }
  return {
    schemaVersion: "director-cfo/context-static-freshness@1",
    fresh: changes.length === 0,
    changedSourceIds: changes.map((row) => row.sourceId),
    changes,
    currentManifest,
    stateFingerprint: fingerprint({
      catalogFingerprint: catalog.catalogFingerprint,
      capturedStatic,
      currentStatic,
      changes,
    }),
  };
}

module.exports = { STATIC_CONTEXT_TYPES, verifyContextSnapshotFreshness };
