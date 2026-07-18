# Changelog

## 1.1.5 - 2026-07-18

- Refreshes the canonical AI Mobile plugin cache after Codex closes and before the exact thread resumes.
- Keeps older authorized handoffs compatible by defaulting their refresh target to `ai-mobile@ai-mobile`.
- Reports the refresh target in dry-run output and fails closed if refresh cannot complete.

## 1.1.4 - 2026-07-18

- Fixed one-shot restart launch failures when the plugin, workspace, or handoff path contains spaces.
- Added durable restart phases, process identifiers, concise error details, and a bounded transition log to every handoff.
- Made restart execution fail closed when the installed Codex desktop process cannot be identified exactly.
- Made workspace reopening path-safe and retained exact-thread, one-shot resume behavior.
- Added regression and harmless hidden-child launch coverage for the real spaced paths used on Windows.

## 1.1.3 - 2026-07-18

- Added exact Fable 5 and Sonnet 5 trusted-primary writing through a private standing policy, with clean Git ownership and mandatory deterministic verification.
- Removed redundant lower-tier model review for successfully verified trusted-primary work while preserving acceptance evidence gates.
- Made the repository a native local marketplace for both Codex and Claude Code, sharing one skill and MCP runtime.
- Added one-shot Codex restart-resume handoffs that preserve the exact thread, task, evidence, priorities, and next action without adding a manager loop.
- Added trusted-primary, shared-host installation, and restart dry-run regressions.
- Added owned-path rollback for failed trusted-primary changes without reverting unrelated concurrent edits.
- Made restart handoffs consumable only once and reopen the exact Codex workspace after headless resume.

## 1.1.2 - 2026-07-18

- Honored explicitly named user models such as Claude Fable during dispatch, reported callable worker job IDs, and exposed concrete provider rejection reasons.
- Allowed user-mandated disjoint external lanes through semantic goal overlap while retaining hard file-ownership conflicts.
- Added Fable and Codex CLI routing regression coverage.
- Fixed explicit user-mandated external lanes being rejected by semantic goal overlap when file ownership is disjoint; added Fable routing regression coverage.
## 1.1.1 - 2026-07-17

- Preserved blocker owner, recovery trigger, and recovery action when importing project acceptance contracts.
- Added a same-turn execution contract that prevents passive diagnosis from ending work while a safe dependency-ready action remains.
- Added explicit resource reports naming current Codex and every provider as selected, idle, or unavailable with model and reason.
- Made dispatch and collection return the current action already in progress instead of user-operated orchestration instructions.
- Hardened the AI Mobile skill so exact authorization is requested only when necessary while other safe work continues.
- Added a production-project-derived continuation regression covering executable blockers, direct Codex work, and Claude Sonnet routing evidence.

## 1.1.0 - 2026-07-17

- Added bounded project-context discovery from `.codex/PROJECT_OUTCOME.md`, `.codex/ACCEPTANCE.json`, and optional `.ai-mobile/project.json`.
- Prevented method-only contracts such as reviews or inspections from silently replacing a broader operational project outcome.
- Added `reconcile-task` so a latest user correction updates the same task, invalidates stale rounds and workers, and preserves only matching acceptance evidence.
- Added automatic acceptance work graphs and concrete current-Codex critical-path units when the request does not provide a plan.
- Prioritized an unresolved `current_slice_requirement_id` when the project contract identifies the active acceptance slice.
- Added typed recovery transitions for ownership, capacity, economics, dependency, and contract rejections.
- Made terminal collection return one-time integration actions and the next acceptance-linked current-Codex unit.
- Added direct core and stdio MCP end-to-end tests for outcome recovery and reconciliation.

## 1.0.0 - 2026-07-16

- Rebuilt AI Mobile around finite outcome tasks and observed execution rounds instead of manager-only control rooms, Goals, heartbeats, automations, or status polling.
- Kept current Codex active on the critical path while allowing at most two disjoint, economically positive Codex CLI, Claude Code, Antigravity CLI, or Cursor workers.
- Moved all runtime state to `%LOCALAPPDATA%\AI Mobile\v1`, with unique task ids, atomic task-scoped updates, and branch-independent concurrent task support.
- Added five-minute positive capacity freshness, 30-second negative freshness, quota-pool evidence, and mandatory cached-negative re-probing before dispatch rejection.
- Split startup from dispatch so Codex inspects the project before declaring file and question ownership.
- Added isolated Git worktrees for writer workers, compact stored patches, one-time collection, deterministic verification, and evidence-gated completion.
- Added finite multi-project portfolios with independent child outcomes, requirements, work graphs, priorities, blockers, patches, evidence, and completion.
- Added machine-wide provider and quota leases, global/per-provider limits, priority fairness, RAM checks, and cross-project file ownership.
- Added configurable worktree disk quota, minimum free space, maximum age, collection/cancellation cleanup, and crash/startup recovery.
- Protected the Codex reserve when measured and refused extra Codex workers when shared capacity is unknown.
- Removed Antigravity broad permission bypass and kept every provider desktop UI behind an explicit user decision.
- Added central-state, stale-capacity, economic, orchestration, writer-isolation, and portable MCP regression suites.

## Pre-1.0 History

Pre-1.0 experiments are retained in Git history and archived release notes under `docs/releases/`. They are not supported runtime contracts for v1.
