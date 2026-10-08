// PROTOTYPE — throwaway, never merged to main. Answers issue #7 "Watcher terminal layout".
// Three structurally different Watcher layouts, switchable with ←/→, over the states a Watcher must show.
//
//   bun prototypes/watcher/watcher.ts              interactive (needs a TTY)
//   bun prototypes/watcher/watcher.ts --real FILE  use a results-v2.json from prototype/review-schema (local only, never commit it)
//   bun prototypes/watcher/watcher.ts --dump       print every variant × entry once, for review without a TTY
//   bun prototypes/watcher/watcher.ts --html OUT   write a comparison page with every layout and state, for viewing in a browser
//
// Keys: ←/→ variant · j/k (↑/↓) older/newer Prompt · s Scope (all → work → personal) · o links (OSC 8 / plain)
//       space simulate a new Prompt (pending, then reviewed) · q quit
// Links open stand-in Review log stubs written to $TMPDIR/prompt-tutor-watcher-proto/ (the real paths come from the store).

import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

type Category = "spelling" | "grammar" | "fluency";
type Finding = { quote: string; fix: string; category: Category; why: string; start: number; end: number };
type Review = { findings: Finding[]; rewrite: string | null; tip: string | null };
type Scope = "work" | "personal";
type Entry = {
	id: string;
	scope: Scope;
	at: Date;
	text: string;
	words: number;
	state: "reviewed" | "pending" | "failed" | "skipped";
	review?: Review;
	problem?: string;
	pendingSince?: number;
};

// ── fixtures (synthetic; real Prompts stay local) ────────────────────────────

function finding(text: string, quote: string, fix: string, category: Category, why: string): Finding {
	const start = text.indexOf(quote);
	if (start < 0) throw new Error(`fixture quote not found: ${quote}`);
	return { quote, fix, category, why, start, end: start + quote.length };
}

function fixtures(): Entry[] {
	const t0 = new Date("2026-10-08T13:41:00");
	const at = (min: number) => new Date(t0.getTime() + min * 60_000);
	const words = (s: string) => s.split(/\s+/).filter(Boolean).length;
	const p1 = "can you checkout why the build is failling on main, i think its related with the bun upgrade we did yesterday";
	const p2 = "add the receipt to the car folder and update the index";
	const p3 = "please make the tests more robust, currently they are depending to the network and fails randomly on CI";
	const p4 = "Research how can I connect my keyboard to the laptop over USB and what software I need for recording";
	const p5 = "ok lets do the option B but keep the old config around incase we need to rollback";
	const p6 = "here is the full log from the failing deploy, read all of it and tell me what went wrong …";
	return [
		{
			id: "20261008-134100-a1f3", scope: "work", at: at(0), text: p1, words: words(p1), state: "reviewed",
			review: {
				findings: [
					finding(p1, "checkout", "check out", "grammar", "'Checkout' is a noun; the verb is two words."),
					finding(p1, "failling", "failing", "spelling", "Only one 'l' before '-ing' here."),
					finding(p1, "its", "it's", "spelling", "'It's' means 'it is'; 'its' is possessive."),
					finding(p1, "related with", "related to", "fluency", "Native speakers say 'related to'."),
				],
				rewrite: "can you check out why the build is failing on main? i think it's related to the bun upgrade we did yesterday",
				tip: "Phrasal verbs are two words (check out, set up, log in); the one-word form is the noun.",
			},
		},
		{ id: "20261008-134412-07bc", scope: "personal", at: at(3), text: p2, words: words(p2), state: "reviewed", review: { findings: [], rewrite: null, tip: null } },
		{
			id: "20261008-135030-9d21", scope: "work", at: at(9), text: p3, words: words(p3), state: "reviewed",
			review: {
				findings: [
					finding(p3, "are depending to", "depend on", "grammar", "'Depend' takes 'on', and the simple present fits a habit."),
					finding(p3, "fails", "fail", "grammar", "The subject 'they' needs 'fail'."),
				],
				rewrite: "please make the tests more robust; right now they depend on the network and fail randomly on CI",
				tip: "Use the simple present for things that keep happening: 'they fail', not 'they are failing'.",
			},
		},
		{ id: "20261008-135702-c4e8", scope: "personal", at: at(16), text: p4, words: words(p4), state: "failed", problem: "invalid output after retry: findings[0].quote not found in the Prompt" },
		{ id: "20261008-140115-5a90", scope: "work", at: at(20), text: p6, words: 412, state: "skipped" },
		{
			id: "20261008-140348-e2d7", scope: "work", at: at(22), text: p5, words: words(p5), state: "reviewed",
			review: {
				findings: [
					finding(p5, "lets", "let's", "spelling", "'Let's' is 'let us'."),
					finding(p5, "the option B", "option B", "grammar", "No article before a labelled option."),
					finding(p5, "incase", "in case", "spelling", "'In case' is two words."),
					finding(p5, "rollback", "roll back", "grammar", "The verb is two words; 'rollback' is the noun."),
				],
				rewrite: "ok, let's go with option B, but keep the old config around in case we need to roll back",
				tip: "Labelled choices take no article: 'option B', 'step 3', 'plan A'.",
			},
		},
	];
}

