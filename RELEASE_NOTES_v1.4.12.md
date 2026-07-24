# AI Mobile 1.4.12

AI Mobile 1.4.12 fixes the unattended recovery boundary exposed by the real Job Vibhu campaign.

- A running program no longer exits merely because `noProgressLimit` is reached when that same boundary has already created exactly one eligible read-only reconciliation package.
- The recovery is admitted inside the existing `run-program-campaign` invocation; another user message or campaign call is not required.
- The grant is limited to one worker, one attempt, and no external writes, and is keyed to the immutable failure fingerprint so it cannot replay unchanged.
- Recovery preserves the original overall-horizon start and deadline.
- Cancellation, hard ceilings, ambiguous external writes, user-owned decisions, resource accounting, and unchanged-retry stops remain fail-closed.
- The production-derived regression proves two finite slices in one invocation, one recovery epoch, one admission record, no deadline extension, and no duplicate recovery.
