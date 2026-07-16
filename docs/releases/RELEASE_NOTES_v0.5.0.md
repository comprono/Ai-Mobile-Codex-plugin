# AI Mobile v0.5.0 - Useful Parallelism, Not Duplicate Work

This release repairs a failure observed during a live project task: Claude completed an expensive diagnosis while Codex independently repeated the same investigation and had not collected the result.

## What changed

- Every external lane must prove that it is independent from current Codex work.
- Semantic overlap, file overlap, duplicate active jobs, and low-value handoffs are rejected before any model starts.
- Automatic routing scores task fit, measured capacity, subscription/PAYG mode, recent reliability, model policy, and integration cost instead of choosing Claude first.
- Claude subscription capacity now includes real five-hour, shared weekly, and Fable-specific windows from the built-in `/usage` command.
- Claude subscription work no longer displays or receives dollar caps; compact readback reports included-plan usage and token evidence.
- Claude workers use a minimal system prompt, only the local file tools needed by the lane, and a structured-output schema sized from the 1,200-2,000 token budget.
- Normal worker results are collected once before Codex takes over that lane. The bridge can wait locally for up to 60 seconds without repeated model-side polling.
- Authorized Antigravity read-only CLI work can use the user's private sandboxed permission preference without desktop popups. Writer, UI, authentication, and external-action authority are never implied.
- Transport, timeout, capacity, authentication, and authorization failures are typed. A confirmed transport, timeout, or authentication outage creates an immediate finite cooldown, preventing another automatic call to the broken route.

## Verified regressions

- A reproduced "Codex and Claude both find the same blocker" case now stays in current Codex and starts no worker.
- Disjoint architecture work routes to Claude Sonnet.
- Authorized repository scanning routes to Antigravity Flash when healthy, then falls back after repeated Antigravity failures.
- Repeated compact result reads do not replay worker output.
- Plugin startup and inventory open no desktop application.
