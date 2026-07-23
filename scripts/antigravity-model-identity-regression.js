#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  antigravityModelIdentityMatch,
  claudeModelIdentityMatch,
  codexModelIdentityEvidence,
  normalizeClaudeUsage,
  parseAntigravityResolvedModelLog,
  prepareAntigravityInvocation,
  prepareCodexInvocation,
  runProvider,
} = require("./providers");
const { buildCodexExecArgs, parseCodexJsonl } = require("./lib/codex-cli");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-mobile-antigravity-model-identity-"));
const workspace = path.join(root, "workspace");
fs.mkdirSync(workspace, { recursive: true });

function fixtureCommand(name, label) {
  const target = path.join(root, name + ".cmd");
  const escapedLabel = String(label).replace(/\(/g, "^(").replace(/\)/g, "^)");
  fs.writeFileSync(target, [
    "@echo off",
    ":scan",
    "if \"%~1\"==\"\" goto done",
    "if /I \"%~1\"==\"--log-file\" goto capture",
    "shift",
    "goto scan",
    ":capture",
    "shift",
    "set \"fixtureLog=%~1\"",
    "shift",
    "goto scan",
    ":done",
    `> \"%fixtureLog%\" echo [fixture] Propagating selected model override to backend: label=${escapedLabel}`,
    "echo fixture provider result",
    "exit /b 0",
    "",
  ].join("\r\n"), "utf8");
  return target;
}

