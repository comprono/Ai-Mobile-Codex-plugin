---
name: ai-mobile
description: Connect Codex to local Antigravity 2.0, Claude Code, and Cursor workers for mobile-started Codex workflows, with CLI-first routing and UI fallback when visible state is needed.
license: MIT
---

# AI Mobile

Use this skill when the user asks Codex to connect to, set up, inspect, compare, or automate the local Antigravity 2.0 desktop app.

Core jobs:

- Set up or verify the plugin on another Windows machine.
- Open Antigravity and report install/runtime status.
- Read model quota and AI credit state from Antigravity's local language server.
- Inspect what is happening live in Antigravity.
- See projects and chats through the live UI.
- Continue an existing chat after verifying the selected project, conversation, and model.
- Start a new chat in an existing project.
- Start a new project and then start a chat there.
- Report quota, model, UI, or submission errors without repeatedly retrying.
- Switch the active chat to an available model automatically when the selected model is exhausted or unsuitable for cost-saving handoff.
- Create durable bridge jobs and read compact artifacts instead of inspecting full Antigravity chats.
- Use Antigravity CLI (`agy`) for low-RAM Antigravity work when visible desktop UI/project/chat state is not required.
- Use local Claude Code CLI as an optional headless worker for coding/review bridge jobs when Antigravity UI context is not needed.
- Use local Cursor as an optional UI worker for Cursor workspace/chat workflows, and use `cursor-agent` headlessly only when a true `cursor-agent` binary is installed.

Primary operating model:

- Codex is the orchestrator. Before nontrivial work, it should call `ai-mobile-local.orchestration-plan` or `antigravity.ps1 orchestration-plan` with the goal, workspace, expected project/chat, estimated Codex tokens, and any visible Codex budget state.
- The orchestrator compares: caller-provided Codex budget state, Antigravity model availability from local limits, Claude Code availability, Cursor headless availability, and whether visible Antigravity UI/chat state is required.
- Codex token availability is not directly readable by this local plugin. If the Codex UI shows a remaining budget or the user states one, pass it as `codexBudgetState`; otherwise use `unknown` and route conservatively.
- Claude Code remaining usage is not exposed by `claude-status`; treat Claude Code as availability/version only unless a future Claude API exposes remaining usage.
- Codex delegates nontrivial work to Antigravity first.
- Codex waits instead of doing the same exploration itself.
- Codex reads only compact status artifacts, targeted diffs, or concise visible status.
- For coding/workspace tasks, Codex should prefer durable bridge jobs under `.antigravity-bridge/jobs/<jobId>/` and later read only `result.md`, `changed-files.txt`, `diff.patch`, `test-output-summary.md`, and `status.json`.
- Codex reviews Antigravity's result, identifies gaps, and gives Antigravity the next compact improvement task.
- Codex performs final user-facing synthesis, safety checks, and narrow code patches only when that is cheaper or higher quality than another Antigravity pass.
- Codex should not duplicate Antigravity's file reading, broad search, browser operation, or long reasoning unless Antigravity is blocked, unavailable, or the task is tiny.
- For Antigravity tasks that do not need visible desktop UI/project/chat state, Codex should delegate through `submit-agy-job` first and then read the same compact bridge artifacts.
- For local coding/review tasks that do not need Antigravity context, Codex may delegate to Claude Code through `submit-claude-job` and then read the same compact bridge artifacts.
- For Cursor workflows, Codex should run `cursor-status` first. Use `open-cursor` for UI workflows. Use `submit-cursor-job` only when `HeadlessAgentFound: true`.

Claude routing hard rule:

