# AI Mobile Implementation Report

Status: lean runtime implemented in v0.5.0; comparative real-project measurement remains ongoing
Research baseline: 2026-07-14
Target: `0.5.0`

## Executive Summary

AI Mobile should become a thin adaptive execution layer for one existing Codex project task. Current Codex remains the accountable working agent: it understands the complete outcome, executes the critical path, integrates changes, verifies the result, and communicates with the user. Claude Code, Antigravity, standalone or native Codex workers, optional Cursor, and a future user-directed ChatGPT consultation path are temporary execution resources, not a hierarchy of managers.

The implementation must optimize successful delivery, not worker activity. A resource is used only when its expected contribution is greater than its handoff, waiting, merge, review, failure, RAM, and billing costs. Small or tightly coupled work stays with current Codex. Independent bounded work can run in parallel. Deterministic tools handle deterministic checks. Premium reasoning is used only where the quality or risk justifies it.

The `0.3.1` runtime carried the previous control-room, continuous-management, heartbeat, polling, and large project-manager implementation inside a 12,000-line monolith. Version `0.5.0` is the subtractive release described here: the six useful tools now run on a small native-first core, and the legacy manager machinery is absent from the executable surface.

This design does not claim that using more models always produces better work. It aims to be the strongest practical local orchestration system by combining four properties that are rarely present together:

1. current provider capacity and capability evidence;
2. Codex continuing real work instead of becoming a status manager;
3. explicit delegation economics and bounded context transfer;
4. measured proof that enabling the plugin improves rather than harms delivery.

## Product Definition

### Purpose

Given one project outcome in one Codex task, AI Mobile helps the current Codex agent decide:

- what it should execute itself;
- whether any work is safely independent and worth delegating;
- which available application, model, and effort level best fits each delegated lane;
- when capacity, reset timing, failure history, RAM, or billing mode makes another route better;
- how to collect and verify results without replaying chats or creating review loops;
- how to continue toward the complete outcome after each verified milestone.

### The User Experience

The user should normally need one invocation:

```text
@ai-mobile Help complete this project efficiently.
Outcome: <measurable result>
Constraints: <important boundaries>
```

There is no required control-room prompt, manager-only mode, provider selection ritual, recurring heartbeat, or status command. The current Codex task remains the visible project conversation. Workers are implementation details. Reports appear only for material transitions, user decisions, verified blockers, and completion.

### Non-Goals

AI Mobile is not:

- a replacement for Codex, Claude Code, Antigravity, Cursor, or ChatGPT;
- an issue tracker, project dashboard, or second conversation system;
- a daemon that invents work or polls forever;
- a requirement to use every available subscription;
- a way to bypass authentication, quotas, permissions, CAPTCHA, or external-action confirmation;
- a universal proxy that intercepts and compresses every provider request;
- a guarantee that multiple agents outperform one capable agent.

## Product Constitution

These rules are ordered. A later rule cannot override an earlier one.

1. **One outcome, one accountable task.** The current Codex task owns the complete project outcome until it is verified, explicitly stopped, or genuinely blocked.
2. **Codex works.** Current Codex executes the critical path by default; invoking AI Mobile must never turn it into a passive manager.
3. **Quality floor before efficiency.** A resource is ineligible if it cannot safely meet the lane's quality and tool requirements, regardless of spare quota.
4. **Delegation must earn its cost.** Delegate only independent bounded work with positive expected net value after all orchestration costs.
5. **Capacity claims require evidence.** Every model, quota, reset, health, and billing claim has a source, observation time, freshness limit, and `known`, `inferred`, or `unknown` confidence.
6. **Context is a contract, not a transcript.** Workers receive the minimum goal, acceptance, constraints, owned boundary, and evidence contract; they read relevant project files locally.
7. **Verification is proportional.** Deterministic checks come first. Independent model review is reserved for risks tests cannot settle and has a bounded budget.
8. **Activity is not progress.** Progress requires a verified artifact, accepted change, passed gate, resolved decision, or materially changed blocker.
9. **Native and headless first.** Use supported CLI, app-server, and structured event surfaces. Open a desktop UI only for an inherently visual, interactive, or authentication-bound step.
10. **The plugin must prove its value.** A release is unacceptable if controlled tests show worse quality, cost, elapsed time, reliability, or user attention than direct Codex.

## Research Conclusions Applied To This Design

