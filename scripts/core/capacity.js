"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { readJson, utcNow, writeJson } = require("./utils");
const { stateRoot } = require("./state-store");

const PROVIDER_IDS = ["codex", "claude", "antigravity", "cursor"];
const POSITIVE_TTL_MS = 5 * 60 * 1000;
const NEGATIVE_TTL_MS = 30 * 1000;

function cacheFile() { return path.join(stateRoot(), "resource-cache.json"); }

function probeProvider(id, timeoutMs = 20000) {
  const script = path.join(__dirname, "..", "providers", "provider-probe.js");
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, id], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* no-op */ }
      finish({ id, available: false, authenticated: false, confidence: "unknown", models: [], reason: `Passive provider probe exceeded ${Math.ceil(timeoutMs / 1000)} seconds; availability is unknown.` });
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => {
      clearTimeout(timer);
      finish({ id, available: false, authenticated: false, confidence: "unknown", models: [], reason: `Passive provider probe could not start: ${error.message}` });
    });
    child.on("close", () => {
      clearTimeout(timer);
      try { finish(JSON.parse(stdout)); }
      catch { finish({ id, available: false, authenticated: false, confidence: "unknown", models: [], reason: `Passive provider probe returned no usable evidence${stderr ? ": " + stderr.slice(0, 200) : "."}` }); }
    });
  });
}

function quotaPools(provider = {}) {
  const windows = Array.isArray(provider.capacity?.windows) ? provider.capacity.windows : [];
  const pools = windows.map((window, index) => ({
    id: String(window.quotaPoolId || window.limitId || window.scope || `window-${index + 1}`),
    scope: String(window.scope || "all"),
    period: String(window.period || window.name || ""),
    remainingPercent: Number.isFinite(Number(window.remainingPercent)) ? Number(window.remainingPercent) : null,
    resetAt: window.resetAt || null,
    source: provider.capacity?.source || "unknown",
  }));
  for (const model of provider.capacity?.models || []) {
    pools.push({
      id: String(model.quotaPoolId || model.id || model.displayName || "model"),
      scope: String(model.scope || model.id || model.displayName || "model"),
      period: "model",
      remainingPercent: Number.isFinite(Number(model.remainingPercent)) ? Number(model.remainingPercent) : null,
      resetAt: model.resetAt || null,
      source: provider.capacity?.source || "unknown",
    });
  }
  return pools;
}

function normalizeProvider(id, raw, observedAt = utcNow(), cached = false) {
  const available = raw?.available === true;
  const authenticated = raw?.authenticated === true;
  const ttlMs = available && authenticated ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS;
  return {
    id,
    ...raw,
    available,
    authenticated,
    models: Array.isArray(raw?.models) ? raw.models : [],
    quotaPools: quotaPools(raw),
    observedAt,
    expiresAt: new Date(Date.parse(observedAt) + ttlMs).toISOString(),
    cached,
  };
}

function resetPassed(provider, nowMs) {
  return (provider?.quotaPools || []).some((pool) => {
    const resetAt = Date.parse(pool.resetAt || "");
    return Number.isFinite(resetAt) && resetAt <= nowMs && resetAt > Date.parse(provider.observedAt || "");
  });
}

function cacheUsable(provider, nowMs) {
  const expiresAt = Date.parse(provider?.expiresAt || "");
  return Number.isFinite(expiresAt) && expiresAt > nowMs && !resetPassed(provider, nowMs);
}

async function inventory(options = {}) {
  const ids = Array.isArray(options.providerIds) && options.providerIds.length
    ? PROVIDER_IDS.filter((id) => options.providerIds.includes(id))
    : PROVIDER_IDS;
  const cachedRecord = readJson(cacheFile(), { schemaVersion: 1, providers: {} });
  const providers = { ...(cachedRecord.providers || {}) };
  const nowMs = Date.now();
  const toProbe = [];

  for (const id of ids) {
    const cached = providers[id];
    const hardNegativeRefresh = options.forDispatch === true && cached && cached.available !== true;
    if (options.refresh === true || hardNegativeRefresh || !cacheUsable(cached, nowMs)) toProbe.push(id);
    else providers[id] = { ...cached, cached: true };
  }

  const prober = typeof options.probe === "function" ? options.probe : probeProvider;
  const rows = await Promise.all(toProbe.map((id) => prober(id, Number(options.timeoutMs || 20000))));
  const observedAt = utcNow();
  rows.forEach((row, index) => {
    const id = toProbe[index];
    providers[id] = normalizeProvider(id, row, observedAt, false);
  });

  const result = {
    schemaVersion: 3,
    generatedAt: utcNow(),
    cached: toProbe.length === 0,
    passive: true,
    machine: {
      logicalCpuCount: os.cpus().length,
      totalRamMb: Math.floor(os.totalmem() / (1024 * 1024)),
      freeRamMb: Math.floor(os.freemem() / (1024 * 1024)),
      observedAt: utcNow(),
    },
    providers,
    guidance: "Capacity is evidence, not a promise. Unknown remains unknown. Desktop applications were not opened.",
  };
  writeJson(cacheFile(), { schemaVersion: 3, generatedAt: result.generatedAt, providers });
  return result;
}

function clearInventoryCache() {
  try { fs.rmSync(cacheFile(), { force: true }); } catch { /* no-op */ }
}

module.exports = {
  NEGATIVE_TTL_MS,
  POSITIVE_TTL_MS,
  PROVIDER_IDS,
  cacheUsable,
  clearInventoryCache,
  inventory,
  normalizeProvider,
  probeProvider,
};