- "Claude Code" means the local `claude` CLI worker. Use `claude-status` / `submit-claude-job` only when the user asks for Claude Code, a headless Claude worker, or a repository review that does not need Antigravity's visible project/chat context.
- "Claude", "Sonnet", or "Opus" inside a named Antigravity project/chat means the model selected inside Antigravity UI. Do not route that to Claude Code CLI.
- If the user says "no Claude CLI", "do not use Claude CLI", or names an Antigravity chat such as `Live review and improvements`, do not call `submit-claude-job`. Select and verify the existing Antigravity chat first, switch the Antigravity model to an available Claude/Sonnet/Opus or requested fallback model, then submit through Antigravity.
- Codex native subagents in this environment are not Claude workers unless a direct Claude tool is explicitly exposed. Do not claim Claude delegation when only GPT-family subagents are available.
- If the active Antigravity chat title does not exactly match `expectedChat`, stop before filling/submitting. Call `ai-mobile-local.select-chat` or `antigravity.ps1 select-chat` to activate the existing chat, then rerun the verify/submit step. Never submit to a different visible chat just because the target chat appears in the sidebar.
- If only `ai-mobile-devtools` is exposed and `ai-mobile-local` is missing from the current Codex session, use the AI Mobile PowerShell helper at `$HOME\plugins\ai-mobile\scripts\antigravity.ps1`. Do not use the older `antigravity-2` helper for AI Mobile routing unless the user explicitly asks for that plugin.

## MCP Tool Surfaces

This plugin exposes two MCP servers:

- `ai-mobile-local`: direct tools for `quick`, `setup`, `doctor`, `status`, `open`, `repair-live`, `inspect`, `live`, `devtools-health`, `submission-guide`, `prepare-offload`, `orchestration-plan`, `create-job`, `submit-job`, `select-chat`, `agy-status`, `agy-models`, `submit-agy-job`, `claude-status`, `submit-claude-job`, `cursor-status`, `open-cursor`, `submit-cursor-job`, `list-jobs`, `read-job`, `cancel-job`, `retry-job`, `switch-model`, `submit-offload`, `limits-summary`, `limits`, `models`, `offload-advice`, `handoff-template`, and `privacy`.
- `ai-mobile-devtools`: Chromium DevTools controls for inspecting and driving the Antigravity UI.

Prefer `ai-mobile-local.submit-job` for nontrivial coding/workspace work. It creates a durable `.antigravity-bridge/jobs/<jobId>/` folder, asks Antigravity to write compact artifacts, verifies/switches the selected model, submits once, and lets Codex stop watching the UI. Use `ai-mobile-local.read-job` later to read only the artifact files. Use `ai-mobile-local.submit-offload` only for lightweight selected-chat handoffs that do not need a durable job folder. If Sonnet/Opus/GPT-OSS is exhausted, do not wait for the user to say so: call `ai-mobile-local.switch-model` with `modelPreference=flash-medium` or pass `modelPreference=flash-medium` to `submit-job` / `submit-offload`. If the MCP tool list is stale and does not show the job/model tools, use the PowerShell helper equivalents before falling back to DevTools choreography. Use `ai-mobile-local.prepare-offload` when Codex should first show the plan or when the selected chat is uncertain. For any nontrivial workspace, repo, browser, UI, research, planning, debugging, review, implementation, or job-application task, default to Antigravity for exploration and long reasoning, while Codex stays the planner, safety gate, patch reviewer, and final summarizer. Use `ai-mobile-local.quick` for general setup checks. If `ReadyForLiveUiInspection` is false or `PageCount` is zero, call `ai-mobile-local.repair-live` once before using DevTools. If `repair-live` restarts Antigravity, do not keep using an already-started stale DevTools MCP connection; let it reconnect to the new port before UI calls. If `ai-mobile-devtools` fails with `Transport closed`, do not repeatedly call `list_pages` in that session. Call `ai-mobile-local.devtools-health`; if it reports pages are ready, restart Codex to recreate the DevTools MCP transport or use `handoff-template` for a manual paste this turn. Use `limits-summary` for normal quota checks and full `limits` only when complete per-model JSON is needed. Use `ai-mobile-devtools` for project/chat selection only when the selected chat is not already correct. If this skill file cannot be read in a Codex session, run the PowerShell helper fast path.

Use `ai-mobile-local.claude-status` and `ai-mobile-local.submit-claude-job` for headless local coding/review jobs when the user has Claude Code installed and the task does not need Antigravity's visible UI/chat context. `submit-claude-job` creates `.antigravity-bridge/jobs/<jobId>/`, starts Claude Code in non-interactive mode, and returns immediately. Codex should later call `read-job` and inspect only compact artifacts. Do not use Claude Code as a hidden substitute for Antigravity project/chat work; use it as a local worker for code review, patching, and repository analysis. If the user rejects Claude CLI or asks for a named Antigravity chat, this path is forbidden for that turn.

