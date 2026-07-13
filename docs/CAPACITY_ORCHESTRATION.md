# Capacity-Aware Resource Orchestration

AI Mobile is a thin execution layer for the current Codex task. Codex keeps the project outcome, critical path, integration, verification, and user conversation. The plugin discovers usable local CLIs, delegates only independent bounded work with positive expected value, and returns compact evidence.

## Evidence Contract

Every provider record includes availability, authentication mode, source, freshness, and confidence. Exact quota or reset values are reported only when a supported local interface exposes them. Unknown remains unknown; the plugin never converts a subscription into an invented dollar balance.

| Provider | Passive evidence | Normal execution |
| --- | --- | --- |
| Codex | Native CLI version and ChatGPT login status | Current Codex by default; one bounded CLI worker only when shared reserve permits |
| Claude Code | Native executable, version, and auth status | Noninteractive bounded CLI job using the existing subscription unless an API key is explicitly configured |
| Antigravity | `agy` version and CLI availability | Sandboxed `default-cli-project` plus the declared workspace; named project id only when supplied |
| Cursor | Real `cursor-agent` detection | Unavailable unless the headless agent actually exists |

Discovery is passive. It does not open, close, restart, or repair desktop applications. UI is a typed blocker for the current Codex task to handle only when visible state or authentication is genuinely required.

## Routing Contract

1. Current Codex keeps tightly coupled, ambiguous, sensitive, and critical-path work.
2. Small work stays direct because dispatch and review would cost more than execution.
3. Delegation requires the exact current-Codex lane, worker lane, independence reason, and non-overlapping path ownership. Semantic or path overlap stays direct.
4. Automatic routing scores task fit, capacity, billing mode, bounded output cost, recent workspace reliability, and local model policy. There is no Claude-first order.
5. Claude Code normally handles substantial independent code and architecture lanes; Sonnet is the non-premium default.
6. Explicitly authorized Antigravity CLI normally handles suitable read-only scans, research, browser-oriented analysis, and inexpensive inspection. Repeated failures trigger cooldown.
7. Cursor is considered only when `cursor-agent` is installed. A separate Codex worker consumes the shared Codex plan and must remain above the reserve.
8. Writers require explicit, non-overlapping `expectedFiles`; read-only providers receive restrictive tool and permission policies.
9. The parent reads a worker once at its integration point and integrates it before redoing that lane. One read may wait locally for up to 60 seconds, avoiding repeated model-side polling. Deterministic checks precede any reasoning review.
10. One concrete failure may justify one provider-diverse retry. There is no retry chain.

Model names and plan limits are deliberately not hardcoded as permanent truth. The private local profile can express user preferences without publishing personal usage data.

## Finite Lifecycle

Each job has a finite state machine:

```text
queued -> starting -> running -> completed | failed | cancelled
```

Artifacts live at `.ai-mobile/jobs/<jobId>/`. They contain the bounded contract, append-only transitions, compact result, attributable changed files, bounded diff, deterministic verification, and available usage evidence. Existing `.antigravity-bridge/jobs` artifacts are read-only compatibility inputs.

There is no project manager, control room, heartbeat, schedule, repeated status poll, or continuous-cycle runtime. Long projects continue because the current Codex task advances verified dependency milestones, not because the plugin manufactures activity.

## Efficiency Standard

The plugin is useful only when all of these remain true:

- exactly six small MCP tools are exposed;
- startup opens no desktop application;
- trivial work starts no worker;
- inventory is cached for up to one active hour and refreshed earlier after a known reset or material provider failure;
- a worker receives a bounded task capsule, never the parent transcript;
- duplicate semantic lanes, overlapping paths, and duplicate active jobs are rejected before model use;
- ordinary worker output is capped at 1,200-2,000 tokens and terminal usage is visible in compact readback;
- every completed worker result is collected once and integrated before Codex takes over its lane;
- successful premium work is not sent to another premium model for reassurance;
- dispatch, waiting, polling, and retries are never reported as project progress;
- project completion remains a current-Codex judgment backed by end-to-end evidence.

See [the implementation report](IMPLEMENTATION_REPORT.md) for the migration rationale and falsifiable release gates.