### OpenAI

- Plugins now package skills, apps, and app templates across ChatGPT and Codex. The plugin should remain the workflow and policy package; permissioned external connections belong to apps.
- Codex app-server exposes model catalogs, rate-limit snapshots and updates, account usage, thread and turn lifecycle, Goals, token events, interruption, and process lifecycle. These native APIs should replace undocumented local-session reconstruction wherever available.
- GPT-5.6 native multi-agent work is useful for independent bounded work but can increase tokens and performs poorly for ordered chains or shared mutable state. AI Mobile should use native Codex workers opportunistically, not build an always-on agent tree.
- Prompt caching and compaction reward a stable instruction prefix plus a small dynamic task tail. Context capsules should therefore use stable schemas and references rather than regenerated narrative prompts.
- Symphony demonstrates useful proof-of-work, isolation, retries, and reconciliation patterns. Its tracker daemon and organizational control plane are not appropriate as AI Mobile's default user experience.

### Anthropic

- Claude Code provides noninteractive execution, structured output, sessions, model selection, effort selection, tool policies, and lifecycle events.
- The announced separation of subscription and Agent SDK usage was paused. AI Mobile must discover current authentication and billing behavior instead of assuming `claude -p` has an independent pool.
- `--bare` reduces startup context but skips normal OAuth/keychain loading. It can be used only when the selected authentication mode is explicitly compatible; it must never silently switch a subscription user to API billing.
- Claude subagents and dynamic teams can consume substantially more tokens. AI Mobile should start one bounded Claude process, not ask Claude to create another organization of agents.

### Antigravity And Gemini

- Local Antigravity CLI `agy 1.1.1` supports project selection, conversation continuation, model selection, sandboxing, plugins, and noninteractive execution.
- Normal Antigravity work should use that CLI. Desktop DevTools are a fallback for visible project/chat/composer state, authentication, or a demonstrated CLI limitation.
- Model inventory can be CLI-native. Account quota remains unknown when no supported machine-readable source is available; starting the desktop merely to turn unknown into a guess is prohibited.

### Cursor

- Cursor remains an optional provider adapter. This machine currently has no `cursor-agent`, so it is unavailable rather than represented by an editor-launch command.
- A future adapter must require a tested headless agent and structured lifecycle. Opening the Cursor UI is a user-directed fallback, not worker dispatch.

### ChatGPT Consultation

- Community projects demonstrate that Codex can consult a visible, signed-in ChatGPT web conversation for planning, research, and second opinions.
- These bridges depend on browser state and are not official hidden APIs. They are unsuitable for default unattended orchestration.
- A future adapter may support explicit, visible, user-directed ChatGPT consultation. It must reuse the user-selected conversation, expose structured stop reasons, avoid hidden authentication, and never launch or manipulate ChatGPT merely because AI Mobile was invoked.

## Pre-0.5.0 Diagnosis

### Foundations Retained

- The skill keeps current Codex on the critical path.
- The default MCP surface contains only six high-level tools.
- Provider jobs are durable and return compact artifacts.
- File boundaries, attributable changes, deterministic verification, one-failover policy, and private local preferences exist.
- Desktop applications are not supposed to open during startup or passive inventory.
- The public docs already reject polling, heartbeat loops, and premium-on-premium review.

### Problems Removed Or Isolated In 0.5.0

1. The 733 KB monolith was replaced by small routing, capacity, provider, job, verification, and MCP modules; the entrypoint is now a thin dispatcher.
2. `run-project-manager`, `project-manager-status`, continuous cycles, manager-only behavior, heartbeats, and repeated status semantics were removed from the executable MCP surface.
3. Codex model and capacity discovery now uses the native app-server probe when available; unknown evidence remains unknown.
4. Provider ranking is runtime-scored from task fit, measured capacity, billing mode, recent reliability, model policy, and handoff economics instead of a fixed provider order.
5. Antigravity roster discovery is passive and separate from explicit execution authorization. Desktop startup is not part of inventory.
6. New jobs use `.ai-mobile/jobs`; `.antigravity-bridge/jobs` is read-only compatibility input.
7. Semantic overlap, file overlap, duplicate active lanes, unsafe billing, and low-value delegation are rejected before a model starts.
8. Deterministic economic simulations and portable MCP tests now cover the previous duplicate-work failure. Comparative real-project measurement remains an ongoing release criterion rather than a completion claim.

