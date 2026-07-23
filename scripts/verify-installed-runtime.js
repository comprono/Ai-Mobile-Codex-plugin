#!/usr/bin/env node
"use strict";

const path = require("node:path");
const { verifyRuntimeParity } = require("./lib/runtime-identity");

function argumentsMap(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) throw new Error("Runtime parity arguments must be --name value pairs.");
    values[key.slice(2)] = value;
  }
  return values;
}

function verifyInstalledRuntime(input) {
  const source = path.resolve(input.source || "");
  const version = String(input.version || "").trim();
  if (!version) throw new Error("--version is required.");
  return {
    ok: true,
    version,
    codex: verifyRuntimeParity(source, path.resolve(input.codex || ""), version, "codex"),
    claude: verifyRuntimeParity(source, path.resolve(input.claude || ""), version, "claude"),
  };
}

if (require.main === module) {
  try {
    process.stdout.write(JSON.stringify(verifyInstalledRuntime(argumentsMap(process.argv.slice(2))), null, 2) + "\n");
  } catch (error) {
    process.stderr.write(`AI Mobile installed-runtime verification failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { argumentsMap, verifyInstalledRuntime };
