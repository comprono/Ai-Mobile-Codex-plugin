# Capacity And Routing

Use this reference only when automatic selection is uncertain.

## Evidence

- start-task performs one passive machine and provider inventory. resource-inventory is an explicit refresh, never a poll.
- Capacity retains source, confidence, observation time, expiry, quota-pool scope, remaining percentage when known, and reset time.
- null means unknown, not empty or unlimited.
- The visible Codex console owns no project files and consumes only bounded interaction and coordinator calls.
- Codex CLI is a work-plane provider. It may use shared Codex capacity only above the private reserve.
- Claude subscription quota is not converted to dollars. Antigravity quota is never invented.
- One portfolio capacity snapshot and machine-wide leases prevent separate projects from oversubscribing a provider or quota pool.

## Decision

A work-plane unit must be dependency-ready, bounded, and independently verifiable. Routing scores task fit, project priority, dependency state, quota pool, reset horizon, billing mode, recent reliability, RAM, model policy, output size, integration cost, and the configured reserve.

Small work is still dispatched when AI Mobile is explicitly active because the console cannot become an implementation worker. The coordinator may instead choose deterministic tooling or combine it with a larger acceptance-linked unit. It never silently pushes work into Luna.

Portfolio candidates use priority-first round-robin fairness. A blocked project is skipped without being completed.

## Explicit User Selection

selectionAuthority user carries a provider or model the user explicitly mandated. Model families are bound canonically: Fable, Opus, Sonnet, and Haiku use Claude; GPT uses Codex; Gemini uses Antigravity. Economics may warn, but authentication, billing, quota, reserve, ownership, storage, and safety gates still win.

Writers require a Git repository and exact expectedFiles. An isolated whole-repository boundary is allowed only in a disposable worktree. Read-only workers create no worktree.

After failure, retry once only for a classified transient failure after fresh evidence changes. Otherwise choose a materially different work-plane path. Never transfer failed work into the visible console.
