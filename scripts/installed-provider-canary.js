#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-mobile-v1-real-canary-"));
process.env.AI_MOBILE_DATA_ROOT = path.join(root, "state");
process.env.LOCALAPPDATA = process.env.LOCALAPPDATA || path.join(root, "local");
const workspace = path.join(root, "workspace");
fs.mkdirSync(workspace, { recursive: true });
fs.writeFileSync(path.join(workspace, "fixture.txt"), "AI_MOBILE_REAL_PROVIDER_CANARY_7319\n", "utf8");

const { inventory } = require("./core/capacity");
const { createJob } = require("./core/job-store");
const { providerHistory } = require("./core/provider-history");
const { collectRound, completeTask, dispatchRound, recordEvidence, startTask } = require("./core/task-orchestrator");
const entrypoint = path.join(__dirname, "ai-mobile-local-mcp.js");

function selectProvider(resources) {
  const requested = String(process.env.AI_MOBILE_CANARY_PROVIDER || "").toLowerCase();
  const candidates = requested ? [requested] : ["antigravity", "claude", "cursor"];
  for (const id of candidates) {
    const state = resources.providers[id];
    if (!state?.available || !state?.authenticated) continue;
    if (id === "antigravity" && !(state.models || []).length && !requested) continue;
    if (id === "claude") return { id, model: (state.models || []).find((row) => /sonnet/i.test(row.id || row.displayName))?.id || "sonnet", allowAntigravity: false };
    if (id === "antigravity") return { id, model: (state.models || []).find((row) => /flash/i.test(`${row.id} ${row.displayName}`))?.displayName || "Gemini Flash", allowAntigravity: true };
    return { id, model: "", allowAntigravity: false };
  }
  throw new Error(`No authenticated non-Codex CLI is available for the real canary${requested ? ` (${requested})` : ""}.`);
}

(async () => {
  try {
    const resources = await inventory({ refresh: true });
    const selected = selectProvider(resources);
    const task = startTask({ workspace, outcome: "Prove one installed AI Mobile real-provider handoff", acceptanceEvidence: [{ description: "An authenticated headless provider reads the disposable fixture and returns its exact marker", minimumEvidenceLevel: "integration" }] }, resources);
    const round = dispatchRound({
      taskId: task.taskId,
      currentCodex: { goal: "Validate the local canary contract and evidence gate", files: [] },
      workUnits: [{
        goal: "Read fixture.txt and return the exact marker AI_MOBILE_REAL_PROVIDER_CANARY_7319 as evidence",
        independenceReason: "The provider only reads a disposable fixture while current Codex validates the contract",
        relevantFiles: ["fixture.txt"], readOnly: true, complexity: "medium", taskKind: "research", estimatedDirectTokens: 6000,
        preferredProvider: selected.id, model: selected.model, selectionAuthority: "user", allowAntigravity: selected.allowAntigravity,
        maxWorkerOutputTokens: 500, timeoutSeconds: 180, integrationAction: "Verify the exact marker once",
      }],
    }, resources, providerHistory(), (contract) => createJob(contract, entrypoint));
    assert.equal(round.workers.length, 1, JSON.stringify(round.rejected));
    const collected = collectRound({ taskId: task.taskId, roundId: round.roundId, waitSeconds: 180, detail: "full" });
    const result = collected.results[0];
    assert.equal(result.state, "completed", result.blocker || result.result || "provider canary failed");
    assert.match(`${result.result || ""}\n${result.handoff?.summary || ""}`, /AI_MOBILE_REAL_PROVIDER_CANARY_7319/);
    recordEvidence({ taskId: task.taskId, evidence: [{ requirementId: "A1", level: "integration", ref: `${selected.id}-installed-canary`, summary: "Authenticated headless provider returned the exact disposable fixture marker", passed: true }] });
    const completed = completeTask({ taskId: task.taskId });
    assert.equal(completed.completionAllowed, true);
    process.stdout.write(`${JSON.stringify({ ok: true, provider: selected.id, model: selected.model || "provider-default", taskId: task.taskId, exactMarkerVerified: true, desktopUiUsed: false, completionAllowed: true }, null, 2)}\n`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
