# Project Manager Operating Procedure

## Lifecycle

| Stage | Required evidence | Exit gate |
| --- | --- | --- |
| Define | Outcome, constraints, risks, authorization | Ambiguity that changes implementation is resolved |
| Plan | Dependency graph, owner, model/effort, capsule, acceptance checks | Every action has bounded ownership |
| Execute | Dependency-ready work only | One writer; independent readers may fan out |
| Verify | Focused tests and objective-specific evidence | Failures are corrected or explicitly blocked |
| Review | Main Codex critiques and integrates once | Conflicting results are resolved by evidence |
| Ship | Final project-level verification | User-visible claim matches verified state |

## Orchestration Shape

- Keep depth at one. Workers do not create workers.
- Prefer direct execution for a single perspective.
- Fan out only distinct independent work with no ordering dependency or shared writer state.
- The current Codex chat owns goals, capacity decisions, steering, user-boundary decisions, compact evidence review, and reporting. In manager-only mode it does not inspect files, run project commands, edit source, or duplicate worker execution.
- Do not add a paraphrasing meta-router. Pass the capsule and source artifacts directly; merge once.
- Launch later stages only after dependencies complete.
- For a complex default graph, make implementation depend on discovery so the writer receives verified evidence and a narrow file boundary.
- Keep project duration continuous by default. Treat the five-hour horizon as a rolling capacity forecast, perform 20-minute resource checkpoints without interrupting running workers, and accelerate to five-minute checks near the protected Codex manager reserve.
- Protect manager runway before native Codex workers exhaust the shared pool. Default to one native worker, route unstarted work externally as reserve headroom shrinks, and let the durable supervisor continue external dependency stages without parent-chat tokens.
- Keep the low-RAM supervisor active only while external stages can advance autonomously. It uses no model tokens and exits when Codex action, verification, a blocker, replacement, or stop is required.
- Give individual provider calls complexity-adaptive safety leases from 10 to 90 minutes. A dead-call timeout may rescope/fail over the item once; it never terminates the overall objective.
- Use `run-project-manager` for normal execution and `project-manager-status` for continuation. `project-manager-plan` is diagnostic only; never reconstruct provider commands from its JSON during a normal run.
- Treat the initial run result as a dispatch receipt. Report exact assignments, then poll status in 20-second intervals until a meaningful transition or a two-minute activity heartbeat; every report names completed, active, failed/blocked, next action, and next check.
- For an explicitly continuous or 24/7 objective, use one same-task heartbeat automation when that Codex app capability exists. The heartbeat performs compact status/steering only; it does not replace the detached supervisor or duplicate project work.
- Mark completed or blocked current-Codex items through `project-manager-status`; completion requires a matching compact evidence entry so dependent CLI work advances from verified state.
- A worker that requires live/current runtime truth depends on the Codex live-control item and receives its evidence. Git status is not runtime evidence.
- Manager-only mode never replaces a failed worker by editing locally. Rescope or reassign the bounded item; `takeoverCodexItems` is available only when the user explicitly disables manager-only mode.
- Native Codex work must come from an exact `HostCodexAction`. First acknowledge its token-bound `reserved` event, then spawn only if the next status still exposes that exact action; acknowledge `started` with the returned agent id, then completion, failure, or cancellation through the same token-bound lifecycle. Never record native worker output as parent-chat `codexEvidence`.
- A changed goal or stop request with a running native Codex worker emits a host cancellation action. Refuse replacement until `multi_agent_v1__close_agent` is acknowledged or the stop is truthfully recorded as unconfirmed.
- Record final verification as passed or failed. A failed live or acceptance gate remains an explicit blocker and forbids a completion claim.
- On new user steering or withdrawn permission, interrupt running workers first, persist the new constraint, and replan. Never let stale workers finish against superseded instructions.
- Treat `ready-for-codex` as active and refuse a replacement run when an old worker process cannot be confirmed stopped.
- Do not dispatch an external writer without an explicit or evidence-inferred file boundary.
- If a writer boundary is missing, insert one read-only scope-discovery item with exact `BOUNDARY <writer-id>:` file output. Do not classify this as provider failure or spend the writer's bounded failover.
- Keep externally consequential operations with the current Codex session even when external workers are healthier or cheaper.
- Keep live session, login, account, cookie, profile, credential, OAuth, email/SMS, and CAPTCHA checks with the current Codex session. Bounded source review about those systems may still be delegated.

## Result Gate

Reject a result when it is empty, an acknowledgement, a model identity, generic advice, off-task, missing required evidence, or outside its file boundary. Exit code zero alone is insufficient.

When a result is close but incomplete, send one narrow correction. When failure is quota, outage, timeout, auth, unavailable model, or insufficient result, cool down that resource and fail over the item once. Do not restart the full plan.

## Anti-Rationalization

| Temptation | Required response |
| --- | --- |
| "The task is small, so no verification is needed" | Run the smallest relevant check |
| "The worker probably understood" | Require objective-specific output and evidence |
| "All workers finished, so the goal is done" | Integrate and run project-level verification |
| "More agents will be faster" | Fan out only genuinely independent work |
| "Every available model must be busy" | Use each appropriate resource only for distinct dependency-ready work; do not duplicate lanes |
| "The cached model list is probably current" | Use fresh catalog/quota evidence or preserve unknown |
| "The CLI failed once, so open every UI" | Classify the failure; use UI only for required visible state or unsupported CLI behavior |
| "Codex fixed it after the worker failed" | In collaborative mode only, record an explicit takeover and evidence; manager-only mode reschedules or blocks the item |
| "The app watchdog is active, so AI Mobile is still managing" | Report the app watchdog and AI Mobile's recorded objective/workers as separate states |
| "I acknowledged the new constraint" | Cancel stale workers and persist the constraint before replying |
| "One more external reviewer is safer" | Keep low-complexity review of direct operational evidence with Codex |
| "The five-hour horizon is nearly over" | It is a rolling forecast; refresh capacity and continue the objective |
| "Codex reset before I finished" | Resume the persisted run, inspect current external job state, and continue from the recorded dependency graph instead of replaying work |

## User Escalation

Stop and ask before irreversible changes, production actions, spending/billing changes, real submissions, destructive cleanup, or a choice whose ambiguity materially changes the result. When authorization is already explicit, the current Codex session performs the bounded operation and records its work-item outcome; it never delegates the external effect itself.
