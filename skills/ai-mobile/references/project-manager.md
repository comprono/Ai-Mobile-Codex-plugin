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
- The current Codex session owns merge decisions and works on a non-duplicated critical-path item while workers run.
- Do not add a paraphrasing meta-router. Pass the capsule and source artifacts directly; merge once.
- Launch later stages only after dependencies complete.
- Use `run-project-manager` for normal execution and `project-manager-status` for continuation. `project-manager-plan` is diagnostic only; never reconstruct provider commands from its JSON during a normal run.
- Mark completed or blocked current-Codex items through `project-manager-status`; completion requires a matching compact evidence entry so dependent CLI work advances from verified state.
- A worker that requires live/current runtime truth depends on the Codex live-control item and receives its evidence. Git status is not runtime evidence.
- When Codex replaces a failed or cancelled worker, use `takeoverCodexItems` before editing and then record completion evidence. Unrecorded fallback work is not part of the run.
- Record final verification as passed or failed. A failed live or acceptance gate remains an explicit blocker and forbids a completion claim.
- Keep externally consequential operations with the current Codex session even when external workers are healthier or cheaper.

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
| "The cached model list is probably current" | Use fresh catalog/quota evidence or preserve unknown |
| "The CLI failed once, so open every UI" | Classify the failure; use UI only for required visible state or unsupported CLI behavior |
| "Codex fixed it after the worker failed" | Record a Codex takeover and evidence before claiming the item complete |
| "The app watchdog is active, so AI Mobile is still managing" | Report the app watchdog and finite AI Mobile run as separate states |

## User Escalation

Stop and ask before irreversible changes, production actions, spending/billing changes, real submissions, destructive cleanup, or a choice whose ambiguity materially changes the result. When authorization is already explicit, the current Codex session performs the bounded operation and records its work-item outcome; it never delegates the external effect itself.
