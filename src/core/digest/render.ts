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

function findingExample(finding: DigestFinding, showWhy = false): string {
	const context = `<details class="sentence"><summary>Show sentence</summary><p>${escapeHtml(finding.sentence)}</p></details>`;
	const why = showWhy
		? `<div class="mute why">${escapeHtml(finding.why)}</div>`
		: "";
	return `<div class="example"><span class="ex">${findingDiffHtml(finding)}</span>${context}${why}</div>`;
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

/** Examples shown before the rest fold into "more examples". */
const VISIBLE_EXAMPLES = 6;

function paragraphs(text: string, className: string): string {
	return text
		.split(/\n\s*\n/u)
		.map((paragraph) => paragraph.trim())
		.filter(Boolean)
		.map((paragraph) => `<p class="${className}">${escapeHtml(paragraph)}</p>`)
		.join("");
}

function patternCard(pattern: DigestPattern, rank: number): string {
	const visible = pattern.examples.slice(0, VISIBLE_EXAMPLES);
	const folded = pattern.examples.slice(VISIBLE_EXAMPLES);
	const examples = visible.map((finding) => findingExample(finding, true));
	const more = folded.length
		? `<details class="more"><summary>${folded.length} more example${folded.length === 1 ? "" : "s"}</summary>${folded.map((finding) => findingExample(finding, true)).join("")}</details>`
		: "";
	const explanation = pattern.explanation
		? paragraphs(pattern.explanation, "explain")
		: "";
	const tip = pattern.tip
		? `<p class="tip"><b>Check before sending:</b> ${escapeHtml(pattern.tip)}</p>`
		: "";
	const practice = pattern.practice?.length
		? `<h4>Practice</h4><ol class="practice">${pattern.practice
				.map(
					(exercise) =>
						`<li><span>${escapeHtml(exercise.sentence)}</span><details><summary>Answer</summary><p>${escapeHtml(exercise.answer)}</p></details></li>`,
				)
				.join("")}</ol>`
		: "";
	return `<article class="card" id="pattern-${rank}"><div class="card-head"><span class="rank">${rank}</span><h3>${escapeHtml(pattern.name)}</h3>${categoryChips(pattern.categories)}</div><div class="card-stats"><span><b>${pattern.count}</b> this week</span><span>${delta(pattern.count, pattern.previousCount, true)} vs last</span><span class="spark">${sparkline(pattern)}</span></div><p class="rule">${escapeHtml(pattern.rule)}</p>${explanation}${tip}<h4>From your prompts</h4>${examples.join("")}${more}${practice}</article>`;
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
	const patternCards = patterns
		.map((pattern, index) => patternCard(pattern, index + 1))
		.join("");
	const contents = patterns.length
		? `<ol class="contents">${patterns.map((pattern, index) => `<li><a href="#pattern-${index + 1}">${escapeHtml(pattern.name)}</a> <span class="mute">${pattern.count}</span></li>`).join("")}</ol>`
		: "";
	const oneOffRows = unranked
		.map(
			(finding) =>
				`<tr><td>${categoryChips([finding.category])}</td><td>${findingExample(finding, true)}</td></tr>`,
		)
		.join("");
	const lesson = digest.lesson
		? `<section class="note"><h2>Teacher’s note</h2>${paragraphs(digest.lesson, "lesson")}</section>`
		: "";
	const focus = digest.focus
		? `<section class="focusbox"><div class="eyebrow">Your habit for next week</div><p class="focus">${escapeHtml(digest.focus)}</p></section>`
		: "";
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
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 system-ui,-apple-system,sans-serif}a{color:inherit}main{max-width:820px;margin:0 auto;padding:28px 20px 100px}header{display:flex;justify-content:space-between;align-items:baseline;gap:18px;border-bottom:2px solid var(--fg);padding-bottom:9px}h1{font-size:24px;margin:0}h2{font-size:14px;text-transform:uppercase;letter-spacing:.05em;margin:34px 0 10px}h3{font-size:19px;margin:0;line-height:1.3}h4{font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:var(--mute);margin:18px 0 6px}.mute{color:var(--mute)}.spelling{color:var(--sp)}.grammar{color:var(--gr)}.fluency{color:var(--fl)}.chip{display:inline-block;font-size:11px;border:1px solid currentColor;border-radius:99px;padding:0 7px;line-height:19px;white-space:nowrap}.kpis{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:10px;margin:18px 0}.kpi{background:var(--soft);border-radius:8px;padding:10px 12px;min-width:0}.kpi b{display:block;font-size:22px}.kpi small{font-size:12px;color:var(--mute)}.kpi small.spelling{color:var(--sp)}.kpi small.grammar{color:var(--gr)}.kpi small.fluency{color:var(--fl)}.up{color:var(--up)}.down{color:var(--down)}.new{font-size:11px;background:#222;color:#fff;border-radius:4px;padding:1px 5px}.note .lesson{font-size:17px;line-height:1.7;margin:0 0 14px;max-width:68ch}.focusbox{border-left:4px solid var(--focus);background:var(--soft);border-radius:0 8px 8px 0;padding:10px 18px;margin:26px 0}.focus{font-size:17px;line-height:1.6;margin:4px 0}.eyebrow{font-size:12px;text-transform:uppercase;color:var(--mute);letter-spacing:.04em}.grader-change{border-left:3px solid #b26a00;padding-left:10px;color:var(--mute);font-size:13px}.contents{margin:0 0 18px;padding-left:22px;line-height:1.9}.contents a{text-decoration:none;border-bottom:1px solid var(--line)}.card{border:1px solid var(--line);border-radius:12px;padding:18px 20px;margin:0 0 18px}.card-head{display:flex;align-items:center;flex-wrap:wrap;gap:10px}.card-head .rank{font-weight:700;color:var(--mute)}.card-stats{display:flex;flex-wrap:wrap;align-items:center;gap:16px;font-size:13px;color:var(--mute);margin:6px 0 10px}.card-stats b{color:var(--fg);font-size:15px}.rule{font-weight:600;margin:8px 0}.explain{margin:8px 0;max-width:68ch}.tip{background:var(--soft);border-radius:8px;padding:8px 12px;margin:12px 0;font-size:15px}.practice{padding-left:22px;margin:4px 0}.practice li{margin:6px 0}.practice details{font-size:14px}.practice summary{color:var(--mute);font-size:13px}.practice details p{margin:2px 0;color:var(--down)}.more>summary{color:var(--mute);font-size:13px;margin:6px 0}.table-wrap{overflow-x:auto}table{border-collapse:collapse;width:100%}td{padding:9px 10px;border-bottom:1px solid var(--line);vertical-align:top}.trend{width:72px;height:22px;vertical-align:middle;color:var(--mute)}.ex{font:14px/1.5 ui-monospace,SFMono-Regular,monospace;overflow-wrap:anywhere}.example{margin:6px 0}.example del{background:#fde4e4;color:#8b1818;text-decoration:line-through;border-radius:3px;padding:0 2px}.example ins{background:#ddf3df;color:#155d20;text-decoration:none;border-radius:3px;padding:0 2px}.sentence{font:12px/1.45 system-ui,sans-serif;color:var(--mute)}.sentence summary{cursor:pointer}.sentence p{margin:3px 0 7px}.why{font-size:13px;margin-top:1px}details>summary{cursor:pointer}.one-offs{margin-top:26px}.not-reviewed{font-size:13px;margin-top:19px}nav{display:flex;flex-direction:column;gap:6px;margin-top:34px;border-top:1px solid var(--line);padding-top:12px;font-size:13px}nav div:last-of-type{line-height:1.9}nav a{margin-right:4px}@media(max-width:760px){main{padding:20px 14px 80px}.kpis{grid-template-columns:repeat(2,minmax(0,1fr))}header{align-items:flex-start;flex-direction:column}.card{padding:14px}.note .lesson,.focus{font-size:16px}}
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
${lesson}
${focus}
<section><h2>Lessons by Pattern</h2>${patterns.length ? `${contents}${patternCards}` : '<p class="mute">Nothing recurred this week.</p>'}</section>
<details class="one-offs"><summary><b>${unranked.length} one-off Findings</b> <span class="mute">(single occurrences; not ranked)</span></summary><div class="table-wrap"><table><tbody>${oneOffRows || '<tr><td class="mute">None.</td></tr>'}</tbody></table></div></details>
${notReviewedLine(digest)}
${archiveNavigation(digest, context)}
</main></body></html>
`;
	return body;
}
