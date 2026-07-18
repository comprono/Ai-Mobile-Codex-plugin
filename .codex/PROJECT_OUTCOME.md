# Project Outcome

State: complete
Updated: 2026-07-18T04:02:00Z

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
- Editing workers use temporary Git worktrees except exact Fable 5 and Sonnet 5 lanes enabled by the user's trusted-primary policy; read-only workers use the shared repository, and abandoned worktrees are cleaned after collection, cancellation, crash recovery, and age or disk-limit enforcement.
- No provider desktop UI, heartbeat, Goal, automation, manager loop, or repeated status poll starts automatically.
- Completion and progress claims require acceptance evidence, not process health or worker activity.
- A project request cannot silently narrow an existing operational outcome into a method such as review, inspection, planning, or monitoring.
- The latest user correction can revise an active task without preserving stale outcome, acceptance, worker, or plan assumptions.
- A rejected or completed worker round returns the next acceptance-linked recovery transition instead of leaving Codex at a dead end.
- An invocation never ends at passive diagnosis while an authorized, dependency-ready recovery action remains: current Codex starts it in the same turn, and model use plus material progress are reported with reasons.
- Exact Claude Fable 5 and Sonnet 5 workers may edit a clean, explicitly bounded primary workspace under the user's saved trust policy; other writers remain isolated, and trusted work is mechanically verified without a second model review.
- Codex and Claude Code install AI Mobile from the same repository and execute the same versioned MCP runtime instead of separate copied implementations.
- A required Codex upgrade can cross the restart boundary through one explicit, durable, one-shot resume handoff without asking the user to restate the project.
- A restart targets only the installed `OpenAI.Codex` package, reopens the exact workspace and thread, and resumes with the requested Codex model without invoking an installer-capable launcher or Classic ChatGPT.
- A durable task whose outcome matches its project contract refreshes requirement status and evidence from that authoritative contract, without creating a duplicate task or importing evidence into an unrelated explicit outcome.

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

- Managing any downstream project itself or guaranteeing external business outcomes.
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
- Plugin Scanner 2.0.1114 default, public-marketplace, and strict-security lint pass at 100; the full repository scan passes at 100/100 with zero findings. Standalone verify passes every static check and marks local stdio execution as a safety-skip by scanner policy.
- Codex and Claude Code both resolve `ai-mobile@ai-mobile` v1.1.3 from this repository and share the same root MCP runtime; strict Claude plugin validation passes.
- A method-only review contract now recovers the bounded project north star and acceptance gap while an explicit review deliverable remains authoritative.
- `reconcile-task` now revises the same task, invalidates stale rounds, preserves matching evidence, removes changed evidence, and reopens completed work when the contract changes.
- Rejected or completed worker lanes now return typed recovery or exact integration and acceptance identifiers rather than an unowned generic instruction.
- A real installed Antigravity CLI canary used Gemini 3.5 Flash Medium, returned the exact disposable marker, recorded integration evidence, completed successfully, and opened no desktop UI.
- All thirteen deterministic release suites plus the MCP self-test pass, including trusted direct-write rollback, shared-host installation, portfolio isolation, global resource leases, storage lifecycle cleanup, and no automatic desktop launch.
- A production-project field test exposed that imported blocked requirements lose their owner, recovery trigger, and recovery action; start-task also reports provider availability without an explicit use/non-use decision, allowing Codex to stop after diagnosis.
- AI Mobile 1.1.1 now preserves executable blockers, emits same-turn execution and reasoned resource reports, passes 11 deterministic suites and both scanner profiles at 100, and passes an installed production-project field test.
- AI Mobile 1.1.3 adds exact Fable 5 and Sonnet 5 trusted-primary execution, mechanical verification without lower-tier model review, private policy controls, shared Codex/Claude installation, and authorized one-shot Codex restart continuity.
- The prior restart-continuity proof was invalidated after a real restart invoked installer-capable `codex app` and failed to guarantee the exact desktop package, model, and thread.
- A the existing production project field run exposed a second gap: durable task requirements could remain at 0/5 while the matching project acceptance contract reported 3/5, because supplied requirements overrode authoritative project evidence and summary did not refresh it.
- AI Mobile 1.1.6 now targets only the exact `OpenAI.Codex` package, carries an exact resume model, and reopens the requested workspace and thread deep link without using `codex app` or Classic ChatGPT.
- Acceptance fingerprints now refresh stale matching tasks only when the project contract changes, preserving newer task evidence when the project file is unchanged and isolating explicit unrelated outcomes.
- All 14 release suites pass; Scanner 2.0.1114 default, public, strict, and full scan gates score 100 with zero findings. Standalone verify has only its documented local-stdio safety skip, covered by the 46-assertion runtime self-test.
- The authorized one-shot restart consumed for the installed OpenAI.Codex package, resumed the exact thread on gpt-5.6-luna, and loaded ai-mobile@ai-mobile 1.1.6 without selecting Classic ChatGPT. Evidence is recorded in `.codex/ACCEPTANCE.json`, verified 2026-07-18.

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

- Current Codex is an active integrator, not a passive manager.
- A higher-tier trusted writer is not reviewed again by a lower-tier model. Scope, Git state, deterministic tests, and acceptance evidence remain mandatory.
- Use finite hybrid rounds with at most two external workers and a default 15 percent Codex reserve.
- Store runtime state under `%LOCALAPPDATA%\AI Mobile\v1`, never in the managed workspace.
- CLI is automatic; UI fallback is explicit and user initiated.
- Recover intent from bounded project contracts and the latest user request; never add an unbounded manager loop or hidden model call to interpret it.
- Restart only the exact installed `OpenAI.Codex` package and reopen with the supported project and thread deep-link arguments; never use installer-capable `codex app` for continuity.

## Failure Memory

- A method-shaped task contract can faithfully orchestrate the wrong outcome; project intent must be reconciled before dispatch.
- A latest user correction must invalidate stale outcome, acceptance, round, and worker assumptions instead of continuing sunk work.
- Rejected delegation or passive capacity discovery is a planning event, not a stopping point; preserve executable recovery metadata and start the owned same-turn action.
- Worker activity, polling, process health, and review chains are not outcome progress and may cost more than direct work.
- Resource and worktree limits must remain machine-wide and bounded while the outcome-recovery layer changes.
- A dry-run command is not proof that a desktop restart targets the correct package, thread, and model.
- Stored task requirements must not override newer evidence in a matching authoritative project acceptance contract.

## Current Slice

- Acceptance ID: none
- Goal: Maintain the complete AI Mobile 1.1.6 release contract.
- Evidence: all 16 required acceptance requirements pass, including exact-package restart continuity and authoritative task-state synchronization.

## Next

Maintain the finite AI Mobile 1.1.6 release. Future changes must reopen the affected acceptance requirement before publication.
