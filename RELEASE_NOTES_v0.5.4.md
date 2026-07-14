# AI Mobile 0.5.4 - explicit user model mandates

A real thread asked for a substantial improvement "with Fable 5". AI Mobile first targeted Fable through the wrong provider, corrected to Claude/Fable, and was then rejected twice by the economic gate before any worker started. The explicit user selection was defeated and turns were wasted.

0.5.4 makes explicit user selection a first-class routing input:

- New lane field `selectionAuthority`: `router` (default) keeps every token-saving automatic gate; `user` marks a provider/model the user explicitly mandated.
- For user-mandated lanes, the economic gate and small-task overhead warn instead of reject, and the mandate satisfies the premium-model opt-in. Hard gates still win: authentication, quota, billing, ownership overlap, file boundaries, and safety.
- Canonical model-to-provider binding: Fable/Opus/Sonnet/Haiku are Claude, GPT is Codex, Gemini is Antigravity. Mismatched explicit pairs are corrected deterministically inside the same orchestrate-task call, or rejected with one exact actionable error. Fable can never dispatch through Antigravity.
- Per-lane rejection history is durable: repeating the same failed user-mandated lane returns one final hard blocker with a do-not-retry instruction instead of another routing round; a genuinely resolved blocker still dispatches.

Automatic routing economics are unchanged, and regressions cover both observed failures plus the preserved defaults and hard gates.

Restart Codex after updating, then start a fresh Codex task so the new skill and MCP schema load.
