"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { commandResult, isInside, redact } = require("./utils");

function statusPaths(workspace) {
  const result = commandResult("git", ["-C", workspace, "status", "--porcelain=v1", "-z", "--", ".", ":(exclude).ai-mobile/**", ":(exclude).antigravity-bridge/**"], { timeout: 15000 });
  if (result.status !== 0) return { available: false, paths: [], raw: "" };
  const rows = result.stdout.split("\0").filter(Boolean);
  const paths = rows.map((row) => row.slice(3).split(" -> ").pop().replace(/\\/g, "/")).filter(Boolean);
  return { available: true, paths: [...new Set(paths)], raw: rows.join("\n") };
}

function walkBoundary(workspace, relative, output, limit) {
  if (output.length >= limit) return;
  const absolute = path.resolve(workspace, relative);
  if (!isInside(workspace, absolute) || !fs.existsSync(absolute)) return;
  const stat = fs.statSync(absolute);
  if (stat.isDirectory()) {
    for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
      if ([".git", ".ai-mobile", ".antigravity-bridge", "node_modules", ".venv", "dist", "build"].includes(entry.name)) continue;
      walkBoundary(workspace, path.relative(workspace, path.join(absolute, entry.name)), output, limit);
      if (output.length >= limit) break;
    }
    return;
  }
  if (!stat.isFile()) return;
  const hash = stat.size <= 2 * 1024 * 1024
    ? crypto.createHash("sha256").update(fs.readFileSync(absolute)).digest("hex")
    : `${stat.size}:${stat.mtimeMs}`;
  output.push([path.relative(workspace, absolute).replace(/\\/g, "/"), hash]);
}

function fingerprint(workspace, boundaries = [], limit = 1000) {
  const entries = [];
  for (const boundary of boundaries) walkBoundary(workspace, boundary, entries, limit);
  return Object.fromEntries(entries);
}

function changedFingerprints(before = {}, after = {}) {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((file) => before[file] !== after[file]);
}

function collectDiff(workspace, files = []) {
  const boundedFiles = [...new Set(files)].slice(0, 100);
  if (!boundedFiles.length) return "";
  const result = commandResult("git", ["-C", workspace, "diff", "--no-ext-diff", "HEAD", "--", ...boundedFiles], { timeout: 30000, maxBuffer: 3 * 1024 * 1024 });
  return result.status === 0 ? redact(result.stdout).slice(0, 50000) : "";
}

function boundaryAllows(file, boundaries = []) {
  const normalized = file.replace(/\\/g, "/").replace(/^\.\//, "");
  return boundaries.some((boundary) => {
    const candidate = String(boundary || "").replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, "");
    return candidate && (normalized === candidate || normalized.startsWith(`${candidate}/`));
  });
}

module.exports = { boundaryAllows, changedFingerprints, collectDiff, fingerprint, statusPaths };
