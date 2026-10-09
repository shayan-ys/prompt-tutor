import type { PromptRecord } from "./types.ts";

export function chipText(record: PromptRecord): string {
	if (record.state === "failed") return "EN ?";
	if (record.state === "pending") return "EN …";
	if (record.state === "skipped") {
		if (record.skip_reason === "too_long")
			return `skipped: too long (${record.word_count} words)`;
		return "skipped: nothing to review";
	}
	if (!record.review) return "EN ?";
	if (record.review.findings.length === 0) return "✓";
	const counts = { spelling: 0, grammar: 0, fluency: 0 };
	for (const finding of record.review.findings) counts[finding.category]++;
	const summary: string[] = [];
	if (counts.spelling > 0) summary.push(`S${counts.spelling}`);
	if (counts.grammar > 0) summary.push(`G${counts.grammar}`);
	if (counts.fluency > 0) summary.push(`F${counts.fluency}`);
	return `EN ${summary.join(" ")}`;
}
