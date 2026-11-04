# Just-in-time Digest instead of a daemon or scheduler

The weekly Digest runs on the first interactive omp session after Friday 12:00 local time, when that Scope's Digest is stale. It runs in the background behind an `O_EXCL` lock file that counts as stale after 10 minutes. It writes that week's `digests/YYYY-MM-DD.html` and `digests/YYYY-MM-DD.json` (the date is the Friday that ends the week), then copies the HTML to `<store>/digest.html` with `<base href="digests/">` so the same relative links work from both places. It announces itself with an omp startup notification. A launchd/cron job or long-running daemon was rejected: it needs per-OS install and uninstall, runs when nobody will read the result, and has no omp context to resolve the grader model. The cost is that a week with no omp session produces no Digest until the next session.

## Consequences

- Moving the previous `digest.html` into `digests/` was rejected: its relative links to `digests/…` would break after the move.
- A week with no reviewed Prompts writes no Digest; the run records that the week was checked, so later sessions do not retry it.

## Amendment (2026-10-26): the Drainer builds Digests too

The first interactive omp session after Friday 12:00 never ran for a Scope whose Prompts come almost only from Claude Code. Work Prompts were reviewed by Drainers (ADR 0011) whose working directory resolved to the personal Scope, so no Drainer qualified for the work Scope, and the only sessions that did were short headless omp runs. `session_start` also scheduled the Digest with no interactive check. A headless run took `digests/.lock`, exited mid-Digest, and left the lock until it went stale: 558 work Prompts over three weeks produced no Digest.

- **Only interactive sessions run the check.** `session_start` runs the Digest check only when `ctx.mode === "tui"` and the agent is the main agent. Print, RPC, and JSON runs, Drainers, and subagents never start a Digest from `session_start`. Retention pruning still runs in every session (ADR 0009).
- **A Drainer builds its profile's Digests.** It checks at start and then every hour while it runs, in a loop that is separate from the review loop, so a long Digest never delays a Review. The hourly check also picks up a week that became due after Friday 12:00, and retries a Digest that failed. It uses the Drainer's own `@advisor` and `runDigest`, with the same lock, week marker, and ten-minute stale rule. Digest outcomes go to the Drainer's log (stderr). It stops with the Drainer's abort signal: a pending grader call is dropped, the Digest leaves no marker, and the next check retries it. Which Scopes a Drainer may digest is in ADR 0007.
- Every Scope still gets one Digest per week from whichever allowed process reaches it first; the lock keeps an interactive session and a Drainer from building the same one twice.