Use `ai-mobile-local.cursor-status` before any Cursor workflow. If it reports `HeadlessAgentFound: true`, Codex may use `submit-cursor-job` for durable compact artifacts. If only the Cursor UI launcher is available, use `open-cursor` for a visual Cursor workspace/chat and do not call it a headless job. On Windows, this plugin treats `cursor.cmd agent -p` as UI-only unless a separate `cursor-agent` binary is found.

Use `ai-mobile-local.agy-status`, `ai-mobile-local.agy-models`, and `ai-mobile-local.submit-agy-job` for low-RAM Antigravity work. `submit-agy-job` uses official Antigravity CLI print mode and does not open the desktop app. Prefer it before desktop UI tools unless the user explicitly asks to inspect/continue a visible Antigravity project/chat or use Manager/Editor UI state.

Existing-chat rule: if the user asks for an existing project/chat, do not create or use a new chat. `expectedChat` must match the active Antigravity document title before model switching or submission. If the helper reports `expectedChatActiveTitle`, `expectedChatActiveContext`, or `activeExistingChat`, call `select-chat` for that exact title and only continue if `Ok: true`.

Submission rule: do not report success or wait for artifacts unless the helper returns `Submitted: true`. If it returns `Submitted: false`, `ComposerStillHasPrompt: true`, or `submit_failed`, tell the user the prompt was not accepted and fix selection/submission first.

Startup rule: plugin MCP startup must be passive. Do not open, close, restart, or repair Antigravity just because Codex opened. Only call `open`, `repair-live`, `switch-model`, `submit-job`, or `submit-offload` after the user asks to use Antigravity or the task explicitly requires it.

## Requirements

- Windows desktop environment.
- Antigravity installed at the standard per-user location: `%LOCALAPPDATA%\Programs\Antigravity\Antigravity.exe`.
- Antigravity user data at: `%APPDATA%\Antigravity`.
- Plugin installed at: `%USERPROFILE%\plugins\ai-mobile`.
- Node.js available on `PATH` when using the bundled `chrome-devtools-mcp` bridge.
- Optional Antigravity CLI available as `agy` on `PATH` or `%LOCALAPPDATA%\agy\bin\agy.exe` for low-RAM Antigravity jobs.
- Optional Claude Code CLI available as `claude` on `PATH` and logged in for headless Claude bridge jobs.

The helper scripts compute `%LOCALAPPDATA%`, `%APPDATA%`, and `%USERPROFILE%` at runtime. Do not hardcode another user's home directory, ports, project names, chats, email addresses, or runtime tokens.

## First-Run Setup

After a user clones the GitHub repo into `%USERPROFILE%\plugins\ai-mobile`, run:

```powershell
powershell -ExecutionPolicy Bypass -File "$HOME\plugins\ai-mobile\scripts\antigravity.ps1" setup
```

Use the setup report to decide the next step:

- If `Installed` is false, ask the user to install Antigravity or provide its install path.
- If `Node.Found` is false, install or expose Node.js on `PATH` before using the DevTools bridge.
- If `AntigravityRunning` is false, run the `open` command.
- If `ReadyForModelLimits` is false after opening Antigravity, wait a few seconds and rerun `setup`.
- If `ReadyForLiveUiInspection` is false, run `repair-live` once. It restarts Antigravity, clears a stale `DevToolsActivePort`, and waits for inspectable pages. Use Browser/Computer Use fallback only if repair still cannot connect.

## Helper Commands

Check status:

```powershell
powershell -ExecutionPolicy Bypass -File "$HOME\plugins\ai-mobile\scripts\antigravity.ps1" status
```

Fast combined readiness and quota summary:

```powershell
powershell -ExecutionPolicy Bypass -File "$HOME\plugins\ai-mobile\scripts\antigravity.ps1" quick
```

Open Antigravity:

