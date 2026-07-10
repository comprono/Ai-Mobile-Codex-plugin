---
name: ai-mobile
description: Use Codex as a smart resource orchestrator across local Antigravity 2.0, Claude Code, and optional Cursor workers. Use when a project goal should be understood, decomposed, assigned by model capability and observed capacity, monitored, failed over, critiqued, integrated, and verified with durable continuity and UI fallback only when visible state is required.
---

# AI Mobile

Use this skill when the user asks Codex to coordinate local AI workers, use Antigravity, use Claude Code, use Cursor, inspect model availability, or continue visible Antigravity project/chat work. When this skill is active, do not make the user manually choose a worker or repeatedly remind Codex to delegate.

## Resource Orchestrator

This is not a static resource scheduler and not merely a token-saving task splitter. Treat platforms as teams and their models as players. Codex is the coach and goal owner:

- understand the complete outcome, constraints, project state, and risk;
- inventory installed teams, models, measured/observed/cached/caller-provided capacity, reset windows, cooldowns, and uncertainty;
- build a dependency-aware work graph based on capabilities, not fixed UI/backend/testing buckets;
- choose the strongest efficient resource for each item and explain the decision;
- brief workers with bounded ownership, start them through CLI, and monitor compact artifacts;
- critique weak results, send one narrow correction, or fail over only the failed work item once;
- integrate accepted work, run final targeted verification, and preserve compact continuity for the next run.

Codex should spend its own capacity on goal interpretation, architecture/risk decisions, feedback, integration, and final verification. Do not duplicate broad reading or implementation already delegated to a suitable worker.

Workers:

- Antigravity CLI models: low-RAM discovery, research, product/context review, drafting, independent validation, and bounded implementation when selected by capability/capacity.
- Antigravity desktop: visible project/chat/model/composer work only.
- Claude Code CLI Sonnet: high-value implementation, architecture, debugging, tests, and review. Use the local `sonnet` alias; record the exact observed model from per-run JSON telemetry instead of guessing a numbered model.
- Cursor: UI workflow only unless `cursor-status` reports a real headless `cursor-agent`.

Using every worker is not the objective. Use only the combination that improves expected quality, time, continuity, or resilience.

## Default Call

For a nontrivial project goal, do a short goal analysis and call one execution tool. Supply structured `workItems` for complex work; otherwise let the tool create a conservative work graph. Do not broadly scan the repository first and do not ask the user to split the task by software.

```text
Call ai-mobile-local.orchestrate-project with goal, workspace, workItems when useful, horizonHours=5, mode, agyModel=auto, claudeModel=sonnet, waitSeconds=30, and start=true.
Pass codexModel, codexBudgetState, codexRemainingPercent, and codexResetAt only when visible to the caller; never invent them.
If State is running, later call ai-mobile-local.read-team-run with workspace and waitSeconds=30.
```

PowerShell fallback:

```powershell
powershell -ExecutionPolicy Bypass -File "$HOME\plugins\ai-mobile\scripts\antigravity.ps1" orchestrate-project -Goal "<goal>" -Workspace "<path>" -Mode patch -HorizonHours 5 -WaitSeconds 30
powershell -ExecutionPolicy Bypass -File "$HOME\plugins\ai-mobile\scripts\antigravity.ps1" read-team-run -Workspace "<path>" -WaitSeconds 30
```

`run-team-task` remains a compatibility alias. `taskSplit` remains a legacy hint; prefer a work graph with objective, kind, complexity, capabilities, dependencies, read-only state, and optional file boundaries.

For one-lane work:

```text
Call ai-mobile-local.run-efficient-task with goal, workspace, mode, nextStep, codexBudgetState, estimatedCodexInputTokens, expectedProject, expectedChat, start=true, and submit=true.
```

PowerShell fallback:

```powershell
powershell -ExecutionPolicy Bypass -File "$HOME\plugins\ai-mobile\scripts\antigravity.ps1" run-efficient-task -Goal "<goal>" -Workspace "<path>" -Mode fast -NextStep "<next step>"
```

Tool discovery failure is not a blocker. If `ai-mobile-local` is missing from the current Codex session, use the PowerShell helper at `$HOME\plugins\ai-mobile\scripts\antigravity.ps1`.

## Capacity And Selection

