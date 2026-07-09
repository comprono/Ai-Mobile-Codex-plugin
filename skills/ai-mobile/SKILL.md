---
name: ai-mobile
description: Orchestrate Codex with local Antigravity 2.0, Claude Code, and Cursor workers for mobile-started workflows. Use for automatic capacity-aware task splitting, bounded team execution, compact durable result readback, CLI-first routing, or visible Antigravity project/chat work.
---

# AI Mobile

Use this skill when the user asks Codex to coordinate local AI workers, use Antigravity, use Claude Code, use Cursor, inspect model availability, or continue visible Antigravity project/chat work.

## Core Model

Codex is the team lead:

- decides the task split,
- checks exposed capacity,
- assigns non-overlapping lanes,
- starts available workers,
- reads compact artifacts,
- resolves conflicts,
- performs final targeted verification,
- summarizes to the user.

Workers:

- Antigravity CLI: low-RAM broad project scan, UI/product/integration context, research-heavy analysis.
- Antigravity desktop: visible project/chat/model/composer work only.
- Claude Code CLI: local implementation, backend/runtime, tests, review, and patch lanes.
- Cursor: UI workflow only unless `cursor-status` reports a real headless `cursor-agent`.

## Default Calls

For nontrivial multi-lane work, call one execution tool first. Preserve the user's comma-separated `taskSplit`; do not call the separate plan tool unless the user asks for a detailed plan.

```text
Call ai-mobile-local.run-team-task with goal, workspace, taskSplit, horizonHours=5, mode, agyModel=auto, claudeModel=sonnet, waitSeconds=30, and start=true.
If State is running, later call ai-mobile-local.read-team-run with workspace and waitSeconds=30.
```

PowerShell fallback:

```powershell
powershell -ExecutionPolicy Bypass -File "$HOME\plugins\ai-mobile\scripts\antigravity.ps1" run-team-task -Goal "<goal>" -Workspace "<path>" -TaskSplit "UI, backend, testing" -Mode patch -HorizonHours 5 -WaitSeconds 30
powershell -ExecutionPolicy Bypass -File "$HOME\plugins\ai-mobile\scripts\antigravity.ps1" read-team-run -Workspace "<path>" -WaitSeconds 30
```

For one-lane work:

```text
Call ai-mobile-local.run-efficient-task with goal, workspace, mode, nextStep, codexBudgetState, estimatedCodexInputTokens, expectedProject, expectedChat, start=true, and submit=true.
```

PowerShell fallback:

```powershell
powershell -ExecutionPolicy Bypass -File "$HOME\plugins\ai-mobile\scripts\antigravity.ps1" run-efficient-task -Goal "<goal>" -Workspace "<path>" -Mode fast -NextStep "<next step>"
```

Tool discovery failure is not a blocker. If `ai-mobile-local` is missing from the current Codex session, use the PowerShell helper at `$HOME\plugins\ai-mobile\scripts\antigravity.ps1`.

## Capacity Rules

- Antigravity model availability comes from `limits-summary`, `models`, or the local language-server API.
- When Antigravity desktop is stopped, use fast CLI detection and skip its quota probe; never open the desktop just to plan CLI work.
- Codex remaining tokens are not readable by this plugin. Use visible UI/user-provided budget text only.
- Claude Code remaining usage is not exposed by `claude-status`; treat Claude as available/unavailable.
- For a 5-hour plan, use known reset metadata only when Antigravity exposes it. Do not invent budgets.
- If a lane is unavailable, skip that lane and reassign only its narrow ownership.

## Durable Artifacts

Workers write under:

```text
.antigravity-bridge/jobs/<jobId>/
```

Team launches also write:

```text
.antigravity-bridge/last-team-run.md
.antigravity-bridge/last-team-run.json
```

Use `read-team-run` for the aggregate state. Use `read-job` only for a failed or partial lane that needs detail.

Codex should read only:

- `result.md`
- `changed-files.txt`
- `diff.patch`
- `test-output-summary.md`
- `status.json`

Do not paste full logs, chats, screenshots, source files, credentials, cookies, or private transcripts into Codex.
`read-job` may mark dead `running` jobs as failed and will omit binary/UTF-16-like artifacts to keep readback compact.
Only report team completion when `read-team-run` returns `State: completed`; `running`, `partial`, `failed`, and `blocked` are not completion.

## Existing Antigravity Chat Rules

Use desktop UI only when visible project/chat state matters.

Before submitting:

- verify the intended project,
- verify the active chat title/context,
- verify the selected model,
- verify the composer is idle,
- use `select-chat` if the target chat is visible but not active.

Never submit into a different or new chat just because the target appears in the sidebar. If `expectedChat` does not match the active document title/context, stop.

Submission success requires `Submitted: true`, a cleared composer, or a verified worker job with `Started: true`. Otherwise report `submit_failed` and fix selection/submission first.

## Model Routing

- If the user asks for Claude/Sonnet/Opus inside an Antigravity project/chat, select that model in Antigravity. Do not route to Claude Code CLI.
- If the user asks for Claude Code or headless code review/patch work, use `claude-status` then `submit-claude-job`; keep `maxMinutes`/`ClaudeMaxMinutes` near 10 unless the user asks for a long run.
- If Sonnet/Opus/GPT-OSS is exhausted in Antigravity, switch to an available Flash/Gemini model with `switch-model`.
- Use `flash-medium` for cost-sensitive Antigravity desktop work unless the user requested another available model.

## Common Commands

```powershell
powershell -ExecutionPolicy Bypass -File "$HOME\plugins\ai-mobile\scripts\antigravity.ps1" quick
powershell -ExecutionPolicy Bypass -File "$HOME\plugins\ai-mobile\scripts\antigravity.ps1" models
powershell -ExecutionPolicy Bypass -File "$HOME\plugins\ai-mobile\scripts\antigravity.ps1" limits-summary
powershell -ExecutionPolicy Bypass -File "$HOME\plugins\ai-mobile\scripts\antigravity.ps1" agy-status
powershell -ExecutionPolicy Bypass -File "$HOME\plugins\ai-mobile\scripts\antigravity.ps1" claude-status
powershell -ExecutionPolicy Bypass -File "$HOME\plugins\ai-mobile\scripts\antigravity.ps1" cursor-status
powershell -ExecutionPolicy Bypass -File "$HOME\plugins\ai-mobile\scripts\antigravity.ps1" read-team-run -Workspace "<path>" -WaitSeconds 30
powershell -ExecutionPolicy Bypass -File "$HOME\plugins\ai-mobile\scripts\antigravity.ps1" read-job -Workspace "<path>" -JobId latest
```

## Startup And Transport

- Startup must be passive. Do not open, close, restart, or repair Antigravity just because Codex opened.
- Call `open`, `repair-live`, `switch-model`, `submit-job`, or `submit-offload` only after the user asks to use Antigravity or the task requires it.
- If `ai-mobile-devtools/list_pages` fails with `Transport closed`, call `devtools-health` once. If pages are live, restart Codex to recreate the DevTools MCP transport or use `handoff-template` for manual paste.

## Boundaries

- Local bridge only; not a cloud service.
- Does not patch Antigravity internals.
- Does not bypass quotas, billing, authentication, or safety controls.
- Does not commit runtime tokens or private user data.
- Run `privacy` before publishing.