## Target Architecture

The target runtime has four layers. Dependencies point downward only.

```text
Codex skill and six MCP tools
             |
             v
Adaptive execution policy
  - outcome and frontier
  - delegation economics
  - routing decision
  - verification policy
             |
             v
Provider adapters
  - Codex app-server / CLI
  - Claude Code CLI
  - Antigravity CLI
  - optional Cursor CLI
  - future opt-in ChatGPT consultation
             |
             v
Durable job and evidence store
  - contracts
  - events
  - compact results
  - verification evidence
```

### Proposed Module Layout

The existing MCP entrypoint remains stable so install commands and manifests do not break.

```text
scripts/
  ai-mobile-local-mcp.js        # thin compatibility entrypoint
  mcp/
    server.js                   # six tool schemas and dispatch
  core/
    outcome.js                  # root outcome, completion evidence, frontier
    decision.js                 # direct/delegate decision and explanation
    routing.js                  # provider/model selection
    capacity.js                 # normalized capacity evidence
    jobs.js                     # finite job lifecycle
    events.js                   # event journal and subscriptions
    verification.js             # deterministic and risk-based review policy
    reporting.js                # material-transition summaries
  providers/
    contract.js                 # adapter interface and validation
    codex.js                    # app-server first, CLI fallback
    claude.js                   # Claude Code CLI and structured events
    antigravity.js              # agy CLI first, desktop fallback boundary
    cursor.js                   # dormant unless headless CLI passes probe
    chatgpt-visible.js          # deferred, opt-in package
  storage/
    project-record.js           # tiny durable project state
    job-store.js                # request, events, result, evidence
  legacy/
    project-manager.js          # temporary read-only compatibility extraction
  lib/
    context-capsule.js
    process-runner.js
    verification-runner.js
```

No new framework is required. The implementation should use Node's standard process, stream, filesystem, and JSON facilities plus existing project dependencies.

## Canonical Contracts

### Capability Snapshot

```json
{
  "provider": "codex",
  "surface": "app-server",
  "observedAt": "2026-07-14T00:00:00Z",
  "expiresAt": "2026-07-14T00:05:00Z",
  "health": "ready",
  "authMode": "chatgpt-subscription",
  "billingMode": "included-plan",
  "models": [],
  "capacityPools": [
    {
      "scope": "shared-agentic",
      "remainingPercent": 60,
      "resetsAt": "2026-07-14T05:00:00Z",
      "source": "account/rateLimits/read",
      "confidence": "known"
    }
  ],
  "capabilities": ["read", "write", "shell", "structured-events"]
}
```

Rules:

- Missing values stay `null`; they are never replaced with optimistic defaults.
- `billingMode` is independent from health and capacity.
- Shared and model-specific pools are represented separately and intersected only when both apply.
- Model names and effort choices come from the current provider catalog, not public hardcoded lists.
- Cached evidence includes its original source and freshness. A cache never upgrades `inferred` to `known`.

### Work Contract

```json
{
  "schemaVersion": 2,
  "projectOutcome": "complete measurable outcome",
  "laneGoal": "one bounded contribution",
  "acceptanceCriteria": [],
  "workspace": "absolute local workspace",
  "ownedPaths": [],
  "readPaths": [],
  "constraints": [],
  "permissions": "read-only",
  "risk": "low",
  "verification": [],
  "resultBudget": { "maxBytes": 16000, "maxBullets": 12 },
  "delegationDepth": 0
}
```

Every external worker receives one finite contract. It cannot create another AI Mobile run, delegate to another model, broaden its file ownership, or reinterpret the complete project outcome.

### Worker Result

```json
{
  "state": "succeeded",
  "summary": "bounded result",
  "changedFiles": [],
  "acceptanceEvidence": [],
  "verificationEvidence": [],
  "blocker": null,
  "usage": {},
  "providerEvents": [],
  "artifactRefs": []
}
```

Worker prose is never sufficient evidence for success. Writer success requires attributable changes plus the requested verification evidence. Read-only success requires the requested artifact or decision evidence.

### Project Record

The project record is intentionally small:

```json
{
  "outcome": "",
  "completionEvidence": [],
  "currentFrontier": [],
  "decisions": [],
  "activeJobs": [],
  "lastMaterialEvent": null
}
```

