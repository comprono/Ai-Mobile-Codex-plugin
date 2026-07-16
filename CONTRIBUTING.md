# Contributing

AI Mobile is a community Codex plugin for finite, capacity-aware use of local AI CLIs.

## Engineering Contract

Contributions must preserve these invariants:

- current Codex works on and owns the critical path;
- external workers receive only bounded, disjoint, acceptance-linked work;
- total delegation and integration cost must be lower than the expected contribution;
- runtime state stays under `%LOCALAPPDATA%\AI Mobile\v1`, outside managed projects;
- writers use isolated Git worktrees and return patches;
- multi-project state and evidence remain isolated, and machine-wide leases prevent provider, quota, file, and storage conflicts;
- cached negative provider evidence is refreshed before dispatch rejection;
- completion requires acceptance evidence;
- startup and discovery never open desktop applications;
- no manager loop, Goal, heartbeat, automation, repeated poll, or premium review chain is added.

## Development Checks

```powershell
node .\scripts\self-test.js
node .\scripts\state-capacity-regression.js
node .\scripts\orchestration-regression.js
node .\scripts\economic-regression.js
node .\scripts\worker-isolation-regression.js
node .\scripts\reliability-e2e.js
powershell -ExecutionPolicy Bypass -File ".\scripts\antigravity.ps1" privacy
git diff --check
pipx run plugin-scanner lint . --profile public-marketplace
pipx run plugin-scanner lint . --profile strict-security
pipx run plugin-scanner verify . --format json
```

The scanner may request manual review for a local executable stdio MCP entry. Document that result rather than weakening the MCP behavior.

## Privacy

Do not commit provider sessions, local task state, prompts, transcripts, account data, personal paths, screenshots, project names, cookies, credentials, or quota snapshots. Use `%USERPROFILE%`, `%APPDATA%`, and `%LOCALAPPDATA%` in examples.
