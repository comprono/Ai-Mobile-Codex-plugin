# AI Mobile Codex Plugin

Created by [comprono](https://github.com/comprono).

AI Mobile is a community Codex MCP plugin for Windows that coordinates the current Codex task with authenticated local Codex CLI, Claude Code, Antigravity CLI, and optional headless Cursor workers. One request can cover one project or a portfolio of separate projects while each project keeps independent outcomes, evidence, patches, and completion state.

The objective is practical: finish more verified work without spending more tokens, time, RAM, or review effort on orchestration than the delegated work saves.

## How It Works

1. `start-task` records one finite outcome contract and passively discovers machine and provider capacity once.
2. Current Codex inspects the minimum authoritative state and immediately advances the highest-value ready critical path.
3. `dispatch-round` assigns only dependency-ready, disjoint, economically useful work to available headless providers.
4. Machine-wide leases protect provider slots, quota pools, RAM, file ownership, Codex reserve, and worktree storage across every task and project.
5. Current Codex continues working while external workers run. No manager loop or polling feed is created.
6. `collect-round` returns compact handoffs and patches once, then removes collected editing worktrees.
7. Current Codex integrates accepted work, runs deterministic checks, and records project-specific evidence.
8. `complete-task` refuses completion until every required project has its own sufficient evidence.

AI Mobile starts no desktop application, Goal, automation, heartbeat, manager process, schedule, or recurring status loop.

## Use

For one project:

```text
@ai-mobile Finish this project efficiently.
Outcome: <measurable result>
Acceptance: <positive observable proof>
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

Read-only workers inspect the declared shared repository and create no worktree. Editing workers use detached Git worktrees that share repository history and never modify the primary worktree directly.

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
| `start-task` | Start one finite project task or multi-project portfolio and capture one passive capacity snapshot. |
| `dispatch-round` | Keep current Codex active and allocate globally safe independent worker units. |
| `collect-round` | Collect one bounded round and clean collected editing worktrees. |
| `record-evidence` | Attach verified evidence to one task or one named portfolio project. |
| `task-summary` | Return one explicit compact evidence summary; it is not a heartbeat. |
| `complete-task` | Complete only from sufficient project-local acceptance evidence. |
| `cancel-task` | Stop owned workers, release leases, and clean owned worktrees. |
| `resource-inventory` | Passively inspect current machine, provider, quota, lease, and storage evidence. |
| `orchestrator-profile` | Read or update private local routing and resource preferences. |

## Token Efficiency

- Trivial or tightly coupled work stays in current Codex.
- Workers receive compact outcome, ownership, acceptance, and integration contracts, never the parent transcript.
- Delegation accounts for prompt, worker output, wait, verification, retry, and integration cost.
- Small or overlapping work is rejected from delegation.
- Deterministic checks precede qualitative model review.
- No worker review chain or premium-model reassurance loop is created.
- A failed worker is retried only after a classified transient failure and changed capacity evidence.
- Worker activity, process health, elapsed time, and token usage are not reported as outcome progress.

The default communication mode is `smart-compact`: answer first, preserve exact evidence and caveats, and remove low-value narration without reducing reasoning quality.

## Install

Requirements:

- Windows and Codex plugin support;
- Node.js on `PATH`;
- optional authenticated `codex`, `claude`, `agy`, and `cursor-agent` CLIs.

Clone and verify:

```powershell
git clone https://github.com/comprono/Ai-Mobile-Codex-plugin.git "$env:USERPROFILE\plugins\ai-mobile"
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\plugins\ai-mobile\scripts\antigravity.ps1" setup
```

Install the repository as a personal Codex plugin, then restart Codex and start a fresh task. Existing Codex tasks keep the skill and MCP schema loaded when they started and cannot be upgraded in place.

The plugin does not launch provider apps during installation or Codex startup. A visible UI fallback is a separate explicit user decision after a verified CLI limitation.

## CLI Diagnostics

```powershell
# Passive machine and provider evidence
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\plugins\ai-mobile\scripts\antigravity.ps1" resource-inventory -Refresh

# Start or advance a task/portfolio from a JSON contract
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\plugins\ai-mobile\scripts\antigravity.ps1" start-task -ContractFile ".\start.json"
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
node .\scripts\state-capacity-regression.js
node .\scripts\orchestration-regression.js
node .\scripts\economic-regression.js
node .\scripts\worker-isolation-regression.js
node .\scripts\portfolio-e2e.js
node .\scripts\global-resource-regression.js
node .\scripts\storage-lifecycle-regression.js
node .\scripts\reliability-e2e.js
# Manual authenticated release canary; consumes one small provider request
node .\scripts\installed-provider-canary.js
powershell -ExecutionPolicy Bypass -File .\scripts\antigravity.ps1 self-test
powershell -ExecutionPolicy Bypass -File .\scripts\antigravity.ps1 privacy
git diff --check
pipx run plugin-scanner lint .
pipx run plugin-scanner verify .
```

See [Capacity-Aware Resource Orchestration](docs/CAPACITY_ORCHESTRATION.md) for decision rules and [Implementation Report](docs/IMPLEMENTATION_REPORT.md) for the v1 architecture and falsifiable gates.

## License

MIT
