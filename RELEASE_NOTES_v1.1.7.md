# AI Mobile 1.1.7 - reliable exact Codex restart

AI Mobile now reopens and verifies the exact installed `OpenAI.Codex` desktop package before it starts a detached, model-bound continuation of the same thread. A long-running Codex turn can no longer prevent the desktop app from reopening.

- Opens only the exact `OpenAI.Codex` AppX executable and workspace/thread deep link.
- Treats an already-closed Codex app as a valid restart state.
- Verifies a package-owned desktop process before launching the continuation.
- Runs the same-thread continuation independently with the requested model.
- Records desktop package, process IDs, timestamps, continuation process, and final resume state.
- Never falls back to Classic ChatGPT or `codex app`.
- Uses atomic BOM-free JSON state shared by PowerShell and Node.
