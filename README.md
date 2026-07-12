# AI Mobile Codex Plugin

Created by [comprono](https://github.com/comprono).

AI Mobile is a community Codex MCP plugin for Windows. It turns one existing Codex task into a CEO-style project control room across standalone or host-native Codex workers, local Antigravity CLI models, Antigravity desktop, Claude Code, and optional Cursor workers. A workflow can start from the ChatGPT mobile app and continue through Codex on the linked PC.

The goal is better delivery, not merely token saving or static scheduling. AI Mobile treats platforms as teams and models as players. The parent Codex task stays manager-only: it discovers capacity, maintains the work graph, assigns owners, intervenes on failures or stalls, asks for decisions, and reports verified outcomes. **Do not create another Codex control-room task** never means do not create workers. Separate Codex CLI/host workers, Claude Code sessions, Antigravity CLI jobs, and optional Cursor jobs are expected and can run concurrently when dependencies and ownership boundaries allow it.

## Core Flow

For a nontrivial goal, use one Codex project task and mention `@ai-mobile`. "Manage this project as my CEO control room" selects the operating mode; it is not the project objective. On the first invocation, include the actual root outcome or explicitly create a Codex Goal containing it. Later invocations reuse that exact Goal/root objective.

```text
@ai-mobile Manage this project as my CEO control room.
Root objective: <the measurable project outcome that must remain active>
```

The one-line form is sufficient only when the same task already has an active Goal or AI Mobile run with `RootGoal`. This means: keep this existing Codex task as the only user-facing control room; do not create another Codex task, thread, Goal, or automation; do create and manage separate native Codex workers and headless Claude/Antigravity/Cursor jobs when eligible.

### Operating Frame

- **Objective:** persists until verified, genuinely blocked, or explicitly stopped.
- **Capacity horizon:** rolling five-hour forecast used to choose models; it never ends the project.
- **Capacity checkpoint:** normally every 20 minutes, accelerating to five minutes as shared Codex capacity approaches the manager reserve; refreshes quotas, resets, cooldowns, and pending assignments.
- **Manager runway:** 15% of shared Codex capacity is protected as a floor. Up to three standalone-or-host Codex workers run concurrently when capacity and independent boundaries permit; the effective limit scales down as headroom approaches the reserve. Claude and Antigravity CLI workers retain independent parallelism.
- **Writer boundaries:** up to two writers may run together when their workspace-relative file or directory boundaries are explicit and pairwise disjoint. Overlapping or unscoped writers remain serialized.
- **Worker lease:** short read-only leases (5-30 minutes by provider/complexity) and longer bounded writer leases (10-90 minutes); a silent or dead call can fail over without ending the objective.
- **Visible activity:** manager reports show each active worker's current bridge step and elapsed/maximum lease, so a healthy long-running worker is distinguishable from a stalled one without opening provider UIs or reading large logs.
- **Utilization:** use every appropriate healthy resource when distinct dependency-ready work exists; never duplicate the same task merely to keep every model busy.
- **Zero-model checks:** a read-only `verification`/`testing` item whose acceptance is fully expressed by structured `verificationCommands` runs in the durable local bridge instead of spending Codex, Claude, Antigravity, or Cursor quota. Qualitative diagnosis and review still use a reasoning model.
- **Continuous management:** persistent control rooms use one immutable root objective and numbered delivery cycles. Finishing a review/fix cycle never completes the root Goal.

PowerShell fallback:

```powershell
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\plugins\ai-mobile\scripts\antigravity.ps1" run-project-manager -Goal "<exact root outcome>" -Workspace "<path>" -CompletionPolicy continuous-management -CycleObjective "<first bounded delivery cycle>" -HorizonHours 5 -WaitSeconds 0
```

The call passively discovers installed workers/models, local Codex five-hour and weekly usage evidence, Claude usage windows, Antigravity per-model capacity when already running, supported Codex reasoning efforts, cooldowns, and recent outcomes. It writes a transcript-free context capsule and an exact action plan under `.antigravity-bridge/orchestrator/`. It does not open desktop apps just to plan. Project duration is continuous by default: the objective stays available until verified, genuinely blocked, or explicitly stopped. A lightweight detached Node.js supervisor advances sequential external stages and rolling capacity checkpoints without model-token use. A capacity checkpoint is internal routing state, not a schedule or a new chat. When Codex capacity approaches its reserve, unstarted work is routed to durable external CLI jobs so progress can continue; after the Codex window resets, the same Goal/task resumes the persisted run through `project-manager-status` instead of replaying the project.

Manager status is evidence-first and visible. The initial call returns assignments immediately; one `project-manager-status -WaitSeconds 120` call then returns early on a recorded transition or returns one two-minute activity checkpoint. Every status starts with a bounded `CEOControlRoom` brief: `Objective`, `Changed`, `Team now`, `Capacity`, `Progress`, `Blocker/Decision`, and `Next`. `Objective` is the immutable root goal; progress distinguishes root state from the current cycle. Continuous cycles close with `cycleVerified`/`cycleVerificationFailed` and add `nextWorkItems` under the same run id, using the exact latest `RunId` and `ActiveCycleId` as fail-closed transition guards. The runtime rejects stale cycle requests and `projectVerified` for continuous management, so a retry or small read-only cycle cannot close the Codex Goal. Compact cycle evidence remains archived when the next cycle starts. Automations are created only when separately requested for timed reports.

When all current-cycle workers finish, status reports `ActiveCycleState: awaiting-acceptance` and includes every current-cycle worker result needed for the decision. Older attempts remain compacted and are available through `read-job` only for diagnosis.

The public PowerShell helper preserves nested work-item arrays at full depth, including `dependsOn`, `expectedFiles`, acceptance criteria, and verification checks. A scope worker succeeds only when every requested writer target has a valid `BOUNDARY <work-item-id>:` line; explicitly declared markers remain mandatory even when writers already have `expectedFiles`, and compact readback preserves them. Prose-only scope suggestions fail closed and can use bounded provider failover.

### Lean tool surface

AI Mobile exposes ten manager/setup MCP tools by default instead of loading every low-level bridge schema into each Codex task. Normal work uses `run-project-manager` and `project-manager-status`; setup, capacity, profile, diagnostics, and privacy remain available. All advanced commands still work through `scripts/antigravity.ps1`. Set `AI_MOBILE_EXPOSE_ADVANCED_TOOLS=1` before starting Codex only when debugging requires the full MCP surface.

Complex callers can provide `WorkItemsJson` instead of manually splitting work by software:

```powershell
$items = '[{"id":"architecture","objective":"Review the design and risks","executionClass":"analysis","kind":"architecture-review","complexity":"high","readOnly":true},{"id":"implementation","objective":"Implement the accepted design","executionClass":"code","kind":"implementation","complexity":"high","readOnly":false,"expectedFiles":["src/"]},{"id":"verification","objective":"Independently verify behavior","executionClass":"analysis","kind":"testing-review","complexity":"high","readOnly":true,"dependsOn":["implementation"],"verificationCommands":[{"name":"project-tests","command":"npm","args":["test"],"timeoutSeconds":300,"expectedExitCode":0}]}]'
& "$env:USERPROFILE\plugins\ai-mobile\scripts\antigravity.ps1" project-manager-plan -Goal "<complete outcome>" -Workspace "<path>" -WorkItemsJson $items
```

AI Mobile prefers the official standalone Codex CLI when it is installed and `codex login status` confirms ChatGPT-plan authentication. It runs an isolated, ephemeral `codex exec` worker with stdin prompt transport, the selected catalog model/effort, bounded sandboxing, measured usage, and the same manager reserve as the parent. Read-only workers use `read-only`; bounded writers request `workspace-write` and do not inherit the parent task's internal permission profile or thread identity. If the effective CLI sandbox still rejects a write, AI Mobile records that transport capability for the current CLI version, keeps CLI reviews available, and routes later writers to host-native Codex or another healthy provider instead of repeating the failed call. It does not create another user-visible Codex task and refuses unknown/API-style auth to avoid unexpected separate billing. When that lane is unavailable, the active skill can use token-bound host-native actions through `project-manager-status`. Existing external orchestration remains available; if it returns `State: running`, resume without reading each worker separately:

```powershell
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\plugins\ai-mobile\scripts\antigravity.ps1" read-team-run -Workspace "<path>" -WaitSeconds 30
```

Workers write compact artifacts under:

```text
.antigravity-bridge/jobs/<jobId>/
  request.md
  status.json
  result.md
  changed-files.txt
  diff.patch
  test-output-summary.md
  verification-evidence.json
  worker-telemetry.json

.antigravity-bridge/last-team-run.json
.antigravity-bridge/last-team-run.md
.antigravity-bridge/orchestrator/resource-state.json
.antigravity-bridge/orchestrator/project-capsule.json
.antigravity-bridge/orchestrator/project-manager-plan.json
.antigravity-bridge/orchestrator/task-capsules/<workItemId>.json
```

Codex reads those artifacts instead of watching full chats, logs, or source dumps. `status.json` and `verification-evidence.json` are bridge-owned: worker-written terminal state or test prose cannot replace independently executed command evidence. Structured `verificationCommands` run as allowlisted argument arrays without an inline shell and record exit code, timeout, bounded output, and workspace mutation. When a read-only `verification`/`testing` item is completely defined by those commands, AI Mobile automatically assigns `bridge:verification / no-model`; it remains a durable job with a lease, telemetry, status, and fail-closed evidence. Work that asks for diagnosis, explanation, comparison, architecture, critique, or recommendations remains model-routed. `State: ready-for-codex` means worker work is ready for critique/integration; Codex still must verify the user goal before claiming completion.

Result budgets scale with complexity: low 5 bullets, medium 6, high 8, and critical 10. Aggregate team readback is capped independently; use `read-job` only when a failed or partial lane needs deeper evidence. Worker telemetry records prompt/result character counts, and Claude telemetry also records reported token usage. Claude workers default to a 12,000 output-token ceiling and an auth-aware budget policy: with claude.ai subscription auth (Pro/Max/Team/Enterprise, no `ANTHROPIC_API_KEY`) no per-worker USD cap is passed and spend is governed by measured 5-hour/weekly/model quota windows plus output-token and lease guards; API-key, PAYG, or unknown billing keeps a conservative automatic per-worker USD cap. `maxClaudeBudgetUsd=0` means auth-aware automatic policy; an explicit positive value is always preserved. The selected policy is shown in plan (`ClaudeBudgetPolicy:`) and run status (`claudeBudget=`) output, and no account identifiers or credentials are stored. Exceeding a budget or token ceiling fails closed without launching a second expensive worker.

### Claude CLI Worker Roles

AI Mobile ships a small Claude Code plugin under `claude-plugin/` with bounded scout, reviewer, verifier, and single-writer roles. Isolated bridge jobs use equivalent feature-detected role contracts through Claude's system-prompt and structured-output flags because Claude `--safe-mode` intentionally suppresses plugin components. This keeps normal worker runs isolated while the bundled Claude plugin remains available for direct Claude Code use and validation with `claude plugin validate ./claude-plugin`.

The component catalog, health-check, and analytics patterns were informed by [Claude Code Templates](https://github.com/davila7/claude-code-templates); AI Mobile does not vendor that repository or depend on its runtime. Model quota and reset decisions continue to use Claude's authoritative local `/usage` output rather than estimated schedules.

## Install

```powershell
git clone https://github.com/comprono/Ai-Mobile-Codex-plugin.git "$env:USERPROFILE\plugins\ai-mobile"
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\plugins\ai-mobile\scripts\antigravity.ps1" setup
```

Restart Codex after installation so the skill and MCP tools are loaded. After that, mention `@ai-mobile` with the project goal; Codex should call `run-project-manager`, execute dependency-ready host/external actions, and avoid asking you to choose models manually.

The MCP manifest resolves its scripts relative to the installed plugin root. It does not require the repository to remain at one developer-specific absolute path.

Requirements:

- Windows.
- Codex plugins loaded from `%USERPROFILE%\plugins`.
- Node.js on `PATH`.
- Recommended for unattended Codex worker lanes: the official standalone Codex CLI, signed in with the same ChatGPT plan (`codex login status`). Host-native workers remain the fallback when exposed.
- Antigravity desktop at `%LOCALAPPDATA%\Programs\Antigravity\Antigravity.exe`.
- Optional: Antigravity CLI as `agy`.
- Optional: Claude Code CLI as `claude`.
- Optional: Cursor; headless jobs require a real `cursor-agent` binary.

## Main Commands

```powershell
# Health and capacity
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\plugins\ai-mobile\scripts\antigravity.ps1" quick
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\plugins\ai-mobile\scripts\antigravity.ps1" codex-usage
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\plugins\ai-mobile\scripts\antigravity.ps1" codex-cli-status
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\plugins\ai-mobile\scripts\antigravity.ps1" models
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\plugins\ai-mobile\scripts\antigravity.ps1" limits-summary
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\plugins\ai-mobile\scripts\antigravity.ps1" resource-inventory -Workspace "<path>"
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\plugins\ai-mobile\scripts\antigravity.ps1" claude-usage

# Private per-user routing policy example
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\plugins\ai-mobile\scripts\antigravity.ps1" orchestrator-profile -ProfileAction set -CodexModelAllowPattern '^gpt-5\.6-(sol|terra|luna)$' -ClaudeModelAllowPattern '^(?!.*haiku).*$' -ClaudePreferredModelPattern 'sonnet' -AntigravityPreferredTaskPattern 'browser|file|read|discovery|research|review|docs|summary|scout' -AdaptiveRouting $true

# Goal-driven orchestration
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\plugins\ai-mobile\scripts\antigravity.ps1" run-project-manager -Goal "<goal>" -Workspace "<path>" -HorizonHours 5 -WaitSeconds 5
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\plugins\ai-mobile\scripts\antigravity.ps1" project-manager-status -Workspace "<path>" -WaitSeconds 120

# Add a new safety constraint now; active workers are interrupted by default
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\plugins\ai-mobile\scripts\antigravity.ps1" project-manager-status -Workspace "<path>" -AddConstraintsJson '["Do not access email."]' -SteeringDirective "Do not access email" -InterruptRunningWorkers $true

# Explicitly permit Antigravity CLI for this run (it may require browser sign-in)
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\plugins\ai-mobile\scripts\antigravity.ps1" run-project-manager -Goal "<goal>" -Workspace "<path>" -AllowAntigravityCli $true

# Unattended Antigravity: sandboxed tool prompts are pre-approved; readers use plan mode, writers use accept-edits; authentication and external-effect gates remain blocked
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\plugins\ai-mobile\scripts\antigravity.ps1" run-project-manager -Goal "<goal>" -Workspace "<path>" -AllowAntigravityCli $true -UnattendedMode $true -AllowAntigravityPermissionBypass $true

# Plan-only routing diagnostic
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\plugins\ai-mobile\scripts\antigravity.ps1" project-manager-plan -Goal "<goal>" -Workspace "<path>" -HorizonHours 5

# Compatibility planning/execution commands
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\plugins\ai-mobile\scripts\antigravity.ps1" orchestration-plan -Goal "<goal>" -Workspace "<path>"
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\plugins\ai-mobile\scripts\antigravity.ps1" team-orchestration-plan -Goal "<goal>" -Workspace "<path>"
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\plugins\ai-mobile\scripts\antigravity.ps1" run-team-task -Goal "<goal>" -Workspace "<path>" -WaitSeconds 30

# Worker lanes
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\plugins\ai-mobile\scripts\antigravity.ps1" submit-agy-job -Goal "<goal>" -Workspace "<path>" -Mode review
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\plugins\ai-mobile\scripts\antigravity.ps1" submit-claude-job -Goal "<goal>" -Workspace "<path>" -Mode patch -ClaudeModel sonnet
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\plugins\ai-mobile\scripts\antigravity.ps1" read-job -Workspace "<path>" -JobId latest

# Visible Antigravity UI only when needed
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\plugins\ai-mobile\scripts\antigravity.ps1" open
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\plugins\ai-mobile\scripts\antigravity.ps1" live
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\plugins\ai-mobile\scripts\antigravity.ps1" select-chat -ExpectedProject "<project>" -ExpectedChat "<chat>"
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\plugins\ai-mobile\scripts\antigravity.ps1" switch-model -ModelPreference flash-medium -ExpectedProject "<project>" -ExpectedChat "<chat>"
```

## MCP Servers

- `ai-mobile-local`: capacity metadata, context capsules, project-manager plans, passive resource inventory, durable jobs, bounded failover, model switching, worker submission, job readback, and privacy scan.
- `ai-mobile-devtools`: Chromium DevTools bridge for live Antigravity UI inspection and interaction.

Important local tools include `run-project-manager`, `project-manager-status`, `project-manager-plan`, `context-capsule`, `codex-usage`, `codex-cli-status`, `submit-codex-job`, `orchestrator-profile`, `resource-inventory`, `claude-usage`, `orchestrate-project`, `read-team-run`, `submit-agy-job`, `submit-claude-job`, `read-job`, no-model `verify-job`, `select-chat`, `switch-model`, `devtools-health`, and `privacy`.

## Operating Rules

- Startup is passive. Opening Codex must not open, close, restart, or repair Antigravity. An authorized unattended CLI job uses explicit `plan` or `accept-edits` mode; any remaining authentication or workspace-trust prompt triggers one failover instead of repeated UI popups.
- Use `run-project-manager` once for a root objective. Finite objectives may use a bounded replacement after a real contract change. Active `continuous-management` objectives reject rephrased or reduced replacement prompts; routine corrections and new work graphs must use `project-manager-status` cycle fields under the same run id. Explicit user steering or stop instructions terminate workers first. Persisted constraints and root gates carry across an intentional restart so safety boundaries are not silently lost.
- `ready-for-codex` is still active until final verification or explicit termination. A changed goal stops that run first, and a replacement is refused if any old worker process cannot be confirmed stopped.
- For `continuous-management`, `ready-for-codex` is only a cycle boundary. `projectVerified` is rejected; the manager records cycle evidence and supplies the next bounded cycle under the same run id.
- Complex default implementations wait for discovery evidence before writer dispatch so the orchestrator can infer a narrow file boundary instead of granting repository-wide write scope.
- A five-hour capacity horizon is a rolling forecast, not a countdown or project deadline. Project duration is continuous by default, with capacity re-evaluated every 20 minutes, every five minutes near the Codex manager reserve, or on the next status call.
- Individual provider calls use role-aware safety leases. Read-only Antigravity work receives 5-20 minutes and other read-only providers 8-30 minutes; writers retain complexity-adaptive 10-90 minute ceilings. These protect against silent or dead CLIs without limiting project duration, and an explicit `MaxWorkerMinutes` may lower the ceiling.
- Direct manual provider jobs keep their 30-minute default. Role-aware adaptive leases apply only to orchestrated workers.
- Capacity checkpoints never kill running workers. They refresh model/quota/cooldown evidence and may reroute only work that has not started.
- The detached supervisor consumes no model tokens. It advances external dependency stages while `State: running` and exits at `ready-for-codex`, `blocked`, `completed`, replacement, or explicit stop.
- Pass user constraints, acceptance criteria, and verification at the top level. New constraints or a changed goal cancel incompatible active workers immediately and are written into the next context capsule.
- Browser profiles, cookies, saved credentials, account selection, email/SMS messages, and OAuth flows are protected state. Workers must stop at sign-in, CAPTCHA, email, SMS, or authorization gates unless the user explicitly authorizes that exact action.
- Live session, login, cookie, account, profile, credential, OAuth, email/SMS, and CAPTCHA checks remain current-Codex actions. CLI workers may review bounded source code about those systems but do not inspect the user's live protected state.
- The current Codex task is manager-only by default: every normal orchestration entrypoint treats an omitted `managerOnly` as true. It owns goals, capacity decisions, steering, intervention, compact evidence review, user-boundary decisions, and reporting. It does not scan project files, run diagnostics/tests, edit source, or duplicate worker execution. Set `managerOnly=false` only when the user explicitly asks this parent task to implement or diagnose a bounded item.
- Manager-only never disables the Codex platform. Separate standalone or host-native Codex workers remain eligible whenever measured shared capacity is above the manager reserve, and may run beside Claude and Antigravity workers on independent work.
- Native Codex workers are separate host agents selected from the current model catalog and shared Codex capacity evidence. The default 15% manager reserve prevents new native dispatch when the shared pool is low, and default native concurrency is one so parallel subagents cannot consume the manager's recovery runway. Every host attempt reserves before spawn, then uses a run-bound attempt id and dispatch token through `hostWorkerEvents` to bind, complete, fail, or cancel the returned agent id.
- Real submissions, sends, deploys, purchases, destructive actions, and other external effects remain current-Codex actions with authorization and live-state checks. CLI workers may analyze, patch, or verify them but cannot silently execute them.
- Current-runtime analysis is automatically sequenced after the relevant live Codex control action. Downstream workers receive compact dependency results and verified Codex evidence instead of rediscovering state from scratch.
- Parent-task boundary work cannot be marked complete without `codexEvidence`. Manager-only mode refuses `takeoverCodexItems`; failed worker work is rescaled, reassigned, or blocked instead of silently consuming the control-room task.
- Selection uses capability fit, required quality, capacity/freshness, speed/cost, independence, and project continuity. It is not a fixed UI/backend/testing map.
- Keep appropriate healthy resources occupied when independent dependency-ready work exists, but never create duplicate lanes solely to maximize utilization.
- Project affinity is learned only from successful worker outcomes. Timeouts and failed work lower reliability instead of making that resource more likely for the same task kind.
- Repeated recent failures without a platform success move broad work to a proven alternative for the five-hour horizon; micro tasks remain eligible for cheap bounded workers.
- Reserve Flash Low for tightly file-bounded micro tasks; prefer Flash Medium for broader repository review or project-health inspection.
- Use Antigravity CLI before desktop UI only when the run explicitly permits it. The CLI may open browser authorization when its local token is stale, so automatic routing treats it as authorization-required by default.
- Use Antigravity desktop only for visible project/chat/model/composer workflows.
- Use Claude Code for local code, review, patch, and test lanes when UI context is not required.
- Claude workers use isolated `--safe-mode` and non-persistent sessions by default, with feature-detected bounded role prompts, structured final evidence, native executable argument transport on Windows, and compatibility fallback for older CLIs. Dominant per-model usage determines the observed model, so background helper-model calls do not corrupt Sonnet/Opus/Fable routing.
- Claude aliases are resolved to exact observed model ids for dispatch when available, preventing a Haiku lane from silently consuming Sonnet capacity.
- Claude CLI aliases are inventoried passively: Haiku handles small bounded work, Sonnet is the substantial implementation default, and Opus/Fable are premium options. Fable is used only when explicitly requested or when high-value work can use a healthy dedicated Fable window near reset, so it is not spent on ordinary tasks.
- Apply every Claude quota window that matches the model. Shared five-hour and all-model weekly windows apply to all aliases; a Fable, Sonnet, Opus, or other model-specific weekly row applies only when `/usage` actually exposes it.
- Treat "Claude/Sonnet/Opus in an Antigravity chat" as an Antigravity model choice, not Claude Code CLI.
- Do not submit into an existing chat unless `expectedChat` matches the active Antigravity document title/context.
- Do not report a submitted task unless the helper returns `Submitted: true` or a worker job returns `Started: true`.
- Do not treat process exit code 0 as completion when the result is empty, generic, off-task, or only identifies the model. The orchestrator classifies that as an insufficient result and can fail over the narrow item once.
- Writer success additionally requires attributable file changes and a non-blocked result. `BLOCKED`, `no code changed`, or an empty changed-file set is an insufficient implementation result and cannot release dependent verification.
- A dependency may authorize writer files only through `BOUNDARY <work-item-id>: ` followed by exact backtick-wrapped paths. Incidental paths mentioned in diagnostics or generated reports are never treated as edit permission.
- Concurrent same-stage writers retain separate attribution: files inside another active writer's explicitly disjoint boundary are recorded as peer changes, while changes outside all declared boundaries still fail closed.
- Keep worker prompts bounded and results complexity-sized. Do not stream worker narration or repeatedly read successful job artifacts into Codex.
- External writer lanes require an explicit file boundary or a narrow boundary inferred from verified dependency evidence. If neither exists, manager-only mode requests bounded discovery and blocks the writer instead of making the control-room task explore or implement.
- Native Codex host workers participate in the same dependency, bounded-writer, evidence, cooldown, and bounded-failover rules as CLI workers. A changed goal cannot start a replacement until any running host agent is confirmed closed.
- Worker change artifacts include only paths changed during that worker run. A path already dirty before launch is detected but its full pre-existing diff is never attributed to the worker.
- Give each nontrivial work item concise acceptance criteria and focused verification checks. Use canonical `objective`, `executionClass`, `expectedFiles`, and structured `verificationCommands` fields. Load only relevant context, run at most two pairwise-disjoint writers, and merge independent reports once in Codex.
- Prefer a pure `kind=verification` or `kind=testing` item with complete structured commands when exit evidence fully decides acceptance. AI Mobile will execute up to two such jobs in the local zero-model bridge; do not add a model-only review to restate the same command result.
- Use direct single-lane execution when one perspective is enough; fan out only independent lanes with distinct outputs. Workers never invoke more workers, and orchestration depth stays one level.
- Keep at least one cross-platform alternate in each failover pool so a provider-level failure does not cycle through only that provider's models.
- Treat `State: ready-for-codex` as an integration or cycle gate, not completion. Only a finite run can return `CompletionClaimAllowed: true`; continuous control rooms keep the root Goal active until explicit user stop.
- Treat `CompletionClaimAllowed` as authoritative. Only a finite root objective with passing final verification permits a success claim. One completed cycle cannot justify stopping or completing a continuous control room.
- If a worker exits after finalizing telemetry but before its terminal status write, recover the real success/failure category from telemetry and compact artifacts instead of reporting a generic process-gone failure.
- `cancel-job` stops the recorded local worker process tree before marking the job cancelled.
- If DevTools says `Transport closed`, call `devtools-health` once; do not keep retrying `list_pages`.

## Capacity Limits

The plugin reads current Codex agentic-use windows from recent local `token_count` events, Claude's built-in `/usage` percentages/reset times without running a model prompt, and Antigravity per-model availability while its local service is already running. Every applicable window is combined using the most restrictive remaining value. Safe provider snapshots are cached and revalidated to avoid repeated probes.

The Codex event shape is undocumented and may change, so the reader fails closed when evidence is stale or unsupported. It returns only numeric capacity/token metadata and discards prompts, responses, paths, and thread identifiers. It is not a complete API for every ChatGPT product/model limit. Unknown capacity remains explicitly unknown.

Model ids and effort levels are discovered from current catalogs and host tool schemas. A private local policy can restrict currently approved families and set a review date; no model id, tier, or reset schedule is assumed permanent. See [Capacity-Aware Resource Orchestration](docs/CAPACITY_ORCHESTRATION.md) for the normalized evidence model and failover policy.

Private preferences are stored under `%LOCALAPPDATA%\AI Mobile\orchestrator-profile.json`, never in the public repository. They can allow or prefer Codex and Claude model patterns, favor Antigravity task types, and enable adaptive project affinity. Public defaults remain provider-neutral; verified successes and failures refine routing for each workspace.

## Future-Proof Context Packaging

AI Mobile follows the progressive-disclosure and orchestration ideas in [Addy Osmani's agent-skills repository](https://github.com/addyosmani/agent-skills): keep the active skill small, package a hierarchical context capsule instead of replaying a transcript, isolate broad research, fan out only independent work, keep depth at one, and make the main Codex session own merge and verification. Provider-specific behavior lives behind adapter contracts, so future model names and effort levels are data, not workflow code.

## Safety

This is a local bridge. It does not patch Antigravity internals, bypass model quotas, commit runtime tokens, or read private chats unless the user asks for that specific context. By default it also forbids opening OAuth flows, reading email or SMS, clearing cookies, switching accounts, or changing the user's browser profile. Those actions require explicit, task-specific authorization.

Before publishing:

```powershell
node ".\scripts\reliability-e2e.js"
powershell -ExecutionPolicy Bypass -File ".\scripts\antigravity.ps1" self-test
powershell -ExecutionPolicy Bypass -File ".\scripts\antigravity.ps1" privacy
git diff --check
python -m pipx run plugin-scanner lint .
python -m pipx run plugin-scanner verify .
```

`plugin-scanner verify` may report skipped stdio execution for safety; manually test the MCP server or PowerShell helper when that happens.

## License

MIT
