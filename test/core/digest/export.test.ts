import { afterEach, describe, expect, test } from "bun:test";
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseConfig } from "../../../src/core/config.ts";
import { exportDigests } from "../../../src/core/digest/index.ts";
import type { DigestArchive } from "../../../src/core/digest/types.ts";
import type { Config, Scope } from "../../../src/core/types.ts";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(
		roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
	);
});

function archive(
	scope: string,
	week: string,
	from: string,
	reviewed: number,
	quote = "a overview",
): DigestArchive {
	return {
		version: 1,
		week,
		scope,
		from,
		stats: {
			prompts: reviewed,
			reviewed,
			clean: Math.floor(reviewed / 2),
			cleanPercent: 50,
			categories: { spelling: 0, grammar: reviewed, fluency: 0 },
			notReviewed: { tooLong: 0, nothingToReview: 0, failed: 0, pending: 0 },
		},
		graderVersions: [],
		lesson: reviewed ? "Use an before a vowel sound." : null,
		focus: reviewed ? "Check each article." : null,
		patterns: reviewed
			? [
					{
						id: "articles",
						name: "Articles",
						rule: "Use an before a vowel sound.",
						categories: ["grammar"],
						count: 2,
						findingIds: ["p:1", "p:2"],
						examples: [
							{
								id: "p:1",
								promptId: "p",
								capturedAt: `${week}T10:00:00.000Z`,
								sentence: quote,
								category: "grammar",
								kind: "article",
								quote,
								fix: "an overview",
								why: "Vowel sound.",
							},
						],
						recurring: true,
						previousCount: null,
						trend: [{ week, count: 2 }],
					},
				]
			: [],
		oneOffs: [],
	};
}

async function setup(scopeNames = ["work", "personal"]): Promise<{
	root: string;
	config: Config;
	scopes: Scope[];
}> {
	const root = await mkdtemp(path.join(os.tmpdir(), "prompt-tutor-export-"));
	roots.push(root);
	const scopes = scopeNames.map(
		(name, index): Scope => ({
			name,
			index,
			store: path.join(root, "stores", name),
			when: [],
			digestProfile: null,
			reviewProfile: null,
		}),
	);
	return {
		root,
		scopes,
		config: {
			scopes,
			allScopesLog: path.join(root, "all", "log"),
			keepMonths: null,
			explanationLanguage: "English",
			digestExport: path.join(root, "export"),
			digestExportScopes: null,
			combinedDigest: null,
			path: null,
		},
	};
}

async function store(scope: Scope, digest: DigestArchive): Promise<void> {
	const directory = path.join(scope.store, "digests");
	await mkdir(directory, { recursive: true });
	await writeFile(
		path.join(directory, `${digest.week}.json`),
		`${JSON.stringify(digest, null, 2)}\n`,
	);
	if (digest.stats.reviewed > 0)
		await writeFile(path.join(directory, `${digest.week}.html`), "<old/>");
}

