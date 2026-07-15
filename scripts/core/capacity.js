"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { localDataFile, readJson, utcNow, writeJson } = require("./utils");

const CACHE = localDataFile("resource-cache-v3.json");

function probeProvider(id, timeoutMs = 16000) {
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
    child.on("error", () => { clearTimeout(timer); finish({ id, available: false, authenticated: false, confidence: "unknown", models: [], reason: "Passive provider probe could not start; availability is unknown." }); });
    child.on("close", () => {
      clearTimeout(timer);
      try { finish(JSON.parse(stdout)); } catch { finish({ id, available: false, authenticated: false, confidence: "unknown", models: [], reason: `Passive provider probe returned no usable evidence${stderr ? "." : ""}` }); }
    });
  });
}

async function discoverParallel() {
  const ids = ["codex", "claude", "antigravity", "cursor"];
  const rows = await Promise.all(ids.map((id) => probeProvider(id)));
  return Object.fromEntries(rows.map((row, index) => [ids[index], { ...row, observedAt: row.observedAt || utcNow() }]));
}

async function inventory(options = {}) {
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
  const providers = await discoverParallel();
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