It is not a transcript, backlog, dashboard database, or replacement for the host Goal. The host task/Goal remains authoritative when available. The project record stores only cross-provider facts the host cannot represent.

## Decision Engine

### Step 1: Establish The Outcome

Current Codex determines:

- the complete measurable outcome;
- evidence required to claim completion;
- current constraints and protected actions;
- the next dependency-ready frontier;
- the critical path that current Codex should begin immediately.

The plugin must not substitute a nearby milestone for the complete outcome.

### Step 2: Gather One Passive Snapshot

Inventory must:

- call no model;
- open no desktop app;
- start no worker;
- discover installed versions and supported flags;
- query only supported or already-running capacity sources;
- complete from cache when evidence is fresh;
- return compact normalized evidence.

Inventory refresh occurs only when evidence expires, a relevant reset passes, a provider reports quota/auth/outage failure, or the user explicitly requests refresh.

### Step 3: Build Candidate Lanes

A lane is eligible for delegation only if all are true:

1. it is bounded by explicit acceptance criteria;
2. it is independent of current critical-path mutations until integration;
3. writer ownership is disjoint and machine-checkable;
4. its context can be transferred without a transcript or broad source dump;
5. a capable provider is currently available;
6. the likely time or context saving exceeds orchestration overhead;
7. failure will not leave unsafe partial external effects.

If any condition fails, current Codex performs the work directly or serializes it after the dependency clears.

### Step 4: Estimate Net Delegation Value

The router uses a transparent decision, not a permanent model leaderboard:

```text
NetValue =
    expected quality contribution
  + expected parallel time saved
  + expected current-Codex context saved
  + expiring-capacity opportunity value
  - handoff and startup cost
  - expected merge and review cost
  - expected failure and retry cost
  - RAM and process cost
  - billing and permission risk
```

Delegation is allowed only when:

- the provider meets the quality floor;
- `NetValue` exceeds a measured threshold;
- current Codex retains enough capacity for integration and recovery;
- the provider's billing mode is acceptable under the private user policy.

Task affinity is learned from local outcomes by task class, not encoded as universal truth. For example, repeated successful Antigravity browser-analysis jobs can raise its affinity for that local task class, but cannot make Antigravity eligible for a security-critical writer lane that fails the quality floor.

### Step 5: Dispatch At Most Two Useful Lanes

Normal concurrency is zero to two external lanes. Native Codex workers share the Codex pool and reserve. External writers require pairwise-disjoint paths. Read-only workers may overlap only when the questions are independent and their combined result is cheaper than one stronger worker.

The current Codex task continues its critical-path work immediately. It does not wait, poll, or narrate worker activity.

### Step 6: Collect At A Natural Integration Point

The runtime records provider lifecycle events in the background. Current Codex reads each terminal compact result once when its own work reaches the integration point. It requests full diagnostics only for a concrete failed or disputed result.

### Step 7: Verify Economically

Verification order:

1. schema, boundary, and attribution checks;
2. formatter, compiler, unit, integration, or browser checks relevant to the lane;
3. current Codex integration review;
4. one independent model review only for security, architecture, irreversible effects, or uncertainty not resolved by deterministic evidence.

An independent review must have a stated question and result budget. It never receives the full producer conversation. It cannot cost more than the work reviewed unless the risk justification and private policy explicitly permit that spend.

### Step 8: Continue Or Finish

Passing a lane or batch advances the dependency frontier. The task finishes only when the complete acceptance evidence is present. A worker timeout, provider quota reset, or host turn boundary does not redefine success.

## Provider Implementation

### Codex

Preferred integration order:

1. current Codex task for critical-path work;
2. host-native Codex worker when the host exposes bounded spawning;
3. standalone Codex CLI for a durable independent lane when ChatGPT-plan authentication is verified;
4. no Codex worker when the shared reserve would be crossed.

Capacity and lifecycle should move to Codex app-server:

- `model/list` for current model and effort catalog;
- `account/rateLimits/read` plus sparse update events for capacity and reset evidence;
- `account/usage/read` where available for account activity;
- thread/turn events for state and token usage;
- `turn/interrupt` and process lifecycle for cancellation;
- version-generated schemas so future Codex updates are feature-detected.

The existing local JSONL telemetry reader remains a temporary fallback with lower confidence. It is removed after supported app-server behavior passes compatibility tests on the minimum supported Codex versions.

