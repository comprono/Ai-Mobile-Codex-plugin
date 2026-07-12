# Changelog

## 0.2.6 - 2026-07-13

- Changed the Codex reserve from a conservative one-worker default into a 15% floor with up to three concurrent Codex workers, scaled down only as measured headroom approaches the reserve.
- Required `hostCodexAvailable=true` whenever any native `spawn_agent` tool is callable, including the current `collaboration` namespace, so a writable native Codex lane is not silently discarded.
- Raised pairwise-disjoint writer concurrency to three and strengthened the manager contract: large tasks must create enough independent bounded lanes to use healthy Codex capacity instead of leaving it idle.
- Prevented an internal routing note from terminating a run: `steeringDirective` now interrupts only with explicit `interruptRunningWorkers=true`, an actual stop, or newly added safety constraints.

## 0.2.5 - 2026-07-13

- Enforced every explicitly requested `BOUNDARY <work-item-id>:` scope contract before releasing dependent writers, even when those writers already declare expected files, and preserved boundary lines during compact result readback.
- Isolated standalone Codex CLI workers from parent Codex task permission and thread variables, detected effective `workspace-write` rejection as a transport capability failure, and routed later writers to host-native Codex or another provider until the CLI version changes or the retry window expires.
- Added explicit Antigravity `plan` and `accept-edits` execution modes while retaining sandboxed permission auto-approval for authorized unattended runs, reducing repeated tool-permission dialogs without bypassing authentication or external-action gates.

## 0.2.4 - 2026-07-13

- Allowed an invalid continuous cycle with no active worker to fail atomically, archive its malformed evidence, and accept a corrected next-cycle graph under the same run id.
- Kept the repair fail-closed when any provider or host worker is actually running, reserved, or awaiting confirmed cancellation.

## 0.2.3 - 2026-07-13

- Prevented automatic live-operation dependency injection from creating transitive cycles in multi-stage correction and release graphs.
- Expanded work-graph integrity checks to report duplicate ids, missing dependencies, self-dependencies, and dependency cycles instead of showing an idle run as useful progress.

## 0.2.2 - 2026-07-13

- Added a durable `bridge:verification` worker for command-complete read-only verification, so exact structured checks run without invoking Codex, Claude, Antigravity, or Cursor.
- Kept qualitative diagnosis, architecture, critique, comparison, and recommendation work on reasoning models instead of over-applying the zero-model route.
- Added bridge lifecycle, zero-token telemetry, workspace-mutation detection, capacity-checkpoint persistence, compact CEO status, and regression coverage for the new lane.

## 0.2.1 - 2026-07-13

- Added a durable standalone Codex CLI provider that passively discovers the official client, requires ChatGPT-plan authentication, selects current catalog models/efforts, uses isolated JSONL stdin execution, and records measured usage without creating another Codex task.
- Unified standalone and host-native Codex workers under the same measured capacity, manager reserve, model policy, cooldown history, and concurrency ceiling; only one transport is represented for each model.
- Added structured `verificationCommands` and bridge-owned `verification-evidence.json`. Requested checks now run as allowlisted argument arrays outside the model and record exit code, timeout, bounded output, and workspace mutation; writer lanes also receive a scoped `git diff --check`.
- Added fake-executable lifecycle coverage for the Codex worker so CI proves discovery, authentication, routing, artifacts, telemetry, and deterministic verification without spending model quota.
- Added `codex-cli-status` and `submit-codex-job` to the PowerShell and advanced MCP surfaces while preserving the ten-tool default manager surface.
- Added no-model `verify-job` to execute structured checks against an existing terminal job and idempotently upgrade older worker-reported test claims to bridge-owned evidence.

## 0.2.0 - 2026-07-13

- Replaced user-specific MCP paths with installation-relative entrypoints that work from the actual plugin directory.
- Added a clean-copy MCP reliability test that initializes the local server from a temporary path containing spaces.
- Added Windows CI for the portable MCP smoke test and the complete lifecycle suite.
- Made manager status include every current-cycle worker result instead of only the newest completed worker.
- Added an explicit `awaiting-acceptance` cycle display state and prevented already-prefixed cycle ids from becoming `c5-c5-*`.

