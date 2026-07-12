#!/usr/bin/env node

"use strict";

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const pluginRoot = path.resolve(__dirname, "..");

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function assertPortableMcpConfig(root) {
  const config = readJson(path.join(root, ".mcp.json"));
  const servers = config.mcpServers || {};
  assert.ok(servers["ai-mobile-local"], "ai-mobile-local MCP entry is required");
  assert.ok(servers["ai-mobile-devtools"], "ai-mobile-devtools MCP entry is required");

  for (const [name, server] of Object.entries(servers)) {
    assert.equal(server.cwd, ".", `${name} must resolve from the installed plugin root`);
    const serialized = JSON.stringify(server);
    assert.doesNotMatch(serialized, /USERPROFILE|CODEX_HOME|\\plugins\\ai-mobile|[A-Za-z]:\\/i, `${name} must not depend on one user's install path`);
    for (const arg of server.args || []) {
      if (!String(arg).startsWith("./")) continue;
      assert.ok(fs.existsSync(path.resolve(root, arg)), `${name} relative entrypoint must exist: ${arg}`);
    }
  }
  return config;
}

function copyPortableFixture() {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "ai mobile portable "));
  fs.cpSync(pluginRoot, fixture, {
    recursive: true,
    filter: (source) => ![".git", ".antigravity-bridge", "node_modules"].includes(path.basename(source)),
  });
  return fixture;
}

function waitForMcpResponses(child, expectedIds, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const responses = new Map();
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => reject(new Error(`MCP smoke test timed out. stderr=${stderr.slice(0, 500)}`)), timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
      const lines = stdout.split(/\r?\n/);
      stdout = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim().startsWith("{")) continue;
        const message = JSON.parse(line);
        if (expectedIds.has(message.id)) responses.set(message.id, message);
      }
      if ([...expectedIds].every((id) => responses.has(id))) {
        clearTimeout(timer);
        resolve(responses);
      }
    });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.on("exit", (code) => {
      if ([...expectedIds].every((id) => responses.has(id))) return;
      clearTimeout(timer);
      reject(new Error(`MCP server exited before responding (code=${code}). stderr=${stderr.slice(0, 500)}`));
    });
  });
}

async function smokePortableLocalMcp(fixture, config) {
  const server = config.mcpServers["ai-mobile-local"];
  assert.equal(server.command, "node", "portable local MCP must use the Node runtime directly");
  assert.deepEqual(server.args, ["./scripts/ai-mobile-local-mcp.js"], "portable local MCP must use its fixed relative entrypoint");
  const child = spawn(process.execPath, ["./scripts/ai-mobile-local-mcp.js"], {
    cwd: path.resolve(fixture, server.cwd),
    env: { ...process.env, AI_MOBILE_SELF_TEST: "1" },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  try {
    const pending = waitForMcpResponses(child, new Set([1, 2]));
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "reliability-e2e", version: "1" } } })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`);
    const responses = await pending;
    assert.equal(responses.get(1)?.result?.serverInfo?.name, "ai-mobile-local", "portable MCP initializes from copied path");
    const toolNames = new Set((responses.get(2)?.result?.tools || []).map((tool) => tool.name));
    assert.ok(toolNames.has("run-project-manager") && toolNames.has("project-manager-status"), "portable MCP exposes the lean manager surface");
  } finally {
    child.stdin.end();
    if (child.exitCode === null) child.kill();
    if (child.exitCode === null) {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 3000);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }
}

async function main() {
  const passed = [];
  const sourceConfig = assertPortableMcpConfig(pluginRoot);
  passed.push("MCP config is installation-relative");
  const fixture = copyPortableFixture();
  try {
    const copiedConfig = assertPortableMcpConfig(fixture);
    passed.push("copied plugin retains portable entrypoints");
    await smokePortableLocalMcp(fixture, copiedConfig || sourceConfig);
    passed.push("local MCP initializes from a clean path containing spaces");
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
  }
  process.stdout.write(["AiMobileReliabilityE2E:", `Passed: ${passed.length}`, ...passed.map((entry) => `- ${entry}`)].join("\n") + "\n");
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
