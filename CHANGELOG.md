# Changelog

## Unreleased

- Reframed AI Mobile from a fixed lane scheduler into a goal-driven resource orchestrator with Codex as coach, critic, integrator, and final verifier.
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
