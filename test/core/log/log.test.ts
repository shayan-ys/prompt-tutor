import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	rebuildMonth,
	stubUrl,
	writeStubs,
} from "../../../src/core/log/index.ts";
import { renderMonthPage } from "../../../src/core/log/render.ts";
import { writeRecord } from "../../../src/core/store.ts";
import type { Config, PromptRecord, Scope } from "../../../src/core/types.ts";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "prompt-tutor-log-"));
	temporaryDirectories.push(directory);
	return directory;
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

function scope(name: string, index: number, store: string): Scope {
	return { name, index, store, when: [], digestProfile: null };
}

function config(scopes: Scope[], allScopesLog: string): Config {
	return { scopes, allScopesLog, path: null };
}

function record(overrides: Partial<PromptRecord> = {}): PromptRecord {
	return {
		version: 1,
		id: "20261001T150000000-a1b2c3",
		scope: "personal",
		profile: "default",
		cwd: "/tmp",
		captured_at: "2026-10-01T15:00:00.000Z",
		utc_offset_minutes: -240,
		log_month: "2026-10",
		text: "Please review this prompt.",
		word_count: 4,
		state: "pending",
		...overrides,
	};
}

const reviewWithFindings = {
	findings: [
		{
			quote: "recieve",
			fix: "receive",
			category: "spelling" as const,
			why: "Use the standard spelling.",
			kind: "misspelled word",
			start: 2,
			end: 9,
		},
		{
			quote: "an",
			fix: "a",
			category: "grammar" as const,
			why: "Use the article before this consonant sound.",
			kind: "article choice",
			start: 10,
			end: 12,
		},
		{
			quote: "badly",
			fix: "well",
			category: "fluency" as const,
			why: "This adverb sounds more natural here.",
			kind: "unnatural word choice",
			start: 13,
			end: 18,
		},
	],
	rewrite: "I receive a apple well",
	tip: "Use a before consonant sounds, as in a book.",
};

const grader = {
	model: "advisor/model",
	requested_reasoning: "medium",
	prompt_hash: "abc12345",
	attempts: 2,
};

test("renders identical bytes when the same month's records arrive in a different listing order", () => {
	const work = scope("work", 1, "/work");
	const records = [
		record({
			id: "newer",
			captured_at: "2026-10-03T12:00:00.000Z",
			scope: "work",
		}),
		record({
			id: "older",
			captured_at: "2026-10-01T12:00:00.000Z",
			scope: "work",
		}),
	];
	const options = { month: "2026-10", scopes: [work], allScopes: false };
	expect(renderMonthPage({ ...options, records })).toBe(
		renderMonthPage({ ...options, records: [...records].reverse() }),
	);
});

test("writes the stub's meta refresh to the stable month anchor in both views", async () => {
	const root = await temporaryDirectory();
	const personal = scope("personal", 0, join(root, "personal"));
	const work = scope("work", 1, join(root, "work"));
	const settings = config([personal, work], join(root, "all", "log"));
	const prompt = record();
	await writeStubs(settings, personal, prompt);

	const scopeStub = await readFile(
		join(personal.store, "log", "r", `${prompt.id}.html`),
		"utf8",
	);
	const allStub = await readFile(
		join(settings.allScopesLog, "r", `${prompt.id}.html`),
		"utf8",
	);
	expect(scopeStub).toContain(
		'http-equiv="refresh" content="0; url=../2026-10.html#20261001T150000000-a1b2c3"',
	);
	expect(allStub).toContain(
		'http-equiv="refresh" content="0; url=../2026-10.html#20261001T150000000-a1b2c3"',
	);
});

test("returns percent-encoded file URLs for Scope and all-Scopes stubs", async () => {
	const root = await temporaryDirectory();
	const personal = scope("personal", 0, join(root, "personal notes #1"));
	const work = scope("work", 1, join(root, "work"));
	const settings = config([personal, work], join(root, "all scopes #log"));

	expect(stubUrl(settings, personal, "prompt-id")).toContain(
		"personal%20notes%20%231/log/r/prompt-id.html",
	);
	expect(stubUrl(settings, null, "prompt-id")).toContain(
		"all%20scopes%20%23log/r/prompt-id.html",
	);
});

