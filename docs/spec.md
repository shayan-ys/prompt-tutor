# prompt-tutor build specification

This is the build-from specification for prompt-tutor. Normative terms MUST and SHOULD state requirements. The [glossary](../GLOSSARY.md) defines the product vocabulary.

## Scope and out of scope

Sources: [Ticket #2 — Pre-charting design decisions](https://github.com/shayan-ys/prompt-tutor/issues/2), [Ticket #6 — Core/adapter boundary and config file format](https://github.com/shayan-ys/prompt-tutor/issues/6), [Ticket #8 — Digest HTML layout](https://github.com/shayan-ys/prompt-tutor/issues/8), [ADR 0007 — A Scope's Digest runs only in its `digest_profile`](./adr/0007-digest-runs-in-scope-profile.md).

- prompt-tutor MUST review the English of Prompts typed in interactive, main-agent omp sessions, out of band. It MUST NOT edit a Prompt or add tutor output to the agent conversation.
- The product consists of an omp adapter and a harness-independent core. Other harnesses, a daemon, and scheduled jobs are out of scope.
- A Scope groups Prompts, Reviews, and its Digest. The Review log MAY show all Scopes together, locally.
- An all-Scopes Digest is out of scope: it would send Findings from separated Scopes together in one request. The all-Scopes Review log provides cross-Scope browsing without provider exposure.

## Capture

Sources: [Ticket #2 — Pre-charting design decisions](https://github.com/shayan-ys/prompt-tutor/issues/2), [Ticket #5 — Review schema and grader prompt](https://github.com/shayan-ys/prompt-tutor/issues/5), [Ticket #6 — Core/adapter boundary and config file format](https://github.com/shayan-ys/prompt-tutor/issues/6), [ADR 0001 — One JSON file per Prompt instead of SQLite](./adr/0001-per-prompt-json-files.md), [ADR 0008 — Reviews graded by `@task` at medium; the Digest stays on `@advisor` at high](./adr/0008-grader-via-task-role.md).

- The adapter MUST capture only `input` events with `event.source === "interactive"` and `ctx.agent.kind === "main"`. Slash-command Prompts are included.
- The handler MUST return without altering the Prompt. It MUST schedule all I/O and model work with `ctx.setTimeout` and catch all failures so background work cannot fail the omp session.
- Before grading, remove the leading slash-command token, replace each fenced code block with `[code]`, and trim the result. Preserve the resulting preprocessed text for the grader and record. Exclude URLs from the word count; do not count URL text as reviewable words.
- A Prompt with more than 600 words after preprocessing and URL exclusion MUST be skipped as `too_long`; zero words MUST be skipped as `nothing_to_review`. A skip MUST NOT call a grader. The Watcher MUST show the reason and, for `too_long`, the count.
- Capture MUST assign the Prompt id, capture time, local `log_month`, and UTC offset before review is scheduled; write the pending or skipped Prompt record first. It MUST create its Review-log stubs and rebuild the month page at capture, so a pending Review is already linkable.
- An invalid configuration or unmatched Scope MUST produce no Review and MUST NOT fall back to a different Scope. Notify once per omp session.

## Scopes and config file

Sources: [Ticket #2 — Pre-charting design decisions](https://github.com/shayan-ys/prompt-tutor/issues/2), [Ticket #6 — Core/adapter boundary and config file format](https://github.com/shayan-ys/prompt-tutor/issues/6), [ADR 0007 — A Scope's Digest runs only in its `digest_profile`](./adr/0007-digest-runs-in-scope-profile.md), [ADR 0009 — Retention prunes whole Review log months, and only when configured](./adr/0009-retention-by-log-month.md), [ADR 0010 — English is the only target language; explanations can use another language](./adr/0010-english-target-explanation-language.md), [README — Configuration](../README.md#configuration).

- Read YAML from `$XDG_CONFIG_HOME/prompt-tutor/config.yml`, or `~/.config/prompt-tutor/config.yml` when `XDG_CONFIG_HOME` is unset. Re-read it when its modification time changes. With no file, use one `default` Scope and no retention or language override.
- Supported top-level keys are `scopes` (required when a file exists), `all_scopes_log`, `keep_months`, and `explanation_language`. Unknown keys MUST be configuration errors. A malformed config MUST be reported; it MUST NOT be silently replaced with defaults.
- `scopes` is an ordered, non-empty list. Each entry has a unique non-empty `name` (the reserved name `all` is invalid), optional `when`, optional `store`, and optional `digest_profile`.
- A Scope without `when`, or with an empty `when` list, matches all sessions. Otherwise each `when` item is an OR alternative; conditions within one item are ANDed. Supported condition keys are `profile` and `cwd`. The unnamed omp profile is `default`. Expand `~`; match `cwd` against its realpath, and let `dir/**` match `dir` itself. The first matching Scope wins.
- By default, a Scope store is `$XDG_DATA_HOME/prompt-tutor/<name>/`, or `~/.local/share/prompt-tutor/<name>/` when `XDG_DATA_HOME` is unset. `store` overrides this path; a relative path is resolved against the config file's directory.
- `digest_profile` MAY name the only profile allowed to run that Scope's Digest. When omitted, use the sole `profile` condition if there is exactly one; otherwise allow any session resolving to that Scope. An explicit `null` has the latter behavior.
- `all_scopes_log` overrides the directory for the all-Scopes Review log; relative paths are resolved against the config directory. Its default is `$XDG_DATA_HOME/prompt-tutor/all/log/` (normally `~/.local/share/prompt-tutor/all/log/`). A path inside any Scope store MUST be rejected. Write the all-Scopes log only when there are at least two Scopes.
- `keep_months` MAY be null or an integer of at least 2. Missing or null means retain all Review-log months.
- `explanation_language` MAY be a non-empty string of at most 40 characters matching `/^\p{L}[\p{L} ()'-]*$/u`. Missing means `English`.

## Storage format

Sources: [Ticket #5 — Review schema and grader prompt](https://github.com/shayan-ys/prompt-tutor/issues/5), [Ticket #6 — Core/adapter boundary and config file format](https://github.com/shayan-ys/prompt-tutor/issues/6), [Ticket #11 — Review log: one HTML file with a stable anchor per Review](https://github.com/shayan-ys/prompt-tutor/issues/11), [Ticket #12 — Review detail stored for the Digest but not shown in the Watcher](https://github.com/shayan-ys/prompt-tutor/issues/12), [ADR 0001 — One JSON file per Prompt instead of SQLite](./adr/0001-per-prompt-json-files.md), [ADR 0006 — Review log rebuilt from Prompt files, not appended](./adr/0006-review-log-rebuilt-not-appended.md).

- A Scope stores one atomic JSON file per Prompt at `<store>/prompts/<log_month>/<id>.json`; write a temporary file, then rename it into place. Do not use SQLite. Files written by prompt-tutor MUST have mode `0600`.
- Every Prompt record MUST include `version: 1`, `id`, `scope`, `profile`, `cwd`, `captured_at` (ISO 8601 UTC with milliseconds), `utc_offset_minutes` (minutes east of UTC at capture), `log_month` (`YYYY-MM` in local time at capture), preprocessed `text`, `word_count`, and `state` (`pending`, `reviewed`, `skipped`, or `failed`). The id is sortable UTC time plus six random hexadecimal characters.
- Optional record fields are `skip_reason` (`too_long` or `nothing_to_review`), `review`, `grader`, `failure`, and `settled_at` (ISO 8601 UTC). Readers MUST skip records with a version newer than they support; the Watcher MUST explain that an upgrade is needed.
- A Review has `findings`, `rewrite`, and `tip`. Each Finding has `quote`, `fix`, `category` (`spelling`, `grammar`, or `fluency`), `why`, `kind`, and code-derived `start`/`end` offsets into the stored preprocessed text. The grader does not supply offsets.
- `grader` records `model`, requested reasoning, `prompt_hash`, and `attempts`. The hash MUST cover the actual grader prompt and tool schema used for that Review.
- Digest archives are versioned JSON at `<store>/digests/<YYYY-MM-DD>.json`; their records include the Scope, Friday week, stats, grader versions, lesson, focus, Patterns, and one-offs. HTML is derived output, not the source for trend calculations.

## Review

Sources: [Ticket #3 — omp extension API: grader call, structured output, status and notify](https://github.com/shayan-ys/prompt-tutor/issues/3), [Ticket #5 — Review schema and grader prompt](https://github.com/shayan-ys/prompt-tutor/issues/5), [Ticket #12 — Review detail stored for the Digest but not shown in the Watcher](https://github.com/shayan-ys/prompt-tutor/issues/12), [ADR 0003 — Grader resolved through the omp `@advisor` role, with only the Prompt text](./adr/0003-grader-via-advisor-role.md), [ADR 0008 — Reviews graded by `@task` at medium; the Digest stays on `@advisor` at high](./adr/0008-grader-via-task-role.md).

- Resolve the session profile's `@task` role at call time and request medium reasoning. The grader MUST receive only the preprocessed Prompt text as user content, not a session snapshot or conversation context. Do not use `ctx.runEphemeralTurn`.
- Require a `submit_review` tool result with strict schema: one `findings` array; each Finding has `quote`, `fix`, `category`, `why`, and `kind`; plus `rewrite` and `tip`, each nullable. If the provider returns no tool call, accept text only when it parses as JSON and passes the same validation.
- The grader SHOULD return one Finding per error, with non-overlapping shortest exact quotes made unique as needed; same-register fixes; `why` of at most 15 words; and a free-text 2–5 word `kind`. Do not flag terse coding-agent register, shorthand, URLs, code, identifiers, or clearly pasted text. Flag genuine spelling, grammar, or fluency errors. When errors share words, combine them and use category precedence spelling, grammar, then fluency.
- Validate schema, category, non-empty quote, `fix !== quote`, quote occurrence after the previous Finding, non-overlap, non-empty `kind`, and the rule that `rewrite` and `tip` are null exactly when there are no Findings. The validator MUST reject invalid output. It checks `kind` only for non-empty text; the 2–5 word length is a grader instruction, not a rejection condition.
- Derive offsets from the exact quote in the preprocessed text, searching forward from the preceding Finding. Store the validated Review only. Retry a failed call or invalid response once; after a second failure, persist `failed` and show `EN ?`.
- For zero Findings, store `findings: []`, `rewrite: null`, and `tip: null`; the Watcher shows clean. Otherwise, the Rewrite MUST preserve meaning and register, changing only errors, and the Tip MUST give one transferable rule with a short example in at most 30 words.
- The adapter MUST update the footer chip only while that Prompt is still the session's newest. Pending is `EN …`; clean is `✓`; a reviewed Prompt shows `EN` and nonzero `S`, `G`, `F` counts; a skip shows its reason and count; failure is `EN ?`. Unexpected background failures MUST also resolve to `EN ?`, not escape the session.

## Watcher

Sources: [Ticket #7 — Watcher terminal layout](https://github.com/shayan-ys/prompt-tutor/issues/7), [Ticket #10 — Install method and Watcher on PATH across profiles](https://github.com/shayan-ys/prompt-tutor/issues/10), [ADR 0006 — Review log rebuilt from Prompt files, not appended](./adr/0006-review-log-rebuilt-not-appended.md), [README — Usage](../README.md#usage).

- `prompt-tutor` with no arguments MUST run a read-only terminal Watcher. The Watcher reads records and logs; it MUST NOT write them. It MUST support a one-frame `--once` mode (see "Watcher in a dashboard") and `--help`.
- Implement layout D, “Focus + trail.” The top line shows `all` and Scope views plus `● following latest` or `◀ N newer`. The selected Prompt header shows Scope, capture time, per-category counts, and an OSC 8 `log ↗` link to the stub for the current view.
- Show the Rewrite as a word diff (deletions red with strikethrough; additions green and bold), then the Tip with a yellow bar. Do not repeat the selected Prompt or show a Findings list or `why` in the main body. The full Review is in the Review log.
- Below a dimmed `earlier` rule, show the last three Prompts in the current view, newest first, with time, Scope letter, status, and clipped Prompt. Status is one colored `S`, `G`, or `F` per Finding, `✓ clean`, a pending spinner, `EN ?`, or `– skipped`.
- Use 256-color SGR: spelling pink (213), grammar orange (214), fluency cyan (81); deletions red (203), insertions green (114), and italic Tip. Diffing SHOULD anchor Finding spans before diffing surrounding words so nearby Rewrite changes do not strike out whole phrases.
- The selected states are clean (`✓` and Prompt), pending (spinner, `reviewing… Ns`, dimmed Prompt), failed (`EN ?`, short reason, dimmed Prompt), and skipped (grey reason and clipped Prompt).
- The Watcher follows the newest Prompt in its view. `j` and `k` move older/newer; `s` cycles all → each Scope → following latest. A frame taller than the terminal shows the selected Review body before the trail and ends in `… N more lines`. Scope views link to that Scope's stub; all view links to the all-Scopes stub.

## Watcher in a dashboard

Sources: [Ticket #17 — devdash section: what prompt-tutor shows in devdash](https://github.com/shayan-ys/prompt-tutor/issues/17), [devdash issue #5 — Custom integrations](https://github.com/shayan-ys/devdash/issues/5), [devdash README — Example: prompt-tutor](https://github.com/shayan-ys/devdash#example-prompt-tutor).

- `prompt-tutor --once` is the interface for hosts that embed the Watcher, such as a devdash integration. It remains a stable contract.
- With `DEVDASH_STATE_FILE` unset, `--once` renders the all view following the newest Prompt, without the Watcher's title line, view tabs, follow indicator, or key row. It reads the store and logs but writes nothing.
- With `DEVDASH_STATE_FILE` set, `--once` reads and writes `{"version":1,"view":"all"|"<Scope>","selected":"<Prompt id>"|null}`. Missing, empty, invalid, or unsupported-version state starts in the all view following latest; other fields are ignored. A view for a Scope no longer configured becomes all; a selection no longer in its view follows latest.
- The supported `DEVDASH_ACTION` values are `newer`, `older`, and `scope`: `newer` is the Watcher's `j`/up behavior (at selected index 0 or 1, follow latest); `older` is `k`/down (stays at the oldest Prompt); `scope` is `s` (cycle all → each configured Scope → all and reset selection to following latest). There is no body scroll action: the host scrolls the frame.
- When the state file is set, the frame includes the Watcher's top line with views and the follow indicator, but not its key row. State is written atomically through a temporary file in the same directory, with mode `0600`, only after successful config and store reads.
- `--once` never reads stdin. It sizes the frame width from the terminal, or from `COLUMNS` when stdout is not a terminal, and MUST NOT exceed it. The frame is as tall as the selected Review body and trail; it ignores `LINES` and never clips, so the host scrolls it. It emits only SGR colours and OSC 8 hyperlinks as escape sequences. Without a state file, an action is ignored and nothing is written; with neither variable set, output is unchanged.
- An empty store is not an error: print the empty frame (`No Prompts yet.`) and exit 0. A config or store read failure MUST print nothing to stdout, write one line to stderr, exit 1, and leave the state file untouched. With a state file set, an unknown action MUST write a message to stderr, exit 1, and leave the state file untouched.
- Setup instructions for devdash live in devdash's README; prompt-tutor's README links to them.

## Review log

Sources: [Ticket #6 — Core/adapter boundary and config file format](https://github.com/shayan-ys/prompt-tutor/issues/6), [Ticket #11 — Review log: one HTML file with a stable anchor per Review](https://github.com/shayan-ys/prompt-tutor/issues/11), [Ticket #12 — Review detail stored for the Digest but not shown in the Watcher](https://github.com/shayan-ys/prompt-tutor/issues/12), [ADR 0006 — Review log rebuilt from Prompt files, not appended](./adr/0006-review-log-rebuilt-not-appended.md).

- Build a monthly `<store>/log/YYYY-MM.html` page per Scope, plus `<all_scopes_log>/YYYY-MM.html` when there are at least two Scopes. The all-Scopes page MUST interleave all Scopes' records by `captured_at`, newest first; it is not a concatenation of Scope pages.
- A page is deterministic from that month's Prompt files, sorted by `captured_at` then id, with no generation timestamp. Write to a temporary file and rename. Rebuild on capture and when a Review settles. After each rename, compare the month file listing with the initial listing and rebuild if it changed; use no lock.
- Each Review has an anchor `id="<prompt-id>"`. Write stubs at capture: `<store>/log/r/<id>.html` and, when enabled, `<all_scopes_log>/r/<id>.html`. Each stub contains a meta refresh to `../YYYY-MM.html#<id>` so macOS retains the fragment. Watcher links MUST be percent-encoded `file://` OSC 8 links to the stub, never directly to an anchored monthly page.
- Pages link previous and next months and show time in the stored UTC offset. All-Scopes pages show a stable Scope badge color by config order and a CSS-only Scope filter.
- Use one self-contained HTML file per page, inline CSS, no JavaScript, and light/dark color-scheme support. Entries include local time, word count, state, preprocessed Prompt with Finding highlights and fixes, a Findings table (including `kind`, category, quote/fix, and `why`), Rewrite diff, and Tip. Pending, clean, skipped, and failed states MUST be legible. Include `grader` metadata in a muted line; show attempt count only when greater than one.

## Digest

Sources: [Ticket #2 — Pre-charting design decisions](https://github.com/shayan-ys/prompt-tutor/issues/2), [Ticket #8 — Digest HTML layout](https://github.com/shayan-ys/prompt-tutor/issues/8), [Ticket #12 — Review detail stored for the Digest but not shown in the Watcher](https://github.com/shayan-ys/prompt-tutor/issues/12), [ADR 0002 — Just-in-time Digest instead of a daemon or scheduler](./adr/0002-just-in-time-digest.md), [ADR 0004 — The Digest is an `@advisor` analysis; code verifies and counts](./adr/0004-digest-written-by-advisor.md), [ADR 0007 — A Scope's Digest runs only in its `digest_profile`](./adr/0007-digest-runs-in-scope-profile.md), [ADR 0008 — Reviews graded by `@task` at medium; the Digest stays on `@advisor` at high](./adr/0008-grader-via-task-role.md).

- At `session_start`, check each Scope allowed by the current profile. After Friday 12:00 local time, the first interactive session runs a stale Digest in the background. Run behind an `O_EXCL` lock considered stale after ten minutes. The Digest runs only in sessions of that Scope's `digest_profile`; resolve its `@advisor` at call time and request high reasoning.
- Send that week's Findings, each with its containing sentence, category, `kind`, quote, fix, and `why`, plus Patterns from the last six Digests. Do not send full Prompts or session context. The model MUST assign every Finding id exactly once to a Pattern, reuse a prior id only when it judges the underlying error the same, and return Pattern names/rules, a lesson, and a focus paragraph through a forced tool schema.
- Code MUST validate every Finding id, count Findings, derive categories, select examples, and render. A Pattern is recurring when it appears at least twice this week or appeared both this week and last week; apply the rule to fluency too. Fold one-offs below recurring Patterns. Show up to two distinct, newest-first examples per Pattern as `quote → fix`.
- The brief lesson covers the top one or two Patterns, corrected sentences from the Scope, and one practice point; keep it under 120 words. Keep the focus paragraph under 60 words. Trend lines use the six latest Digest JSON archives, independently of Review retention.
- Render the Report layout: Scope/week, stat cards, focus paragraph, lesson, ranked Pattern table with counts/change/trend/examples, folded one-offs, not-reviewed counts, and archive navigation. Fixed HTML labels remain English.
- Write `<store>/digests/<Friday YYYY-MM-DD>.json` and `.html`, then atomically copy the HTML to `<store>/digest.html` with `<base href="digests/">`. Keep the old alias in place; moving it into `digests/` breaks relative links. A week with no reviewed Prompts writes no Digest and records that it was checked. Validate and retry once; after the second failure, notify and write no Digest so the next session retries.

## Retention and deletion

Sources: [ADR 0001 — One JSON file per Prompt instead of SQLite](./adr/0001-per-prompt-json-files.md), [ADR 0006 — Review log rebuilt from Prompt files, not appended](./adr/0006-review-log-rebuilt-not-appended.md), [ADR 0007 — A Scope's Digest runs only in its `digest_profile`](./adr/0007-digest-runs-in-scope-profile.md), [ADR 0009 — Retention prunes whole Review log months, and only when configured](./adr/0009-retention-by-log-month.md).

- Without `keep_months`, retain all Prompts and Reviews. With `keep_months = N`, keep the current local month and the preceding `N - 1` months, measured by `record.log_month`; expire older months.
- At every omp `session_start`, prune every Scope independently of Digest routing. For each expired month, delete its Review stubs from the Scope log and, when enabled, the all-Scopes log; then delete `log/<month>.html`. Delete the all-Scopes page only when no Scope still has `prompts/<month>/`. Delete each `prompts/<month>/` directory last, so an interrupted prune is retried at the next session. Rebuild the oldest remaining month page for each Scope and the all-Scopes log so previous-month links remain valid.
- Never prune `digests/*` or `digest.html`; trends read the Digest JSON archives. Pruning is local-only. A prune failure MUST be caught and reported as a warning, never thrown into omp.
- Plugin uninstall MUST NOT remove user data. `prompt-tutor --delete-data` is a dry run: print every path that would be removed and exit 0. `--delete-data --yes` performs the removal. Tell users to quit omp sessions first.
- Derive stores from the current config, or from the default one-Scope config when no config exists. In each Scope store, remove only `prompts/`, `log/`, `digests/` (including its lock), and `digest.html`, then remove the store directory only if empty. In the all-Scopes log, remove `r/` and `*.html`, then remove that directory and its parent only if empty. Remove the data home only if empty. Leave and report unknown files. Never delete the config; print its path. Broken config MUST exit 1 with the config error and state that stores are unknown. Renamed/removed Scopes cannot be discovered; users must inspect the default data directory for old stores.

## Language

Sources: [Ticket #2 — Pre-charting design decisions](https://github.com/shayan-ys/prompt-tutor/issues/2), [Ticket #5 — Review schema and grader prompt](https://github.com/shayan-ys/prompt-tutor/issues/5), [Ticket #8 — Digest HTML layout](https://github.com/shayan-ys/prompt-tutor/issues/8), [Ticket #12 — Review detail stored for the Digest but not shown in the Watcher](https://github.com/shayan-ys/prompt-tutor/issues/12), [ADR 0010 — English is the only target language; explanations can use another language](./adr/0010-english-target-explanation-language.md).

- English MUST remain the sole target language. `explanation_language` sets the language for each Finding's `why` and `kind`, the Tip, and Digest Pattern names/rules, lesson, and focus paragraph.
- Keep quotes, fixes, Rewrite, and English example sentences in English. Digest HTML's fixed labels stay English.
- If the setting is absent or equals English case-insensitively, grader and Digest prompts MUST be byte-identical to their English defaults; this preserves the existing Review prompt hash. Otherwise append a short `LANGUAGE` paragraph naming the selected language. Hash the prompt actually used with the corresponding schema so language changes appear as a grader change in the Digest.
- Explanation language does not change which data leaves the machine or which provider receives it.

## Privacy

Sources: [README — Privacy](../README.md#privacy), [Ticket #6 — Core/adapter boundary and config file format](https://github.com/shayan-ys/prompt-tutor/issues/6), [ADR 0007 — A Scope's Digest runs only in its `digest_profile`](./adr/0007-digest-runs-in-scope-profile.md), [ADR 0008 — Reviews graded by `@task` at medium; the Digest stays on `@advisor` at high](./adr/0008-grader-via-task-role.md), [ADR 0009 — Retention prunes whole Review log months, and only when configured](./adr/0009-retention-by-log-month.md), [ADR 0010 — English is the only target language; explanations can use another language](./adr/0010-english-target-explanation-language.md).

- **Provider exposure:** each Prompt's preprocessed text goes to the `@task` model of the omp session's profile. Each week's Findings and their containing sentences go to the `@advisor` model of the session profile allowed to run that Scope's Digest. The profile's role configuration selects the provider; Scope selection does not.
- **Storage:** store each Scope's records, Review log, and Digest separately under `$XDG_DATA_HOME/prompt-tutor/<scope>/` by default. The all-Scopes Review log is a separate local directory. Files MUST be mode `0600`; store only preprocessed Prompt text. `keep_months` controls optional Review retention; `--delete-data` explicitly removes known data paths.
- **Scope separation:** Scopes separate storage and Digests, not providers. The all-Scopes Review log is local and does not create an all-Scopes model request. Explanation language changes the requested output language, not the data or recipients.

## Install, upgrade, and uninstall

Sources: [Ticket #4 — omp distribution: installing a third-party extension and bin script from GitHub](https://github.com/shayan-ys/prompt-tutor/issues/4), [Ticket #9 — OSS setup: license, CI, release process, README, contributor docs](https://github.com/shayan-ys/prompt-tutor/issues/9), [Ticket #10 — Install method and Watcher on PATH across profiles](https://github.com/shayan-ys/prompt-tutor/issues/10), [ADR 0005 — Users install from `main`, with no release ref](./adr/0005-install-from-main.md), [ADR 0009 — Retention prunes whole Review log months, and only when configured](./adr/0009-retention-by-log-month.md), [README — Install](../README.md#install), [README — Uninstall](../README.md#uninstall).

- Require the latest omp and Bun 1.3 or newer. Install separately in every omp profile with `omp plugin install github:shayan-ys/prompt-tutor`, then restart omp. `main` is the normal install source; tags are optional pins.
- In a chosen profile, `/prompt-tutor install-watcher` MUST symlink the installed Watcher into `~/.local/bin` when that directory is on `PATH`, or accept a directory already on `PATH`. Running it again for the same target is harmless; it MUST refuse to replace a non-owned link or file and print the link path. For multiple profiles, run it from the profile whose copy should back the single PATH link.
- Upgrade each profile with `omp --profile <p> plugin upgrade prompt-tutor` (omit `--profile <p>` for default), then restart omp. A pinned-tag user upgrades by reinstalling with a newer tag.
- To uninstall, first run `prompt-tutor --delete-data` if data removal is wanted; the command is not available after unlinking the Watcher. Remove the Watcher symlink only if it points into a prompt-tutor installation, then uninstall prompt-tutor from each profile. Plugin uninstall alone leaves records, Reviews, Digests, locks, and config untouched.

## OSS process

Sources: [Ticket #9 — OSS setup: license, CI, release process, README, contributor docs](https://github.com/shayan-ys/prompt-tutor/issues/9), [Ticket #10 — Install method and Watcher on PATH across profiles](https://github.com/shayan-ys/prompt-tutor/issues/10), [ADR 0005 — Users install from `main`, with no release ref](./adr/0005-install-from-main.md), [README — Contributing](../README.md#contributing).

- License the project MIT. Protect `main`: require pull requests and passing CI, allow squash merges only, and block bypass, force-push, and branch deletion. `main` MUST always be releasable because users upgrade from it.
- The merge gate MUST run `tsc --noEmit`, Biome lint/format, fixture-only `bun test` (no live grader calls), and an install smoke through the real GitHub plugin path. On PRs install the PR head SHA in a throwaway `HOME`; after merges, exercise the exact unpinned install and an upgrade from the previous `main`. The smoke MUST assert `/prompt-tutor` registers, not merely that plugin loading exits successfully.
- Support and test only the latest omp; do not claim a minimum version. Dependabot SHOULD update GitHub Actions and Bun dependencies weekly, grouped.
- Use SemVer tags `vX.Y.Z` and Keep a Changelog. Each user-visible PR adds an `Unreleased` line. A release PR moves that section to a version heading and bumps `package.json`; after merge, tag the merge commit. A tag workflow verifies the tag matches the package version and creates the GitHub Release from that changelog section.

## Open items

Sources: [Ticket #9 — OSS setup: license, CI, release process, README, contributor docs](https://github.com/shayan-ys/prompt-tutor/issues/9), [Ticket #19 — Watcher keys inside devdash](https://github.com/shayan-ys/prompt-tutor/issues/19), [ADR 0007 — A Scope's Digest runs only in its `digest_profile`](./adr/0007-digest-runs-in-scope-profile.md).

- `prompt-tutor --once` accepts devdash key actions through `DEVDASH_ACTION` and keeps navigation state through `DEVDASH_STATE_FILE`; without those variables its original one-frame behavior remains.
- Ticket #9 leaves unverified whether a fork PR's head SHA can be installed through the base repository's GitHub spec; verify that when CI is built and use the fork's own spec if required.
- All-Scopes Digests remain out of scope for the separation reason above; the all-Scopes Review log is the cross-Scope view.
