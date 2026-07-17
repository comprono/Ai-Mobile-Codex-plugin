# AI Mobile 1.1.2

This release fixes explicit provider/model routing after a real Claude Fable field failure.

- Explicitly named user models, including Claude Fable, are honored when capacity and safety gates pass.
- Resource reports distinguish callable worker jobs from current Codex and reserved Codex CLI capacity.
- Provider rejection reasons are surfaced instead of generic idle status.
- Disjoint user-mandated worker lanes no longer fail semantic goal-overlap checks; file ownership conflicts remain blocked.
- Added deterministic Fable and Codex CLI routing regressions.