describe("exportDigests", () => {
	test("writes a note and page per reviewed week, links weeks, and indexes them in order", async () => {
		const { config, scopes } = await setup();
		const [work, personal] = scopes as [Scope, Scope];
		await store(work, archive("work", "2026-10-09", "2026-10-02", 0));
		await store(work, archive("work", "2026-10-16", "2026-10-09", 4));
		await store(work, archive("work", "2026-10-23", "2026-10-16", 6));
		await store(personal, archive("personal", "2026-10-16", "2026-10-09", 2));
		const root = config.digestExport as string;

		await exportDigests(config);

		expect(
			(await readdir(path.join(root, "work", "digests"))).toSorted(),
		).toEqual(["2026-10-16.html", "2026-10-23.html"]);
		const latest = await readFile(
			path.join(root, "Prompt Tutor Digest 2026-10-23 (work).md"),
			"utf8",
		);
		expect(latest).toContain("[[Prompt Tutor Digest 2026-10-16 (work)]]");
		expect(latest).toContain("(work/digests/2026-10-23.html)");
		expect(
			await readFile(
				path.join(root, "work", "digests", "2026-10-23.html"),
				"utf8",
			),
		).toContain("Articles");
		expect(
			await readFile(path.join(root, "work", "digest.html"), "utf8"),
		).toContain('<base href="digests/">');
		const index = await readFile(path.join(root, "_index.md"), "utf8");
		const listed = [...index.matchAll(/\[\[([^\]]+)\]\]/gu)].map((m) => m[1]);
		expect(listed).toEqual([
			"Prompt Tutor Digest 2026-10-16 (personal)",
			"Prompt Tutor Digest 2026-10-16 (work)",
			"Prompt Tutor Digest 2026-10-23 (work)",
		]);
		expect(index).toContain("Last updated: 2026-10-23");
	});

	test("a second export with unchanged Digests writes nothing", async () => {
		const { config, scopes } = await setup(["work"]);
		await store(
			scopes[0] as Scope,
			archive("work", "2026-10-16", "2026-10-09", 4),
		);
		expect((await exportDigests(config)).length).toBeGreaterThan(0);
		expect(await exportDigests(config)).toEqual([]);
	});

	test("Prompt text cannot add links, comments, math, or HTML to a note", async () => {
		const { config, scopes } = await setup(["work"]);
		await store(
			scopes[0] as Scope,
			archive(
				"work",
				"2026-10-16",
				"2026-10-09",
				4,
				"see [[Secret]] %%x%% <script> $5 | ok",
			),
		);
		await exportDigests(config);
		const note = await readFile(
			path.join(
				config.digestExport as string,
				"Prompt Tutor Digest 2026-10-16 (work).md",
			),
			"utf8",
		);
		const body = note.slice(note.indexOf("## Recurring Patterns"));
		expect(body).not.toContain("[[Secret]]");
		expect(body).not.toContain("%%x%%");
		expect(body).not.toContain("<script>");
		expect(body).not.toMatch(/(?<!\\)\$5/u);
		expect(body).toContain("\\[\\[Secret\\]\\]");
	});

	test("refuses a Scope name that would escape the export directory", async () => {
		const { config, scopes } = await setup(["../outside"]);
		await store(
			scopes[0] as Scope,
			archive("x", "2026-10-16", "2026-10-09", 4),
		);
		await expect(exportDigests(config)).rejects.toThrow(
			"export directory name",
		);
	});

	test("with combined_digest exports the combined notes and each scope_digests Scope's, not the others", async () => {
		const { root, config, scopes } = await setup();
		const [work, personal] = scopes as [Scope, Scope];
		const all = path.join(root, "stores", "all");
		const combined: Config = {
			...config,
			combinedDigest: {
				profile: "personal",
				store: all,
				scopeDigests: ["personal"],
			},
		};
		await store(
			work,
			archive("work", "2026-11-06", "2026-10-30", 4, "work secret"),
		);
		await store(personal, archive("personal", "2026-11-06", "2026-10-30", 2));
		await store(
			{ ...personal, name: "all", store: all },
			archive("all", "2026-11-06", "2026-10-30", 6),
		);
		const exportRoot = config.digestExport as string;

		await exportDigests(combined);

		const files = await readdir(exportRoot);
		expect(files.filter((file) => file.endsWith(".md")).toSorted()).toEqual([
			"Prompt Tutor Digest 2026-11-06 (all).md",
			"Prompt Tutor Digest 2026-11-06 (personal).md",
			"_index.md",
		]);
		expect(files).not.toContain("work");
		const personalNote = await readFile(
			path.join(exportRoot, "Prompt Tutor Digest 2026-11-06 (personal).md"),
			"utf8",
		);
		expect(personalNote).not.toContain("work secret");
		expect(personalNote).not.toContain("(work)");
		expect(
			await readFile(path.join(exportRoot, "personal", "digest.html"), "utf8"),
		).toContain('<base href="digests/">');
	});

	test("the rebuilt index keeps rows of other notes still in the directory", async () => {
		const { config, scopes } = await setup(["personal"]);
		await store(
			scopes[0] as Scope,
			archive("personal", "2026-10-16", "2026-10-09", 2),
		);
		const exportRoot = config.digestExport as string;
		await mkdir(exportRoot, { recursive: true });
		const handRow =
			"| [[Prompt Tutor Unified Lessons 2026-10-02 to 2026-10-30]] | note | seed | Written by hand. |";
		const oldRow =
			"| [[Prompt Tutor Digest 2026-10-16 (work)]] | note | seed | An earlier export. |";
		await writeFile(
			path.join(exportRoot, "_index.md"),
			[
				"| Note | Type | Status | Summary |",
				"|------|------|--------|---------|",
				handRow,
				oldRow,
				"| [[Prompt Tutor Digest 2026-10-09 (work)]] | note | seed | Deleted note. |",
				"| [[Prompt Tutor Digest 2026-10-16 (personal)]] | note | seed | Stale summary. |",
				"",
			].join("\n"),
		);
		for (const name of [
			"Prompt Tutor Unified Lessons 2026-10-02 to 2026-10-30",
			"Prompt Tutor Digest 2026-10-16 (work)",
		])
			await writeFile(path.join(exportRoot, `${name}.md`), "kept\n");

		await exportDigests(config);

		const index = await readFile(path.join(exportRoot, "_index.md"), "utf8");
		const rows = index.split("\n").filter((line) => line.startsWith("| [["));
		expect(rows).toHaveLength(3);
		expect(rows[0]).toStartWith(
			"| [[Prompt Tutor Digest 2026-10-16 (personal)]]",
		);
		expect(rows[0]).not.toContain("Stale summary");
		expect(rows.slice(1)).toEqual([oldRow, handRow]);
	});

	test("digest_export_scopes exports only the listed Digests and keeps index rows of notes already there", async () => {
		const { root, config, scopes } = await setup();
		const [work, personal] = scopes as [Scope, Scope];
		const all = path.join(root, "stores", "all");
		const limited: Config = {
			...config,
			digestExportScopes: ["personal"],
			combinedDigest: {
				profile: "personal",
				store: all,
				scopeDigests: ["work", "personal"],
			},
		};
		await store(
			work,
			archive("work", "2026-11-06", "2026-10-30", 4, "work secret"),
		);
		await store(personal, archive("personal", "2026-11-06", "2026-10-30", 2));
		await store(
			{ ...personal, name: "all", store: all },
			archive("all", "2026-11-06", "2026-10-30", 6, "work secret"),
		);
		const exportRoot = config.digestExport as string;
		await mkdir(exportRoot, { recursive: true });
		const oldRow =
			"| [[Prompt Tutor Digest 2026-10-23 (work)]] | note | seed | An earlier export. |";
		await writeFile(path.join(exportRoot, "_index.md"), `${oldRow}\n`);
		await writeFile(
			path.join(exportRoot, "Prompt Tutor Digest 2026-10-23 (work).md"),
			"kept\n",
		);

		const written = await exportDigests(limited);

		expect(written.join("\n")).not.toContain("work secret");
		expect(
			written.filter((file) =>
				/\((all|work)\)|[/\\](all|work)[/\\]/u.test(file),
			),
		).toEqual([]);
		const files = await readdir(exportRoot);
		expect(files.toSorted()).toEqual([
			"Prompt Tutor Digest 2026-10-23 (work).md",
			"Prompt Tutor Digest 2026-11-06 (personal).md",
			"_index.md",
			"personal",
		]);
		const index = await readFile(path.join(exportRoot, "_index.md"), "utf8");
		const listed = [...index.matchAll(/\[\[([^\]]+)\]\]/gu)].map((m) => m[1]);
		expect(listed).toEqual([
			"Prompt Tutor Digest 2026-10-23 (work)",
			"Prompt Tutor Digest 2026-11-06 (personal)",
		]);
		expect(index).not.toContain("work secret");
	});
});

