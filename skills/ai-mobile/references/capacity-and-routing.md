# Capacity And Routing

Use this reference only when automatic selection is uncertain.

## Evidence

- `resource-inventory` is passive and cached for five minutes by the runtime. The skill may reuse a known snapshot longer when no provider event changed.
- Availability means a native CLI exists and its authentication check passed where supported.
- Capacity facts retain source and confidence. `null` means unknown, not empty or unlimited.
- Current Codex has the best knowledge of its own visible usage window. Protect the user's configured integration reserve before starting a separate Codex worker.
- Claude subscription quota is not converted to dollars. Antigravity model quota is not invented when `agy` exposes only availability.

## Decision

Delegate only when the lane is independent and:

```text
expected execution/context saving
  > startup + task-capsule + integration + expected-failure cost
```

Small or tightly coupled work stays with current Codex. For substantial independent work, prefer an explicitly eligible provider, otherwise authenticated Claude Code, authorized read-only Antigravity, real headless Cursor, then a separate Codex worker. This order protects shared Codex capacity; it is not a permanent quality ranking.

Writers require explicit workspace-relative `expectedFiles`. Keep parallel writer boundaries disjoint. When evidence is unknown or stale, reduce concurrency instead of guessing.

After a concrete terminal failure, either take the lane back into current Codex or fail over once to a provider with a materially different failure surface. Do not retry authorization prompts, stale transports, or the same provider repeatedly.