- `resource-inventory` is passive. It discovers Codex caller state, Claude auth/CLI state, Antigravity CLI models, live Antigravity quota only when already running, Cursor headless availability, cooldowns, and recent outcomes.
- Evidence classes are measured, observed, cached, caller-provided, and unknown. Preserve unknown values as unknown.
- When Antigravity desktop is stopped, use fast CLI detection and skip its quota probe; never open the desktop just to plan CLI work.
- Codex remaining tokens are not readable by this plugin. Use visible UI/user-provided budget text only.
- Claude remaining subscription usage is not exposed by the CLI. Infer availability from auth plus real success/rate-limit outcomes; JSON telemetry records per-run usage and the exact model used.
- For a five-hour horizon, use real reset/cooldown metadata when present. Do not invent budgets or reset times.
- Selection weighs capability fit, required quality, capacity/freshness, speed/cost, project continuity, independence, and user preference.
- Learn task-kind affinity only from successful outcomes. A timeout or failed result must increase reliability penalties and must never create positive affinity for that resource.
- Aggregate recent outcomes by platform for the five-hour horizon. After repeated failures with no recent success, route broad work to a proven alternative instead of cycling through more models on the same platform; keep micro tasks eligible for bounded cheap workers.
- Use Flash Low only for tightly file-bounded low-complexity micro tasks. Prefer Flash Medium for broad read-only project review, health inspection, or work without an explicit file boundary.
- Keep one writer per workspace. Run independent read-only scouts/reviewers in parallel. Respect explicit dependencies.
- Keep failover pools provider-diverse. On quota, rate limit, outage, timeout, auth, model-unavailable, worker failure, or an insufficient/off-task result, cool down that resource and fail over the narrow item once. Do not retry loops.
- Exit code 0 is not sufficient evidence. Reject empty, placeholder, generic acknowledgement, model-identity-only, or otherwise non-objective results before reporting worker completion.

## Durable Artifacts

Workers write under:

```text
.antigravity-bridge/jobs/<jobId>/
```

Team launches also write:

```text
.antigravity-bridge/last-team-run.md
.antigravity-bridge/last-team-run.json
.antigravity-bridge/orchestrator/resource-state.json
```

Use `read-team-run` for the aggregate state. Use `read-job` only for a failed or partial lane that needs detail.
Keep results complexity-sized: low 5 bullets, medium 6, high 8, and critical 10. Prefer the capped aggregate readback; do not re-read successful jobs individually. Use worker telemetry prompt/result character counts and available token fields to verify efficiency rather than assuming it.

Codex should read only:

- `result.md`
- `changed-files.txt`
- `diff.patch`
- `test-output-summary.md`
- `worker-telemetry.json`
- `status.json`

Do not paste full logs, chats, screenshots, source files, credentials, cookies, or private transcripts into Codex.
`status.json` is bridge-owned. Never ask a worker to edit it, and do not accept a worker-written terminal state while the bridge process is still finalizing artifacts.
If a worker exits after writing finalized telemetry and compact artifacts but before its terminal status update, recover the terminal state and exact failure category from that telemetry.
`read-job` may mark dead `running` jobs as failed and will omit binary/UTF-16-like artifacts to keep readback compact.
`State: ready-for-codex` means workers are finished, not that the user goal is complete. Codex must critique, integrate, and verify before claiming completion. `running`, `partial`, `failed`, and `blocked` are not completion.

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
- If the user asks for Claude Code or headless code review/patch work, let `orchestrate-project` select it or use `submit-claude-job`; keep `maxMinutes`/`ClaudeMaxMinutes` near 10 unless the user asks for a long run.
- If Sonnet/Opus/GPT-OSS is exhausted in Antigravity, switch to an available Flash/Gemini model with `switch-model`.
- Prefer a Flash model for low-risk discovery/drafting. Escalate to Pro/Sonnet/Opus only when complexity and capacity justify it.

## Common Commands

```powershell
powershell -ExecutionPolicy Bypass -File "$HOME\plugins\ai-mobile\scripts\antigravity.ps1" quick
powershell -ExecutionPolicy Bypass -File "$HOME\plugins\ai-mobile\scripts\antigravity.ps1" resource-inventory -Workspace "<path>"
powershell -ExecutionPolicy Bypass -File "$HOME\plugins\ai-mobile\scripts\antigravity.ps1" orchestrate-project -Goal "<goal>" -Workspace "<path>" -Mode patch -WaitSeconds 30
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
