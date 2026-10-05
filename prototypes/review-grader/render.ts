// PROTOTYPE — renders data/results.json to data/report.html. Run: bun prototypes/review-grader/render.ts
type Finding = { quote: string; fix: string; category: string; why: string; start?: number; end?: number };
type Review = { findings: Finding[]; rewrite: string | null; tip: string | null };
type Attempt = { ms: number; via: string; review: Review | null; problems: string[]; usage?: { input?: number; output?: number }; error?: string };
type Result = { id: number; text: string; words: number; attempts: Attempt[] };

const DATA = new URL("./data/", import.meta.url).pathname;
const { model, results }: { model: string; results: Result[] } = await Bun.file(DATA + "results.json").json();

const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);

function highlight(text: string, findings: Finding[]): string {
	const spans = findings.filter(f => f.start !== undefined).sort((a, b) => a.start! - b.start!);
	let out = "";
	let at = 0;
	for (const f of spans) {
		if (f.start! < at) continue;
		out += esc(text.slice(at, f.start)) + `<mark class="${f.category}" title="${esc(f.fix)}">${esc(f.quote)}</mark>`;
		at = f.end!;
	}
	return out + esc(text.slice(at));
}

function wordDiff(a: string, b: string): string {
	const x = a.split(/(\s+)/);
	const y = b.split(/(\s+)/);
	const dp = Array.from({ length: x.length + 1 }, () => new Array<number>(y.length + 1).fill(0));
	for (let i = x.length - 1; i >= 0; i--) for (let j = y.length - 1; j >= 0; j--) dp[i][j] = x[i] === y[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
	let i = 0, j = 0, out = "";
	while (i < x.length || j < y.length) {
		if (i < x.length && j < y.length && x[i] === y[j]) out += esc(x[i++]), j++;
		else if (j < y.length && (i >= x.length || dp[i][j + 1] >= dp[i + 1][j])) out += `<ins>${esc(y[j++])}</ins>`;
		else out += `<del>${esc(x[i++])}</del>`;
	}
	return out;
}

const final = results.map(r => r.attempts.at(-1)!);
const cats: Record<string, number> = {};
for (const a of final) for (const f of a.review?.findings ?? []) cats[f.category] = (cats[f.category] ?? 0) + 1;
const summary = [
	`model ${model}, ${results.length} Prompts`,
	`tool call on first attempt: ${results.filter(r => r.attempts[0].via === "tool").length}/${results.length}`,
	`valid on first attempt: ${results.filter(r => r.attempts[0].problems.length === 0).length}, after retry: ${final.filter(a => a.problems.length === 0).length}`,
	`clean (no Findings): ${final.filter(a => a.review?.findings.length === 0).length}`,
	`Findings: ${Object.entries(cats).map(([k, v]) => `${k} ${v}`).join(", ")}`,
	`median latency ${final.map(a => a.ms).sort((a, b) => a - b)[Math.floor(final.length / 2)]} ms`,
];

const cards = results.map((r, n) => {
	const a = r.attempts.at(-1)!;
	const rv = a.review;
	const findings = rv?.findings ?? [];
	return `<section>
<h2>#${n + 1} <small>${r.words} words · ${a.via} · ${a.ms} ms · attempts ${r.attempts.length}${a.problems.length ? ` · <b class="bad">INVALID: ${esc(a.problems.join("; "))}</b>` : ""}</small></h2>
<div class="label">Prompt (as sent to grader)</div><pre>${highlight(r.text, findings)}</pre>
${findings.length === 0 ? `<p class="clean">No Findings</p>` : `<table>${findings.map(f => `<tr><td class="${f.category}">${f.category}</td><td><del>${esc(f.quote)}</del> → <ins>${esc(f.fix)}</ins></td><td>${esc(f.why)}</td></tr>`).join("")}</table>
<div class="label">Rewrite (diff vs Prompt)</div><pre>${wordDiff(r.text, rv?.rewrite ?? "")}</pre>
<div class="label">Tip</div><p class="tip">${esc(rv?.tip ?? "")}</p>`}
<div class="verdict">Verdict: <label><input type="radio" name="v${n}"> useful</label> <label><input type="radio" name="v${n}"> nitpicky / register false positive</label> <label><input type="radio" name="v${n}"> missed errors</label> <label><input type="radio" name="v${n}"> wrong</label></div>
</section>`;
});

await Bun.write(
	DATA + "report.html",
	`<!doctype html><meta charset="utf-8"><title>PROTOTYPE grader report</title>
<style>
body{font:15px/1.5 system-ui;max-width:900px;margin:2em auto;padding:0 1em;color:#222}
pre{white-space:pre-wrap;background:#f6f6f6;padding:.6em;border-radius:6px;font:14px/1.5 ui-monospace,monospace}
mark.spelling{background:#fdd} mark.grammar{background:#ffe9a8} mark.fluency{background:#d6ecff}
td.spelling{color:#b00} td.grammar{color:#a60} td.fluency{color:#06c}
del{background:#fdd;text-decoration:line-through} ins{background:#dfd;text-decoration:none}
table{border-collapse:collapse;width:100%} td{border-top:1px solid #ddd;padding:.3em .5em;vertical-align:top}
section{border:1px solid #ddd;border-radius:8px;padding:.5em 1em;margin:1.5em 0}
.label{font-size:12px;color:#666;text-transform:uppercase;margin-top:.6em} .clean{color:#080;font-weight:600}
.tip{background:#fff8dc;padding:.5em;border-radius:6px} .bad{color:#b00} small{color:#666;font-weight:normal;font-size:13px}
.banner{background:#222;color:#fff;padding:.5em 1em;border-radius:6px}
</style>
<div class="banner">PROTOTYPE — issue #5 Review schema and grader prompt. Local only: contains real Prompts; do not commit.</div>
<ul>${summary.map(s => `<li>${esc(s)}</li>`).join("")}</ul>
${cards.join("\n")}`,
);
console.log("wrote", DATA + "report.html");
