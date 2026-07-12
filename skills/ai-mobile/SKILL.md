---
name: ai-mobile
description: Use Codex as a capacity-aware project manager across native Codex workers, Claude Code, Antigravity, and optional Cursor. Use when a project should be understood, packaged into bounded context, assigned by current capability and quota, executed CLI-first in parallel where safe, critiqued, integrated, verified, and resumed without replaying the parent chat.
---

# AI Mobile

Use one Codex chat as the project control room. By default, the current Codex session is manager-only: it owns the goal, capacity decisions, steering, compact evidence review, user-boundary decisions, and reporting. Claude Code, Antigravity, Cursor when headless-capable, and host-native Codex workers when actually exposed own bounded project execution.

## Goal-First Continuity

Keep one Codex task per project. If the host exposes `get_goal`, call it before starting or resuming orchestration. An active Codex Goal is the durable control contract for repeated continuation in this same task; reuse its objective and the workspace's active AI Mobile run instead of creating another task, run, heartbeat, or cron job. Never create a Goal unless the user explicitly asks to start one.

Capacity checkpoints are internal routing reviews persisted in the AI Mobile run. They are not chat schedules and must not create messages or tasks. Do not create, update, or inspect an automation merely to keep project management alive. Use an automation only when the user explicitly requests a wall-clock reminder or periodic report; first find and update an existing matching automation, and keep a heartbeat attached to the same task rather than creating standalone chats.

During Goal-driven work, each continuation starts with one `project-manager-status` call for the existing workspace run. Keep the Goal active while useful progress is possible. Mark it complete only after AI Mobile reports verified completion; apply the host's blocked-goal threshold exactly and never mark it blocked for a temporary quota reset or a running external worker.

Manager-only means the control-room chat does not search memory for project implementation context, inspect project files, run project diagnostics or tests, edit source, or duplicate a worker after `run-project-manager` succeeds. Its normal tool path is one `run-project-manager` call followed by compact `project-manager-status` calls. The only direct exceptions are explicit user-boundary actions that cannot safely be delegated: authorization, protected live session/authentication checks, externally consequential operations, steering, and final acceptance of recorded evidence.

Every normal orchestration call defaults to `managerOnly=true`; omit the field or pass true. Set it to false only when the user explicitly asks this Codex chat itself to implement or diagnose a bounded item.

## Steering First

When a user changes the goal, adds a safety constraint, says stop, or withdraws permission while a run exists, handle that before any other work. Call `project-manager-status` with `steeringDirective`, any `addConstraints`, and `interruptRunningWorkers=true` (or `stopRun=true`). Do not merely acknowledge the instruction while an old worker continues. Start a new objective run only if the user still wants continuation.

If `run-project-manager` is called again, reuse the active run only when its goal, work graph, constraints, acceptance/verification gates, routing authorization, and budgets are unchanged. Accumulate existing same-goal constraints and gates with later additions, including across a stopped/completed run; do not require the user to restate them.

Examples requiring immediate interruption include: "do not access email", "stop", "do not use Antigravity", "do not change my browser profile", a new project goal, or revoked authorization for a live operation.

## Operating Frame

- Objective lifetime: continuous until verified, genuinely blocked, or explicitly stopped.
- Capacity horizon: rolling five-hour forecast for model selection, never a countdown.
- Capacity checkpoint: default 20 minutes, accelerating to five minutes near the protected Codex manager reserve, or on the next status call; refresh resources without interrupting active workers.
- Manager runway: reserve 15% of shared Codex capacity and default to one active native Codex worker; external CLI providers retain independent parallelism.
- Worker lease: adaptive 10-90 minute provider-call watchdog, not a project deadline.
- Utilization: keep appropriate healthy resources working on distinct dependency-ready items; never duplicate work just to use every model.

## Visible Progress Loop

The initial `run-project-manager` result is a dispatch receipt, not a user closeout. Pass `waitSeconds=0`, immediately tell the user which exact work items were assigned to which recorded resources, then call `project-manager-status` with `waitSeconds=20` in short intervals. Do not end the manager turn with only "running", "workers dispatched", or "next checkpoint".

Continue the short polling loop until one of these occurs: a work item completes or fails, a blocker/user-boundary action appears, a native Codex reservation/action appears, or two minutes pass with no transition. At two minutes, report the exact active item, provider/model, elapsed time, completed/failed counts, and next check; never invent a percentage. Every user-facing progress report must contain `Progress`, `Completed`, `Active`, `Failed/Blocked`, `Next`, and `Next check`.

