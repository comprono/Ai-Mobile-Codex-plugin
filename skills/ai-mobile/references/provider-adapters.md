# Provider Adapters

## Standalone Codex CLI

- Status/auth: `codex-cli-status`; dispatch: `submit-codex-job` through the orchestrator.
- Use only when the official CLI is logged in through the ChatGPT plan. Refuse unknown/API-style auth so a subscription workflow cannot silently become separately billed API work.
- Run `codex exec` ephemerally with ignored user config, JSONL output, stdin prompt transport, an exact catalog model/effort, and `read-only` or `workspace-write` sandboxing.
- Share measured capacity, manager reserve, and concurrency with host-native Codex workers. Never create both transports for the same model in one inventory.
- The parent task never reconstructs or manually starts the CLI command; the durable bridge owns launch, cancellation, output parsing, token telemetry, git attribution, and verification evidence.

## Host-Native Codex

- Dispatch boundary: the host's native agent tool, used when the standalone ChatGPT-plan CLI lane is unavailable.
- Pass an exact catalog model and supported effort only when the active skill explicitly returns a bounded native-host action. Never read a plan file merely to reconstruct routine dispatch.
- Receive the worker result directly in the control chat and integrate it once.

## Claude Code

- Status/capacity: `claude-status`, `claude-usage`.
- Dispatch: `submit-claude-job`.
- Readback: `read-job` or aggregate team state.
- Keep bounded runtime and prompt/result artifacts.
- Default to safe-mode, non-persistent sessions. Record the dominant model plus the bounded model mix so helper-model calls do not masquerade as the requested worker model.
- Prefer an exact model id learned from real CLI telemetry over a moving alias. Keep the alias only for quota-window applicability and policy.
- Never infer live runtime state from source control. Consume recorded dependency evidence or report the state as unknown.
- Every Claude lane receives a complexity-adaptive safety lease and output-token ceiling. Direct bridge jobs default to 30 minutes. A budget breach is terminal for that lane and does not trigger a second paid attempt; it does not terminate the project.
- Budget policy is auth-aware: claude.ai subscription auth (Pro/Max/Team/Enterprise, no `ANTHROPIC_API_KEY`) omits `--max-budget-usd` and relies on measured 5-hour/weekly/model quota windows plus the output-token and lease guards; API-key/PAYG/unknown billing keeps a conservative automatic per-worker USD cap. `maxClaudeBudgetUsd=0` means automatic policy, an explicit positive cap is preserved, and no account identifiers or credentials are stored.

## Antigravity CLI

- Status/models: `agy-status`, `agy-models`.
- Dispatch: `submit-agy-job`.
- The CLI can automatically open browser OAuth when its token is absent or stale. Automatic orchestration therefore treats it as authorization-required unless `allowAntigravityCli=true` or an exact `agyModel` was explicitly requested.
- Once explicitly enabled, CLI is the normal low-RAM path.
- Direct bridge jobs default to 30 minutes; orchestration gives read-only Antigravity work 5-20 minutes and writer work 10-60 minutes by complexity unless an explicit lower ceiling is supplied.

## Antigravity Desktop

Use only when project/chat/model/composer visibility is required. Verify intended project, active chat, selected model, and idle composer before submission. Submission is successful only after the message is visibly accepted or a verified bridge job starts.

If the DevTools MCP transport is closed, call `devtools-health` once. Repeated calls cannot revive the same dead transport. Use CLI or restart the host session only when UI control remains required.

## Cursor

- Status: `cursor-status`.
- Dispatch: `submit-cursor-job` only for a verified headless agent.
- `open-cursor` is an explicit UI fallback, never an automatic startup action.
- Direct headless jobs default to 30 minutes; orchestration uses an 8-30 minute read-only lease or a 10-90 minute writer lease.

## Startup

All adapters are passive during Codex startup. Codex/Claude/Antigravity status and auth probes do not run model prompts. Model/catalog discovery must not open desktop applications. UI open/repair commands require an active task need or explicit user request.
