# Provider Adapters

## Codex

- Require native CLI plus confirmed ChatGPT login.
- Separate workers use ephemeral `codex exec` sessions, JSONL output, an explicit model/effort, and read-only or workspace-write sandboxing.
- A Codex worker consumes the shared plan. Current Codex remains the default executor and integrator.

## Claude Code

- Resolve the native executable on Windows, including the npm-installed executable behind `claude.cmd`.
- Use noninteractive print mode and structured JSON when supported.
- Existing subscription authentication is the default. An explicit `ANTHROPIC_API_KEY` changes billing mode and must be reported.
- Do not use `--bare` as the subscription default because it bypasses normal account state.

## Antigravity

- Use `agy --print` with `default-cli-project`, `--add-dir <workspace>`, and sandboxing for ordinary bounded CLI work.
- Use a named project id or conversation only when the caller supplies verified identifiers.
- `allowAntigravity=true` is required because the CLI may request local authorization.
- `needsUi=true` returns a typed blocker; the runtime never opens the desktop automatically.

## Cursor

- Use only a real `cursor-agent` executable.
- Cursor desktop presence alone is not a headless worker.

Every adapter returns bounded text, available usage evidence, exit state, and a typed blocker. Provider prose cannot override boundary or deterministic verification failures.
