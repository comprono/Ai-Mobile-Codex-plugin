# Capacity-Aware Work Orchestration

## Decision Flow

1. Receive the latest outcome and acceptance evidence.
2. Load the bounded project contract.
3. Discover machine and provider capacity once.
4. Select the highest-value dependency-ready gap.
5. If a human decision is required, report it exactly and continue other ready work.
6. Build one finite work-plane unit.
7. Score providers and models by role, quota, reset, reliability, cost, RAM, and reserve.
8. Acquire machine-wide provider, quota, file, and storage leases.
9. Run the bounded worker.
10. Collect once and clean its worktree.
11. For a writer, check boundaries and concurrent primary changes.
12. Apply the patch once and run deterministic primary verification.
13. Reverse the patch if verification fails.
14. Record only sufficient acceptance evidence.
15. Select the next dependency-ready gap.

## Console Rule

The visible Codex task is not a worker. It takes direction, invokes coordinator tools, presents material decisions, and reports verified transitions. It owns no project paths and does not absorb a rejected worker task.

## Work-Plane Rule

Every unit is bounded by outcome, acceptance item, dependency node, read paths, write paths, deterministic checks, timeout, output budget, and integration action.

Separate projects may run concurrently. Units inside one project run concurrently only when ownership and reasoning questions are disjoint.

## Capacity Rule

Unknown capacity is not treated as free. Shared Codex usage above reserve may be assigned to Codex CLI. Independent Claude or Antigravity quota may be used when task fit and total economics are better. Premium capacity near reset is useful only for a task that needs it.

## Progress Rule

Assignments, running processes, passing unit tests, and model usage are not project completion. Progress requires accepted evidence against the project contract.
