import type { Category } from "../types.ts";
import type {
	DigestArchive,
	DigestFinding,
	DigestPattern,
	DigestRenderContext,
} from "./types.ts";

const CATEGORY_ORDER: Category[] = ["spelling", "grammar", "fluency"];
const CATEGORY_LABEL: Record<Category, string> = {
	spelling: "Spelling",
	grammar: "Grammar",
	fluency: "Fluency",
};

function escapeHtml(value: string): string {
	return value.replace(/[&<>"']/g, (character) => {
		switch (character) {
			case "&":
				return "&amp;";
			case "<":
				return "&lt;";
			case ">":
				return "&gt;";
			case '"':
				return "&quot;";
			default:
				return "&#39;";
		}
	});
}

function delta(
	current: number,
	previous: number | null,
	inverse = false,
): string {
	if (previous === null) return '<span class="new">NEW</span>';
	if (current === previous) return '<span class="mute">±0</span>';

	const increased = current > previous;
	const improves = inverse ? !increased : increased;
	const direction = increased ? "▲" : "▼";
	const tone = improves ? "down" : "up";
	return `<span class="${tone}">${direction} ${Math.abs(current - previous)}</span>`;
}

function percent(value: number, total: number): number {
	return total === 0 ? 0 : Math.round((100 * value) / total);
}

function findingExample(finding: DigestFinding, showWhy = false): string {
	const quote = escapeHtml(finding.quote);
	const fix = escapeHtml(finding.fix);
	const context = `<details class="sentence"><summary>Show sentence</summary><p>${escapeHtml(finding.sentence)}</p></details>`;
	const why = showWhy
		? `<div class="mute why">${escapeHtml(finding.why)}</div>`
		: "";
	return `<div class="example"><span class="ex"><del>${quote}</del> → <ins>${fix}</ins></span>${context}${why}</div>`;
}

function categoryChips(categories: Category[]): string {
	return [...categories]
		.sort((a, b) => CATEGORY_ORDER.indexOf(a) - CATEGORY_ORDER.indexOf(b))
		.map(
			(category) =>
				`<span class="chip ${category}">${CATEGORY_LABEL[category]}</span>`,
		)
		.join(" ");
}

function sparkline(pattern: DigestPattern): string {
	const values = pattern.trend.map(({ count }) => count);
	if (values.length === 0) return '<span class="mute">—</span>';

	const width = 72;
	const height = 22;
	const maximum = Math.max(...values, 1);
	const points = values
		.map((value, index) => {
			const x =
				values.length === 1
					? width / 2
					: 2 + (index * (width - 4)) / (values.length - 1);
			const y = height - 2 - (value * (height - 4)) / maximum;
			return `${x.toFixed(1)},${y.toFixed(1)}`;
		})
		.join(" ");
	const [lastX, lastY] = points.split(" ").at(-1)?.split(",") ?? ["36", "20"];
	const trendText = pattern.trend
		.map(({ week, count }) => `${week}: ${count}`)
		.join(", ");
	return `<svg class="trend" viewBox="0 0 ${width} ${height}" role="img" aria-label="Last Digest counts: ${escapeHtml(trendText)}"><polyline points="${points}" fill="none" stroke="currentColor" stroke-width="1.7"/><circle cx="${lastX}" cy="${lastY}" r="2.4" fill="currentColor"/></svg>`;
}

function statCard(
	label: string,
	value: string,
	change: string,
	note: string,
	category?: Category,
): string {
	const categoryClass = category ? ` ${category}` : "";
	return `<div class="kpi"><small class="${categoryClass.trim()}">${escapeHtml(label)}</small><b>${escapeHtml(value)}</b><small>${change} · vs last week${note ? ` · ${escapeHtml(note)}` : ""}</small></div>`;
}

function graderVersionLabel(versions: DigestArchive["graderVersions"]): string {
	return (
		versions
			.map(({ model, promptHash }) => `${model} (prompt ${promptHash})`)
			.join(", ") || "none"
	);
}

function graderChangeNote(context: DigestRenderContext): string {
	if (!context.graderChanged) return "";
	return `<p class="grader-change">Grader changed this week: ${escapeHtml(graderVersionLabel(context.graderChanged.from))} → ${escapeHtml(graderVersionLabel(context.graderChanged.to))}; trends may shift.</p>`;
}

function patternRow(pattern: DigestPattern, rank: number): string {
	const examples = pattern.examples
		.map((finding) => findingExample(finding))
		.join("");
	return `<tr><td class="rank">${rank}</td><td><b>${escapeHtml(pattern.name)}</b> ${categoryChips(pattern.categories)}<div class="mute rule">${escapeHtml(pattern.rule)}</div></td><td class="count"><b>${pattern.count}</b></td><td>${delta(pattern.count, pattern.previousCount, true)}</td><td>${sparkline(pattern)}</td><td>${examples}</td></tr>`;
}