try {
  const codexModel = "gpt-5.3-codex-spark";
  const codexArgs = buildCodexExecArgs({ workspace, model: codexModel, effort: "medium", readOnly: true });
  const exactCodexIdentity = codexModelIdentityEvidence(codexModel, codexArgs, {}, true);
  assert.equal(exactCodexIdentity.observed, true);
  assert.equal(exactCodexIdentity.matched, true);
  assert.equal(exactCodexIdentity.actualModelId, codexModel);
  assert.equal(exactCodexIdentity.source, "successful-exact-codex-model-argument");
  assert.equal(codexModelIdentityEvidence(codexModel, codexArgs, {}, false).observed, false, "A failed Codex invocation must never mark its requested model observed.");
  const parsedCodexModel = parseCodexJsonl([
    JSON.stringify({ type: "thread.started", thread_id: "fixture", model: codexModel }),
    JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 5 } }),
  ].join("\n"));
  assert.equal(parsedCodexModel.actualModelId, codexModel);
  assert.match(parsedCodexModel.modelIdentitySource, /codex-jsonl/);
  assert.equal(codexModelIdentityEvidence(codexModel, codexArgs, parsedCodexModel, true).matched, true);
  const completedPreferred = parseCodexJsonl([
    JSON.stringify({ type: "item.updated", item: { type: "agent_message", text: "partial invalid JSON" } }),
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "{\"kind\":\"master-plan\"}" } }),
    JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 5 } }),
  ].join("\n"));
  assert.equal(completedPreferred.resultText, "{\"kind\":\"master-plan\"}", "completed Codex output must replace streaming partials");
  const structuredCodex = prepareCodexInvocation({
    workspace,
    model: codexModel,
    effort: "high",
    readOnly: true,
    executorKind: "strategist",
    deliverableKind: "master-plan",
    maxWorkerOutputTokens: 4000,
  });
  try {
    assert.ok(structuredCodex.schemaFile && fs.existsSync(structuredCodex.schemaFile));
    assert.equal(structuredCodex.args[structuredCodex.args.indexOf("--output-schema") + 1], structuredCodex.schemaFile);
    assert.equal(JSON.parse(fs.readFileSync(structuredCodex.schemaFile, "utf8")).type, "object");
  } finally {
    const schemaFile = structuredCodex.schemaFile;
    structuredCodex.cleanup();
    assert.equal(fs.existsSync(schemaFile), false, "temporary Codex output schema must be removed");
  }

  const claudeObserved = {
    model: "claude-opus-4-8",
    usage: { input_tokens: 10, output_tokens: 5 },
  };
  const claudeAlias = normalizeClaudeUsage(claudeObserved, "opus");
  assert.equal(claudeAlias.model, "opus");
  assert.equal(claudeAlias.actualModelId, "opus");
  assert.equal(claudeAlias.actualModel, "claude-opus-4-8");
  assert.equal(claudeAlias.modelIdentityMatched, true);
  assert.equal(claudeAlias.modelIdentityReason, "catalog-family-alias");
  const claudeVersionMismatch = normalizeClaudeUsage(claudeObserved, "claude-opus-4-6");
  assert.equal(claudeVersionMismatch.actualModelId, "claude-opus-4-8");
  assert.equal(claudeVersionMismatch.modelIdentityMatched, false);
  assert.equal(claudeVersionMismatch.modelIdentityReason, "explicit-version-or-tier-mismatch");
  assert.equal(claudeModelIdentityMatch("claude-opus-4-6", "claude-opus-4-8").matched, false);
  const lowLog = "[debug] Propagating selected model override to backend: label=Gemini 3.5 Flash (Medium)\n";
  const opusLog = "[debug] Propagating selected model override to backend: label=Claude Opus 4.6 (Thinking)\n";
  assert.equal(parseAntigravityResolvedModelLog(lowLog), "Gemini 3.5 Flash (Medium)");
  assert.equal(parseAntigravityResolvedModelLog(opusLog), "Claude Opus 4.6 (Thinking)");
  assert.deepEqual(antigravityModelIdentityMatch("gemini-3.5-flash-low", "Gemini 3.5 Flash (Medium)"), {
    matched: false,
    reason: "model-tier-mismatch",
    requestedTier: "low",
    actualTier: "medium",
  });
  assert.equal(antigravityModelIdentityMatch("claude-opus-4-6-thinking", "Claude Opus 4.6 (Thinking)").matched, true);

  const probe = prepareAntigravityInvocation({ workspace, timeoutSeconds: 30, readOnly: true, model: "fixture" }, "probe");
  const invocationRoot = path.dirname(probe.logFile);
  try {
    assert.equal(probe.args[0], "--log-file");
    assert.equal(probe.args[1], probe.logFile);
    fs.writeFileSync(probe.logFile, opusLog, "utf8");
    assert.equal(probe.resolvedModel(), "Claude Opus 4.6 (Thinking)");
  } finally {
    probe.cleanup();
  }
  assert.equal(fs.existsSync(invocationRoot), false, "The isolated model/auth log directory must be removed after parsing.");

  const mismatch = runProvider({ antigravity: { available: true, command: fixtureCommand("agy-medium", "Gemini 3.5 Flash (Medium)") } }, {
    provider: "antigravity",
    workspace,
    projectId: "fixture-project",
    timeoutSeconds: 30,
    readOnly: true,
    model: "gemini-3.5-flash-low",
  }, "return fixture output");
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.typedBlocker, "model-identity-mismatch", JSON.stringify(mismatch));
  assert.equal(mismatch.usage.requestedModel, "gemini-3.5-flash-low");
  assert.equal(mismatch.usage.actualModel, "Gemini 3.5 Flash (Medium)");
  assert.equal(mismatch.usage.actualModelId, "gemini-3.5-flash-medium");
  assert.equal(mismatch.usage.modelIdentityMatched, false);

  const exact = runProvider({ antigravity: { available: true, command: fixtureCommand("agy-opus", "Claude Opus 4.6 (Thinking)") } }, {
    provider: "antigravity",
    workspace,
    projectId: "fixture-project",
    timeoutSeconds: 30,
    readOnly: true,
    model: "claude-opus-4-6-thinking",
  }, "return fixture output");
  assert.equal(exact.ok, true, exact.text);
  assert.equal(exact.typedBlocker, "");
  assert.equal(exact.usage.model, "claude-opus-4-6-thinking");
  assert.equal(exact.usage.actualModelId, "claude-opus-4-6-thinking");
  assert.equal(exact.usage.actualModel, "Claude Opus 4.6 (Thinking)");
  assert.equal(exact.usage.requestedModel, "claude-opus-4-6-thinking");
  assert.equal(exact.usage.principalModelObserved, true);
  assert.equal(exact.usage.modelIdentityMatched, true);
  assert.equal(exact.usage.totalTokens, null, "Antigravity logs do not provide authoritative token accounting.");
  assert.equal(exact.usage.resourceAccountingComplete, false);

  process.stdout.write(JSON.stringify({
    ok: true,
    lowToMediumMismatchBlocked: true,
    exactOpusLabelAccepted: true,
    isolatedLogCleaned: true,
    codexExactArgumentIdentityAccepted: true,
    codexFailedInvocationUnobserved: true,
    claudeAliasAcceptedAndVersionDriftBlocked: true,
    tokenTelemetryInvented: false,
  }, null, 2) + "\n");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
