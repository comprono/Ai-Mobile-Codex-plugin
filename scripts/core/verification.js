"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { commandResult, isInside, redact, utcNow, writeJson } = require("./utils");

const ALLOWED = new Set([
  "git", "git.exe", "node", "node.exe", "python", "python.exe", "python3", "python3.exe", "py", "py.exe",
  "pytest", "pytest.exe", "npm", "npm.cmd", "pnpm", "pnpm.cmd", "yarn", "yarn.cmd", "dotnet", "dotnet.exe",
  "go", "go.exe", "cargo", "cargo.exe", "mvn", "mvn.cmd", "gradle", "gradle.bat", "gradlew", "gradlew.bat",
  "powershell", "powershell.exe", "pwsh", "pwsh.exe",
]);

function verificationPlanningGuidance() {
  return "Verification policy: use an allowlisted executable with argument arrays only. Never use inline code flags such as node -e, python -c, or PowerShell -Command. Prefer node <existing-or-expected-script>, python <existing-or-expected-script>, python -m unittest <module>, python -m json.tool <json-file>, or pytest <existing-or-expected-test>. Every directly named script must already exist or be listed in expectedFiles, and every new expected file must have an existing immediate parent directory.";
}

function normalizeCommands(value) {
  return (Array.isArray(value) ? value : []).slice(0, 8).map((entry, index) => ({
    name: String(entry?.name || `verification-${index + 1}`).slice(0, 80),
    command: String(entry?.command || "").trim().slice(0, 260),
    args: (Array.isArray(entry?.args) ? entry.args : []).slice(0, 30).map((arg) => String(arg).slice(0, 1000)),
    timeoutSeconds: Math.max(1, Math.min(900, Number(entry?.timeoutSeconds || 300))),
    expectedExitCode: Math.max(0, Math.min(255, Number(entry?.expectedExitCode ?? 0))),
  })).filter((entry) => entry.command);
}

function validate(workspace, entry) {
  const executable = path.basename(entry.command).toLowerCase();
  if (!ALLOWED.has(executable)) return `Verification executable is not allowlisted: ${entry.command}`;
  if (path.isAbsolute(entry.command) && !isInside(workspace, entry.command)) return "Absolute verification executable leaves the workspace.";
  if (entry.args.some((arg) => /[\r\n\0]/.test(arg))) return "Verification arguments must be single-line values.";
  if (/^node(?:\.exe)?$/.test(executable) && entry.args.some((arg) => /^(?:-e|--eval|-p|--print)$/i.test(arg))) return "Inline Node evaluation is refused.";
  if (/^(?:python|python3|py)(?:\.exe)?$/.test(executable) && entry.args.some((arg) => /^(?:-c|--command)$/i.test(arg))) return "Inline Python execution is refused.";
  if (/^git(?:\.exe)?$/.test(executable) && !["diff", "status", "rev-parse", "ls-files", "log", "show"].includes(String(entry.args[0] || "").toLowerCase())) return "Only read-only git verification commands are allowed.";
  if (/^(?:powershell|pwsh)(?:\.exe)?$/.test(executable)) {
    if (entry.args.some((arg) => /^-(?:command|c|encodedcommand|e)$/i.test(arg))) return "PowerShell verification requires -File; inline commands are refused.";
    const index = entry.args.findIndex((arg) => /^-file$/i.test(arg));
    const script = index >= 0 ? path.resolve(workspace, entry.args[index + 1] || "") : "";
    if (!script || !isInside(workspace, script) || !fs.existsSync(script)) return "PowerShell -File must reference a script inside the workspace.";
  }
  return "";
}

function validateCommands(workspace, commands) {
  const normalized = normalizeCommands(commands);
  const errors = normalized.map((entry) => validate(workspace, entry)).filter(Boolean);
  return { valid: normalized.length > 0 && errors.length === 0, commands: normalized, errors };
}

function runVerification(workspace, jobDir, commands) {
  const normalized = normalizeCommands(commands);
  const checks = [];
  for (const entry of normalized) {
    const error = validate(workspace, entry);
    if (error) {
      checks.push({ ...entry, passed: false, state: "rejected", error });
      break;
    }
    const started = Date.now();
    const result = commandResult(entry.command, entry.args, { cwd: workspace, timeout: entry.timeoutSeconds * 1000, env: { ...process.env, CI: process.env.CI || "1" } });
    const passed = !result.error && result.status === entry.expectedExitCode;
    checks.push({
      name: entry.name,
      command: entry.command,
      args: entry.args,
      durationMs: Date.now() - started,
      expectedExitCode: entry.expectedExitCode,
      exitCode: result.status,
      timedOut: result.timedOut,
      passed,
      stdout: redact(result.stdout).slice(0, 5000),
      stderr: redact(result.stderr).slice(0, 3000),
    });
    if (!passed) break;
  }
  const required = normalized.length > 0;
  const passed = required ? checks.length === normalized.length && checks.every((check) => check.passed) : null;
  const evidence = {
    version: 2,
    state: required ? (passed ? "passed" : "failed") : "not-requested",
    required,
    passed,
    generatedAt: utcNow(),
    checks,
    blocker: checks.find((check) => !check.passed)?.error || (required && !passed ? `Verification failed: ${checks.find((check) => !check.passed)?.name || "unknown"}` : ""),
  };
  writeJson(path.join(jobDir, "verification-evidence.json"), evidence);
  fs.writeFileSync(path.join(jobDir, "test-output-summary.md"), checks.length
    ? `${checks.map((check) => `${check.name}: ${check.passed ? "PASS" : "FAIL"} (exit ${check.exitCode ?? "unknown"}, ${check.durationMs}ms)`).join("\n")}\n`
    : "No deterministic verification requested.\n", "utf8");
  return evidence;
}

module.exports = { normalizeCommands, runVerification, validateCommands, verificationPlanningGuidance };
