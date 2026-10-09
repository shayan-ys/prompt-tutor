# English is the only target language; explanations can use another language

prompt-tutor reviews English only. The grader prompt's register rules are English rules: lowercase "i", dropped apostrophes, and chat spellings such as "gonna" are allowed. A general target-language setting would need a tested grader prompt for each language, and none has been tried. The optional `explanation_language` config key (default English) sets the language of the explanations that a learner reads: each Finding's `why` and `kind`, the Tip, and the Digest's Pattern names and rules, its lesson, and its focus paragraph. Quotes, fixes, the Rewrite, and example sentences stay in English, because they are the English being taught. The key is one global setting, not a per-Scope one, because it describes the learner, not the work.

## Consequences

- When the key is absent or is English, the grader and Digest prompts do not change. Otherwise each prompt gets one paragraph that names the language. Each Review stores the hash of the prompt that was actually used, so the Digest flags the week in which the language changed as a week in which the grader changed (issue #12).
- The Digest HTML's fixed labels stay in English.
- The setting does not change what leaves the machine or which provider receives it.
- Supporting another target language means a new grader prompt and a new decision that supersedes this one.
