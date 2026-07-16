# AI Mobile 1.0 - finite local AI orchestration for Codex

AI Mobile 1.0 is a clean runtime replacement focused on useful project delivery.

## Highlights

- Current Codex remains the accountable working agent and owns the critical path.
- One finite request can coordinate multiple separate projects with independent outcomes, work graphs, priorities, blockers, evidence, and completion.
- Claude Code, Antigravity CLI, Codex CLI, and optional Cursor receive only bounded independent work.
- Capacity evidence includes freshness, confidence, model or quota-pool scope, and reset time when exposed.
- Writer workers use isolated Git worktrees and return patches without touching the primary worktree.
- Machine-wide provider, quota-pool, worker, RAM, file-ownership, fairness, and worktree-storage guards prevent cross-project oversubscription.
- Editing worktrees are cleaned after collection, cancellation, worker loss, startup recovery, or maximum age; read-only workers create none.
- Completion requires recorded acceptance evidence.
- No desktop application, manager loop, Goal, heartbeat, automation, or repeated poll starts automatically.

## Upgrade

AI Mobile 1.0 preserves safe private profile preferences but does not import pre-1.0 task, job, lease, or workspace state. Restart Codex after installing this release so its skill and MCP schema load together.
