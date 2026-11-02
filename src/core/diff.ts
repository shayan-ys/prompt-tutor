import type { Finding, PromptRecord } from "./types.ts";

export type DiffToken = {
	text: string;
	operation: "same" | "delete" | "insert";
};

/** Words (with inner apostrophes) and the runs between them; punctuation stays its own token. */
function tokens(text: string): string[] {
	return (
		text.match(
			/[\p{L}\p{M}\p{N}_]+(?:['’][\p{L}\p{M}\p{N}_]+)*|[^\p{L}\p{M}\p{N}_]+/gu,
		) ?? []
	);
}

function appendToken(output: DiffToken[], token: DiffToken): void {
	if (!token.text) return;
	const last = output[output.length - 1];
	if (last?.operation === token.operation) last.text += token.text;
	else output.push({ ...token });
}

/** Token-level LCS diff; adjacent tokens with the same operation merge. */
export function diffText(before: string, after: string): DiffToken[] {
	if (before === after)
		return before ? [{ text: before, operation: "same" }] : [];
	const oldTokens = tokens(before);
	const newTokens = tokens(after);
	const columns = newTokens.length + 1;
	const table = new Uint16Array((oldTokens.length + 1) * columns);
	for (let oldIndex = oldTokens.length - 1; oldIndex >= 0; oldIndex--) {
		const row = oldIndex * columns;
		const nextRow = (oldIndex + 1) * columns;
		for (let newIndex = newTokens.length - 1; newIndex >= 0; newIndex--) {
			const cell = row + newIndex;
			table[cell] =
				oldTokens[oldIndex] === newTokens[newIndex]
					? table[nextRow + newIndex + 1]! + 1
					: Math.max(table[nextRow + newIndex]!, table[cell + 1]!);
		}
	}
	const output: DiffToken[] = [];
	let oldIndex = 0;
	let newIndex = 0;
	while (oldIndex < oldTokens.length || newIndex < newTokens.length) {
		if (
			oldIndex < oldTokens.length &&
			newIndex < newTokens.length &&
			oldTokens[oldIndex] === newTokens[newIndex]
		) {
			appendToken(output, { text: oldTokens[oldIndex]!, operation: "same" });
			oldIndex++;
			newIndex++;
		} else if (
			oldIndex < oldTokens.length &&
			(newIndex >= newTokens.length ||
				table[(oldIndex + 1) * columns + newIndex]! >=
					table[oldIndex * columns + newIndex + 1]!)
		) {
			appendToken(output, {
				text: oldTokens[oldIndex]!,
				operation: "delete",
			});
			oldIndex++;
		} else {
			appendToken(output, {
				text: newTokens[newIndex]!,
				operation: "insert",
			});
			newIndex++;
		}
	}
	return output;
}

/** Diff a reviewed Prompt against its rewrite, anchoring each Finding span to its exact fix. */
export function rewriteDiff(record: PromptRecord): DiffToken[] {
	const review = record.review;
	const rewrite = review?.rewrite;
	if (!review || rewrite === null || rewrite === undefined) return [];
	const findings = [...review.findings].sort(
		(left, right) => left.start - right.start,
	);
	let promptOffset = 0;
	let rewriteOffset = 0;
	const output: DiffToken[] = [];
	const append = (part: DiffToken[]) => {
		for (const token of part) appendToken(output, token);
	};
	for (const finding of findings) {
		if (
			finding.start < promptOffset ||
			finding.end < finding.start ||
			record.text.slice(finding.start, finding.end) !== finding.quote
		) {
			return diffText(record.text, rewrite);
		}
		const fixStart = rewrite.indexOf(finding.fix, rewriteOffset);
		if (fixStart < rewriteOffset) return diffText(record.text, rewrite);
		append(
			diffText(
				record.text.slice(promptOffset, finding.start),
				rewrite.slice(rewriteOffset, fixStart),
			),
		);
		append(diffText(finding.quote, finding.fix));
		promptOffset = finding.end;
		rewriteOffset = fixStart + finding.fix.length;
	}
	append(
		diffText(record.text.slice(promptOffset), rewrite.slice(rewriteOffset)),
	);
	return output;
}

/**
 * The part of a Finding's quote its fix actually changes, as offsets into the quote.
 * `start === end` means the fix only inserts text at that point.
 */
export function changedSpan(finding: Pick<Finding, "quote" | "fix">): {
	start: number;
	end: number;
} {
	let offset = 0;
	let start = -1;
	let end = -1;
	for (const token of diffText(finding.quote, finding.fix)) {
		if (token.operation === "insert") {
			if (start < 0) start = offset;
			end = Math.max(end, offset);
			continue;
		}
		if (token.operation === "delete") {
			if (start < 0) start = offset;
			end = offset + token.text.length;
		}
		offset += token.text.length;
	}
	if (start < 0) return { start: 0, end: finding.quote.length };
	return { start, end };
}
