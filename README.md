# AI Mobile Codex Plugin

Created by [comprono](https://github.com/comprono).

AI Mobile is a community Codex MCP plugin for Windows. It lets one Codex project task coordinate bounded workers from the Codex CLI, Claude Code, Antigravity, and optional Cursor while the current Codex model keeps working. The same task can be steered from the ChatGPT mobile app while execution continues on the linked PC.

The goal is simple: **finish useful project work faster without spending more tokens managing workers than the workers save.**

## Operating Model

AI Mobile follows eight foundation rules:

1. Current Codex owns the goal, critical path, integration, verification, and user communication.
2. One finite first call fixes the root outcome, inventories capacity, keeps Codex working, and routes bounded lanes.
3. Only genuinely independent bounded work is delegated, never to more than two external workers.
4. Every lane has one owner: Codex cannot redo a worker question or touch its files before collecting that result.
5. Codex continues a disjoint critical-path lane immediately after dispatch; there is no polling or heartbeat loop.
6. Deterministic checks run before any model review, and premium work is not sent to another premium model merely for reassurance.
7. The complete project outcome remains fixed; a passing milestone triggers the next dependency-ready milestone instead of ending the work.
8. Reasoning stays deep while communication stays compact, answer-first, and easy to scan.

Provider jobs are durable and write compact artifacts locally. Each task also has a caller-declared binding at `.ai-mobile/current-work.json` and one append-only handoff inbox. The binding never guesses or controls the host-selected Codex chat; it records only the declared current-Codex goal, file ownership, optional model, and integration point. A failed lane gets at most one justified failover; otherwise current Codex takes the bounded work back.

## Use

For a substantial project task:

```text
@ai-mobile Help complete this project efficiently.
Outcome: <measurable result>
Constraints: <important boundaries>
```

That is enough. The skill should:

- call `orchestrate-task` first, before project commands or file reads;
- preserve the complete outcome and positive completion evidence;
- keep genuine external stop conditions separate so an empty queue or named gate cannot become a false success path;
- inventory compact capacity and build the first delivery batch in that same call;
- keep the critical path in the current Codex task;
- dispatch only useful independent lanes;
- continue Codex work instead of waiting;
- collect each worker once at the integration point;
- verify with tests, diffs, and policy gates;
- advance to the next ready milestone in the same turn instead of stopping after the first passing slice;
- report `Done / Active / Blocked / Capacity / Next` using evidence.

The orchestration receipt initially forbids a final answer after setup, status, restart, or an empty eligible queue. Codex must first produce verified material progress, satisfy the completion evidence, or prove a genuine external/user-only blocker and that no dependency-ready local work remains.

Do not ask AI Mobile to create a control room, Goal, automation, schedule, or heartbeat unless that behavior is independently required. Continuous project work does not require recurring chat turns.

## Default Tool Surface

Only six tools are exposed to Codex by default:

| Tool | Purpose |
| --- | --- |
| `orchestrate-task` | Mandatory finite first call: preserve the root outcome, inventory capacity, keep Codex on the critical path, and route up to two bounded lanes. |
| `read-job` | Collect one compact result, optionally waiting locally for up to 60 seconds without model-side polling. |
| `verify-job` | Run bridge-owned deterministic checks without another model. |
| `cancel-job` | Stop one recorded local worker process. |
| `resource-inventory` | Explicit diagnostic capacity refresh; normal project startup already inventories capacity. |
| `orchestrator-profile` | Read or update private local routing preferences. |

The default surface excludes project-manager cycles, status polling, setup tools, raw DevTools, and provider-specific internals. This materially reduces tool-schema context in every Codex turn.

## Resource Selection

- **Current Codex:** critical reasoning, integration, ambiguous debugging, final verification, protected live state, and external effects.
- **Codex worker:** independent high-value work while shared Codex capacity remains above the 15% reserve. The router ranks the current native catalog from its advertised capability metadata and supported effort levels. It does not assume a Sol/Terra/Luna order; a private profile can still constrain or prefer a user's own allowed models.
- **Claude Code:** substantial bounded code, refactoring, debugging, and architecture work. Sonnet-class models are the normal default; premium Fable/Opus capacity is for genuinely hard work or a valuable dedicated window near reset.
- **Antigravity CLI:** broad read-only inspection, research, browser-oriented analysis, drafting, and low-cost validation. It is never auto-launched without explicit authorization.
- **Antigravity UI:** named visible project/chat state, authentication, model selection, or a verified CLI limitation only.
- **Cursor:** only when a true headless `cursor-agent` is installed and suitable.
- **Local bridge:** deterministic tests and artifact validation with no model tokens.

Model catalogs, effort levels, quota windows, reset times, recent workspace outcomes, and provider health are discovered from current local evidence. Automatic routing scores task fit and recent reliability; it does not choose Claude first by default. Unknown or stale limits remain unknown.

### Explicit User Model Selection

When the user explicitly names a provider or model ("use Fable 5"), the lane carries `selectionAuthority: "user"`. Model-to-provider binding is canonical — Fable/Opus/Sonnet/Haiku are Claude, GPT is Codex, Gemini is Antigravity — and a mismatched explicit pair is corrected deterministically in the same call, so Fable can never dispatch through Antigravity. For a user mandate the economic gate and small-task overhead warn instead of reject, and the mandate covers the premium-model opt-in; hard authentication, quota, billing, ownership-overlap, file-boundary, and safety gates still win. A repeated identical failed mandate returns one final do-not-retry blocker instead of another orchestration round. Automatic routing without a mandate keeps every token-saving default.

## Token-Efficiency Contract

- No plugin call for trivial or tightly coupled work.
- One compact orchestration call at project-task start; passive provider probes run in parallel under a fixed deadline, so an unavailable provider becomes unknown rather than stalling startup. Capacity refresh only after a reset, material provider change, or failure.
- No parent transcript in worker prompts.
- No dispatch without a distinct current-Codex lane, an independence reason, and non-overlapping ownership.
- Zero to two external lanes normally.
- No repeated status reads.
- Worker outputs default to 1,200-2,000 tokens. Claude subscriptions use measured quota windows and finite leases; dollar caps appear only for explicitly authorized PAYG lanes.
- Every new lane declares its expected contribution and the one-time action current Codex takes when the result arrives. A completed worker result is integrated before Codex does that lane itself.
- One terminal handoff artifact per worker, with compact result readback and full diagnostics only after a real blocker. A finite worker lease turns stalled workers into terminal failures rather than persistent "running" noise.
- Deterministic verification before qualitative review.
- No premium-on-premium review chain.
- Worker dispatch, waiting, retries, and unchanged reviews do not count as progress.
- No greetings, repeated prompts, tool-by-tool narration, waiting commentary, or routine postambles.
- Brevity never removes exact evidence, warnings, caveats, code, commands, paths, errors, or necessary reasoning.

### Smart Compact Communication

AI Mobile includes a communication mode inspired by [Caveman's](https://github.com/Shawnchee/caveman-skill) filler-removal principle, without caveman grammar. It keeps intelligence and verification unchanged, leads with the answer, removes low-value narration, and automatically expands when confusion, risk, ambiguity, or an important decision requires more explanation. The private profile supports `smart-compact` (default), `standard`, and `detailed` modes.

The current Codex task protects a configurable 15% shared-capacity reserve, but capacity above that floor remains available for useful Codex work. A five-hour horizon influences routing; it is not a project deadline.

For broad goals, the plugin keeps a compact `RootOutcome`, `CompletionEvidence`, `CurrentBatch`, and dependency `Frontier`. It stops only on verified completion, a real user/safety decision, a concrete external blocker, exhausted usable capacity, or a forced host-turn boundary. `Next` should describe work already started or the exact condition that prevented it.

## Durable Artifacts

Worker jobs live under the project workspace:

```text
.ai-mobile/tasks/<taskId>.json

.ai-mobile/jobs/<jobId>/
  contract.json
  request.md
  status.json
  events.jsonl
  result.md
  changed-files.json
  worker.diff
  test-output-summary.md
  verification-evidence.json
  usage.json
```

`read-job` returns a bounded summary, provider/model usage, ownership, and an explicit integration instruction. At an integration point, `waitSeconds=60` can absorb a short remaining worker delay inside the local bridge instead of creating repeated model turns. The first terminal read records `collectedAt`; a second read is visibly marked as already collected. Raw status JSON, full diffs, and telemetry dumps require `detail=full` and should be used only for focused diagnosis.

Writers require explicit non-overlapping file boundaries. The bridge records attributable changes and executes allowlisted verification commands as argument arrays rather than trusting worker prose.

## Install

```powershell
git clone https://github.com/comprono/Ai-Mobile-Codex-plugin.git "$env:USERPROFILE\plugins\ai-mobile"
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\plugins\ai-mobile\scripts\antigravity.ps1" setup
```

Restart Codex after installation or update, then start a fresh Codex task. Existing tasks keep the plugin skill and MCP schemas they loaded when they started and cannot be upgraded in place. AI Mobile rejects stale-task calls before inventory or worker execution.

Requirements:

- Windows.
- Codex plugin support.
- Node.js on `PATH`.
- Recommended: official Codex CLI authenticated through the ChatGPT plan.
- Optional: Claude Code CLI (`claude`).
- Optional: Antigravity CLI (`agy`) and Antigravity desktop.
- Optional: a real headless Cursor agent (`cursor-agent`).

The plugin starts no desktop app when Codex starts. The normal MCP manifest registers only `ai-mobile-local`; Antigravity UI control remains an on-demand advanced path.

## CLI Diagnostics

The PowerShell helper remains available for setup and focused diagnostics:

```powershell
# Setup and passive capacity checks
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\plugins\ai-mobile\scripts\antigravity.ps1" setup
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\plugins\ai-mobile\scripts\antigravity.ps1" resource-inventory -Refresh

# Finite orchestration contract and compact result
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\plugins\ai-mobile\scripts\antigravity.ps1" orchestrate-task -ContractFile ".\ai-mobile-contract.json"
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\plugins\ai-mobile\scripts\antigravity.ps1" read-job -Workspace "<path>" -JobId "<job-id>" -WaitSeconds 60
```

Old `.antigravity-bridge/jobs` artifacts remain readable, but the legacy manager, heartbeat, polling, and continuous-cycle commands are removed from the executable surface.

## Privacy And Safety

This is a local bridge. Private routing preferences are stored under `%LOCALAPPDATA%\AI Mobile\orchestrator-profile.json` and are not committed to the repository.

The plugin does not bypass model quotas, authentication, CAPTCHA, login, OAuth, external-action confirmation, or workspace boundaries. Browser profiles, cookies, credentials, email/SMS codes, real submissions, sends, deploys, purchases, and destructive actions remain protected current-Codex operations requiring applicable authorization.

Antigravity permission auto-approval is never implicit. A private local opt-in is honored only for sandboxed read-only CLI lanes; it never grants writer, UI, authentication, or external-action authority. Opening Codex must not open, close, restart, or repair Antigravity.

## Development

Run the local gates before publishing:

```powershell
node ".\scripts\ai-mobile-local-mcp.js" self-test
node ".\scripts\orchestration-regression.js"
node ".\scripts\economic-regression.js"
node ".\scripts\reliability-e2e.js"
powershell -ExecutionPolicy Bypass -File ".\scripts\antigravity.ps1" self-test
powershell -ExecutionPolicy Bypass -File ".\scripts\antigravity.ps1" privacy
git diff --check
python -m pipx run plugin-scanner lint .
python -m pipx run plugin-scanner verify .
```

`plugin-scanner verify` may exit nonzero only because it intentionally refuses to execute a local stdio MCP server. `scripts/reliability-e2e.js` performs that missing execution check from a clean copied path; all other scanner checks must pass.

See [Capacity-Aware Resource Orchestration](docs/CAPACITY_ORCHESTRATION.md) for the current evidence model and [AI Mobile Implementation Report](docs/IMPLEMENTATION_REPORT.md) for the researched target architecture, subtractive migration plan, and falsifiable release gates. The progressive-disclosure approach is informed by [Addy Osmani's agent-skills repository](https://github.com/addyosmani/agent-skills).

## License

MIT