test("does not create all-Scopes pages or stubs for a one-Scope config", async () => {
	const root = await temporaryDirectory();
	const personal = scope("personal", 0, join(root, "personal"));
	const settings = config([personal], join(root, "all", "log"));
	const prompt = record();
	await writeRecord(personal.store, prompt);
	await writeStubs(settings, personal, prompt);
	await rebuildMonth(settings, personal, prompt.log_month);

	await expect(
		readFile(join(settings.allScopesLog, "2026-10.html"), "utf8"),
	).rejects.toThrow();
	await expect(
		readFile(join(settings.allScopesLog, "r", `${prompt.id}.html`), "utf8"),
	).rejects.toThrow();
	expect(
		await readFile(join(personal.store, "log", "2026-10.html"), "utf8"),
	).toContain(prompt.id);
});

test("interleaves Scope records newest-first and renders the CSS-only Scope filter", async () => {
	const root = await temporaryDirectory();
	const personal = scope("personal", 0, join(root, "personal"));
	const work = scope("work", 1, join(root, "work"));
	const settings = config([personal, work], join(root, "all", "log"));
	await writeRecord(
		personal.store,
		record({
			id: "personal-old",
			scope: "personal",
			captured_at: "2026-10-01T12:00:00.000Z",
		}),
	);
	await writeRecord(
		work.store,
		record({
			id: "work-new",
			scope: "work",
			captured_at: "2026-10-02T12:00:00.000Z",
		}),
	);

	await rebuildMonth(settings, personal, "2026-10");
	const html = await readFile(
		join(settings.allScopesLog, "2026-10.html"),
		"utf8",
	);

	expect(html.indexOf('id="work-new"')).toBeLessThan(
		html.indexOf('id="personal-old"'),
	);
	expect(html).toContain(
		'class="scope-badge" style="--scope-color:#fdba74">work</span>',
	);
	expect(html).toContain('id="scope-filter-0" type="radio"');
	expect(html).toContain('id="scope-filter-1" type="radio"');
	expect(html).toContain(
		'body:has(#scope-filter-0:checked) .entry:not([data-scope-index="0"]) { display:none; }',
	);
	expect(html).not.toContain("<script");
});

test("renders replaced words deletion-first with spacing and preserves unchanged spacing", () => {
	const personal = scope("personal", 0, "/personal");
	const text = "Keep  the old  words";
	const html = renderMonthPage({
		month: "2026-10",
		records: [
			record({
				text,
				state: "reviewed",
				review: {
					findings: [
						{
							quote: "old",
							fix: "new",
							category: "fluency",
							why: "Word choice.",
							kind: "word choice",
							start: 10,
							end: 13,
						},
					],
					rewrite: "Keep  the new  words",
					tip: null,
				},
				grader,
			}),
		],
		scopes: [personal],
		allScopes: false,
	});

	expect(html).toContain(
		'<pre class="rewrite">Keep  the <del>old</del> <ins>new</ins>  words</pre>',
	);
});

test("renders pending, clean, skipped, failed, and detailed reviewed states", () => {
	const personal = scope("personal", 0, "/personal");
	const details = record({
		id: "detailed",
		text: "I recieve an badly",
		word_count: 4,
		state: "reviewed",
		review: reviewWithFindings,
		grader,
	});
	const records = [
		record({ id: "pending", state: "pending" }),
		record({
			id: "clean",
			state: "reviewed",
			review: { findings: [], rewrite: null, tip: null },
			grader: { ...grader, attempts: 1 },
		}),
		record({
			id: "too-long",
			state: "skipped",
			skip_reason: "too_long",
			word_count: 601,
		}),
		record({
			id: "nothing",
			state: "skipped",
			skip_reason: "nothing_to_review",
		}),
		record({
			id: "failed",
			state: "failed",
			failure: "The grader returned invalid output.",
		}),
		details,
	];
	const html = renderMonthPage({
		month: "2026-10",
		records,
		scopes: [personal],
		allScopes: false,
	});

	expect(html).toContain("reviewing…");
	expect(html).toContain("No Findings");
	expect(html).toContain("skipped: too long (601 words)");
	expect(html).toContain("skipped: nothing to review");
	expect(html).toContain("EN ?");
	expect(html).toContain("The grader returned invalid output.");
	expect(html).toContain("UTC−04:00");
	expect(html).toContain('class="spelling"');
	expect(html).toContain('class="grammar"');
	expect(html).toContain('class="fluency"');
	expect(html).toContain("misspelled word");
	expect(html).toContain(
		"graded by advisor/model · medium · prompt abc12345 · 2 attempts",
	);
	expect(html).toContain("<del>");
	expect(html).toContain("<ins>");
	expect(html).toContain("Use a before consonant sounds, as in a book.");
	expect(html).toContain('<details class="folded-prompt">');
});
