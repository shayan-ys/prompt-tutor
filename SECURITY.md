# Security Policy

## Reporting a vulnerability

Please report security issues through GitHub's private vulnerability reporting for this repository. Do not open a public issue for an unpatched vulnerability.

Include the affected commit or release, omp version, operating system, and a concise description of the impact and reproduction steps. Do not include real Prompts, credentials, API keys, or other private session content. Redact Prompt text from Watcher output before sharing it.

## Scope and data handling

prompt-tutor stores Prompt records and generated Reviews locally in the configured Scope store. The grader sends each Prompt to the session profile's configured `@task` model; review the [Privacy](README.md#privacy) section before enabling it for sensitive work.
