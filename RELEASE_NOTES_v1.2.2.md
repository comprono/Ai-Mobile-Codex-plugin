# AI Mobile 1.2.2 - visible and bounded Codex restart continuity

AI Mobile 1.2.2 fixes the restart failure that could leave the Codex desktop closed while an app-server verification turn or project cycle was still running.

- Reopens the exact OpenAI.Codex package and task immediately after the plugin cache refresh.
- Runs fresh-runtime verification and the Luna-low continuation only after the desktop is visible.
- Bounds the continuation helper to 20 minutes and cleans only its own stale process tree on timeout.
- Keeps Classic ChatGPT excluded and preserves the same Codex task, provider safety gates, and bounded worker cycle.
- Normal project execution never closes, reopens, or launches Codex or another desktop app; restart remains an explicit plugin-upgrade boundary only.
- Caps each synchronous MCP execution slice at 210 seconds and returns continuationRequired for the same finite worker instead of timing out at the host boundary.
- Runs Codex CLI writers with noninteractive approval inside workspace-write isolation, rejects no-patch results before verification, and refuses auto-generated root-wide writer/test contracts.