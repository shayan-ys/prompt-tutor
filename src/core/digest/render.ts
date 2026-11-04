import { findingDiffHtml } from "../log/render.ts";
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
	// One point is no trend; the count beside it already says it.
	if (values.length < 2) return "";

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
	const changeText = change ? `${change} · vs last week` : "";
	const details = [changeText, note ? escapeHtml(note) : ""]
		.filter(Boolean)
		.join(" · ");
	return `<div class="kpi"><small class="${categoryClass.trim()}">${escapeHtml(label)}</small><b>${escapeHtml(value)}</b><small>${details}</small></div>`;
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

/** Examples shown before the rest fold into "more examples". */
const VISIBLE_EXAMPLES = 4;

/** Model prose as HTML: `- ` lines become a list, other blocks become paragraphs. */
function proseHtml(text: string): string {
	return text
		.split(/\n\s*\n/u)
		.map((block) => block.trim())
		.filter(Boolean)
		.map((block) => {
			const lines = block.split("\n").map((line) => line.trim());
			if (!lines.every((line) => line.startsWith("- ")))
				return `<p>${escapeHtml(block)}</p>`;
			return `<ul>${lines.map((line) => `<li>${escapeHtml(line.slice(2))}</li>`).join("")}</ul>`;
		})
		.join("");
}

function exampleItem(finding: DigestFinding): string {
	return `<li><span class="ex">${findingDiffHtml(finding)}</span><details class="why"><summary>why</summary><p>${escapeHtml(finding.why)}</p><p class="mute">“${escapeHtml(finding.sentence)}”</p></details></li>`;
}

function exampleList(examples: DigestFinding[]): string {
	const visible = examples.slice(0, VISIBLE_EXAMPLES).map(exampleItem).join("");
	const folded = examples.slice(VISIBLE_EXAMPLES);
	const more = folded.length
		? `<details class="more"><summary>+${folded.length} more</summary><ul class="examples">${folded.map(exampleItem).join("")}</ul></details>`
		: "";
	return `<ul class="examples">${visible}</ul>${more}`;
}

function patternAnchor(pattern: DigestPattern): string {
	return `pattern-${pattern.id.replace(/[^a-z0-9-]/giu, "-")}`;
}

/** Bars shown before the smaller Patterns fold away. */
const CHART_ROWS = 10;

/** One bar per recurring Pattern, scaled to the largest, linking to its card or row. */
function patternChart(patterns: DigestPattern[], showChange: boolean): string {
	const maximum = Math.max(...patterns.map(({ count }) => count), 1);
	const bar = (pattern: DigestPattern) => {
		const width = Math.max(2, Math.round((100 * pattern.count) / maximum));
		const category = pattern.categories[0] ?? "grammar";
		const change = showChange
			? delta(pattern.count, pattern.previousCount, true)
			: "";
		return `<a class="bar-row" href="#${patternAnchor(pattern)}"><span class="bar-name">${escapeHtml(pattern.name)}</span><span class="bar-track"><span class="bar ${category}" style="width:${width}%"></span></span><b>${pattern.count}</b><span class="bar-delta">${change}</span></a>`;
	};
	const folded = patterns.slice(CHART_ROWS);
	const more = folded.length
		? `<details class="more"><summary>+${folded.length} smaller patterns</summary><div class="chart">${folded.map(bar).join("")}</div></details>`
		: "";
	return `<div class="chart">${patterns.slice(0, CHART_ROWS).map(bar).join("")}</div>${more}`;
}

function patternCard(pattern: DigestPattern, showChange: boolean): string {
	const explanation = pattern.explanation
		? `<div class="explain">${proseHtml(pattern.explanation)}</div>`
		: "";
	const tip = pattern.tip
		? `<div class="tip"><span class="label">Before you send</span>${escapeHtml(pattern.tip)}</div>`
		: "";
	const practice = pattern.practice?.length
		? `<div class="practice"><span class="label">Try it</span><ol>${pattern.practice
				.map(
					(exercise) =>
						`<li><span>${escapeHtml(exercise.sentence)}</span><details><summary>answer</summary><p>${escapeHtml(exercise.answer)}</p></details></li>`,
				)
				.join("")}</ol></div>`
		: "";
	const change = showChange
		? delta(pattern.count, pattern.previousCount, true)
		: "";
	return `<article class="card" id="${patternAnchor(pattern)}"><div class="card-head"><h3>${escapeHtml(pattern.name)}</h3><span class="count">${pattern.count}</span>${change}${sparkline(pattern)}${categoryChips(pattern.categories)}</div><p class="rule">${escapeHtml(pattern.rule)}</p>${explanation}${exampleList(pattern.examples)}${tip}${practice}</article>`;
}

