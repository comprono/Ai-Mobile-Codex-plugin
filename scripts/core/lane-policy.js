"use strict";

const crypto = require("node:crypto");

const STOP_WORDS = new Set([
  "about", "after", "again", "also", "and", "before", "being", "current", "exact", "from", "the",
  "have", "into", "only", "project", "return", "should", "that", "their", "then", "this",
  "through", "using", "with", "without", "work", "worker", "your",
]);

function terms(value) {
  return new Set((String(value || "").toLowerCase().match(/[a-z0-9][a-z0-9._-]{2,}/g) || [])
    .map((term) => term.replace(/[._-]+$/g, ""))
    .filter((term) => !STOP_WORDS.has(term)));
}

function goalOverlap(left, right) {
  const a = terms(left);
  const b = terms(right);
  if (!a.size || !b.size) return { overlaps: false, shared: [], containment: 0, jaccard: 0 };
  const shared = [...a].filter((term) => b.has(term));
  const containment = shared.length / Math.min(a.size, b.size);
  const jaccard = shared.length / new Set([...a, ...b]).size;
  return {
    overlaps: shared.length >= 4 && (containment >= 0.34 || jaccard >= 0.24),
    shared: shared.slice(0, 12),
    containment: Number(containment.toFixed(3)),
    jaccard: Number(jaccard.toFixed(3)),
  };
}

function normalizeBoundary(value) {
  return String(value || "").trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, "").toLowerCase();
}

function boundariesOverlap(left = [], right = []) {
  const pairs = [];
  for (const rawLeft of left) {
    const a = normalizeBoundary(rawLeft);
    if (!a) continue;
    for (const rawRight of right) {
      const b = normalizeBoundary(rawRight);
      if (!b) continue;
      if (a === "." || b === "." || a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)) {
        pairs.push([rawLeft, rawRight]);
      }
    }
  }
  return pairs.slice(0, 20);
}

function estimateTokens(value) {
  return Math.max(1, Math.ceil(String(value || "").length / 4));
}

function economicEstimate(request) {
  const directDefaults = { small: 1600, medium: 6500, large: 14000 };
  const directTokens = request.estimatedDirectTokens || directDefaults[request.complexity] || directDefaults.medium;
  const capsuleTokens = estimateTokens([
    request.projectGoal,
    request.goal,
    request.currentCodexGoal,
    request.independenceReason,
    request.acceptanceCriteria.join(" "),
    request.nextStep,
  ].join(" "));
  const integrationTokens = Math.max(300, Math.min(900, Math.ceil(request.maxWorkerOutputTokens * 0.35)));
  const delegatedTokens = capsuleTokens + request.maxWorkerOutputTokens + integrationTokens;
  const netTokenSavings = directTokens - delegatedTokens;
  const savingsPercent = directTokens > 0 ? (netTokenSavings / directTokens) * 100 : 0;
  return {
    directTokens,
    capsuleTokens,
    maxWorkerOutputTokens: request.maxWorkerOutputTokens,
    integrationTokens,
    delegatedTokens,
    netTokenSavings,
    savingsPercent: Number(savingsPercent.toFixed(1)),
    positive: netTokenSavings >= 800 && savingsPercent >= request.minimumSavingsPercent,
  };
}

function laneKey(request) {
  const material = JSON.stringify({
    goal: [...terms(request.goal)].sort(),
    relevantFiles: (request.relevantFiles || []).map(normalizeBoundary).sort(),
    expectedFiles: (request.expectedFiles || []).map(normalizeBoundary).sort(),
  });
  return crypto.createHash("sha256").update(material).digest("hex").slice(0, 20);
}

module.exports = { boundariesOverlap, economicEstimate, goalOverlap, laneKey, normalizeBoundary };
