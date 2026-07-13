---
name: ai-mobile
description: Coordinate the current Codex task with bounded Codex CLI, Claude Code, Antigravity, and optional Cursor workers. Use for nontrivial project work when capacity-aware parallel delegation can reduce elapsed time or context cost without turning the parent task into a polling control room.
---

# AI Mobile

## Aim

AI Mobile helps the current Codex task deliver a project outcome faster and with less wasted model capacity. It is a resource orchestrator, not a scheduler, status dashboard, or replacement for Codex judgment.

The current Codex task normally remains the goal owner, architect, critical-path worker, integrator, verifier, and user contact. It delegates only bounded independent work whose expected time or context savings exceed dispatch and integration overhead.

When this skill is loaded, do not search the filesystem, plugin cache, or memory for another AI Mobile skill. Use the normalized `ai-mobile-local` tools already exposed to this task.

## Non-Negotiable Defaults

- **Codex keeps working.** Dispatching a worker never means waiting for it. Continue the current Codex-owned critical path immediately.
- **Inventory once.** Read capacity at task start, then reuse it. Refresh only after a quota reset, provider failure, material model change, or 60 minutes of active work.
- **Delegate selectively.** Start zero to two independent lanes normally; use three only when boundaries and integration are unusually clear.
- **No orchestration loops.** Do not create a Goal, Codex task, recurring automation, heartbeat, continuous cycle, or repeated status poll merely because this skill is used.
- **One collection read.** Read each worker at its natural integration point or after its lease. Do not repeatedly ask whether it is done.
- **Verification costs less than production.** Prefer tests, validators, diffs, type checks, and policy gates. No premium-on-premium review chain; do not send successful premium-model work to another premium model for reassurance.
- **UI is fallback.** Startup is passive. Do not open Antigravity, Claude, Cursor, Chrome, or another desktop app unless visible state, authentication, or a verified CLI gap requires it.
- **Unknown stays unknown.** Never invent model limits, reset times, authentication, completion, or savings.

## When To Use It

Use AI Mobile when all are true:

1. The task is nontrivial.
2. At least one work item is genuinely independent of the current Codex critical path.
3. Another available provider has suitable capability or independent capacity.
4. The expected saved time/context is greater than the handoff and integration cost.

Skip delegation for quick answers, tightly coupled edits, tiny single-file fixes, user decisions, sensitive live-state checks, or work the current Codex task can finish faster than it can specify and integrate.

## Efficient Workflow

1. Understand the measurable outcome, constraints, current state, acceptance gates, and smallest useful verification.
2. Call `resource-inventory` once with `detail=compact`. Do not start apps while inventorying.
3. Make a short execution split:
   - one current-Codex critical path;
   - zero to two independent worker lanes;
   - explicit ownership boundaries for every writer;
   - a clear integration point.
4. Select providers from current evidence, not a fixed UI/backend/testing map. Call `run-efficient-task` once per external lane with an explicit `preferredProvider` whenever inventory already identified the provider. Send only the bounded objective, relevant boundary, acceptance check, and next step. Never send the parent transcript.
5. After each dispatch receipt, continue the Codex-owned work. Do not wait, poll, narrate the worker, or launch a reviewer.
6. At the integration point, call `read-job` once with `detail=compact`. Use `detail=full` only when the compact blocker is insufficient for focused diagnosis.
7. Inspect the bounded diff and run deterministic verification. Accept, repair narrowly, or reject the result.
8. On one failed or no-change lane, either fail over once to a clearly better available provider or take the bounded lane back into current Codex. Never create a review/retry chain.
9. Report material results, not orchestration activity.

## Resource Routing

Choose by task fit, measured availability, quota/reset horizon, reliability, ownership, and integration cost.

- **Current Codex:** architecture, ambiguous debugging, critical-path implementation, integration, final judgment, and all protected or externally consequential actions.
- **Standalone/native Codex worker:** a high-value independent lane when shared Codex capacity remains above the configured 15% reserve. It shares the Codex pool, so it is not a free external resource.
- **Claude Code:** bounded code implementation, refactoring, architecture review, and repository reasoning. Prefer Sonnet-class models for normal substantial work. Use Fable/Opus-class capacity only for genuinely hard work, explicit user choice, or a valuable dedicated window near reset. Do not use premium Claude merely to review premium Claude.
- **Antigravity CLI:** broad read-only file inspection, inexpensive research, browser-oriented analysis, drafting, and low-cost validation. Auto routing must not launch it without explicit CLI authorization because authentication or permission prompts may appear.
- **Antigravity UI:** only for a named visible project/chat, model switch, authentication, or a proven CLI limitation. Verify the expected project and chat before submission.
- **Cursor:** only when a true headless agent exists and the task benefits from its editor context. The Cursor UI launcher is not a headless worker.
- **No-model bridge verification:** deterministic commands and artifact checks. Use this before any reasoning reviewer.

