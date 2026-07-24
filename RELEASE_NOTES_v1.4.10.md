# AI Mobile 1.4.10

AI Mobile 1.4.10 prevents a repeated `@ai-mobile` intake from creating a second Director task for the same project workspace.

- `start-program` reuses the existing active Director-CFO task and preserves its mission, dossier, plan, budget, requirements, evidence, and failure history.
- A workspace-scoped durable lock prevents concurrent intake races.
- A paraphrased requested outcome cannot overwrite or stall the canonical mission; only an explicit `reconcile-task` call may replace it.
- Multiple active Director tasks fail closed instead of choosing or launching one silently.
- Regression coverage proves same-workspace reuse and explicit outcome reconciliation.
