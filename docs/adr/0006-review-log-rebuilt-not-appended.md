# Review log rebuilt from Prompt files, not appended

Each Review log page (one per month, for each Scope and for all Scopes together) is rebuilt from that month's per-Prompt JSON files (ADR 0001) and written to a temporary file, then renamed into place. Its bytes depend only on those files, sorted by `captured_at` and then Prompt id, and the page records no time of generation. Appending to the page in place was rejected for three reasons: a pending entry could not later change to reviewed, skipped, or failed; Reviews finish out of order in concurrent omp sessions; and a crash during an append leaves a torn file. Concurrent rebuilds take no lock. Each writer lists the month's files before it rebuilds, and after its rename it lists them again and rebuilds if anything changed, so the last writer always converges on the full set and nothing blocks the omp UI.

## Consequences

- The month of a Review's page is stored in its Prompt record at capture, together with the UTC offset at capture, so changing time zone never moves a Review to a different page or breaks its link.
- macOS loses the `#fragment` when it opens a `file://` URL in the browser (tested with Chrome through `open`, AppleScript `open location`, and `open -a`). Each Review therefore gets a stub page, `log/r/<prompt-id>.html`, containing only a meta refresh to `../YYYY-MM.html#<prompt-id>`. The redirect keeps the fragment. There is one stub for the Scope log and one for the all-Scopes log, and both are written at capture.
- Each rebuild reads a whole month of Prompt files. This is acceptable at one person's volume of Prompts, and retention can prune by month.
