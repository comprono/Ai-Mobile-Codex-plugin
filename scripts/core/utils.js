"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

function utcNow() {
  return new Date().toISOString();
}

function bounded(value, max = 4000) {
  const text = String(value ?? "");
  return text.length <= max ? text : `${text.slice(0, max)}\n[truncated ${text.length - max} chars]`;
}

function boundedList(values, maxItems = 20, maxChars = 500) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => bounded(String(value || "").trim(), maxChars))
    .filter(Boolean))].slice(0, maxItems);
}

function safeWorkspace(value) {
  const workspace = path.resolve(String(value || "").trim());
  if (!workspace || workspace === path.parse(workspace).root) throw new Error("A concrete workspace path is required.");
  if (!fs.existsSync(workspace) || !fs.statSync(workspace).isDirectory()) throw new Error(`Workspace does not exist: ${workspace}`);
  return workspace;
}

function isInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function safeRelativePath(workspace, value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const absolute = path.resolve(workspace, raw);
  if (!isInside(workspace, absolute)) throw new Error(`Path leaves the workspace: ${raw}`);
  return path.relative(workspace, absolute).replace(/\\/g, "/") || ".";
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(3).toString("hex")}.tmp`);
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  let lastError;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      fs.renameSync(temp, file);
      return;
    } catch (error) {
      lastError = error;
      if (!["EACCES", "EBUSY", "EPERM", "ENOTEMPTY"].includes(String(error.code || "").toUpperCase())) break;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 * (attempt + 1));
    }
  }
  try { fs.rmSync(temp, { force: true }); } catch { /* preserve original error */ }
  throw lastError;
}

function appendJsonl(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(value)}\n`, "utf8");
}

function readText(file, max = 12000) {
  try {
    return bounded(fs.readFileSync(file, "utf8"), max);
  } catch {
    return "";
  }
}

function commandResult(command, args = [], options = {}) {
  const result = spawnSync(command, args.map(String), {
    cwd: options.cwd,
    env: options.env || process.env,
    input: options.input,
    encoding: "utf8",
    timeout: options.timeout || 10000,
    maxBuffer: options.maxBuffer || 4 * 1024 * 1024,
    windowsHide: true,
    shell: false,
  });
  return {
    status: result.status,
    stdout: String(result.stdout || ""),
    stderr: String(result.stderr || result.error?.message || ""),
    error: result.error || null,
    timedOut: result.error?.code === "ETIMEDOUT",
  };
}

function where(command) {
  const resolver = process.platform === "win32" ? "where.exe" : "which";
  const result = commandResult(resolver, [command], { timeout: 2500 });
  return result.status === 0
    ? result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    : [];
}

function resolveCommand(command, fallbacks = []) {
  const candidates = [...where(command), ...fallbacks].filter(Boolean);
  for (const candidate of candidates) {
    if (path.isAbsolute(candidate) && !fs.existsSync(candidate)) continue;
    const probe = commandResult(candidate, ["--version"], { timeout: 5000 });
    if (probe.status === 0) return { found: true, command: candidate, version: (probe.stdout || probe.stderr).trim() };
  }
  return { found: false, command: "", version: "" };
}

function localDataFile(name) {
  return path.join(process.env.LOCALAPPDATA || os.tmpdir(), "AI Mobile", name);
}

function redact(value) {
  let text = String(value || "");
  text = text.replace(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g, "[REDACTED PRIVATE KEY]");
  text = text.replace(/\b(sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,}|AIza[A-Za-z0-9_-]{20,})\b/g, "[REDACTED TOKEN]");
  text = text.replace(/\b(Bearer\s+)[A-Za-z0-9._~+\/-]{12,}/gi, "$1[REDACTED]");
  text = text.replace(/^([^\r\n]*(?:password|passwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token)[^=:\r\n]*[=:])[ \t]*.*$/gim, "$1 [REDACTED]");
  text = text.replace(/C:\\Users\\[^\\\r\n]+/gi, "%USERPROFILE%");
  return text;
}

function processAlive(pid) {
  const value = Number(pid);
  if (!Number.isInteger(value) || value <= 0) return false;
  try {
    process.kill(value, 0);
    return true;
  } catch {
    return false;
  }
}

function terminateTree(pid) {
  const value = Number(pid);
  if (!Number.isInteger(value) || value <= 0) return { ok: false, reason: "invalid pid" };
  if (!processAlive(value)) return { ok: true, alreadyStopped: true };
  if (process.platform === "win32") {
    const result = commandResult("taskkill.exe", ["/PID", String(value), "/T", "/F"], { timeout: 15000 });
    return { ok: result.status === 0, output: bounded(result.stdout || result.stderr, 800) };
  }
  try {
    process.kill(-value, "SIGTERM");
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error.message };
  }
}

module.exports = {
  appendJsonl,
  bounded,
  boundedList,
  commandResult,
  isInside,
  localDataFile,
  processAlive,
  readJson,
  readText,
  redact,
  resolveCommand,
  safeRelativePath,
  safeWorkspace,
  terminateTree,
  utcNow,
  where,
  writeJson,
};