The 15 percent reserve is a private policy default, not a public truth. It applies to the shared Codex pool and protects integration/recovery capacity. Capacity above it remains available for useful current or worker Codex execution.

### Claude Code

The adapter must:

- feature-detect the installed CLI and available flags;
- verify whether authentication is subscription, API key, or unknown before dispatch;
- prevent `ANTHROPIC_API_KEY` from silently converting intended subscription usage into PAYG;
- use structured stream events and exact session ids;
- choose a current catalog model from policy plus measured capacity;
- avoid nested Claude teams and subagents;
- use `--bare` only when its authentication requirements are compatible;
- enforce finite process lease, output limit, permissions, path boundary, and one result contract;
- interpret dollar fields only as API/PAYG budgets, never as subscription balance.

Model preference such as Sonnet-first or a dedicated Fable window remains private local policy. The public plugin discovers current aliases, model-specific windows, and shared windows without assuming their future names.

### Antigravity

The adapter must separate four decisions:

1. `probe`: is `agy` installed and authenticated enough for passive commands?
2. `catalog`: what models and agents does the current CLI expose?
3. `authorize`: did the user permit this provider and required tool permissions for this lane?
4. `execute`: start one finite `agy --print` job with project, conversation, model, mode, and sandbox arguments.

Project and conversation continuation must use native CLI ids. Desktop DevTools are permitted only when the requested operation requires visible state or the CLI returns a typed unsupported blocker. A single repair attempt is allowed for an explicitly needed UI transport; repeated repair/pop-up loops are forbidden.

Unattended execution uses sandboxed permissions unless the user explicitly authorizes a broader exact boundary. `--dangerously-skip-permissions` is never inferred from a general project request.

### Cursor

The adapter returns `unavailable` unless a supported headless agent binary passes a version and structured-output probe. It never launches the editor as a substitute. When a future CLI is present, it implements the same adapter contract and earns work through the same routing policy.

### ChatGPT Visible Consultation

This is deferred until the lean core passes its acceptance suite. The optional adapter will be read-only by default and require explicit user policy. Appropriate tasks include deep planning, research synthesis, or a second opinion when ChatGPT exposes a materially useful separate capability or capacity pool.

It must not become a hidden way to consume another subscription. The user sees the selected conversation, files sent, and stop reason. Browser failure returns one typed blocker and no retry loop.

## Event-Driven Lifecycle

The runtime stores append-only lifecycle events:

```text
queued -> starting -> running -> terminal
                              -> succeeded
                              -> failed
                              -> blocked
                              -> cancelled
```

Transitions come from process exit, structured provider events, filesystem evidence, cancellation, or lease expiry. There is no 20-second or 120-second model polling loop. A zero-model local process may wait on operating-system process and filesystem events.

User-facing reporting occurs only when:

- a lane is accepted and dispatched;
- a material result becomes available;
- a user decision is required;
- a blocker changes the plan;
- the complete outcome is verified.

An unchanged `running` state is not a reportable achievement.

## Context And Token Efficiency

### Stable Prefix

Provider instructions, result schema, safety policy, and task-contract schema remain stable and versioned. Dynamic goal, boundary, and evidence references appear at the end to improve provider prompt caching where supported.

### Small Dynamic Capsule

The worker receives:

- complete project outcome in one bounded sentence;
- one lane goal;
- relevant constraints and decisions;
- exact read/write paths;
- acceptance and verification gates;
- artifact path for the result.

It does not receive the parent transcript, full repository listing, unrelated logs, or previous worker prose. Files are read from the workspace only when relevant.

### Bounded Result

Successful results default to:

- one concise summary;
- changed paths;
- acceptance evidence;
- verification evidence;
- one blocker when incomplete;
- references to larger local artifacts.

Large raw output stays on disk and is referenced by hash/path. Compression proxies are not required for the core because they add protocol and authentication risk. They may be evaluated later as opt-in experiments against measured accuracy.

## Storage Migration

New jobs should use:

```text
.ai-mobile/
  project.json
  events.jsonl
  jobs/<jobId>/
    contract.json
    events.jsonl
    result.json
    result.md
    changed-files.txt
    diff.patch
    verification-evidence.json
    usage.json
```

Migration policy:

- Read existing `.antigravity-bridge/jobs` artifacts for compatibility.
- Never rewrite or delete legacy artifacts automatically.
- Write new lean-core jobs to `.ai-mobile` after the storage feature flag is enabled.
- Provide one explicit migration/cleanup command after at least one stable release.
- Keep credentials, account ids, transcripts, cookies, browser state, and prompt contents out of both stores.

## Private Policy

Public defaults remain provider- and model-neutral. Personal preferences live outside the repository and can define:

- allowed and preferred model families;
- minimum Codex reserve;
- provider authorization defaults;
- subscription-only or PAYG permissions;
- premium model thresholds;
- maximum concurrency and RAM budget;
- tasks that must remain with current Codex;
- tasks permitted for unattended execution;
- optional forms of address and report style.

Policy is declarative data with a schema version and review date. New model names or quota systems should require a profile refresh, not source edits.

## Subtractive Migration Plan

### Phase 0: Freeze And Measure

Deliverables:

- tag the current `0.3.1` behavior as the comparison baseline;
- capture current MCP schema size, startup time, idle memory, passive inventory time, process count, and representative task results;
- build a safe fixture repository that reproduces important long-running project failure classes without credentials, live submissions, or external effects;
- define direct-Codex baselines for the same fixtures.

Exit gate:

- measurements are reproducible from one command and contain no private data.

### Phase 1: Contract Tests Before Extraction

Deliverables:

- black-box tests for the six public tools;
- provider fixture streams for success, auth, quota, timeout, malformed output, and cancellation;
- tests proving no desktop app starts during server startup or inventory;
- tests proving default tool discovery excludes every legacy manager surface;
- billing-mode tests for Claude subscription, API key, and unknown auth.

Exit gate:

- the existing runtime passes the new public-contract suite before code moves.

### Phase 2: Extract The Lean Core Without Behavior Change

Deliverables:

- thin MCP entrypoint and six-tool server;
- normalized provider contract;
- finite job store and process runner;
- existing context and verification libraries moved behind explicit interfaces;
- legacy code isolated in `scripts/legacy` and unreachable without an explicit compatibility flag.

Exit gate:

- public-contract outputs remain compatible;
- default startup no longer imports or parses legacy project-manager code;
- install and diagnostic commands remain unchanged.

### Phase 3: Native Capacity And Lifecycle

Deliverables:

- Codex app-server adapter with generated version-specific schema support;
- Claude structured event and auth/billing adapter;
- native `agy` project/conversation/model adapter;
- dormant Cursor adapter;
- source, freshness, confidence, and billing mode on every capacity row.

Exit gate:

- unknown values remain unknown in all fixtures;
- model/catalog changes require no source edit;
- a provider outage or quota exhaustion produces one typed transition and no retry loop.

### Phase 4: Economic Router

Deliverables:

- direct-versus-delegate gate;
- capability quality floor;
- disjoint-boundary and dependency checks;
- measured overhead estimates;
- private policy filters;
- one-failover policy;
- machine-readable decision explanation.

Exit gate:

- trivial and coupled fixtures remain direct;
- independent fixtures delegate only when their measured expected value is positive;
- Codex begins its own lane before or immediately after dispatch.

### Phase 5: Event-Driven Integration And Reporting

Deliverables:

- append-only local event journal;
- process/file event subscriptions;
- one compact result collection at integration time;
- material-transition reporting;
- restart recovery for finite active jobs.

Exit gate:

- no timer-driven status polling in normal operation;
- a Codex restart can rediscover a live or terminal job without reconstructing its prompt;
- `running` alone cannot satisfy progress or completion.

### Phase 6: Remove Legacy Manager Machinery

Delete after compatibility evidence is collected:

- `run-project-manager`;
- `project-manager-status`;
- continuous-management cycles;
- heartbeat and same-thread reporting actions;
- manager-only execution restrictions;
- supervisor-specific planning schemas;
- fixed 20-second and 120-second polling semantics;
- duplicated advanced provider commands that the normalized adapter replaces.

Retain only a read-only legacy job importer for one deprecation release.

Exit gate:

- repository search finds no executable control-room, heartbeat, or continuous-manager path;
- the default and advanced schema sizes are materially smaller;
- all public lean-core tests and marketplace validators pass.

### Phase 7: Optional ChatGPT Consultation Experiment

Only after Phases 0-6 pass:

