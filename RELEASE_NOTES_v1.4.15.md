# AI Mobile 1.4.15

AI Mobile 1.4.15 repairs the in-supervisor recovery-budget transition exposed by the canonical Job Vibhu campaign.

- A newer budgeted read-only context, strategy, or reconciliation package can now supersede an exhausted accepted-plan allocation after the live plan is invalidated.
- The supervisor keeps every historical attempt and derives the new cumulative ceiling as prior exposure plus only the newly accepted recovery allocation.
- Recovery authority is rejected if it contains mutating permissions, a stale package/budget revision, a mismatched allocation, or a non-recovery executor.
- Explicit user hard ceilings, unchanged-retry refusal, external-write gates, cancellation, and duplicate-dispatch protections remain intact.
- A production-shaped regression reproduces accepted budget revision 31, exact attempt-cap equality, and recovery budget revision 34; the complete 43-gate deterministic release matrix passes.