## 0.1.9 - 2026-07-12

- Persisted each external worker's read-only role and adaptive lease in durable orchestration state.
- Added the active bridge step and elapsed/maximum lease to CEO control-room worker reporting so healthy work and stalls are distinguishable without opening provider UIs.
- Clarified that an explicit continuous-management request creates or resumes one host Goal and must not create duplicate Codex tasks, Goals, runs, or automations.

## 0.1.8 - 2026-07-12

- Fixed PowerShell `project-manager-status` serialization to preserve nested next-cycle arrays such as `dependsOn`, `expectedFiles`, acceptance criteria, and verification checks instead of silently flattening the dependency graph.
- Enforced machine-readable boundary-discovery output before a scope worker can succeed, so missing `BOUNDARY <work-item-id>:` lines fail over rather than leaving a writer blocked after false discovery success.
- Added persisted PowerShell regression coverage proving next-cycle dependency ordering survives the public helper path.

## 0.1.7 - 2026-07-12

- Shortened orchestrated read-only worker leases by provider and complexity so silent Antigravity discovery fails over in 5-20 minutes and other read-only lanes in 8-30 minutes, while bounded writer leases and continuous project duration remain unchanged.
- Added regression coverage proving explicit worker ceilings still win and writer leases retain their longer complexity budget.
- Made writer completion fail closed when a provider reports `BLOCKED`/`no code changed` or produces no attributable file changes, preventing no-op implementation from releasing dependent verification.
- Made dependency-derived writer boundaries require the exact machine-readable `BOUNDARY <work-item-id>:` marker, so incidental diagnostic/generated-file paths cannot authorize the wrong edit surface.

## 0.1.6 - 2026-07-12

- Added an immutable `RootGoal` and explicit `finite` versus `continuous-management` completion policy so "manage as CEO" cannot shrink the project objective into a monitoring task.
- Added a runtime completion firewall: continuous control rooms reject `projectVerified`/`projectVerificationFailed`, never return root completion permission, and cannot cause `update_goal complete` from a small review cycle.
- Added numbered delivery cycles with `cycleVerified`, `cycleVerificationFailed`, and `nextWorkItems`, allowing corrections and further work under the same durable run id instead of replacement runs.
- Added run-and-cycle identity guards so delayed status retries or capacity-planning races cannot mutate a newer cycle or another root run.
- Made cycle results immutable and archived bounded work-item/job evidence before advancing, while failed cycles remain active checkpoints instead of terminal root runs.
- Added cycle-state revision checks, idempotent full Codex-result retries, a same-run malformed-cycle repair route, and a persisted two-cycle PowerShell regression test.
- Protected active continuous runs from rephrased-goal or contract replacement and made the seven-field CEO brief display the exact root objective and separate root/cycle progress.
- Stopped skill self-discovery and stale memory-workflow substitution, reserved steering for actual user changes, and required persistent managers to keep the Codex Goal active until explicit user stop.

## 0.1.5 - 2026-07-12

- Replaced the ambiguous "do not create another chat" rule with an explicit single Codex control-room task contract; native Codex subagents and headless Claude, Antigravity, and Cursor worker sessions/jobs remain allowed and expected.
- Added a bounded six-field `CEOControlRoom` status brief with changed state, active owners/models/elapsed time, per-platform capacity and reset evidence, progress, blocker or decision, and the next management intervention.
- Strengthened the manager skill from passive polling into active CEO behavior: maintain workstreams and owners, intervene on stalls/failures/quota transitions, reconsider underused eligible resources, and accept evidence before final verification.
- Added the short default trigger `@ai-mobile Manage this project as my CEO control room.` and aligned runtime schemas, README, Pages, and operating references with the same semantics.

## 0.1.4 - 2026-07-12