function notReviewedLine(digest: DigestArchive): string {
	const items = [
		[digest.stats.notReviewed.tooLong, "too long"],
		[digest.stats.notReviewed.nothingToReview, "nothing to review"],
		[digest.stats.notReviewed.failed, "grader failure (EN ?)"],
		[digest.stats.notReviewed.pending, "pending"],
	] as const;
	const summary = items
		.filter(([count]) => count > 0)
		.map(([count, label]) => `${count} ${label}`)
		.join(", ");
	return `<p class="mute not-reviewed">Not reviewed: ${summary ? escapeHtml(summary) : "none"}.</p>`;
}

function archiveNavigation(
	digest: DigestArchive,
	context: DigestRenderContext,
): string {
	const archive = [...new Set(context.archiveWeeks)].sort((a, b) =>
		b.localeCompare(a),
	);
	const previousLink = context.previousArchive
		? `<a href="${escapeHtml(context.previousArchive)}.html">${escapeHtml(context.previousArchive)}</a>`
		: '<span class="mute">none</span>';
	const archiveLinks = archive
		.map((week) =>
			week === digest.week
				? `<span aria-current="page">${escapeHtml(week)} (this week)</span>`
				: `<a href="${escapeHtml(week)}.html">${escapeHtml(week)}</a>`,
		)
		.join(" · ");
	return `<nav><div>Previous: ${previousLink}</div><div>Archive: ${archiveLinks}</div><a href="../digest.html">Latest Digest</a></nav>`;
}

