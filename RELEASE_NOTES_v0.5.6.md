# AI Mobile 0.5.6 - parallel read-only review lanes

This patch fixes a routing failure where a Claude Sonnet review was rejected because it shared project words with the active Sol Ultra task. A bounded read-only evidence lane can now run beside an active Codex implementation lane when its file scope is explicit and non-overlapping.

Writers, overlapping file boundaries, missing independence evidence, billing gates, quota gates, and safety gates remain enforced.