```powershell
powershell -ExecutionPolicy Bypass -File "$HOME\plugins\ai-mobile\scripts\antigravity.ps1" open
```

Repair live DevTools inspection if Antigravity is running but exposes zero pages:

```powershell
powershell -ExecutionPolicy Bypass -File "$HOME\plugins\ai-mobile\scripts\antigravity.ps1" repair-live
```

Generate a compact handoff prompt without touching the UI:

```text
Call ai-mobile-local.handoff-template with goal, workspace, statusFile, and nextStep.
```

Check whether a task should be offloaded before using UI tokens:

```text
Call ai-mobile-local.offload-advice with goal, hasWorkspaceWork, and estimatedCodexInputTokens.
```

Prepare the whole token-saving handoff in one call:

```text
Call ai-mobile-local.prepare-offload with goal, workspace, statusFile, nextStep, hasWorkspaceWork, and estimatedCodexInputTokens.
```

Plan the full Codex / Antigravity / Claude / Cursor route before doing work:

```text
Call ai-mobile-local.orchestration-plan with goal, workspace, codexBudgetState, estimatedCodexInputTokens, hasWorkspaceWork, needsVisibleAntigravityChat, expectedProject, and expectedChat.
```

Create and submit a durable bridge job:

```text
Call ai-mobile-local.submit-job with goal, workspace, mode, nextStep, expectedProject, expectedChat, modelPreference=auto, and submit=true.
```

Select an existing Antigravity chat before model switching or submission:

```text
Call ai-mobile-local.select-chat with expectedProject and expectedChat.
```

Use low-RAM Antigravity CLI for non-UI Antigravity jobs:

```text
Call ai-mobile-local.agy-status.
Call ai-mobile-local.agy-models.
Call ai-mobile-local.submit-agy-job with goal, workspace, mode, nextStep, model=gemini-3.5-flash-low, and start=true.
Call ai-mobile-local.read-job with workspace and the returned jobId.
```

PowerShell fallback:

```powershell
powershell -ExecutionPolicy Bypass -File "$HOME\plugins\ai-mobile\scripts\antigravity.ps1" agy-status
powershell -ExecutionPolicy Bypass -File "$HOME\plugins\ai-mobile\scripts\antigravity.ps1" agy-models
powershell -ExecutionPolicy Bypass -File "$HOME\plugins\ai-mobile\scripts\antigravity.ps1" submit-agy-job -Goal "<goal>" -Workspace "<path>" -Mode fast -NextStep "<next step>" -AgyModel gemini-3.5-flash-low
```

Read job results without reading the Antigravity chat:

```text
Call ai-mobile-local.list-jobs with workspace.
Call ai-mobile-local.read-job with workspace and jobId=latest.
```

Use local Claude Code headlessly for coding/review bridge jobs:

```text
Call ai-mobile-local.claude-status.
Call ai-mobile-local.submit-claude-job with goal, workspace, mode, nextStep, model=sonnet, and start=true.
Call ai-mobile-local.read-job with workspace and the returned jobId.
```

Use Cursor for Cursor-specific workflows:

```text
Call ai-mobile-local.cursor-status.
If HeadlessAgentFound is true, call ai-mobile-local.submit-cursor-job with goal, workspace, mode, nextStep, and start=true.
If HeadlessAgentFound is false but UiFound is true, call ai-mobile-local.open-cursor with workspace and chat=true only when a visible Cursor UI workflow is needed.
```

PowerShell fallback:

```powershell
powershell -ExecutionPolicy Bypass -File "$HOME\plugins\ai-mobile\scripts\antigravity.ps1" claude-status
powershell -ExecutionPolicy Bypass -File "$HOME\plugins\ai-mobile\scripts\antigravity.ps1" submit-claude-job -Goal "<goal>" -Workspace "<path>" -Mode fast -NextStep "<next step>" -ClaudeModel sonnet
powershell -ExecutionPolicy Bypass -File "$HOME\plugins\ai-mobile\scripts\antigravity.ps1" cursor-status
powershell -ExecutionPolicy Bypass -File "$HOME\plugins\ai-mobile\scripts\antigravity.ps1" open-cursor -Workspace "<path>" -CursorChat true
```

