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
- `prompt-tutor --once` prints one dashboard frame for hosts such as devdash: sized from `COLUMNS` and `LINES` when stdout is not a terminal, without the Watcher's title line, view tabs, follow indicator, or key row. A config or store read failure goes to stderr with exit status 1.
- `prompt-tutor --once` supports devdash navigation and body scrolling actions (`newer`, `older`, `scope`, `scroll-down`, `scroll-up`) and atomic view, selection, and scroll state in `DEVDASH_STATE_FILE`; scroll-aware frames preserve selected Review body room before the trail, while stateless embedded frames retain body-first clipping. The Watcher's view tabs and follow indicator appear when state is enabled.