describe("digest_export config", () => {
	test("expands the path and rejects one inside a Scope store", () => {
		const env = { ...process.env, HOME: "/home/u", XDG_DATA_HOME: "/data" };
		const valid = parseConfig(
			"digest_export: ~/vault/Digests\nscopes:\n  - name: work\n",
			"/cfg/config.yml",
			env,
		);
		expect(valid.ok && valid.config.digestExport).toBe("/home/u/vault/Digests");
		const inside = parseConfig(
			"digest_export: /data/prompt-tutor/work/export\nscopes:\n  - name: work\n",
			"/cfg/config.yml",
			env,
		);
		expect(inside.ok).toBe(false);
	});

	test("digest_export_scopes names configured Scopes, or all with combined_digest", () => {
		const env = { ...process.env, HOME: "/home/u", XDG_DATA_HOME: "/data" };
		const parse = (yaml: string) =>
			parseConfig(
				`scopes:\n  - name: work\n  - name: personal\n${yaml}`,
				"/cfg/config.yml",
				env,
			);
		const absent = parse("");
		expect(absent.ok && absent.config.digestExportScopes).toBeNull();
		const personal = parse("digest_export_scopes: [personal]\n");
		expect(personal.ok && personal.config.digestExportScopes).toEqual([
			"personal",
		]);
		const combined = parse(
			"combined_digest:\n  profile: personal\ndigest_export_scopes: [all, personal]\n",
		);
		expect(combined.ok && combined.config.digestExportScopes).toEqual([
			"all",
			"personal",
		]);
		for (const yaml of [
			"digest_export_scopes: []\n",
			"digest_export_scopes: personal\n",
			"digest_export_scopes: [home]\n",
			"digest_export_scopes: [all]\n",
			"digest_export_scopes: [personal, personal]\n",
		])
			expect(parse(yaml).ok).toBe(false);
	});
});

