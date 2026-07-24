# AI Mobile 1.4.9

AI Mobile 1.4.9 restores safe Codex worker discovery when Codex Desktop has written a model cache newer than the latest stable standalone CLI.

- A newer cache is accepted only after a fresh native app-server probe returns a non-empty current model roster.
- Invalid caches and failed or empty native probes remain blocked.
- GPT-5.6 Sol, Terra, and Codex Auto Review expose `ultra` effort through the verified native roster.