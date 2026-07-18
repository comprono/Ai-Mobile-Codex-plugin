# AI Mobile 1.1.8

## Fixed

- Replaced direct execution from the protected `WindowsApps` directory with Windows `shell:AppsFolder` activation for the exact `OpenAI.Codex` package.
- Opens the same Codex thread through its registered `codex://threads/<thread-id>` link before the detached, model-bound continuation begins.
- Preserves exact-package verification, the no-Classic-ChatGPT rule, and one-shot handoff evidence.
