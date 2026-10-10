# Reviews graded by `@task` at medium; the Digest stays on `@advisor` at high

Each Review is graded by the model the omp `@task` role points to, with medium reasoning requested. The weekly Digest uses the `@advisor` role with high reasoning requested. Both roles are resolved at call time, and each request still contains only what ADR 0003 and ADR 0004 allow. Shayan decided this on 2026-10-08, after the first live run, in which `@advisor` graded every Prompt. `@task` is the role omp uses for subagent work. It fits a call made for every Prompt. The Digest runs once a week and has the hardest job: grouping a week of Findings into Patterns and writing the lesson. So it keeps the stronger role and asks for more reasoning. Each call requests its level explicitly, so a role's own configured thinking level, such as `:xhigh`, does not apply.

## Consequences

- This supersedes ADR 0003's choice of role for Reviews. ADR 0003's other rules still hold: resolution at call time, only the Prompt text, and no `ctx.runEphemeralTurn`. ADR 0004 is unchanged except that the Digest now requests high reasoning.
- Each profile's `@task` setting decides which provider receives that profile's Prompts. Its `@advisor` setting decides which provider receives the week's Findings for the Digests it runs (see ADR 0007).
- Reviews record the resolved model id, so the Digest's "Grader changed this week" note flags the switch in the first week graded by `@task`.
