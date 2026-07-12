# Context Capsules

A capsule packages the minimum durable state required to continue work without replaying a chat.

## Project Capsule

```json
{
  "schemaVersion": 1,
  "workspaceFingerprint": "hash",
  "goal": "bounded outcome",
  "lifecycleStage": "plan",
  "constraints": [],
  "decisions": [],
  "blockers": [],
  "acceptanceCriteria": [],
  "verification": [],
  "workItems": [],
  "fileEvidence": [],
  "continuity": { "summary": "", "artifactRefs": [] },
  "policy": { "transcriptIncluded": false, "oneWriterPerBoundary": true, "maxParallelWriters": 2, "orchestrationDepth": 1 }
}
```

File evidence contains workspace-relative path, type, size, modified time, and a bounded content hash for small files. It does not embed file content. Paths outside the workspace are rejected.

## Worker Prompt

Each worker receives a derived `task-capsules/<workItemId>.json` file containing only:

- the complete goal in bounded form;
- one work item and dependency state;
- ownership/file boundary;
- capsule path;
- acceptance and verification gates;
- current user constraints and protected browser/account boundaries;
- a complexity-sized result limit;
- an explicit no-delegation rule.
- for discovery that unlocks a writer, exact proposed workspace-relative file targets wrapped in backticks for deterministic boundary enforcement.

Workers read relevant local files directly. Never paste full source trees, logs, screenshots, chats, credentials, cookies, email/SMS verification content, OAuth tokens, saved browser credentials, or parent transcripts.

## Freshness

Capsule hashes exclude generation timestamps and change when stable plan content or file evidence changes. Unchanged project and task capsules are reused. Rebuild at a lifecycle boundary or when relevant files/decisions change, not on every poll.

## Readback

Read aggregate state first. Read a single job only for a failed, partial, or disputed item. Compact successful outputs into the final integration view once.
