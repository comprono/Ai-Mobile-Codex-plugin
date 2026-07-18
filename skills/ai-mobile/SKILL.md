---
name: ai-mobile
description: Use when the user explicitly invokes @ai-mobile for nontrivial work in one project or a portfolio of separate projects. AI Mobile makes current Codex and available local Codex CLI, Claude Code, Antigravity CLI, and optional Cursor workers operate as one finite, capacity-aware team. Current Codex actively advances the highest-value critical path; external workers receive only useful independent work.
---

# AI Mobile

## Purpose

AI Mobile is a local AI resource orchestrator installed from one repository into Codex and Claude Code. It helps finish one outcome or a portfolio of independent project outcomes by using authenticated local AI CLIs when delegation reduces total work or improves verified quality. The durable AI Mobile task, not either host's transient chat state, is the shared source of truth.

It is not a manager-only chat, scheduler, control room, heartbeat, Goal, automation, background supervisor, or reason for Codex to stop working.

## Start The Outcome

For an explicit `@ai-mobile` request involving nontrivial work, make `start-task` the first project-related call. Pass the latest user request verbatim in `userRequest`; do not silently rewrite a method such as review, inspection, planning, or monitoring into the final outcome. Supply either one project or a portfolio.

For one project, supply:

- the concrete workspace;
- the latest user request;
- the complete measurable outcome and positive acceptance evidence when they are not already in a bounded project contract;
- real constraints and the current Codex model when already known.

`start-task` reads only bounded explicit contracts: `.codex/PROJECT_OUTCOME.md`, `.codex/ACCEPTANCE.json`, and optional `.ai-mobile/project.json`. If Codex supplies a narrow diagnostic method while the project contract defines a broader operational outcome, AI Mobile restores the project outcome and reports the reconciliation. If the user explicitly wants the diagnostic artifact as the final deliverable, set `outcomeAuthority: "user"`.

For a portfolio, supply one portfolio outcome plus two or more project entries. Every project owns its workspace, outcome, acceptance evidence, priority, blockers, and optional dependency work graph. Do not flatten separate projects into unrelated `start-task` calls.

Do not invent worker lanes before inspecting the project. `start-task` records one finite task, imports the bounded acceptance gap, creates a minimal requirement work graph when needed, and passively inventories capacity. It starts no worker or desktop application.

When `.codex/ACCEPTANCE.json` names an unresolved `current_slice_requirement_id`, use the returned current-Codex unit for that slice unless an explicit dependency blocks it.

When the user corrects the goal, scope, acceptance, blocker, or priority, call `reconcile-task` on the same task before more work. Do not start a replacement task. Reconciliation cancels only workers made stale by the changed contract, invalidates their round, preserves evidence only for unchanged acceptance requirements, and returns the next owned action.

Trivial questions, one-line edits, and work whose delegation overhead is obviously larger should be handled directly without AI Mobile unless the user explicitly requires a provider.

## Work As The Lead Engineer

After `start-task`:

1. Start the returned current-Codex acceptance unit immediately; inspect only enough authoritative state to prove the gap and establish file ownership. In a portfolio, start with the highest-priority unblocked project.
2. If the recovered outcome is wrong because the user truly changed it, call `reconcile-task` once with the latest request, the full corrected outcome, and `outcomeAuthority: "user"` before continuing.
3. Identify dependency-ready units across all projects that are genuinely parallel, disjoint, independently verifiable, and cheaper than doing and reviewing them directly.
4. Call `dispatch-round` only after ownership is observed. Exact writer boundaries are mandatory; uncertain work stays read-only or in current Codex.
5. Continue current Codex work while workers run, including when workers own separate projects. Do not wait, narrate routine orchestration, inspect worker-owned questions, or touch worker-owned files.
6. At the natural integration point, call `collect-round` once. Use its local wait instead of repeated model-side polling.
7. Follow the returned recovery plan. Integrate each listed handoff once, or use the typed owner, trigger, and recovery action for a rejection or failure. Never repeat the same rejected worker contract.
8. Call `record-evidence` only for acceptance-linked proof. Portfolio evidence must name its project and never satisfies another project. Then call `complete-task`; it completes each project independently and the portfolio only after all required projects pass.

A further round is allowed only after the previous round is terminal and integrated, and only when another independent acceptance-linked unit remains. Long projects use several finite rounds, not a perpetual manager loop.
## Continue Without User-Operated Orchestration

The `execution` object is a binding same-turn contract for Codex, not a suggestion for the user:

- If `mustStartNow` is true, begin `execution.action` in the same turn before producing a final answer. A diagnostic, capacity inventory, test result, or blocker discovery is not a stopping point.
- Never end by telling the user to run a safe command, perform the next repair, call another AI Mobile tool, or ask for another prompt. Do it under the existing authorization when it is reversible and in scope.
- When an exact authorization, credential, CAPTCHA, login, or irreversible decision is genuinely required, state the single decision precisely. Continue every other dependency-ready safe unit before pausing.
- A blocked acceptance item is still executable work when it carries a non-user owner and `recoveryAction`. Start that recovery action; do not merely repeat the blocker.
- After bounded reconnaissance, call `dispatch-round` when a disjoint economical lane exists. If no worker is assigned, continue directly and report the rejection reason once.
- Report the current Codex model and each external provider as selected, idle, or unavailable with the routing reason. Availability alone is not a resource plan.
- Continue through finite implementation, verification, evidence recording, and the next acceptance-linked slice until a listed stop condition is actually reached.
- The plugin does not create a background loop. Within a loaded session, Codex continues finite acceptance-linked work until a true stop condition.
- If a plugin upgrade requires restarting Codex while authorized work remains, call `prepare-restart-handoff` with the exact thread, workspace, exact resume model, task, priorities, evidence-backed next action, and existing authorization. Run its one-shot launcher only as the final action of the turn. It must target package `OpenAI.Codex`, resume the same thread through `codex exec resume -m <model>`, and reopen that package with the project and thread deep link. Never call `codex app`, launch Classic ChatGPT, ask the user to restate context, or create a replacement task.
- Claude Code loads this same skill and MCP runtime. When it continues an existing task, use the durable task id and evidence rather than inventing a separate Claude plan; Codex CLI use remains a separately reported worker.

