# AI Mobile v0.4.0 - finite, token-efficient execution

AI Mobile 0.4.0 is a subtractive reliability release. It keeps Codex working on the project and delegates only independent work that is expected to save more time or context than dispatch and integration cost.

## Changes

- Replaced the orchestration monolith with a modular six-tool MCP runtime.
- Removed manager loops, control rooms, heartbeats, polling, schedules, supervisors, and continuous-cycle execution.
- Added passive native discovery for Codex CLI, Claude Code, Antigravity CLI, and optional headless Cursor.
- Added finite background jobs under `.ai-mobile/jobs` with compact artifacts and append-only state transitions.
- Added strict read-only and writer-boundary enforcement plus allowlisted no-model verification.
- Kept existing `.antigravity-bridge/jobs` readable for migration without executing the old runtime.
- Made Antigravity CLI sandboxed and desktop-free by default.

The result is designed to make orchestration cheaper than the work it saves, fail closed when evidence is missing, and leave final project judgment with the current Codex task.
