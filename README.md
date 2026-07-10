# AI Mobile Codex Plugin

Created by [comprono](https://github.com/comprono).

AI Mobile is a community Codex MCP plugin for Windows. you can use all of AI tools(apps or software) like Antigravity, Claude, cursor with your mobile with open AI not only that. It turns Codex into a smart resource orchestrator across local Antigravity CLI models, Antigravity desktop, Claude Code, and optional Cursor workers, including workflows started from the ChatGPT mobile app and continued by Codex on the linked PC.

The goal is better delivery, not merely token saving or static scheduling. AI Mobile treats platforms as teams and models as players: Codex understands the goal, inventories capability and capacity evidence, builds a work graph, assigns each item to the strongest efficient resource, monitors and redirects failures, critiques results, integrates accepted work, and performs final verification.

## Core Flow

For a nontrivial project goal, use the primary orchestrator:

```powershell
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\plugins\ai-mobile\scripts\antigravity.ps1" orchestrate-project -Goal "<complete outcome>" -Workspace "<path>" -Mode patch -HorizonHours 5 -WaitSeconds 30
```

The call passively discovers installed workers/models, uses measured or observed capacity evidence, creates a dependency-aware work graph, keeps one workspace writer, parallelizes independent read-only work, and dispatches through CLI. It does not open Antigravity desktop just to inspect resources.

Complex callers can provide `WorkItemsJson` instead of manually splitting work by software:

```powershell
$items = '[{"id":"architecture","objective":"Review the design and risks","kind":"architecture-review","complexity":"high","readOnly":true},{"id":"implementation","objective":"Implement the accepted design","kind":"implementation","complexity":"high","readOnly":false},{"id":"verification","objective":"Independently verify behavior","kind":"testing-review","complexity":"high","readOnly":true,"dependsOn":["implementation"]}]'
& "$env:USERPROFILE\plugins\ai-mobile\scripts\antigravity.ps1" orchestrate-project -Goal "<complete outcome>" -Workspace "<path>" -WorkItemsJson $items -WaitSeconds 30
```

If it returns `State: running`, resume without reading each worker separately:

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
```

Codex reads those artifacts instead of watching full chats, logs, or source dumps. `status.json` is bridge-owned: worker-written terminal state is ignored until the bridge has finalized the result, telemetry, and execution summary. `State: ready-for-codex` means worker work is ready for critique/integration; Codex still must verify the user goal before claiming completion.

Result budgets scale with complexity: low 5 bullets, medium 6, high 8, and critical 10. Aggregate team readback is capped independently; use `read-job` only when a failed or partial lane needs deeper evidence. Worker telemetry records prompt/result character counts, and Claude telemetry also records reported token usage.

## Install

```powershell
git clone https://github.com/comprono/Ai-Mobile-Codex-plugin.git "$env:USERPROFILE\plugins\ai-mobile"
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\plugins\ai-mobile\scripts\antigravity.ps1" setup
```

Restart Codex after installation so the skill and MCP tools are loaded. After that, mention `@ai-mobile` with the project goal; Codex should call `orchestrate-project` itself rather than asking you to choose models or split the work manually.

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
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\plugins\ai-mobile\scripts\antigravity.ps1" models
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\plugins\ai-mobile\scripts\antigravity.ps1" limits-summary
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\plugins\ai-mobile\scripts\antigravity.ps1" resource-inventory -Workspace "<path>"
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\plugins\ai-mobile\scripts\antigravity.ps1" claude-usage

# Goal-driven orchestration
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\plugins\ai-mobile\scripts\antigravity.ps1" orchestrate-project -Goal "<goal>" -Workspace "<path>" -WaitSeconds 30
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\plugins\ai-mobile\scripts\antigravity.ps1" read-team-run -Workspace "<path>" -WaitSeconds 30

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

- `ai-mobile-local`: passive resource inventory, goal-driven orchestration, durable jobs, per-run telemetry, bounded failover, model switching, worker submission, job readback, and privacy scan.
- `ai-mobile-devtools`: Chromium DevTools bridge for live Antigravity UI inspection and interaction.

Important local tools include `resource-inventory`, `claude-usage`, `orchestrate-project`, `read-team-run`, `quick`, `models`, `limits-summary`, `run-efficient-task`, `submit-agy-job`, `submit-claude-job`, `submit-job`, `read-job`, `select-chat`, `switch-model`, `devtools-health`, and `privacy`.

## Operating Rules

- Startup is passive. Opening Codex must not open, close, restart, or repair Antigravity.
- Codex is the goal owner, critic, integrator, and final verifier. External workers receive bounded work items and compact artifact contracts.
- Selection uses capability fit, required quality, capacity/freshness, speed/cost, independence, and project continuity. It is not a fixed UI/backend/testing map.
- Project affinity is learned only from successful worker outcomes. Timeouts and failed work lower reliability instead of making that resource more likely for the same task kind.
- Repeated recent failures without a platform success move broad work to a proven alternative for the five-hour horizon; micro tasks remain eligible for cheap bounded workers.
- Reserve Flash Low for tightly file-bounded micro tasks; prefer Flash Medium for broader repository review or project-health inspection.
- Use Antigravity CLI before desktop UI when visible project/chat state is not required.
- Use Antigravity desktop only for visible project/chat/model/composer workflows.
- Use Claude Code for local code, review, patch, and test lanes when UI context is not required.
- Claude CLI aliases are inventoried passively: Haiku handles small bounded work, Sonnet is the substantial implementation default, and Opus/Fable are premium options. Fable is used only when explicitly requested or when high-value work can use a healthy dedicated Fable window near reset, so it is not spent on ordinary tasks.
- Apply every Claude quota window that matches the model. Shared five-hour and all-model weekly windows apply to all aliases; a Fable, Sonnet, Opus, or other model-specific weekly row applies only when `/usage` actually exposes it.
- Treat "Claude/Sonnet/Opus in an Antigravity chat" as an Antigravity model choice, not Claude Code CLI.
- Do not submit into an existing chat unless `expectedChat` matches the active Antigravity document title/context.
- Do not report a submitted task unless the helper returns `Submitted: true` or a worker job returns `Started: true`.
- Do not treat process exit code 0 as completion when the result is empty, generic, off-task, or only identifies the model. The orchestrator classifies that as an insufficient result and can fail over the narrow item once.
- Keep worker prompts bounded and results complexity-sized. Do not stream worker narration or repeatedly read successful job artifacts into Codex.
- Give each nontrivial work item concise acceptance criteria and focused verification checks. Load only the relevant context, keep one writer per workspace, and merge independent reports once in Codex.
- Use direct single-lane execution when one perspective is enough; fan out only independent lanes with distinct outputs. Workers never invoke more workers, and orchestration depth stays one level.
- Keep at least one cross-platform alternate in each failover pool so a provider-level failure does not cycle through only that provider's models.
- Treat `State: ready-for-codex` as an integration gate, not completion. Codex must verify before reporting the user goal complete.
- If a worker exits after finalizing telemetry but before its terminal status write, recover the real success/failure category from telemetry and compact artifacts instead of reporting a generic process-gone failure.
- `cancel-job` stops the recorded local worker process tree before marking the job cancelled.
- If DevTools says `Transport closed`, call `devtools-health` once; do not keep retrying `list_pages`.

## Capacity Limits

The plugin reads Claude's built-in `/usage` percentages and reset times without running a model prompt. It combines shared five-hour and all-model weekly windows with any model-specific weekly windows, then routes using the most restrictive applicable value. It can also read Antigravity model availability and, while its local service is already running, full per-model percentage/reset evidence from the local language server. Safe capacity snapshots are cached for 10 minutes to reduce repeated local probes.

Codex does not expose its private remaining-token ledger, so the plugin accepts only caller-visible budget/model details. Unknown capacity remains explicitly unknown. Exact Claude alias ids are learned from CLI help or completed-run telemetry instead of being hardcoded. See [Capacity-Aware Resource Orchestration](docs/CAPACITY_ORCHESTRATION.md) for the bucket model, five-hour planning policy, reset-aware premium routing, failover rules, and privacy boundary. The policy also follows [agent-skills orchestration patterns](https://github.com/addyosmani/agent-skills): use the cheapest sufficient direct lane, isolate research context, parallelize only independent work, and keep the merge/verification step in Codex.

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
