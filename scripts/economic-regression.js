#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-mobile-v1-economics-"));
process.env.LOCALAPPDATA = root;
const workspace = path.join(root, "workspace");
fs.mkdirSync(path.join(workspace, "src", "ui"), { recursive: true });
fs.mkdirSync(path.join(workspace, "src", "api"), { recursive: true });

const { economicEstimate } = require("./core/lane-policy");
const { normalizeRequest, route } = require("./core/router");

function request(patch = {}) {
  return normalizeRequest({ workspace, projectGoal: "Ship verified feature", currentCodexGoal: "Implement API", currentCodexFiles: ["src/api"], goal: "Review UI architecture", independenceReason: "Different files and decision", relevantFiles: ["src/ui"], readOnly: true, complexity: "large", taskKind: "review", estimatedDirectTokens: 14000, maxWorkerOutputTokens: 1000, ...patch });
}
function resources(codexRemaining = 80) { return { providers: {
  codex: { available: true, authenticated: true, authMode: "chatgpt", models: [{ id: "gpt-fixture", description: "balanced capable model" }], capacity: { effectiveRemainingPercent: codexRemaining } },
  claude: { available: true, authenticated: true, authMode: "subscription", models: [{ id: "sonnet" }, { id: "fable" }], capacity: { windows: [{ scope: "all", remainingPercent: 70 }, { scope: "fable", remainingPercent: 90, resetAt: new Date(Date.now() + 60 * 60 * 1000).toISOString() }] } },
  antigravity: { available: false, authenticated: false, reason: "not installed" },
  cursor: { available: false, authenticated: false, reason: "not installed" },
} }; }

try {
  const good = economicEstimate(request());
  assert.equal(good.positive, true);
  const tiny = request({ complexity: "small", estimatedDirectTokens: 800, maxWorkerOutputTokens: 800 });
  assert.equal(route(tiny, resources(), {}).action, "direct");
  const medium = route(request(), resources(), {});
  assert.equal(medium.action, "delegate");
  const reserve = route(request({ preferredProvider: "codex" }), resources(10), {});
  assert.equal(reserve.action, "direct");
  assert.match(reserve.reason, /reserve/);
  const unknownCodex = resources();
  unknownCodex.providers.codex.capacity = { effectiveRemainingPercent: null };
  const unknown = route(request(), unknownCodex, {});
  assert.notEqual(unknown.provider, "codex");
  const premium = route(request({ preferredProvider: "claude", model: "fable", selectionAuthority: "user", allowPremiumModel: true }), resources(), {});
  assert.equal(premium.action, "delegate");
  assert.equal(premium.provider, "claude");
  process.stdout.write(`${JSON.stringify({ ok: true, delegatedSavingsPercent: good.savingsPercent, smallTaskDirect: true, codexReserveProtected: true, unknownCodexNotDelegated: true }, null, 2)}\n`);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
