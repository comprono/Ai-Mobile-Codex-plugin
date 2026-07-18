# AI Mobile 1.1.6 - exact Codex restart and authoritative task state

AI Mobile 1.1.6 fixes two field failures that could interrupt work or misreport progress.

- Restarts only the installed `OpenAI.Codex` package; Classic ChatGPT is never used as a fallback.
- Reopens the exact workspace and `codex://threads/<thread-id>` deep link.
- Resumes the same thread through Codex CLI with an exact requested model such as `gpt-5.6-luna`.
- Removes the installer-capable `codex app` launch path.
- Refreshes a matching durable task from the project-authoritative `.codex/ACCEPTANCE.json`.
- Keeps explicit unrelated user outcomes isolated and creates no duplicate task.
- Reports whether work is actually running, ready for current Codex, blocked, or complete.

The release remains finite and event-driven: no manager loop, heartbeat, automation, repeated polling, or automatic provider UI launch was added.
