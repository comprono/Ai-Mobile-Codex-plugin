# AI Mobile 1.1.5 - atomic plugin refresh and resume

AI Mobile 1.1.5 completes the restart boundary introduced in 1.1.4.

- Closes only the verified Codex desktop package.
- Refreshes `ai-mobile@ai-mobile` while the live cache lock is released.
- Resumes the exact thread only after the refresh succeeds.
- Reopens the exact workspace after success or failure.
- Preserves durable phase, process, transition, and error evidence.

Older unconsumed AI Mobile restart handoffs automatically use the canonical refresh target.
