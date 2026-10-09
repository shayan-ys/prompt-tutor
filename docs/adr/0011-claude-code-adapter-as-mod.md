# Claude Code adapter as a Claude Mod

Status: Proposed (2026-10-09). This ADR becomes Accepted when [issue #21](https://github.com/shayan-ys/prompt-tutor/issues/21) closes.

prompt-tutor gets a second adapter for Prompts typed into Claude Code. The adapter is a [Claude Mod](https://code.claude.com/docs/en/plugins/mods/overview), which Claude Code added in v2.1.287 on 2026-10-01. A mod is a plugin whose JavaScript runs inside Claude Code. The adapter lives in `src/claude-code/`, next to `src/omp/`, and is published as a plugin. Shayan asked for Claude Code coverage on 2026-10-09. Until now, the map listed "Adapters for other harnesses (Claude Code `UserPromptSubmit`, Codex)" as out of scope.

A mod is the only Claude Code mechanism that can keep the omp adapter's guarantees:

- **Only typed Prompts.** `prompt.submit` carries a closed `origin` set, so the adapter can keep only the user's own Enter (`composer`). It drops `sdk` (`claude -p`, the Agent SDK) and Claude Code's own submissions: notifications, peer sessions, schedules, `/loop`, and other plugins. This matches the omp rule `source === "interactive"`. The settings `UserPromptSubmit` hook has no origin field. Its documentation says it also fires for scheduled tasks, `/loop`, background subagent reports, and peer messages, so the grader would review text that the user never wrote.
- **Out of band.** The hook schedules its work with `$.clock.after(0, …)` and returns `next(e)` unchanged. It never sets `text` or `context`. The chip uses `$.ui.status`, which Claude does not read.
- **Prompt text only, no extra credentials.** `$.model.complete` sends one prompt with no conversation history, using the session's own Claude credentials. This keeps ADR 0003's rule that the grader receives only the Prompt. It also means the Prompt goes to the same account and provider that the Prompt itself was just sent to. A settings hook has no model access. It would need a separate API key, or a `claude -p` call that fires the hook again.

## Consequences

- The hooks module has no Node APIs, so the mod cannot import `src/core`. Instead it calls the `prompt-tutor` CLI through `$.process.run` for capture, validation, storage, Review log rebuilds, and retention. Bun must be on the PATH that Claude Code runs with. Core's `review()` splits into two steps, "build the grader request" and "validate and settle", and the model call runs in the mod between them. The omp adapter keeps calling the combined step.
- `$.model.complete` has no forced tool call (checked against the 2.1.277 types; issue #21 rechecks the installed build). Reviews therefore use the spec's existing fallback: JSON text that passes the same validation. ADR 0008's `@task` and `@advisor` roles have no equivalent in Claude Code. The mod's `userConfig` names a Review model and a Digest model instead. Defaults are chosen from issue #21's grader trials.
- Scope rules stay the same. A Claude Code Prompt records `profile: "claude-code"`, so `when.profile` and `when.cwd` work without a format change. `digest_profile: claude-code` routes a Scope's Digest (ADR 0007) to Claude Code sessions.
- Where it works: the CLI and the Desktop Code tab capture and show the chip. The VS Code chat panel captures but shows no chip. `claude -p`, the Agent SDK, cloud sessions, and Desktop WSL sessions are not reviewed. The Watcher and the Review log need no change.
- Risk: mods are new, and every release since 2.1.287 contains mod fixes. Keep the mod thin and cover it with `claude plugin test`. An organization's managed `allowManagedModsOnly`, `allowManagedHooksOnly`, or `disableAllHooks` turns the mod off without any notice to the user. The effective policy for Shayan's work sign-in is not verified yet (issue #21).
- Every Claude Code Prompt in a Scope uses one model call on the signed-in account. The README privacy section must name this second provider route.
- The spec's "Scope and out of scope" section and the map's out-of-scope list change once this ADR is accepted. `docs/spec.md` gains a Claude Code adapter section that follows the omp one.