function patternRow(pattern: DigestPattern): string {
	return `<div class="row" id="${patternAnchor(pattern)}"><div class="row-head"><b>${escapeHtml(pattern.name)}</b><span class="count">${pattern.count}</span>${categoryChips(pattern.categories)}</div><p class="rule">${escapeHtml(pattern.rule)}</p>${exampleList(pattern.examples)}</div>`;
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
	// With no earlier Digest every count would read NEW; leave changes out instead.
	const showChange = previousStats !== null;
	const cleanPercent =
		digest.stats.reviewed === 0
			? 0
			: Math.round((100 * digest.stats.clean) / digest.stats.reviewed);
	const previousCleanPercent = previousStats
		? previousStats.reviewed === 0
			? 0
			: Math.round((100 * previousStats.clean) / previousStats.reviewed)
		: null;
	const promptsChange = showChange
		? delta(digest.stats.prompts, previousStats.prompts)
		: "";
	const cleanChange = showChange
		? delta(cleanPercent, previousCleanPercent)
		: "";
	const categoryCards = CATEGORY_ORDER.map((category) => {
		const previous = previousStats?.categories[category] ?? null;
		return statCard(
			CATEGORY_LABEL[category],
			String(digest.stats.categories[category]),
			showChange
				? delta(digest.stats.categories[category], previous, true)
				: "",
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
	const taught = patterns.filter((pattern) => pattern.explanation);
	const others = patterns.filter((pattern) => !pattern.explanation);
	const unranked = digest.oneOffs;
	const categoryTotal = CATEGORY_ORDER.reduce(
		(sum, category) => sum + digest.stats.categories[category],
		0,
	);
	const split = categoryTotal
		? `<div class="split" role="img" aria-label="Findings by category">${CATEGORY_ORDER.filter(
				(category) => digest.stats.categories[category] > 0,
			)
				.map(
					(category) =>
						`<span class="seg ${category}" style="flex:${digest.stats.categories[category]}">${CATEGORY_LABEL[category]} ${percent(digest.stats.categories[category], categoryTotal)}%</span>`,
				)
				.join("")}</div>`
		: "";
	const lesson = digest.lesson
		? `<section class="note"><h2>This week</h2>${proseHtml(digest.lesson)}</section>`
		: "";
	const focus = digest.focus
		? `<section class="focusbox"><span class="label">Next week, practise</span><p>${escapeHtml(digest.focus)}</p></section>`
		: "";
	const lessons = taught.length
		? `<section><h2>Lessons</h2>${taught.map((pattern) => patternCard(pattern, showChange)).join("")}</section>`
		: "";
	const otherRows = others.length
		? `<section><h2>Also recurring</h2><div class="rows">${others.map(patternRow).join("")}</div></section>`
		: "";
	const oneOffItems = unranked.map(exampleItem).join("");
	const title =
		digest.scope === "all" ? "English Digest" : `Digest · ${digest.scope}`;
	const body = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · ${escapeHtml(digest.week)}</title>
<style>
:root{color-scheme:light dark;--fg:#1d1d1f;--mute:#6b6b70;--line:#e3e3e8;--bg:#fff;--soft:#f6f6f8;--sp:#c62828;--gr:#b26a00;--fl:#1565c0;--up:#c62828;--down:#2e7d32;--focus:#1d1d1f}
@media(prefers-color-scheme:dark){:root{--fg:#ececf0;--mute:#a1a1a9;--line:#3a3a42;--bg:#17171a;--soft:#242429;--sp:#ff7070;--gr:#ffbb58;--fl:#80b8ff;--up:#ff7777;--down:#79d58a;--focus:#ececf0}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.55 system-ui,-apple-system,sans-serif}a{color:inherit;text-decoration:none}main{max-width:860px;margin:0 auto;padding:28px 20px 100px}header{display:flex;justify-content:space-between;align-items:baseline;gap:18px;border-bottom:2px solid var(--fg);padding-bottom:9px}h1{font-size:24px;margin:0}h2{font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:var(--mute);margin:34px 0 12px}h3{font-size:18px;margin:0;line-height:1.3}.mute{color:var(--mute)}.spelling{color:var(--sp)}.grammar{color:var(--gr)}.fluency{color:var(--fl)}.chip{display:inline-block;font-size:11px;border:1px solid currentColor;border-radius:99px;padding:0 7px;line-height:19px;white-space:nowrap}.kpis{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:10px;margin:18px 0 10px}.kpi{background:var(--soft);border-radius:10px;padding:10px 12px;min-width:0}.kpi b{display:block;font-size:24px}.kpi small{font-size:12px;color:var(--mute)}.kpi small.spelling{color:var(--sp)}.kpi small.grammar{color:var(--gr)}.kpi small.fluency{color:var(--fl)}.up{color:var(--up)}.down{color:var(--down)}.new{font-size:10px;background:#222;color:#fff;border-radius:4px;padding:1px 5px}.split{display:flex;height:22px;border-radius:99px;overflow:hidden;font-size:11px;font-weight:600;margin:0 0 8px}.seg{display:flex;align-items:center;justify-content:center;color:#fff;white-space:nowrap;overflow:hidden;min-width:0}.seg.spelling{background:var(--sp)}.seg.grammar{background:var(--gr)}.seg.fluency{background:var(--fl)}.label{display:block;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--mute);margin-bottom:4px}.note ul{margin:0;padding-left:20px;font-size:16px}.note li{margin:6px 0}.note p{margin:6px 0}.focusbox{border-left:4px solid var(--down);background:var(--soft);border-radius:0 10px 10px 0;padding:10px 16px;margin:22px 0}.focusbox p{font-size:17px;font-weight:600;margin:0}.grader-change{border-left:3px solid #b26a00;padding-left:10px;color:var(--mute);font-size:13px}.chart{display:grid;gap:4px}.bar-row{display:grid;grid-template-columns:minmax(0,15em) 1fr 2.5em 3.5em;align-items:center;gap:10px;padding:3px 6px;border-radius:6px;font-size:14px}.bar-row:hover{background:var(--soft)}.bar-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.bar-track{height:12px;background:var(--soft);border-radius:99px;overflow:hidden}.bar{display:block;height:100%;border-radius:99px}.bar.spelling{background:var(--sp)}.bar.grammar{background:var(--gr)}.bar.fluency{background:var(--fl)}.bar-row b{text-align:right}.bar-delta{font-size:12px}.card{border:1px solid var(--line);border-radius:14px;padding:16px 18px;margin:0 0 16px}.card-head,.row-head{display:flex;align-items:center;flex-wrap:wrap;gap:10px}.count{font-weight:700;background:var(--soft);border-radius:99px;padding:0 9px;font-size:13px}.rule{font-size:16px;font-weight:600;margin:10px 0 6px}.row .rule{font-size:14px;font-weight:400;margin:4px 0}.explain{color:var(--mute);margin:4px 0 10px}.explain p,.explain ul{margin:4px 0}.examples{list-style:none;padding:0;margin:8px 0;display:grid;gap:6px}.examples li{background:var(--soft);border-radius:8px;padding:6px 10px}.ex{font:14px/1.5 ui-monospace,SFMono-Regular,monospace;overflow-wrap:anywhere}.ex del{background:#fde4e4;color:#8b1818;text-decoration:line-through;border-radius:3px;padding:0 2px}.ex ins{background:#ddf3df;color:#155d20;text-decoration:none;border-radius:3px;padding:0 2px}.why{display:inline;font-size:12px;color:var(--mute);margin-left:8px}.why[open]{display:block;margin:4px 0 0}.why p{margin:2px 0}summary{cursor:pointer}.more>summary{color:var(--mute);font-size:13px;margin:6px 0}.tip{border:1px dashed var(--line);border-radius:10px;padding:8px 12px;margin:12px 0 8px}.practice ol{margin:0;padding-left:20px}.practice li{margin:4px 0}.practice details{display:inline;margin-left:8px;font-size:13px;color:var(--mute)}.practice details[open]{display:block;margin:2px 0 0}.practice details p{margin:0;color:var(--down);font-weight:600}.rows{display:grid;gap:10px}.row{border-bottom:1px solid var(--line);padding-bottom:10px}.one-offs{margin-top:26px}.not-reviewed{font-size:13px;margin-top:19px}nav{display:flex;flex-direction:column;gap:6px;margin-top:34px;border-top:1px solid var(--line);padding-top:12px;font-size:13px}nav div:last-of-type{line-height:1.9}nav a{margin-right:4px;text-decoration:underline}.trend{width:60px;height:18px;vertical-align:middle;color:var(--mute)}@media(max-width:760px){main{padding:20px 14px 80px}.kpis{grid-template-columns:repeat(2,minmax(0,1fr))}header{align-items:flex-start;flex-direction:column}.card{padding:14px}.bar-row{grid-template-columns:1fr 2em;row-gap:3px}.bar-name{grid-column:1/-1;white-space:normal}.bar-delta{display:none}}
</style>
</head>
<body><main>
<header><h1>${escapeHtml(title)}</h1><span class="mute">Week ending ${escapeHtml(digest.week)} · ${escapeHtml(digest.from)} → ${escapeHtml(digest.week)}</span></header>
<div class="kpis">
${statCard("Prompts", String(digest.stats.prompts), promptsChange, "")}
${statCard("Clean", `${cleanPercent}%`, cleanChange, `${digest.stats.clean}/${digest.stats.reviewed} reviewed`)}
${categoryCards}
</div>
${graderChangeNote(context)}
${split}
${lesson}
${focus}
<section><h2>Your patterns</h2>${patterns.length ? patternChart(patterns, showChange) : '<p class="mute">Nothing recurred this week.</p>'}</section>
${lessons}
${otherRows}
<details class="one-offs"><summary><b>${unranked.length} one-off Findings</b> <span class="mute">single occurrences</span></summary><ul class="examples">${oneOffItems || '<li class="mute">None.</li>'}</ul></details>
${notReviewedLine(digest)}
${archiveNavigation(digest, context)}
</main></body></html>
`;
	return body;
}
