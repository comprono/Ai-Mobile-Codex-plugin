"use strict";

const fs = require("node:fs");
const { discoverAll } = require("../providers");
const { localDataFile, readJson, utcNow, writeJson } = require("./utils");

const CACHE = localDataFile("resource-cache-v2.json");

function inventory(options = {}) {
  const maxAgeMs = Math.max(0, Number(options.maxAgeSeconds ?? 3600)) * 1000;
  const cached = readJson(CACHE, null);
  const generatedAt = Date.parse(cached?.generatedAt || "") || 0;
  const resetPassed = Object.values(cached?.providers || {}).some((provider) => {
    const windows = provider?.capacity?.windows || [];
    return windows.some((window) => {
      const resetAt = Date.parse(window.resetAt || "") || 0;
      return resetAt > generatedAt && resetAt <= Date.now();
    });
  });
  if (!options.refresh && cached && !resetPassed && Date.now() - generatedAt <= maxAgeMs) return { ...cached, cached: true };
  const providers = discoverAll();
  const result = {
    schemaVersion: 2, generatedAt: utcNow(), cached: false, passive: true,
    providers,
    guidance: "Use exact evidence only. Unknown quota stays unknown; no desktop app was opened.",
  };
  writeJson(CACHE, result);
  return result;
}

function clearInventoryCache() { try { fs.rmSync(CACHE, { force: true }); } catch { /* no-op */ } }

module.exports = { clearInventoryCache, inventory };
