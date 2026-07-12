"use strict";

const KNOWN_EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"];

function normalizedEfforts(model = {}) {
  const values = [...new Set((Array.isArray(model.reasoningLevels) ? model.reasoningLevels : [])
    .map((value) => String(value || "").toLowerCase())
    .filter(Boolean))];
  return values.length ? values : [String(model.defaultReasoning || "medium").toLowerCase()];
}

function effortRank(value) {
  const index = KNOWN_EFFORTS.indexOf(String(value || "").toLowerCase());
  return index >= 0 ? index : KNOWN_EFFORTS.indexOf("medium");
}

function selectReasoningEffort(model, item = {}) {
  const supported = normalizedEfforts(model).sort((a, b) => effortRank(a) - effortRank(b));
  const complexity = String(item.complexity || "medium").toLowerCase();
  const text = `${item.kind || ""} ${item.objective || ""} ${(item.requiredCapabilities || []).join(" ")}`.toLowerCase();
  const needsMaximum = complexity === "critical" && /frontier|security|incident|irreversible|migration|architecture|adversarial/.test(text);
  const desired = needsMaximum ? "ultra" : complexity === "critical" ? "xhigh" : complexity === "high" ? "high" : complexity === "low" ? "low" : String(model.defaultReasoning || "medium");
  const desiredRank = effortRank(desired);
  const atOrBelow = supported.filter((value) => effortRank(value) <= desiredRank);
  return atOrBelow[atOrBelow.length - 1] || supported[0] || "medium";
}

function codexProfile(model = {}) {
  const text = `${model.id || ""} ${model.displayName || ""} ${model.description || ""}`.toLowerCase();
  if (/\bsol\b/.test(text)) return { quality: 100, speed: 58, efficiency: 28, role: "frontier architecture, critical reasoning, integration, and high-risk implementation" };
  if (/\bterra\b/.test(text)) return { quality: 91, speed: 80, efficiency: 70, role: "balanced implementation, debugging, tests, and everyday project work" };
  if (/\bluna\b/.test(text)) return { quality: 81, speed: 96, efficiency: 96, role: "fast bounded discovery, mechanical edits, summaries, and focused verification" };
  return { quality: 86, speed: 72, efficiency: 64, role: "catalog-discovered Codex worker; route conservatively until outcomes are observed" };
}

function buildHostCodexCandidates(catalog = {}, telemetry = {}, policy = {}) {
  const includePattern = policy.includePattern instanceof RegExp ? policy.includePattern : /^gpt-/i;
  return (catalog.models || [])
    .filter((model) => includePattern.test(String(model.id || "")))
    .map((model) => {
      const profile = codexProfile(model);
      return {
        id: `codex-host:${model.id}`,
        platform: "codex",
        team: "Codex native worker",
        model: model.id,
        displayName: model.displayName || model.id,
        routable: true,
        dispatchable: policy.hostCapabilityVerified === true,
        bridgeDispatchable: false,
        hostDispatchable: policy.hostCapabilityVerified === true,
        dispatchMode: "host-subagent",
        hostTool: "multi_agent_v1__spawn_agent",
        hostCapabilityVerified: policy.hostCapabilityVerified === true,
        state: policy.hostCapabilityVerified !== true
          ? "host-unverified"
          : telemetry.found && telemetry.fresh === false
            ? "capacity-stale"
            : telemetry.state === "exhausted"
              ? "exhausted"
              : "available",
        evidence: telemetry.found ? telemetry.evidence : "catalog-only",
        remainingPercent: Number.isFinite(telemetry.effectiveRemainingPercent) ? telemetry.effectiveRemainingPercent : null,
        resetAt: telemetry.windows?.slice().sort((a, b) => Number(a.remainingPercent ?? 101) - Number(b.remainingPercent ?? 101))[0]?.resetAt || "",
        reasoningLevels: normalizedEfforts(model),
        defaultReasoning: model.defaultReasoning || "medium",
        contextWindow: model.contextWindow || null,
        capabilities: ["general-reasoning", "architecture", "implementation", "debugging", "testing", "review", "integration", "final-verification"],
        quality: profile.quality,
        speed: profile.speed,
        cost: profile.efficiency,
        role: profile.role,
      };
    });
}

function hostScore(candidate, item = {}) {
  if (candidate.state !== "available") return Number.NEGATIVE_INFINITY;
  const complexity = String(item.complexity || "medium").toLowerCase();
  const text = `${item.kind || ""} ${item.objective || ""}`.toLowerCase();
  let score = candidate.quality * (complexity === "critical" ? 0.62 : complexity === "high" ? 0.48 : 0.3);
  score += candidate.speed * (complexity === "low" ? 0.35 : 0.12);
  score += candidate.cost * (complexity === "low" ? 0.32 : complexity === "medium" ? 0.16 : 0.05);
  if (/architecture|risk|integration|security|incident|migration/.test(text) && /sol/i.test(candidate.model)) score += 30;
  if (/implementation|debug|test/.test(text) && /terra/i.test(candidate.model)) score += 18;
  if (/discovery|summary|docs|mechanical|focused/.test(text) && /luna/i.test(candidate.model)) score += 22;
  if (Number.isFinite(candidate.remainingPercent)) score += Math.max(-35, Math.min(18, (candidate.remainingPercent - 25) / 3));
  return Math.round(score * 10) / 10;
}

function chooseHostCodexAction(candidates, item) {
  const ranked = candidates
    .map((candidate) => ({ candidate, score: hostScore(candidate, item) }))
    .filter((row) => Number.isFinite(row.score))
    .sort((a, b) => b.score - a.score || b.candidate.quality - a.candidate.quality);
  const selected = ranked[0];
  if (!selected) return null;
  return {
    resourceId: selected.candidate.id,
    model: selected.candidate.model,
    reasoningEffort: selectReasoningEffort(selected.candidate, item),
    score: selected.score,
    dispatchMode: "host-subagent",
    hostTool: selected.candidate.hostTool,
    hostCapabilityVerified: selected.candidate.hostCapabilityVerified,
  };
}

function normalizedBoundary(value) {
  return String(value || "").trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "").toLowerCase();
}

function disjointWriterPair(left, right) {
  if (!left || !right || left.readOnly !== false || right.readOnly !== false) return false;
  const leftFiles = left.expectedFiles || [];
  const rightFiles = right.expectedFiles || [];
  if (!leftFiles.length || !rightFiles.length) return false;
  return leftFiles.every((leftFile) => rightFiles.every((rightFile) => {
    const a = normalizedBoundary(leftFile);
    const b = normalizedBoundary(rightFile);
    if (!a || !b || /[*?\[\]{}]/.test(a) || /[*?\[\]{}]/.test(b)) return false;
    return a !== b && !a.startsWith(`${b}/`) && !b.startsWith(`${a}/`);
  }));
}

function shouldFanOut(workItems = []) {
  const ready = workItems.filter((item) => !(item.dependsOn || []).length);
  if (ready.length < 2) return false;
  const writers = ready.filter((item) => item.readOnly === false);
  for (let index = 0; index < writers.length; index += 1) {
    for (let peerIndex = index + 1; peerIndex < writers.length; peerIndex += 1) {
      if (!disjointWriterPair(writers[index], writers[peerIndex])) return false;
    }
  }
  return writers.length > 1 || (ready.some((item) => item.readOnly !== false) && new Set(ready.map((item) => item.kind)).size > 1);
}

module.exports = {
  buildHostCodexCandidates,
  chooseHostCodexAction,
  codexProfile,
  normalizedEfforts,
  selectReasoningEffort,
  shouldFanOut,
  disjointWriterPair,
};
