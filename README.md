# AI Mobile Codex Plugin

Created by [comprono](https://github.com/comprono).

AI Mobile is a community Codex and Claude Code Director-CFO plugin for Windows. It turns complex projects into authorized context, a strong master plan, a resource budget, typed worker teams, finite campaigns, reconciliation, and verified outcomes across authenticated local Codex CLI, Claude Code, Antigravity CLI, and optional headless Cursor workers.

The objective is practical: finish more verified work without spending more tokens, time, RAM, or review effort on orchestration than the delegated work saves.

## How It Works

1. start-program decides whether the request is a direct task that fits within one minute or a complex Director-CFO program.
2. A direct task bypasses durable orchestration. A complex task creates one Mission and an explicitly authorized source catalog.
3. An economical context scout builds a compact, cited Context Dossier. The visible Codex task remains a lightweight console and owns no project files.
4. A strong strategist turns the dossier into a Master Plan with milestones, workstreams, risks, team roles, timeline, and acceptance path.
5. The CFO forecasts the whole plan, protects reserves, binds immutable allocation grants, and aggregates attempts, tokens, duration, artifacts, leases, quota evidence, and campaign exposure across the durable program.
6. Typed context, strategy, implementation, operational, browser, verification, observation, and reconciliation workers receive bounded work packages.
7. run-program-campaign starts or resumes one bounded program supervisor above finite event-driven slices and budget-campaign epochs. It owns same-task continuation across campaign boundaries, process restarts, and recoverable capacity waits, without duplicate dispatch or integration. Before a budget exists, fixed conservative caps are independent of the time horizon. A revision-fenced provisional ResourceBudget then replaces them, and an accepted plan budget may replace that; historical exposure is added once and already-funded allocations are deduplicated.
8. Semantic failure creates a complete Failure Packet for a strong reconciler. An unchanged retry is refused, and repeated acceptance failure refreshes context and revises the plan.
9. program-report emits only material changes in goal, milestones, accepted evidence, active work, aggregate resources, supervisor state, blockers, recovery, and next action.
10. Completion requires accepted outcome evidence. Worker activity, elapsed time, and process health are never treated as project progress.

AI Mobile starts no desktop application, Goal, automation, heartbeat, LLM manager process, schedule, hidden Codex continuation, or recurring status loop. Its durable program supervisor owns bounded continuation while each detached coordinator slice remains finite and event-driven.

The console reports only accepted evidence, real assignments, typed blockers, resource choices, and the next action already assigned. Activity is not progress.

## Use

For one project:

```text
@ai-mobile Finish this project efficiently: <latest user request>
Outcome and acceptance may be omitted when .codex/PROJECT_OUTCOME.md and
.codex/ACCEPTANCE.json already define them.
Authorized sources: <project files, chats, logs, services, or other explicit locators>
Permissions and constraints: <important boundaries>
```

For multiple separate projects:

```text
@ai-mobile Coordinate these projects as one finite portfolio.
Portfolio outcome: <overall result>
Project A: <workspace, outcome, acceptance, priority, blockers>
Project B: <workspace, outcome, acceptance, priority, blockers>
```

The user does not need to design worker lanes. The Director-CFO builds the team and budget from the plan, then schedules only dependency-ready work that passes ownership, permission, capacity, reserve, safety, and economic gates.

## Resource Decisions

- Project console: GPT-5.3 Codex Spark at medium effort by default, for user interaction and compact reports only.
- Codex CLI: a separate work-plane worker when measured shared capacity remains above the private reserve, normally 15 percent.
- Claude Code: bounded implementation, debugging, architecture, and repository reasoning through the authenticated subscription CLI.
- Antigravity CLI: economical browser-oriented work, repository scans, research, drafting, and validation with explicit or saved read-only consent.
- Cursor: only a real authenticated headless cursor-agent; desktop presence is not a worker.
- No-model tools: tests, linters, validators, diffs, direct receipts, and deterministic patch integration are preferred for verification.

Model names are discovered dynamically. Routing ranks role capability, dependency readiness, quota pool, reset horizon, reliability, subscription or API cost, RAM, user priority, output size, and total integration or review cost. Unknown limits remain unknown.
Resource accounting never resets on a mission, plan, or campaign revision. Failed and cancelled attempts still count; missing telemetry commits the immutable allocation ceiling; live leases define concurrency; and unknown quota remains unknown rather than becoming zero.


Bulk context goes to deterministic search or an economical worker. Consequential architecture goes to the strongest suitable available model. A premium result is not automatically re-read by another premium model.

## Portfolio Safety

- One capacity inventory is shared by all projects in the portfolio.
- The work plane starts with the highest-priority unblocked project unless new evidence justifies an explicit override.
- Independent projects can use different providers concurrently.
- Priority-first round-robin allocation gives each ready project a fair opportunity before a second unit goes to the same project.
- Provider, quota-pool, and global worker leases are machine-wide, so separate portfolios cannot oversubscribe the same capacity.
- A blocked project does not stall useful work in another project.
- Evidence never crosses project boundaries, and portfolio completion requires every required project to pass independently.

## Worker Isolation

Read-only workers inspect the declared shared repository and create no worktree. Editing workers normally use detached Git worktrees that share repository history and never modify the primary worktree directly.

The only direct-write exception is exact `claude-fable-5` or `claude-sonnet-5`, enabled in the user's private `trustedPrimaryWriteModels` profile. The owned paths must be clean and explicit, deterministic verification commands are mandatory, and the provider receipt must confirm the exact model. Generic `fable`, generic `sonnet`, older Sonnet versions, other providers, dirty paths, and unverified work remain isolated.

Worktree controls are private local profile settings:

- `worktreeDiskQuotaMb`;
- `worktreeMinFreeMb`;
- `worktreeMaxAgeHours`;
- cleanup after collection, cancellation, lost worker recovery, startup, and maximum age;
- removal of dependencies, logs, caches, virtual environments, coverage, and build outputs before patch collection.

Runtime state lives under `%LOCALAPPDATA%\AI Mobile\v1`, outside managed repositories and Git branches.

## Tool Surface

| Tool | Purpose |
| --- | --- |
| start-program | Apply the one-minute intake gate; directly bypass simple work or create one durable Director-CFO program from authorized sources. |
| run-program-campaign | Start or resume one durable Director-CFO supervisor across finite slices and campaign epochs, with cumulative resource accounting, bounded quota recovery, provisional-to-accepted budget cap revisions, and an explicit overall horizon up to 168 hours. |
| program-report | Emit one deduplicated material report covering goal, milestone, accepted progress, blockers, budget, and next action. |
| reconcile-task | Apply a material correction to the same program, or explicitly migrate one canonical legacy task in place while preserving accepted evidence. |
| start-task | Legacy project or portfolio intake retained for existing tasks and deliberate diagnosis. |
| dispatch-round | Legacy or diagnostic allocation of dependency-ready units to real work-plane workers. |
| run-task-cycle | Legacy finite coordinator surface; Director-CFO programs use run-program-campaign. |
| material-status | Legacy passive material-event view; Director-CFO programs use program-report. |
| collect-round | Legacy or diagnostic collection for one bounded round. |
| integrate-round | Legacy or diagnostic verified patch integration with concurrent-change and rollback protection. |
| record-evidence | Attach verified evidence to one task or named portfolio project. |
| task-summary | Return one explicit compact evidence summary; it is not a heartbeat. |
| complete-task | Complete only from sufficient project-local acceptance evidence. |
| cancel-task | Stop owned workers, release leases, and clean owned worktrees. |
| resource-inventory | Passively inspect current provider, model, quota, lease, RAM, and storage evidence. |
| provider-diagnostics | Report privacy-safe executable, authentication, billing, model, quota/reset, and callable-surface evidence; run a minimal canary only when explicitly requested. |
| orchestrator-profile | Read or update private local routing and resource preferences. |
| prepare-restart-handoff | Persist one authorized exact-package and exact-task restart boundary with version, build-fingerprint, and Director-only continuation gates. |

## Token Efficiency

- The visible console never becomes an implementation fallback.
- Workers receive compact outcome, acceptance, ownership, test, and integration contracts, never the parent transcript.
- Delegation counts prompt, output, wait, retry, verification, and integration cost.
- Bulk reading uses deterministic or economical workers; heavy reasoning uses a strong model only for the compact hard question.
- Deterministic checks precede qualitative review.
- Verified trusted Fable 5 and Sonnet 5 changes receive no second model review.
- Isolated patches are integrated deterministically, not reimplemented by Luna.
- A failed worker is retried only after a classified transient failure and changed evidence.
- A successful read-only plan is accepted once, converted into exact dependency-ready writer units, and never repeated or sent through a redundant premium review.
- Worker activity, process health, elapsed time, and token usage are never reported as outcome progress.

The default communication mode is smart-compact: answer first, preserve exact evidence and caveats, and remove low-value narration without reducing reasoning quality.

## Install

Requirements:

- Windows with Codex and/or Claude Code plugin support;
- Node.js on `PATH`;
- optional authenticated `codex`, `claude`, `agy`, and `cursor-agent` CLIs.

Clone once and install the same checkout into both hosts:

```powershell
git clone https://github.com/comprono/Ai-Mobile-Codex-plugin.git "$env:USERPROFILE\plugins\ai-mobile"
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\plugins\ai-mobile\scripts\install-ai-mobile.ps1"
```

The repository is both an AI Mobile Codex marketplace and an AI Mobile Claude Code marketplace. A Git update followed by the same installer updates both host caches from this one source; there is no copied Claude orchestration implementation.

Existing host sessions keep the schema they loaded at startup. A schema or runtime upgrade therefore follows one strict order:

1. Keep the capable setup model active while it fixes, validates, scans, and versions the candidate.
2. Before installation or restart, run the mutation-guarded clone of the exact durable project state through real context integration, assured strategy, whole-plan budget and team compilation, and the first safe execution route. Never use a live restart as the release test.
3. After that clone passes, install the exact candidate into both host caches and verify its semantic version and whole-runtime fingerprint.
4. prepare-restart-handoff closes only OpenAI.Codex and refreshes the canonical AI Mobile plugin. Classic ChatGPT is never a fallback.
5. Immediately after refresh, the launcher reopens the exact OpenAI.Codex task so the desktop cannot remain hidden behind verification or worker execution.
6. With that task visible, the official local Codex app-server resumes the exact persisted task. A bounded capable-model turn calls AI Mobile resource-inventory once and must observe the expected runtimeVersion and runtimeFingerprint.
7. Only after both values match, a second turn in the same task selects GPT-5.3 Codex Spark at medium effort. An existing Director-CFO program resumes with zero reconciliation or migration; only a canonical legacy task may reconcile once under an explicit migration contract. The turn invokes run-program-campaign exactly once and never invokes start-program, start-task, or run-task-cycle.
8. After the app-server persists that continuation, the same authorized upgrade handoff performs one finite package-owned OpenAI.Codex process reload and reopens the exact task. This clears the desktop renderer's stale task snapshot; it is never used during normal project execution.
9. The detached coordinator continues finite worker, integration, and recovery transitions after the visible turn returns. Later explicit status requests use program-report once; the console never polls or creates another task.

This path never uses codex exec resume, a duplicate task, a Goal, an automation, an LLM manager loop, or UI automation. Normal continuation does not restart the app. The default Director-CFO console is GPT-5.3 Codex Spark at medium effort; work-plane models are selected by role and live evidence rather than a permanent product name.

For a durable task whose outcome matches the project North Star, summary, dispatch, integration, evidence, and completion refresh authoritative .codex state. Execution states distinguish dispatch-required, workers-running, integration-required, blocked, and completed.

Normal installation, startup, inventory, dispatch, and long project execution never launch or restart a desktop app. Restart is used only after an explicitly authorized plugin upgrade that cannot load in the current task.
## CLI Diagnostics

```powershell
# Passive machine and provider evidence
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\plugins\ai-mobile\scripts\antigravity.ps1" resource-inventory -Refresh

# Start or advance a Director-CFO program from a JSON contract
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\plugins\ai-mobile\scripts\antigravity.ps1" start-program -ContractFile ".\program.json"
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\plugins\ai-mobile\scripts\antigravity.ps1" run-program-campaign -ContractFile ".\campaign.json"
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\plugins\ai-mobile\scripts\antigravity.ps1" program-report -TaskId "<task-id>"

# Legacy task or portfolio diagnostics
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\plugins\ai-mobile\scripts\antigravity.ps1" start-task -ContractFile ".\start.json"
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\plugins\ai-mobile\scripts\antigravity.ps1" reconcile-task -ContractFile ".\correction.json"
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\plugins\ai-mobile\scripts\antigravity.ps1" dispatch-round -ContractFile ".\round.json"
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\plugins\ai-mobile\scripts\antigravity.ps1" run-task-cycle -ContractFile ".\cycle.json"
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\plugins\ai-mobile\scripts\antigravity.ps1" collect-round -ContractFile ".\collect.json"

# One explicit evidence summary
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\plugins\ai-mobile\scripts\antigravity.ps1" task-summary -TaskId "<task-id>"
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\plugins\ai-mobile\scripts\antigravity.ps1" task-summary -PortfolioId "<portfolio-id>"
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\plugins\ai-mobile\scripts\antigravity.ps1" material-status -TaskId "<task-id>"

# Privacy-safe provider details; add -ContractFile only for an explicitly requested canary
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\plugins\ai-mobile\scripts\antigravity.ps1" provider-diagnostics
```

## Privacy And Safety

Private routing preferences and runtime records remain local. The public repository must not contain credentials, cookies, browser profiles, transcripts, quota snapshots, personal project data, or machine-specific paths.

AI Mobile does not bypass quotas, authentication, CAPTCHA, login, OAuth, confirmation gates, workspace boundaries, or external-action safety. Sends, submissions, deploys, purchases, destructive actions, and similar side effects remain protected by the project's authorization and evidence gates.

## Development

Run all release gates before publishing:

```powershell
node .\scripts\antigravity-model-identity-regression.js
node .\scripts\app-server-resume-regression.js
node .\scripts\console-workplane-regression.js
node .\scripts\context-freshness-regression.js
node .\scripts\continuation-regression.js
node .\scripts\director-cfo-budget-regression.js
node .\scripts\director-cfo-campaign-continuation-regression.js
node .\scripts\director-cfo-context-regression.js
node .\scripts\director-cfo-contracts-regression.js
node .\scripts\director-cfo-failed-round-regression.js
node .\scripts\director-cfo-live-inventory-regression.js
node .\scripts\director-cfo-migration-regression.js
node .\scripts\director-cfo-operational-dispatch-regression.js
node .\scripts\director-cfo-program-regression.js
node .\scripts\director-cfo-provider-contract-regression.js
node .\scripts\director-cfo-resource-enforcement-regression.js
node .\scripts\director-cfo-runtime-regression.js
node .\scripts\director-cfo-typed-execution-regression.js
node .\scripts\durable-event-regression.js
node .\scripts\economic-regression.js
node .\scripts\fable-routing-regression.js
node .\scripts\global-resource-regression.js
node .\scripts\installed-runtime-parity-regression.js
node .\scripts\integration-regression.js
node .\scripts\orchestration-regression.js
node .\scripts\outcome-recovery-e2e.js
node .\scripts\portfolio-e2e.js
node .\scripts\program-reporting-regression.js
node .\scripts\program-resource-snapshot-regression.js
node .\scripts\provider-capability-regression.js
node .\scripts\provider-patch-regression.js
node .\scripts\reliability-e2e.js
node .\scripts\resource-lease-regression.js
node .\scripts\self-test.js
node .\scripts\shared-host-install-regression.js
node .\scripts\sqlite-observation-regression.js
node .\scripts\sqlite-snapshot-regression.js
node .\scripts\state-capacity-regression.js
node .\scripts\storage-lifecycle-regression.js
node .\scripts\task-cycle-regression.js
node .\scripts\trusted-primary-regression.js
node .\scripts\worker-isolation-regression.js

# Manual authenticated release canaries; consume bounded provider requests
node .\scripts\installed-provider-canary.js
node .\scripts\real-provider-portfolio-canary.js

# Explicit authorization is required because this sends the task's authorized
# project sources to authenticated providers. It stops before execution work.
$env:AI_MOBILE_CANARY_TASK_ID = "task-your-durable-id"
node .\scripts\live-state-release-canary.js

powershell -ExecutionPolicy Bypass -File .\scripts\antigravity.ps1 self-test
powershell -ExecutionPolicy Bypass -File .\scripts\antigravity.ps1 privacy
git diff --check
pipx run plugin-scanner lint .
pipx run plugin-scanner verify .
pipx run plugin-scanner scan . --format json
```

Scanner 2.0.1116 scores the repository `100/100` with zero findings. Its standalone `verify` command intentionally classifies every local stdio MCP launch as `safety-skip` and exits nonzero; use the executed `self-test` and `reliability-e2e` gates as the manual runtime evidence alongside that scanner result.
See [Capacity-Aware Resource Orchestration](docs/CAPACITY_ORCHESTRATION.md) for decision rules and [Implementation Report](docs/IMPLEMENTATION_REPORT.md) for the v1 architecture and falsifiable gates.

## License

MIT
