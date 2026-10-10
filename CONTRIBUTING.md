# Contributing

## Development setup

Use Bun (1.3 or newer) and the latest omp. Clone the repository, then link it into the profile you use for development:

```sh
omp --profile <p> plugin link <clone>
```

Restart omp after changing extension code. Install the development dependencies with `bun install` and run the full local gate with:

```sh
bun run check
```

This runs TypeScript, Biome, and the fixture-only Bun test suite. Tests must not call a live grader or include real Prompts.

## Pull requests

- Add a user-visible change under `Unreleased` in `CHANGELOG.md`.
- Update an ADR when changing a settled architectural decision; keep domain terms in `GLOSSARY.md`.
- Keep fixtures synthetic and redact Prompt text from diagnostic output.
- Run `bun run check` before opening a pull request. If you changed `claude-code/`, also run `claude plugin test claude-code`. The CI workflow runs both, validates the Claude Code marketplace and plugin, and smoke-installs the GitHub plugin and verifies `/prompt-tutor`.

Issues labelled `wayfinder:*` are planning issues, not implementation tasks.