When the user asks for continuous, proactive, unattended, or 24/7 management, prefer an active Codex Goal in this same task. The detached supervisor advances eligible external CLI work between Codex turns without model tokens; Goal continuations resume monitoring and native Codex actions. A recurring automation is optional and requires a separate explicit request for timed reports.

## Default Workflow

For a nontrivial project goal:

1. Understand the outcome, constraints, risk, current state, acceptance criteria, and focused verification.
   In manager-only mode, derive this from the user's request and existing AI Mobile run state. Do not pre-read project files, search implementation memory, or run health commands before dispatch; make project discovery a bounded work item.
2. Look for the normalized direct MCP tool `mcp__ai_mobile_local__run_project_manager` and the native host tool `multi_agent_v1__spawn_agent`. Do not declare AI Mobile or native Codex workers unavailable until exposed tool names have been searched for those exact prefixes. Pass `hostCodexAvailable=true` only when the spawn tool is actually callable.
3. Call `run-project-manager` once with `goal`, `workspace`, `managerOnly=true`, measured caller-visible Codex state when available, `hostCodexAvailable`, `horizonHours=5`, `runDeadlineMinutes=0`, `capacityCheckpointMinutes=20`, `codexManagerReservePercent=15`, `maxConcurrentCodexWorkers=1`, `maxWorkerMinutes=0`, `maxClaudeOutputTokens=12000`, `waitSeconds=0`, `start=true`, and a dependency-aware `workItems` graph only when the goal genuinely needs one. Zero project deadline means continuous until verified, blocked, or explicitly stopped; zero worker cap means complexity-adaptive safety leases. The 20-minute capacity checkpoint is local routing state, not an automation schedule. Pass top-level `constraints`, `acceptanceCriteria`, and `verification`; keep `includePlan=false` unless debugging routing. In a complex default graph, discovery completes before implementation so verified evidence can establish the writer's file boundary.
4. Do not read `project-manager-plan.json`, reconstruct submit commands, or manually call provider workers after a successful run call. The orchestrator dispatches eligible CLI work and returns `HostCodexActions` plus non-delegable `ManagerBoundaryActions` directly.
5. For every returned `HostCodexReservationAction`, first acknowledge `reserved` through `project-manager-status.hostWorkerEvents` with the exact run id, work item id, attempt id, and dispatch token. Only if the next status response still returns the exact `HostCodexAction`, call `multi_agent_v1__spawn_agent` with its bounded model, effort, role, and message. Immediately acknowledge the returned agent id as `started`; completion or failure uses the same attempt and token. Never mark native output as parent-chat Codex evidence.
6. While workers run, stay in the control room. Use `project-manager-status` and native host wait/close tools to monitor, steer, and report. Perform a returned manager-boundary action only when it is an authorization, protected live-state check, externally consequential operation, or other non-delegable user boundary. Do not fill worker idle time with repository exploration or implementation.
7. Use `project-manager-status` for compact continuation. Every `completedCodexItems` id must have a matching `codexEvidence` entry containing a concise verified summary and optional artifact refs. Pass blocked ids in `failedCodexItems`. Host workers use `hostWorkerEvents`, never these parent-action fields.
8. Read compact results once. Accept objective-specific evidence, request one bounded correction, or let the orchestrator perform its single provider-diverse failover. Manager-only mode forbids `takeoverCodexItems`; rescope or reassign the worker item instead.
9. Review the bounded integration and verification artifacts once. Do not rerun their project commands in the control-room chat. After all work items and recorded verification gates are complete, call `project-manager-status` with either `projectVerified=true` or `projectVerificationFailed=true` and a concrete `projectVerificationSummary`. A failed gate must become an explicit blocker, never an optimistic completion.

Do not ask the user to choose models manually. Do not use every provider merely because it is installed.
Do not preload all reference files. Open one only when its specific edge case is active.

## Execution Contract