Use `-Start false` to validate job creation without starting Claude Code. The helper does not use `--dangerously-skip-permissions` by default; review mode defaults to Claude Code `plan`, and patch/fast/deep default to `acceptEdits`.
If Claude Code returns `Not logged in`, report that blocker and ask the user to complete `/login` in Claude Code before retrying.

Use modes:

- `fast`: inspect only directly relevant files, make the smallest safe change, run targeted verification.
- `deep`: inspect related modules and prior patterns, run the strongest practical tests, include risks.
- `review`: inspect and report only; do not edit.
- `patch`: make a narrow safe edit, run relevant verification, produce a diff.

Switch the selected Antigravity chat to a cost-saving available model:

```text
Call ai-mobile-local.switch-model with modelPreference=flash-medium, expectedProject, and expectedChat.
```

Submit the handoff in one call when the correct Antigravity chat is already selected:

```text
Call ai-mobile-local.submit-offload with goal, workspace, statusFile, nextStep, expectedProject, expectedChat, modelPreference=auto, and submit=true.
```

Use `expectedProject` and `expectedChat` when known. If either expected string is not visible, `submit-offload` stops before filling or submitting.
Use `modelPreference=flash-medium` when the user wants Flash or when a quota warning/exhausted Sonnet/Opus model is visible. `submit-offload` refuses to submit if it cannot verify the chosen model.
Use `submit=false` for verify-only; it must not fill the composer. Use `fillOnly=true` only when the user wants to manually review the handoff before sending.

If MCP `submit-offload` is not visible in the current Codex session, use the raw helper:

```powershell
powershell -ExecutionPolicy Bypass -File "$HOME\plugins\ai-mobile\scripts\antigravity.ps1" switch-model -ModelPreference flash-medium -ExpectedProject "<project text>" -ExpectedChat "<chat text>"
powershell -ExecutionPolicy Bypass -File "$HOME\plugins\ai-mobile\scripts\antigravity.ps1" submit-offload -Goal "<goal>" -Workspace "<path>" -StatusFile "notes/antigravity-status.md" -NextStep "<next step>" -ExpectedProject "<project text>" -ExpectedChat "<chat text>" -ModelPreference auto -Submit true
```

If MCP tools are unavailable and Codex can only run shell commands, use the PowerShell helper equivalent:

```powershell
powershell -ExecutionPolicy Bypass -File "$HOME\plugins\ai-mobile\scripts\antigravity.ps1" prepare-offload -Goal "<goal>" -Workspace "<path>" -StatusFile "notes/antigravity-status.md" -NextStep "<next step>"
```

Inspect integration details:

```powershell
powershell -ExecutionPolicy Bypass -File "$HOME\plugins\ai-mobile\scripts\antigravity.ps1" inspect
```

Inspect the live DevTools connection:

```powershell
powershell -ExecutionPolicy Bypass -File "$HOME\plugins\ai-mobile\scripts\antigravity.ps1" live
```

Check DevTools transport health after `Transport closed`:

```text
Call ai-mobile-local.devtools-health.
```

Check how to submit a chat prompt without invalid key names:

```text
Call ai-mobile-local.submission-guide.
```

Report model limits:

```powershell
powershell -ExecutionPolicy Bypass -File "$HOME\plugins\ai-mobile\scripts\antigravity.ps1" limits-summary
powershell -ExecutionPolicy Bypass -File "$HOME\plugins\ai-mobile\scripts\antigravity.ps1" models
```

`limits` is an alias for `models`.
Use `limits-summary` unless full per-model JSON is required.

Run the public-repo privacy scanner:

```powershell
powershell -ExecutionPolicy Bypass -File "$HOME\plugins\ai-mobile\scripts\antigravity.ps1" privacy
```

## Model Limits

Use `models` or `limits` for model quota checks. The helper discovers the running Antigravity `language_server.exe`, reads its CSRF token from the local process command line, finds its local HTTPS gRPC-web port, and calls:

- `exa.language_server_pb.LanguageServerService/GetAvailableModels`
- `exa.language_server_pb.LanguageServerService/GetLoadCodeAssist`

