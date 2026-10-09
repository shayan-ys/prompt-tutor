# Grader resolved through the omp `@task` role

Reviews and Digests are graded by whatever model the omp `@task` role points to, not `@advisor`. The role is resolved at call time with a requested reasoning level of medium, and the request still contains only what ADR 0003 and ADR 0004 allow. Shayan made this change on 2026-10-08, after the first live run. That run graded with `@advisor`, which in his profiles is the model that reviews the main agent's work. `@task` is the role omp uses for subagent work. Each call requests medium reasoning explicitly, so the role's own configured thinking level, for example `:xhigh`, does not apply to grading.

## Consequences

- This supersedes ADR 0003's choice of role. ADR 0003's other rules still hold: resolution at call time, only the Prompt text, and no `ctx.runEphemeralTurn`. In ADR 0004, "the `@advisor` model" now means the `@task` model.
- Which provider receives each Prompt and each Digest request now depends on each profile's `@task` setting (see ADR 0007).
- Reviews record the resolved model id, so the Digest's "Grader changed this week" note flags the switch in the first week that uses `@task`.
