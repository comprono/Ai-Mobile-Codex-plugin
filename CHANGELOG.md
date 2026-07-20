# Changelog

## 1.3.7 - 2026-07-21

- Allows the authorized restart-handoff tool to prepare the exact-task upgrade boundary when the currently loaded AI Mobile runtime is stale.
- Keeps every ordinary orchestration tool fail-closed until the installed runtime has been loaded and verified.

## 1.3.6 - 2026-07-21

- Preserves process timeout truth across Codex, Claude, Antigravity, and Cursor adapters instead of misclassifying partial output as a generic provider failure.
- Gives bounded read-only planning workers finite complexity-aware budgets of 300, 420, or 600 seconds and permits one materially changed recovery route after a timeout.
- Prevents periodic reporters from spending tokens on unchanged terminal status; one terminal report is emitted and the same heartbeat is paused.
- Tightens work-plan prompts to use supplied resume context directly and return only the required structured artifact.

## 1.3.5 - 2026-07-19

- Preserves the exact blocked work-graph node through recovery planning so structured observations cannot be dispatched as orphan jobs.
- Refuses automatic work when no durable graph node owns it and records orphan observation rejection once instead of retrying invisibly.
- Adds a capped deterministic filename scan that gives planning workers likely implementation, fixture, runner, and focused-test paths while excluding provider worktrees, caches, logs, reports, backups, dependencies, and build output.
- Adds an explicitly requested unattended mode with one finite five-hour coordinator and an explicitly requested passive five-minute status heartbeat; neither behavior starts by default.
- Adds a regression for the real Job Vibhu failure shape: blocked acceptance, bounded path discovery, exact graph ownership, and stale Claude worktree exclusion.

## 1.3.4 - 2026-07-19

- Scopes provider cooldown and no-progress accounting to rounds created by the current execution, so a stale failed round cannot exclude a healthy provider or consume a fresh recovery budget.
- Tells structured planning workers the exact deterministic verifier policy before they propose work, including the ban on inline interpreter flags and required workspace paths.
- Treats headless Antigravity permission auto-denial as `authorization-required` even when the CLI exits zero, then cools that surface and allows another eligible provider to continue.
- Replaces ineffective post-continuation route bouncing with one finite package-owned OpenAI.Codex process reload inside the explicitly authorized plugin-upgrade handoff.
- Adds regressions for same-provider stale-round recovery in both execution paths, verifier-safe planning prompts, exit-zero Antigravity denial, and post-continuation desktop reload.

## 1.3.3 - 2026-07-19

- Rejects structured work plans before writer dispatch when source paths, write parents, or directly named verification files are not present in the real workspace.
- Returns rejected observation nodes to pending, cools down the failed provider, and permits one materially different provider to inspect the authoritative repository.
- Counts accepted work-graph and evidence transitions as progress while keeping activity-only rounds subject to the finite no-progress limit.
- Refreshes the exact Codex task after an explicit restart handoff through supported deep-link routes so the persisted continuation is reloaded without another model turn.
- Stabilizes detached Windows coordinator verification by waiting for the coordinator process to exit before fixture cleanup.
## 1.3.2 - 2026-07-19

- Persists the lightweight console model with the official Codex app-server thread settings method and foregrounds the exact task after continuation.
- Preserves child-written runtime and model proof, waits for a stable child exit, and trusts a matching structured success receipt.
- Requires exact JSON work plans from CLI providers that do not enforce an output schema natively.
- Counts no-progress only for rounds dispatched by the current coordinator execution, allowing bounded failover after stale failures.
- Adds regressions for visible model persistence, structured plan prompts, preserved restart state, and stale-round failover accounting.

## 1.3.1 - 2026-07-19

- Replaces visible-turn continuation slices with one finite detached event-driven coordinator that watches durable worker state, collects and integrates each result once, and stops on acceptance, typed decisions, deadlines, or no progress.
- Makes job, coordinator, and material-event state cross-process locked, revisioned, and monotonic so a late launcher write cannot resurrect terminal work; lost worker processes reconcile without waiting for their original deadline.
- Converts bounded read-only observations into fingerprinted exact writer units instead of returning general prose as progress.
- Adds dynamic provider capability surfaces, live-roster model validation, model tiers, authentication/billing separation, quota/reset-horizon routing, premium-model gates, active Codex use above reserve, and privacy-safe provider diagnostics.
- Adds passive material status reporting with no provider probe, project scan, heartbeat, or desktop launch.
- Makes isolated Codex CLI writers return path-bounded unified diffs; AI Mobile recounts, rejects unsafe symlink/submodule modes, applies, tests, and integrates them without bypassing the Windows sandbox.
- Completes accepted portfolio projects before redispatch so a finished project cannot starve another project's failover, and retries only bounded transient Windows worktree cleanup while preserving truthful failure evidence.
- Proves a real Codex and Claude portfolio completes two concurrent isolated projects with independent evidence, a protected Codex reserve, bounded storage, and zero desktop launches.
- Exposes material-status and provider-diagnostics through MCP and the shared PowerShell helper, and expands release CI with durable-event, capability, and patch-safety gates.
## 1.2.2 - 2026-07-19