/** Render a self-contained, static Report page. The returned archive HTML has no base element. */
export function renderDigest(
	digest: DigestArchive,
	context: DigestRenderContext,
): string {
	const previousStats = context.previousWeek?.stats ?? null;
	const cleanPercent =
		digest.stats.reviewed === 0
			? 0
			: Math.round((100 * digest.stats.clean) / digest.stats.reviewed);
	const previousCleanPercent = previousStats
		? previousStats.reviewed === 0
			? 0
			: Math.round((100 * previousStats.clean) / previousStats.reviewed)
		: null;
	const promptsChange = delta(
		digest.stats.prompts,
		previousStats?.prompts ?? null,
	);
	const cleanChange = delta(cleanPercent, previousCleanPercent);
	const categoryCards = CATEGORY_ORDER.map((category) => {
		const previous = previousStats?.categories[category] ?? null;
		return statCard(
			CATEGORY_LABEL[category],
			String(digest.stats.categories[category]),
			delta(digest.stats.categories[category], previous, true),
			"",
			category,
		);
	}).join("");
	const patterns = digest.patterns
		.filter((pattern) => pattern.recurring)
		.toSorted(
			(a, b) =>
				b.count - a.count ||
				(b.previousCount ?? -1) - (a.previousCount ?? -1) ||
				a.name.localeCompare(b.name),
		);
	const unranked = digest.oneOffs;
	const patternRows = patterns
		.map((pattern, index) => patternRow(pattern, index + 1))
		.join("");
	const oneOffRows = unranked
		.map(
			(finding) =>
				`<tr><td>${categoryChips([finding.category])}</td><td>${findingExample(finding, true)}</td></tr>`,
		)
		.join("");
	const lesson = digest.lesson
		? `<section><h2>This week’s lesson</h2><p class="lesson">${escapeHtml(digest.lesson)}</p></section>`
		: "";
	const focus = digest.focus
		? `<section class="focusbox"><div class="eyebrow">What to focus on next</div><p class="focus">${escapeHtml(digest.focus)}</p></section>`
		: "";
	const body = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Digest · ${escapeHtml(digest.scope)} · ${escapeHtml(digest.week)}</title>
<style>
:root{color-scheme:light dark;--fg:#1d1d1f;--mute:#6b6b70;--line:#e3e3e8;--bg:#fff;--soft:#f6f6f8;--sp:#c62828;--gr:#b26a00;--fl:#1565c0;--up:#c62828;--down:#2e7d32;--focus:#1d1d1f}
@media(prefers-color-scheme:dark){:root{--fg:#ececf0;--mute:#a1a1a9;--line:#3a3a42;--bg:#17171a;--soft:#242429;--sp:#ff7070;--gr:#ffbb58;--fl:#80b8ff;--up:#ff7777;--down:#79d58a;--focus:#ececf0}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.55 system-ui,-apple-system,sans-serif}a{color:inherit}main{max-width:1040px;margin:0 auto;padding:28px 20px 100px}header{display:flex;justify-content:space-between;align-items:baseline;gap:18px;border-bottom:2px solid var(--fg);padding-bottom:9px}h1{font-size:23px;margin:0}h2{font-size:14px;text-transform:uppercase;letter-spacing:.05em;margin:28px 0 8px}.mute{color:var(--mute)}.spelling{color:var(--sp)}.grammar{color:var(--gr)}.fluency{color:var(--fl)}.chip{display:inline-block;font-size:11px;border:1px solid currentColor;border-radius:99px;padding:0 7px;line-height:19px;white-space:nowrap}.kpis{display:grid;grid-template-columns:repeat(5,minmax(105px,1fr));gap:10px;margin:18px 0}.kpi{background:var(--soft);border-radius:8px;padding:10px 12px;min-width:0}.kpi b{display:block;font-size:22px}.kpi small{font-size:12px;color:var(--mute)}.kpi small.spelling{color:var(--sp)}.kpi small.grammar{color:var(--gr)}.kpi small.fluency{color:var(--fl)}.up{color:var(--up)}.down{color:var(--down)}.new{font-size:11px;background:#222;color:#fff;border-radius:4px;padding:1px 5px}.focusbox{border-left:4px solid var(--focus);padding:5px 16px;margin:24px 0}.focus{font-size:17px;line-height:1.6;margin:4px 0}.eyebrow{font-size:12px;text-transform:uppercase;color:var(--mute);letter-spacing:.04em}.lesson{max-width:78ch}.grader-change{border-left:3px solid #b26a00;padding-left:10px;color:var(--mute);font-size:13px}.table-wrap{overflow-x:auto}table{border-collapse:collapse;width:100%;min-width:760px}th{text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--mute);font-weight:600}th,td{padding:9px 10px;border-bottom:1px solid var(--line);vertical-align:top}.rank,.count{white-space:nowrap}.rule{font-size:13px;margin-top:2px}.trend{width:72px;height:22px;vertical-align:middle;color:var(--mute)}.ex{font:13px/1.5 ui-monospace,SFMono-Regular,monospace}.example{margin:3px 0}.example del{background:#fde4e4;color:#8b1818;text-decoration:line-through;border-radius:3px;padding:0 2px}.example ins{background:#ddf3df;color:#155d20;text-decoration:none;border-radius:3px;padding:0 2px}.sentence{font:12px/1.45 system-ui,sans-serif;color:var(--mute)}.sentence summary{cursor:pointer}.sentence p{margin:3px 0 7px}.why{font-size:12px;margin-top:2px}details>summary{cursor:pointer}.not-reviewed{font-size:13px;margin-top:19px}nav{display:flex;flex-direction:column;gap:6px;margin-top:34px;border-top:1px solid var(--line);padding-top:12px;font-size:13px}nav div:last-of-type{line-height:1.9}nav a{margin-right:4px}@media(max-width:760px){main{padding:20px 14px 80px}.kpis{grid-template-columns:repeat(2,minmax(0,1fr))}header{align-items:flex-start;flex-direction:column}.focus{font-size:16px}}
</style>
</head>
<body><main>
<header><h1>Digest · ${escapeHtml(digest.scope)}</h1><span class="mute">Week ending ${escapeHtml(digest.week)} · ${escapeHtml(digest.from)} → ${escapeHtml(digest.week)}</span></header>
<div class="kpis">
${statCard("Prompts", String(digest.stats.prompts), promptsChange, "")}
${statCard("Clean", `${cleanPercent}%`, cleanChange, `${digest.stats.clean}/${digest.stats.reviewed} reviewed`)}
${categoryCards}
</div>
${graderChangeNote(context)}
${focus}
${lesson}
<section><h2>Recurring Patterns</h2>${patterns.length ? `<div class="table-wrap"><table><thead><tr><th>#</th><th>Pattern</th><th>This week</th><th>vs last</th><th>6 Digests</th><th>Examples</th></tr></thead><tbody>${patternRows}</tbody></table></div>` : '<p class="mute">Nothing recurred this week.</p>'}</section>
<details class="one-offs"><summary><b>${unranked.length} one-off Findings</b> <span class="mute">(single occurrences; not ranked)</span></summary><div class="table-wrap"><table><tbody>${oneOffRows || '<tr><td class="mute">None.</td></tr>'}</tbody></table></div></details>
${notReviewedLine(digest)}
${archiveNavigation(digest, context)}
</main></body></html>
`;
	return body;
}
