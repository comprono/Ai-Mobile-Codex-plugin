---
name: ai-mobile
description: Coordinate the current Codex task with bounded Codex CLI, Claude Code, Antigravity, and optional Cursor workers. Use for nontrivial project work when capacity-aware parallel delegation can reduce elapsed time or context cost without turning the parent task into a polling control room.
---

# AI Mobile

## Aim

AI Mobile helps the current Codex task deliver a project outcome faster and with less wasted model capacity. It is a resource orchestrator, not a scheduler, status dashboard, or replacement for Codex judgment.

The current Codex task normally remains the goal owner, architect, critical-path worker, integrator, verifier, and user contact. It delegates only bounded independent work whose expected time or context savings exceed dispatch and integration overhead.

Keep the user's complete project outcome fixed until it is verified or explicitly changed. A passing milestone advances that outcome; it does not replace it and is not, by itself, a reason to stop.

When this skill is loaded, do not search the filesystem, plugin cache, or memory for another AI Mobile skill. Use the normalized `ai-mobile-local` tools already exposed to this task.

## Non-Negotiable Defaults

- **Codex keeps working.** Dispatching a worker never means waiting for it. Continue the current Codex-owned critical path immediately.
- **The root outcome survives.** Never shrink a broad project objective into the first safe fix, review, or feature slice.
- **Advance after success.** When a milestone passes, integrate it and start the next dependency-ready milestone in the same turn while useful capacity and authority remain.
- **Inventory once.** Read capacity at task start, then reuse it. Refresh only after a quota reset, provider failure, material model change, or 60 minutes of active work.
- **Delegate selectively.** Start zero to two independent external lanes; never exceed two in one workspace.
- **One owner per lane.** Current Codex and a worker never investigate the same question or touch overlapping files concurrently. Parallelism means different useful work, not two answers to one problem.
- **No orchestration loops.** Do not create a Goal, Codex task, recurring automation, heartbeat, continuous cycle, or repeated status poll merely because this skill is used.
- **One collection read.** Keep the returned job id in working context. Read it once at its integration point or lease, and integrate that result before doing any worker-owned analysis. Do not repeatedly ask whether it is done.
- **Verification costs less than production.** Prefer tests, validators, diffs, type checks, and policy gates. No premium-on-premium review chain; do not send successful premium-model work to another premium model for reassurance.
- **UI is fallback.** Startup is passive. Do not open Antigravity, Claude, Cursor, Chrome, or another desktop app unless visible state, authentication, or a verified CLI gap requires it.
- **Unknown stays unknown.** Never invent model limits, reset times, authentication, completion, or savings.
- **Think deeply; communicate compactly.** Compression applies to wording, never to reasoning, verification, evidence, code, or safety.

## Smart Compact Communication

Default to scan-friendly, answer-first communication:

- lead with the outcome, decision, or blocker;
- use short headings and bullets only when they improve scanning;
- omit greetings, repeated task text, tool-by-tool narration, waiting commentary, and routine postambles;
- preserve exact facts, numbers, paths, commands, errors, caveats, and evidence;
- report only material transitions, not orchestration activity;
- expand automatically for ambiguity, user confusion, safety warnings, irreversible actions, tradeoffs, or requested explanation.

Never use deliberately broken or cryptic grammar. Fewer words must not make the answer harder to understand. The private profile may set `communicationMode` to `smart-compact` (default), `standard`, or `detailed`.

## Root Outcome And Delivery Batches

For a broad project request, keep four compact facts in working context:

- `RootOutcome`: the complete measurable user outcome;
- `CompletionEvidence`: the proof required before the project can be called complete;
- `CurrentBatch`: two to four dependency-aware milestones that materially advance the root outcome;
- `Frontier`: the next ready work after the current batch.

For every dispatched lane, also keep one compact ownership record:

- `CurrentCodexLane`: what Codex is doing now;
- `WorkerLane`: the distinct question or change delegated;
- `ForbiddenOverlap`: worker files/question Codex must not redo;
- `CollectAt`: the concrete integration point or finite lease;
- `JobId`: the single durable result to read.

Do not turn `CurrentBatch` into a manager run. It is an execution batch inside the current Codex turn. Assign at least one milestone to current Codex. Use healthy external capacity for independent lanes when it saves elapsed time or context; if no lane is delegated, continue directly and state the concrete reason only in the final report.

A milestone passing is an integration point. Continue to the next ready milestone without asking the user or ending the turn unless one of these is true:

1. `RootOutcome` and `CompletionEvidence` are verified;
2. a real authorization, safety, product decision, or missing fact requires the user;
3. no dependency-ready work remains because of a concrete external blocker;
4. protected Codex reserve has been reached and no suitable external capacity can continue; or
5. the host turn must end, in which case report the exact verified frontier so the same project task can resume without rediscovery.

## When To Use It

Use AI Mobile when all are true:

1. The task is nontrivial.
2. At least one work item is genuinely independent of the current Codex critical path.
3. Another available provider has suitable capability or independent capacity.
4. The expected saved time/context is greater than the handoff and integration cost.

Skip delegation for quick answers, tightly coupled edits, tiny single-file fixes, user decisions, sensitive live-state checks, or work the current Codex task can finish faster than it can specify and integrate.

## Efficient Workflow

