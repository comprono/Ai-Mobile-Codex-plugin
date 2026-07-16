# Context Capsules

Send a worker only the minimum immutable contract:

- complete `rootOutcome` / `projectGoal` in one concise statement;
- portfolio and project identifiers when the unit belongs to a multi-project request;
- end-to-end `completionEvidence` that worker completion cannot satisfy by itself;
- the exact `currentCodexGoal` and `currentCodexFiles` that remain owned by Codex;
- one bounded `goal` independent of current Codex work;
- one concrete `independenceReason` plus `relevantFiles` for overlap detection;
- relevant acceptance criteria;
- workspace and explicit writer boundaries;
- deterministic verification commands;
- one useful next integration step.

Never send the parent transcript, repeated status history, unrelated files, private credentials, cookies, quota screenshots, or speculative project narrative. The worker must not start another agent or broaden its own scope.

The runtime rejects semantic overlap, path overlap, global lease conflicts, and duplicate active ownership before dispatch. The result should contain only the achieved outcome, changed files, checks, and one concrete blocker. Read `detail=compact` once at integration, using a bounded `waitSeconds` only when useful, and use the result before taking over the worker lane. Use `detail=full` only to integrate a patch or diagnose a real failure.