- Normal path: `run-project-manager` owns Claude, Antigravity, and optional headless Cursor dispatch. Do not duplicate those calls.
- Manager-only control room: after a successful run call, do not use shell/project tools except for a specifically returned non-delegable manager-boundary action. Never run broad `rg`, recursive file listings, memory searches, harness diagnostics, tests, or edits as background activity.
- Native Codex worker: use `multi_agent_v1__spawn_agent` only for an exact `HostCodexAction` that remains exposed after its token-bound reservation acknowledgement. The native worker is separate from the manager chat, uses the selected current-catalog model/effort, never spawns workers, and is acknowledged with token-bound `hostWorkerEvents`. Never launch `codex.exe` as a nested worker.
- Current Codex action: perform only returned `ManagerBoundaryActions` directly and narrowly. Ordinary diagnostics, implementation, testing, and failed-worker recovery remain delegated.
- Steering or stop with a running native Codex worker returns `HostCodexCancellationActions`. Call `multi_agent_v1__close_agent`, acknowledge `cancelled` or `cancellation-unconfirmed`, and never start a replacement while cancellation remains unconfirmed.
- Real submissions, sends, deploys, purchases, destructive changes, and other externally consequential operations always remain current-Codex actions with authorization and live safety checks. External workers may analyze or verify them but may not perform them.
- Protect browser and account state. Never log out, clear cookies/storage, switch or create browser profiles, change the signed-in account, inspect saved credentials, install a connector, request OAuth consent, or access email/SMS verification codes unless the user explicitly authorized that exact action. Use task-owned automation tabs and stop at human authentication gates.
- Keep live checks of signed-in sessions, browser profiles, cookies, accounts, credentials, OAuth, email/SMS authentication, and CAPTCHA with the current Codex session. CLI workers may review bounded source code about those systems but may not inspect the user's live protected state.
- Git status, tracked deletions, ignored files, and source layout are not runtime-liveness evidence. Workers must use recorded dependency evidence or an explicitly allowed current health check.
- External writers require a verified file boundary. The bridge may infer it from completed dependency evidence; otherwise manager-only mode blocks and requests bounded discovery instead of returning implementation to current Codex.
- A `ready-for-codex` run is still active until final verification or explicit termination. Stop it before changed-goal replacement, and refuse the replacement if any old worker process cannot be confirmed stopped.
- Antigravity desktop UI is reserved for visible project/chat state or verified CLI gaps. Startup remains passive.

The bridge may start external CLI jobs, but an MCP server cannot invoke host-native Codex agent tools. The active skill must execute those host actions itself.

## Capacity Rules

- `run-project-manager` discovers installed CLIs, model catalogs, quotas, resets, cooldowns, and recent outcomes before assignment. `project-manager-plan` is a plan-only diagnostic.
- The parent Codex model is the manager; native Codex workers are separate resource candidates. Discover their exact model ids and supported efforts from the current host schema/catalog, apply the private local allow pattern, and route by task quality, speed, capacity, and observed project outcomes.
- Native Codex workers share the manager's five-hour pool. Penalize them as reserve headroom shrinks, stop new native dispatch at `codexManagerReservePercent`, and honor `maxConcurrentCodexWorkers`. Before reaching the reserve, prefer durable Claude or authorized Antigravity CLI work for remaining dependency-ready items.
- `codex-usage` reads only bounded local `token_count` metadata. It discards prompts, responses, paths, and thread ids. This is Codex agentic-usage evidence, not a complete ChatGPT product-limit API.
- Preserve unknown or stale capacity as unknown/stale. Never invent token allowances, reset times, or model availability.
- Apply every quota window that governs a model and route using the most restrictive remaining window.
- Discover models and supported effort levels from current catalogs/tool schemas. Honor the local model allow-pattern, and flag it when its review date is due.
- Use the cheapest/fastest model that safely meets the quality floor. Reserve highest efforts and premium models for materially critical reasoning, not routine work.
- Use all appropriate healthy resources when the graph has genuinely independent ready work, while preserving one writer and avoiding duplicate analysis.
- A provider outage, exhausted window, invalid model, timeout, or insufficient result triggers cooldown and one narrow failover. Do not loop retries.
- `horizonHours` is a rolling capacity forecast, never a countdown. Project duration is continuous by default; `capacityCheckpointMinutes` refreshes remaining capacity without terminating the objective.
- Worker calls use complexity-adaptive safety leases from 10 to 90 minutes when `maxWorkerMinutes=0`. A lease timeout rescoping/failover protects against a dead provider process but does not terminate the project.
- At a capacity checkpoint, refresh catalogs, quota windows, resets, cooldowns, and recent outcomes. Preserve running assignments; reroute only pending or resource-blocked work.
- The detached CLI supervisor uses no model tokens. It advances sequential external stages while the run is `running` and exits when current Codex input or a terminal decision is required.
- If the parent Codex window is exhausted, do not abandon or reconstruct the project. External jobs and the supervisor continue from `.antigravity-bridge`; after reset, call `project-manager-status` and resume the same run.
- Claude budgeting is auth-aware: claude.ai subscription auth (Pro/Max/Team/Enterprise, no API key) omits the USD cap and relies on measured quota windows plus output-token and lease guards; API-key/PAYG/unknown billing keeps a conservative automatic USD cap, and an explicit user cap always wins. `budget-exceeded` stops the lane without failover so cost is not doubled.
- Claude workers use feature-detected scout, reviewer, verifier, or writer contracts. Isolated bridge sessions use `--safe-mode`, non-persistence, structured output when supported, and no nested Agent tool. The bundled `claude-plugin/` roles are for direct Claude Code use; safe-mode bridge jobs receive equivalent explicit role instructions because safe mode suppresses plugins.
- Antigravity CLI may launch a browser OAuth flow. Do not auto-dispatch it unless the user explicitly enables `allowAntigravityCli=true` or supplies a specific `agyModel`. Prefer Claude/current Codex when that authorization is absent.

