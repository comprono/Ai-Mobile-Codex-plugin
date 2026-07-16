# AI Mobile v1 Implementation Report

## Outcome

AI Mobile v1 makes current Codex and authenticated local AI CLIs operate as one finite team across one or more projects. Current Codex remains responsible for intent, critical-path work, integration, risky actions, and final verification. External workers are temporary resources, not managers.

## Why The Runtime Was Replaced

Earlier versions accumulated manager terminology, continuous status behavior, workspace-local state, stale capacity decisions, and worker activity reports. In real project use this created four failures:

1. orchestration consumed more time and tokens than it saved;
2. current Codex became a reporter instead of a working agent;
3. stale provider evidence and duplicate rounds caused false blocks or repeated work;
4. process health was mistaken for project progress.

Version 1 removes those mechanisms instead of layering another manager over them.

## Runtime Architecture

```text
Codex task
  -> start-task
       -> central outcome or portfolio state
       -> one passive machine/provider inventory
  -> current Codex reconnaissance and critical-path work
  -> dispatch-round
       -> dependency, ownership, economics, capacity, and safety routing
       -> machine-wide resource lease
       -> read-only shared repository OR detached editing worktree
  -> collect-round
       -> compact handoff, patch, usage, deterministic verification
       -> immediate editing-worktree cleanup
  -> record-evidence
       -> project-local acceptance requirement
  -> complete-task
       -> fail closed until every required project passes
```

Runtime state is stored under `%LOCALAPPDATA%\AI Mobile\v1` with atomic JSON writes and task-scoped locks. It survives Git branch changes and never adds orchestration files to managed repositories.

## Single And Multi-Project Contracts

The same nine tools serve both modes.

Single-project mode stores one task with outcome, requirements, current-Codex ownership, rounds, jobs, and evidence.

Portfolio mode adds one portfolio record and one independent child task per project. It stores priorities, blockers, dependency work graphs, allocation decisions, and evidence references without merging project state. Each worker job belongs to exactly one child task and one optional work-graph node.

## Allocation Invariants

- Current Codex receives the highest-value ready critical path and starts immediately.
- External work must be dependency-ready, disjoint, bounded, independently verifiable, and economically positive unless the user explicitly mandates a provider/model.
- A user mandate can override the economic warning, but never authentication, billing, quota, ownership, storage, or safety gates.
- Machine-wide leases enforce global and per-provider limits and quota-pool exclusion.
- Priority-first round-robin allocation provides portfolio fairness.
- The Codex reserve is enforced before an additional Codex CLI worker is eligible.
- Unknown shared Codex capacity cannot justify an extra Codex worker.
- UI-required work returns a typed blocker and never launches a desktop app automatically.

## Evidence Invariants

Evidence levels are ordered:

```text
activity < process-health < focused-test < integration < end-to-end < user-visible
```

A lower level cannot satisfy a higher requirement. Worker completion, process health, elapsed time, token use, and a passing unit test cannot prove an end-to-end outcome unless the acceptance contract explicitly requires that evidence level.

Portfolio evidence must include `projectId`; the runtime writes it only to that child task. Completing one project never completes another. Portfolio completion requires every required project task to be complete.

## Storage Invariants

- Read-only workers create no worktree.
- Editing workers require an exact Git repository root.
- Editing worktrees are detached and share Git history.
- The primary worktree is never the worker execution directory.
- Disk quota, minimum free space, and maximum age are configurable in the private local profile.
- Dependencies, caches, logs, virtual environments, coverage, and build outputs are removed before patch capture.
- Collection, cancellation, worker loss, startup, and age expiry all have cleanup transitions.

## Token-Efficiency Invariants

- No delegation for trivial or tightly coupled work.
- No parent transcript in worker prompts.
- No repeated polling or status feed.
- No premium-on-premium review chain.
- Deterministic checks precede model review.
- Worker outputs are bounded, and full diagnostics are read only for a focused blocker.
- Current Codex integrates a useful result once; it does not redo the worker's question.
- A same-outcome failure is retried only after failure classification and changed evidence.

## Release Gates

Version 1 is releasable only when all gates in `.codex/ACCEPTANCE.json` pass:

1. central state and stale-negative capacity recovery;
2. finite current-Codex-led orchestration;
3. no automatic UI, loops, Goals, heartbeats, automations, or repeated polls;
4. economically positive delegation;
5. two-project portfolio concurrency and independent completion;
6. global provider, quota, worker, fairness, reserve, RAM, and ownership guards;
7. worktree quota, free-space, age, collection, cancellation, and crash cleanup;
8. local installation, scanner/privacy checks, and a disposable real-provider canary.

Tests are executable under `scripts/` and are listed in the repository README.
