# Grader resolved through the omp `@advisor` role, with only the Prompt text

Reviews are graded by whatever model the omp `@advisor` role points to, resolved at call time with medium reasoning, so a change to the role applies without touching prompt-tutor config. The request contains only the Prompt text. `ctx.runEphemeralTurn` was rejected because it sends the whole session snapshot, which leaks session context to the grader and costs far more tokens than one Prompt.

## Consequences

- prompt-tutor depends on omp exposing role resolution and a direct completion call to extensions; this is being verified in the omp extension API research ticket.
- A harness without role aliases needs its own grader setting; other harnesses are out of scope for now.
