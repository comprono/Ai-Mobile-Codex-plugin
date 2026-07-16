# AI Mobile 1.1.0 - outcome recovery and task reconciliation

AI Mobile 1.1.0 fixes the failure mode where a diagnostic method such as a review or inspection could accidentally replace the real project outcome.

## Highlights

- Recovers bounded project intent from .codex/PROJECT_OUTCOME.md, .codex/ACCEPTANCE.json, and optional .ai-mobile/project.json.
- Reconciles method-only requests against the operational outcome while preserving explicit user-selected deliverables.
- Adds reconcile-task so corrections revise the existing task instead of creating replacement tasks or orchestration loops.
- Builds a minimal acceptance-linked work graph when the project does not provide one.
- Keeps current Codex on the highest-value unresolved acceptance item.
- Honors the project contract's current acceptance slice when it is unresolved.
- Returns typed recovery actions for rejected or failed worker assignments.
- Returns exact work-graph and acceptance identifiers when a worker handoff is ready for integration.
- Preserves evidence only for unchanged acceptance requirements.

This release does not add manager loops, heartbeats, scheduled polling, automatic desktop launches, or activity-based completion.
