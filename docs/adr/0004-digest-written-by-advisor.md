# The Digest is an `@advisor` analysis; code verifies and counts

_Since [ADR 0008](./0008-grader-via-task-role.md), the model is the `@task` role's, not `@advisor`'s._

Each week, the `@advisor` model receives the week's Findings, each with the sentence that contains it, and the Patterns of the last six Digests. It groups the Findings into Patterns, reuses an earlier Pattern's id when the error is the same kind (it decides that "missing article" and "article omission" match), and writes a brief lesson and the focus paragraph. It returns them through a forced tool schema. prompt-tutor checks every Finding id, counts the Findings in each Pattern, picks the examples, and renders the page, so every number and example comes from stored Reviews. The grader's `quote`, `why`, and category vary between runs and give no stable key, so grouping them by code alone left almost every Finding as a one-off. A fixed taxonomy tag on each Finding was rejected because Shayan wants the Digest to read as a lesson about the week, not a tally.

## Consequences

- This supersedes the pre-charting decision that `@advisor` writes only the focus paragraph.
- The Digest request contains Findings and their sentences, not full Prompts or any session context, which is consistent with ADR 0003.
- Output is validated and retried once. If the retry also fails, no Digest is written; the run shows a notification and the next session tries again.
