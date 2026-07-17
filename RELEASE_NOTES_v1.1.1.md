# AI Mobile 1.1.1 - same-turn execution and transparent resource routing

AI Mobile 1.1.1 fixes a field failure where the plugin diagnosed an existing blocker, listed available models, and then handed the next safe action back to the user instead of continuing the project.

## Changes

- Project acceptance blockers retain their owner, recovery trigger, and executable recovery action.
- Current Codex receives a binding same-turn execution contract and may not stop while an authorized dependency-ready action remains.
- Every provider is reported as selected, idle, or unavailable with the selected model and concrete routing reason.
- Dispatch and collection report the action already starting instead of user-operated next-step instructions.
- Exact authorization is requested only for genuinely protected actions while other safe work continues.
- A production-project-derived regression proves blocker recovery, current-Codex continuation, and Claude Sonnet routing evidence.

This release keeps finite rounds and evidence-gated completion. It does not add manager loops, background heartbeats, repeated polling, automatic desktop launches, or activity-based progress.