Models and limits change. Discover current catalogs and quota windows; do not encode today's model names as permanent truth. A private local profile may express user preferences, but public defaults remain capability-based.

## Capacity Policy

- Plan over the next five hours only to decide what can run now and what resets soon. It is not a work deadline.
- Protect 15% of shared Codex capacity for integration, steering, and recovery. Capacity above the reserve should be used when useful work exists; the reserve is not an excuse for idle Codex capacity.
- If Codex capacity is unknown, keep current Codex productive and limit speculative Codex-worker dispatch to one lane.
- Apply the most restrictive capacity window that governs a model.
- Treat a dedicated model window near reset as an opportunity only when a suitable high-value task exists. Never manufacture work to consume quota.
- Cool down a failed provider and allow one justified failover. Do not retry the same broken transport repeatedly.

## Manager-Only Requests

If the user explicitly asks for a manager-only or reporting-only parent task, keep that parent task out of project edits, but still dispatch real Codex/provider workers. Manager-only applies to the parent task, not the Codex platform.

Use the same efficient workflow: one inventory, bounded dispatches, no polling, one result read, cheap verification, concise reports. If no worker can execute the critical path, report that concrete blocker immediately and offer adaptive mode. Do not spend turns maintaining an empty control room.

The legacy `run-project-manager`, `project-manager-status`, continuous-cycle, and heartbeat surfaces are advanced compatibility tools. Do not use them in the normal workflow. Use them only when the user explicitly requests the legacy durable control-room protocol and accepts its additional overhead.

## Reporting

Give the user short evidence-backed updates at meaningful transitions:

- `Done`: accepted changes or verified outcomes.
- `Active`: current Codex work and genuinely running worker lanes.
- `Blocked`: concrete blocker and owner.
- `Capacity`: only fresh relevant provider/model evidence.
- `Next`: the next delivery action or decision.

Worker dispatch, waiting, polling, retries, unchanged reviews, and a running supervisor are activity, not progress. Never present them as completed work.

Do not create periodic reporting unless the user explicitly asks for a cadence. If requested, use one same-task report no more frequently than every 30 minutes, make its status read non-waiting, and pause it when no worker is active. `Use no plugin`, `stop AI Mobile`, `pause AI Mobile`, and equivalent wording stop plugin activity before any further AI Mobile call.

## Verification Economics

1. Run deterministic checks first.
2. Current Codex reviews the compact changed-file list, bounded diff, and check evidence once.
3. Use an independent reasoning reviewer only for security, architecture, or irreversible-risk cases where tests cannot establish confidence.
4. Such a reviewer receives only the bounded diff and acceptance gates, uses a cheaper capable model, and targets at most 10% of the producer output.
5. Excess narration is compacted and warned; it does not invalidate attributable changes that pass boundary and deterministic checks.

## Safety And Ownership

- Writers require explicit non-overlapping `expectedFiles` boundaries. Read-only workers do not modify files.
- Preserve concurrent user and worker changes. Never revert unrelated work.
- Real submissions, sends, deploys, purchases, destructive operations, login, OAuth, CAPTCHA, credentials, cookies, email/SMS codes, and other protected live state remain with current Codex and require the user's applicable authorization.
- Antigravity permission auto-approval is never implicit. It does not authorize authentication, external effects, or work outside the declared boundary.
- Worker completion is evidence, not project completion. Current Codex integrates and verifies the project outcome.

## Default Tool Surface

Normal operation uses only:

- `resource-inventory`: passive compact capacity evidence;
- `run-efficient-task`: dispatch one bounded lane and return immediately;
- `read-job`: collect one compact result;
- `verify-job`: run no-model checks for an existing job;
- `cancel-job`: stop one worker;
- `orchestrator-profile`: read or update private local preferences when needed.

If these tools are not exposed after a plugin update, tell the user that the current Codex task has stale plugin tools and needs one Codex restart. Do not search caches, reconstruct internal provider commands, or fall back to the legacy manager loop.

Load an advanced reference only when its edge case is active: [capacity and routing](references/capacity-and-routing.md), [provider adapters](references/provider-adapters.md), [context capsules](references/context-capsules.md), or [legacy project manager](references/project-manager.md).
