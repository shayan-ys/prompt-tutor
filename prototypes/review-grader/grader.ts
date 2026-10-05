// PROTOTYPE — throwaway. Answers issue #5: Review schema and grader prompt.
// Not production code: no tests, minimal error handling.

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
- Findings must not overlap. If two errors share words, report them as one Finding with one fix.

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
					required: ["quote", "fix", "category", "why"],
					properties: {
						quote: { type: "string" },
						fix: { type: "string" },
						category: { type: "string", enum: ["spelling", "grammar", "fluency"] },
						why: { type: "string" },
					},
				},
			},
			rewrite: { type: ["string", "null"] },
			tip: { type: ["string", "null"] },
		},
	},
} as const;

/** Removes fenced code blocks and a leading slash-command token. */
export function preprocess(raw: string): string {
	let text = raw.replace(/^\/\S+\s*/, "");
	text = text.replace(/```[\s\S]*?(```|$)/g, "[code]");
	return text.trim();
}

export type Finding = { quote: string; fix: string; category: string; why: string; start?: number; end?: number };
export type Review = { findings: Finding[]; rewrite: string | null; tip: string | null };

/** Validates a Review against the text and resolves each quote to offsets. Returns problems found. */
export function validate(value: unknown, text: string): string[] {
	const problems: string[] = [];
	if (!value || typeof value !== "object" || !("findings" in value) || !Array.isArray(value.findings)) return ["findings missing"];
	const review = value as Review; // prototype: fields checked one by one below
	let cursor = 0;
	for (const f of review.findings) {
		if (typeof f.quote !== "string" || typeof f.fix !== "string") problems.push("finding fields missing");
		else if (!["spelling", "grammar", "fluency"].includes(f.category)) problems.push(`bad category ${f.category}`);
		else if (f.quote === f.fix) problems.push(`no-op fix "${f.quote}"`);
		else {
			let at = text.indexOf(f.quote, cursor);
			if (at < 0) at = text.indexOf(f.quote);
			if (at < 0) problems.push(`quote not found "${f.quote}"`);
			else {
				f.start = at;
				f.end = at + f.quote.length;
				cursor = f.end;
			}
		}
	}
	const located = review.findings.filter(f => f.start !== undefined).sort((a, b) => a.start! - b.start!);
	for (let i = 1; i < located.length; i++) if (located[i].start! < located[i - 1].end!) problems.push(`overlap "${located[i - 1].quote}" / "${located[i].quote}"`);
	const empty = review.findings.length === 0;
	if (empty !== (review.rewrite === null)) problems.push("rewrite/finding mismatch");
	if (empty !== (review.tip === null)) problems.push("tip/finding mismatch");
	return problems;
}
