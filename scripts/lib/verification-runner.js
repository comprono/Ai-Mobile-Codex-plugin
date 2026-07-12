"use strict";

const fs = require("node:fs");
const path = require("node:path");

const allowedExecutables = new Set([
  "git", "git.exe",
  "node", "node.exe",
  "python", "python.exe", "python3", "python3.exe", "py", "py.exe", "pytest", "pytest.exe",
  "npm", "npm.cmd", "pnpm", "pnpm.cmd", "yarn", "yarn.cmd",
  "dotnet", "dotnet.exe", "go", "go.exe", "cargo", "cargo.exe",
  "mvn", "mvn.cmd", "gradle", "gradle.bat", "gradlew", "gradlew.bat",
  "powershell", "powershell.exe", "pwsh", "pwsh.exe",
]);

function normalizeVerificationCommands(value, truncate = (text) => String(text || "")) {
  return (Array.isArray(value) ? value : [])
    .filter((entry) => entry && typeof entry === "object" && !Array.isArray(entry))
    .slice(0, 8)
    .map((entry, index) => ({
      name: truncate(String(entry.name || `verification-${index + 1}`).trim(), 80),
      command: truncate(String(entry.command || "").trim(), 260),
      args: (Array.isArray(entry.args) ? entry.args : []).slice(0, 30).map((argument) => truncate(String(argument), 1000)),
      timeoutSeconds: Math.max(1, Math.min(900, Number(entry.timeoutSeconds || 300))),
      expectedExitCode: Math.max(0, Math.min(255, Number(entry.expectedExitCode ?? 0))),
    }))
    .filter((entry) => entry.command);
}

