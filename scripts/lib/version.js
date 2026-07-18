"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { readJson } = require("../core/utils");

const PLUGIN_ROOT = path.resolve(__dirname, "..", "..");

function pluginVersion(root = PLUGIN_ROOT) {
  return readJson(path.join(root, ".codex-plugin", "plugin.json"), {}).version || "unknown";
}

function versionParts(value) {
  const match = String(value || "").match(/^(\d+)\.(\d+)\.(\d+)(?:[-+]([0-9A-Za-z.-]+))?$/);
  if (!match) return null;
  return {
    core: match.slice(1, 4).map(Number),
    suffix: match[4] || "",
  };
}

function comparePluginVersions(left, right) {
  const a = versionParts(left);
  const b = versionParts(right);
  if (!a || !b) return String(left || "").localeCompare(String(right || ""));
  for (let index = 0; index < a.core.length; index += 1) {
    if (a.core[index] !== b.core[index]) return a.core[index] - b.core[index];
  }
  if (a.suffix === b.suffix) return 0;
  if (!a.suffix) return -1;
  if (!b.suffix) return 1;
  return a.suffix.localeCompare(b.suffix, "en", { numeric: true, sensitivity: "base" });
}

function runtimeVersionInfo(root = PLUGIN_ROOT) {
  const parent = path.dirname(root);
  const folderVersion = path.basename(root);
  const manifestVersion = pluginVersion(root);
  const currentVersion = versionParts(folderVersion) ? folderVersion : manifestVersion;

  // Source checkouts are not versioned cache folders and have no stale-task boundary.
  if (path.basename(parent).toLowerCase() !== "ai-mobile") {
    return { stale: false, currentVersion: manifestVersion, newestVersion: manifestVersion };
  }

  let versions = [];
  try {
    versions = fs.readdirSync(parent, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && versionParts(entry.name))
      .map((entry) => entry.name);
  } catch {
    return { stale: false, currentVersion, newestVersion: currentVersion };
  }
  const newestVersion = versions.sort(comparePluginVersions).at(-1) || currentVersion;
  return {
    stale: comparePluginVersions(currentVersion, newestVersion) < 0,
    currentVersion,
    newestVersion,
  };
}

function assertCurrentRuntime(root = PLUGIN_ROOT) {
  const info = runtimeVersionInfo(root);
  if (!info.stale) return info;
  throw new Error(
    "STALE AI MOBILE TASK: this Codex task loaded AI Mobile " + info.currentVersion + ", but " + info.newestVersion + " is installed. "
    + "Stop all AI Mobile calls and do not switch this task to the lightweight console. "
    + "A capable setup model must restart the exact OpenAI.Codex app/task, verify the new runtime version, and only then select the lightweight console. "
    + "Do not create a fresh task, use codex exec resume, retry workers, or claim orchestration here.",
  );}

module.exports = { assertCurrentRuntime, comparePluginVersions, pluginVersion, runtimeVersionInfo };
