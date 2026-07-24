# AI Mobile 1.4.14

AI Mobile 1.4.14 repairs the post-restart continuation boundary exposed during the 1.4.13 activation.

- The capable setup-model turn remains the sole owner of the mandatory `resource-inventory` runtime proof.
- A restart handoff now rejects any continuation action that asks the lightweight console to repeat `resource-inventory`.
- The generated continuation prompt explicitly records that runtime proof already succeeded and prohibits a second inventory call.
- A production-shaped regression covers the duplicated-inventory failure while preserving exact version and fingerprint verification, one campaign call, same-task continuity, and fail-closed tool authorization.
