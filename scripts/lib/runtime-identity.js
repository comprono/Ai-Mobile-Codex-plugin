"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const PLUGIN_ROOT = path.resolve(__dirname, "..", "..");
const REQUIRED_RUNTIME_FILES = Object.freeze([
  ".codex-plugin/plugin.json",
  ".claude-plugin/plugin.json",
  ".mcp.json",
]);
const RUNTIME_DIRECTORIES = Object.freeze(["agents", "scripts", "skills"]);
const FORBIDDEN_RUNTIME_ARTIFACT = /\.(?:orig|rej)$/i;

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function filesBelow(root, relativeDirectory) {
  const base = path.join(root, relativeDirectory);
  if (!fs.existsSync(base) || !fs.statSync(base).isDirectory()) {
    throw new Error(`AI Mobile runtime directory is missing: ${relativeDirectory}`);
  }
  const files = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) {
        const relative = path.relative(root, absolute).split(path.sep).join("/");
        if (FORBIDDEN_RUNTIME_ARTIFACT.test(relative)) {
          throw new Error(`Forbidden patch artifact is present in the AI Mobile runtime: ${relative}`);
        }
        files.push(relative);
      }
    }
  };
  visit(base);
  return files;
}

function runtimeFileList(root = PLUGIN_ROOT) {
  const files = [
    ...REQUIRED_RUNTIME_FILES,
    ...RUNTIME_DIRECTORIES.flatMap((directory) => filesBelow(root, directory)),
  ];
  return [...new Set(files)].sort();
}

function runtimeFileHashes(root = PLUGIN_ROOT, files = runtimeFileList(root)) {
  return Object.fromEntries(files.map((relative) => {
    const file = path.join(root, ...relative.split("/"));
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
      throw new Error(`AI Mobile runtime file is missing: ${relative}`);
    }
    return [relative, sha256(fs.readFileSync(file))];
  }));
}

function runtimeFingerprint(root = PLUGIN_ROOT) {
  const files = runtimeFileList(root);
  const hashes = runtimeFileHashes(root, files);
  return sha256(files.map((relative) => `${relative}:${hashes[relative]}`).join("\n"));
}

function manifestVersion(root, relative) {
  const file = path.join(root, ...relative.split("/"));
  return JSON.parse(fs.readFileSync(file, "utf8")).version;
}

function verifyRuntimeParity(sourceRoot, installedRoot, expectedVersion, host) {
  const manifest = host === "claude" ? ".claude-plugin/plugin.json" : ".codex-plugin/plugin.json";
  const sourceVersion = manifestVersion(sourceRoot, manifest);
  const installedVersion = manifestVersion(installedRoot, manifest);
  if (sourceVersion !== expectedVersion || installedVersion !== expectedVersion) {
    throw new Error(`${host} AI Mobile version mismatch: expected ${expectedVersion}, source ${sourceVersion}, installed ${installedVersion}.`);
  }
  const sourceFiles = runtimeFileList(sourceRoot);
  const installedFiles = runtimeFileList(installedRoot);
  const missing = sourceFiles.filter((relative) => !installedFiles.includes(relative));
  const unexpected = installedFiles.filter((relative) => !sourceFiles.includes(relative));
  if (missing.length || unexpected.length) {
    throw new Error(`${host} AI Mobile cache file set differs from the source release: missing [${missing.join(", ")}], unexpected [${unexpected.join(", ")}].`);
  }
  const sourceHashes = runtimeFileHashes(sourceRoot, sourceFiles);
  const installedHashes = runtimeFileHashes(installedRoot, sourceFiles);
  const mismatches = sourceFiles.filter((relative) => sourceHashes[relative] !== installedHashes[relative]);
  if (mismatches.length) {
    throw new Error(`${host} AI Mobile cache differs from the source release: ${mismatches.join(", ")}.`);
  }
  return {
    host,
    version: expectedVersion,
    installedRoot,
    runtimeFingerprint: runtimeFingerprint(installedRoot),
    matchedFiles: sourceFiles.length,
  };
}

module.exports = {
  REQUIRED_RUNTIME_FILES,
  runtimeFileList,
  runtimeFileHashes,
  runtimeFingerprint,
  verifyRuntimeParity,
};