- implement behind an explicit private policy flag;
- use a visible signed-in browser session;
- support read-only planning/review first;
- record exact user-approved files and conversation;
- stop once on browser, login, permission, or UI mismatch;
- compare total Codex plus ChatGPT effort against direct Codex.

The adapter graduates only if it improves measured outcomes without creating recurring browser friction.

### Phase 8: Public Release

Deliverables:

- migration notes and rollback instructions;
- updated README, skill, manifest, release notes, architecture docs, and privacy model;
- plugin scanner lint/verify evidence;
- local install and fresh-task smoke test;
- GitHub release with falsifiable benchmark results, not unsupported performance claims.

## Falsifiable Acceptance Standard

### Functional Scenarios

| Scenario | Required behavior |
| --- | --- |
| Trivial edit | Current Codex works directly; no inventory or worker unless required by missing capability. |
| Coupled single-module change | One agent executes serially; no artificial parallel split. |
| Two independent modules | Current Codex and at most one or two bounded workers run concurrently with disjoint ownership. |
| Provider absent | Inventory reports unavailable; Codex continues. |
| Capacity unknown | Router does not claim healthy quota or choose a provider solely from guessed capacity. |
| Codex near reserve | Current Codex retains integration capacity; new shared-pool workers are not started. |
| Claude API key present | Billing mode is explicit; subscription-only policy blocks PAYG dispatch. |
| Antigravity auth/UI required | One typed authorization blocker; no repeated popup or repair loop. |
| Worker timeout | One terminal event and at most one justified provider-diverse failover. |
| Overlapping writer paths | Work is serialized or retained by current Codex. |
| Premium producer | Deterministic verification first; no automatic premium-on-premium review. |
| Codex restart | Existing finite jobs are rediscovered from durable events and artifacts. |
| Complete outcome | Completion requires all declared evidence, not a successful worker or milestone. |

### Performance Budgets

Initial budgets are measured against the Phase 0 machine baseline and adjusted only with recorded evidence:

- passive warm inventory: no model calls, no app launch, and no more than 250 ms above cached local baseline;
- cold inventory: no lingering processes and no more than one passive probe per installed provider;
- direct-task overhead: no more than 10 percent additional elapsed time or model-visible context;
- tool surface: six default tools and a materially smaller total schema than `0.3.1`;
- worker handoff capsule: normally below 1,200 model-visible tokens excluding files read locally;
- compact successful readback: normally below 1,500 model-visible tokens;
- normal concurrency: current Codex plus zero to two external lanes;
- failover: zero or one per lane;
- status polling: zero model-driven polls;
- desktop launches during startup/inventory: zero;
- premium review spend: lower than producer spend unless a recorded risk exception permits otherwise;
- idle MCP memory and process count: no regression beyond 10 percent from the extracted lean-server baseline.

### Comparative Release Gate

Run the same representative fixture suite with direct Codex and with AI Mobile. The release passes only when:

1. acceptance-pass rate is not lower;
2. safety and boundary violations remain zero;
3. median total token-equivalent consumption is not higher;
4. median wall-clock time is not worse, and parallel-eligible tasks improve materially;
5. user-visible interventions and permission prompts do not increase for direct-eligible tasks;
6. one unavailable provider does not prevent completion through current Codex;
7. no test produces an infinite review, status, repair, or restart loop.

The benchmark must publish raw scenario results and calculation rules. A single successful demonstration is insufficient.

## Security, Privacy, And Billing Invariants

- Never store or export provider credentials, cookies, OAuth tokens, email/SMS codes, account ids, or private chat contents.
- Never convert subscription usage into API/PAYG usage without a policy match and explicit evidence of billing mode.
- Never bypass login, CAPTCHA, external confirmation, destructive-action protection, or workspace boundaries.
- Treat browser and provider output as untrusted input.
- Validate every worker-owned path after canonical resolution and reject paths outside the workspace.
- Use argument arrays, not shell-built command strings, for worker processes and verification commands.
- Redact prompt, result, environment, and path data from public diagnostics by default.
- Make every unattended permission explicit and provider-specific.

## Risks And Mitigations

