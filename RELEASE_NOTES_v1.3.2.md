# AI Mobile 1.3.2 - visible restart continuity and resilient provider failover

AI Mobile 1.3.2 repairs the real restart and production orchestration failures observed with 1.3.1.

## Changes

- Persists the requested lightweight model and effort through Codex app-server `thread/settings/update` before the continuation turn.
- Preserves successful child-process runtime and model proof instead of overwriting it with stale launcher state.
- Treats the structured app-server success receipt as authoritative after the child exits, then foregrounds the exact Codex task so the new turn is visible.
- Requires CLI workers without native schema enforcement to return one exact JSON work-plan object with bounded paths and structured verification commands.
- Prevents failed rounds from earlier executions from consuming a fresh coordinator's no-progress budget.
- Keeps provider failover finite: stale failures are collected and cooled down, while materially different eligible providers can still take the dependency-ready unit.

## Compatibility
Normal project execution remains headless and does not restart Codex or open provider UIs. Restart behavior runs only after an explicitly authorized plugin upgrade.
