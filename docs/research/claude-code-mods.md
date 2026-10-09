# Claude Code mods: capture, grading, and limits for a prompt-tutor adapter

Research target: Claude Code 2.1.293 for the `claude -p` runs and 2.1.295 for the typed-session runs, because the CLI updated itself during the work. The generated types are from 2.1.295. Sign-in: a Claude Team account. Method: a throwaway mod loaded with `--plugin-dir`. It logged the events it received and was driven in `claude -p` and in a real typed terminal session (a pty). Answers rely on that log and on the TypeScript declarations Claude Code generates for the build (`.claude-plugin/types/claude-code/index.d.ts`), which are newer than the 2.1.277 file in the Claude Code repo. Issue: [#21](https://github.com/shayan-ys/prompt-tutor/issues/21). Decision under test: [ADR 0011](../adr/0011-claude-code-adapter-as-mod.md).

Docs: [mods overview](https://code.claude.com/docs/en/plugins/mods/overview) · [events](https://code.claude.com/docs/en/plugins/mods/events) · [API](https://code.claude.com/docs/en/plugins/mods/api) · [reference](https://code.claude.com/docs/en/plugins/mods/reference) · [admin](https://code.claude.com/docs/en/plugins/mods/admin) · [settings hooks](https://code.claude.com/docs/en/hooks)

## Questions

### 1. Does a Prompt typed at the terminal arrive with `origin.kind === "composer"`?

**Yes.** In a typed session, `Reply with only the word ok.` was logged as:

```json
{"event":"prompt.submit","text":"Reply with only the word ok.","origin":{"kind":"composer"},"wait":false,"turnIdPresent":false,"contextCount":0}
```

`claude -p` reports `{"kind":"sdk"}`. The generated types define a closed set: `composer`, `bridge`, `sdk`, `task-notification`, `scheduled-trigger`, `peer`, `peer-send-message`, `projects-relay`, `channel`, `coordinator`, `observer`, `observer-activity`, `auto-continuation`, `unclassified`, `slack-ping`, and `plugin`. The types say `composer` is stamped only for the user's own gesture at the terminal, and a channel the engine cannot attest arrives as `unclassified`. `bridge` is the user's message through Remote Control from a phone or the web. That is typed by the user, but not at this machine's terminal. Whether to keep `bridge` is a product choice. It was not exercised.

### 2. Do slash commands reach `prompt.submit`, and in what form?

**A skill or prompt command does, as the raw text it was typed with. A mod's own command does not.** `/caveman lite` fired `command.run` (`command: "caveman"`, `args: "lite"`, origin `composer`), then `prompt.submit` with `text: "/caveman lite"`. The spec's preprocessing already removes the leading slash-command token, so this matches the omp rule that slash-command Prompts are included. `/pt-spike-visible`, a command the mod registered itself, fired only `command.run`. Built-in commands such as `/model` and `/clear` were not checked for `prompt.submit`. The `/clear` run logged no `prompt.submit` for `/clear`.

### 3. Does `prompt.submit` ever fire for text the user did not type?

**Yes, but the origin marks it, so filtering on `composer` is enough.** Notifications, schedules, `/loop`, peers, and plugins each have their own `origin.kind` (see question 1). The settings `UserPromptSubmit` hook fires for the same cases without any origin field ([hooks docs](https://code.claude.com/docs/en/hooks#userpromptsubmit)). No subagent, background-task notification, or `/loop` run was exercised. Subagent tool events carry `agentId` instead and do not go through `prompt.submit`; this is from the types and was not observed.

### 4. What does `$.model.complete` accept and return on this build?

**`{ model, prompt, system?, maxTokens?, effort?, timeoutMs? }`, with no tool or schema option.**

- `model` is an alias or a full id, resolved and allowlist-checked like `--model`. `haiku`, `sonnet`, and `opus` all answered. The `opus` call took 991 ms.
- `effort` is `low | medium | high | xhigh | max` and is dropped for models that do not take it.
- `maxTokens` defaults to 1024. The maximum is 64,000 or the model's own output limit, whichever is lower.
- `system` comes after Claude Code's identity block. `prompt` and `system` accept cacheable text blocks.
- The result is `{ isAnswered: true, text, usage }`, or `{ isAnswered: false, reason }`. For an API error, `reason` is `api-error` with `status` and a classified `error` such as `rate_limit` or `overloaded`. API failures resolve; they do not reject.

### 5. Does the grader prompt pass `validateReview` through the JSON-text path?

**Yes: 12 of 12.** `GRADER_PROMPT`, plus the `submit_review` parameter schema and a "return only the JSON arguments" instruction, was sent as `system`, with the Prompt as `prompt`. Each reply was checked by importing `validateReview` from `src/core/grader.ts` in Bun.

| Model | Passed | Mean latency (ms) |
|---|---|---|
| haiku | 6/6 | 1369 |
| sonnet | 6/6 | 1508 |

The cases were: clean, spelling (`responsability`), grammar (`logs shows`), "explain me", terse register (`check logs then push`), and inline code. Both models left the terse and code cases clean, and both labelled "explain me" as grammar, not fluency. One quality gap passed validation: Sonnet quoted the whole sentence for `logs shows` instead of the shortest span. Six Prompts is a smoke test, not the ~20-Prompt trial from #5.

### 6. What happens to background work at exit, `/clear`, and interrupt?

**`/exit` kills it. It survived `/clear` in the one run.**

- `/exit`: a `$.clock.after(5000)` job scheduled from `prompt.submit` never fired. `session.end` fired with reason `prompt_input_exit` and a 4,999 ms budget.
- `claude -p`: the timer died at teardown, as the async-hook docs describe for settings hooks.
- `/clear`: the timer fired. `/clear` was queued behind the running turn, so the timer had probably already run.
- Interrupt (Esc) and `next.signal` were not exercised.

`session.end` gets the SessionEnd budget: 1.5 s by default, about 5 s on this machine. That is enough to finish one or two in-flight Reviews (1–2 s each) but not a queue.

### 7. How should the mod pass text to the CLI?

**Through stdin.** `$.process.run(argv, { cwd, env, stdin, timeoutMs })` writes `stdin` and then closes it. The timeout defaults to 30 s and can be at most 10 minutes. stdout and stderr are each capped at 4 MiB. No argv limit is documented, and stdin avoids the question. `bun --version` ran from the mod.

### 8. How do `$.ui.status` and `$.ui.log` render, and does Claude see them?

**Both show to the user. Neither reaches the model. `$.ui.log` is saved in the transcript file.**

- `$.ui.status` drew `⚠ pt-spike-observer: PT_SPIKE_STATUS_visible_not_model` under the prompt. The `⚠` and the mod name are added by Claude Code. The text appears nowhere in the session's transcript JSONL.
- `$.ui.log` drew a dim `⏺ pt-spike-observer: …` row. The transcript stores it as `{"type":"system","subtype":"informational","level":"notice"}`. That is a display record, not a user or assistant message, and the types say log lines are not sent to the model.
- "Does not reach the model" rests on the generated types and on the transcript record types above. It was not confirmed by asking Claude: that probe merged with another typed line that itself contained `PT_SPIKE`, so its answer is not evidence.
- Consequence: the adapter uses `$.ui.status` for the chip and does not put Review text in `$.ui.log`. Otherwise Findings would be copied into Claude's transcript files.

### 9. Do managed or server policies stop mods here?

**Not at the time of the test; the engine's own view showed no restriction.** From the mod, `$.settings.read()` and `$.settings.read({ source: "policy" })` returned no `allowManagedModsOnly` (on the `sec-default` guard's `pluginConfigs`), `allowManagedHooksOnly`, `disableAllHooks`, or `prependPlugins`.

- The macOS managed-settings file `/Library/Application Support/ClaudeCode/managed-settings.json` is absent.
- `defaults read com.anthropic.claudecode` reports that the domain does not exist, and `/Library/Managed Preferences` is absent.
- The server-managed settings cache `~/.claude/remote-settings.json` is an empty object.

The account is Claude Team, so the built-in `sec-default` guard loads. It restricts only what the organization manages ([admin docs](https://code.claude.com/docs/en/plugins/mods/admin#know-what-happens-by-default)). An admin can still add these flags later. The mod would then stop with no notice to the user, so the Watcher should show when no Claude Code Prompts have arrived.

### 10. Can a Digest run from `session.start` with a stronger model?

**Probably yes; the limits allow it, but no full Digest was run.** `opus` answered through `$.model.complete`. With `effort: "high"` and `maxTokens` up to 64,000, one call fits the Digest's single request. The provider ends a request at ten minutes. Hook execution time does not count time spent waiting on API calls. A Digest started from `session.start` should run in a `$.clock.after` job so the session starts right away; question 6 shows that `/exit` would cut it off.

## Consequences for ADR 0011

- **Confirmed:** `prompt.submit` with `origin.kind === "composer"` is the capture rule. Slash-command Prompts arrive as typed and need no new preprocessing.
- **Corrected:** `$.model.complete` takes `effort`, so the Review model can ask for `medium` and the Digest for `high`, as ADR 0008 does in omp. There is still no tool schema, so the JSON-text path is the only path.
- **Corrected:** Prompt text goes to the CLI over `stdin`, not argv.
- **New:** a Review still pending at `/exit` is lost with the timer. Either `session.end` awaits in-flight Reviews within its budget, or the next `session.start` regrades `pending` records that the mod's earlier sessions left behind. Otherwise they stay `pending`.
- **New:** the chip goes through `$.ui.status` only. `$.ui.log` must not carry Review text, because it is saved in Claude's transcript.
- **Open product choice:** whether `bridge` (Remote Control) Prompts count as the user's own.
- **Policy:** nothing blocks mods today on this Team sign-in. A later admin flag would disable the mod without notice.
- **Not verified:** subagent and `/loop` prompts in practice, Esc interrupt, `bridge`, a full Digest run, and the VS Code panel.
