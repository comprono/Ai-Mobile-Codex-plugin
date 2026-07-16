# AI Mobile 0.6.0 - Bound Tasks And Truthful Handoffs

- Parallel, deadline-bounded passive capacity discovery for Codex, Claude Code, Antigravity, and optional Cursor.
- Caller-declared current-Codex task binding with explicit ownership and a durable task handoff inbox.
- One compact terminal handoff per worker, containing its contribution, integration action, changed files, verification state, and blocker.
- Finite worker leases: stale workers become terminal failures instead of indefinitely reporting `running`.
- No new manager loop, scheduler, heartbeat, polling tool, UI launch, or automatic control of the active Codex chat.

## Verification

- Plugin self-test, orchestration regression, economic regression, and MCP portability regression pass.
- The real MCP server returns the cached passive inventory through its asynchronous tool path.
- `plugin-scanner lint .` passes with score 100. `plugin-scanner verify .` requires manual review for arbitrary local stdio MCP execution, which the scanner intentionally refuses to run.