This is the same local language-server surface the Antigravity Models tab uses. It returns per-model quota fraction/reset metadata and AI credit tier data when Antigravity exposes it. It is not a raw all-model token ledger unless Antigravity exposes one through these responses.

Do not parse old chats, task transcripts, or logs for model limits except as supporting evidence after the language-server path fails.

## Live UI Inspection

For project and chat work, the live UI is the source of truth.

Preferred path:

1. Run `setup` or `live` to confirm DevTools readiness.
2. Use the plugin MCP server `ai-mobile-devtools` when available. It starts Antigravity's bundled `chrome-devtools-mcp` and connects through `DevToolsActivePort`.
3. Inspect the visible UI text and interactive elements through DevTools.
4. Confirm the project, conversation, composer state, and selected model before sending a message.

If `ai-mobile-devtools/list_pages` or another DevTools tool fails with `Transport closed`, the child MCP process has died. This is a transport failure, not proof that Antigravity is unavailable. Call `ai-mobile-local.devtools-health` to confirm the live pages. If pages are ready, restart Codex before trying DevTools again; if the user wants to continue immediately, use `ai-mobile-local.handoff-template` and ask for manual paste into Antigravity.

Manual DevTools endpoint check:

```powershell
$port = (Get-Content "$env:APPDATA\Antigravity\DevToolsActivePort")[0]
Invoke-RestMethod "http://127.0.0.1:$port/json/list"
```

If DevTools cannot interact with a native dialog or OS-level control, use the Computer Use plugin as a fallback.

## Project And Chat Workflows

### See Chats In Projects

Use DevTools to inspect the live Antigravity project list, selected project, conversation list, and conversation titles. If the UI has a project or conversation search control, use it rather than reading private storage first.

Storage under `%APPDATA%\Antigravity\User` can support investigation, but live UI remains authoritative.

### Continue An Existing Chat

Before submitting:

- Verify the intended project is selected.
- Verify the intended conversation title or visible context.
- Verify the intended model in the composer.
- Verify the composer is idle and not already streaming.
- Check `models` if the user asks about limits or if a quota warning is visible.

Then paste the user's instruction into the composer and submit it. Report whether Antigravity accepted the message, started working, requested confirmation, or showed a quota/error state.

Submission reliability:

- Fill or type the prompt first without a `submitKey`.
- Prefer clicking the visible Send/arrow button after the prompt is in the composer.
- If a keyboard submit is needed, use a separate key call with a simple accepted key such as `Enter`.
- Do not use `Control+Enter`, `Ctrl+Enter`, or chord strings unless the active tool schema explicitly lists that exact value. Some DevTools tools reject those strings with `Unknown key`.
- After submission, verify a new user message or working state. If one submit method fails once, stop retrying the same method and use `handoff-template` or report the blocker.

### Start A New Chat In An Existing Project

Before submitting:

- Select or search for the existing project.
- Use the UI control for a new chat/conversation.
- Verify the new composer belongs to that project.
- Verify the selected model.

Then submit the user's initial prompt. Report the new conversation title or visible identifier if Antigravity shows one.

### Start A New Project

Before creating:

- Ask for a project name only if the user's intended name cannot be inferred.
- Use the visible Antigravity project creation flow.
- Select local folders/workspaces only when the user explicitly requests those paths or they are already visible and clearly intended.
- Avoid broad filesystem access without explicit user instruction.

After creation, verify the project is selected, then start a chat if requested.

### Tell What Is Happening Live

Inspect the active page text and state through DevTools. Summarize:

- selected project,
- selected conversation,
- selected model,
- whether the agent is idle, working, waiting for approval, or blocked,
- visible quota/errors,
- last visible meaningful action.

Do not expose unrelated private chat content unless the user asked for that specific context.

## Token-Saving Offload Workflow

Use Antigravity as an offload worker when the user wants to save Codex tokens or asks Codex to "ride on" Antigravity.

### Orchestration Gate

Run `ai-mobile-local.orchestration-plan` before `prepare-offload`, `submit-agy-job`, `submit-job`, or `submit-claude-job` for any nontrivial task. This is the main AI Mobile behavior: Codex should decide who works before it spends tokens reading files or driving UI.

