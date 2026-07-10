---
name: ai-mobile
description: Use Codex as a capacity-aware project manager across native Codex workers, Claude Code, Antigravity, and optional Cursor. Use when a project should be understood, packaged into bounded context, assigned by current capability and quota, executed CLI-first in parallel where safe, critiqued, integrated, verified, and resumed without replaying the parent chat.
---

# AI Mobile

Use one Codex chat as the project control room. The current Codex session is the project manager, goal owner, integration owner, and an active narrow contributor. It coordinates workers; it does not become a passive router or duplicate delegated work.

## Default Workflow

For a nontrivial project goal:

1. Understand the outcome, constraints, risk, current state, acceptance criteria, and focused verification.
2. Check whether a native host agent tool such as `multi_agent_v1__spawn_agent` is exposed. Never probe or launch `codex.exe`.
3. Call `ai-mobile-local.project-manager-plan` with `goal`, `workspace`, a dependency-aware `workItems` graph when useful, `horizonHours=5`, and `hostCodexAvailable=true` only when the native host tool is callable.
4. Read the generated `project-manager-plan.json` once. It contains exact bounded prompts and one transcript-free context-capsule path.
5. Launch only dependency-ready actions. Parallelize distinct independent work; keep one writer per workspace.
6. While workers run, the current Codex session handles the narrow critical path: decisions, integration preparation, risk gates, or another non-duplicated item.
7. Read compact results once. Accept objective-specific evidence, request one bounded correction, or fail over the failed item once to a provider-diverse alternate.
8. Launch dependent stages only after their gates pass. Merge once, run focused final verification, and report evidence-backed completion.

Do not ask the user to choose models manually. Do not use every provider merely because it is installed.

## Execution Contract

- Native Codex action: call the host agent tool using the exact `model` and `reasoningEffort` in the plan. Workers never spawn workers.
- Claude action: call `submit-claude-job` with the stored prompt and model.
- Antigravity action: prefer `submit-agy-job`; use desktop chat/model tools only when visible project or conversation state is part of the task.
- Cursor action: use only when `cursor-status` reports a true headless agent. The `cursor` launcher is UI, not a headless worker.
- Current Codex action: perform it directly in this chat with targeted reads and commands.

The bridge may start external CLI jobs, but an MCP server cannot invoke host-native Codex agent tools. The active skill must execute those host actions itself.

## Capacity Rules

- `project-manager-plan` and `resource-inventory` discover installed CLIs, model catalogs, quotas, resets, cooldowns, and recent outcomes before assignment.
- `codex-usage` reads only bounded local `token_count` metadata. It discards prompts, responses, paths, and thread ids. This is Codex agentic-usage evidence, not a complete ChatGPT product-limit API.
- Preserve unknown or stale capacity as unknown/stale. Never invent token allowances, reset times, or model availability.
- Apply every quota window that governs a model and route using the most restrictive remaining window.
- Discover models and supported effort levels from current catalogs/tool schemas. Honor the local model allow-pattern, and flag it when its review date is due.
- Use the cheapest/fastest model that safely meets the quality floor. Reserve highest efforts and premium models for materially critical reasoning, not routine work.
- A provider outage, exhausted window, invalid model, timeout, or insufficient result triggers cooldown and one narrow failover. Do not loop retries.

Detailed policy: [capacity-and-routing.md](references/capacity-and-routing.md).

## Context And Continuity

Workers receive a project capsule, not the parent transcript. It includes only the goal, constraints, work graph, ownership, file fingerprints, decisions, blockers, acceptance gates, verification, and compact artifact references. File contents and broad logs remain local and are read only when relevant.

Durable control artifacts live under:

```text
.antigravity-bridge/orchestrator/project-capsule.json
.antigravity-bridge/orchestrator/project-manager-plan.json
.antigravity-bridge/orchestrator/task-capsules/<workItemId>.json
.antigravity-bridge/jobs/<jobId>/
```

Read only compact worker artifacts: `result.md`, `changed-files.txt`, `diff.patch`, `test-output-summary.md`, `worker-telemetry.json`, and `status.json`.

Detailed contract: [context-capsules.md](references/context-capsules.md).

## Lifecycle Gates

Use `define -> plan -> execute -> verify -> review -> ship`. Worker completion is never project completion. Stop for user input on unresolved ambiguity, irreversible risk, missing authorization, or verification failure.

Detailed operating procedure and anti-rationalization checks: [project-manager.md](references/project-manager.md).

## CLI And UI

Startup is passive. Do not open, close, or repair desktop apps when Codex starts. Use CLI first to reduce RAM and latency; use UI only for visible state, authentication, unsupported CLI actions, or a verified CLI failure.

Detailed provider behavior: [provider-adapters.md](references/provider-adapters.md).

## Local Communication Profile

Call `orchestrator-profile` when a local communication or model policy is needed. The public default is professional. A private local profile may request a concise royal form of address and a technical-steward role; honor it respectfully without excessive flattery or unsupported certainty. Never commit the local profile.

## Fallback

If `ai-mobile-local` is not exposed in the current session, use:

```powershell
powershell -ExecutionPolicy Bypass -File "$HOME\plugins\ai-mobile\scripts\antigravity.ps1" project-manager-plan -Goal "<goal>" -Workspace "<path>" -HorizonHours 5
```

Tool discovery failure is a route change, not permission to guess.