type RawResult = { id: number; text: string; words?: number; attempts: { review: Review | null; problems: string[]; error?: string }[] };

async function realEntries(path: string): Promise<Entry[]> {
	// Unchecked: the file is the grader harness's own output on prototype/review-schema.
	const { results } = (await Bun.file(path).json()) as { results: RawResult[] };
	const t0 = Date.now() - results.length * 7 * 60_000;
	return results.map((r, n): Entry => {
		const last = r.attempts.at(-1);
		const id = `real-${r.id}`;
		const base = { id, scope: (n % 3 === 0 ? "personal" : "work") as Scope, at: new Date(t0 + n * 7 * 60_000), text: r.text, words: r.words ?? r.text.split(/\s+/).length };
		return last?.review && last.problems.length === 0
			? { ...base, state: "reviewed", review: last.review }
			: { ...base, state: "failed", problem: last?.problems?.join("; ") || last?.error || "no review" };
	});
}

// ── styling and wrapping ─────────────────────────────────────────────────────

const ESC = "\x1b[";
const RESET = `${ESC}0m`;
const fg = (n: number) => `${ESC}38;5;${n}m`;
const bg = (n: number) => `${ESC}48;5;${n}m`;
const BOLD = `${ESC}1m`, DIM = `${ESC}2m`, ITAL = `${ESC}3m`, UL = `${ESC}4m`, STRIKE = `${ESC}9m`, INV = `${ESC}7m`;
const CAT: Record<Category, { fg: number; bg: number; glyph: string }> = {
	spelling: { fg: 213, bg: 89, glyph: "S" },
	grammar: { fg: 214, bg: 94, glyph: "G" },
	fluency: { fg: 81, bg: 24, glyph: "F" },
};
const DEL = fg(203) + STRIKE;
const INS = fg(114) + BOLD;

type Seg = { t: string; s?: string; href?: string };
let osc8 = true;

function piece(p: Seg): string {
	const body = p.href && osc8 ? `\x1b]8;;${p.href}\x1b\\${p.t}\x1b]8;;\x1b\\` : p.t;
	return p.s ? p.s + body + RESET : body;
}

/** Greedy word wrap over styled segments; "\n" forces a break. */
function wrap(segs: Seg[], width: number, indent = "", firstIndent = indent): string[] {
	const out: string[] = [];
	let line: Seg[] = [];
	let len = 0;
	let pad = firstIndent;
	const flush = () => {
		while (line.length && /^\s+$/.test(line.at(-1)!.t)) line.pop();
		out.push(pad + line.map(piece).join(""));
		line = [];
		len = 0;
		pad = indent;
	};
	for (const seg of segs) {
		for (const tok of seg.t.split(/(\n|\s+)/)) {
			if (!tok) continue;
			if (tok === "\n") { flush(); continue; }
			const room = width - pad.length;
			if (/^\s+$/.test(tok)) { if (len) { line.push({ ...seg, t: " " }); len++; } continue; }
			let word = tok;
			while (word.length > room) {
				if (len) flush();
				line.push({ ...seg, t: word.slice(0, room) });
				len = room;
				flush();
				word = word.slice(room);
			}
			if (len + word.length > room) flush();
			line.push({ ...seg, t: word });
			len += word.length;
		}
	}
	if (len || out.length === 0) flush();
	return out;
}

