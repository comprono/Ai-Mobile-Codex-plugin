#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { applyProviderPatch, extractUnifiedDiff } = require("./core/provider-patch");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-mobile-provider-patch-"));
function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stderr || result.stdout || result.error?.message);
}

try {
  fs.writeFileSync(path.join(root, "seed.txt"), "seed\n", "utf8");
  run("git", ["init"]);
  run("git", ["config", "user.email", "patch-regression@example.invalid"]);
  run("git", ["config", "user.name", "AI Mobile Patch Regression"]);
  run("git", ["add", "seed.txt"]);
  run("git", ["commit", "-m", "fixture"]);

  const response = [
    "```diff",
    "diff --git a/result.js b/result.js",
    "new file mode 100644",
    "index 0000000..f70f10e",
    "--- /dev/null",
    "+++ b/result.js",
    "@@ -0,0 +1 @@",
    "+const value = 42;",
    "+module.exports = value;",
    "```",
  ].join("\n");
  assert.ok(extractUnifiedDiff(response).startsWith("diff --git "));
  const applied = applyProviderPatch(root, root, response, ["result.js"]);
  assert.equal(applied.applied, true, JSON.stringify(applied));
  assert.equal(fs.readFileSync(path.join(root, "result.js"), "utf8").replace(/\r\n/g, "\n"), "const value = 42;\nmodule.exports = value;\n");

  const outside = response.replaceAll("result.js", "outside.js");
  const rejected = applyProviderPatch(root, root, outside, ["allowed.js"]);
  assert.equal(rejected.applied, false);
  assert.match(rejected.blocker, /boundary-violation/);
  assert.equal(fs.existsSync(path.join(root, "outside.js")), false);

  const symlink = [
    "diff --git a/link.txt b/link.txt",
    "new file mode 120000",
    "--- /dev/null",
    "+++ b/link.txt",
    "@@ -0,0 +1 @@",
    "+../outside.txt",
  ].join("\n");
  const unsafeMode = applyProviderPatch(root, root, symlink, ["link.txt"]);
  assert.equal(unsafeMode.applied, false);
  assert.match(unsafeMode.blocker, /unsafe-symlink-or-submodule-mode/);
  assert.equal(fs.existsSync(path.join(root, "link.txt")), false);

  process.stdout.write(JSON.stringify({ ok: true, boundedPatchApplied: true, outsidePathRejected: true, unsafeFileModeRejected: true, sandboxBypassUsed: false }, null, 2) + "\n");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}