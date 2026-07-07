# AI Mobile Codex Plugin

Created by [comprono](https://github.com/comprono).

AI Mobile is a community Codex MCP plugin for mobile-started OpenAI Codex workflows that need to reach local desktop AI workers on Windows. It connects Codex to Google Antigravity / Antigravity 2.0 through the lightweight `agy` CLI, MCP, Chromium DevTools, and local PowerShell helper commands, and it can also dispatch coding/review jobs to local Claude Code and Cursor workers when their CLIs are available.

Use this repo for the combined bridge: ChatGPT mobile or Codex can hand work to the Windows desktop, then use Antigravity CLI for low-RAM Antigravity work, Antigravity desktop only for visible project/chat/UI workflows, Claude Code for headless local coding or review jobs, and Cursor UI when a visible Cursor workspace/chat is the right surface. If a user asks for Claude/Sonnet in a named Antigravity chat, this plugin treats that as an Antigravity model selection, not as Claude Code CLI.

The Antigravity-only project remains in the separate `antigravity-2-codex-plugin` repository.

After setup, you can start from the ChatGPT mobile app, open Codex, and use this local plugin as the bridge into your Windows Antigravity, Claude Code, and Cursor desktop session.

## AI Mobile Bridge

This is a community Codex plugin for connecting OpenAI Codex to local AI desktop workers. It provides an Antigravity 2.0 Codex bridge for visible Antigravity project/chat workflows, an optional Claude Code headless bridge for local repository work, and Cursor UI/headless-agent detection for Cursor-based workflows. Worker paths write compact `.antigravity-bridge/jobs/<jobId>/` artifacts so Codex can save tokens by reading results instead of watching full chats or logs.

AI Mobile is designed as an orchestration plugin: Codex checks the task shape, caller-provided Codex budget state, Antigravity model availability, Claude Code availability, and Cursor availability, then chooses the cheapest reliable worker before doing broad work.

Keywords: AI Mobile Codex plugin, OpenAI Codex Antigravity, Antigravity 2.0 Codex bridge, Claude Code Codex bridge, Cursor Codex bridge, Codex MCP plugin, DevTools MCP Antigravity, mobile Codex desktop bridge.
## What It Does

- Launches the local Antigravity desktop app.
- Reports install path, user data path, running process IDs, setup readiness, and DevTools port.
- Reports Antigravity model quota state from the local language server and model availability from `agy models`.
- Connects to Antigravity's bundled `chrome-devtools-mcp` server when available.
- Exposes local setup/model/status and active-model switch commands as MCP tools, so Codex can use them even when skill files are unavailable.
- Creates durable `.antigravity-bridge/jobs/<jobId>/` folders so Codex can submit work once and later read compact result artifacts.
- Runs low-RAM Antigravity CLI bridge jobs with `agy -p` when visible UI state is not required.
- Optionally dispatches durable bridge jobs to local Claude Code headless mode when the `claude` CLI is installed.
- Detects local Cursor, opens Cursor workspaces or standalone chat only when needed, and uses a true `cursor-agent` binary for headless jobs when one is installed.
- Helps Codex inspect live project/chat context from the UI.
- Supports safe handoff to continue an existing chat, start a new chat in an existing project, or start a new project.
- Provides a local privacy scan for sensitive data before publishing changes.

## Requirements

- Windows.
- Antigravity installed at `%LOCALAPPDATA%\Programs\Antigravity\Antigravity.exe`.
- Antigravity CLI installed as `agy` or `%LOCALAPPDATA%\agy\bin\agy.exe`.
- Codex plugins loaded from `%USERPROFILE%\plugins`.
- Node.js available on `PATH` for the DevTools MCP bridge.
- Optional: Claude Code CLI available as `claude` on `PATH` and logged in for headless Claude bridge jobs.
- Optional: Cursor installed at `%LOCALAPPDATA%\Programs\cursor`; a true `cursor-agent` binary is required for headless Cursor jobs. The normal `cursor.cmd` launcher is treated as UI-only on Windows.

## Install

Clone this repository into the recommended Codex local plugin folder:

```powershell
git clone https://github.com/comprono/Ai-Mobile-Codex-plugin.git "$env:USERPROFILE\plugins\ai-mobile"
```

Then install or refresh the plugin from your Codex personal marketplace.

For a setup check after cloning:

```powershell
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\plugins\ai-mobile\scripts\antigravity.ps1" setup
```

The setup report tells Codex whether Antigravity is installed, whether Node.js is available, whether the bundled DevTools MCP package exists, whether the DevTools endpoint is reachable, and whether the local language-server model-limit API is ready.

## MCP Tools

The plugin registers two MCP servers:

- `ai-mobile-local`: direct local tools for `quick`, `setup`, `doctor`, `status`, `open`, `repair-live`, `inspect`, `live`, `devtools-health`, `submission-guide`, `prepare-offload`, `orchestration-plan`, `create-job`, `submit-job`, `select-chat`, `agy-status`, `agy-models`, `submit-agy-job`, `claude-status`, `submit-claude-job`, `cursor-status`, `open-cursor`, `submit-cursor-job`, `list-jobs`, `read-job`, `cancel-job`, `retry-job`, `switch-model`, `submit-offload`, `limits-summary`, `limits`, `models`, `offload-advice`, `handoff-template`, and `privacy`.
- `ai-mobile-devtools`: Chromium DevTools controls for inspecting and driving the Antigravity UI.

Startup is passive. Opening Codex must not open, close, restart, or repair Antigravity. The DevTools MCP server only connects when Antigravity is already running and inspectable; use `ai-mobile-local.open` or `ai-mobile-local.repair-live` only after the user asks to use Antigravity.

Codex should call `ai-mobile-local.orchestration-plan` first for nontrivial work. The plan compares caller-provided Codex budget state, Antigravity model limits, Claude Code availability, Cursor availability, whether visible UI/chat state is required, and the estimated direct Codex token cost. Codex should follow that route instead of guessing. Use `ai-mobile-local.submit-job` for nontrivial workspace work when the correct Antigravity project/chat is already selected. It creates a durable job folder, prepares the artifact contract, verifies or switches the active model with `modelPreference=auto`, fills the active composer, and submits with a direct CDP Enter keypress, avoiding repeated `list_pages`, snapshots, fill, key, and evaluate calls. Use `ai-mobile-local.submit-offload` only for lightweight selected-chat handoffs that do not need a durable job folder. If Sonnet/Opus/GPT-OSS is exhausted or the user asks for Flash, Codex should call `ai-mobile-local.switch-model` with `modelPreference=flash-medium` before submitting. If the MCP tool list is stale and does not show the job/model tools, use the PowerShell helper `antigravity.ps1 orchestration-plan` / `antigravity.ps1 submit-job` / `antigravity.ps1 switch-model` before falling back to DevTools choreography. Use `ai-mobile-local.prepare-offload` when Codex should show the plan first or when the selected chat is uncertain. For nontrivial workspace, repo, browser, UI, research, planning, debugging, review, implementation, and job-application work, the intended cost split is: Antigravity explores and works locally; Codex plans, gates safety, reviews final changes, and summarizes from job artifacts. Use `ai-mobile-local.quick` for general setup checks. If `ReadyForLiveUiInspection` is false, call `ai-mobile-local.repair-live` once before using DevTools. If repair restarts Antigravity, an already-started DevTools MCP connection may need to reconnect to the new port. If `ai-mobile-devtools` fails with `Transport closed`, call `ai-mobile-local.devtools-health`; do not keep retrying `list_pages` in the same broken transport. Use `limits-summary` for normal quota checks and full `limits` only when the complete per-model JSON is needed.

When Antigravity work does not require visible desktop project/chat state, Codex should call `ai-mobile-local.agy-status`, `ai-mobile-local.agy-models`, and `ai-mobile-local.submit-agy-job` before opening the desktop UI. This uses Antigravity CLI print mode, creates the same durable job folder, and avoids desktop RAM overhead. Use the Antigravity desktop UI only for visual project/chat state, model picker work, or workflows that require the Manager/Editor interface.

When the task is local coding or review work and Antigravity context is not needed, Codex can call `ai-mobile-local.claude-status` and then `ai-mobile-local.submit-claude-job`. This uses Claude Code's non-interactive CLI mode, creates the same durable job folder, and returns immediately so Codex can later call `read-job` instead of watching a chat. If the user says "no Claude CLI" or names an Antigravity project/chat and asks for Claude/Sonnet/Opus, Codex must not use `submit-claude-job`; it must select and verify the existing Antigravity chat, switch the Antigravity model there, and only then submit.

When the task belongs in Cursor, Codex should call `ai-mobile-local.cursor-status` first. If `HeadlessAgentFound` is true, Codex may use `submit-cursor-job`. If only the Cursor UI launcher is available, Codex should use `open-cursor` for the visual workflow and must not pretend that `cursor.cmd agent -p` is headless.

Existing-chat submissions are strict. If `expectedChat` is provided, it must match the active Antigravity document title, not merely a sidebar item or previous message. Use `select-chat` first when the target chat is visible but not active. The helper refuses to submit in a new chat and records `submit_failed` when Antigravity does not accept the prompt. Codex must not wait for artifacts unless the helper returns `Submitted: true`.

For the lowest-token phone workflow, prefer `ai-mobile-local.submit-job` over raw chat watching. It creates:

```text
.antigravity-bridge/
  jobs/
    <jobId>/
      request.md
      status.json
      result.md
      changed-files.txt
      diff.patch
      test-output-summary.md
```

Codex should submit the job, stop watching the UI, and later call `read-job` to read only `result.md`, `changed-files.txt`, `diff.patch`, `test-output-summary.md`, and `status.json`.

## Usage

Check status:

```powershell
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\plugins\ai-mobile\scripts\antigravity.ps1" status
```

Fast combined readiness and quota summary:

```powershell
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\plugins\ai-mobile\scripts\antigravity.ps1" quick
```

Plan which worker should handle a task:

```powershell
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\plugins\ai-mobile\scripts\antigravity.ps1" orchestration-plan -Goal "<goal>" -Workspace "<path>" -CodexBudgetState "unknown" -EstimatedCodexInputTokens 2000
```

Open Antigravity:

```powershell
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\plugins\ai-mobile\scripts\antigravity.ps1" open
```

Repair live DevTools inspection if Antigravity is running but exposes zero pages:

```powershell
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\plugins\ai-mobile\scripts\antigravity.ps1" repair-live
```

Inspect integration details:

```powershell
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\plugins\ai-mobile\scripts\antigravity.ps1" inspect
```

Inspect live UI connection:

```powershell
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\plugins\ai-mobile\scripts\antigravity.ps1" live
```

After a DevTools MCP `Transport closed` error, use the local fallback:

```text
Call ai-mobile-local.devtools-health.
```

If it reports pages are ready, restart Codex to recreate the DevTools MCP transport or use `ai-mobile-local.handoff-template` for a manual paste into Antigravity for the current turn.

Report model quota state:

```powershell
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\plugins\ai-mobile\scripts\antigravity.ps1" limits-summary
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\plugins\ai-mobile\scripts\antigravity.ps1" models
```

The `limits-summary` command gives a compact availability summary. The `models` and `limits` commands call Antigravity's local language server over its gRPC-web API (`LanguageServerService/GetAvailableModels` and `GetLoadCodeAssist`) and return the fuller per-model data. This is the same source the Antigravity Models tab uses. It returns per-model quota metadata such as remaining fraction and reset time when available. It does not expose a raw all-model token ledger if Antigravity itself does not publish one.

Check and use the low-RAM Antigravity CLI path:

```powershell
irm https://antigravity.google/cli/install.ps1 | iex
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\plugins\ai-mobile\scripts\antigravity.ps1" agy-status
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\plugins\ai-mobile\scripts\antigravity.ps1" agy-models
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\plugins\ai-mobile\scripts\antigravity.ps1" submit-agy-job -Goal "<goal>" -Workspace "<path>" -Mode fast -NextStep "<next step>" -AgyModel gemini-3.5-flash-low
```

Use `submit-agy-job` before `submit-job` when the task does not require the Antigravity desktop UI. Use `submit-job` / `submit-offload` only for existing desktop project/chat workflows that need visible UI verification.

Switch the current Antigravity chat to a cost-saving available model:

```powershell
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\plugins\ai-mobile\scripts\antigravity.ps1" select-chat -ExpectedProject "<visible project>" -ExpectedChat "<visible chat>"
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\plugins\ai-mobile\scripts\antigravity.ps1" switch-model -ModelPreference flash-medium -ExpectedProject "<visible project>" -ExpectedChat "<visible chat>"
```

`switch-model` uses the local model-limit summary to choose an available model, then uses the local CDP bridge to select it in the visible Antigravity chat. `flash-medium` prefers `Gemini 3.5 Flash (Medium)` when available, then falls back to another available Flash/Gemini model.

Run a local repository privacy scan:

```powershell
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\plugins\ai-mobile\scripts\antigravity.ps1" privacy
```

## Codex Operating Model

This plugin intentionally combines two local surfaces:

- Stable status and model-limit checks use local helper commands and Antigravity's local language server.
- Project/chat actions use the live Antigravity UI through the `ai-mobile-devtools` MCP bridge, because the UI is the source of truth for selected projects, selected conversations, composer state, and model selection.

For chat actions, Codex should verify the target project, conversation, and selected model before sending anything. For new projects or new chats, Codex should use the visible Antigravity controls through DevTools automation and report whether Antigravity accepted the action or showed an error/quota state.

For nontrivial work, Codex should act as the orchestrator, not the main worker. Codex first calls `orchestration-plan`, then gives the chosen worker compact tasks, waits, reads only status artifacts or targeted diffs, reviews the result, and sends the next improvement task back to the worker. Codex should avoid duplicating Antigravity, Claude Code, or Cursor broad file reading, browser operation, and long reasoning unless all workers are blocked or final verification requires it.

Codex token budget is not directly readable by this local plugin. If the Codex UI or the user provides a remaining budget, pass it as `CodexBudgetState`; otherwise the plugin reports it as unknown and routes conservatively. Claude Code availability is detectable, but Claude Code remaining usage is not exposed by `claude-status`.

For prompt submission, Codex should call `ai-mobile-local.submission-guide` or follow the same rule: fill/type the prompt without a `submitKey`, then click the visible Send/arrow button. If a keyboard submit is required, use a separate key call with a simple accepted key such as `Enter`. Do not use `Control+Enter`, `Ctrl+Enter`, or chord strings unless the active tool schema explicitly lists that exact value; some DevTools tools reject those strings with `Unknown key`.

## Token-Saving Offload Pattern

Use this plugin to make Codex the router and verifier while Antigravity, Claude Code, or Cursor does the long work. Codex should avoid reading huge files, full logs, or full Antigravity chat transcripts. Instead, Codex calls `orchestration-plan`, sends the chosen worker a compact handoff, lets the worker inspect locally, and reads back only a small artifact or status checkpoint.

Token savings are not automatic. First decide whether the task is worth offloading:

- Keep Codex direct only for arithmetic, short factual answers, tiny shell checks, small summaries, and prompts that do not need workspace context.
- Use Antigravity by default for project work, implementation, debugging, reviews, planning, research, UI operation, job-search/application workflows, and analysis where Antigravity can inspect local files and write a compact result.
- In existing project chats, assume Antigravity may inspect attached folders before answering. That is useful for real project work and wasteful for tiny tests.
- If Antigravity starts broad folder exploration for a small task, cancel it and answer directly in Codex.

Recommended flow:

1. Run `ai-mobile-local.orchestration-plan` with the goal, workspace, visible Codex budget state if known, expected project/chat, and estimated direct Codex tokens.
2. If the plan routes to Antigravity CLI, run `submit-agy-job` and later `read-job`.
3. If the plan routes to Antigravity desktop/chat, verify/select the chat, switch model if needed, then run `submit-job` or `submit-offload`.
4. If the plan routes to Claude Code, run `submit-claude-job` and later `read-job`.
5. If the plan routes to `codex-direct`, do not open or drive Antigravity.
6. Ask the selected worker to write progress to `.antigravity-bridge/jobs/<jobId>/status.json` and the required result/diff/test artifacts.
7. Codex reads only `read-job`, a targeted diff, or a compact visible UI status.
8. If the result is incomplete, Codex sends a short follow-up task or `retry-job` back to the selected worker with the exact gap instead of pulling broad context into Codex.
9. Codex summarizes for the user after the worker has produced a useful result or is clearly blocked.

If a Codex session cannot see MCP tools and can only run shell commands, use the equivalent PowerShell helper:

```powershell
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\plugins\ai-mobile\scripts\antigravity.ps1" prepare-offload -Goal "<goal>" -Workspace "<path>" -StatusFile "notes/antigravity-status.md" -NextStep "<next step>"
```

For selected-chat direct submission through the PowerShell helper:

```powershell
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\plugins\ai-mobile\scripts\antigravity.ps1" submit-offload -Goal "<goal>" -Workspace "<path>" -StatusFile "notes/antigravity-status.md" -NextStep "<next step>" -ExpectedProject "<project text>" -ExpectedChat "<chat text>" -ModelPreference auto -Submit true
```

Use `-Submit false` for verify-only; it should not fill the composer. Use `-FillOnly true` only when the user wants to manually review the handoff before sending.

For durable job submission through the PowerShell helper:

```powershell
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\plugins\ai-mobile\scripts\antigravity.ps1" submit-job -Goal "<goal>" -Workspace "<path>" -Mode fast -NextStep "<next step>" -ExpectedProject "<project text>" -ExpectedChat "<chat text>" -ModelPreference auto
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\plugins\ai-mobile\scripts\antigravity.ps1" list-jobs -Workspace "<path>"
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\plugins\ai-mobile\scripts\antigravity.ps1" read-job -Workspace "<path>" -JobId latest
```

Modes are `fast`, `deep`, `review`, and `patch`. Use `create-job` when you want to create the folder without touching Antigravity, `retry-job` to resubmit an existing request, and `cancel-job` to mark the bridge job cancelled.

For local Claude Code headless jobs through the PowerShell helper:

```powershell
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\plugins\ai-mobile\scripts\antigravity.ps1" claude-status
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\plugins\ai-mobile\scripts\antigravity.ps1" submit-claude-job -Goal "<goal>" -Workspace "<path>" -Mode fast -NextStep "<next step>" -ClaudeModel sonnet
```

Use `-Start false` to create and inspect the job without starting Claude Code. `submit-claude-job` writes into `.antigravity-bridge/jobs/<jobId>/` and returns immediately; call `read-job` later to inspect the compact artifacts. It does not use `--dangerously-skip-permissions` by default. Review mode defaults to Claude Code `plan`; other modes default to `acceptEdits`.

If Claude Code returns `Not logged in`, run Claude Code locally and complete `/login`, then retry the bridge job.

For Cursor workflows through the PowerShell helper:

```powershell
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\plugins\ai-mobile\scripts\antigravity.ps1" cursor-status
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\plugins\ai-mobile\scripts\antigravity.ps1" open-cursor -Workspace "<path>" -CursorChat true
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\plugins\ai-mobile\scripts\antigravity.ps1" submit-cursor-job -Goal "<goal>" -Workspace "<path>" -Mode fast -NextStep "<next step>"
```

Use `submit-cursor-job` only when `cursor-status` reports `HeadlessAgentFound: true`. On Windows, the normal `cursor.cmd` launcher opens UI and is not treated as a reliable headless job runner.

If UI submission is blocked by a stale DevTools port, use `ai-mobile-local.handoff-template` to generate the compact prompt and avoid repeated CDP probing. Restart Codex or paste the generated handoff manually so the next session attaches to the current Antigravity port.

Compact handoff template:

```text
Goal: <goal>
Workspace: <path>
Constraints: inspect files locally; do not paste full files, full logs, or full source; use search before reading whole files.
Token rule: work token-efficiently; write progress to <small-status-file>; output max 10 bullets plus changed file list.
Next step: <specific next action>
If blocked: ask one concise question; otherwise continue autonomously.
```

## Safety

This plugin operates only on the local machine and local Antigravity profile. It does not patch Antigravity internals, commit runtime tokens, or call Antigravity cloud APIs directly. Treat Antigravity user data, settings, chats, and workspace files as user-owned state.

Before publishing changes, run:

```powershell
powershell -ExecutionPolicy Bypass -File ".\scripts\antigravity.ps1" privacy
```

## License

MIT
