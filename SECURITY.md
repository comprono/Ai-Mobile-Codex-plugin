# Security And Privacy

AI Mobile is a local community plugin. It invokes authenticated command-line tools already installed by the user.

## Runtime Boundaries

- Provider discovery is passive and never opens desktop applications.
- Runtime state is stored under `%LOCALAPPDATA%\AI Mobile\v1`; managed projects receive no orchestration-state files.
- Read-only workers receive declared file boundaries.
- Writer workers run in detached Git worktrees and return patches; they do not edit the primary worktree. Machine-wide storage limits and collection, cancellation, crash, startup, and age cleanup prevent abandoned worktrees.
- Verification commands use an executable allowlist and argument arrays. Inline Node, Python, and PowerShell execution is refused.
- Antigravity uses sandbox mode. AI Mobile does not pass a broad permission-bypass flag.
- Credentials, login, CAPTCHA, purchases, messages, applications, deploys, and other external side effects remain behind explicit project authorization and evidence gates.
- Worker output and stored artifacts are bounded and redacted for common secret formats and user paths.

## Public Repository Rules

Do not commit local state, provider logs, transcripts, screenshots, account identity, quota snapshots, cookies, OAuth tokens, API keys, passwords, private project names, or machine-specific absolute paths.

## Reporting A Vulnerability

Use GitHub private vulnerability reporting for the repository when available. Do not publish credentials, private prompts, or reproducible sensitive data in a public issue.

## Release Checks

Run the lifecycle tests, privacy helper, `git diff --check`, and both public-marketplace and strict-security scanner profiles documented in [CONTRIBUTING.md](CONTRIBUTING.md).
