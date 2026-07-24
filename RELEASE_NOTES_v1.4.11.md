# AI Mobile 1.4.11

AI Mobile 1.4.11 is the immutable final build of the workspace-level Director deduplication fix.

- Repeated intake reuses the canonical active Director task, even when request wording is paraphrased.
- Workspace locking prevents simultaneous intake races.
- Multiple active Director programs fail closed.
- The only duplicate-creation bypass is regression-only and cannot be enabled through normal plugin arguments.
- Codex and Claude installations must match the same 124-file runtime fingerprint.
