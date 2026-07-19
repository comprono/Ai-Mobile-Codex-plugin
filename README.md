# AI Mobile Codex Plugin

Created by [comprono](https://github.com/comprono).

AI Mobile is a community Codex and Claude Code MCP plugin for Windows that coordinates the active project task with authenticated local Codex CLI, Claude Code, Antigravity CLI, and optional headless Cursor workers. Both hosts install from this repository and use the same versioned skill, MCP runtime, durable task state, and acceptance evidence.

The objective is practical: finish more verified work without spending more tokens, time, RAM, or review effort on orchestration than the delegated work saves.

## How It Works

1. start-task reads the bounded project outcome and acceptance gap and captures one fresh capacity snapshot.
2. The visible Codex task becomes a lightweight project console. It owns no project files and performs no bulk reading, planning, coding, or expensive review.
3. The deterministic coordinator returns the highest-value dependency-ready work-plane unit.
4. run-task-cycle starts or reuses one finite detached event-driven coordinator and returns a durable receipt promptly.
5. dispatch-round selects an actual Codex CLI, Claude, Antigravity, or Cursor worker from task fit, quota pools, reset horizon, reliability, RAM, storage, cost, and user priority.
6. Machine-wide leases protect provider slots, shared quota, the Codex reserve, file ownership, and worktree storage across projects.
7. The coordinator waits on worker state changes without visible-model polling, collects each finite worker once, and refuses an unchanged failed-provider retry.
8. integrate-round applies an isolated patch exactly once only after boundary checks and declared deterministic primary-workspace verification. Concurrent user changes and unverified patches are refused.
9. record-evidence advances only the named project requirement. complete-task refuses completion until every required acceptance item has sufficient evidence.

AI Mobile starts no desktop application, Goal, automation, heartbeat, LLM manager process, schedule, hidden Codex continuation, or recurring status loop. Its finite detached coordinator advances only on durable worker transitions and uses no repeated model-turn polling.

The console reports only accepted evidence, real assignments, typed blockers, resource choices, and the next action already assigned. Activity is not progress.

## Use

For one project:

```text
@ai-mobile Finish this project efficiently: <latest user request>
Outcome and acceptance may be omitted when .codex/PROJECT_OUTCOME.md and
.codex/ACCEPTANCE.json already define them.
Constraints: <important boundaries>
```

For multiple separate projects:

```text
@ai-mobile Coordinate these projects as one finite portfolio.
Portfolio outcome: <overall result>
Project A: <workspace, outcome, acceptance, priority, blockers>
Project B: <workspace, outcome, acceptance, priority, blockers>
```

The user does not need to design worker lanes. The coordinator recovers the acceptance gap and proposes only dependency-ready work that passes ownership, capacity, safety, and economic gates.

## Resource Decisions

- Project console: the cheapest capable visible Codex model at low effort for user interaction and compact reports only.
- Codex CLI: a separate work-plane worker when measured shared capacity remains above the private reserve, normally 15 percent.
- Claude Code: bounded implementation, debugging, architecture, and repository reasoning through the authenticated subscription CLI.
- Antigravity CLI: economical browser-oriented work, repository scans, research, drafting, and validation with explicit or saved read-only consent.
- Cursor: only a real authenticated headless cursor-agent; desktop presence is not a worker.
- No-model tools: tests, linters, validators, diffs, direct receipts, and deterministic patch integration are preferred for verification.

Model names are discovered dynamically. Routing ranks role capability, dependency readiness, quota pool, reset horizon, reliability, subscription or API cost, RAM, user priority, output size, and total integration or review cost. Unknown limits remain unknown.

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
| start-task | Recover bounded intent, create one durable project or portfolio task, capture capacity, and return console plus work-plane plans. |
| reconcile-task | Apply the latest correction to the same task, migrate legacy state, invalidate stale work, and preserve matching evidence. |
| dispatch-round | Allocate dependency-ready units to real work-plane workers; omitted units use the coordinator recommendation. |
| run-task-cycle | Start or reuse one finite detached event-driven coordinator and return a durable receipt without visible-model polling. |
| material-status | Passively report material events, acceptance, assignments, blockers, evidence, and next action without probing providers or scanning projects. |
| collect-round | Collect one bounded round and clean editing worktrees. |
| integrate-round | Apply verified isolated patches once without a model review; protect concurrent changes and roll back failed verification. |
| record-evidence | Attach verified evidence to one task or named portfolio project. |
| task-summary | Return one explicit compact evidence summary; it is not a heartbeat. |
| complete-task | Complete only from sufficient project-local acceptance evidence. |
| cancel-task | Stop owned workers, release leases, and clean owned worktrees. |
| resource-inventory | Passively inspect current provider, model, quota, lease, RAM, and storage evidence. |
| provider-diagnostics | Report privacy-safe executable, authentication, billing, model, quota/reset, and callable-surface evidence; run a minimal canary only when explicitly requested. |
| orchestrator-profile | Read or update private local routing and resource preferences. |
| prepare-restart-handoff | Persist one authorized exact-package and exact-task restart boundary for a schema upgrade. |

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

1. Keep the capable setup model active while it fixes, validates, scans, versions, and installs the plugin.
2. Do not switch the visible task to the lightweight console before restart.
3. prepare-restart-handoff closes only OpenAI.Codex and refreshes the canonical AI Mobile plugin. Classic ChatGPT is never a fallback.
4. Immediately after refresh, the launcher reopens the exact OpenAI.Codex task so the desktop cannot remain hidden behind verification or worker execution.
5. With that task visible, the official local Codex app-server resumes the exact persisted task. A bounded capable-model turn calls AI Mobile resource-inventory once and must observe the expected runtimeVersion.
6. Only after that evidence, a second turn in the same task selects the lightweight console model and low effort, reconciles the existing durable task once, and invokes run-task-cycle exactly once.
7. The detached coordinator continues finite worker, integration, and recovery transitions after the visible turn returns. Later explicit status requests use material-status once; the console never polls or creates another task.

This path never uses codex exec resume, a duplicate task, a Goal, an automation, an LLM manager loop, or UI automation. Normal continuation does not restart the app. Today the private console preference is GPT-5.6 Luna at low effort; future models are selected by role and live evidence rather than a permanent product name.

For a durable task whose outcome matches the project North Star, summary, dispatch, integration, evidence, and completion refresh authoritative .codex state. Execution states distinguish dispatch-required, workers-running, integration-required, blocked, and completed.

Normal installation, startup, inventory, dispatch, and long project execution never launch or restart a desktop app. Restart is used only after an explicitly authorized plugin upgrade that cannot load in the current task.
## CLI Diagnostics

```powershell
# Passive machine and provider evidence
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\plugins\ai-mobile\scripts\antigravity.ps1" resource-inventory -Refresh

# Start or advance a task/portfolio from a JSON contract
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
node .\scripts\self-test.js
node .\scripts\reliability-e2e.js
node .\scripts\continuation-regression.js
node .\scripts\task-cycle-regression.js
node .\scripts\console-workplane-regression.js
node .\scripts\durable-event-regression.js
node .\scripts\provider-capability-regression.js
node .\scripts\provider-patch-regression.js
node .\scripts\app-server-resume-regression.js
node .\scripts\fable-routing-regression.js
node .\scripts\trusted-primary-regression.js
node .\scripts\shared-host-install-regression.js
node .\scripts\outcome-recovery-e2e.js
node .\scripts\orchestration-regression.js
node .\scripts\state-capacity-regression.js
node .\scripts\worker-isolation-regression.js
node .\scripts\integration-regression.js
node .\scripts\portfolio-e2e.js
node .\scripts\global-resource-regression.js
node .\scripts\storage-lifecycle-regression.js
node .\scripts\economic-regression.js

# Manual authenticated release canaries; consume bounded provider requests
node .\scripts\installed-provider-canary.js
node .\scripts\real-provider-portfolio-canary.js

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
