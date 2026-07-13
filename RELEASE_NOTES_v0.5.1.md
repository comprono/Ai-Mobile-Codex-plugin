# AI Mobile v0.5.1 - finite orchestration that starts real work

Version 0.5.1 fixes a real-task failure in which Codex could inspect a project, call only the resource inventory, and never delegate useful work.

## Changes

- Adds `orchestrate-task` as the single finite first call for an explicit AI Mobile project request.
- Preserves the complete root outcome and required end-to-end evidence before any worker starts.
- Keeps current Codex on a concrete critical-path lane while routing up to two independent bounded workers.
- Combines capacity inventory, provider selection, economic checks, overlap checks, and dispatch in one compact call.
- Prevents the same root-outcome lane from being dispatched twice.
- Makes worker completion explicitly insufficient for project completion.
- Removes the old separate `run-efficient-task` helper path.
- Adds deterministic zero-model regression coverage for the prior failure pattern.

No desktop application starts during plugin startup or passive capacity discovery. The legacy manager, control-room, heartbeat, automation, and polling runtime remains removed.
