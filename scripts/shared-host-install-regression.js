"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const readJson = (relative) => JSON.parse(fs.readFileSync(path.join(root, relative), "utf8"));
const codex = readJson(".codex-plugin/plugin.json");
const claude = readJson(".claude-plugin/plugin.json");
const claudeMarketplace = readJson(".claude-plugin/marketplace.json");
const codexMarketplace = readJson(".agents/plugins/marketplace.json");
const mcp = readJson(".mcp.json");

assert.equal(codex.name, "ai-mobile");
assert.equal(claude.name, "ai-mobile");
assert.equal(codex.version, claude.version);
assert.equal(claudeMarketplace.plugins[0].source, "./");
assert.equal(codexMarketplace.plugins[0].source.path, "./");
assert.equal(mcp.mcpServers["ai-mobile-local"].args[0], "./scripts/ai-mobile-local-mcp.js");
assert.equal(fs.existsSync(path.join(root, "skills", "ai-mobile", "SKILL.md")), true);
assert.equal(fs.existsSync(path.join(root, "agents", "ai-mobile-writer.md")), true);
assert.equal(fs.existsSync(path.join(root, "claude-plugin")), false);
const installer = fs.readFileSync(path.join(root, "scripts", "install-ai-mobile.ps1"), "utf8");
assert.match(installer, /claude.*plugin.*marketplace/s);
assert.match(installer, /codex.*plugin.*marketplace/s);
assert.equal((installer.match(/\.mcp\.json/g) || []).length >= 1, true);
assert.match(installer, /verify-installed-runtime\.js/);
assert.match(installer, /CacheParityVerified/);
assert.equal(fs.existsSync(path.join(root, `RELEASE_NOTES_v${codex.version}.md`)), true);

process.stdout.write(JSON.stringify({
  ok: true,
  version: codex.version,
  canonicalRepositoryRoot: root,
  codexAndClaudeShareMcp: true,
  duplicateClaudeRuntime: false,
}, null, 2) + "\n");