function createVerificationRunner(dependencies = {}) {
  const {
    collectGitState,
    isPathInside,
    redact,
    runCommand,
    truncate,
    utcStamp,
    writeJson,
  } = dependencies;
  for (const [name, dependency] of Object.entries({ collectGitState, isPathInside, redact, runCommand, truncate, utcStamp, writeJson })) {
    if (typeof dependency !== "function") throw new Error(`verification-runner requires ${name}`);
  }

  function normalize(value) {
    return normalizeVerificationCommands(value, truncate);
  }

  function validate(workspace, entry = {}) {
    const command = String(entry.command || "").trim();
    const executable = path.basename(command).toLowerCase();
    if (!allowedExecutables.has(executable)) {
      return { ok: false, reason: `Verification executable is not allowlisted: ${command || "<empty>"}` };
    }
    if (path.isAbsolute(command) && !isPathInside(workspace, command)) {
      return { ok: false, reason: "Absolute verification executables must be inside the workspace; use a PATH command for installed runtimes." };
    }
    const args = Array.isArray(entry.args) ? entry.args.map((value) => String(value)) : [];
    if (args.some((value) => value.length > 1000 || /[\r\n\u0000]/.test(value))) {
      return { ok: false, reason: "Verification arguments must be bounded single-line values." };
    }
    if (/^node(?:\.exe)?$/i.test(executable) && args.some((value) => /^(?:-e|--eval|-p|--print)$/i.test(value))) {
      return { ok: false, reason: "Node verification must execute or check a workspace script; inline evaluation is refused." };
    }
    if (/^(?:python|python3|py)(?:\.exe)?$/i.test(executable) && args.some((value) => /^(?:-c|--command)$/i.test(value))) {
      return { ok: false, reason: "Python verification must execute a workspace script or module; inline code is refused." };
    }
    if (/^git(?:\.exe)?$/i.test(executable) && !["diff", "status", "rev-parse", "ls-files", "log", "show"].includes(String(args[0] || "").toLowerCase())) {
      return { ok: false, reason: "Git verification permits read-only inspection commands only." };
    }
    if (/^(?:npm|pnpm|yarn)(?:\.cmd)?$/i.test(executable) && !["test", "run"].includes(String(args[0] || "").toLowerCase())) {
      return { ok: false, reason: "Package-manager verification permits existing test/run scripts only." };
    }
    if (/^dotnet(?:\.exe)?$/i.test(executable) && !["test", "build"].includes(String(args[0] || "").toLowerCase())) {
      return { ok: false, reason: "dotnet verification permits test or build only." };
    }
    if (/^go(?:\.exe)?$/i.test(executable) && !["test", "vet"].includes(String(args[0] || "").toLowerCase())) {
      return { ok: false, reason: "Go verification permits test or vet only." };
    }
    if (/^cargo(?:\.exe)?$/i.test(executable) && !["test", "check"].includes(String(args[0] || "").toLowerCase())) {
      return { ok: false, reason: "Cargo verification permits test or check only." };
    }
    if (/^(?:powershell|pwsh)(?:\.exe)?$/i.test(executable)) {
      if (args.some((value) => /^-(?:command|c|encodedcommand|e)$/i.test(value))) {
        return { ok: false, reason: "PowerShell verification permits -File only; inline or encoded commands are refused." };
      }
      const fileIndex = args.findIndex((value) => /^-file$/i.test(value));
      const script = fileIndex >= 0 ? args[fileIndex + 1] : "";
      const scriptPath = script ? path.resolve(workspace, script) : "";
      if (!script || !isPathInside(workspace, scriptPath) || !fs.existsSync(scriptPath)) {
        return { ok: false, reason: "PowerShell verification requires -File followed by an existing script inside the workspace." };
      }
    }
    return { ok: true, command, args };
  }

  function writeSkipped(jobDir, args = {}, reason = "worker result did not pass pre-verification gates") {
    const commands = normalize(args.verificationCommands);
    const evidence = {
      version: 1,
      state: commands.length ? "skipped" : "not-requested",
      required: commands.length > 0,
      passed: commands.length ? false : null,
      generatedAt: utcStamp(),
      requestHash: String(args.verificationRequestHash || ""),
      blocker: commands.length ? reason : "",
      checks: [],
    };
    writeJson(path.join(jobDir, "verification-evidence.json"), evidence);
    fs.appendFileSync(path.join(jobDir, "test-output-summary.md"), [
      "",
      "BridgeDeterministicVerification:",
      `Required: ${evidence.required}`,
      `State: ${evidence.state}`,
      evidence.blocker ? `Blocker: ${evidence.blocker}` : null,
      "",
    ].filter((line) => line !== null).join("\n"), "utf8");
    return evidence;
  }

  function run(workspace, jobDir, args = {}, gitOutcome = {}) {
    const commands = normalize(args.verificationCommands);
    const evidencePath = path.join(jobDir, "verification-evidence.json");
    const summaryPath = path.join(jobDir, "test-output-summary.md");
    if (!commands.length) {
      const evidence = { version: 1, state: "not-requested", required: false, passed: null, generatedAt: utcStamp(), requestHash: String(args.verificationRequestHash || ""), checks: [] };
      writeJson(evidencePath, evidence);
      fs.appendFileSync(summaryPath, "\nBridgeDeterministicVerification:\nRequired: false\nState: not-requested\n", "utf8");
      return evidence;
    }

    const before = collectGitState(workspace);
    const checks = [];
    for (const entry of commands) {
      const validated = validate(workspace, entry);
      if (!validated.ok) {
        checks.push({ name: entry.name, command: entry.command, args: entry.args, state: "rejected", passed: false, error: validated.reason });
        break;
      }
      let commandArgs = validated.args;
      if (/^git(?:\.exe)?$/i.test(path.basename(validated.command))
        && JSON.stringify(commandArgs) === JSON.stringify(["diff", "--check"])
        && (gitOutcome.changedDuringRun || []).length) {
        commandArgs = [...commandArgs, "--", ...(gitOutcome.changedDuringRun || [])];
      }
      const startedAt = utcStamp();
      const startedMs = Date.now();
      const result = runCommand(validated.command, commandArgs, {
        cwd: workspace,
        timeout: entry.timeoutSeconds * 1000,
        maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, CI: process.env.CI || "1" },
      });
      const expectedExitCode = Number(entry.expectedExitCode ?? 0);
      const timedOut = result.error?.code === "ETIMEDOUT";
      const passed = !result.error && result.status === expectedExitCode;
      checks.push({
        name: entry.name,
        command: validated.command,
        args: commandArgs.map((value) => truncate(redact(value), 300)),
        startedAt,
        durationMs: Date.now() - startedMs,
        expectedExitCode,
        exitCode: result.status,
        timedOut,
        passed,
        stdout: truncate(redact(String(result.stdout || "").trim()), 5000),
        stderr: truncate(redact(String(result.stderr || result.error?.message || "").trim()), 3000),
      });
      if (!passed) break;
    }
    const after = collectGitState(workspace);
    const workspaceMutationDetected = before.available && after.available && (before.status !== after.status || before.diff !== after.diff);
    const passed = checks.length === commands.length && checks.every((check) => check.passed) && !workspaceMutationDetected;
    const failedCheck = checks.find((check) => !check.passed);
    const blocker = workspaceMutationDetected
      ? "Deterministic verification changed tracked workspace state; inspect and attribute the mutation before acceptance."
      : failedCheck?.error || (failedCheck ? `Bridge verification failed: ${failedCheck.name}` : "");
    const evidence = {
      version: 1,
      state: passed ? "passed" : "failed",
      required: true,
      passed,
      generatedAt: utcStamp(),
      requestHash: String(args.verificationRequestHash || ""),
      workspaceMutationDetected,
      blocker,
      checks,
    };
    writeJson(evidencePath, evidence);
    fs.appendFileSync(summaryPath, `${[
      "",
      "BridgeDeterministicVerification:",
      "Required: true",
      `State: ${evidence.state}`,
      `WorkspaceMutationDetected: ${workspaceMutationDetected}`,
      ...checks.map((check) => `- ${check.name}: state=${check.state || (check.passed ? "passed" : "failed")}; exit=${check.exitCode ?? "unknown"}; expected=${check.expectedExitCode ?? "unknown"}; timeout=${check.timedOut === true}`),
      blocker ? `Blocker: ${blocker}` : null,
    ].filter((line) => line !== null).join("\n")}\n`, "utf8");
    return evidence;
  }

  return { normalize, run, skip: writeSkipped, validate };
}

module.exports = { createVerificationRunner, normalizeVerificationCommands };
