---
name: ai-mobile
description: Use Codex as a capacity-aware project manager across native Codex workers, Claude Code, Antigravity, and optional Cursor. Use when a project should be understood, packaged into bounded context, assigned by current capability and quota, executed CLI-first in parallel where safe, critiqued, integrated, verified, and resumed without replaying the parent chat.
---

# AI Mobile

Use one Codex chat as the project control room. The current Codex session is the project manager, goal owner, integration owner, and an active narrow contributor. It coordinates workers; it does not become a passive router or duplicate delegated work.

## Steering First

When a user changes the goal, adds a safety constraint, says stop, or withdraws permission while a run exists, handle that before any other work. Call `project-manager-status` with `steeringDirective`, any `addConstraints`, and `interruptRunningWorkers=true` (or `stopRun=true`). Do not merely acknowledge the instruction while an old worker continues. Start a new objective run only if the user still wants continuation.

If `run-project-manager` is called again, reuse the active run only when its goal, work graph, constraints, acceptance/verification gates, routing authorization, and budgets are unchanged. Accumulate existing same-goal constraints and gates with later additions, including across a stopped/completed run; do not require the user to restate them.

Examples requiring immediate interruption include: "do not access email", "stop", "do not use Antigravity", "do not change my browser profile", a new project goal, or revoked authorization for a live operation.

## Operating Frame

- Objective lifetime: continuous until verified, genuinely blocked, or explicitly stopped.
- Capacity horizon: rolling five-hour forecast for model selection, never a countdown.
- Capacity checkpoint: default 20 minutes while the low-RAM supervisor runs, or on the next status call; refresh resources without interrupting active workers.
- Worker lease: adaptive 10-90 minute provider-call watchdog, not a project deadline.
- Utilization: keep appropriate healthy resources working on distinct dependency-ready items; never duplicate work just to use every model.

## Default Workflow

For a nontrivial project goal:

1. Understand the outcome, constraints, risk, current state, acceptance criteria, and focused verification.
2. Look for the normalized direct MCP tool `mcp__ai_mobile_local__run_project_manager`. Do not declare AI Mobile unavailable until exposed tool names have been searched for the `mcp__ai_mobile_local__` prefix.
3. Call `run-project-manager` once with `goal`, `workspace`, `horizonHours=5`, `runDeadlineMinutes=0`, `capacityCheckpointMinutes=20`, `maxWorkerMinutes=0`, `maxClaudeOutputTokens=12000`, `start=true`, and a dependency-aware `workItems` graph only when the goal genuinely needs one. Zero project deadline means continuous until verified, blocked, or explicitly stopped; zero worker cap means complexity-adaptive safety leases. Pass top-level `constraints`, `acceptanceCriteria`, and `verification`; keep `includePlan=false` unless debugging routing. In a complex default graph, discovery completes before implementation so verified evidence can establish the writer's file boundary.
4. Do not read `project-manager-plan.json`, reconstruct submit commands, or manually call provider workers after a successful run call. The orchestrator dispatches eligible CLI work and returns `CodexOwnedActions` directly.
5. While workers run, complete only the returned Codex-owned critical path: authorization, live-state checks, architecture decisions, integration, or another non-duplicated item. Any worker that needs live/current/runtime truth must depend on that verified Codex action.
6. Use `project-manager-status` for compact continuation. Every `completedCodexItems` id must have a matching `codexEvidence` entry containing a concise verified summary and optional artifact refs. Pass blocked ids in `failedCodexItems`.
7. Read compact results once. Accept objective-specific evidence, request one bounded correction, or let the orchestrator perform its single provider-diverse failover. If Codex must replace a bad/cancelled worker, first pass that id in `takeoverCodexItems`; never make an unrecorded local fallback.
8. Merge once and run focused final verification. After all work items are complete, call `project-manager-status` with either `projectVerified=true` or `projectVerificationFailed=true` and a concrete `projectVerificationSummary`. A failed gate must become an explicit blocker, never an optimistic completion.

Do not ask the user to choose models manually. Do not use every provider merely because it is installed.
Do not preload all reference files. Open one only when its specific edge case is active.

## Execution Contract

- Normal path: `run-project-manager` owns Claude, Antigravity, and optional headless Cursor dispatch. Do not duplicate those calls.
- Native Codex action: use the host agent tool only for a clearly independent bounded action explicitly returned by a diagnostic plan. Workers never spawn workers and `codex.exe` is never launched as a worker.
- Current Codex action: perform returned `CodexOwnedActions` directly with targeted reads and commands.
- Real submissions, sends, deploys, purchases, destructive changes, and other externally consequential operations always remain current-Codex actions with authorization and live safety checks. External workers may analyze or verify them but may not perform them.
- Protect browser and account state. Never log out, clear cookies/storage, switch or create browser profiles, change the signed-in account, inspect saved credentials, install a connector, request OAuth consent, or access email/SMS verification codes unless the user explicitly authorized that exact action. Use task-owned automation tabs and stop at human authentication gates.
- Keep live checks of signed-in sessions, browser profiles, cookies, accounts, credentials, OAuth, email/SMS authentication, and CAPTCHA with the current Codex session. CLI workers may review bounded source code about those systems but may not inspect the user's live protected state.
- Git status, tracked deletions, ignored files, and source layout are not runtime-liveness evidence. Workers must use recorded dependency evidence or an explicitly allowed current health check.
- External writers require a verified file boundary. The bridge may infer it from completed dependency evidence; otherwise the item returns to current Codex instead of launching a broad exploratory writer.
- A `ready-for-codex` run is still active until final verification or explicit termination. Stop it before changed-goal replacement, and refuse the replacement if any old worker process cannot be confirmed stopped.
- Antigravity desktop UI is reserved for visible project/chat state or verified CLI gaps. Startup remains passive.

The bridge may start external CLI jobs, but an MCP server cannot invoke host-native Codex agent tools. The active skill must execute those host actions itself.

## Capacity Rules

- `run-project-manager` discovers installed CLIs, model catalogs, quotas, resets, cooldowns, and recent outcomes before assignment. `project-manager-plan` is a plan-only diagnostic.
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
- Claude workers receive a provider cost cap and a reported output-token cap. `budget-exceeded` stops the lane without failover so cost is not doubled.
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
powershell -ExecutionPolicy Bypass -File "$HOME\plugins\ai-mobile\scripts\antigravity.ps1" run-project-manager -Goal "<goal>" -Workspace "<path>" -HorizonHours 5 -WaitSeconds 5
```

Continue with `project-manager-status`, not manual JSON or provider-command reconstruction. Tool discovery failure is a route change, not permission to guess.
