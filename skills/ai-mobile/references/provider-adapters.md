# Provider Adapters

## Native Codex

- Dispatch boundary: the host's native agent tool.
- Never invoke a locked or nested `codex.exe` process.
- Pass exact catalog model and supported effort from `project-manager-plan.json`.
- Receive the worker result directly in the control chat and integrate it once.

## Claude Code

- Status/capacity: `claude-status`, `claude-usage`.
- Dispatch: `submit-claude-job`.
- Readback: `read-job` or aggregate team state.
- Keep bounded runtime and prompt/result artifacts.

## Antigravity CLI

- Status/models: `agy-status`, `agy-models`.
- Dispatch: `submit-agy-job`.
- CLI is the normal low-RAM path.

## Antigravity Desktop

Use only when project/chat/model/composer visibility is required. Verify intended project, active chat, selected model, and idle composer before submission. Submission is successful only after the message is visibly accepted or a verified bridge job starts.

If the DevTools MCP transport is closed, call `devtools-health` once. Repeated calls cannot revive the same dead transport. Use CLI or restart the host session only when UI control remains required.

## Cursor

- Status: `cursor-status`.
- Dispatch: `submit-cursor-job` only for a verified headless agent.
- `open-cursor` is an explicit UI fallback, never an automatic startup action.

## Startup

All adapters are passive during Codex startup. Model/catalog discovery must not open desktop applications. UI open/repair commands require an active task need or explicit user request.
