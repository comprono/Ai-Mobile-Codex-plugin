# AI Mobile 0.5.3 - progress before status

This release fixes a real project run where AI Mobile started correctly but Codex stopped after checking the runner and finding no eligible queue item.

## Fixed

- Completion evidence must now be positive observable proof. Blocker and eligibility alternatives belong in separate `blockingConditions`.
- The orchestration receipt explicitly forbids a final answer immediately after setup, status, restart, or an empty queue.
- A blocker can end the turn only when it is external or user-only and no dependency-ready local improvement remains.
- Unknown Antigravity quota remains unknown instead of being displayed as `0%`.
- A saved private read-only Antigravity authorization is honored without repeated prompts; explicit denial still wins.

The plugin remains finite and token-aware. It does not restore manager loops, heartbeats, polling, or mandatory use of uneconomic workers.