Routing contract:

- Codex keeps strategy, safety, final patch review, verification, and user summary.
- Antigravity CLI handles low-RAM broad workspace work when visible chat/UI state is not needed.
- Antigravity desktop handles existing project/chat work, model picker work, and visible UI state.
- Claude Code handles local code/review jobs when Antigravity UI context is unnecessary and the user has not said "no Claude CLI".
- Cursor is used only for Cursor-specific UI work unless a true `cursor-agent` is available.
- If Codex budget is low or critical, Codex should avoid broad file reads and should send compact tasks to Antigravity CLI, Antigravity desktop, or Claude Code according to the plan.
- If all workers are blocked, Codex should perform one narrow local step or report the blocker; do not silently fall back to expensive broad Codex exploration.

### Offload Decision Gate

Run `ai-mobile-local.prepare-offload` before opening or driving the Antigravity UI unless the user explicitly asks to inspect the live UI. This is the cheapest token-saving step because it replaces several separate checks.

Do not offload:

- arithmetic, short factual answers, tiny transformations, or simple status questions,
- small shell checks where Codex can run one command and summarize compactly,
- prompts that can be answered without reading project files, logs, browser state, or long chat history,
- tests inside an existing project chat when the task does not need that project's workspace.

Do offload:

- most nontrivial workspace tasks that would make Codex read files, large logs, browser state, or transcripts,
- non-UI Antigravity tasks to Antigravity CLI (`submit-agy-job`) before opening desktop UI,
- ongoing Antigravity project/chat work where the Antigravity context is already useful,
- local coding/review tasks to Claude Code when the `claude` CLI is installed and Antigravity UI context would add friction,
- debugging, implementation, job-search/application workflows, UI operation, reviews, planning, research, and analysis that can write a compact artifact,
- tasks where Antigravity can keep working while Codex waits and then reads only a small result.

Cost split:

- Antigravity explores, searches, reads files, inspects UI, drafts plans, and writes status artifacts.
- Codex gives Antigravity tasks, waits, reviews the compact output, tells Antigravity how to improve, verifies final diffs/tests, and explains the result to the user.
- If Antigravity output is incomplete, Codex should usually send a short follow-up task back to Antigravity rather than expanding its own context with broad file reads.

Important lesson from project chats: Antigravity may automatically inspect attached folders before answering, even for a tiny prompt. That is useful for real project work but wasteful for tests like `2+2`. If Antigravity starts broad folder exploration for a small task, cancel it and report that offload is not token-efficient.

Core rule:

- Codex is the router, verifier, and final summarizer.
- Antigravity CLI is the default low-RAM Antigravity worker.
- Antigravity desktop UI is the visual project/chat worker only when UI state matters.
- Claude Code is the headless local worker when UI/project chat context is unnecessary.
- Cursor is a UI worker unless `cursor-status` reports a true headless `cursor-agent`.
- Files are the compact memory between them.

Do not copy large files, long logs, full source, or full Antigravity chat transcripts into Codex. Savings happen only when Codex sends compact instructions, lets Antigravity inspect the workspace locally, and reads back a small artifact or status checkpoint.

Fast preferred flow:

1. If the task is Antigravity-capable but does not require visible desktop UI/project/chat state, call `ai-mobile-local.agy-status`, `agy-models`, then `submit-agy-job`; read artifacts with `read-job`.
2. If the correct desktop project/chat is already selected and visible UI context matters, call `ai-mobile-local.submit-job` with `submit=true`, `modelPreference=auto`, and expected visible project/chat text.
3. If the task is pure repository code/review work and does not require Antigravity context, call `ai-mobile-local.claude-status` and then `ai-mobile-local.submit-claude-job`; read artifacts with `read-job`.
4. If the task belongs in Cursor, call `ai-mobile-local.cursor-status`; use `submit-cursor-job` only when a true headless agent is available, otherwise use `open-cursor` for visible UI handoff.
5. If a quota warning is visible or the user mentions Sonnet/Opus/GPT-OSS exhaustion in the desktop UI, call `ai-mobile-local.switch-model` with `modelPreference=flash-medium` first.
6. If MCP job/model tools are not visible, run `antigravity.ps1 submit-agy-job` / `antigravity.ps1 submit-job` / `antigravity.ps1 submit-claude-job` / `antigravity.ps1 cursor-status` / `antigravity.ps1 switch-model` with the same fields.
7. If the selected desktop chat is uncertain, call `ai-mobile-local.prepare-offload`, then use DevTools only to select the project/chat; use `switch-model` for the model.
8. If the decision is `codex-direct`, do not open or drive Antigravity.
9. After a successful `submit-agy-job`, `submit-job`, `submit-claude-job`, or `submit-cursor-job`, stop watching every step. Read only the job artifacts with `read-job`.
10. If the artifact is weak, issue another compact Antigravity/Claude/Cursor follow-up or retry with the exact missing point. Do not pull broad context back into Codex unless needed for final verification.

