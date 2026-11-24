# Opt-in combined Digest, and a Digest that teaches

The spec ruled out an all-Scopes Digest because building it sends Findings from separated Scopes to one model in one request. In use, the learner read neither per-Scope Digest: the same mistakes recurred in both Scopes, split across two pages that each half-explained them. The lessons were also too thin to learn from — a lesson capped at 120 words, a one-line rule, and two examples per Pattern.

## Decision

- **`combined_digest` is opt-in.** With `combined_digest: { profile: P }`, one Digest covers every Scope's Prompts and no per-Scope Digest is built. Only sessions and Drainers of profile `P` build it, so the user names the one provider that receives every Scope's Findings. Its store defaults to `$XDG_DATA_HOME/prompt-tutor/all/` (beside the all-Scopes Review log, at `all/digest.html`) and MUST NOT overlap a Scope store. Without the key, ADR 0007 is unchanged. Per-Scope `digest_profile` has no effect while the key is set.
- **Storage stays separated.** Prompt records and Review logs stay in their Scope stores; the combined Digest only reads them. Its archive records the Scope name `all`, which config already reserves.
- **The `@advisor` writes as a teacher, briefly.** For each of the eight largest Patterns with two or more Findings it returns a 25–60-word explanation that contrasts one of the learner's wrong forms with the right one, a self-check tip under 20 words, and three short practice sentences with answers; smaller Patterns keep only their rule and examples, so a week of several hundred Findings stays within one response. The lesson is three to five short bullet lines that open with progress against earlier weeks, and the focus is one sentence. The model also receives this week's counts and each prior Digest's counts and focus, so it can say what improved. Code still validates every Finding id and rejects the result when one of those eight Patterns has no explanation or tip. A first version asked for 150–300-word notes and 60–150-word explanations; on a real week that read as walls of text on a phone.
- **Every distinct example is kept.** The archive stores every distinct example per Pattern, newest first; the page shows four and folds the rest, with each reason folded behind "why".
- **The page is visual first.** Stat cards and a category split bar, the lesson as a list, the focus habit, a bar chart of recurring Patterns linking to their sections, one card per taught Pattern, and compact rows for the rest replace the ranked table.

## Consequences

- Turning on `combined_digest` sends every Scope's Findings to `P`'s `@advisor`; the README's privacy section says so. A user who keeps work and personal providers apart leaves the key unset.
- The combined Digest starts with no history: trends and "vs last" fill in from its own archives, not the per-Scope ones.
- Digest archives grow by the teaching text and the extra examples. Older archives lack `explanation`, `tip`, and `practice`; the renderer skips those parts.
- Output per Digest is several times longer, so a Digest call takes longer and costs more; it already runs beside the review loop (ADR 0002).

## Amendment (2026-11-24): `scope_digests` keeps chosen per-Scope Digests

Turning on `combined_digest` stopped every per-Scope Digest, and with it the per-Scope export notes. A reader allowed to see only one Scope, such as a personal assistant that may read personal notes but never work ones, then had nothing to read: the combined note mixes in the other Scopes' Findings.

`combined_digest.scope_digests` lists Scopes that keep their own Digest beside the combined one, for example `combined_digest: { profile: personal, scope_digests: [personal] }`. A listed Scope's Digest is the ordinary per-Scope Digest: it reads only that Scope's store, is written to it, and is built only by the sessions and Drainers that ADR 0007 allows for that Scope (its `digest_profile`, or its `review_profile` when it has none). `combined_digest.profile` gives no extra right to build it. `digest_export` writes both the combined notes, `(all)`, and each listed Scope's notes. Unlisted Scopes still get no Digest of their own while the key is set.

This adds no provider exposure beyond ADR 0007: the listed Scope's Findings go to the same `@advisor` they would reach without `combined_digest`. It costs one more `@advisor` call per listed Scope each week.

The export follows the same separation on request: `digest_export_scopes` lists which Digests reach `digest_export` (Scope names, and `all` for the combined one). With `digest_export_scopes: [personal]`, a personal vault receives only the personal notes, never `(work)` or `(all)` ones, while the combined Digest is still built in its own store. Without the key, every built Digest is exported.

Because the new key arrives weeks after the per-Scope Digests stopped, `/prompt-tutor digest --since YYYY-MM-DD` builds missed weeks on request, oldest first, under the same routing, and a backfilled week does not move `digest.html` off a newer week.
