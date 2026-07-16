# Changelog

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
