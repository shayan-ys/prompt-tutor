import type { Finding, PromptRecord, Scope } from "../types.ts";

const SCOPE_COLORS = [
	"#fca5a5",
	"#fdba74",
	"#fde047",
	"#86efac",
	"#67e8f9",
	"#93c5fd",
	"#c4b5fd",
	"#f9a8d4",
];

export interface MonthPageOptions {
	month: string;
	records: readonly PromptRecord[];
	scopes: readonly Scope[];
	allScopes: boolean;
	previousMonth?: string;
	nextMonth?: string;
}

export function escapeHtml(value: string): string {
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

function byNewest(a: PromptRecord, b: PromptRecord): number {
	if (a.captured_at !== b.captured_at)
		return a.captured_at < b.captured_at ? 1 : -1;
	if (a.id !== b.id) return a.id < b.id ? 1 : -1;
	if (a.scope !== b.scope) return a.scope < b.scope ? -1 : 1;
	return 0;
}

function localCapturedAt(record: PromptRecord): string {
	const date = new Date(record.captured_at);
	date.setUTCMinutes(date.getUTCMinutes() + record.utc_offset_minutes);
	const pad = (value: number) => String(value).padStart(2, "0");
	const year = date.getUTCFullYear();
	const month = pad(date.getUTCMonth() + 1);
	const day = pad(date.getUTCDate());
	const hour = pad(date.getUTCHours());
	const minute = pad(date.getUTCMinutes());
	const offset = record.utc_offset_minutes;
	const sign = offset < 0 ? "−" : "+";
	const absOffset = Math.abs(offset);
	return `${year}-${month}-${day} ${hour}:${minute} UTC${sign}${pad(Math.floor(absOffset / 60))}:${pad(absOffset % 60)}`;
}

function promptWithFindings(text: string, findings: Finding[]): string {
	const spans = [...findings].sort(
		(a, b) => a.start - b.start || a.end - b.end,
	);
	let output = "";
	let offset = 0;
	for (const finding of spans) {
		if (
			finding.start < offset ||
			finding.start < 0 ||
			finding.end < finding.start ||
			finding.end > text.length
		)
			continue;
		output += escapeHtml(text.slice(offset, finding.start));
		output += `<mark class="${finding.category}" title="Fix: ${escapeHtml(finding.fix)}">${escapeHtml(text.slice(finding.start, finding.end))}</mark>`;
		offset = finding.end;
	}
	return output + escapeHtml(text.slice(offset));
}

function wordDiff(before: string, after: string): string {
	const left = before.match(/\s+|[^\s]+/gu) ?? [];
	const right = after.match(/\s+|[^\s]+/gu) ?? [];
	const width = right.length + 1;
	const rows = left.length + 1;
	const table = new Uint16Array(rows * width);
	for (let i = left.length - 1; i >= 0; i--) {
		for (let j = right.length - 1; j >= 0; j--) {
			const cell = i * width + j;
			table[cell] =
				left[i] === right[j]
					? table[(i + 1) * width + j + 1] + 1
					: Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
		}
	}

	let i = 0;
	let j = 0;
	let output = "";
	let previousChangeWasWord = false;
	while (i < left.length || j < right.length) {
		if (i < left.length && j < right.length && left[i] === right[j]) {
			output += escapeHtml(left[i]);
			i++;
			j++;
			previousChangeWasWord = false;
		} else if (
			j < right.length &&
			(i >= left.length ||
				table[i * width + j + 1] > table[(i + 1) * width + j])
		) {
			const token = right[j++];
			if (previousChangeWasWord && /\S/u.test(token)) output += " ";
			output += `<ins>${escapeHtml(token)}</ins>`;
			previousChangeWasWord = /\S/u.test(token);
		} else {
			const token = left[i++];
			if (previousChangeWasWord && /\S/u.test(token)) output += " ";
			output += `<del>${escapeHtml(token)}</del>`;
			previousChangeWasWord = /\S/u.test(token);
		}
	}
	return output;
}

function monthNavigation(
	previousMonth: string | undefined,
	nextMonth: string | undefined,
): string {
	const previous = previousMonth
		? `<a href="${escapeHtml(previousMonth)}.html" rel="prev">← ${escapeHtml(previousMonth)}</a>`
		: "";
	const next = nextMonth
		? `<a href="${escapeHtml(nextMonth)}.html" rel="next">${escapeHtml(nextMonth)} →</a>`
		: "";
	return `<nav class="month-nav" aria-label="Month">${previous}${next}</nav>`;
}

function stateBadge(record: PromptRecord): string {
	switch (record.state) {
		case "pending":
			return '<span class="state pending">reviewing…</span>';
		case "skipped": {
			const reason =
				record.skip_reason === "too_long"
					? `too long (${record.word_count} words)`
					: "nothing to review";
			return `<span class="state skipped">skipped: ${reason}</span>`;
		}
		case "failed":
			return `<span class="state failed">EN ?</span><span class="failure">${escapeHtml(record.failure ?? "Review failed")}</span>`;
		case "reviewed":
			return '<span class="state reviewed">reviewed</span>';
	}
	throw new Error("Unknown Prompt state");
}

function graderLine(record: PromptRecord): string {
	if (!record.grader) return "";
	const grader = record.grader;
	const attempts = grader.attempts > 1 ? ` · ${grader.attempts} attempts` : "";
	return `<p class="grader">graded by ${escapeHtml(grader.model)} · ${escapeHtml(grader.requested_reasoning)} · prompt ${escapeHtml(grader.prompt_hash)}${attempts}</p>`;
}

function reviewBody(record: PromptRecord): string {
	const review = record.review;
	if (record.state === "skipped") {
		return `<details class="folded-prompt"><summary>Prompt · show skipped text</summary><pre>${escapeHtml(record.text)}</pre></details>`;
	}
	const prompt = `<div class="label">Prompt</div><pre class="prompt">${review ? promptWithFindings(record.text, review.findings) : escapeHtml(record.text)}</pre>`;
	if (record.state !== "reviewed" || !review)
		return `${prompt}${record.state === "failed" ? graderLine(record) : ""}`;
	if (review.findings.length === 0)
		return `${prompt}<p class="clean">No Findings</p>${graderLine(record)}`;

	const rows = review.findings
		.map(
			(finding) =>
				`<tr><td class="category ${finding.category}">${escapeHtml(finding.category)}</td><td><small class="kind">${escapeHtml(finding.kind)}</small> · <del>${escapeHtml(finding.quote)}</del> → <ins>${escapeHtml(finding.fix)}</ins></td><td>${escapeHtml(finding.why)}</td></tr>`,
		)
		.join("");
	const rewrite =
		review.rewrite === null
			? ""
			: `<div class="label">Rewrite · word diff from Prompt</div><pre class="rewrite">${wordDiff(record.text, review.rewrite)}</pre>`;
	const tip =
		review.tip === null
			? ""
			: `<div class="label">Tip</div><p class="tip">${escapeHtml(review.tip)}</p>`;
	return `${prompt}<div class="label">Findings</div><table><thead><tr><th>Category</th><th>Finding</th><th>Why</th></tr></thead><tbody>${rows}</tbody></table>${rewrite}${tip}${graderLine(record)}`;
}

function renderEntry(
	record: PromptRecord,
	options: MonthPageOptions,
	scopesByName: Map<string, Scope>,
): string {
	const scope = scopesByName.get(record.scope);
	const scopeIndex = scope?.index ?? 0;
	const badge =
		options.allScopes && scope
			? `<span class="scope-badge" style="--scope-color:${SCOPE_COLORS[((scope.index % SCOPE_COLORS.length) + SCOPE_COLORS.length) % SCOPE_COLORS.length]}">${escapeHtml(scope.name)}</span>`
			: "";
	const dataScope = options.allScopes
		? ` data-scope-index="${scopeIndex}"`
		: "";
	return `<article class="entry" id="${escapeHtml(record.id)}"${dataScope}>\n<header>${badge}<time datetime="${escapeHtml(record.captured_at)}">${localCapturedAt(record)}</time><span class="words">${record.word_count} words</span>${stateBadge(record)}</header>\n${reviewBody(record)}\n</article>`;
}

function scopeFilter(scopes: readonly Scope[]): string {
	const controls = [
		'<label><input id="scope-filter-all" type="radio" name="scope-filter" value="all" checked> All Scopes</label>',
		...scopes.map(
			(scope) =>
				`<label><input id="scope-filter-${scope.index}" type="radio" name="scope-filter" value="${scope.index}"> ${escapeHtml(scope.name)}</label>`,
		),
	].join("");
	const selectors = scopes
		.map(
			(scope) =>
				`body:has(#scope-filter-${scope.index}:checked) .entry:not([data-scope-index="${scope.index}"]) { display:none; }`,
		)
		.join("\n");
	return `<fieldset class="scope-filter"><legend>Show</legend>${controls}</fieldset><style>${selectors}</style>`;
}

const STYLES = `
:root{color-scheme:light dark;--bg:#fff;--fg:#202124;--muted:#687078;--panel:#f5f6f7;--line:#d9dde1;--link:#1759a6;--green:#166534;--red:#991b1b;--tip:#fff7d6;--tip-line:#e2b635}
@media(prefers-color-scheme:dark){:root{--bg:#17191c;--fg:#e8eaed;--muted:#a0a7b0;--panel:#22262b;--line:#3c424a;--link:#8ab4f8;--green:#86efac;--red:#fca5a5;--tip:#3b321c;--tip-line:#d6ad3c}}
*{box-sizing:border-box}body{max-width:940px;margin:2rem auto;padding:0 1.25rem 4rem;background:var(--bg);color:var(--fg);font:15px/1.55 system-ui,-apple-system,sans-serif}a{color:var(--link)}h1{font-size:1.8rem;margin:.1em 0}header.page-header{border-bottom:1px solid var(--line);padding-bottom:1rem;margin-bottom:1rem}.subtitle{color:var(--muted);margin:.2rem 0}.month-nav{display:flex;justify-content:space-between;gap:1em;margin:.8rem 0}.month-nav a{text-decoration:none}.scope-filter{display:flex;align-items:center;flex-wrap:wrap;gap:.35rem 1rem;border:1px solid var(--line);border-radius:.6rem;margin:1rem 0;padding:.5rem .8rem}.scope-filter legend{color:var(--muted);padding:0 .3rem}.scope-filter label{white-space:nowrap}.entry{border:1px solid var(--line);border-radius:.75rem;padding:1rem 1.1rem;margin:1.1rem 0;background:var(--bg);scroll-margin-top:1rem}.entry>header{display:flex;align-items:center;flex-wrap:wrap;gap:.45rem .65rem;margin-bottom:.8rem}.entry time,.words{color:var(--muted);font-size:.9rem}.state,.scope-badge{display:inline-flex;align-items:center;border-radius:999px;padding:.12rem .55rem;font-size:.8rem;font-weight:650}.state{background:var(--panel)}.state.pending{color:#965a00}.state.skipped{color:var(--muted)}.state.failed{color:#b42318;background:#fee4e2}.state.reviewed{color:var(--green);background:color-mix(in srgb,var(--green) 13%,transparent)}.failure{color:var(--red);font-size:.9rem}.scope-badge{background:var(--scope-color);color:#17191c}.label{font-size:.72rem;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);margin:.8rem 0 .25rem}.prompt,.rewrite,.folded-prompt pre{white-space:pre-wrap;overflow-wrap:anywhere;background:var(--panel);padding:.75rem .85rem;border-radius:.5rem;margin:.25rem 0;font:14px/1.6 ui-monospace,SFMono-Regular,monospace}mark{border-radius:.15em;padding:0 .04em}mark.spelling{background:#ffd2e4;color:#5c1636}mark.grammar{background:#ffdfa8;color:#5a3500}mark.fluency{background:#c9eaff;color:#003a5c}@media(prefers-color-scheme:dark){mark.spelling{background:#682d49;color:#ffe0ee}mark.grammar{background:#634313;color:#ffe7bd}mark.fluency{background:#16445a;color:#dcf5ff}}table{border-collapse:collapse;width:100%;font-size:.93rem}th{text-align:left;font-size:.78rem;color:var(--muted);font-weight:600}th,td{border-top:1px solid var(--line);padding:.5rem .55rem;vertical-align:top}td.category{font-weight:650;white-space:nowrap}.spelling{color:#a51d58}.grammar{color:#9a5b00}.fluency{color:#0878a0}@media(prefers-color-scheme:dark){.spelling{color:#ff9fc7}.grammar{color:#ffd080}.fluency{color:#8ee2ff}}.kind{display:inline-block;color:var(--muted);font-size:.82rem}del{background:#ffdede;color:#8b1717;text-decoration:line-through;border-radius:.12em}ins{background:#daf5df;color:#14532d;text-decoration:none;border-radius:.12em}@media(prefers-color-scheme:dark){del{background:#5b2929;color:#ffc1c1}ins{background:#214c31;color:#c0f2cd}}.clean{color:var(--green);font-weight:650}.tip{background:var(--tip);border-left:3px solid var(--tip-line);border-radius:.3rem;padding:.55rem .75rem;margin:.25rem 0}.grader{margin:.9rem 0 0;color:var(--muted);font-size:.78rem}.folded-prompt{margin:.55rem 0}.folded-prompt summary{color:var(--muted);cursor:pointer}.folded-prompt pre{margin-top:.5rem}
`;

export function renderMonthPage(options: MonthPageOptions): string {
	const records = [...options.records].sort(byNewest);
	const scopesByName = new Map(
		options.scopes.map((scope) => [scope.name, scope]),
	);
	const title = options.allScopes
		? "All Scopes"
		: (options.scopes[0]?.name ?? "Review log");
	const entries = records
		.map((record) => renderEntry(record, options, scopesByName))
		.join("\n");
	const filter = options.allScopes ? scopeFilter(options.scopes) : "";
	return `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} · ${escapeHtml(options.month)} · prompt-tutor Review log</title><style>${STYLES}</style></head><body>\n<header class="page-header"><h1>${escapeHtml(title)} Review log</h1><p class="subtitle">${escapeHtml(options.month)} · ${records.length} ${records.length === 1 ? "Prompt" : "Prompts"}</p>${monthNavigation(options.previousMonth, options.nextMonth)}</header>\n${filter}\n<main>${entries}</main>\n</body></html>\n`;
}

export function renderStubPage(month: string, id: string): string {
	const target = `../${month}.html#${id}`;
	return `<!doctype html><meta http-equiv="refresh" content="0; url=${escapeHtml(target)}">`;
}
