# AI Mobile 1.3.4 - reliable recovery and visible upgrade continuation

AI Mobile 1.3.4 fixes the concrete failures observed during a real multi-provider project run.

## Fixed

- Stale failed rounds no longer poison provider selection or consume the no-progress budget of a new execution.
- Planning workers receive the deterministic verification policy before proposing commands, preventing invalid inline `python -c`, `node -e`, and PowerShell `-Command` plans.
- Antigravity permission auto-denial is classified as `authorization-required` even when the CLI exits successfully, allowing safe provider failover.
- Explicit plugin-upgrade restart handoffs perform one bounded OpenAI.Codex package-process reload after same-task continuation so the desktop shows the persisted result.

Normal task execution still never launches or restarts Codex, Classic ChatGPT, Antigravity, Claude, Cursor, or a browser UI.
