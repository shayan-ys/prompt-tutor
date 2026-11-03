# Opt-in combined Digest, and a Digest that teaches

The spec ruled out an all-Scopes Digest because building it sends Findings from separated Scopes to one model in one request. In use, the learner read neither per-Scope Digest: the same mistakes recurred in both Scopes, split across two pages that each half-explained them. The lessons were also too thin to learn from — a lesson capped at 120 words, a one-line rule, and two examples per Pattern.

## Decision

- **`combined_digest` is opt-in.** With `combined_digest: { profile: P }`, one Digest covers every Scope's Prompts and no per-Scope Digest is built. Only sessions and Drainers of profile `P` build it, so the user names the one provider that receives every Scope's Findings. Its store defaults to `$XDG_DATA_HOME/prompt-tutor/all/` (beside the all-Scopes Review log, at `all/digest.html`) and MUST NOT overlap a Scope store. Without the key, ADR 0007 is unchanged. Per-Scope `digest_profile` has no effect while the key is set.
- **Storage stays separated.** Prompt records and Review logs stay in their Scope stores; the combined Digest only reads them. Its archive records the Scope name `all`, which config already reserves.
- **The `@advisor` writes as a teacher.** For each Pattern with two or more Findings it returns an explanation (60–150 words, quoting the learner's own sentences), a self-check tip, and three practice sentences with answers. The lesson becomes a 150–300-word teacher's note that opens with progress against earlier weeks, and the focus paragraph names one habit. The model also receives this week's counts and each prior Digest's counts and focus, so it can say what improved. Code still validates every Finding id and rejects a Pattern of two or more Findings with no explanation or tip.
- **Every distinct example is kept.** The archive stores every distinct example per Pattern, newest first; the page shows six and folds the rest.
- **The page reads like a lesson.** The ranked table is replaced by one card per recurring Pattern: rule, explanation, tip, examples with their reasons, and practice with hidden answers.

## Consequences

- Turning on `combined_digest` sends every Scope's Findings to `P`'s `@advisor`; the README's privacy section says so. A user who keeps work and personal providers apart leaves the key unset.
- The combined Digest starts with no history: trends and "vs last" fill in from its own archives, not the per-Scope ones.
- Digest archives grow by the teaching text and the extra examples. Older archives lack `explanation`, `tip`, and `practice`; the renderer skips those parts.
- Output per Digest is several times longer, so a Digest call takes longer and costs more; it already runs beside the review loop (ADR 0002).