1. Fix the `RootOutcome`, `CompletionEvidence`, constraints, current state, and acceptance gates. Do not substitute a nearby milestone for the root outcome.
2. Call `resource-inventory` once with `detail=compact`. Do not start apps while inventorying.
3. Build a two-to-four item `CurrentBatch` from the dependency frontier:
   - one current-Codex critical path;
   - zero to two independent worker lanes;
   - explicit ownership boundaries for every writer;
   - a clear integration point and following milestone.
4. Before dispatch, state `currentCodexGoal`, `currentCodexFiles`, the worker `goal`, `relevantFiles`, and one falsifiable `independenceReason`. If you cannot explain why the lanes are independent in one sentence, do the work directly.
5. Call `run-efficient-task` once. Let `auto` score providers unless the user explicitly requested one. Include a realistic direct-token estimate and a small worker output cap. The runtime rejects semantic overlap, file overlap, duplicate active lanes, low economic value, provider cooldowns, unsafe billing, and unavailable capacity.
6. After a dispatch receipt, record its `JobId`, `ForbiddenOverlap`, and `CollectAt`, then continue only the disjoint Codex lane. If Codex reaches the worker lane first, collect the worker result or cancel it before taking ownership; never silently redo it.
7. At the integration point, call `read-job` once with `detail=compact` and `waitSeconds=60` when the worker may still be finishing. The wait happens inside the local bridge and does not create model-side polling turns. A completed result says `integration.required=true`; use it before finalizing that lane. Use `detail=full` only when the compact blocker is insufficient for focused diagnosis.
8. Inspect the bounded diff and run deterministic verification. Accept, repair narrowly, or reject the result. Do not spend a second premium model merely to restate a usable premium result.
9. On one failed or no-change lane, either fail over once to a clearly better available provider or take the bounded lane back into current Codex. Never create a review/retry chain.
10. After integrating a milestone, immediately advance the dependency frontier and continue the batch. Report material results and the verified frontier, not orchestration activity.

## Resource Routing

Choose by task fit, measured availability, quota/reset horizon, reliability, ownership, and integration cost.

- **Current Codex:** architecture, ambiguous debugging, critical-path implementation, integration, final judgment, and all protected or externally consequential actions.
- **Standalone/native Codex worker:** a high-value independent lane when shared Codex capacity remains above the configured 15% reserve. It shares the Codex pool, so it is not a free external resource.
- **Claude Code:** bounded code implementation, refactoring, architecture review, and repository reasoning. Prefer Sonnet-class models for normal substantial work. Use Fable/Opus-class capacity only for genuinely hard work, explicit user choice, or a verified valuable dedicated window near reset. Claude is not the automatic first choice for every repository read.
- **Antigravity CLI:** broad read-only file inspection, inexpensive research, browser-oriented analysis, drafting, and low-cost validation. Auto routing requires explicit CLI authorization. A private local auto-approval preference applies only to sandboxed read-only CLI lanes and never opens the desktop.
- **Antigravity UI:** only for a named visible project/chat, model switch, authentication, or a proven CLI limitation. Verify the expected project and chat before submission.
- **Cursor:** only when a true headless agent exists and the task benefits from its editor context. The Cursor UI launcher is not a headless worker.
- **No-model bridge verification:** deterministic commands and artifact checks. Use this before any reasoning reviewer.

Models and limits change. Discover current catalogs and quota windows; do not encode today's model names as permanent truth. A private local profile may express user preferences, but public defaults remain capability-based.

## Capacity Policy

- Plan over the next five hours only to decide what can run now and what resets soon. It is not a work deadline.
- Protect 15% of shared Codex capacity for integration, steering, and recovery. Capacity above the reserve should be used when useful work exists; the reserve is not an excuse for idle Codex capacity.
- When a broad goal has two or more genuinely independent ready lanes and healthy external capacity, dispatch at least one suitable lane unless the handoff would cost more than doing it directly. Never leave all independent capacity idle merely because the first Codex milestone is clear.
- If Codex capacity is unknown, keep current Codex productive and limit speculative Codex-worker dispatch to one lane.
- Apply the most restrictive capacity window that governs a model.
- Use recent workspace outcomes as a cooldown signal. Two consecutive transport failures make that provider ineligible for automatic routing until a different event or explicit user choice justifies retrying it.
- Treat a dedicated model window near reset as an opportunity only when a suitable high-value task exists. Never manufacture work to consume quota.
- Cool down a failed provider and allow one justified failover. Do not retry the same broken transport repeatedly.

## Reporting

Give the user short, scan-friendly, evidence-backed updates at meaningful transitions:

- `Done`: accepted changes or verified outcomes.
- `Active`: current Codex work and genuinely running worker lanes.
- `Blocked`: concrete blocker and owner.
- `Capacity`: only fresh relevant provider/model evidence.
- `Next`: work already started, or the precise condition that prevented it from starting. Do not present a known dependency-ready action as a future suggestion and then stop.

Worker dispatch, waiting, polling, retries, unchanged reviews, and a running supervisor are activity, not progress. Never present them as completed work.

When the user asks which resources are being used, report the runtime's provider decision and rejected alternatives. Do not imply that every installed provider should run: unused capacity is correct when its lane would duplicate work, fail, cost more, or add no value.

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

Load a reference only when its edge case is active: [capacity and routing](references/capacity-and-routing.md), [provider adapters](references/provider-adapters.md), or [context capsules](references/context-capsules.md).
