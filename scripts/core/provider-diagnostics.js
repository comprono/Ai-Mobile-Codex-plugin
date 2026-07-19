"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { inventory } = require("./capacity");
const { bounded, redact, utcNow } = require("./utils");
const { runProvider } = require("../providers");

const PROVIDERS = ["codex", "claude", "antigravity", "cursor"];
const ENVIRONMENT_NAMES = {
  codex: ["OPENAI_API_KEY", "OPENAI_BASE_URL", "CODEX_HOME"],
  claude: ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "CLAUDE_CONFIG_DIR"],
  antigravity: ["GOOGLE_API_KEY", "GEMINI_API_KEY", "AI_MOBILE_ANTIGRAVITY_HELPER"],
  cursor: ["CURSOR_API_KEY"],
};

function billingMode(provider = {}) {
  if (provider.authMode === "api-key") return "api-or-payg";
  if (["subscription", "chatgpt", "cli-session"].includes(provider.authMode)) return "subscription-or-cli-session";
  return "unknown";
}

function configuredEnvironment(id) {
  return (ENVIRONMENT_NAMES[id] || []).map((name) => ({ name, present: Boolean(String(process.env[name] || "").trim()) }));
}

function modelRows(provider = {}) {
  return (provider.models || []).slice(0, 100).map((row) => ({
    id: row.id || row.displayName,
    displayName: row.displayName || "",
    capabilityTier: row.capabilityTier || "unknown",
    reasoningEfforts: row.supportedReasoningEfforts || [],
    defaultReasoningEffort: row.defaultReasoningEffort || "",
    quota: row.quota ? { remainingPercent: row.quota.remainingPercent ?? null, resetAt: row.quota.resetAt || null, status: row.quota.status || "unknown" } : null,
  }));
}

function commandSource(provider = {}) {
  if (!provider.command) return "not-found";
  if (path.isAbsolute(provider.command)) return "resolved-local-executable";
  return "PATH";
}

function diagnosticRow(id, provider = {}) {
  return {
    id,
    installed: provider.installed === true || Boolean(provider.command),
    callableHeadless: provider.available === true && provider.authenticated === true && provider.headless !== false,
    authenticated: provider.authenticated === true,
    authMode: provider.authMode || "unknown",
    billingMode: billingMode(provider),
    subscriptionType: provider.subscriptionType || "",
    command: provider.command ? path.basename(provider.command) : "",
    commandSource: commandSource(provider),
    version: bounded(provider.version, 200),
    confidence: provider.confidence || "unknown",
    models: modelRows(provider),
    quotaPools: (provider.quotaPools || []).slice(0, 30).map((pool) => ({ id: pool.id, scope: pool.scope, period: pool.period, remainingPercent: pool.remainingPercent ?? null, resetAt: pool.resetAt || null, source: pool.source || "unknown" })),
    surfaces: provider.surfaces || {},
    taskCapabilities: provider.capabilities || {},
    environment: configuredEnvironment(id),
    secretPolicy: "Environment and config values are never returned; only variable names and presence are reported.",
    capacitySource: provider.capacity?.source || "unknown",
    reason: bounded(provider.reason, 800),
    typedFailure: provider.diagnostic?.failureClass || "",
    observedAt: provider.observedAt || null,
    expiresAt: provider.expiresAt || null,
  };
}

function canaryModel(id, provider) {
  const rows = provider.models || [];
  if (id === "codex") return rows.find((row) => row.isDefault)?.id || rows.find((row) => row.capabilityTier === "efficient")?.id || rows[0]?.id || "";
  if (id === "claude") return rows.find((row) => row.capabilityTier === "balanced")?.id || rows.find((row) => row.capabilityTier === "efficient")?.id || rows[0]?.id || "sonnet";
  if (id === "antigravity") return rows.find((row) => row.capabilityTier === "efficient")?.displayName || rows.find((row) => row.capabilityTier === "balanced")?.displayName || rows[0]?.displayName || rows[0]?.id || "";
  return rows[0]?.id || "";
}

function runSmallCanary(id, provider) {
  if (!provider?.available || !provider?.authenticated) return { attempted: false, passed: false, failureClass: provider?.diagnostic?.failureClass || "provider-unavailable", summary: provider?.reason || "Provider is not callable headlessly." };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-mobile-provider-canary-"));
  const marker = `AI_MOBILE_CANARY_${Date.now().toString(36).toUpperCase()}`;
  try {
    fs.writeFileSync(path.join(root, "canary.txt"), `${marker}\n`, "utf8");
    const model = canaryModel(id, provider);
    const contract = {
      provider: id,
      workspace: root,
      projectId: "ai-mobile-provider-diagnostic",
      readOnly: true,
      model,
      effort: "low",
      timeoutSeconds: 90,
      providerAuthMode: provider.authMode || "unknown",
      maxApiBudgetUsd: 0.05,
      needsUi: false,
    };
    const response = runProvider({ [id]: provider }, contract, `Read only canary.txt and return the exact marker ${marker}. Do not modify files, start a UI, delegate, or add commentary.`);
    const passed = response.ok === true && String(response.text || "").includes(marker);
    return {
      attempted: true,
      passed,
      provider: id,
      model: response.usage?.model || model || "provider-default",
      failureClass: passed ? "" : response.typedBlocker || "canary-marker-missing",
      summary: passed ? "The authenticated headless provider returned the exact disposable marker." : bounded(redact(response.text), 600),
      usage: {
        inputTokens: response.usage?.inputTokens ?? null,
        cachedInputTokens: response.usage?.cachedInputTokens ?? null,
        outputTokens: response.usage?.outputTokens ?? null,
        billingNote: response.usage?.billingNote || "Usage telemetry is not a subscription balance or confirmed charge.",
      },
      desktopUiUsed: false,
    };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function providerDiagnostics(args = {}, dependencies = {}) {
  const inventoryFn = dependencies.inventory || inventory;
  const resources = await inventoryFn({ refresh: args.refresh !== false });
  const requested = Array.isArray(args.providerIds) && args.providerIds.length ? PROVIDERS.filter((id) => args.providerIds.includes(id)) : PROVIDERS;
  const providers = Object.fromEntries(requested.map((id) => [id, diagnosticRow(id, resources.providers[id] || {})]));
  let canary = { attempted: false, reason: "Set runCanary true for one explicit, minimal, read-only provider call." };
  if (args.runCanary === true) {
    const requestedCanary = String(args.canaryProvider || "").toLowerCase();
    const order = requestedCanary ? [requestedCanary] : ["antigravity", "claude", "cursor", "codex"];
    const selected = order.find((id) => requested.includes(id) && resources.providers[id]?.available && resources.providers[id]?.authenticated);
    canary = selected ? runSmallCanary(selected, resources.providers[selected]) : { attempted: false, passed: false, failureClass: "no-callable-headless-provider", summary: "No requested provider passed executable and authentication checks." };
  }
  return {
    generatedAt: utcNow(),
    passiveDiscovery: args.runCanary !== true,
    providers,
    canary,
    noSecretsReturned: true,
    noDesktopUiLaunched: true,
  };
}

module.exports = { diagnosticRow, providerDiagnostics, runSmallCanary };