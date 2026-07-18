# AI Mobile 1.2 Implementation Report

## Outcome

AI Mobile coordinates local AI subscriptions so one measurable project outcome advances without turning the visible Codex conversation into an expensive implementation worker.

The visible task is a lightweight project console. A deterministic coordinator assigns actual project work to separate Codex CLI, Claude, Antigravity, or Cursor workers. Every assignment is finite, acceptance-linked, capacity-aware, isolated, and independently verifiable.

## Why 1.2 Exists

The earlier design made current Codex both manager and critical-path implementer. When the visible task was moved to Luna for cheap reporting, Luna inherited coding, architecture, and integration. That defeated the model split and caused stale-runtime diagnosis, duplicated review, high token use, and weak visible progress.

Version 1.2 separates three concerns:

1. Console: user direction, decisions, compact verified reports.
2. Coordinator: deterministic outcome recovery, dependency selection, capacity routing, leases, economics, and evidence state.
3. Work plane: separate models and no-model tools that read, reason, edit, test, and integrate.

## Finite Flow

1. start-task imports the project North Star and acceptance requirements.
2. The coordinator identifies one dependency-ready critical-path unit.
3. run-task-cycle opens one bounded execution window and dispatch-round selects an eligible work-plane provider from fresh evidence.
4. A read-only worker shares the workspace; an editor receives an isolated Git worktree unless an exact trusted-primary exception applies.
5. The cycle waits locally without repeated model turns, collects one terminal handoff, and cleans the worktree.
6. integrate-round verifies boundaries, checks for concurrent primary changes, applies the patch once, runs declared primary-workspace tests, and rolls back a failure.
7. An unchanged failed provider is not retried in the same cycle; an automatic lane may fail over to another eligible provider.
8. record-evidence advances only the named acceptance item.
9. complete-task succeeds only when every required item passes.

No recurring LLM manager, Goal, heartbeat, automation, hidden Codex run, repeated model-turn poll, or provider UI is created.

## Resource Selection

The router observes provider availability, authentication, models, quota pools, remaining capacity when knowable, reset time, billing mode, recent reliability, free RAM, worktree storage, project priority, dependencies, output budget, and total integration cost.

Model names are not permanent roles. The console uses the cheapest capable low-effort model. Bulk context uses deterministic or economical workers. Consequential planning uses the strongest suitable available model. Implementation uses the best eligible bounded worker. Verification uses no-model evidence first.

Codex CLI is a normal work-plane candidate when shared Codex capacity remains above the configured reserve.

## Safety

- The console owns no project files.
- Machine-wide leases prevent provider and quota oversubscription.
- One worker owns each file boundary.
- Whole-repository writer ownership is allowed only inside an isolated worktree.
- Unverified patches never enter the primary workspace.
- Concurrent primary changes block integration instead of being overwritten.
- Failed primary verification triggers a reverse-patch rollback.
- Exact trusted Fable 5 and Sonnet 5 primary writers require clean bounded paths, exact model identity, and deterministic checks.
- External actions remain behind project authorization, truthfulness, duplicate, login, CAPTCHA, document, and receipt gates.

## Restart Invariant

A source install is not active in an already loaded task. The release gate enforces:

validate and install -> close only OpenAI.Codex -> app-server resumes the exact task -> capable-model tool call proves the fresh runtime -> same-task Luna-low console turn reconciles and runs one bounded execution cycle through a terminal result -> reopen the exact desktop task.

Luna never repairs a stale plugin runtime.

## Falsifiable Acceptance

The release fails if any of these occur:

- the visible console receives project file ownership;
- dispatch rejection tells the console to code;
- Codex CLI is ignored despite measured capacity above reserve and best task fit;
- a worker patch needs Luna or another model merely to apply it;
- an unverified or conflicting patch changes the primary workspace;
- a portfolio oversubscribes a provider or shares evidence across projects;
- a desktop application opens during normal startup or dispatch;
- a stale runtime permits a model switch before restart verification;
- activity is reported as outcome progress.
