# AI Mobile 1.4.13

AI Mobile 1.4.13 repairs three production failures exposed while correcting and verifying the public portfolio-product contract.

- A coordinator that is waiting on a worker now handles an authoritative contract revision as a bounded supersession transition. It discards the invalidated round, records the transition, and continues from the revised mission instead of terminating the supervisor with `coordinator-failed`.
- An explicitly authorized, user-declared read-only file may be outside the project root. AI Mobile copies the exact regular file into the context worker's immutable snapshot, rebases the worker contract to that bounded copy, and withholds the original path.
- External source capture remains fail-closed for symlinks, directories, implicit discovery, metadata-only access, and descriptors without explicit user authority.
- A campaign-supervisor execution can admit at most one protected read-only recovery epoch. The durable execution fence remains stable while finite slices rotate their own execution IDs, so a different downstream failure fingerprint cannot start a recovery chain in the same invocation.
- Provider-facing contracts now state the non-negotiable shapes that live workers previously violated: reconciliation plan changes are non-empty objects, guarded transactions carry explicit pre/postconditions, and one code package may cover at most two unresolved acceptance requirements.
- The live-state gate distinguishes authoritative runtime/contract renewals from recovery admissions and rejects both unaccounted epochs and a skipped eligible stopped recovery.
- Generic projects no longer need to invent a database source. The gate verifies declared database receipts when present, forbids fabricated receipts when absent, and recognizes an unavailable external-write boundary only when every remaining package has exact acceptance ownership and a budgeted permission deferral.
- Read-only verification and reconciliation workers now receive immutable copies of only their explicitly granted, workspace-contained regular files. Path escapes, symlinks, missing `read-files` authority, excessive file counts, quota violations, and source mutation still fail closed.
- Disposable-canary policy keeps code writers in normal isolated Git worktrees and reserves direct cloned-project execution for bounded local operational transactions. The live cloned-state gate itself executes authenticated read-only workers only, then captures the first mutation contract before launch to avoid unnecessary provider use. Canary success requires integration of the exact fenced work package, not merely a completed worker process.
- A truthful verification failure can form a successful continuation boundary only when the worker read hashed snapshot sources and the runtime schedules an acceptance-linked, fingerprinted reconciliation package.
- Successful Git-worktree cleanup now removes empty per-task parent directories as well as the worktree and metadata, leaving no disposable worker residue.
- Dedicated regressions cover all three production failure shapes, including two distinct sequential recovery failures with exactly one admitted epoch.
