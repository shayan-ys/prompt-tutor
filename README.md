# prompt-tutor

Review the English of every interactive prompt you send to omp, out of band. prompt-tutor never edits your Prompt or adds tutor feedback to the agent's conversation.

## Demo

No GIF is included: a fixture-only VHS recording has not yet been made.

## What you get

- **Reviews:** spelling, grammar, and fluency findings, a same-register rewrite, and one transferable tip.
- **Watcher:** a colourful terminal view of the latest Review and recent Prompts, with links to the full local Review log.
- **Digest:** a weekly, per-Scope HTML lesson about recurring patterns, with counts, examples, trends, and a focus paragraph.

A static Digest screenshot is not included yet; this repository has no rendered fixture Digest to capture.

## Requirements

- The latest omp release.
- Bun 1.3 or newer (also used by omp's plugin manager and the Watcher).

## Install

Install prompt-tutor separately in each omp profile you use:

```sh
omp plugin install github:shayan-ys/prompt-tutor
```

Restart omp after installing. In the profile you use most, run:

```text
/prompt-tutor install-watcher
```

This symlinks the installed Watcher into `~/.local/bin` when that directory is on `PATH`. Otherwise, pass a directory already on `PATH`, for example `/prompt-tutor install-watcher ~/bin`. The command prints the link path. For several profiles, run the install command in your main profile so the single Watcher link points to that profile's copy.

## Usage

Type Prompts normally in omp. Reviews run in the background and the footer chip updates when the newest Review settles. Start a terminal tab and run:

```sh
prompt-tutor
```

The Watcher reads local records and Review logs; it does not write them. The first interactive omp session after Friday noon may build a stale weekly Digest in the background.

## Configuration

Configuration is YAML at `$XDG_CONFIG_HOME/prompt-tutor/config.yml` (normally `~/.config/prompt-tutor/config.yml`). The first matching Scope wins; conditions in one `when` entry are ANDed, and entries are ORed. This routes the `personal` profile or work under `~/Documents/personal/` to the personal store, with everything else in work:
```yaml
scopes:
  - name: personal
    when:
      - profile: personal
      - cwd: ~/Documents/personal/**
  - name: work
```

With no config file, prompt-tutor uses one `default` Scope. Each Scope stores its Prompt records, Review log, and Digest in its own directory. See [ADR 0007](./docs/adr/0007-digest-runs-in-scope-profile.md) for Digest routing.

## Privacy

1. **Provider exposure per Prompt:** each Prompt is sent to the `@task` model configured for the omp session's active profile. That model may use a different provider from the session's main model. Scope selection does not change which provider receives the Prompt; only that profile's `@task` setting does.
2. **Storage Scope:** the profile and cwd rules decide only where the Prompt and Review are stored.
3. **Digest routing:** a Scope's Digest runs only in sessions of its `digest_profile` (by default, its sole profile condition; otherwise any session resolving to that Scope). Findings from a week are therefore sent to that session profile's `@task` model. This limits which profile runs the Digest, not which providers its data might reach.

## Upgrade

Upgrade each profile separately, then restart omp:

```sh
omp --profile <p> plugin upgrade prompt-tutor
```

For the default profile, omit `--profile <p>`. Users track `main`; SemVer tags are optional pins, not the normal upgrade route.

## Uninstall

First remove the Watcher link at the path printed by `install-watcher`, only if it is a symlink into a prompt-tutor installation. Do not use `rm "$(command -v prompt-tutor)"`, which may select a different executable. Then uninstall from every profile:

```sh
omp --profile <p> plugin uninstall prompt-tutor
```

Stored Prompt records, Reviews, and Digests are not removed by uninstall.

## How it works

See the [glossary](./GLOSSARY.md) and the architecture decisions: [per-Prompt storage](./docs/adr/0001-per-prompt-json-files.md), [just-in-time Digest](./docs/adr/0002-just-in-time-digest.md), [role-based grading](./docs/adr/0003-grader-via-advisor-role.md), [model-written Digest](./docs/adr/0004-digest-written-by-advisor.md), [installing from main](./docs/adr/0005-install-from-main.md), [Review log rebuilds](./docs/adr/0006-review-log-rebuilt-not-appended.md), [Digest profile routing](./docs/adr/0007-digest-runs-in-scope-profile.md), and [grading with `@task`](./docs/adr/0008-grader-via-task-role.md).

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

[MIT](./LICENSE).