- Reopens the exact OpenAI.Codex task immediately after plugin refresh, before any potentially long app-server verification or worker cycle.
- Adds a hard 20-minute continuation-process timeout that cleans only its own stale child tree while leaving the desktop visible.
- Records the real 1.2.1 failure mode where a synchronous verification turn left Codex closed and the restart helper indefinitely active.
- Keeps normal task execution UI-free, slices MCP waits below the host timeout, enables sandboxed noninteractive Codex worktree edits, and skips verification after no-patch workers.
- Prevents generated acceptance gaps from becoming root-wide editing lanes or inferred full-repository test runs without explicit file and verification boundaries.
## 1.2.1 - 2026-07-19

- Adds run-task-cycle as the default bounded execution path: dispatch, local wait, terminal collection, deterministic integration, evidence completion, and next-gap advance without repeated model turns.
- Fixes Windows Claude launch by preferring the native claude.exe over the npm command shim, preserving valid JSON schema arguments.
- Reconciles terminal worker state during task summaries so dead workers cannot remain falsely running until another user message.
- Prevents unchanged failed-provider retries within one cycle while allowing an automatic lane to fail over to another eligible provider.
- Captures safe Git patches for newly created files from isolated workers without staging or modifying the primary worktree.
- Adds real subscription canary proof and end-to-end cycle coverage through accepted project completion.
- Returns successful read-only artifacts once instead of misclassifying them as integration failures or repeating the same inspection.
## 1.2.0 - 2026-07-18

- Separates the visible Codex task into a lightweight zero-file project console and routes all project reading, reasoning, editing, and expensive verification to a separate work plane.
- Makes Codex CLI a normal capacity-aware worker above the configured shared Codex reserve.
- Adds coordinator-generated dependency-ready work units so Luna does not inspect repositories or invent worker contracts.
- Adds deterministic integrate-round patch application with boundary checks, concurrent-change protection, primary-workspace verification, rollback, idempotency, and acceptance-linked evidence.
- Adds standard project-test inference and read-only fallback when deterministic verification cannot be established.
- Adds a one-shot official Codex app-server continuation: Sol verifies the freshly loaded runtime first, then the same task switches to Luna-low, dispatches real work, and reopens only OpenAI.Codex.
- Adds console/work-plane, deterministic integration, unavailable-provider, restart-order, portfolio, lease, isolation, and token-economics regressions.
## 1.1.10 - 2026-07-18

- Uses Codex's app-native same-task follow-up surface for ordinary continuation instead of treating desktop restart or `codex exec resume` as orchestration.
- Defines future-proof lightweight-orchestrator, bulk-context, critical-reasoning, and deterministic-verification model roles; the current private lightweight preference resolves to GPT-5.6 Luna at low effort.
- Clarifies that the Windows restart helper only refreshes and reopens the exact Codex app/task and cannot itself prove a visible continued turn.
## 1.1.9 - 2026-07-18

- Removed the misleading Windows detached `codex exec resume` path: it created an independent CLI run and could not post a visible turn into the reopened Desktop task.
- Restart handoffs now reopen only the exact OpenAI.Codex app and task, then record `resume-awaiting-visible-turn` instead of consuming quota in an invisible session.
- Added regression coverage that forbids restoring detached CLI continuation behavior.
## 1.1.8 - 2026-07-18

- Replaced direct WindowsApps executable launch with supported shell:AppsFolder package activation followed by the exact Codex thread deep link.
- Keeps the exact OpenAI.Codex package, detached model-bound resume, and Classic ChatGPT exclusion; records the activation method and AppUserModelID in the handoff.
- Added regression coverage for the packaged-app activation path.

## 1.1.7 - 2026-07-18

- Reopens and verifies the exact `OpenAI.Codex` desktop package before starting the same-thread model continuation.
- Runs the model-bound continuation in a detached helper so a long Codex turn cannot block desktop reopening.
- Continues safely when Codex is already closed, records exact desktop and resume process evidence, and keeps Classic ChatGPT excluded.
- Writes restart state atomically as BOM-free JSON and adds a deterministic detached-resume integration test.
## 1.1.6 - 2026-07-18

- Replaced installer-capable `codex app` reopening with the exact installed `OpenAI.Codex` AppX executable and exact workspace/thread deep link.
- Added model-bound one-shot resume so an authorized handoff can continue the same thread on an exact model such as `gpt-5.6-luna`.
- Prevented Classic ChatGPT from being selected as a restart fallback.
- Made matching project acceptance contracts authoritative over duplicate stale request requirements and refresh the same durable task during summary, dispatch, and completion.
- Added explicit execution state so an active durable task is not misreported as active worker execution.
- Added regressions for exact-package restart, Luna resume, authoritative evidence refresh, same-task continuity, and unrelated-task isolation.

## 1.1.5 - 2026-07-18

- Refreshes the canonical AI Mobile plugin cache after Codex closes and before the exact thread resumes.
- Keeps older authorized handoffs compatible by defaulting their refresh target to `ai-mobile@ai-mobile`.
- Reports the refresh target in dry-run output and fails closed if refresh cannot complete.

