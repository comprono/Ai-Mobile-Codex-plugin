"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { runtimeFileList, runtimeFingerprint, verifyRuntimeParity } = require("./lib/runtime-identity");

const source = path.resolve(__dirname, "..");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-mobile-runtime-parity-"));
const codex = path.join(root, "codex");
const claude = path.join(root, "claude");
const version = JSON.parse(fs.readFileSync(path.join(source, ".codex-plugin", "plugin.json"), "utf8")).version;

function copyRuntime(target) {
  for (const relative of runtimeFileList(source)) {
    const destination = path.join(target, ...relative.split("/"));
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(source, ...relative.split("/")), destination);
  }
}

try {
  copyRuntime(codex);
  copyRuntime(claude);
  const codexProof = verifyRuntimeParity(source, codex, version, "codex");
  const claudeProof = verifyRuntimeParity(source, claude, version, "claude");
  assert.equal(codexProof.runtimeFingerprint, runtimeFingerprint(source));
  assert.equal(claudeProof.runtimeFingerprint, runtimeFingerprint(source));
  fs.appendFileSync(path.join(codex, "scripts", "mcp", "server.js"), "\n// stale cache fixture\n");
  assert.throws(() => verifyRuntimeParity(source, codex, version, "codex"), /cache differs.*server\.js/i);
  const forbiddenArtifact = path.join(claude, "scripts", "core", "temporary-patch.js.orig");
  fs.writeFileSync(forbiddenArtifact, "temporary patch backup\n");
  assert.throws(() => verifyRuntimeParity(source, claude, version, "claude"), /forbidden patch artifact.*temporary-patch\.js\.orig/i);
  fs.rmSync(forbiddenArtifact);
  fs.rmSync(path.join(claude, "scripts", "core", "director-cfo-orchestrator.js"));
  assert.throws(() => verifyRuntimeParity(source, claude, version, "claude"), /file set differs.*missing.*director-cfo-orchestrator/i);
  process.stdout.write(JSON.stringify({ ok: true, version, exactCacheParityRequired: true, runtimeFiles: runtimeFileList(source).length }, null, 2) + "\n");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
