---
name: ai-mobile
description: Use when the user explicitly invokes @ai-mobile for nontrivial work in one project or a portfolio of separate projects. AI Mobile makes current Codex and available local Codex CLI, Claude Code, Antigravity CLI, and optional Cursor workers operate as one finite, capacity-aware team. Current Codex actively advances the highest-value critical path; external workers receive only useful independent work.
---

# AI Mobile

## Purpose

AI Mobile is a local AI resource orchestrator. It helps current Codex finish one outcome or a portfolio of independent project outcomes by using authenticated local AI CLIs when delegation reduces total work or improves verified quality.

It is not a manager-only chat, scheduler, control room, heartbeat, Goal, automation, background supervisor, or reason for Codex to stop working.

## Start The Outcome

For an explicit `@ai-mobile` request involving nontrivial work, make `start-task` the first project-related call. Supply either one project or a portfolio.

For one project, supply:

- the concrete workspace;
- one complete measurable outcome;
- positive observable acceptance evidence;
- real constraints and the current Codex model when already known.

For a portfolio, supply one portfolio outcome plus two or more project entries. Every project owns its workspace, outcome, acceptance evidence, priority, blockers, and optional dependency work graph. Do not flatten separate projects into unrelated `start-task` calls.

Do not invent worker lanes before inspecting the project. `start-task` records one finite task and passively inventories capacity. It starts no worker or desktop application.

Trivial questions, one-line edits, and work whose delegation overhead is obviously larger should be handled directly without AI Mobile unless the user explicitly requires a provider.

## Work As The Lead Engineer

After `start-task`:

1. Inspect the minimum authoritative state needed to identify the acceptance gap. In a portfolio, start with the highest-priority unblocked project.
2. Choose and begin current Codex's highest-value critical-path unit immediately.
3. Identify dependency-ready units across all projects that are genuinely parallel, disjoint, independently verifiable, and cheaper than doing and reviewing them directly.
4. Call `dispatch-round` only after ownership is observed. Exact writer boundaries are mandatory; uncertain work stays read-only or in current Codex.
5. Continue current Codex work while workers run, including when workers own separate projects. Do not wait, narrate routine orchestration, inspect worker-owned questions, or touch worker-owned files.
6. At the natural integration point, call `collect-round` once. Use its local wait instead of repeated model-side polling.
7. Inspect each compact handoff and stored patch once. Accept, reject, or narrowly repair it; run deterministic project checks before any model review.
8. Call `record-evidence` only for acceptance-linked proof. Portfolio evidence must name its project and never satisfies another project. Then call `complete-task`; it completes each project independently and the portfolio only after all required projects pass.

A further round is allowed only after the previous round is terminal and integrated, and only when another independent acceptance-linked unit remains. Long projects use several finite rounds, not a perpetual manager loop.

## Resource Judgment

- **Current Codex:** owns user intent, ambiguous reasoning, architecture, critical-path implementation, integration, risky actions, and final verification. AI Mobile never changes the model selected for the current Codex task.
- **Codex CLI worker:** use only when shared Codex capacity is measured above the private reserve and a separate high-value unit justifies consuming the same pool.
- **Claude Code:** bounded implementation, refactoring, debugging, architecture, and repository reasoning. Prefer the user's allowed capable model family; premium or model-specific capacity is used only when difficulty or a near reset justifies it.
- **Antigravity CLI:** economical browser-oriented analysis, repository scans, research, drafting, and validation. It requires explicit lane authorization or saved read-only consent.
- **Cursor:** only a real authenticated headless `cursor-agent`; a desktop launcher is not a worker.
- **No-model tools:** tests, linters, validators, diffs, screenshots, and runtime evidence. Prefer them for verification.

Capacity is evidence with a timestamp, source, expiry, and confidence. Unknown remains unknown. Cached unavailable providers are re-probed before dispatch. Never create unnecessary work merely to consume capacity before reset.

For a portfolio, discover machine and provider capacity once at start. Allocate within the configured horizon using capability fit, dependencies, quota pools, reset horizons, reliability, subscription/API cost, free RAM, project priority, and fairness. Machine-wide leases prevent separate projects or tasks from oversubscribing one provider or quota pool. Current Codex's private reserve remains protected.

## Economic Rules

- Current Codex always has useful work; it is never only a reporter.
- Preserve the private Codex reserve, normally 15 percent, while using capacity above it productively.
- Start zero to the configured machine-wide external-worker limit, normally two. Prefer one ready unit per project before granting a second unit to the same project. Zero is correct when work overlaps, is too small, is unsafe, or would cost more to hand off and review.
- Count prompt, worker output, waiting, verification, retry, and integration cost. A cheap worker whose result needs expensive re-analysis is not a saving.
- Never send the parent transcript. Workers receive a compact outcome, owned paths, unit acceptance, and integration action.
- Never create worker review chains. Deterministic checks come first; another premium model reviews only unresolved high-risk evidence.
- Retry a transient provider failure at most once after a fresh capacity check. Semantic failures require a changed plan, not another dispatch.

## Isolation And Safety

- Read-only workers may inspect the declared shared workspace.
- Writer workers operate in detached Git worktrees that share repository history and return a stored patch; they never edit the primary worktree directly. Read-only workers create no worktree.
- Worktrees are bounded by configured disk quota, minimum free space, and maximum age. They exclude dependencies, logs, caches, virtual environments, and build outputs, and are cleaned after collection, cancellation, crash/startup recovery, or expiry.
- If safe writer isolation is unavailable, keep the edit in current Codex or use a read-only adviser.
- Preserve user and concurrent changes. One owner per file boundary and question.
- Credentials, login, CAPTCHA, messages, applications, purchases, deploys, destructive operations, and other external side effects remain with current Codex under the user's applicable authorization.
- AI Mobile never auto-opens Codex, Claude, Antigravity, Cursor, or ChatGPT desktop UI. A CLI limitation returns `ui-required`; opening UI is a separate explicit user decision.
- Classic ChatGPT is not a worker until it exposes a supported callable API, CLI, or MCP surface.

## Reporting

Report only material transitions, normally once after assignments and once after integration. For portfolios, identify the project on every changed, blocked, or verified line:

- `Done`: accepted change or verified outcome;
- `Active`: current Codex unit and genuinely running independent workers;
- `Blocked`: exact evidence, owner, and recovery action;
- `Capacity`: only fresh facts that changed the routing decision;
- `Next`: the material action already starting.

Do not report dispatches, elapsed time, polling, worker count, healthy processes, or token use as progress. A worker completion, passing unit test, service restart, or running process cannot complete the project unless it proves the stated acceptance evidence.

## Tool Surface

- `start-task`: create one project task or a multi-project portfolio and one passive capacity snapshot;
- `dispatch-round`: keep current Codex on the highest-value path and route bounded independent units globally;
- `collect-round`: collect one finite task or portfolio round and clean collected editing worktrees;
- `record-evidence`: attach verified evidence only to the named project's requirements;
- `task-summary`: explicit compact diagnostic only;
- `complete-task`: evidence-gated completion;
- `cancel-task`: stop only task-owned workers;
- `resource-inventory`: explicit passive capacity diagnostic;
- `orchestrator-profile`: private local preferences.

If a tool reports `STALE AI MOBILE TASK`, stop using AI Mobile in that Codex task. Restart Codex after installation and begin a fresh task so the skill and MCP schema load together. Do not reconstruct removed v0.x commands or revive a manager loop.
