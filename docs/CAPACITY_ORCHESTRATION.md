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
3. Claude Code is preferred for substantial independent repository work when authenticated.
4. Explicitly authorized Antigravity CLI handles suitable read-only, research, browser-oriented, and inexpensive inspection lanes.
5. Cursor is considered only when `cursor-agent` is installed.
6. A separate Codex worker is last in automatic routing because it consumes the shared Codex plan.
7. Writers require explicit, non-overlapping `expectedFiles`; read-only mutations and outside-boundary writes fail closed.
8. The parent reads a worker once at its integration point and uses deterministic checks before any reasoning review.
9. One concrete failure may justify one provider-diverse retry. There is no retry chain.

Model names and plan limits are deliberately not hardcoded as permanent truth. The private local profile can express user preferences without publishing personal usage data.

## Finite Lifecycle

Each job has a finite state machine:

```text
queued -> running -> completed | failed | cancelled
```

Artifacts live at `.ai-mobile/jobs/<jobId>/`. They contain the bounded contract, append-only transitions, compact result, attributable changed files, bounded diff, deterministic verification, and available usage evidence. Existing `.antigravity-bridge/jobs` artifacts are read-only compatibility inputs.

There is no project manager, control room, heartbeat, schedule, repeated status poll, or continuous-cycle runtime. Long projects continue because the current Codex task advances verified dependency milestones, not because the plugin manufactures activity.

## Efficiency Standard

The plugin is useful only when all of these remain true:

- exactly six small MCP tools are exposed;
- startup opens no desktop application;
- trivial work starts no worker;
- inventory is cached and refreshed only after staleness or material failure;
- a worker receives a bounded task capsule, never the parent transcript;
- successful premium work is not sent to another premium model for reassurance;
- dispatch, waiting, polling, and retries are never reported as project progress;
- project completion remains a current-Codex judgment backed by end-to-end evidence.

See [the implementation report](IMPLEMENTATION_REPORT.md) for the migration rationale and falsifiable release gates.
