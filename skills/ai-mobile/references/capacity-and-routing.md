# Capacity And Routing

Use this reference only when automatic selection is uncertain.

## Evidence

- `resource-inventory` is passive and cached for up to one active hour. A known quota reset, provider failure, material model change, or explicit refresh invalidates it earlier. With a workspace, it also returns recent provider outcomes and cooldown evidence.
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

Small, tightly coupled, semantically overlapping, or path-overlapping work stays with current Codex. For substantial independent work, the runtime scores task fit, capacity, billing mode, recent reliability, model policy, handoff size, bounded output, and integration cost. It does not use a permanent Claude-first or model-leaderboard order.

Writers require explicit workspace-relative `expectedFiles`. Keep parallel writer boundaries disjoint. When evidence is unknown or stale, reduce concurrency instead of guessing.

After a concrete terminal failure, either take the lane back into current Codex or fail over once to a provider with a materially different failure surface. Do not retry authorization prompts, stale transports, or the same provider repeatedly.
