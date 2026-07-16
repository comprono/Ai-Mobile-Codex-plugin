# Capacity And Routing

Use this reference only when automatic selection is uncertain.

## Evidence

- `start-task` performs the normal passive machine/provider inventory. `resource-inventory` is an explicit diagnostic refresh.
- Positive capacity evidence is cached briefly. Negative evidence expires faster and is re-probed before dispatch rejection.
- Availability means a native headless CLI exists and its authentication check passed where supported.
- Capacity facts retain source, confidence, observation time, expiry, quota-pool scope, and reset time. `null` means unknown, not empty or unlimited.
- Current Codex has the best knowledge of the active project and retains the configured integration reserve before a separate Codex CLI worker is considered.
- Claude subscription quota is not converted to dollars. Antigravity quota is not invented when `agy` exposes only availability.
- A portfolio stores one capacity snapshot for all projects. Dispatch may refresh stale or negative evidence but does not poll.

## Decision

Delegate only when the unit is dependency-ready, disjoint, and:

```text
expected execution/context saving
  > startup + compact prompt + wait + verification + integration + expected-failure cost
```

Small, tightly coupled, semantically overlapping, or path-overlapping work stays with current Codex. For substantial independent work, routing scores task fit, project priority, dependencies, quota pools, reset horizon, billing mode, recent reliability, free RAM, model policy, output size, and integration cost.

Machine-wide leases enforce global and per-provider worker limits and quota-pool exclusion across separate tasks and portfolios. Portfolio candidates use priority-first round-robin fairness; a blocked project is skipped without being completed.

## Explicit User Selection

A unit with `selectionAuthority: "user"` carries a provider/model the user explicitly mandated. The runtime binds model families canonically: Fable/Opus/Sonnet/Haiku are Claude, GPT is Codex, and Gemini is Antigravity. Economics and small-task overhead warn without rejecting a mandate, but authentication, billing, quota, reserve, ownership, storage, and safety gates still win.

Writers require exact workspace-relative `expectedFiles` and a Git repository root. Parallel writer boundaries must be disjoint. Read-only workers create no worktree.

After a terminal failure, take the work back into current Codex or retry once only when a classified transient failure has materially changed evidence. Never retry authorization prompts, stale transports, or the same semantic plan blindly.