describe("combined_digest config", () => {
	const env = { ...process.env, HOME: "/home/u", XDG_DATA_HOME: "/data" };
	const parse = (yaml: string) =>
		parseConfig(
			`scopes:\n  - name: work\n  - name: personal\n${yaml}`,
			"/cfg/config.yml",
			env,
		);

	test("defaults the store beside the all-Scopes log", () => {
		const parsed = parse("combined_digest:\n  profile: personal\n");
		expect(parsed.ok && parsed.config.combinedDigest).toEqual({
			profile: "personal",
			store: "/data/prompt-tutor/all",
			scopeDigests: [],
		});
	});

	test("scope_digests lists configured Scopes, kept in config order", () => {
		const parsed = parse(
			"combined_digest:\n  profile: personal\n  scope_digests: [personal, work]\n",
		);
		expect(parsed.ok && parsed.config.combinedDigest?.scopeDigests).toEqual([
			"work",
			"personal",
		]);
		for (const yaml of [
			"combined_digest:\n  profile: personal\n  scope_digests: personal\n",
			"combined_digest:\n  profile: personal\n  scope_digests: [home]\n",
			"combined_digest:\n  profile: personal\n  scope_digests: [work, work]\n",
			"combined_digest:\n  profile: personal\n  scope_digests: [1]\n",
		])
			expect(parse(yaml).ok).toBe(false);
	});

	test("rejects a missing profile, an unknown key, and a store overlapping a Scope", () => {
		for (const yaml of [
			"combined_digest:\n  store: /data/x\n",
			"combined_digest:\n  profile: personal\n  scope: work\n",
			"combined_digest:\n  profile: personal\n  store: /data/prompt-tutor/work/all\n",
			"combined_digest:\n  profile: personal\n  store: /data\n",
		])
			expect(parse(yaml).ok).toBe(false);
	});
});
