# AI Mobile 1.2.1 - bounded execution that finishes the worker cycle

AI Mobile 1.2.1 repairs the gap between assigning work and obtaining verified project progress.

The lightweight Codex console now invokes one bounded deterministic cycle. The cycle dispatches a dependency-ready unit, waits locally without repeated model turns, collects the terminal worker once, integrates verified patches, records acceptance evidence, and advances only when evidence or the recovery state materially changes.

Key fixes:

- Native Windows Claude Code executable selection, so structured JSON schema arguments are not corrupted by an npm command shim.
- Terminal-state reconciliation, so a worker that failed or finished cannot remain falsely reported as running.
- No unchanged failed-provider retry within the same cycle; automatic routing may use another eligible provider.
- Safe patch capture for newly created files from isolated Git worktrees.
- Completion ordering after integration, so a fully passing task cannot remain active because the round limit was reached.
- One-pass read-only artifacts, so successful inspections are not misclassified, repeated, or sent through redundant premium review.
- Real authenticated Claude subscription canary plus an end-to-end disposable-project cycle test.
- No desktop provider UI, LLM manager loop, Goal, heartbeat, automation, hidden continuation, or repeated model-turn polling.