"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { boundaryAllows } = require("./git-evidence");
const { commandResult } = require("./utils");

const MAX_PATCH_BYTES = 100 * 1024;

function extractUnifiedDiff(value) {
  const text = String(value || "").replace(/\r\n/g, "\n").trim();
  if (!text) return "";
  const fence = text.match(/```diff\s*\n([\s\S]*?)```/i);
  let patch = fence ? fence[1].trim() : "";
  if (!patch) {
    const start = text.search(/^diff --git /m);
    if (start >= 0) patch = text.slice(start).trim();
  }
  if (!patch.startsWith("diff --git ")) return "";
  return Buffer.byteLength(patch, "utf8") <= MAX_PATCH_BYTES ? `${patch}\n` : "";
}

function normalizedPatchPath(value) {
  const candidate = String(value || "").replace(/\\/g, "/").replace(/^\.\//, "");
  if (!candidate || candidate.startsWith("/") || /^[A-Za-z]:\//.test(candidate)) return "";
  if (candidate === ".git" || candidate.startsWith(".git/") || candidate.split("/").includes("..")) return "";
  return candidate;
}

function inspectPatch(workspace, patchPath, patch, expectedFiles) {
  if (/^(?:rename|copy) (?:from|to) /m.test(patch) || /^(?:GIT binary patch|Binary files )/m.test(patch)) {
    return { ok: false, blocker: "provider-patch-unsupported-rename-copy-or-binary" };
  }
  if (/^(?:new file mode|old mode|new mode) (?:120000|160000)$/m.test(patch) || /^index [0-9a-f]+\.\.[0-9a-f]+ (?:120000|160000)$/mi.test(patch)) {
    return { ok: false, blocker: "provider-patch-unsafe-symlink-or-submodule-mode" };
  }
  const numstat = commandResult("git", ["-C", workspace, "apply", "--recount", "--numstat", "-z", patchPath], { timeout: 30000, maxBuffer: 1024 * 1024 });
  if (numstat.status !== 0) {
    return { ok: false, blocker: `provider-patch-invalid: ${String(numstat.stderr || numstat.stdout).trim().slice(0, 800)}` };
  }
  const paths = [];
  for (const record of numstat.stdout.split("\0").filter(Boolean)) {
    const columns = record.split("\t");
    const relative = normalizedPatchPath(columns.slice(2).join("\t"));
    if (columns.length < 3 || !relative) return { ok: false, blocker: "provider-patch-path-invalid" };
    paths.push(relative);
  }
  const changedFiles = [...new Set(paths)];
  if (!changedFiles.length) return { ok: false, blocker: "provider-patch-has-no-files" };
  const outside = changedFiles.filter((file) => !boundaryAllows(file, expectedFiles));
  if (outside.length) return { ok: false, blocker: `provider-patch-boundary-violation: ${outside.join(", ")}`, outside };
  return { ok: true, changedFiles };
}

function applyProviderPatch(workspace, outputDirectory, responseText, expectedFiles = []) {
  const patch = extractUnifiedDiff(responseText);
  if (!patch) return { applied: false, blocker: "provider-unified-diff-missing" };
  const patchPath = path.join(outputDirectory, "provider-output.diff");
  fs.writeFileSync(patchPath, patch, "utf8");
  const inspection = inspectPatch(workspace, patchPath, patch, expectedFiles);
  if (!inspection.ok) return { applied: false, patchPath, ...inspection };
  const check = commandResult("git", ["-C", workspace, "apply", "--recount", "--check", "--whitespace=nowarn", patchPath], { timeout: 30000, maxBuffer: 1024 * 1024 });
  if (check.status !== 0) return { applied: false, patchPath, blocker: `provider-patch-check-failed: ${String(check.stderr || check.stdout).trim().slice(0, 800)}` };
  const apply = commandResult("git", ["-C", workspace, "apply", "--recount", "--whitespace=nowarn", patchPath], { timeout: 30000, maxBuffer: 1024 * 1024 });
  if (apply.status !== 0) return { applied: false, patchPath, blocker: `provider-patch-apply-failed: ${String(apply.stderr || apply.stdout).trim().slice(0, 800)}` };
  return { applied: true, patchPath, changedFiles: inspection.changedFiles };
}

module.exports = { applyProviderPatch, extractUnifiedDiff, inspectPatch };