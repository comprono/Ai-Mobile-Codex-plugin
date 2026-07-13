---
name: ai-mobile
description: For an explicit @ai-mobile request on nontrivial project work, call orchestrate-task before any project shell, file, browser, or runtime action. It creates one finite root-outcome contract, inventories current Codex, Claude Code, Antigravity, and optional Cursor capacity, keeps current Codex working, and starts at most two independent bounded workers without a manager loop or polling control room.
---

# AI Mobile

## Purpose

Use the AI resources already available on the machine as one efficient project team. Current Codex remains accountable for understanding the user, advancing the critical path, integrating evidence, making final judgments, and verifying the complete outcome. Other workers receive only independent bounded lanes whose expected value exceeds their handoff and integration cost.

AI Mobile is a finite execution aid. It is not a project manager chat, scheduler, heartbeat, status loop, or excuse for Codex to stop working.

## Mandatory First Action

When the user explicitly invokes `@ai-mobile` for nontrivial project work, the **first project-related tool call must be `orchestrate-task`**.

Before that call, do not:

- inspect project files, run project commands, open a browser, or change runtime state;
- call `resource-inventory` separately;
- search the filesystem, plugin cache, or memory for another AI Mobile skill;
- create a Codex Goal, task, automation, schedule, heartbeat, or manager run.

Build the call from the user request, current workspace, and already available context:

- `rootOutcome`: the complete measurable result the user actually wants;
- `completionEvidence`: end-to-end evidence required before claiming completion;
- `currentCodexGoal`: concrete critical-path work Codex starts immediately;
- `currentCodexFiles`: only the files Codex currently owns, when known;
- `candidateLanes`: one or two genuinely independent bounded worker options;
- each candidate includes a clear goal, independence reason, read boundary, task kind, complexity, and realistic direct-token estimate;
- writers also require exact `expectedFiles`; unknown write boundaries stay read-only.

If the file map is unknown, use a bounded read-only discovery candidate. `relevantFiles: ["."]` is allowed only for that discovery lane; keep current Codex on a distinct live-state, acceptance, or user-decision path until the result is collected. Never invent narrow paths merely to pass the schema.

The runtime inventories capacity, applies billing, reserve, model, reliability, overlap, and economic gates, and either starts useful workers or returns precise rejection reasons. One call replaces the former inventory-then-dispatch ritual.

## Execution Contract

After `orchestrate-task` returns:

1. Keep its `taskId`, job ids, root outcome, and completion evidence in working context.
2. Start the returned current-Codex lane immediately. Do not wait for workers and do not narrate orchestration.
3. Do not investigate a worker-owned question or touch its file boundary while that worker is active.
4. Collect each worker once with `read-job` at its natural integration point. Use `waitSeconds` up to 60 only when Codex has reached that point; the bridge waits locally without extra model turns.
5. Integrate useful evidence once. Run `verify-job` or direct deterministic checks before any reasoning review.
6. Reject, narrowly repair, or fail over one time when evidence is unusable. Never create a premium-model review chain.
7. Continue the next dependency-ready project work in the same task until all completion evidence is verified or a genuine blocker requires the user.

A worker completion, passing unit test, service restart, healthy process, milestone, plan, or running supervisor is not the root outcome. It cannot end the task unless it verifies every required completion-evidence item.

## Resource Judgment

Select resources from current evidence, not a fixed UI/backend/testing split.

- **Current Codex:** ambiguous reasoning, architecture, live-state control, critical-path implementation, integration, irreversible decisions, and final verification.
- **Codex CLI worker:** a high-value independent lane when shared Codex capacity remains above the configured reserve. It consumes the same Codex pool, so use it deliberately.
- **Claude Code:** bounded implementation, refactoring, architecture, debugging, and repository reasoning. Prefer a capable Sonnet-class model by default. Use premium model-specific capacity only when task difficulty and reset horizon justify it.
- **Antigravity CLI:** inexpensive repository scans, research, browser-oriented analysis, drafting, and validation. Automatic execution requires explicit authorization; read-only sandbox auto-approval never authorizes login, CAPTCHA, external effects, or undeclared paths.
- **Antigravity UI:** only when visible chat/project state, authentication, or a verified CLI limitation requires it.
- **Cursor:** only when a real headless `cursor-agent` is available and beneficial. A desktop launcher is not a worker.
- **No-model tools:** tests, linters, type checks, diffs, validators, and artifact inspection. Prefer these for verification.

Protect the configured Codex reserve, normally 15%, for integration and recovery. Capacity above it should remain productive when useful work exists. Plan against applicable five-hour and model-specific quota windows, but never treat the horizon as a project deadline. Unknown capacity remains unknown.

## Efficiency Rules

- Start zero to two workers after the mandatory call; the runtime may reject every candidate when direct work is cheaper or safer.
- One owner per question and file boundary. Parallel means different useful work.
- Never send the parent transcript. Workers receive the bounded contract only.
- Keep worker output caps small enough to integrate once.
- Do not repeatedly refresh capacity. Refresh only after a quota reset, provider failure, material model change, or 60 minutes of active work.
- Do not repeatedly call `read-job`. Continue Codex work and collect once.
- Do not spend a premium model re-evaluating successful premium work when deterministic checks establish correctness.
- Activity is not progress. Dispatches, polling, retries, and elapsed time are not deliverables.
- Do not use every provider merely because it exists. Idle capacity is correct when a lane would duplicate work, fail, cost more, or add no value.

## Reporting

Report only material transitions in a compact, evidence-backed shape:

- `Done`: accepted changes or verified outcomes;
- `Active`: concrete current-Codex work and genuinely running independent lanes;
- `Blocked`: exact blocker, evidence, and owner;
- `Capacity`: only fresh capacity facts relevant to the next decision;
- `Next`: work already started, or the precise condition preventing it.

Do not turn the conversation into a control-room feed. Do not announce routine tool calls, waiting, or unchanged status. Respect a private local address/style preference when present, but clarity and truth take priority.

## Safety And Ownership

- Preserve concurrent user and worker changes. Never revert unrelated work.
- Writers require explicit non-overlapping `expectedFiles` boundaries.
- Real submissions, sends, deploys, purchases, destructive operations, credentials, OAuth, login, CAPTCHA, email/SMS codes, and protected live state remain with current Codex and the user's applicable authorization.
- Antigravity permission auto-approval applies only to the declared sandboxed read-only CLI lane.
- Worker evidence must be integrated and verified by current Codex; it never authorizes a project-completion claim by itself.

## Tool Surface

Normal operation exposes six tools:

- `orchestrate-task`: mandatory finite first call; inventory plus bounded routing and dispatch;
- `read-job`: one compact result collection;
- `verify-job`: deterministic no-model verification;
- `cancel-job`: stop one worker process tree;
- `resource-inventory`: explicit diagnostic refresh only, not project startup;
- `orchestrator-profile`: private local routing and communication preferences.

If `orchestrate-task` is missing after an update, the current Codex task has stale plugin tools. Tell the user one Codex restart is required. Do not reconstruct provider commands, search caches, or restore the legacy manager loop.

Load a reference only when its edge case is active: [capacity and routing](references/capacity-and-routing.md), [provider adapters](references/provider-adapters.md), or [context capsules](references/context-capsules.md).
