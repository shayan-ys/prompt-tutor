import type { Category } from "../types.ts";
import type {
	DigestArchive,
	DigestFinding,
	DigestPattern,
	DigestRenderContext,
} from "./types.ts";

const CATEGORY_ORDER: Category[] = ["spelling", "grammar", "fluency"];

/** The exported note's file name without `.md`, which is also its wikilink target. */
export function noteName(
	digest: Pick<DigestArchive, "week" | "scope">,
): string {
	return `Prompt Tutor Digest ${digest.week} (${digest.scope})`;
}

/** Escape model or Prompt text for one line of Markdown, including Obsidian's `%%` and `==`. */
function inline(text: string): string {
	return text
		.replace(/\s+/gu, " ")
		.trim()
		.replace(/[\\`*_~[\]<>#|$=%]/gu, "\\$&");
}

/** Escape prose that may contain line breaks and list items, keeping its structure. */
function prose(text: string): string {
	return text.trim().replace(/[\\<>[\]$%|]/gu, "\\$&");
}

function cleanPercent(digest: DigestArchive): number {
	return digest.stats.reviewed === 0
		? 0
		: Math.round((100 * digest.stats.clean) / digest.stats.reviewed);
}

function recurringPatterns(digest: DigestArchive): DigestPattern[] {
	return digest.patterns
		.filter((pattern) => pattern.recurring)
		.toSorted(
			(a, b) =>
				b.count - a.count ||
				(b.previousCount ?? -1) - (a.previousCount ?? -1) ||
				a.name.localeCompare(b.name),
		);
}

const SUMMARY_MAX_WORDS = 30;

/** At most 30 words, for frontmatter and the index table: stats, then as many top Patterns as fit. */
export function noteSummary(digest: DigestArchive): string {
	const stats = `English mistakes in ${digest.scope} Prompts, ${digest.from} to ${digest.week}: ${digest.stats.prompts} Prompts, ${cleanPercent(digest)}% clean.`;
	const words = (text: string) => text.split(/\s+/u).filter(Boolean).length;
	const top: string[] = [];
	for (const pattern of recurringPatterns(digest).slice(0, 3)) {
		const candidate = `${stats} Top Patterns: ${[...top, pattern.name].join("; ")}.`;
		if (words(candidate) > SUMMARY_MAX_WORDS) break;
		top.push(pattern.name);
	}
	return top.length ? `${stats} Top Patterns: ${top.join("; ")}.` : stats;
}

function example(finding: DigestFinding, why: boolean): string {
	const reason = why && finding.why.trim() ? ` ${inline(finding.why)}` : "";
	return `~~${inline(finding.quote)}~~ → **${inline(finding.fix)}**${reason}`;
}

function patternSection(pattern: DigestPattern, rank: number): string {
	const change =
		pattern.previousCount === null
			? "new this week"
			: `${pattern.previousCount} the week before`;
	const lines = [
		`### ${rank}. ${inline(pattern.name)}`,
		"",
		`${pattern.count} this week, ${change}. ${pattern.categories.join(", ")}.`,
		"",
		prose(pattern.rule),
	];
	if (pattern.examples.length) {
		lines.push(
			"",
			...pattern.examples.map((finding) => `- ${example(finding, false)}`),
		);
	}
	return lines.join("\n");
}

/** Render a Digest as an Obsidian-friendly Markdown note: frontmatter, lead, then sections. */
export function renderDigestMarkdown(
	digest: DigestArchive,
	context: DigestRenderContext,
	links: { htmlPath: string; previousNote: string | null },
): string {
	const title = noteName(digest);
	const previous = context.previousWeek;
	const previousClean = previous
		? ` (${cleanPercent(previous)}% the week before)`
		: "";
	const categories = CATEGORY_ORDER.map(
		(category) => `${digest.stats.categories[category]} ${category}`,
	).join(", ");
	const frontmatter = [
		"---",
		`title: ${JSON.stringify(title)}`,
		"type: note",
		"tags:",
		"  - english",
		"status: seed",
		`created: ${digest.week}`,
		`updated: ${digest.week}`,
		`summary: ${JSON.stringify(noteSummary(digest))}`,
		...(links.previousNote
			? ["related:", `  - ${JSON.stringify(`[[${links.previousNote}]]`)}`]
			: []),
		'source: "prompt-tutor"',
		`aliases: ${JSON.stringify([`prompt-tutor ${digest.scope} ${digest.week}`, `English Digest ${digest.scope} ${digest.week}`, `English mistakes ${digest.scope} ${digest.week}`])}`,
		"---",
	];
	const sections = [
		`# ${inline(title)}`,
		`In the ${inline(digest.scope)} Scope, from ${digest.from} to ${digest.week}: ${digest.stats.prompts} Prompts, ${digest.stats.reviewed} reviewed, ${cleanPercent(digest)}% clean${previousClean}. Findings: ${categories}.`,
	];
	if (digest.focus) sections.push(`## Focus\n\n${prose(digest.focus)}`);
	if (digest.lesson) sections.push(`## Lesson\n\n${prose(digest.lesson)}`);
	const patterns = recurringPatterns(digest);
	sections.push(
		patterns.length
			? `## Recurring Patterns\n\n${patterns.map((pattern, index) => patternSection(pattern, index + 1)).join("\n\n")}`
			: "## Recurring Patterns\n\nNothing recurred this week.",
	);
	if (digest.oneOffs.length) {
		sections.push(
			`## One-off Findings\n\n${digest.oneOffs.map((finding) => `- *${finding.category}*: ${example(finding, true)}`).join("\n")}`,
		);
	}
	const notReviewed = [
		[digest.stats.notReviewed.tooLong, "too long"],
		[digest.stats.notReviewed.nothingToReview, "nothing to review"],
		[digest.stats.notReviewed.failed, "grader failure"],
		[digest.stats.notReviewed.pending, "pending"],
	] as const;
	const skipped = notReviewed
		.filter(([count]) => count > 0)
		.map(([count, label]) => `${count} ${label}`)
		.join(", ");
	const footer = [
		`Not reviewed: ${skipped || "none"}.`,
		`The full page with sentences and trends: [${digest.week}.html](${links.htmlPath}).`,
	];
	if (links.previousNote)
		footer.push(`Previous week: [[${links.previousNote}]].`);
	sections.push(`## More\n\n${footer.join("\n\n")}`);
	return `${frontmatter.join("\n")}\n\n${sections.join("\n\n")}\n`;
}
