import { createHash } from "node:crypto";
import type { Category, Finding, Review } from "./types.ts";

export const GRADER_PROMPT = `You review the English of one message that a person typed to an AI coding agent. The person writes English as a second language and wants to sound like a fluent native speaker. Call submit_review exactly once.

REGISTER. These messages are fast chat instructions to a tool. Judge them against how a fluent native speaker types to a coding agent, not against formal prose. Never flag:
- terse, imperative, or telegraphic style ("fix tests", "check logs then push", "done apparently, see if it was saved");
- dropped subjects or dropped articles inside a fragment that is clearly shorthand;
- lowercase sentence starts, lowercase "i", missing final punctuation, missing apostrophes in contractions (dont, im, whats);
- casual spellings natives use in chat (tho, yea, gonna, kinda) and abbreviations (eg, incl, q1, pls);
- code, commands, file paths, URLs, identifiers, numbers, markdown formatting, and correctly spelled product and model names;
- text the person clearly pasted from elsewhere (agent output, logs, documentation, quoted messages). Review only their own words.

FLAG real errors a fluent native speaker would not make, even typing fast:
- spelling: a misspelled word, including a misspelled name of a well-known product, tool, or company (not a casual chat spelling);
- grammar: wrong word form, agreement, tense, preposition, article in a full sentence, word order, missing or extra word that breaks the sentence;
- fluency: grammatical but unnatural wording; a native speaker would phrase it differently.
When unsure whether something is register or an error, do not flag it.

FINDINGS. One Finding per error.
- quote: the shortest exact substring of the message that contains the error, copied character for character. If that substring occurs more than once, extend it until it is unique.
- fix: the replacement text for quote, in the same casual register. Change only what is wrong.
- category: spelling, grammar, or fluency.
- why: the rule or reason, in at most 15 words.
- kind: a 2–5 word name for the kind of error, e.g. missing article.
- Findings must not overlap. If two errors share words, report them as one Finding; use the first category in this order: spelling, grammar, fluency.

REWRITE. The whole message as a fluent native speaker would type it in the same casual register: same meaning, same structure and line breaks, code and URLs unchanged. Fix the Findings; do not polish what is fine. Pasted text stays as is.

TIP. One piece of advice worth remembering beyond this message, taken from the most instructive Finding: a general rule plus a short example, at most 30 words.

NO ERRORS. If you find nothing, return findings: [], rewrite: null, tip: null.`;

export const REVIEW_TOOL = {
	name: "submit_review",
	description: "Submit the Review of the message.",
	strict: true,
	parameters: {
		type: "object",
		additionalProperties: false,
		required: ["findings", "rewrite", "tip"],
		properties: {
			findings: {
				type: "array",
				items: {
					type: "object",
					additionalProperties: false,
					required: ["quote", "fix", "category", "why", "kind"],
					properties: {
						quote: { type: "string" },
						fix: { type: "string" },
						category: {
							type: "string",
							enum: ["spelling", "grammar", "fluency"],
						},
						why: { type: "string" },
						kind: { type: "string" },
					},
				},
			},
			rewrite: { type: ["string", "null"] },
			tip: { type: ["string", "null"] },
		},
	},
} as const;

function hashPrompt(prompt: string): string {
	return createHash("sha256")
		.update(prompt)
		.update(JSON.stringify(REVIEW_TOOL.parameters))
		.digest("hex")
		.slice(0, 12);
}

export function graderPromptForLanguage(language: string): string {
	if (language.toLowerCase() === "english") return GRADER_PROMPT;
	return `${GRADER_PROMPT}\n\nLANGUAGE. English remains the target language. Write each Finding's why and kind, and the Tip, in ${language}. Keep quote, fix, and Rewrite in English.`;
}

export const GRADER_PROMPT_HASH = hashPrompt(GRADER_PROMPT);

export function graderPromptHashForLanguage(language: string): string {
	return hashPrompt(graderPromptForLanguage(language));
}

function isObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function validateReview(
	value: unknown,
	text: string,
): { review?: Review; problems: string[] } {
	const problems: string[] = [];
	if (!isObject(value)) return { problems: ["Review must be an object"] };
	for (const key of Object.keys(value)) {
		if (key !== "findings" && key !== "rewrite" && key !== "tip") {
			problems.push(`unexpected Review field: ${key}`);
		}
	}
	if (!Array.isArray(value.findings))
		return { problems: [...problems, "findings must be an array"] };
	if (value.rewrite !== null && typeof value.rewrite !== "string")
		problems.push("rewrite must be a string or null");
	if (value.tip !== null && typeof value.tip !== "string")
		problems.push("tip must be a string or null");

	const findings: Finding[] = [];
	let cursor = 0;
	for (const [index, rawFinding] of value.findings.entries()) {
		if (!isObject(rawFinding)) {
			problems.push(`finding ${index + 1} must be an object`);
			continue;
		}
		for (const key of Object.keys(rawFinding)) {
			if (!["quote", "fix", "category", "why", "kind"].includes(key)) {
				problems.push(`unexpected field in finding ${index + 1}: ${key}`);
			}
		}
		const quote = rawFinding.quote;
		const fix = rawFinding.fix;
		const category = rawFinding.category;
		const why = rawFinding.why;
		const kind = rawFinding.kind;
		if (typeof quote !== "string" || quote.length === 0)
			problems.push(`finding ${index + 1} quote must be a non-empty string`);
		if (typeof fix !== "string")
			problems.push(`finding ${index + 1} fix must be a string`);
		if (
			category !== "spelling" &&
			category !== "grammar" &&
			category !== "fluency"
		) {
			problems.push(`finding ${index + 1} has an invalid category`);
		}
		if (typeof why !== "string")
			problems.push(`finding ${index + 1} why must be a string`);
		if (typeof kind !== "string" || kind.trim().length === 0)
			problems.push(`finding ${index + 1} kind must be a non-empty string`);
		if (
			typeof quote !== "string" ||
			quote.length === 0 ||
			typeof fix !== "string" ||
			(category !== "spelling" &&
				category !== "grammar" &&
				category !== "fluency") ||
			typeof why !== "string" ||
			typeof kind !== "string" ||
			kind.trim().length === 0
		) {
			continue;
		}
		if (quote === fix) {
			problems.push(`finding ${index + 1} fix must differ from quote`);
			continue;
		}
		const start = text.indexOf(quote, cursor);
		if (start < 0) {
			problems.push(
				`finding ${index + 1} quote was not found after the previous finding`,
			);
			continue;
		}
		const end = start + quote.length;
		if (start < cursor) {
			problems.push(`finding ${index + 1} overlaps the previous finding`);
			continue;
		}
		findings.push({
			quote,
			fix,
			category: category as Category,
			why,
			kind,
			start,
			end,
		});
		cursor = end;
	}

	const noFindings = value.findings.length === 0;
	if (noFindings && value.rewrite !== null)
		problems.push("rewrite must be null when there are no findings");
	if (!noFindings && value.rewrite === null)
		problems.push("rewrite must be a string when findings exist");
	if (noFindings && value.tip !== null)
		problems.push("tip must be null when there are no findings");
	if (!noFindings && value.tip === null)
		problems.push("tip must be a string when findings exist");
	if (problems.length > 0) return { problems };
	return {
		review: {
			findings,
			rewrite: value.rewrite as string | null,
			tip: value.tip as string | null,
		},
		problems,
	};
}