const visible = (s: string) => s.replace(/\x1b\]8;;[^\x1b]*\x1b\\/g, "").replace(/\x1b\[[0-9;]*m/g, "").length;
const rpad = (s: string, w: number) => s + " ".repeat(Math.max(0, w - visible(s)));
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const hhmm = (d: Date) => d.toTimeString().slice(0, 5);

type DiffTok = { t: string; op: "=" | "-" | "+"; cat?: Category };

/** Word diff of Prompt → Rewrite, grouped into hunks (old words, then new words); tokens carry the overlapping Finding's category. */
function diff(a: string, b: string, findings: Finding[]): DiffTok[] {
	const x = a.split(/(\s+)/), y = b.split(/(\s+)/);
	const dp = Array.from({ length: x.length + 1 }, () => new Array<number>(y.length + 1).fill(0));
	for (let i = x.length - 1; i >= 0; i--) for (let j = y.length - 1; j >= 0; j--) dp[i][j] = x[i] === y[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
	const offs: number[] = [];
	x.reduce((o, t) => (offs.push(o), o + t.length), 0);
	const catAt = (o: number) => findings.find(f => o >= f.start && o < f.end)?.category;
	const out: DiffTok[] = [];
	let dels: DiffTok[] = [], ins: DiffTok[] = [], hunkCat: Category | undefined;
	const flush = () => {
		const shared: DiffTok[] = [];
		while (dels.length && ins.length && dels.at(-1)!.op === "=" && ins.at(-1)!.op === "=") shared.unshift(dels.pop()!), ins.pop();
		out.push(...dels.map(d => ({ ...d, op: "-" as const, cat: hunkCat })), ...ins.map(d => ({ ...d, op: "+" as const, cat: hunkCat })), ...shared);
		dels = [];
		ins = [];
		hunkCat = undefined;
	};
	let i = 0, j = 0;
	while (i < x.length || j < y.length) {
		const open = dels.length + ins.length > 0;
		if (i < x.length && j < y.length && x[i] === y[j]) {
			// Whitespace inside a change stays in the hunk so "checkout" → "check out" reads as one edit.
			if (open && /^\s+$/.test(x[i])) { const tok: DiffTok = { t: x[i], op: "=" }; dels.push(tok); ins.push(tok); }
			else { flush(); out.push({ t: x[i], op: "=" }); }
			i++; j++;
		} else if (i < x.length && (j >= y.length || dp[i + 1][j] >= dp[i][j + 1])) {
			hunkCat ??= catAt(offs[i]);
			dels.push({ t: x[i++], op: "-" });
		} else {
			hunkCat ??= catAt(offs[i] ?? a.length);
			ins.push({ t: y[j++], op: "+" });
		}
	}
	flush();
	return out;
}

// ── links ────────────────────────────────────────────────────────────────────

const LOG_ROOT = join(tmpdir(), "prompt-tutor-watcher-proto");

/** Scope view links to the Scope log stub; the all-Scopes view links to the all-Scopes stub (issue #11). */
function stubUrl(e: Entry, view: View): string {
	return pathToFileURL(join(LOG_ROOT, view === "all" ? "all" : e.scope, "log", "r", `${e.id}.html`)).href;
}

function writeStubs(entries: Entry[]) {
	const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);
	for (const e of entries) {
		const r = e.state === "reviewed" ? e.review : undefined;
		const body = `<h1>Review log stand-in · ${e.scope} · ${e.at.toISOString()}</h1><p>${esc(e.text)}</p><p><b>${e.state}</b> ${esc(e.problem ?? "")}</p>${
			r ? `<ul>${r.findings.map(f => `<li>[${f.category}] <del>${esc(f.quote)}</del> → <ins>${esc(f.fix)}</ins> — ${esc(f.why)}</li>`).join("")}</ul><p>${esc(r.rewrite ?? "")}</p><p><i>${esc(r.tip ?? "")}</i></p>` : ""
		}`;
		for (const dir of [e.scope, "all"]) {
			const d = join(LOG_ROOT, dir, "log", "r");
			mkdirSync(d, { recursive: true });
			writeFileSync(join(d, `${e.id}.html`), `<!doctype html><meta charset=utf-8><title>PROTOTYPE stub</title>${body}`);
		}
	}
}

function linkSegs(e: Entry, view: View, label: string): Seg[] {
	const href = stubUrl(e, view);
	return osc8 ? [{ t: label, s: fg(75) + UL, href }] : [{ t: href, s: fg(75) + DIM }];
}

// ── shared state pieces ──────────────────────────────────────────────────────

type View = "all" | Scope;
const SPIN = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
/** Spinner frame plus seconds since the Prompt was captured. */
const pendingLabel = (e: Entry) =>
	`${SPIN[Math.floor(Date.now() / 100) % SPIN.length]} reviewing… ${Math.floor((Date.now() - (e.pendingSince ?? Date.now())) / 1000)}s`;

function counts(r: Review): Seg[] {
	const n: Partial<Record<Category, number>> = {};
	for (const f of r.findings) n[f.category] = (n[f.category] ?? 0) + 1;
	return (Object.keys(CAT) as Category[]).filter(c => n[c]).flatMap(c => [{ t: ` ${c} ${n[c]} `, s: bg(CAT[c].bg) + fg(231) + BOLD }, { t: " " }]);
}

function scopeTag(e: Entry): Seg {
	return { t: ` ${e.scope} `, s: e.scope === "work" ? bg(25) + fg(231) : bg(28) + fg(231) };
}

/** Non-reviewed states read the same in every variant, so they render once. */
function stateBlock(e: Entry, w: number): string[] | null {
	if (e.state === "pending")
		return [...wrap([{ t: pendingLabel(e), s: fg(220) + BOLD }], w, " "), "", ...wrap([{ t: e.text, s: DIM }], w, " ")];
	if (e.state === "failed")
		return [
			...wrap([{ t: " EN ? ", s: bg(160) + fg(231) + BOLD }, { t: "  Review failed: " }, { t: e.problem ?? "", s: DIM }], w, " "),
			...wrap([{ t: "The Prompt is kept; the next Review is unaffected.", s: DIM + ITAL }], w, " "),
			"",
			...wrap([{ t: e.text, s: DIM }], w, " "),
		];
	if (e.state === "skipped")
		return [...wrap([{ t: ` skipped: too long (${e.words} words) `, s: bg(238) + fg(250) }], w, " "), "", ...wrap([{ t: clip(e.text, 140), s: DIM }], w, " ")];
	return null;
}

// ── Variant A: Card — Prompt with marked spans, Rewrite diff, Findings table, Tip ─

function variantA(e: Entry, view: View, w: number): string[] {
	const head: Seg[] = [scopeTag(e), { t: `  ${hhmm(e.at)}  ` }, ...(e.review ? counts(e.review) : []), { t: "  " }, ...linkSegs(e, view, "open in Review log ↗")];
	const out = [...wrap(head, w, " "), " " + fg(240) + "─".repeat(w - 2) + RESET];
	const st = stateBlock(e, w);
	if (st) return [...out, ...st];
	const r = e.review!;
	if (!r.findings.length) return [...out, ...wrap([{ t: "✓ No Findings", s: fg(114) + BOLD }, { t: "  nothing to fix in this Prompt", s: DIM }], w, " "), "", ...wrap([{ t: e.text, s: DIM }], w, " ")];
	const label = (t: string) => " " + fg(245) + BOLD + t + RESET;
	const marked: Seg[] = [];
	let at = 0;
	for (const f of [...r.findings].sort((a, b) => a.start - b.start)) {
		if (f.start < at) continue;
		marked.push({ t: e.text.slice(at, f.start) }, { t: f.quote, s: fg(CAT[f.category].fg) + UL + BOLD });
		at = f.end;
	}
	marked.push({ t: e.text.slice(at) });
	const d = diff(e.text, r.rewrite ?? e.text, r.findings).map((p): Seg => ({ t: p.t, s: p.op === "-" ? DEL : p.op === "+" ? INS : undefined }));
	const qw = Math.min(28, Math.max(...r.findings.map(f => f.quote.length)) + 1);
	const rows = r.findings.map(f =>
		" " + fg(CAT[f.category].fg) + "● " + rpad(f.category, 9) + RESET + rpad(DEL + clip(f.quote, qw) + RESET, qw + 1) + fg(240) + "→ " + RESET + INS + f.fix + RESET,
	);
	return [
		...out,
		label("PROMPT"), ...wrap(marked, w, "   "), "",
		label("REWRITE"), ...wrap(d, w, "   "), "",
		label("FINDINGS"), ...rows, "",
		label("TIP"), ...wrap([{ t: r.tip ?? "", s: fg(230) + ITAL }], w, " " + fg(220) + "▌ " + RESET),
	];
}

// ── Variant B: Rewrite-first — one category-coloured diff, then the Tip ───────

function variantB(e: Entry, view: View, w: number): string[] {
	const out: string[] = [];
	const st = stateBlock(e, w);
	if (st) out.push(...st);
	else {
		const r = e.review!;
		if (!r.findings.length) out.push(...wrap([{ t: e.text }, { t: "  ✓", s: fg(114) + BOLD }], w, "  "));
		else {
			const d = diff(e.text, r.rewrite ?? e.text, r.findings).map((p): Seg => {
				if (p.op === "=") return { t: p.t };
				const c = p.cat ? CAT[p.cat] : undefined;
				return p.op === "-" ? { t: p.t, s: fg(c?.fg ?? 203) + DIM + STRIKE } : { t: p.t, s: bg(c?.bg ?? 22) + fg(231) + BOLD };
			});
			out.push(...wrap(d, w, "  "), "");
			out.push(...wrap([{ t: "💡 " }, { t: r.tip ?? "", s: fg(222) + BOLD }], w, "     ", "  "));
		}
	}
	const present = new Set(e.review?.findings.map(f => f.category));
	const legend: Seg[] = (Object.keys(CAT) as Category[]).filter(c => present.has(c)).flatMap(c => [{ t: "■", s: fg(CAT[c].fg) }, { t: ` ${c}  `, s: DIM }]);
	const foot: Seg[] = [{ t: `${e.scope} · ${hhmm(e.at)} · `, s: DIM }, ...(st ? [] : legend), ...linkSegs(e, view, "details ↗")];
	return ["", ...out, "", ...wrap(foot, w, "  ")];
}

// ── Variant C: Feed — one line per Prompt, newest at the bottom, selected one opened ─

function feedLine(e: Entry, sel: boolean, w: number): string {
	const mark = sel ? fg(220) + "▶ " + RESET : "  ";
	let status: string;
	if (e.state === "pending") status = fg(220) + pendingLabel(e).split(" ")[0] + " review" + RESET;
	else if (e.state === "failed") status = bg(160) + fg(231) + " EN ? " + RESET;
	else if (e.state === "skipped") status = fg(244) + "– skipped" + RESET;
	else if (!e.review!.findings.length) status = fg(114) + "✓ clean" + RESET;
	else status = e.review!.findings.map(f => fg(CAT[f.category].fg) + CAT[f.category].glyph).join("") + RESET;
	status = rpad(status, 10);
	const head = `${mark}${fg(244)}${hhmm(e.at)}${RESET} ${e.scope === "work" ? fg(75) + "W" : fg(77) + "P"}${RESET} ${status}`;
	const room = w - visible(head) - 1;
	return head + " " + (sel ? "" : DIM) + clip(e.text.replace(/\s+/g, " "), room) + RESET;
}

function variantC(e: Entry, view: View, w: number, list: Entry[], rows: number): string[] {
	const open: string[] = [];
	const st = stateBlock(e, w - 2);
	if (st) open.push(...st);
	else if (!e.review!.findings.length) open.push(...wrap([{ t: "✓ No Findings", s: fg(114) + BOLD }], w, "   "));
	else {
		const r = e.review!;
		for (const f of r.findings)
			open.push(
				...wrap(
					[{ t: CAT[f.category].glyph, s: bg(CAT[f.category].bg) + fg(231) + BOLD }, { t: " " }, { t: f.quote, s: DEL }, { t: " → " }, { t: f.fix, s: INS }, { t: "   " + f.why, s: DIM }],
					w, "     ", "   ",
				),
			);
		open.push("", ...wrap([{ t: "Say: ", s: fg(245) }, { t: r.rewrite ?? "", s: fg(114) }], w, "        ", "   "));
		open.push(...wrap([{ t: "Tip: ", s: fg(245) }, { t: r.tip ?? "", s: fg(222) + ITAL }], w, "        ", "   "));
	}
	open.push(...wrap(linkSegs(e, view, "open in Review log ↗"), w, "   "));
	const sel = list.indexOf(e);
	const budget = Math.max(3, rows - open.length - 2);
	const first = Math.max(0, Math.min(sel - budget + 1, list.length - budget));
	const lines = list.slice(first, sel + 1).map(x => feedLine(x, x === e, w));
	const after = list.slice(sel + 1).map(x => feedLine(x, false, w));
	return [...lines, " " + fg(238) + "┄".repeat(w - 2) + RESET, ...open, ...(after.length ? ["", ...after] : [])];
}

/** Last few Prompts before the shown one, dimmed, newest first: the trail D and E share. */
function trail(e: Entry, list: Entry[], w: number, n: number): string[] {
	const sel = list.indexOf(e);
	return list.slice(Math.max(0, sel - n), sel).reverse().map(x => DIM + feedLine(x, false, w).replace(/\x1b\[0m/g, RESET + DIM) + RESET);
}

function tipLine(r: Review, w: number): string[] {
	return wrap([{ t: r.tip ?? "", s: fg(230) + ITAL }], w, "   " + fg(220) + "▌ " + RESET);
}

// ── Variant D: Focus + trail — header, Rewrite diff, Tip; earlier Prompts dimmed below ─

function variantD(e: Entry, view: View, w: number, list: Entry[]): string[] {
	const head: Seg[] = [scopeTag(e), { t: `  ${hhmm(e.at)}   ` }, ...(e.state === "reviewed" && e.review ? counts(e.review) : [])];
	const link = linkSegs(e, view, "log ↗");
	const headLine = wrap(head, w, " ")[0];
	const linkLine = link.map(piece).join("");
	const out = [rpad(headLine, w - visible(linkLine)) + linkLine, ""];
	const st = stateBlock(e, w);
	if (st) out.push(...st.map(l => "  " + l));
	else if (!e.review!.findings.length) out.push(...wrap([{ t: "✓ ", s: fg(114) + BOLD }, { t: e.text }], w, "   "));
	else {
		const r = e.review!;
		const d = diff(e.text, r.rewrite ?? e.text, r.findings).map((p): Seg => ({ t: p.t, s: p.op === "-" ? DEL : p.op === "+" ? INS : undefined }));
		out.push(...wrap(d, w, "   "), "", ...tipLine(r, w));
	}
	const t = trail(e, list, w, 3);
	return t.length ? [...out, "", "", " " + fg(238) + "earlier " + "┄".repeat(w - 10) + RESET, ...t] : out;
}

// ── Variant E: Ladder — short trail on top, the Prompt line, then its Findings as rungs and the Tip; no Rewrite ─

function variantE(e: Entry, view: View, w: number, list: Entry[]): string[] {
	const out = [...trail(e, list, w, 3).reverse(), feedLine(e, true, w), ""];
	const st = stateBlock(e, w - 4);
	if (st) out.push(...st.map(l => "    " + l));
	else if (!e.review!.findings.length) out.push(...wrap([{ t: "✓ nothing to fix", s: fg(114) + BOLD }], w, "     "));
	else {
		const r = e.review!;
		const qw = Math.min(26, Math.max(...r.findings.map(f => f.quote.length)) + 2);
		for (const f of r.findings)
			out.push("     " + bg(CAT[f.category].bg) + fg(231) + BOLD + ` ${CAT[f.category].glyph} ` + RESET + "  " + rpad(DEL + clip(f.quote, qw) + RESET, qw) + fg(240) + "→ " + RESET + INS + f.fix + RESET);
		out.push("", ...tipLine(r, w).map(l => "  " + l));
	}
	const linkLine = linkSegs(e, view, "full Review ↗").map(piece).join("");
	return [...out, "", " ".repeat(Math.max(0, w - visible(linkLine))) + linkLine];
}

// ── app ──────────────────────────────────────────────────────────────────────

const VARIANTS = [
	{ key: "D", name: "Focus + trail", render: variantD },
	{ key: "E", name: "Ladder", render: variantE },
	{ key: "A", name: "Card", render: variantA },
	{ key: "B", name: "Rewrite-first", render: variantB },
	{ key: "C", name: "Feed", render: variantC },
] as const;

const args = process.argv.slice(2);
const realPath = args.includes("--real") ? args[args.indexOf("--real") + 1] : undefined;
const entries: Entry[] = realPath ? await realEntries(realPath) : fixtures();
writeStubs(entries);

let variant = 0;
let view: View = "all";
let selected: string | null = null; // null = follow the latest Prompt in view

const inView = () => entries.filter(e => view === "all" || e.scope === view).sort((a, b) => +a.at - +b.at);
const current = () => {
	const l = inView();
	return l.find(e => e.id === selected) ?? l.at(-1)!;
};

function frame(cols: number, rows: number): string {
	const w = Math.min(cols - 2, 100);
	const e = current();
	const list = inView();
	const tabs = (["all", "work", "personal"] as View[])
		.map(v => (v === view ? INV + BOLD + ` ${v} ` + RESET : DIM + ` ${v} ` + RESET))
		.join(" ");
	const behind = list.length - list.indexOf(e) - 1;
	const follow = behind === 0 ? fg(114) + "● following latest" + RESET : fg(220) + `◀ ${behind} newer` + RESET;
	const title = ` ${BOLD}prompt-tutor${RESET}  ${tabs}`;
	const top = rpad(title, w - visible(follow)) + follow;
	const v = VARIANTS[variant];
	const body = v.key === "C" ? variantC(e, view, w, list, rows - 5) : v.render(e, view, w, list, rows);
	const room = rows - 4;
	const shown = body.length > room ? [...body.slice(0, room - 1), DIM + `   … ${body.length - room + 1} more lines` + RESET] : body;
	const bar =
		INV +
		` ◀ ${v.key} ${v.name} ▶ │ ${e.state} · view ${view} · links ${osc8 ? "OSC 8" : "plain"} │ ←→ variant  j/k Prompt  s Scope  o links  space new  q quit ` +
		RESET;
	return [top, "", ...shown, ...Array(Math.max(0, room - shown.length)).fill(""), "", bar].join("\n");
}

if (args.includes("--dump")) {
	for (const [k, v] of VARIANTS.entries()) {
		variant = k;
		for (const e of entries) {
			selected = e.id;
			console.log(`\n=== variant ${v.key} ${v.name} · ${e.id} ${e.state} ===`);
			console.log(frame(90, 40));
		}
	}
	process.exit(0);
}

/** xterm-256 colour index → CSS hex. */
function xterm(n: number): string {
	const base = ["000000", "cd0000", "00cd00", "cdcd00", "0000ee", "cd00cd", "00cdcd", "e5e5e5", "7f7f7f", "ff0000", "00ff00", "ffff00", "5c5cff", "ff00ff", "00ffff", "ffffff"];
	if (n < 16) return `#${base[n]}`;
	if (n >= 232) return `#${(8 + 10 * (n - 232)).toString(16).padStart(2, "0").repeat(3)}`;
	const lv = [0, 95, 135, 175, 215, 255], i = n - 16;
	return `#${[Math.floor(i / 36), Math.floor(i / 6) % 6, i % 6].map(k => lv[k].toString(16).padStart(2, "0")).join("")}`;
}

/** Terminal frame → HTML spans, so the layouts can be looked at without running a TTY. */
function ansiToHtml(s: string): string {
	const esc = (t: string) => t.replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c] ?? c);
	let st: { b?: boolean; d?: boolean; i?: boolean; u?: boolean; x?: boolean; v?: boolean; fg?: number; bg?: number } = {};
	let href: string | null = null, out = "";
	for (const part of s.split(/(\x1b\[[0-9;]*m|\x1b\]8;;[^\x1b]*\x1b\\)/)) {
		const osc = part.match(/^\x1b\]8;;([^\x1b]*)\x1b\\$/);
		if (osc) { href = osc[1] || null; continue; }
		const sgr = part.match(/^\x1b\[([0-9;]*)m$/);
		if (sgr) {
			const c = sgr[1].split(";").map(Number);
			for (let k = 0; k < c.length; k++) {
				const v = c[k];
				if (v === 0) st = {};
				else if (v === 1) st.b = true; else if (v === 2) st.d = true; else if (v === 3) st.i = true;
				else if (v === 4) st.u = true; else if (v === 7) st.v = true; else if (v === 9) st.x = true;
				else if (v === 38 && c[k + 1] === 5) st.fg = c[(k += 2)];
				else if (v === 48 && c[k + 1] === 5) st.bg = c[(k += 2)];
			}
			continue;
		}
		if (!part) continue;
		let fgc = st.fg !== undefined ? xterm(st.fg) : "#d4d4d4", bgc = st.bg !== undefined ? xterm(st.bg) : "";
		if (st.v) [fgc, bgc] = [bgc || "#1b1d22", fgc];
		const css = [`color:${fgc}`, bgc && `background:${bgc}`, st.b && "font-weight:700", st.d && "opacity:.55", st.i && "font-style:italic",
			(st.u || st.x) && `text-decoration:${[st.u && "underline", st.x && "line-through"].filter(Boolean).join(" ")}`].filter(Boolean).join(";");
		const span = `<span style="${css}">${esc(part)}</span>`;
		out += href ? `<a href="${href}" target="_blank">${span}</a>` : span;
	}
	return out;
}

