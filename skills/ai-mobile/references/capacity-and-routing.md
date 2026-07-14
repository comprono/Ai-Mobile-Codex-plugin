# Capacity And Routing

Use this reference only when automatic selection is uncertain.

## Evidence

- `orchestrate-task` performs the normal passive inventory and routing in one first call. `resource-inventory` is a diagnostic refresh, not the project-start path.
- Capacity evidence is cached for up to one active hour. A known quota reset, provider failure, material model change, or explicit refresh invalidates it earlier. Workspace routing also uses recent provider outcomes and cooldown evidence.
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

## Explicit User Selection

A lane with `selectionAuthority: "user"` carries a provider/model the user explicitly mandated. The runtime binds models to providers canonically (Fable/Opus/Sonnet/Haiku are Claude, GPT is Codex, Gemini is Antigravity), corrects an unambiguous mismatch in the same call, and rejects an unbindable mandate with one exact actionable error. Economics and small-task overhead warn without rejecting, and the mandate satisfies the premium-model opt-in. Hard authentication, quota, billing, ownership, file-boundary, and safety gates still reject. A repeat of the same failed mandated lane returns one final do-not-retry blocker from the durable task record.

Writers require explicit workspace-relative `expectedFiles`. Keep parallel writer boundaries disjoint. When evidence is unknown or stale, reduce concurrency instead of guessing.

After a concrete terminal failure, either take the lane back into current Codex or fail over once to a provider with a materially different failure surface. Do not retry authorization prompts, stale transports, or the same provider repeatedly.
