# Failed Reviews are regraded on request by the Scope's Drainer

Status: Accepted (2026-11-24). Amends ADR 0011.

A Review fails for good after its retry (ADR 0008), and nothing reviewed it again: the omp session that captured a Prompt grades it once, and the Drainer took only `pending` Claude Code records (ADR 0011). When a profile's `@task` role had no available model for weeks, about 230 personal Prompts failed with `grader failed: No available model is configured for @task.` Fixing the role did not bring their Reviews back, so that time was missing from the Review log and the Digest.

## Decision

- **The user asks for it.** `prompt-tutor regrade --failed [--scope NAME] [--since YYYY-MM-DD] [--dry-run]` returns failed records to `pending` and marks them `regrade: true`. Nothing regrades on its own, so a broken provider cannot make a loop of failing calls, and the user chooses when the cause is fixed.
- **Only grader failures.** A record qualifies when its `failure` starts with `grader failed:`: the call threw, which covers a missing model, provider and network errors, usage limits, and stalls. `invalid Review after 2 attempts` means the model answered twice and both answers failed validation; another try would most likely fail the same way, so those records stay failed. Skipped Prompts (`too_long`, `nothing_to_review`) never reach a grader and are untouched.
- **The Scope's Drainer reviews them.** A `regrade` record is drained like a Claude Code record: by the Drainer of the Scope's `review_profile`, through the same `review()`, lock, and log rebuild. The CLI has no model access of its own, and the Drainer already runs one headless omp per `review_profile`. `review()` removes the mark when the record settles.
- **A Scope without `review_profile` keeps its failures.** No Drainer would take the records, so `regrade` counts them and leaves them `failed` rather than queueing them forever.

Rejected:

- **Regrade in the capturing profile.** An omp record stores the session's `profile`, and the original Review went to that profile's `@task`. Grading there would need a Drainer for every profile that ever captured a Prompt, not one per `review_profile`, and the profile that failed is often the one whose role is still broken.
- **Automatic retry after a delay.** It needs a schedule, which the product rules out, and it would retry failures the user has not fixed.

## Consequences

- **Provider exposure.** A regraded omp Prompt goes to the `@task` model of its Scope's `review_profile`, which may differ from the profile that captured it (for example, a work-profile session in a personal directory). That profile already receives the Scope's Claude Code Prompts and, under ADR 0007, its Findings, so the Prompt reaches the provider the user named for that Scope. The README privacy section says this.
- **ADR 0011's rule narrows.** "Nothing regrades `pending` omp records" now reads: nothing regrades them unless `prompt-tutor regrade` marked them. The Watcher shows a marked record as `queued` until a Drainer holds its Scope's lock.
- **Record format.** `regrade` is a new optional field. An older prompt-tutor ignores it: its Drainer leaves the record `pending` and its Watcher shows a spinner, so upgrade the profile of each `review_profile` before regrading.