## 1.1.4 - 2026-07-18

- Fixed one-shot restart launch failures when the plugin, workspace, or handoff path contains spaces.
- Added durable restart phases, process identifiers, concise error details, and a bounded transition log to every handoff.
- Made restart execution fail closed when the installed Codex desktop process cannot be identified exactly.
- Made workspace reopening path-safe and retained exact-thread, one-shot resume behavior.
- Added regression and harmless hidden-child launch coverage for the real spaced paths used on Windows.

## 1.1.3 - 2026-07-18

- Added exact Fable 5 and Sonnet 5 trusted-primary writing through a private standing policy, with clean Git ownership and mandatory deterministic verification.
- Removed redundant lower-tier model review for successfully verified trusted-primary work while preserving acceptance evidence gates.
- Made the repository a native local marketplace for both Codex and Claude Code, sharing one skill and MCP runtime.
- Added one-shot Codex restart-resume handoffs that preserve the exact thread, task, evidence, priorities, and next action without adding a manager loop.
- Added trusted-primary, shared-host installation, and restart dry-run regressions.
- Added owned-path rollback for failed trusted-primary changes without reverting unrelated concurrent edits.
- Made restart handoffs consumable only once and reopen the exact Codex workspace after headless resume.

## 1.1.2 - 2026-07-18

- Honored explicitly named user models such as Claude Fable during dispatch, reported callable worker job IDs, and exposed concrete provider rejection reasons.
- Allowed user-mandated disjoint external lanes through semantic goal overlap while retaining hard file-ownership conflicts.
- Added Fable and Codex CLI routing regression coverage.
- Fixed explicit user-mandated external lanes being rejected by semantic goal overlap when file ownership is disjoint; added Fable routing regression coverage.
## 1.1.1 - 2026-07-17

- Preserved blocker owner, recovery trigger, and recovery action when importing project acceptance contracts.
- Added a same-turn execution contract that prevents passive diagnosis from ending work while a safe dependency-ready action remains.
- Added explicit resource reports naming current Codex and every provider as selected, idle, or unavailable with model and reason.
- Made dispatch and collection return the current action already in progress instead of user-operated orchestration instructions.
- Hardened the AI Mobile skill so exact authorization is requested only when necessary while other safe work continues.
- Added a production-project-derived continuation regression covering executable blockers, direct Codex work, and Claude Sonnet routing evidence.

## 1.1.0 - 2026-07-17

- Added bounded project-context discovery from `.codex/PROJECT_OUTCOME.md`, `.codex/ACCEPTANCE.json`, and optional `.ai-mobile/project.json`.
- Prevented method-only contracts such as reviews or inspections from silently replacing a broader operational project outcome.
- Added `reconcile-task` so a latest user correction updates the same task, invalidates stale rounds and workers, and preserves only matching acceptance evidence.
- Added automatic acceptance work graphs and concrete current-Codex critical-path units when the request does not provide a plan.
- Prioritized an unresolved `current_slice_requirement_id` when the project contract identifies the active acceptance slice.
- Added typed recovery transitions for ownership, capacity, economics, dependency, and contract rejections.
- Made terminal collection return one-time integration actions and the next acceptance-linked current-Codex unit.
- Added direct core and stdio MCP end-to-end tests for outcome recovery and reconciliation.

## 1.0.0 - 2026-07-16

- Rebuilt AI Mobile around finite outcome tasks and observed execution rounds instead of manager-only control rooms, Goals, heartbeats, automations, or status polling.
- Kept current Codex active on the critical path while allowing at most two disjoint, economically positive Codex CLI, Claude Code, Antigravity CLI, or Cursor workers.
- Moved all runtime state to `%LOCALAPPDATA%\AI Mobile\v1`, with unique task ids, atomic task-scoped updates, and branch-independent concurrent task support.
- Added five-minute positive capacity freshness, 30-second negative freshness, quota-pool evidence, and mandatory cached-negative re-probing before dispatch rejection.
- Split startup from dispatch so Codex inspects the project before declaring file and question ownership.
- Added isolated Git worktrees for writer workers, compact stored patches, one-time collection, deterministic verification, and evidence-gated completion.
- Added finite multi-project portfolios with independent child outcomes, requirements, work graphs, priorities, blockers, patches, evidence, and completion.
- Added machine-wide provider and quota leases, global/per-provider limits, priority fairness, RAM checks, and cross-project file ownership.
- Added configurable worktree disk quota, minimum free space, maximum age, collection/cancellation cleanup, and crash/startup recovery.
- Protected the Codex reserve when measured and refused extra Codex workers when shared capacity is unknown.
- Removed Antigravity broad permission bypass and kept every provider desktop UI behind an explicit user decision.
- Added central-state, stale-capacity, economic, orchestration, writer-isolation, and portable MCP regression suites.

## Pre-1.0 History

Pre-1.0 experiments are retained in Git history and archived release notes under `docs/releases/`. They are not supported runtime contracts for v1.
