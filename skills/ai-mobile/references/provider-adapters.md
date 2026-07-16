# Provider Adapters

## Codex

- Require native CLI plus confirmed ChatGPT login.
- Separate workers use ephemeral `codex exec` sessions, JSONL output, an explicit model/effort, and read-only or workspace-write sandboxing.
- A Codex worker consumes the shared plan. Current Codex remains the default executor and integrator.

## Claude Code

- Resolve the native executable on Windows, including the npm-installed executable behind `claude.cmd`.
- Use noninteractive print mode and structured JSON when supported.
- Existing subscription authentication is the default. An explicit `ANTHROPIC_API_KEY` changes billing mode and must be reported.
- Subscription-only policy rejects API/PAYG dispatch unless the lane explicitly permits it.
- Read-only lanes use safe mode, no Chrome, no session persistence, only Read/Glob/Grep tools, structured compact output, and a finite token/lease guard. Claude subscriptions use `/usage` windows; `--max-budget-usd` is reserved for explicitly authorized API/PAYG lanes.
- Do not use `--bare` as the subscription default because it bypasses normal account state.

## Antigravity

- Use `agy --print` with `default-cli-project`, `--add-dir <workspace>`, and sandboxing for ordinary bounded CLI work.
- Use a named project id or conversation only when the caller supplies verified identifiers.
- `allowAntigravity=true` is required because the CLI may request local authorization.
- A private `antigravityReadOnlyConsent=true` preference is honored only for sandboxed read-only CLI lanes. It does not apply to writers, UI automation, authentication, or external effects.
- `needsUi=true` returns a typed blocker; the runtime never opens the desktop automatically.

## Cursor

- Use only a real `cursor-agent` executable.
- Cursor desktop presence alone is not a headless worker.

Every adapter returns bounded text, available usage evidence, exit state, and a typed blocker. Provider prose cannot override boundary or deterministic verification failures.
