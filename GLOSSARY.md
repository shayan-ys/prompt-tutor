# prompt-tutor

A language tutor for the prompts a person types into a coding agent. It reviews each prompt's English after the fact and summarises recurring patterns, without touching the agent session.

## Language

**Prompt**:
One message a person types into an interactive, main-agent session, captured for review.
_Avoid_: message, input, query

**Review**:
The assessment of exactly one Prompt: its Findings, its Rewrite, and its Tip.
_Avoid_: grade, feedback, correction

**Finding**:
One language error in a Prompt: the span where it occurs, its fix, and its category (spelling, grammar, or fluency).
_Avoid_: error, issue, mistake

**Rewrite**:
A native-speaker version of the whole Prompt that keeps its meaning and its register.
_Avoid_: correction, suggestion, fixed prompt

**Tip**:
The single piece of language advice a Review offers, meant to be remembered beyond this Prompt.
_Avoid_: hint, lesson, advice

**Scope**:
A set of Prompts whose Reviews are kept and digested together, chosen by rules on the agent profile and working directory.
_Avoid_: profile, workspace, bucket

**Pattern**:
A kind of language error that recurs across a Scope's Findings, such as a missing article, recognised by the Digest and followed from week to week.
_Avoid_: theme, error type, rule

**Digest**:
A brief weekly English lesson for one Scope, built from that week's Patterns and their trend over recent weeks, ending with what to focus on next.
_Avoid_: report, summary, recap

**Watcher**:
The terminal view that shows the latest Prompt and its Review.
_Avoid_: viewer, dashboard, monitor

**Review log**:
The browsable record of Reviews, one page per month, for one Scope or for all Scopes together, where each Review has its own link.
_Avoid_: history, report, feed
