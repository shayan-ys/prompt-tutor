# A Scope's Digest runs only in sessions of its `digest_profile`

Scopes are chosen by omp profile and by working directory (cwd), so a session in one profile can store its Prompts in a Scope that belongs to another profile. For example, a work-profile session inside `~/Documents/personal/` stores its Prompts in the personal Scope. Each Scope therefore has an optional `digest_profile`, and its weekly Digest runs only in sessions of that profile. If a Scope has exactly one `profile:` condition, that profile is the default. Otherwise, any session that resolves to the Scope may run its Digest. Letting any session in the Scope run the Digest was rejected: one session in the wrong profile would send a whole week of that Scope's Findings, with their sentences, to its own profile's `@advisor`, including Findings from sessions that never used that provider.

## Consequences

- Scopes and `digest_profile` control where data is **stored** and which profile **runs the Digest**. They don't isolate providers. Each Review sends the Prompt text to the grader role of the session's own profile: `@task` since ADR 0008, `@advisor` before it. That model can come from a different provider than the session's main model, and the session's Scope doesn't change which one it is. Only each profile's grader role setting decides which provider receives that profile's Prompts. The README's privacy section has to say this.
- If no session of a Scope's `digest_profile` starts during a week, that Scope gets no Digest that week.
