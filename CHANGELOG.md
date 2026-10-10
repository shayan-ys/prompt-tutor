# Changelog

All notable changes to prompt-tutor are documented here.

This project follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Out-of-band English Reviews for interactive prompts in omp's main session.
- Persistent per-Prompt records, Scope-specific Review logs, and a terminal Watcher.
- Weekly per-Scope Digests, run only in sessions of each Scope's `digest_profile`.
- Reviews graded by the omp `@task` role with medium reasoning; weekly Digests written by `@advisor` with high reasoning.
- `/prompt-tutor install-watcher` to place the Watcher command on `PATH`.
- Optional Review log retention by `keep_months` and explicit data removal with `prompt-tutor --delete-data [--yes]`.
- Configurable explanation language for Findings, Tips, and Digest prose while keeping English as the target language.
- `prompt-tutor --once` prints one dashboard frame for hosts such as devdash: as wide as `COLUMNS` when stdout is not a terminal and as tall as its content, without the Watcher's title line, view tabs, follow indicator, or key row. A config or store read failure goes to stderr with exit status 1.
- `prompt-tutor --once` supports devdash navigation actions (`newer`, `older`, `scope`) and atomic view and selection state in `DEVDASH_STATE_FILE`. The Watcher's view tabs and follow indicator appear when state is enabled.
- Claude Code support: a Claude Code mod captures typed Prompts, and `prompt-tutor capture --harness claude-code` queues them. Preprocessing drops the `<system-reminder>` blocks Claude Code adds to submitted text. Install it with `claude plugin marketplace add shayan-ys/prompt-tutor`.
- `prompt-tutor drain` starts the Drainer, which reviews queued Claude Code Prompts in a headless omp process for each configured `review_profile`, using that profile's `@task`. A Scope's new `review_profile` setting has no default; without it, its Claude Code Prompts stay queued.
- The Watcher shows a Claude Code Prompt as queued until a Drainer holds its Scope's `drain.lock`.

### Fixed
- A stalled model request no longer holds a Review, or the Drainer's queue behind it, for minutes: a Review call that sends no first stream event within 20 s, or that fails, is replaced once by a fresh call, and the Review fails after 120 s at most. A model error now fails the Review with the provider's message. Digests keep the provider defaults.
