# AI Mobile Codex Plugin

Created by [comprono](https://github.com/comprono).

AI Mobile is a community Codex MCP plugin for Windows. It turns one Codex chat into a project control room across native Codex workers, local Antigravity CLI models, Antigravity desktop, Claude Code, and optional Cursor workers. A workflow can start from the ChatGPT mobile app and continue through Codex on the linked PC.

The goal is better delivery, not merely token saving or static scheduling. AI Mobile treats platforms as teams and models as players: the current Codex session acts as project manager and active integrator, discovers current models/effort levels/quota windows, packages bounded project context, assigns dependency-aware work, monitors failures, critiques results, and performs final verification.

## Core Flow

For a nontrivial goal, mention `@ai-mobile` in the project chat. The skill calls the primary project-manager tool, detects whether native Codex workers are callable, and executes the returned dependency stages:

```text
@ai-mobile orchestrate this project goal using current capacity and CLI-first workers.
```

PowerShell fallback:

```powershell
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\plugins\ai-mobile\scripts\antigravity.ps1" project-manager-plan -Goal "<complete outcome>" -Workspace "<path>" -Mode patch -HorizonHours 5
```

The call passively discovers installed workers/models, local Codex five-hour and weekly usage evidence, Claude usage windows, Antigravity per-model capacity when already running, supported Codex reasoning efforts, cooldowns, and recent outcomes. It writes a transcript-free context capsule and an exact action plan under `.antigravity-bridge/orchestrator/`. It does not open desktop apps just to plan.

Complex callers can provide `WorkItemsJson` instead of manually splitting work by software:

```powershell
$items = '[{"id":"architecture","objective":"Review the design and risks","kind":"architecture-review","complexity":"high","readOnly":true},{"id":"implementation","objective":"Implement the accepted design","kind":"implementation","complexity":"high","readOnly":false},{"id":"verification","objective":"Independently verify behavior","kind":"testing-review","complexity":"high","readOnly":true,"dependsOn":["implementation"]}]'
& "$env:USERPROFILE\plugins\ai-mobile\scripts\antigravity.ps1" project-manager-plan -Goal "<complete outcome>" -Workspace "<path>" -WorkItemsJson $items
```

The active Codex skill then launches native Codex agents through the host tool and external workers through AI Mobile's CLI adapters. The MCP server never starts `codex.exe`. Existing external-only orchestration remains available; if it returns `State: running`, resume without reading each worker separately:

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
  worker-telemetry.json

.antigravity-bridge/last-team-run.json
.antigravity-bridge/last-team-run.md
.antigravity-bridge/orchestrator/resource-state.json
.antigravity-bridge/orchestrator/project-capsule.json
.antigravity-bridge/orchestrator/project-manager-plan.json
.antigravity-bridge/orchestrator/task-capsules/<workItemId>.json
```

Codex reads those artifacts instead of watching full chats, logs, or source dumps. `status.json` is bridge-owned: worker-written terminal state is ignored until the bridge has finalized the result, telemetry, and execution summary. `State: ready-for-codex` means worker work is ready for critique/integration; Codex still must verify the user goal before claiming completion.

Result budgets scale with complexity: low 5 bullets, medium 6, high 8, and critical 10. Aggregate team readback is capped independently; use `read-job` only when a failed or partial lane needs deeper evidence. Worker telemetry records prompt/result character counts, and Claude telemetry also records reported token usage.

## Install

```powershell
git clone https://github.com/comprono/Ai-Mobile-Codex-plugin.git "$env:USERPROFILE\plugins\ai-mobile"
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\plugins\ai-mobile\scripts\antigravity.ps1" setup
```

Restart Codex after installation so the skill and MCP tools are loaded. After that, mention `@ai-mobile` with the project goal; Codex should call `project-manager-plan`, execute dependency-ready host/external actions, and avoid asking you to choose models manually.

Requirements:

- Windows.
- Codex plugins loaded from `%USERPROFILE%\plugins`.
- Node.js on `PATH`.
- Antigravity desktop at `%LOCALAPPDATA%\Programs\Antigravity\Antigravity.exe`.
- Optional: Antigravity CLI as `agy`.
- Optional: Claude Code CLI as `claude`.
- Optional: Cursor; headless jobs require a real `cursor-agent` binary.

## Main Commands

```powershell
# Health and capacity
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\plugins\ai-mobile\scripts\antigravity.ps1" quick
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\plugins\ai-mobile\scripts\antigravity.ps1" codex-usage
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\plugins\ai-mobile\scripts\antigravity.ps1" models
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\plugins\ai-mobile\scripts\antigravity.ps1" limits-summary
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\plugins\ai-mobile\scripts\antigravity.ps1" resource-inventory -Workspace "<path>"
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\plugins\ai-mobile\scripts\antigravity.ps1" claude-usage

# Goal-driven orchestration
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\plugins\ai-mobile\scripts\antigravity.ps1" run-project-manager -Goal "<goal>" -Workspace "<path>" -HorizonHours 5 -WaitSeconds 5
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\plugins\ai-mobile\scripts\antigravity.ps1" project-manager-status -Workspace "<path>" -WaitSeconds 30

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

Important local tools include `run-project-manager`, `project-manager-status`, `project-manager-plan`, `context-capsule`, `codex-usage`, `orchestrator-profile`, `resource-inventory`, `claude-usage`, `orchestrate-project`, `read-team-run`, `submit-agy-job`, `submit-claude-job`, `read-job`, `select-chat`, `switch-model`, `devtools-health`, and `privacy`.

## Operating Rules

- Startup is passive. Opening Codex must not open, close, restart, or repair Antigravity.
- Use `run-project-manager` as the one-call default. It is idempotent for an active workspace run and avoids manual plan JSON reads or provider command reconstruction.
- The current Codex session is project manager, goal owner, critic, active narrow contributor, integrator, and final verifier. Native and external workers receive bounded work items and compact artifact contracts.
- Real submissions, sends, deploys, purchases, destructive actions, and other external effects remain current-Codex actions with authorization and live-state checks. CLI workers may analyze, patch, or verify them but cannot silently execute them.
- Selection uses capability fit, required quality, capacity/freshness, speed/cost, independence, and project continuity. It is not a fixed UI/backend/testing map.
- Project affinity is learned only from successful worker outcomes. Timeouts and failed work lower reliability instead of making that resource more likely for the same task kind.
- Repeated recent failures without a platform success move broad work to a proven alternative for the five-hour horizon; micro tasks remain eligible for cheap bounded workers.
- Reserve Flash Low for tightly file-bounded micro tasks; prefer Flash Medium for broader repository review or project-health inspection.
- Use Antigravity CLI before desktop UI when visible project/chat state is not required.
- Use Antigravity desktop only for visible project/chat/model/composer workflows.
- Use Claude Code for local code, review, patch, and test lanes when UI context is not required.
- Claude workers use isolated `--safe-mode` and non-persistent sessions by default, with a compatibility fallback for older CLIs. Dominant per-model usage determines the observed model, so background helper-model calls do not corrupt Sonnet/Opus/Fable routing.
- Claude CLI aliases are inventoried passively: Haiku handles small bounded work, Sonnet is the substantial implementation default, and Opus/Fable are premium options. Fable is used only when explicitly requested or when high-value work can use a healthy dedicated Fable window near reset, so it is not spent on ordinary tasks.
- Apply every Claude quota window that matches the model. Shared five-hour and all-model weekly windows apply to all aliases; a Fable, Sonnet, Opus, or other model-specific weekly row applies only when `/usage` actually exposes it.
- Treat "Claude/Sonnet/Opus in an Antigravity chat" as an Antigravity model choice, not Claude Code CLI.
- Do not submit into an existing chat unless `expectedChat` matches the active Antigravity document title/context.
- Do not report a submitted task unless the helper returns `Submitted: true` or a worker job returns `Started: true`.
- Do not treat process exit code 0 as completion when the result is empty, generic, off-task, or only identifies the model. The orchestrator classifies that as an insufficient result and can fail over the narrow item once.
- Keep worker prompts bounded and results complexity-sized. Do not stream worker narration or repeatedly read successful job artifacts into Codex.
- Worker change artifacts include only paths changed during that worker run. A path already dirty before launch is detected but its full pre-existing diff is never attributed to the worker.
- Give each nontrivial work item concise acceptance criteria and focused verification checks. Load only the relevant context, keep one writer per workspace, and merge independent reports once in Codex.
- Use direct single-lane execution when one perspective is enough; fan out only independent lanes with distinct outputs. Workers never invoke more workers, and orchestration depth stays one level.
- Keep at least one cross-platform alternate in each failover pool so a provider-level failure does not cycle through only that provider's models.
- Treat `State: ready-for-codex` as an integration gate, not completion. Codex must verify before reporting the user goal complete.
- If a worker exits after finalizing telemetry but before its terminal status write, recover the real success/failure category from telemetry and compact artifacts instead of reporting a generic process-gone failure.
- `cancel-job` stops the recorded local worker process tree before marking the job cancelled.
- If DevTools says `Transport closed`, call `devtools-health` once; do not keep retrying `list_pages`.

## Capacity Limits

The plugin reads current Codex agentic-use windows from recent local `token_count` events, Claude's built-in `/usage` percentages/reset times without running a model prompt, and Antigravity per-model availability while its local service is already running. Every applicable window is combined using the most restrictive remaining value. Safe provider snapshots are cached and revalidated to avoid repeated probes.

The Codex event shape is undocumented and may change, so the reader fails closed when evidence is stale or unsupported. It returns only numeric capacity/token metadata and discards prompts, responses, paths, and thread identifiers. It is not a complete API for every ChatGPT product/model limit. Unknown capacity remains explicitly unknown.

Model ids and effort levels are discovered from current catalogs and host tool schemas. A private local policy can restrict currently approved families and set a review date; no model id, tier, or reset schedule is assumed permanent. See [Capacity-Aware Resource Orchestration](docs/CAPACITY_ORCHESTRATION.md) for the normalized evidence model and failover policy.

## Future-Proof Context Packaging

AI Mobile follows the progressive-disclosure and orchestration ideas in [Addy Osmani's agent-skills repository](https://github.com/addyosmani/agent-skills): keep the active skill small, package a hierarchical context capsule instead of replaying a transcript, isolate broad research, fan out only independent work, keep depth at one, and make the main Codex session own merge and verification. Provider-specific behavior lives behind adapter contracts, so future model names and effort levels are data, not workflow code.

## Safety

This is a local bridge. It does not patch Antigravity internals, bypass model quotas, commit runtime tokens, or read private chats unless the user asks for that specific context.

Before publishing:

```powershell
powershell -ExecutionPolicy Bypass -File ".\scripts\antigravity.ps1" self-test
powershell -ExecutionPolicy Bypass -File ".\scripts\antigravity.ps1" privacy
git diff --check
python -m pipx run plugin-scanner lint .
python -m pipx run plugin-scanner verify .
```

`plugin-scanner verify` may report skipped stdio execution for safety; manually test the MCP server or PowerShell helper when that happens.

## License

MIT