if (args.includes("--html")) {
	const outPath = args[args.indexOf("--html") + 1];
	const pending: Entry = { ...entries[2], id: `${entries[2].id}-p`, state: "pending", pendingSince: Date.now() - 3000, at: new Date(+entries.at(-1)!.at + 60_000) };
	entries.push(pending);
	writeStubs([pending]);
	const shot = (k: number, id: string) => {
		variant = k;
		selected = id;
		const lines = frame(78, 60).split("\n").slice(0, -1);
		while (lines.length && lines.at(-1)!.replace(/\x1b\[[0-9;]*m/g, "").trim() === "") lines.pop();
		return `<pre class="term">${lines.map(ansiToHtml).join("\n")}</pre>`;
	};
	const main = entries[5].id;
	const states: [string, string][] = [["No Findings", entries[1].id], ["Pending", pending.id], ["Failed", entries[3].id], ["Skipped, too long", entries[4].id], ["Another Prompt with Findings", entries[0].id]];
	const pitch: Record<string, string> = {
		D: "A's colours, one block: the Rewrite diff and the Tip, with the last three Prompts dimmed underneath. No Findings table, no repeated Prompt.",
		E: "C's history line, short: three earlier Prompts above, then this Prompt's Findings as quote → fix rungs and the Tip. No Rewrite (it is in the log).",
		A: "Round 1: everything — marked Prompt, Rewrite diff, Findings table, Tip.",
		C: "Round 1: full feed, Findings with why, plain Rewrite, Tip.",
	};
	const card = (key: string) => {
		const k = VARIANTS.findIndex(v => v.key === key), v = VARIANTS[k];
		return `<section class="card"><h2>${v.key} · ${v.name}</h2><p class="angle">${pitch[v.key]}</p>${shot(k, main)}
<details><summary>Other states in ${v.key}</summary>${states.map(([label, id]) => `<h3>${label}</h3>${shot(k, id)}`).join("")}</details>
<button onclick="navigator.clipboard.writeText('${v.key}');this.textContent='Copied ${v.key}: paste it back'">Pick ${v.key}</button></section>`;
	};
	const cards = ["D", "E"].map(card).join("");
	const earlier = ["A", "C"].map(card).join("");
	writeFileSync(outPath, `<!doctype html><meta charset="utf-8"><title>PROTOTYPE · Watcher layouts (issue #7)</title>
<style>
:root{--bg:#fff;--fg:#14171a;--mut:#5d6b7a;--line:#e3e8ef;--card:#f7f9fb;--accent:#c2410c}
@media (prefers-color-scheme:dark){:root{--bg:#0f1418;--fg:#eef2f6;--mut:#9aa8b6;--line:#243039;--card:#161d23;--accent:#fb923c}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);padding:32px;font:16px/1.5 ui-sans-serif,-apple-system,sans-serif}
h1{font-size:24px;margin:0 0 6px}p.lede{margin:0 0 24px;color:var(--mut);max-width:90ch}
.grid{display:grid;gap:20px;grid-template-columns:repeat(auto-fit,minmax(min(680px,100%),1fr))}
.card{min-width:0;border:1px solid var(--line);border-radius:12px;background:var(--card);padding:16px;display:flex;flex-direction:column;gap:10px}
h2{font-size:18px;margin:0}h3{font-size:14px;margin:14px 0 6px;color:var(--mut)}.angle{color:var(--mut);font-size:14px;margin:0}
pre.term{margin:0;background:#1b1d22;padding:12px 14px;border-radius:8px;font:12.5px/1.35 ui-monospace,Menlo,monospace;overflow-x:auto;white-space:pre}
pre.term a{text-decoration:none}summary{cursor:pointer;color:var(--mut);font-size:14px}
button{align-self:flex-start;font:inherit;font-size:14px;padding:8px 14px;border-radius:7px;cursor:pointer;border:1px solid var(--accent);background:transparent;color:var(--accent)}
button:hover{background:var(--accent);color:var(--bg)}
</style>
<h1>Watcher layouts, round 2: between A and C, less crowded</h1>
<p class="lede">D and E keep A's and C's colours and drop the parts that repeat each other. Both show the same Prompt with four Findings; open “Other states” for a clean Prompt, a pending Review, a failed Review, and a skipped Prompt. Round 1's A and C are at the bottom for comparison.</p>
<div class="grid">${cards}</div>
<details style="margin-top:28px"><summary>Round 1: A and C, for comparison</summary><div class="grid" style="margin-top:16px">${earlier}</div></details>`);
	process.exit(0);
}

if (!process.stdin.isTTY) {
	console.error("Needs a TTY; use --dump to print every layout.");
	process.exit(1);
}

const draw = () => process.stdout.write(`${ESC}H${ESC}2J` + frame(process.stdout.columns, process.stdout.rows));
process.stdout.write(`${ESC}?1049h${ESC}?25l`);
const quit = () => {
	process.stdout.write(`${ESC}?25h${ESC}?1049l`);
	process.exit(0);
};
process.stdin.setRawMode(true);
process.stdin.on("data", (b: Buffer) => {
	const k = b.toString();
	const list = inView();
	const idx = list.indexOf(current());
	if (k === "q" || k === "\x03") quit();
	else if (k === `${ESC}C`) variant = (variant + 1) % VARIANTS.length;
	else if (k === `${ESC}D`) variant = (variant + VARIANTS.length - 1) % VARIANTS.length;
	else if (k === "k" || k === `${ESC}A`) selected = list[Math.max(0, idx - 1)].id;
	else if (k === "j" || k === `${ESC}B`) selected = idx + 1 >= list.length - 1 ? null : list[idx + 1].id;
	else if (k === "s") (view = view === "all" ? "work" : view === "work" ? "personal" : "all"), (selected = null);
	else if (k === "o") osc8 = !osc8;
	else if (k === " ") {
		const src = entries.filter(x => x.state === "reviewed" && x.review?.findings.length)[Math.floor(Math.random() * 3)] ?? entries[0];
		const newest = Math.max(...entries.map(x => +x.at));
		const e: Entry = { ...src, id: `${src.id}-n${Date.now() % 10000}`, at: new Date(newest + 60_000), state: "pending", pendingSince: Date.now() };
		entries.push(e);
		writeStubs([e]);
		setTimeout(() => ((e.state = "reviewed"), writeStubs([e]), draw()), 3500);
	}
	draw();
});
process.stdout.on("resize", draw);
setInterval(() => current().state === "pending" && draw(), 100);
draw();
