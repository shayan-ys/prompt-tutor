# Just-in-time Digest instead of a daemon or scheduler

The weekly Digest runs on the first interactive omp session after Friday 12:00 local time, when that Scope's Digest is stale. It runs in the background behind an `O_EXCL` lock file that counts as stale after 10 minutes. It writes that week's `digests/YYYY-MM-DD.html` and `digests/YYYY-MM-DD.json` (the date is the Friday that ends the week), then copies the HTML to `<store>/digest.html` with `<base href="digests/">` so the same relative links work from both places. It announces itself with an omp startup notification. A launchd/cron job or long-running daemon was rejected: it needs per-OS install and uninstall, runs when nobody will read the result, and has no omp context to resolve the grader model. The cost is that a week with no omp session produces no Digest until the next session.

## Consequences

- Moving the previous `digest.html` into `digests/` was rejected: its relative links to `digests/…` would break after the move.
- A week with no reviewed Prompts writes no Digest; the run records that the week was checked, so later sessions do not retry it.