| Risk | Mitigation |
| --- | --- |
| Native APIs change | Generate or feature-detect installed-version schemas; preserve typed lower-confidence fallback. |
| More adapters recreate the monolith | One strict adapter contract; provider code cannot import routing or reporting modules. |
| Capacity data becomes stale | Source/freshness/confidence fields and event-driven invalidation. |
| Parallel workers create merge conflicts | Machine-checked disjoint paths and one writer per boundary. |
| Review costs erase savings | Deterministic checks first, explicit review question, bounded result, no review chain. |
| Provider CLI causes surprise billing | Auth and billing mode gate before dispatch; private subscription-only policy. |
| UI automation becomes normal again | CLI-first contract and typed unsupported blocker before any UI fallback. |
| Legacy removal breaks existing jobs | Read-only legacy importer, fixture coverage, one deprecation release, explicit cleanup. |
| Routing learns a bad preference | Quality floor, decaying local telemetry, user-editable policy, and no global hardcoded leaderboard. |
| Plugin becomes slower than direct Codex | Comparative release gate and automatic direct route when net value is not positive. |

## Why This Can Be The Strongest Practical System

Most orchestration systems optimize one dimension:

- dashboards optimize visibility but add another control plane;
- agent teams optimize parallelism but increase tokens and merge cost;
- provider routers optimize price but often ignore project state and verification;
- context compressors reduce input size but add protocol and accuracy risk;
- single-provider harnesses preserve continuity but cannot use independent subscription capacity.

AI Mobile can combine their useful mechanisms without adopting their full overhead:

1. **One accountable working agent.** Codex remains responsible and productive.
2. **Cross-provider optionality.** Independent resources are available without becoming mandatory.
3. **Capacity truth.** Routing uses current provider evidence, reset timing, and billing mode.
4. **Economic delegation.** Every handoff must justify itself against direct execution.
5. **Native lifecycle.** Supported CLIs and events replace fragile desktop automation and polling.
6. **Minimal context transfer.** Contracts and artifact references replace transcript replay.
7. **Verification economics.** Tests establish cheap confidence before another model is considered.
8. **Graceful degradation.** Missing or exhausted providers reduce acceleration, not correctness.
9. **Future-proof discovery.** Models, efforts, pools, and features are discovered rather than hardcoded.
10. **Measured honesty.** The plugin cannot call itself efficient unless comparative tests prove it.

The differentiator is therefore not the number of AI applications connected. It is the discipline to use exactly the resources that improve the current outcome, while keeping the strongest available agent working and preserving enough capacity to integrate and recover.

## Definition Of Done

The implementation is complete when:

- the six public tools run on the extracted lean core;
- normal startup does not load legacy manager code or open applications;
- Codex, Claude, and Antigravity use native, structured, feature-detected adapters;
- Cursor remains cleanly optional;
- current Codex always owns and advances the critical path;
- routing decisions expose evidence and net-value reasons;
- worker lifecycle is finite and event-driven;
- context and results are bounded;
- deterministic verification precedes model review;
- legacy manager, heartbeat, polling, and continuous-cycle code is removed;
- privacy, billing, marketplace, and compatibility tests pass;
- comparative benchmarks meet every release gate;
- a fresh Codex task can invoke `@ai-mobile` with the short prompt and complete representative complex work with less friction than direct manual coordination.

## Sources

- [Plugins in ChatGPT and Codex](https://help.openai.com/en/articles/20001256-plugins-in-chatgpt-and-codex)
- [Codex app-server protocol](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md)
- [OpenAI multi-agent guidance](https://developers.openai.com/api/docs/guides/responses-multi-agent)
- [OpenAI orchestration and handoffs](https://developers.openai.com/api/docs/guides/agents/orchestration)
- [OpenAI prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching)
- [OpenAI Symphony](https://github.com/openai/symphony)
- [Claude Code programmatic execution](https://code.claude.com/docs/en/headless)
- [Claude Agent SDK plan update](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)
- [Claude Code with Pro or Max](https://support.claude.com/en/articles/11145838-use-claude-code-with-your-pro-or-max-plan)
- [Gemini CLI headless mode](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/headless.md)
- [Gemini CLI quota and pricing](https://github.com/google-gemini/gemini-cli/blob/main/docs/resources/quota-and-pricing.md)
- [12 Factor Agents](https://github.com/humanlayer/12-factor-agents)
- [Addy Osmani's Agent Skills](https://github.com/addyosmani/agent-skills)
- [Get Shit Done](https://github.com/gsd-build/get-shit-done)
- [Codex ChatGPT Control](https://github.com/adamallcock/codex-chatgpt-control)