Detailed fallback flow:

1. Run `ai-mobile-local.quick`.
2. If `ReadyForLiveUiInspection` is false, run `ai-mobile-local.repair-live` once.
3. Run `ai-mobile-local.offload-advice` with the goal. Continue only if the decision is `offload-to-antigravity`.
4. Run `ai-mobile-local.limits-summary`; avoid full `limits` unless model-level JSON is actually needed.
5. Run `ai-mobile-local.switch-model` with `modelPreference=auto` or `flash-medium`; this is mandatory when Sonnet/Opus/GPT-OSS is exhausted.
6. Use `ai-mobile-devtools` only if needed to verify the target project, chat, idle composer, and whether workspace context is appropriate.
7. Use `ai-mobile-local.submission-guide`, then send Antigravity a compact handoff prompt with only the goal, workspace/path, constraints, next step, and required output format.
8. Ask Antigravity to inspect files locally, write progress/results to a small status artifact, and avoid pasting full files or logs.
9. Stop monitoring every step. Wait until Antigravity visibly stops or writes the status artifact.
10. Read only the small artifact or changed-file list, then summarize to the user in a few bullets.

If DevTools UI submission fails because a stale port is still attached, do not spend more tokens probing CDP from Codex. Use `ai-mobile-local.handoff-template` to prepare the compact prompt, report that UI submission was blocked by stale DevTools, and ask the user to restart Codex or paste the handoff manually. The next Codex session should load the new DevTools port.

Recommended handoff prompt:

```text
Goal: <goal>
Workspace: <path>
Constraints: inspect files locally; do not paste full files, full logs, or full source; use search before reading whole files.
Token rule: work token-efficiently; write progress to <small-status-file>; output max 10 bullets plus changed file list.
Next step: <specific next action>
If blocked: ask one concise question; otherwise continue autonomously.
```

Recommended artifacts:

- `notes/antigravity-status.md`
- `plans/antigravity-next.md`
- `reports/antigravity-result.json`
- a Git diff, branch, or commit with a short summary

When checking back, Codex should read only the artifact, targeted diffs, or a compact visible UI status. Do not ask Antigravity to restate the whole conversation. Use delta prompts such as:

```text
Continue from reports/antigravity-result.json. Only fix the failing item. Return max 5 bullets and changed file paths.
```

Report back to the user with:

- project/chat used,
- model selected,
- whether Antigravity accepted the task,
- current status,
- next action needed.

## Public Plugin Hygiene

Before committing or publishing:

```powershell
powershell -ExecutionPolicy Bypass -File "$HOME\plugins\ai-mobile\scripts\antigravity.ps1" privacy
git diff --check
```

Also run a local targeted scan for any private terms the current user mentions. Do not commit names, emails, project names, runtime ports, CSRF tokens, OAuth tokens, cookies, logs, screenshots, or Antigravity user data.

## Boundaries

- This plugin is a local bridge, not a cloud service.
- It does not patch Antigravity internals.
- It does not commit runtime language-server tokens.
- It does not bypass Antigravity quota, billing, authentication, or safety controls.
- It should not read sensitive files, credentials, browser cookies, or private chat contents unless the user asks for that specific context.
- If Antigravity reports quota limits, do not keep resubmitting. Report the reset time and prepare the next action plan.
