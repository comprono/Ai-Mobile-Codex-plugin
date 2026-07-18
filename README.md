# AI Mobile Codex Plugin

Created by [comprono](https://github.com/comprono).

AI Mobile is a community Codex and Claude Code MCP plugin for Windows that coordinates the active project task with authenticated local Codex CLI, Claude Code, Antigravity CLI, and optional headless Cursor workers. Both hosts install from this repository and use the same versioned skill, MCP runtime, durable task state, and acceptance evidence.

The objective is practical: finish more verified work without spending more tokens, time, RAM, or review effort on orchestration than the delegated work saves.

## How It Works

1. `start-task` reads bounded project contracts, prevents a diagnostic method from replacing the real outcome, imports the acceptance gap, and discovers capacity once.
2. Current Codex immediately starts the returned highest-value acceptance unit.
3. `reconcile-task` applies a latest user correction to the same task, invalidates stale dependent work, and preserves only matching evidence.
4. `dispatch-round` assigns only dependency-ready, disjoint, economically useful work to available headless providers.
5. Machine-wide leases protect provider slots, quota pools, RAM, file ownership, Codex reserve, and worktree storage across every task and project.
6. Current Codex continues working while external workers run. No manager loop or polling feed is created.
7. `collect-round` returns each compact handoff once, cleans isolated editing worktrees, and supplies an owned recovery transition for rejection or failure.
8. Current Codex integrates isolated work. Exact Fable 5 or Sonnet 5 workers enabled by private policy may instead change clean bounded primary files directly; their deterministic checks replace a redundant lower-tier model review.
9. `complete-task` refuses completion until every required project has its own sufficient evidence.

AI Mobile starts no desktop application, Goal, automation, heartbeat, manager process, schedule, or recurring status loop.

Every tool response includes a same-turn execution contract and a compact resource report. If safe work remains, current Codex starts it before replying; `Next` describes work already beginning, not a command for the user to operate.

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

The user does not need to design worker lanes. Current Codex discovers the project state first, chooses its own critical path, and proposes only work that passes dependency, ownership, capacity, safety, and economic gates.

## Resource Decisions

- **Current Codex:** owns user intent, ambiguous reasoning, the highest-value critical path, integration, risky actions, and final verification.
- **Codex CLI:** an additional bounded worker only when measured shared capacity stays above the private reserve, normally 15 percent.
- **Claude Code:** bounded implementation, refactoring, debugging, architecture, and repository reasoning through the authenticated CLI.
- **Antigravity CLI:** economical browser-oriented analysis, repository scans, research, drafting, and validation. Read-only use requires explicit or saved local consent.
- **Cursor:** only a real authenticated headless `cursor-agent`; the desktop launcher is not treated as a worker.
- **No-model tools:** tests, linters, validators, diffs, and runtime evidence are preferred for verification.

Routing considers capability fit, dependency readiness, quota pools, reset horizon, recent reliability, subscription or API cost, free RAM, user priority, and integration cost. Unknown limits remain unknown. Cached negative availability is re-probed before dispatch rejection.

## Portfolio Safety

- One capacity inventory is shared by all projects in the portfolio.
- Current Codex works on the highest-priority unblocked project unless new evidence justifies an explicit override.
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
| `start-task` | Recover bounded project intent, start one finite task or portfolio, and capture one passive capacity snapshot. |
| `reconcile-task` | Apply the latest correction to the same task, invalidate stale work, preserve matching evidence, and return the next action. |
| `dispatch-round` | Keep current Codex active and allocate globally safe independent worker units. |
| `collect-round` | Collect one bounded round and clean collected editing worktrees. |
| `record-evidence` | Attach verified evidence to one task or one named portfolio project. |
| `task-summary` | Return one explicit compact evidence summary; it is not a heartbeat. |
| `complete-task` | Complete only from sufficient project-local acceptance evidence. |
| `cancel-task` | Stop owned workers, release leases, and clean owned worktrees. |
| `resource-inventory` | Passively inspect current machine, provider, quota, lease, and storage evidence. |
| `orchestrator-profile` | Read or update private local routing and resource preferences. |
| `prepare-restart-handoff` | Persist one authorized thread/task handoff for a required Codex restart and return its one-shot resume launcher. |

## Token Efficiency

- Trivial or tightly coupled work stays in current Codex.
- Method-only contracts are reconciled against bounded project intent before any worker starts.
- Rejected or failed delegation returns an owner, recovery trigger, recovery action, and next acceptance unit instead of ending the task.
- Workers receive compact outcome, ownership, acceptance, and integration contracts, never the parent transcript.
- Delegation accounts for prompt, worker output, wait, verification, retry, and integration cost.
- Small or overlapping work is rejected from delegation.
- Deterministic checks precede qualitative model review; verified trusted Fable 5 and Sonnet 5 changes receive no second model review.
- No worker review chain, lower-tier re-evaluation, or premium-model reassurance loop is created.
- A failed worker is retried only after a classified transient failure and changed capacity evidence.
- Worker activity, process health, elapsed time, and token usage are not reported as outcome progress.

The default communication mode is `smart-compact`: answer first, preserve exact evidence and caveats, and remove low-value narration without reducing reasoning quality.

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

Existing host sessions keep the schema they loaded at startup. When a required Codex upgrade occurs during an authorized long task, `prepare-restart-handoff` writes the exact thread, workspace, requested resume model, task, priorities, evidence, and next action. Codex may run the returned one-shot launcher as its final action; the helper closes only processes owned by the installed `OpenAI.Codex` package, resumes that thread headlessly with `codex exec resume -m <model>`, and activates the exact packaged app through `shell:AppsFolder` and opens the exact `codex://threads/<thread-id>` deep link. It never calls installer-capable `codex app` and never falls back to `OpenAI.ChatGPT-Desktop`.

Every restart handoff records its current phase, helper process id, bounded transition log, and any failure in the handoff JSON. Paths containing spaces are quoted end to end. After Codex closes, the helper refreshes the canonical AI Mobile cache before exact-thread resume. If the exact Codex desktop package cannot be identified or the refresh fails, the helper fails closed without stopping or launching Classic ChatGPT, or resuming with mixed plugin versions.

For an existing durable task whose outcome matches the project North Star, `task-summary`, dispatch, and completion refresh requirement status, blockers, and evidence from `.codex/ACCEPTANCE.json`. A separate explicit user-authoritative outcome remains isolated. Summaries distinguish durable task state from current execution as `workers-running`, `ready-for-current-codex`, blocked, or completed.

Normal installation, startup, inventory, and dispatch never launch a provider desktop app. Restart-resume is separately authorized in the private profile and only runs when Codex invokes the one-shot launcher.

Private standing preferences for the requested behavior:

```json

## CLI Diagnostics

```powershell
# Passive machine and provider evidence
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\plugins\ai-mobile\scripts\antigravity.ps1" resource-inventory -Refresh

# Start or advance a task/portfolio from a JSON contract
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\plugins\ai-mobile\scripts\antigravity.ps1" start-task -ContractFile ".\start.json"
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\plugins\ai-mobile\scripts\antigravity.ps1" reconcile-task -ContractFile ".\correction.json"
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\plugins\ai-mobile\scripts\antigravity.ps1" dispatch-round -ContractFile ".\round.json"
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\plugins\ai-mobile\scripts\antigravity.ps1" collect-round -ContractFile ".\collect.json"

# One explicit evidence summary
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\plugins\ai-mobile\scripts\antigravity.ps1" task-summary -TaskId "<task-id>"
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\plugins\ai-mobile\scripts\antigravity.ps1" task-summary -PortfolioId "<portfolio-id>"
```

## Privacy And Safety

Private routing preferences and runtime records remain local. The public repository must not contain credentials, cookies, browser profiles, transcripts, quota snapshots, personal project data, or machine-specific paths.

AI Mobile does not bypass quotas, authentication, CAPTCHA, login, OAuth, confirmation gates, workspace boundaries, or external-action safety. Sends, submissions, deploys, purchases, destructive actions, and similar side effects remain protected current-Codex operations under the user's applicable authorization.

## Development

Run all release gates before publishing:

```powershell
node .\scripts\self-test.js
node .\scripts\outcome-recovery-e2e.js
node .\scripts\continuation-regression.js
node .\scripts\state-capacity-regression.js
node .\scripts\orchestration-regression.js
node .\scripts\economic-regression.js
node .\scripts\worker-isolation-regression.js
node .\scripts\portfolio-e2e.js
node .\scripts\global-resource-regression.js
node .\scripts\trusted-primary-regression.js
node .\scripts\shared-host-install-regression.js
node .\scripts\storage-lifecycle-regression.js
node .\scripts\reliability-e2e.js
# Manual authenticated release canary; consumes one small provider request
node .\scripts\installed-provider-canary.js
powershell -ExecutionPolicy Bypass -File .\scripts\antigravity.ps1 self-test
powershell -ExecutionPolicy Bypass -File .\scripts\antigravity.ps1 privacy
git diff --check
pipx run plugin-scanner lint .
pipx run plugin-scanner verify .
pipx run plugin-scanner scan . --format json
```

Scanner 2.0.1114 scores the repository `100/100` with zero findings. Its standalone `verify` command intentionally classifies every local stdio MCP launch as `safety-skip` and exits nonzero; use the executed `self-test` and `reliability-e2e` gates as the manual runtime evidence alongside that scanner result.
See [Capacity-Aware Resource Orchestration](docs/CAPACITY_ORCHESTRATION.md) for decision rules and [Implementation Report](docs/IMPLEMENTATION_REPORT.md) for the v1 architecture and falsifiable gates.

## License

MIT
