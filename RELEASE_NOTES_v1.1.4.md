# AI Mobile 1.1.4 - reliable Codex restart continuity

AI Mobile 1.1.4 fixes the one-shot restart boundary used after a plugin upgrade during active work.

## Fixed

- Hidden PowerShell launch arguments now preserve plugin, workspace, and handoff paths containing spaces.
- The exact Codex desktop package is verified before any process is stopped.
- Obsolete plugin cleanup and exact-thread `codex exec resume` remain one-shot operations.
- Reopening the target workspace is path-safe.

## Observable failure handling

Each handoff now records:

- scheduled helper process id
- current restart phase
- a bounded transition log
- the last concise error
- whether Codex was reopened after success or failure

The helper fails closed when it cannot identify Codex and never targets the classic ChatGPT desktop app.
