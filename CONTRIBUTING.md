# Contributing

AI Mobile is a community Codex plugin for finite, capacity-aware use of local AI CLIs.

## Engineering Contract

Contributions must preserve these invariants:

- the visible Codex task remains a zero-file lightweight project console;
- dependency-ready critical-path work is assigned to a separate work-plane worker;
- external workers receive only bounded, disjoint, acceptance-linked work;
- total delegation and integration cost must be lower than the expected contribution;
- runtime state stays under `%LOCALAPPDATA%\AI Mobile\v1`, outside managed projects;
- writers use isolated Git worktrees and return patches;
- multi-project state and evidence remain isolated, and machine-wide leases prevent provider, quota, file, and storage conflicts;
- imported blockers retain their executable owner, trigger, and recovery action;
- safe dependency-ready work is assigned before the console reports;
- cached negative provider evidence is refreshed before dispatch rejection;
- completion requires acceptance evidence;
- startup and discovery never open desktop applications;
- one durable program supervisor owns continuation across finite campaign epochs, process restarts, and recoverable capacity waits until its overall horizon or stop policy is reached;
- whole-program resource caps aggregate every durable attempt and immutable allocation grant across revisions; missing telemetry is committed conservatively, live leases define concurrency, and unknown quota remains unknown;
- no LLM manager loop, Goal, heartbeat, automation, repeated model-turn poll, or premium review chain is added; one finite detached coordinator may advance only on durable transitions and acceptance evidence.

## Development Checks

Run the complete deterministic release matrix:

```powershell
node .\scripts\antigravity-model-identity-regression.js
node .\scripts\app-server-resume-regression.js
node .\scripts\console-workplane-regression.js
node .\scripts\context-freshness-regression.js
node .\scripts\continuation-regression.js
node .\scripts\contract-revision-continuation-regression.js
node .\scripts\director-cfo-budget-regression.js
node .\scripts\director-cfo-campaign-continuation-regression.js
node .\scripts\director-cfo-context-regression.js
node .\scripts\director-cfo-contracts-regression.js
node .\scripts\director-cfo-failed-round-regression.js
node .\scripts\director-cfo-live-inventory-regression.js
node .\scripts\director-cfo-migration-regression.js
node .\scripts\director-cfo-operational-dispatch-regression.js
node .\scripts\director-cfo-program-regression.js
node .\scripts\director-cfo-provider-contract-regression.js
node .\scripts\director-cfo-resource-enforcement-regression.js
node .\scripts\director-cfo-runtime-regression.js
node .\scripts\director-cfo-typed-execution-regression.js
node .\scripts\durable-event-regression.js
node .\scripts\economic-regression.js
node .\scripts\fable-routing-regression.js
node .\scripts\global-resource-regression.js
node .\scripts\installed-runtime-parity-regression.js
node .\scripts\integration-regression.js
node .\scripts\orchestration-regression.js
node .\scripts\outcome-recovery-e2e.js
node .\scripts\portfolio-e2e.js
node .\scripts\program-reporting-regression.js
node .\scripts\program-resource-snapshot-regression.js
node .\scripts\provider-capability-regression.js
node .\scripts\provider-patch-regression.js
node .\scripts\reliability-e2e.js
node .\scripts\release-canary-policy-regression.js
node .\scripts\resource-lease-regression.js
node .\scripts\self-test.js
node .\scripts\shared-host-install-regression.js
node .\scripts\sqlite-observation-regression.js
node .\scripts\sqlite-snapshot-regression.js
node .\scripts\state-capacity-regression.js
node .\scripts\storage-lifecycle-regression.js
node .\scripts\task-cycle-regression.js
node .\scripts\trusted-primary-regression.js
node .\scripts\worker-isolation-regression.js

powershell -ExecutionPolicy Bypass -File ".\scripts\antigravity.ps1" privacy
git diff --check
pipx run plugin-scanner lint . --profile public-marketplace
pipx run plugin-scanner lint . --profile strict-security
pipx run plugin-scanner verify . --format json
```

The authenticated real-provider canaries consume bounded provider requests and are required for a release that changes provider launch, routing, patch transport, portfolio allocation, or integration:

```powershell
node .\scripts\installed-provider-canary.js
node .\scripts\real-provider-portfolio-canary.js
```

For a release that changes the Director lifecycle, run the cloned-state canary against an explicitly authorized durable task. Real workers send only the task's authorized bounded sources to authenticated model providers. The canary guards static production state, confines code changes to isolated worktrees and local operations to the disposable clone, rejects external effects, and requires at least one acceptance-linked result to integrate before it captures the next eligible package without launching it:

```powershell
$env:AI_MOBILE_CANARY_TASK_ID = "task-your-durable-id"
node .\scripts\live-state-release-canary.js
```

The scanner may request manual review for a local executable stdio MCP entry. Document that result rather than weakening the MCP behavior.

## Privacy

Do not commit provider sessions, local task state, prompts, transcripts, account data, personal paths, screenshots, project names, cookies, credentials, or quota snapshots. Use `%USERPROFILE%`, `%APPDATA%`, and `%LOCALAPPDATA%` in examples.
