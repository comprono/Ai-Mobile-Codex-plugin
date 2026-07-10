# Capacity-Aware Resource Orchestration

AI Mobile treats Codex, Claude Code, Antigravity, and optional Cursor workers as one local delivery team. It does not assign work by a fixed UI/backend/testing split. It first inventories the resources that are actually available, then chooses a model for each bounded work item by capability, quality, capacity, reset timing, speed, reliability, and continuity.

## Evidence Model

The orchestrator preserves the source and freshness of every capacity fact:

| Resource | Models | Capacity and reset evidence | Dispatch |
| --- | --- | --- | --- |
| Codex | Host agent schema plus local Codex model catalog | Bounded local `token_count` capacity windows when fresh; caller-visible fallback | Native host agent tool; current Codex remains PM, active integrator, and verifier |
| Claude Code | Installed aliases plus exact ids learned from CLI help or completed-run telemetry | Built-in `/usage` output, cached for 10 minutes | Headless CLI |
| Antigravity CLI | `agy models` | CLI roster plus recent outcomes | Headless CLI |
| Antigravity desktop | Full named model roster | Per-model remaining percentage and reset time while the local service is already running | UI only when visible project/chat state is required |
| Cursor | UI and `cursor-agent` detection | Unknown unless a real headless agent reports it | UI fallback or headless agent when installed |

Evidence is classified as measured, observed, cached, caller-provided, or unknown. Unknown values stay unknown.

## Codex Capacity And Effort

The local reader scans only bounded tails of recent Codex JSONL session files and accepts only `event_msg` rows whose payload type is `token_count`. It normalizes current five-hour, seven-day, and future window shapes, plus numeric session token totals. Prompts, responses, file paths, and thread identifiers are discarded. Because this is an undocumented local event shape, stale or incompatible data fails closed.

Host-native model ids and reasoning efforts come from the current spawn-agent schema when exposed, with the local model catalog as a passive fallback. The planner selects only an effort supported by that model. Maximum efforts are reserved for material criticality or risk; availability alone is not a reason to spend them.

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
2. Use Haiku or efficient Antigravity Flash models for tightly bounded discovery, summaries, and low-risk checks.
3. Prefer Sonnet for substantial implementation, architecture, debugging, and tests when its shared windows are healthy.
4. Reserve Opus for complex premium reasoning. Use Fable only when explicitly requested or when its dedicated window creates a high-value capacity opportunity.
5. Treat healthy dedicated Fable capacity that resets inside the planning horizon as an opportunity only for high-value work. A reset is not a reason to waste premium capacity on routine work.
6. Penalize any resource below 15 percent effective remaining capacity and stop dispatching it when an applicable window is exhausted.
7. Keep one workspace writer. Parallelize only independent read-only work.
8. Record successful task affinity, failures, cooldowns, exact observed model ids, duration, and available token telemetry.
9. On quota, outage, timeout, auth, model-unavailable, or insufficient output, fail over the narrow work item once to a provider-diverse alternate.
10. Return all worker results to Codex for critique, integration, and final verification.

## Five-Hour Planning Horizon

The default horizon is five hours because it captures the immediate work period and Claude's short usage window. The planner compares:

- work-item dependency order;
- current effective remaining percentage;
- model-specific and shared reset times;
- recent platform success/failure evidence;
- whether a result is needed before or after a reset;
- whether waiting, using an alternate, or spending premium capacity gives the best expected outcome.

Provider snapshots are cached to avoid repeatedly calling local CLIs or the Antigravity language server. Codex local capacity is read from a recent event with a shorter freshness boundary. `refresh=true` or `-RefreshInventory true` forces a fresh provider probe when a quota change, outage, or reset makes the cache stale in practice.

## Privacy Boundary

The machine cache stores model ids, safe software/version facts, quota percentages and reset times, and compact reliability telemetry. The project capsule stores bounded planning metadata and file fingerprints, not source contents. Neither stores prompts, chat transcripts, cookies, credentials, organization ids, email addresses, or active Antigravity chat titles.

## Inspect The Current Team

```powershell
powershell -ExecutionPolicy Bypass -File "$HOME\plugins\ai-mobile\scripts\antigravity.ps1" resource-inventory -Workspace "<path>" -HorizonHours 5
powershell -ExecutionPolicy Bypass -File "$HOME\plugins\ai-mobile\scripts\antigravity.ps1" codex-usage
powershell -ExecutionPolicy Bypass -File "$HOME\plugins\ai-mobile\scripts\antigravity.ps1" claude-usage
```

Use `-RefreshInventory true` only when a fresh software/model/quota probe is needed. Normal orchestration reuses the safe short-lived snapshot.