- Fixed defensive work-item normalization so `title`, `description`, and `class` aliases preserve the intended objective and analysis/code/integration execution class instead of collapsing work into generic read-only Flash tasks.
- Added work-graph integrity detection so runs that already persisted lost placeholder objectives are safely replanned instead of resumed after upgrade.
- Clarified that manager-only applies only to the parent control-room chat; separate native Codex workers remain executable and can run alongside Claude and Antigravity when current capacity and dependencies permit.
- Added bounded parallel writers with pairwise-disjoint verified file or directory ownership, a default concurrency of two, and serialization for overlaps, wildcards, or missing boundaries.
- Added an explicit unattended Antigravity policy: interactive lanes are excluded unless sandboxed permission auto-approval is authorized, and auto-approval never extends to OAuth, login, CAPTCHA, destructive actions, external effects, or undeclared paths.
- Replaced repeated 20-second manager polling with one 120-second transition-aware wait that returns early on state change, plus profile-aware `Changed`, `Team now`, `Progress`, `Blocker`, and `Next` reporting.
- Recovered corrupt worker status fail-closed from live process identity or finalized telemetry, returned the last verified snapshot on a transition-wait manifest race, centralized writer-boundary comparison, and prioritized native Codex reservations by work-item priority.
- Added a complexity-sized hard Claude tool-operation budget so bounded workers stop with a concise blocker instead of consuming many exploratory turns.

## 0.1.3 - 2026-07-12

- Retried transient Windows `EPERM`, `EACCES`, and `EBUSY` lock-acquisition collisions so overlapping supervisor and manager-status checks do not fail while preserving exclusive state updates.
- Replaced automatic heartbeat guidance with Goal-first continuity in one project task; capacity checkpoints remain local routing state, and automations now require a separate explicit timed-report request.
- Reduced the default MCP discovery surface from 49 low-level tools to ten manager/setup tools while retaining every advanced bridge command through the CLI or `AI_MOBILE_EXPOSE_ADVANCED_TOOLS=1`.

## 0.1.2 - 2026-07-12

- Made the manager return an immediate dispatch receipt, continue through short status polls, and expose mandatory progress fields with concrete active-worker elapsed time instead of ending on a generic `running` sentence.
- Added automatic machine-readable writer-boundary recovery: a missing file map launches one low-cost read-only scope worker, assigns exact target-specific files, resumes the original writers, and does not consume provider failover.
- Documented optional same-task heartbeat reporting for explicitly continuous or 24/7 objectives; the zero-token supervisor keeps eligible CLI work moving while the heartbeat only wakes Codex for compact status and steering.

## 0.1.1 - 2026-07-12

