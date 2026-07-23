#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { collectSourceSnapshots } = require("./core/context-dossier");
const { verifyContextSnapshotFreshness } = require("./core/context-freshness");
const { createSourceCatalog } = require("./core/source-catalog");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-mobile-context-freshness-"));

function git(args) {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", timeout: 10000, windowsHide: true });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

try {
  fs.mkdirSync(path.join(root, ".codex"), { recursive: true });
  fs.writeFileSync(path.join(root, ".codex", "PROJECT_OUTCOME.md"), "Outcome A\n", "utf8");
  fs.writeFileSync(path.join(root, ".codex", "ACCEPTANCE.json"), "{\"requirements\":[]}\n", "utf8");
  fs.writeFileSync(path.join(root, "chat.md"), "decision one\n", "utf8");
  fs.writeFileSync(path.join(root, "README.md"), "project\n", "utf8");
  fs.writeFileSync(path.join(root, "runtime.log"), "tick 1\n", "utf8");
  fs.writeFileSync(path.join(root, "runtime.db"), "dynamic 1\n", "utf8");
  git(["init"]);
  git(["config", "user.email", "ai-mobile@example.invalid"]);
  git(["config", "user.name", "AI Mobile Regression"]);
  git(["add", ".codex/PROJECT_OUTCOME.md", ".codex/ACCEPTANCE.json", "chat.md", "README.md", "runtime.log", "runtime.db"]);
  git(["commit", "-m", "fixture"]);

  const catalog = createSourceCatalog({
    missionId: "mission-freshness",
    projectContract: true,
    chats: [{ id: "chat", locator: "chat.md" }],
    files: [{ id: "readme", locator: "README.md" }],
    git: [{ id: "repository", locator: "." }],
    logs: [{ id: "runtime-log", locator: "runtime.log" }],
    databases: [{ id: "runtime-db", locator: "runtime.db" }],
    authorization: {
      scopeId: "fixture",
      authorizedBy: "regression",
      grantRef: "fixture",
      projectContract: true,
      allowedTypes: ["project-outcome", "acceptance", "chat", "file", "git", "log", "database"],
    },
  });
  const capturedManifest = collectSourceSnapshots(root, catalog);
  assert.equal(verifyContextSnapshotFreshness({ workspace: root, sourceCatalog: catalog, capturedManifest }).fresh, true);

  fs.appendFileSync(path.join(root, "runtime.log"), "tick 2\n", "utf8");
  fs.appendFileSync(path.join(root, "runtime.db"), "dynamic 2\n", "utf8");
  fs.writeFileSync(path.join(root, "runtime.db-wal"), "dynamic sidecar\n", "utf8");
  const dynamicDrift = verifyContextSnapshotFreshness({ workspace: root, sourceCatalog: catalog, capturedManifest });
  assert.equal(dynamicDrift.fresh, true, "log/database drift must not invalidate a static context snapshot");

  fs.appendFileSync(path.join(root, "chat.md"), "decision two\n", "utf8");
  const staticDrift = verifyContextSnapshotFreshness({ workspace: root, sourceCatalog: catalog, capturedManifest });
  assert.equal(staticDrift.fresh, false, "static project drift must invalidate the worker result");
  assert.ok(staticDrift.changedSourceIds.includes("chat"), "changed static source must be named");
  assert.ok(staticDrift.changedSourceIds.includes("repository"), "Git state drift must be named");

  process.stdout.write(JSON.stringify({ ok: true, dynamicDriftAllowed: true, staticDriftRejected: true, changedSourceIds: staticDrift.changedSourceIds }, null, 2) + "\n");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
