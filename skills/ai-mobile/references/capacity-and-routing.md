# Capacity And Routing

## Evidence Order

1. Fresh measured provider quota/usage window.
2. Current host tool schema or model catalog.
3. Observed successful run telemetry.
4. Fresh safe cache validated by source timestamp/hash.
5. Caller-provided visible state.
6. Unknown.

Do not turn unknown into healthy.

## Codex

- Read current model ids and supported reasoning efforts from the host agent tool schema when available; use `models_cache.json` as the passive catalog fallback.
- `codex-usage` accepts only local JSONL rows where `type=event_msg` and `payload.type=token_count`. It returns capacity windows and numeric token totals only.
- The local event schema is undocumented. If it changes or the event is stale, fail closed.
- The five-hour and seven-day windows currently govern shared Codex agentic usage; do not claim model-specific buckets unless the source explicitly provides one.
- Select effort from that model's supported list. Low work uses low; normal work uses the model default; high work uses high; xhigh/max/ultra require material complexity or risk. Never spend maximum effort just because it exists.
- Local policy may restrict the catalog to a current family such as Sol/Terra/Luna. The policy has a review date so model changes do not require code changes.

## Claude Code

- Discover aliases from current CLI help and exact model ids from completed-run telemetry.
- Read `/usage` without sending a model prompt.
- Apply shared session/all-model windows to every model, plus any model-specific row only to that model.
- A separate Fable row means a dedicated Fable window for that account at that time. Do not assume another model has a separate limit without a row.
- Favor a fast bounded model for small work, Sonnet-class capacity for substantial coding, and premium models only when quality/risk or a healthy dedicated near-reset opportunity justifies them. Keep critical Claude work at `high` by default; use `xhigh` or `max` only when explicitly justified and supported because maximum effort can spend substantially more tokens.

## Antigravity

- Discover CLI models without opening the desktop.
- Read live per-model percentage/reset data only when the local service is already running.
- Prefer Flash-class capacity for low-risk discovery/drafting. Escalate for complex implementation or review only when quality and capacity justify it.
- Use desktop DevTools only for visible project/chat/model/composer state.

## Cursor

- A `cursor` executable may only open the editor. Treat Cursor as headless-capable only when a real agent CLI is detected and tested.

## Five-Hour Plan

For each candidate compute capability fit, quality floor, available capacity, reset within horizon, speed, cost/efficiency, project continuity, recent success/failure, file ownership, and independence. Recompute at a stage boundary, provider failure, reset, or stale-evidence threshold; do not poll continuously.