- Protected the parent manager from shared Codex exhaustion with a configurable 15% reserve, default one-worker native Codex concurrency, capacity-headroom scoring, five-minute near-reserve checkpoints, durable external handoff, and same-run resume after a Codex reset.
- Added a validated lightweight Claude Code worker plugin with scout, reviewer, verifier, and writer roles; isolated bridge jobs feature-detect equivalent system-prompt and structured-output support, prefer the native Windows executable for exact arguments, and fall back without replaying a model call when optional CLI features are unavailable.
- Fixed expired Claude reset timestamps being treated as immediate premium-capacity opportunities and serialized all manifest refresh writes through the workspace lock while retaining bounded Windows atomic-rename retries.
- Recovered manager-only/native Codex execution: all normal orchestration entrypoints default manager-only, native workers now use a token-bound pre-spawn reservation before `started` binds the returned agent id, reserved actions remain visible until spawn, and cancellation races cannot bypass replacement safety.
- Serialized writable host actions with other workspace writers, included host lanes in refresh/failover/count/cancellation handling without `status.json`, retried transient Windows atomic-rename collisions, and preserved an omitted local profile address on PowerShell updates.
- Clarified that direct manual provider jobs retain a 30-minute default while orchestrated leases are adaptive, and that takeovers are collaborative-mode only.
- Made the Codex control-room chat manager-only by default: it plans, inventories capacity, dispatches, steers, reviews compact evidence, asks for user-boundary decisions, and reports without scanning project files, running diagnostics/tests, editing source, or duplicating worker execution.
- Promoted native Codex agents into executable project-manager lanes. Sol/Terra/Luna and future catalog models are selected from current host schemas, supported effort levels, measured shared Codex capacity, private policy, and observed outcomes.
- Added token-bound native host lifecycle events for start, completion, failure, and cancellation, including durable agent ids, one-writer protection, evidence-gated writer completion, idempotent acknowledgements, and replacement refusal while host cancellation is unconfirmed.
- Expanded the private local orchestrator profile with Codex/Claude allow patterns, Claude preference patterns, Antigravity task preferences, and adaptive project affinity; public defaults remain provider-neutral.
- Made Claude budgeting subscription-aware: claude.ai Pro/Max/Team/Enterprise auth without `ANTHROPIC_API_KEY` no longer passes `--max-budget-usd` and relies on measured 5-hour/weekly/model quota windows plus output-token and worker-lease guards; API-key/PAYG/unknown billing keeps a conservative automatic USD cap, `maxClaudeBudgetUsd=0` selects the auth-aware automatic policy, an explicit user cap is preserved, and the chosen policy is exposed in plan/status output without storing account identifiers.
- Replaced the default project deadline with continuous objective duration: work remains resumable until verified, genuinely blocked, or explicitly stopped; an optional explicit deadline remains available.
- Added rolling 20-minute capacity checkpoints, accelerating to five minutes near the Codex manager reserve, that refresh models, quota/reset windows, cooldowns, and pending assignments without interrupting running workers.
- Added a detached low-RAM, zero-model-token supervisor that advances sequential external stages and checkpoints, then exits when Codex input or a terminal decision is required.
- Replaced the global six-minute worker cap with complexity-adaptive 10-90 minute safety leases; direct Claude, Antigravity, and Cursor jobs default to 30 minutes.
- Added immediate user steering: new goals, stop requests, and safety constraints cancel incompatible active workers, persist the reason, and block unfinished items fail closed.
- Treated `ready-for-codex` as an active run, stopped it before changed-goal replacement, and refused replacement when an old worker process could not be confirmed stopped.
- Made active-run idempotency compare the full contract, including constraints, work graph, gates, routing authorization, and budgets, while carrying prior same-goal constraints, gates, and work graph across later additions and terminal-run continuation.
- Added default protected-state constraints for browser profiles, cookies, saved credentials, accounts, email/SMS authentication, CAPTCHA, and OAuth authorization flows.
- Kept live session, login, account, cookie, profile, credential, OAuth, email/SMS, and CAPTCHA checks with current Codex while preserving delegation for bounded source-code review.
- Made Antigravity CLI dispatch explicitly opt-in because an expired local token can launch an interactive browser authorization flow.
- Added evidence-inferred writer file boundaries; manager-only mode requests bounded discovery and blocks when a safe narrow scope is unavailable instead of silently taking over implementation.
- Sequenced complex default implementation after discovery so verified evidence can establish that writer boundary.
- Required discovery handoffs that unlock a writer to return exact workspace-relative file targets in backticks for deterministic boundary enforcement.
- Delegated low-complexity evidence review in manager-only mode while retaining parent ownership only for non-delegable user-boundary operations.
- Compacted project-manager status output to the newest relevant jobs, continuous-duration state, rolling capacity horizon/checkpoint, active constraints, and termination evidence.
- Added evidence-backed Codex completion, explicit takeover of failed worker items, downstream dependency-result handoff, and final project verification before a run can report `completed`.
- Failed final verification now records an explicit blocked state, and a cooling-down resource reroutes to a healthy pre-vetted alternate before dispatch.
- Added live-state dependency injection so runtime analysis cannot race ahead of the current Codex control check or infer liveness from Git deletions.
- Claude workers now dispatch exact observed model ids when available, preventing an alias mismatch from wasting a Haiku lane on Sonnet.
- Added authoritative run ids and `CompletionClaimAllowed` output so blocked orchestration cannot be hidden behind a success-style final response or confused with an application's own watchdog.
- Added `run-project-manager` and `project-manager-status` as the direct, idempotent execution/continuation path, removing manual plan JSON reads and provider command reconstruction from normal use.
- Added execution-class routing that keeps real submissions, sends, deploys, purchases, destructive actions, and other external effects under the current Codex session's authorization and live-state checks.
- Isolated Claude jobs with safe-mode, non-persistent sessions by default and corrected dominant-model telemetry so background Haiku calls do not masquerade as the requested Sonnet/Opus/Fable worker.
- Changed worker Git artifacts to attribute only paths changed during the worker run; pre-dirty paths are detected without copying the user's full existing diff into the worker patch.
- Added `project-manager-plan`, which coordinates native Codex workers and external CLI workers through a dependency-aware action manifest while the current Codex chat remains the manager and reporter.
- Added privacy-bounded `codex-usage` telemetry for current five-hour/weekly agentic-use windows and numeric session totals; transcript fields, paths, and thread ids are discarded and undocumented schema changes fail closed.
- Added transcript-free context capsules with bounded work-item budgets, workspace-only file fingerprints, stable hashes, lifecycle gates, and durable continuity under `.antigravity-bridge/orchestrator/`.
- Added dynamic native Codex model/effort discovery with a private local allow-pattern and review date, including supported Sol/Terra/Luna effort selection without invoking `codex.exe`.
- Added a private local orchestrator profile for communication/model policy; personal style and address preferences stay outside the public repository.
- Added live Claude CLI effort discovery and conservative model-effort routing; critical work defaults to high, while xhigh/max require explicit justification and current CLI support.
- Reworked the skill for progressive disclosure with one-hop project-manager, capacity, context-capsule, and provider-adapter references based on agent-skills orchestration patterns.
- Added zero-prompt Claude `/usage` inspection with five-hour, all-model weekly, and dynamic model-specific weekly percentage/reset windows.
- Added quota applicability routing: Sonnet uses shared windows unless a Sonnet row exists, while Fable also uses its dedicated weekly window when exposed.
- Added Haiku discovery, exact Claude alias resolution from safe evidence, the local Codex model catalog, software versions, and the full live Antigravity named-model inventory.
- Added reset-aware premium routing that uses Fable only when explicitly requested or for high-value work near a healthy dedicated reset instead of spending its separate capacity routinely.
- Cached privacy-safe capacity snapshots for 10 minutes so repeated orchestration calls avoid redundant CLI and Antigravity quota probes.
- Added `claude-usage` and the capacity-orchestration operating specification.
- Added bounded acceptance criteria and focused verification metadata to work items, plus context-budget guidance and one-level fan-out/merge rules inspired by the referenced agent-skills patterns.
- Added complexity-sized worker result budgets (5/6/8/10 bullets), bounded prompt/readback sizes, and prompt/result character telemetry for measurable token efficiency.
- Added five-hour platform reliability routing so repeated recent failures move broad work to a proven alternative instead of cycling through more models on the same failing platform.
- Reduced aggregate Codex readback while preserving detailed failed-lane evidence through `read-job`.
- Reframed AI Mobile from a fixed lane scheduler into a goal-driven resource orchestrator with the parent Codex chat as manager, critic, user-boundary owner, and reporter.
- Added passive `resource-inventory` discovery for Codex caller state, Claude auth/observed models, Antigravity CLI model roster/live quota evidence, Cursor headless availability, cooldowns, and evidence freshness.
- Added `orchestrate-project` with structured work items, capability/quality/capacity scoring, dependency-aware dispatch, one-writer safety, independent read-only review, and a compatibility path through `run-team-task`.
- Added one bounded failover for quota, rate-limit, timeout, outage, auth, model-unavailable, and worker failures; project outcome/cooldown history now persists under `.antigravity-bridge/orchestrator/`.
- Switched Claude worker output to structured JSON and added compact `worker-telemetry.json` with exact observed model, duration, token/cache usage, and provider-reported cost equivalent.
- Added safe machine-level resource caching under `%LOCALAPPDATA%\AI Mobile` without emails, organization ids, credentials, prompts, or private transcripts.
- Added active-run locking, atomic state writes, PID identity checks, timeout descendant cleanup, sensitive-data redaction for untracked files, and optional writer file-boundary enforcement.
- Made `run-team-task` a bounded one-call lifecycle: preserve explicit task lanes, route them to available workers, launch, wait, and return a compact fail-closed aggregate.
- Added `read-team-run` and `.antigravity-bridge/last-team-run.json` so Codex can resume and read all team workers with one command.
- Reduced stopped-desktop planning latency by using fast CLI detection and skipping Antigravity quota probes when no live DevTools page exists.
- Added deterministic non-overlapping lane ownership and narrow reassignment when a worker is unavailable.
- Made worker exceptions fail closed, made `cancel-job` terminate the recorded process tree, and made bridge-owned exit status authoritative in test summaries.
- Prevented review-only workers from reporting unrelated workspace diffs as their own changes.
- Added a deterministic `self-test` command for lane routing, aggregate state, and review-mode mutation detection.
- Streamlined README and skill instructions to remove repeated operating guidance and make team orchestration the primary workflow.
- Added team orchestration commands: `team-orchestration-plan` for 5-hour capacity-aware lane planning and `run-team-task` for starting Codex-led Antigravity CLI / Claude Code parallel worker lanes.
- Made `run-efficient-task` the mandatory fallback path when Codex cannot see the direct `ai-mobile-local` MCP tools, so sessions use the PowerShell helper instead of stopping after stale tool discovery.
- Added Cursor bridge support through `cursor-status`, `open-cursor`, and fail-closed `submit-cursor-job`.
- Documented that the Windows `cursor.cmd` launcher is UI-only unless a separate true `cursor-agent` binary is available.
- Added optional Claude Code headless bridge support through `claude-status` and `submit-claude-job`.
- Added PowerShell helper commands for Claude Code bridge jobs with safe defaults and `-Start false` dry-run support.
- Reused `.antigravity-bridge/jobs/<jobId>/` artifacts for Claude Code so Codex can read the same compact outputs without watching another chat.
- Hardened selected-chat verification so `expectedChat` must match the active Antigravity document title before model switching or submission.
- Hardened prompt submission verification so jobs are marked `submit_failed` unless Antigravity actually accepts the prompt.
- Captured DevTools/no-page submission exceptions into `status.json` instead of leaving bridge jobs stuck in `queued`.
- Added click-then-Enter submission fallback for Antigravity composer states where the visible nearby control is a mic/recording button instead of a send button.
- Added `flash-high` model preference for Gemini 3.5 Flash High routing.
- Made `antigravity-devtools` startup passive so opening Codex no longer opens, closes, restarts, or repairs Antigravity unless the user explicitly asks to use it.
- Added durable bridge job tools: `create-job`, `submit-job`, `list-jobs`, `read-job`, `cancel-job`, and `retry-job`.
- Added the `.antigravity-bridge/jobs/<jobId>/` artifact contract for `request.md`, `status.json`, `result.md`, `changed-files.txt`, `diff.patch`, and `test-output-summary.md`.
- Added `switch-model` MCP/PowerShell helper to move the active Antigravity chat to an available cost-saving model such as Gemini 3.5 Flash Medium.
- Updated `submit-offload` to run a model gate by default and refuse submission if the requested/available model cannot be verified.

## 0.1.0 - 2026-06-03

- Initial public release of the AI Mobile Codex Plugin.
- Added a local Antigravity 2.0 Codex bridge for Windows.
- Added MCP server entries for local setup/status/model-limit tools and DevTools-driven Antigravity UI work.
- Added PowerShell helper commands for setup checks, app launch, live readiness, model quota summaries, and privacy scanning.
- Added documentation for safe local handoff from OpenAI Codex to a visible Antigravity desktop session.