Detailed policy: [capacity-and-routing.md](references/capacity-and-routing.md).

## Context And Continuity

Workers receive a project capsule, not the parent transcript. It includes only the goal, constraints, work graph, ownership, file fingerprints, decisions, blockers, acceptance gates, verification, and compact artifact references. File contents and broad logs remain local and are read only when relevant.

Durable control artifacts live under:

```text
.antigravity-bridge/orchestrator/project-capsule.json
.antigravity-bridge/orchestrator/project-manager-plan.json
.antigravity-bridge/orchestrator/task-capsules/<workItemId>.json
.antigravity-bridge/jobs/<jobId>/
```

Read only compact worker artifacts: `result.md`, `changed-files.txt`, `diff.patch`, `test-output-summary.md`, `worker-telemetry.json`, and `status.json`.

Detailed contract: [context-capsules.md](references/context-capsules.md).

## Lifecycle Gates

Use `define -> plan -> execute -> verify -> review -> ship`. Worker completion is never project completion. Stop for user input on unresolved ambiguity, irreversible risk, missing authorization, or verification failure.

Detailed operating procedure and anti-rationalization checks: [project-manager.md](references/project-manager.md).

## Truthful Closeout

Before answering the user, call `project-manager-status` once and treat its `State` as authoritative.

- Start with `AI Mobile run <RunId>: <State>`.
- Report the models/resources that actually ran, the Codex-owned action, and the compact evidence.
- If `CompletionClaimAllowed: false`, do not say done, successful, actively managed, or that the management goal remains active. State the failed/blocked item and the next recovery action.
- A `completed` run means the objective passed final verification. Continuous mode keeps unfinished work resumable for as long as needed, but it does not invent new work after completion or claim a background worker exists when none is recorded.
- Distinguish the target application's own watchdog/runner from AI Mobile's run state.
- A low-complexity review that only rechecks terminal evidence from a current-Codex operation stays with Codex; do not launch another provider merely to restate the same evidence.

## CLI And UI

Startup is passive. Do not open, close, or repair desktop apps when Codex starts. Use CLI first to reduce RAM and latency; use UI only for visible state, authentication, unsupported CLI actions, or a verified CLI failure.

Detailed provider behavior: [provider-adapters.md](references/provider-adapters.md).

## Local Communication Profile

Call `orchestrator-profile` when a local communication or model policy is needed. The public default is professional. A private local profile may request a concise royal form of address and a technical-steward role; honor it respectfully without excessive flattery or unsupported certainty. Never commit the local profile.

## Fallback

If no `mcp__ai_mobile_local__*` tool is exposed after an actual tool-name search, use:

```powershell
powershell -ExecutionPolicy Bypass -File "$HOME\plugins\ai-mobile\scripts\antigravity.ps1" run-project-manager -Goal "<goal>" -Workspace "<path>" -HorizonHours 5 -WaitSeconds 0
```

Continue with `project-manager-status`, not manual JSON or provider-command reconstruction. Tool discovery failure is a route change, not permission to guess.
