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
		});
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