## Resource Judgment

- **Current Codex:** owns user intent, ambiguous reasoning, architecture, critical-path implementation, integration, risky actions, and final verification. AI Mobile never changes the model selected for the current Codex task.
- **Codex CLI worker:** use only when shared Codex capacity is measured above the private reserve and a separate high-value unit justifies consuming the same pool.
- **Claude Code:** bounded implementation, refactoring, debugging, architecture, and repository reasoning. Prefer the user's allowed capable model family; premium or model-specific capacity is used only when difficulty or a near reset justifies it. Exact `claude-fable-5` and `claude-sonnet-5` may use the trusted-primary path only when the private profile enables them.
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
- Do not dump the parent transcript. Workers receive a compact but complete task capsule: latest user request, outcome, constraints, unresolved acceptance, owned paths, unit acceptance, and integration action. Omit unrelated conversation.
- Never create worker review chains. Deterministic checks come first; another premium model reviews only unresolved high-risk evidence.
- Retry a transient provider failure at most once after a fresh capacity check. Semantic failures require a changed plan, not another dispatch.

## Isolation And Safety

- Read-only workers may inspect the declared shared workspace.
- Writer workers normally operate in detached Git worktrees that share repository history and return a stored patch. Read-only workers create no worktree.
- Exact Fable 5 and Sonnet 5 workers enabled by `trustedPrimaryWriteModels` may edit the primary Git workspace directly only when their explicit file boundaries are clean and disjoint and deterministic verification commands are present. Confirm the provider receipt matches the exact model. After successful checks, do not spend Luna, another Codex model, or another Claude model re-reviewing that work. Record acceptance evidence and continue. Generic aliases, older versions, dirty paths, and missing checks stay isolated.
- Worktrees are bounded by configured disk quota, minimum free space, and maximum age. They exclude dependencies, logs, caches, virtual environments, and build outputs, and are cleaned after collection, cancellation, crash/startup recovery, or expiry.
- If safe writer isolation is unavailable, keep the edit in current Codex or use a read-only adviser.
- Preserve user and concurrent changes. One owner per file boundary and question.
- Credentials, login, CAPTCHA, messages, applications, purchases, deploys, destructive operations, and other external side effects remain with current Codex under the user's applicable authorization.
- Normal startup, inventory, and dispatch never auto-open Codex, Claude, Antigravity, Cursor, or ChatGPT desktop UI. A one-shot Codex restart-resume may reopen Codex only under `allowCodexRestartHandoff` or explicit call authorization. Other UI fallback remains a separate explicit user decision.
- Classic ChatGPT is not a worker until it exposes a supported callable API, CLI, or MCP surface.

## Reporting

Report only material transitions, normally once after assignments and once after integration. For portfolios, identify the project on every changed, blocked, or verified line:

- `Done`: accepted change or verified outcome;
- `Active`: current Codex unit and genuinely running independent workers;
- `Blocked`: exact evidence, owner, and recovery action;
- `Resources`: current Codex and every considered provider as selected, idle, or unavailable, naming the model and routing reason;
- `Next`: the material action already starting.

Do not report dispatches, elapsed time, polling, worker count, healthy processes, or token use as progress. A worker completion, passing unit test, service restart, or running process cannot complete the project unless it proves the stated acceptance evidence.

Do not send a final response while `execution.mustStartNow` is true. `Next` is never homework for the user; it describes the action Codex has already begun.

## Tool Surface

- `start-task`: recover bounded project intent, create one project task or multi-project portfolio, and capture one passive capacity snapshot;
- `reconcile-task`: apply the latest correction to the same task, invalidate stale dependent work, preserve matching evidence, and return the next owned action;
- `dispatch-round`: keep current Codex on the highest-value path and route bounded independent units globally;
- `collect-round`: collect one finite task or portfolio round and clean collected editing worktrees;
- `record-evidence`: attach verified evidence only to the named project's requirements;
- `task-summary`: explicit compact diagnostic only;
- `complete-task`: evidence-gated completion;
- `cancel-task`: stop only task-owned workers;
- `resource-inventory`: explicit passive capacity diagnostic;
- `orchestrator-profile`: private local preferences.
- `prepare-restart-handoff`: durable one-shot Codex restart and exact-thread resume contract.

If a tool reports `STALE AI MOBILE TASK`, stop calling the stale MCP schema. When restart handoff is authorized, persist the exact continuation and run its one-shot launcher as the final action instead of asking the user to restart or repeat the task. Without authorization, report the single restart decision precisely. Do not reconstruct removed commands or revive a manager loop.
