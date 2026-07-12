# Capacity-Aware Resource Orchestration

AI Mobile treats Codex, Claude Code, Antigravity, and optional Cursor workers as one local delivery team. It does not assign work by a fixed UI/backend/testing split. It first inventories the resources that are actually available, then chooses a model for each bounded work item by capability, quality, capacity, reset timing, speed, reliability, and continuity.

## Evidence Model

The orchestrator preserves the source and freshness of every capacity fact:

| Resource | Models | Capacity and reset evidence | Dispatch |
| --- | --- | --- | --- |
| Codex | Host agent schema plus local Codex model catalog | Bounded local `token_count` capacity windows when fresh; caller-visible fallback | Separate native host agents; parent Codex control-room task remains manager-only |
| Claude Code | Installed aliases plus exact ids learned from CLI help or completed-run telemetry | Built-in `/usage` output, cached for 10 minutes | Headless CLI |
| Antigravity CLI | `agy models` | CLI roster plus recent outcomes | Headless CLI |
| Antigravity desktop | Full named model roster | Per-model remaining percentage and reset time while the local service is already running | UI only when visible project/chat state is required |
| Cursor | UI and `cursor-agent` detection | Unknown unless a real headless agent reports it | UI fallback or headless agent when installed |

Evidence is classified as measured, observed, cached, caller-provided, or unknown. Unknown values stay unknown.

## Codex Capacity And Effort

The local reader scans only bounded tails of recent Codex JSONL session files and accepts only `event_msg` rows whose payload type is `token_count`. It normalizes current five-hour, seven-day, and future window shapes, plus numeric session token totals. Prompts, responses, file paths, and thread identifiers are discarded. Because this is an undocumented local event shape, stale or incompatible data fails closed.

Host-native model ids and reasoning efforts come from the current spawn-agent schema when exposed, with the local model catalog as a passive fallback. The planner selects only an effort supported by that model. Maximum efforts are reserved for material criticality or risk; availability alone is not a reason to spend them. The parent control-room task never impersonates a selected Codex worker: it first records a token-bound reservation, exposes the exact spawn action while reserved, binds the returned agent id on `started`, and requires compact completion evidence.

Codex capacity windows currently apply to the shared Codex agent pool unless the observed source explicitly identifies a model-specific window. A private local allow pattern can restrict eligible catalog models without hardcoding those names into the public plugin.

Because native Codex workers consume that same shared pool, AI Mobile protects a configurable manager reserve (15% by default), penalizes native dispatch as headroom shrinks, and stops new native workers at the reserve. Default native concurrency is one. Claude and Antigravity CLI workers use independent capacity and can continue in parallel through the durable supervisor.

## Visible Progress And Scope Recovery

`run-project-manager` returns initial assignments without a long silent wait. The manager then makes one transition-aware `project-manager-status` call with `waitSeconds=120`; it returns early when recorded state changes. Runtime reporting emits a seven-field `CEOControlRoom` brief: `Objective`, `Changed`, `Team now`, `Capacity`, `Progress`, `Blocker/Decision`, and `Next`. The immutable root objective stays visible while progress separately identifies the numbered cycle. For a continuous objective, prefer one active Codex Goal in the same project task; the detached supervisor remains responsible for zero-token external progression.

Persistent control rooms use `completionPolicy=continuous-management`. `projectVerified` and `projectVerificationFailed` are rejected by the bridge. A finished batch is recorded with `cycleVerified` or `cycleVerificationFailed`, guarded by the exact latest `RunId` and `ActiveCycleId`; `nextWorkItems` starts the next bounded cycle under the same run id while compact prior evidence is archived. Delayed retries and stale plans fail closed. Thus a read-only health check or no-op review cannot complete or replace the root project Goal.

"Do not create another chat" is intentionally not part of the runtime contract. The precise rule is: do not create another user-facing Codex control-room task/thread. Native Codex subagents and headless Claude Code, Antigravity, and optional Cursor worker sessions/jobs remain allowed and expected behind that one task.

An external writer still requires a verified file boundary. If discovery does not return one, the run inserts one bounded read-only scope-discovery item with a machine-readable `BOUNDARY <writer-id>:` contract. This is a scoping correction, not a provider failure: it does not consume the writer's failover allowance, and the original writer resumes only after exact existing files are recorded.

## Claude Quota Windows

Claude `/usage` can expose several overlapping windows:

- a shared five-hour session window;
- a shared seven-day all-model window;
- zero or more model-specific seven-day windows, such as a Fable window.

A model's effective remaining capacity is the most restrictive applicable window. For example:

- Sonnet uses the shared five-hour and all-model weekly windows when no Sonnet-specific row is returned;
- Fable uses both shared windows and the Fable-specific weekly window when that row is returned;
- if a future account exposes a Sonnet, Opus, or other model-specific row, the same rule applies automatically.

The plugin reads percentages and reset timestamps. It does not infer a raw token allowance from percentages.
It also does not infer model quality from a separate quota bucket. Fable availability and its dedicated window are local runtime evidence; routing still applies a task-quality threshold and user preference.

## Routing Policy

The baseline family roles follow [Claude Code model configuration](https://code.claude.com/docs/en/model-config) and [cost guidance](https://code.claude.com/docs/en/costs); local alias ids and quota rows remain runtime evidence because they can change before public documentation does.

1. Apply a quality floor before considering cost or reset timing.
2. Apply the private local model allow/preference patterns before scoring; public defaults remain neutral.
3. Use efficient Antigravity Flash models for tightly bounded browser/file-reading, discovery, summaries, and low-risk checks when their capability and quota evidence fit.
4. Prefer Sonnet for substantial Claude implementation, architecture, debugging, and tests when its shared windows are healthy and the local profile permits it.
5. Reserve Opus/Fable for complex premium reasoning or a justified dedicated-capacity opportunity.
6. Penalize any resource below 15 percent effective remaining capacity and stop dispatching it when an applicable window is exhausted.
7. Permit at most two simultaneous writers only when their verified workspace-relative file or directory boundaries are pairwise disjoint. Serialize overlaps, wildcards, missing boundaries, and shared integration surfaces; honor the separate native Codex concurrency ceiling.
8. Record successful task affinity, failures, cooldowns, exact observed model ids, duration, and available token telemetry.
9. On quota, outage, timeout, auth, model-unavailable, or insufficient output, fail over the narrow work item once to a provider-diverse alternate.
10. Keep the parent Codex task on planning, assignment, steering, intervention, evidence review, user decisions, and reporting; project execution belongs to separate native or CLI workers.

Claude jobs feature-detect the installed CLI instead of relying on a fixed version. On Windows the bridge prefers Claude's native executable for exact argument transport, uses isolated non-persistent sessions, assigns bounded scout/reviewer/verifier/writer contracts, and accepts structured final evidence when supported. A small optional Claude plugin with the same roles lives under `claude-plugin/`; bridge safe mode uses explicit equivalent role instructions because safe mode suppresses plugin components.

Direct manual provider jobs default to 30 minutes. Orchestrated read-only calls receive shorter provider-aware leases (Antigravity 5-20 minutes; other providers 8-30 minutes), while writers retain complexity-adaptive 10-90 minute safety leases unless an explicit lower ceiling is supplied. Worker timeout/failover never limits the continuous project duration.

## Five-Hour Planning Horizon

The default horizon is five hours because it captures the immediate work period and Claude's short usage window. The planner compares:

- work-item dependency order;
- current effective remaining percentage;
- model-specific and shared reset times;
- recent platform success/failure evidence;
- whether a result is needed before or after a reset;
- whether waiting, using an alternate, or spending premium capacity gives the best expected outcome.

Provider snapshots are cached to avoid repeatedly calling local CLIs or the Antigravity language server. Codex local capacity is read from a recent event with a shorter freshness boundary. `refresh=true` or `-RefreshInventory true` forces a fresh provider probe when a quota change, outage, or reset makes the cache stale in practice.

The nominal capacity checkpoint is 20 minutes, reduced to five minutes when Codex reaches or approaches the manager reserve. It is an internal refresh deadline, not a recurring Codex task. External CLI jobs and their dependency state are durable under `.antigravity-bridge`, so they can continue without parent-task tokens; after a Codex reset, the same Goal/task calls `project-manager-status` and resumes the same run.

## Privacy Boundary

The machine cache stores model ids, safe software/version facts, quota percentages and reset times, and compact reliability telemetry. The project capsule stores bounded planning metadata and file fingerprints, not source contents. Neither stores prompts, chat transcripts, cookies, credentials, organization ids, email addresses, or active Antigravity chat titles.

## Inspect The Current Team

```powershell
powershell -ExecutionPolicy Bypass -File "$HOME\plugins\ai-mobile\scripts\antigravity.ps1" resource-inventory -Workspace "<path>" -HorizonHours 5
powershell -ExecutionPolicy Bypass -File "$HOME\plugins\ai-mobile\scripts\antigravity.ps1" codex-usage
powershell -ExecutionPolicy Bypass -File "$HOME\plugins\ai-mobile\scripts\antigravity.ps1" claude-usage
```

Use `-RefreshInventory true` only when a fresh software/model/quota probe is needed. Normal orchestration reuses the safe short-lived snapshot.
