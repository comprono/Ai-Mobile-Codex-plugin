# AI Mobile 0.5.2 - stale-task protection

AI Mobile now detects when an existing Codex task is still bound to an older plugin runtime after an update.

## Fixed

- Rejects stale plugin calls before capacity inventory or worker execution.
- Prevents an old task from silently using removed tools or inventory-only behavior.
- Returns one explicit recovery instruction: start a fresh Codex task so Codex can load the installed skill and MCP schema.
- Covers cachebuster ordering and stale-runtime detection with deterministic tests.

Codex currently freezes plugin skills and MCP schemas when a task starts. Reopening an old task cannot upgrade that task in place; this release makes that boundary visible and fail-closed instead of costly and misleading.
