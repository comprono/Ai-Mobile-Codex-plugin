# Contributing

Thanks for improving the AI Mobile Codex Plugin.

## Scope

This repository is a community Codex plugin for connecting mobile-started OpenAI Codex sessions to local Windows AI workers. Contributions should preserve the delivery-first contract: current Codex keeps the critical path, capacity is inspected once, only bounded independent work is delegated, results are collected once, and deterministic verification precedes model review. Antigravity direct CDP/UI behavior remains on demand; normal startup must stay passive.

Do not add manager loops, automatic Goals, recurring chat heartbeats, repeated status polling, premium-on-premium review chains, or another always-loaded MCP server to the default workflow. Advanced compatibility code must remain outside the six-tool normal surface.

Do not add claims that the plugin is official unless the project status changes and the repository owner documents that clearly.

## Development Checks

Before opening a pull request, run:

```powershell
powershell -ExecutionPolicy Bypass -File ".\scripts\antigravity.ps1" privacy
node .\scripts\reliability-e2e.js
powershell -ExecutionPolicy Bypass -File ".\scripts\antigravity.ps1" self-test
git diff --check
python -m pipx run plugin-scanner lint . --profile public-marketplace
python -m pipx run plugin-scanner lint . --profile strict-security
python -m pipx run plugin-scanner verify . --format json
```

`plugin-scanner verify` may safety-skip stdio MCP execution and request manual review. That is expected for executable MCP server entries; document the result in the pull request.

## Privacy

Do not commit local Antigravity logs, screenshots, chat contents, project names, runtime ports, CSRF tokens, OAuth tokens, cookies, API keys, or personal identifiers.

Use environment-variable examples such as `%USERPROFILE%`, `%APPDATA%`, and `%LOCALAPPDATA%` instead of machine-specific absolute paths.
