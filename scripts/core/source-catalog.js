"use strict";

const crypto = require("node:crypto");
const { bounded, boundedList } = require("./utils");

const SOURCE_TYPES = new Set([
  "project-outcome",
  "acceptance",
  "chat",
  "file",
  "git",
  "log",
  "database",
  "service",
  "browser",
  "external",
]);

const COLLECTION_KEYS = {
  chats: "chat",
  files: "file",
  git: "git",
  logs: "log",
  databases: "database",
  services: "service",
  browsers: "browser",
  external: "external",
};

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

function fingerprint(value, length = 24) {
  return crypto.createHash("sha256").update(JSON.stringify(stable(value))).digest("hex").slice(0, length);
}

function cleanId(value, fallback) {
  return String(value || fallback || "source")
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 100) || fallback || "source";
}

function normalizeAuthorization(value = {}) {
  const allowedTypes = new Set(boundedList(value.allowedTypes || value.allowedSourceTypes, 20, 40).map((row) => row.toLowerCase()));
  if (value.projectContract === true) {
    allowedTypes.add("project-outcome");
    allowedTypes.add("acceptance");
  }
  return {
    scopeId: cleanId(value.scopeId, "project"),
    authorizedBy: bounded(value.authorizedBy || "user-or-project-contract", 160),
    grantRef: bounded(value.grantRef || "", 500),
    allowedTypes,
  };
}

function descriptorLocator(type, row) {
  if (typeof row === "string") return row.trim();
  if (!row || typeof row !== "object") return "";
  const direct = row.locator || row.path || row.ref || row.uri || row.url || row.threadId || row.repository || row.name;
  if (direct) return String(direct).trim();
  if (type === "database") return String(row.database || row.connectionName || "").trim();
  if (type === "service") return String(row.service || row.serviceName || "").trim();
  if (type === "browser") return String(row.session || row.sessionId || "").trim();
  return "";
}

function normalizeDescriptor(type, row, index, authorization) {
  if (!SOURCE_TYPES.has(type)) throw new Error(`Unsupported source type: ${type}`);
  const source = typeof row === "string" ? { locator: row } : row || {};
  const locator = bounded(descriptorLocator(type, source), 1200);
  if (!locator) throw new Error(`${type} source descriptor ${index + 1} requires a locator.`);
  const authorized = source.authorized === true || authorization.allowedTypes.has(type);
  const access = String(source.access || "read").trim().toLowerCase();
  if (!new Set(["read", "metadata", "observe"]).has(access)) throw new Error(`Context source access must be read, metadata, or observe: ${locator}`);
  const id = cleanId(source.id, `${type}-${fingerprint({ type, locator }, 12)}`);
  const descriptor = {
    id,
    type,
    locator,
    access,
    authorized,
    authority: bounded(source.authority || (type === "project-outcome" || type === "acceptance" ? "project-contract" : "user-declared"), 80),
    required: source.required !== false,
    description: bounded(source.description || "", 600),
    revisionHint: bounded(source.revisionHint || source.revision || source.etag || "", 240),
    capabilities: boundedList(source.capabilities, 20, 80),
    collectionPolicy: type === "chat" ? "passed-descriptor-only" : "authorized-descriptor-only",
  };
  return { ...descriptor, descriptorFingerprint: fingerprint(descriptor) };
}

function projectDescriptors(input) {
  const contract = input.projectContract;
  if (!contract) return [];
  const value = contract === true ? {} : contract;
  return [
    { type: "project-outcome", row: { id: value.outcomeId || "project-outcome", locator: value.outcomePath || ".codex/PROJECT_OUTCOME.md", required: true } },
    { type: "acceptance", row: { id: value.acceptanceId || "project-acceptance", locator: value.acceptancePath || ".codex/ACCEPTANCE.json", required: true } },
  ];
}

function createSourceCatalog(input = {}) {
  const authorization = normalizeAuthorization(input.authorization);
  const candidates = projectDescriptors(input);
  for (const [key, type] of Object.entries(COLLECTION_KEYS)) {
    const values = Array.isArray(input[key]) ? input[key] : input[key] ? [input[key]] : [];
    values.forEach((row) => candidates.push({ type, row }));
  }
  const accepted = [];
  const rejected = [];
  const ids = new Set();
  for (let index = 0; index < candidates.length; index += 1) {
    const descriptor = normalizeDescriptor(candidates[index].type, candidates[index].row, index, authorization);
    if (ids.has(descriptor.id)) throw new Error(`Duplicate source id: ${descriptor.id}`);
    ids.add(descriptor.id);
    if (descriptor.authorized) accepted.push(descriptor);
    else rejected.push({ id: descriptor.id, type: descriptor.type, locator: descriptor.locator, reason: "source-type-not-authorized" });
  }
  const catalogBasis = {
    missionId: cleanId(input.missionId, "mission"),
    authorizationScopeId: authorization.scopeId,
    sources: accepted.map(({ descriptorFingerprint, ...row }) => row),
  };
  return {
    schemaVersion: "director-cfo/source-catalog@1",
    missionId: catalogBasis.missionId,
    authorization: {
      scopeId: authorization.scopeId,
      authorizedBy: authorization.authorizedBy,
      grantRef: authorization.grantRef,
      allowedTypes: [...authorization.allowedTypes].sort(),
    },
    sources: accepted,
    rejectedSources: rejected,
    catalogFingerprint: fingerprint(catalogBasis),
    policy: {
      descriptorOnly: true,
      chatDiscoveryAllowed: false,
      undeclaredSourceAccessAllowed: false,
    },
  };
}

function assertCatalog(value) {
  if (!value || value.schemaVersion !== "director-cfo/source-catalog@1") throw new Error("A versioned source catalog is required.");
  const ids = new Set();
  for (const source of value.sources || []) {
    if (!source.authorized) throw new Error(`Unauthorized source entered catalog: ${source.id}`);
    if (!SOURCE_TYPES.has(source.type)) throw new Error(`Unsupported catalog source type: ${source.type}`);
    if (!source.id || ids.has(source.id)) throw new Error(`Invalid or duplicate source id: ${source.id || "missing"}`);
    ids.add(source.id);
  }
  return value;
}

module.exports = {
  SOURCE_TYPES,
  assertCatalog,
  createSourceCatalog,
  fingerprint,
};
