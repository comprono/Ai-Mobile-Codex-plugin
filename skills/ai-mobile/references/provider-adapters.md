# Provider Adapters

## Codex CLI

- Require the native CLI and confirmed ChatGPT login.
- Use a separate finite codex exec worker with explicit model, effort, sandbox, ownership, and output limits.
- Protect the shared Codex reserve; unknown shared capacity is not assumed available.
- Codex CLI is never confused with the visible Codex console.

## Claude Code

- Resolve the native Windows executable, including the npm executable behind claude.cmd.
- Use noninteractive structured output and the existing subscription by default.
- Report API-key billing and reject it unless the lane explicitly permits PAYG.
- Read-only lanes disable Chrome and session persistence and use bounded local file tools.
- Exact privately trusted Fable 5 and Sonnet 5 may write clean bounded primary paths only with deterministic verification.

## Antigravity

- Use CLI-first sandboxed work with the declared workspace.
- Require explicit lane authorization or saved read-only consent.
- A UI-required request returns a typed blocker; the runtime never opens Antigravity automatically.

## Cursor

- Use only a real authenticated cursor-agent.
- Cursor desktop presence alone is not a worker.

Every adapter returns bounded output, model identity, available usage evidence, exit state, and a typed blocker. Provider prose cannot override ownership or deterministic verification.
