# AI Mobile 1.3.3 - workspace-grounded plans and visible restart continuation

AI Mobile 1.3.3 fixes the failure where a syntactically valid but invented work plan consumed multiple writers, then stopped without a visible useful result.

## Changes

- Validates proposed relevant files, expected-file parent directories, symlink resolution, and directly named verification scripts against the real project workspace before creating any writer node.
- Records invalid observations as `structured-work-plan-path-invalid`, returns the original graph node to pending, cools down that provider, and allows a different eligible provider to re-inspect.
- Treats an accepted observation-to-writer graph transition as real finite-cycle progress; worker activity alone still does not reset the no-progress limit.
- Uses a supported Codex last-turn route bounce after an explicitly authorized upgrade restart so the exact task reloads the completed continuation without a third model call.
- Keeps normal project execution headless: no automatic desktop launch, manager loop, heartbeat, Goal, automation, or repeated LLM polling is added.

## Verification

The release is gated by the complete 21-suite deterministic matrix, including a three-round regression that rejects an invalid Claude plan, dispatches a fresh Codex observation, runs only the valid writer, verifies the primary workspace, and proves the invented path never enters a writer contract.
