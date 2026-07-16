# AI Mobile 0.5.5 - catalog-aware resource routing

AI Mobile now selects standalone Codex workers from the current native model catalog instead of taking the first allowed model. The selection is generic: it uses catalog capability metadata, supported reasoning efforts, current capacity, task complexity, and the user's private policy. It is not hardcoded for Sol, Terra, Luna, or any other model family.

This release also adds a privacy-preserving passive active-work signal from Codex app-server, plus two required-by-workflow handoff fields for new lanes:

- `expectedContribution`: the decision, patch, or verification the worker must add beyond current Codex work.
- `integrationAction`: what current Codex will do with a successful result.

The public six-tool surface and existing calls remain compatible. No desktop app is opened by inventory, and no chat content, thread title, or thread identifier is stored in capacity data.

Restart Codex after updating, then begin a fresh task to load the new skill and MCP schema.
