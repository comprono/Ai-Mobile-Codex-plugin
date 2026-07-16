# Project Outcome

State: complete
Updated: 2026-07-16T16:29:39Z

## North Star

AI Mobile must make current Codex and available local AI CLIs work as one efficient team across one or more projects: Codex owns and advances the highest-value critical path, bounded external workers handle only useful independent work, and every project advances from isolated evidence instead of orchestration activity.

## Done Means

- Authority: .codex/ACCEPTANCE.json
- A natural `@ai-mobile` project request starts one finite task without requiring the user to design worker lanes.
- Capacity evidence is current enough for dispatch and never rejects a newly available provider from a stale negative cache.
- Task state survives Git branch changes and concurrent tasks in the same workspace.
- Current Codex keeps working while at most two disjoint external workers run, and integrates each result once.
- One request can coordinate multiple independently verifiable projects from one capacity snapshot and one bounded portfolio plan.
- Machine-wide provider, quota, worker, RAM, and worktree-storage limits prevent cross-project oversubscription while preserving useful concurrency and fairness.
- Every editing worker uses a temporary Git worktree; read-only workers use the shared repository; abandoned worktrees are cleaned after collection, cancellation, crash recovery, and age or disk-limit enforcement.
- No provider desktop UI, heartbeat, Goal, automation, manager loop, or repeated status poll starts automatically.
- Completion and progress claims require acceptance evidence, not process health or worker activity.

## User Intent

Build the plugin properly in one coherent v1 replacement. Preserve useful provider discovery and bounded workers, remove the behavior that wasted tokens and time, keep public defaults reusable, and retain private preferences only in local profile state.

## Work Map

### Critical Path

- Replace workspace-local runtime state and stale capacity semantics.
- Replace the premature one-call lane contract with task start, observed round dispatch, collection, evidence, and completion gates.
- Make worker execution bounded, isolated where practical, and cheaper than direct work.
- Add a portfolio task that owns independent project outcomes, acceptance requirements, work graphs, priorities, blockers, allocation decisions, and evidence references.
- Allocate providers machine-wide with leases, fairness, quota-pool exclusion, Codex reserve, global worker limits, and storage safeguards.
- Prove the installed plugin works through deterministic tests and a disposable real-provider canary.

### Add-ons

- Consolidate documentation and release metadata for v1.
- Preserve scanner and marketplace compatibility.

### Non-goals

- Managing Job Vibhu itself or guaranteeing job applications or interviews.
- Creating background project managers, schedules, Goals, or control-room feeds.
- Treating the classic ChatGPT desktop app as a worker without a supported callable surface.
- Automatically approving credentials, browser actions, live submissions, or irreversible operations.
- Creating worktrees for read-only workers or copying dependency, cache, log, virtual-environment, and build-output directories into worker evidence.

## Verified State

- Repository is clean at v0.6.0 on `main` before the rebuild.
- Central v1 task state now remains independent across same-workspace tasks and Git branch changes.
- Capacity dispatch now re-probes cached negative provider evidence while retaining fresh positive evidence for five minutes.
- Finite task start, observed round dispatch, one-time collection, evidence recording, and completion refusal now pass integration tests.
- Writer workers now execute in detached Git worktrees and return patches without modifying the primary worktree.
- Economic routing keeps small and overlapping work direct, protects measured Codex reserve, and avoids extra Codex workers when shared capacity is unknown.
- A two-project disposable portfolio now runs independent editing workers concurrently, keeps current Codex on the highest-priority project, allows a ready project to advance past a blocked sibling, and refuses cross-project evidence reuse.
- Machine-wide tests now prevent provider, quota-pool, global-worker, and file-ownership conflicts while preserving priority fairness and Codex reserve policy.
- Worktree tests now enforce disk and free-space limits and prove collection, cancellation, lost-worker, startup, and maximum-age cleanup with no primary-worktree edits or read-only worktrees.
- Plugin Scanner lint and full scan pass at 100/100 with zero findings; verify passes every static check and skips only local stdio execution by scanner policy.
- Codex reports `ai-mobile@personal` installed and enabled at v1.0.0; the installed cache passes self-test, portfolio end-to-end, and storage lifecycle checks.
- A real installed Antigravity CLI canary used Gemini 3.5 Flash Medium, returned the exact disposable marker, recorded integration evidence, completed successfully, and opened no desktop UI.
- Verified v1 was committed as `16adcf7` and pushed to `origin/main` at `https://github.com/comprono/Ai-Mobile-Codex-plugin`.
- Existing unit, regression, and simulated reliability tests pass but do not cover stale negatives, branch-safe state, concurrent tasks, or live provider integration.
- Current orchestration stores task and job state inside each workspace and requires candidate lanes before project inspection.
- Current capacity cache can be reused for one hour and has produced false provider absence.

## Context Pointers

- `skills/ai-mobile/SKILL.md`
- `scripts/mcp/server.js`
- `scripts/core/task-orchestrator.js`
- `scripts/core/capacity.js`
- `scripts/core/job-store.js`
- `scripts/providers/index.js`

## Assumptions To Test

- Provider CLIs can be probed without opening their desktop applications.
- Central local JSON state with atomic task-scoped writes is sufficient without adding a database dependency.
- Isolated Git worktrees can be optional, with read-only fallback for dirty or non-Git workspaces.
- Provider quota-pool exclusivity is conservative enough to prevent oversubscription without suppressing unrelated provider pools.

## Decisions

- Keep the existing repository and plugin identity, but release the replacement as v1.0.0.
- Current Codex is an active integrator, not a passive manager.
- Use finite hybrid rounds with at most two external workers and a default 15 percent Codex reserve.
- Store runtime state under `%LOCALAPPDATA%\AI Mobile\v1`, never in the managed workspace.
- CLI is automatic; UI fallback is explicit and user initiated.
- A portfolio is finite orchestration state, not a manager loop: it advances only on explicit start, dispatch, collect, evidence, summary, complete, or cancel calls.
- Discover capacity once per portfolio start and refresh only when dispatch evidence is stale or negative, not through polling.

## Failure Memory

- A stale negative capacity record must never hard-reject a provider without a fresh probe.
- Asking Codex to invent file ownership before reconnaissance can reject all useful workers and must not return.
- Workspace-local orchestration state is invalid because branch and cleanup operations can erase or confuse it.
- Worker activity, polling, and process health must not be reported as outcome progress.
- Delegating work whose review costs as much as the work is a routing failure.
- Cross-project concurrency without machine-wide leases can oversubscribe one provider or quota pool and is invalid.
- Worktree isolation without disk, age, crash, cancellation, and collection cleanup is an unbounded storage leak.

## Current Slice

- Acceptance ID: PUBLIC_RELEASE
- Goal: Pass scanner/privacy gates, install v1 locally, and prove one authenticated disposable provider handoff without UI fallback.
- Evidence target: end-to-end installed-plugin and real-provider canary evidence.

## Next

No required v1 work remains. Restart Codex before using the new skill and MCP schema in a fresh task.
