import { afterEach, describe, expect, test } from "bun:test";
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	utimes,
	writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { dueDigests, runDigest } from "../../../src/core/digest/index.ts";
import type {
	Config,
	Grader,
	GraderRequest,
	PromptRecord,
	Scope,
} from "../../../src/core/types.ts";

const roots: string[] = [];
const endingFriday = new Date(2026, 9, 2, 12, 0, 0, 0);

interface Fixture {
	root: string;
	store: string;
	configHome: string;
	env: NodeJS.ProcessEnv;
}

interface ConfigScope {
	name: string;
	store: string;
	when: string[];
	digestProfile?: string;
}

async function fixture(): Promise<Fixture> {
	const root = await mkdtemp(path.join(os.tmpdir(), "prompt-tutor-digest-"));
	roots.push(root);
	return {
		root,
		store: path.join(root, "store"),
		configHome: path.join(root, "config"),
		env: {
			...process.env,
			XDG_CONFIG_HOME: path.join(root, "config"),
			XDG_DATA_HOME: path.join(root, "data"),
		},
	};
}

async function writeConfig(
	target: Fixture,
	scopes: ConfigScope[],
): Promise<void> {
	const configDirectory = path.join(target.configHome, "prompt-tutor");
	await mkdir(configDirectory, { recursive: true });
	const lines = ["scopes:"];
	for (const scope of scopes) {
		lines.push(`  - name: ${JSON.stringify(scope.name)}`);
		lines.push(`    store: ${JSON.stringify(scope.store)}`);
		if (scope.when.length > 0) {
			lines.push("    when:");
			for (const condition of scope.when) lines.push(`      - ${condition}`);
		}
		if (scope.digestProfile !== undefined)
			lines.push(`    digest_profile: ${JSON.stringify(scope.digestProfile)}`);
	}
	await writeFile(
		path.join(configDirectory, "config.yml"),
		`${lines.join("\n")}\n`,
	);
}

function scopeFor(
	store: string,
	name = "test",
	digestProfile: string | null = "test",
): Scope {
	return { name, index: 0, store, when: [], digestProfile };
}

function configFor(scope: Scope, root: string): Config {
	return {
		scopes: [scope],
		allScopesLog: path.join(root, "all", "log"),
		path: null,
	};
}

function makeRecord(
	storeScope: Scope,
	id: string,
	capturedAt: Date,
	text: string,
	state: PromptRecord["state"] = "reviewed",
): PromptRecord {
	const review =
		state === "reviewed"
			? {
					findings: [
						{
							quote: "are",
							fix: "is",
							category: "grammar" as const,
							why: "The singular subject takes a singular verb.",
							kind: "subject verb agreement",
							start: text.indexOf("are"),
							end: text.indexOf("are") + "are".length,
						},
					],
					rewrite: "This is wrong.",
					tip: "Match the verb to the subject.",
				}
			: undefined;
	return {
		version: 1,
		id,
		scope: storeScope.name,
		profile: "test",
		cwd: "/tmp",
		captured_at: capturedAt.toISOString(),
		utc_offset_minutes: -capturedAt.getTimezoneOffset(),
		log_month: `${capturedAt.getFullYear()}-${String(capturedAt.getMonth() + 1).padStart(2, "0")}`,
		text,
		word_count: text.trim().split(/\s+/u).length,
		state,
		...(state === "skipped"
			? { skip_reason: "nothing_to_review" as const }
			: {}),
		...(review ? { review } : {}),
		...(state === "reviewed"
			? {
					grader: {
						model: "test/advisor",
						requested_reasoning: "medium",
						prompt_hash: "a1b2c3d4",
						attempts: 1,
					},
				}
			: {}),
		...(state === "failed" ? { failure: "test failure" } : {}),
	};
}

async function putRecords(
	store: string,
	records: PromptRecord[],
): Promise<void> {
	for (const record of records) {
		const monthDirectory = path.join(store, "prompts", record.log_month);
		await mkdir(monthDirectory, { recursive: true });
		await writeFile(
			path.join(monthDirectory, `${record.id}.json`),
			`${JSON.stringify(record)}\n`,
		);
	}
}

function response(
	patterns: { id: string; name: string; rule: string; findingIds: string[] }[],
) {
	return {
		patterns,
		lesson: "Use a singular verb with a singular subject.",
		focus: "Check each subject and verb before sending the Prompt.",
	};
}

function fakeGrader(outputs: unknown[]): {
	grader: Grader;
	requests: GraderRequest[];
} {
	const requests: GraderRequest[] = [];
	let index = 0;
	return {
		requests,
		grader: {
			async call(request) {
				requests.push(request);
				const output = outputs[Math.min(index, outputs.length - 1)];
				index += 1;
				return {
					toolArgs: output,
					model: "test/advisor",
					requestedReasoning: "medium",
				};
			},
		},
	};
}

async function expectNoDigestFiles(store: string): Promise<void> {
	const digestDirectory = path.join(store, "digests");
	const files = await readdir(digestDirectory).catch(() => []);
	expect(files.filter((file) => file !== ".lock")).toEqual([]);
	await expect(
		readFile(path.join(store, "digest.html"), "utf8"),
	).rejects.toThrow();
}

afterEach(async () => {
	await Promise.all(
		roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
	);
});

describe("dueDigests", () => {
	test("ends weeks at Friday noon in the session timezone", async () => {
		const moduleUrl = new URL(
			"../../../src/core/digest/index.ts",
			import.meta.url,
		).href;
		const cases = [
			{
				timezone: "America/Toronto",
				instant: "2026-10-02T15:59:00.000Z",
				week: "2026-09-25",
			},
			{
				timezone: "America/Toronto",
				instant: "2026-10-02T16:00:00.000Z",
				week: "2026-10-02",
			},
			{
				timezone: "Asia/Tokyo",
				instant: "2026-10-02T02:59:00.000Z",
				week: "2026-09-25",
			},
			{
				timezone: "Asia/Tokyo",
				instant: "2026-10-02T03:00:00.000Z",
				week: "2026-10-02",
			},
		];
		for (const item of cases) {
			const target = await fixture();
			await writeConfig(target, [
				{
					name: "scope",
					store: target.store,
					when: ["profile: test"],
					digestProfile: "test",
				},
			]);
			const digestDirectory = path.join(target.store, "digests");
			await mkdir(digestDirectory, { recursive: true });
			await writeFile(path.join(digestDirectory, `${item.week}.json`), "{}\n");
			const script = `import { dueDigests } from ${JSON.stringify(moduleUrl)};\nconst env = JSON.parse(process.env.PROMPT_TUTOR_ENV);\nconst due = await dueDigests({ profile: "test", cwd: process.cwd(), now: new Date(process.env.PROMPT_TUTOR_NOW) }, { env });\nconsole.log(JSON.stringify(due.map(({ name }) => name)));`;
			const child = Bun.spawnSync([process.execPath, "-e", script], {
				env: {
					...process.env,
					TZ: item.timezone,
					PROMPT_TUTOR_ENV: JSON.stringify(target.env),
					PROMPT_TUTOR_NOW: item.instant,
				},
				stdout: "pipe",
				stderr: "pipe",
			});
			expect(child.exitCode).toBe(0);
			expect(child.stderr.toString()).toBe("");
			expect(child.stdout.toString().trim()).toBe("[]");
		}
	});

	test("honours digest_profile and resolves null-profile Scopes", async () => {
		const target = await fixture();
		const explicitStore = path.join(target.root, "explicit");
		const localStore = path.join(target.root, "local");
		const personalDirectory = path.join(target.root, "personal");
		const outsideDirectory = path.join(target.root, "outside");
		await mkdir(personalDirectory, { recursive: true });
		await mkdir(outsideDirectory, { recursive: true });
		await writeConfig(target, [
			{
				name: "explicit",
				store: explicitStore,
				when: ["profile: source"],
				digestProfile: "digest",
			},
			{
				name: "local",
				store: localStore,
				when: [`cwd: ${JSON.stringify(path.join(personalDirectory, "**"))}`],
			},
		]);
		const now = new Date(endingFriday.getTime());
		const exactProfile = await dueDigests(
			{ profile: "digest", cwd: outsideDirectory, now },
			{ env: target.env },
		);
		expect(exactProfile.map(({ name }) => name)).toEqual(["explicit"]);
		const resolvedScope = await dueDigests(
			{ profile: "other", cwd: personalDirectory, now },
			{ env: target.env },
		);
		expect(resolvedScope.map(({ name }) => name)).toEqual(["local"]);
		const wrongProfileAndScope = await dueDigests(
			{ profile: "other", cwd: outsideDirectory, now },
			{ env: target.env },
		);
		expect(wrongProfileAndScope).toEqual([]);
	});
});

describe("runDigest", () => {
	test("takes over a lock older than ten minutes", async () => {
		const target = await fixture();
		const scope = scopeFor(target.store);
		const digestDirectory = path.join(target.store, "digests");
		await mkdir(digestDirectory, { recursive: true });
		const lock = path.join(digestDirectory, ".lock");
		await writeFile(lock, "another process");
		const staleTime = new Date(Date.now() - 11 * 60 * 1000);
		await utimes(lock, staleTime, staleTime);
		const fake = fakeGrader([]);
		const result = await runDigest(
			scope,
			configFor(scope, target.root),
			fake.grader,
			new Date(endingFriday.getTime()),
		);
		expect(result).toEqual({ kind: "empty", week: "2026-10-02" });
		expect(
			await readFile(path.join(digestDirectory, "2026-10-02.json"), "utf8"),
		).toContain('"week": "2026-10-02"');
		expect(await readdir(digestDirectory)).toEqual(["2026-10-02.json"]);
		expect(fake.requests).toHaveLength(0);
	});

	test("uses the preceding week's Pattern id to rank a one-Finding recurrence", async () => {
		const target = await fixture();
		const scope = scopeFor(target.store);
		const start = new Date(
			endingFriday.getFullYear(),
			endingFriday.getMonth(),
			endingFriday.getDate() - 7,
			12,
		);
		const currentPrompt = new Date(start.getTime() + 60 * 60 * 1000);
		const text = "This are wrong.";
		await putRecords(target.store, [
			makeRecord(scope, "prompt-1", currentPrompt, text),
		]);
		const digestDirectory = path.join(target.store, "digests");
		await mkdir(digestDirectory, { recursive: true });
		const lastWeek = {
			version: 1,
			week: "2026-09-25",
			scope: scope.name,
			from: "2026-09-18",
			stats: {
				prompts: 2,
				reviewed: 2,
				clean: 1,
				cleanPercent: 50,
				categories: { spelling: 0, grammar: 2, fluency: 0 },
				notReviewed: { tooLong: 0, nothingToReview: 0, failed: 0, pending: 0 },
			},
			graderVersions: [],
			lesson: "Last week's lesson.",
			focus: "Last week's focus.",
			patterns: [
				{
					id: "subject-agreement",
					name: "Subject–verb agreement",
					rule: "The verb agrees with its subject.",
					categories: ["grammar"],
					count: 2,
					findingIds: ["older:1", "older:2"],
					examples: [],
					recurring: true,
					previousCount: 1,
					trend: [],
				},
			],
			oneOffs: [],
		};
		await writeFile(
			path.join(digestDirectory, "2026-09-25.json"),
			`${JSON.stringify(lastWeek)}\n`,
		);
		await writeFile(
			path.join(digestDirectory, "2026-09-25.html"),
			"<html></html>",
		);
		const fake = fakeGrader([
			response([
				{
					id: "subject-agreement",
					name: "Subject–verb agreement",
					rule: "A singular subject takes a singular verb.",
					findingIds: ["prompt-1:1"],
				},
			]),
		]);
		const result = await runDigest(
			scope,
			configFor(scope, target.root),
			fake.grader,
			new Date(endingFriday.getTime()),
		);
		expect(result.kind).toBe("written");
		expect(fake.requests).toHaveLength(1);
		const request = JSON.parse(fake.requests[0].user);
		expect(request.findings).toEqual([
			{
				id: "prompt-1:1",
				sentence: "This are wrong.",
				category: "grammar",
				kind: "subject verb agreement",
				quote: "are",
				fix: "is",
				why: "The singular subject takes a singular verb.",
			},
		]);
		const digest = JSON.parse(
			await readFile(path.join(digestDirectory, "2026-10-02.json"), "utf8"),
		);
		expect(digest.patterns[0]).toMatchObject({
			id: "subject-agreement",
			count: 1,
			recurring: true,
			previousCount: 2,
		});
		expect(digest.patterns[0].examples).toHaveLength(1);
		const html = await readFile(path.join(target.store, "digest.html"), "utf8");
		expect(html).toContain('<base href="digests/">');
		expect(html).toContain("Recurring Patterns");
		expect(html).toContain("Grader changed this week:");
		expect(html).toContain("Last Digest counts");
	});

	for (const invalidCase of [
		{
			name: "unknown Finding ids",
			invalid: response([
				{
					id: "pattern",
					name: "Rule",
					rule: "A rule.",
					findingIds: ["unknown:1"],
				},
			]),
		},
		{
			name: "missing Finding ids",
			invalid: response([
				{ id: "pattern", name: "Rule", rule: "A rule.", findingIds: [] },
			]),
		},
	]) {
		test(`writes nothing after rejecting ${invalidCase.name}`, async () => {
			const target = await fixture();
			const scope = scopeFor(target.store);
			const promptDate = new Date(
				endingFriday.getFullYear(),
				endingFriday.getMonth(),
				endingFriday.getDate() - 1,
				13,
			);
			await putRecords(target.store, [
				makeRecord(scope, "prompt-1", promptDate, "This are wrong."),
			]);
			const fake = fakeGrader([invalidCase.invalid, invalidCase.invalid]);
			const result = await runDigest(
				scope,
				configFor(scope, target.root),
				fake.grader,
				new Date(endingFriday.getTime()),
			);
			expect(result.kind).toBe("failed");
			expect(fake.requests).toHaveLength(2);
			await expectNoDigestFiles(target.store);
		});
	}

	test("retries invalid output once and accepts the corrected Finding coverage", async () => {
		const target = await fixture();
		const scope = scopeFor(target.store);
		const promptDate = new Date(
			endingFriday.getFullYear(),
			endingFriday.getMonth(),
			endingFriday.getDate() - 1,
			13,
		);
		await putRecords(target.store, [
			makeRecord(scope, "prompt-1", promptDate, "This are wrong."),
		]);
		const fake = fakeGrader([
			response([
				{
					id: "pattern",
					name: "Rule",
					rule: "A rule.",
					findingIds: ["unknown:1"],
				},
			]),
			response([
				{
					id: "pattern",
					name: "Agreement",
					rule: "A singular subject takes a singular verb.",
					findingIds: ["prompt-1:1"],
				},
			]),
		]);
		const result = await runDigest(
			scope,
			configFor(scope, target.root),
			fake.grader,
			new Date(endingFriday.getTime()),
		);
		expect(result.kind).toBe("written");
		expect(fake.requests).toHaveLength(2);
		expect(fake.requests[1].user).toContain("prior result was invalid");
	});

	test("records an empty week so subsequent sessions do not retry it", async () => {
		const target = await fixture();
		const scope = scopeFor(target.store);
		await writeConfig(target, [
			{
				name: scope.name,
				store: scope.store,
				when: ["profile: test"],
				digestProfile: "test",
			},
		]);
		const result = await runDigest(
			scope,
			configFor(scope, target.root),
			fakeGrader([]).grader,
			new Date(endingFriday.getTime()),
		);
		expect(result).toEqual({ kind: "empty", week: "2026-10-02" });
		const emptyJson = JSON.parse(
			await readFile(
				path.join(target.store, "digests", "2026-10-02.json"),
				"utf8",
			),
		);
		expect(emptyJson.stats).toMatchObject({
			prompts: 0,
			reviewed: 0,
			clean: 0,
		});
		expect(await readdir(path.join(target.store, "digests"))).toEqual([
			"2026-10-02.json",
		]);
		const due = await dueDigests(
			{ profile: "test", cwd: "/tmp", now: new Date(endingFriday.getTime()) },
			{ env: target.env },
		);
		expect(due).toEqual([]);
	});

	test("grades a week once when sessions start together or later", async () => {
		const target = await fixture();
		const scope = scopeFor(target.store);
		const promptDate = new Date(
			endingFriday.getFullYear(),
			endingFriday.getMonth(),
			endingFriday.getDate() - 1,
			13,
		);
		await putRecords(target.store, [
			makeRecord(scope, "prompt-1", promptDate, "This are wrong."),
		]);
		const fake = fakeGrader([
			response([
				{
					id: "agreement",
					name: "Agreement",
					rule: "A singular subject takes a singular verb.",
					findingIds: ["prompt-1:1"],
				},
			]),
		]);
		const config = configFor(scope, target.root);
		const now = new Date(endingFriday.getTime());
		const together = await Promise.all([
			runDigest(scope, config, fake.grader, now),
			runDigest(scope, config, fake.grader, now),
		]);
		expect(together.map(({ kind }) => kind).sort()).toEqual([
			"locked",
			"written",
		]);
		const later = await runDigest(scope, config, fake.grader, now);
		expect(later).toEqual({ kind: "current", week: "2026-10-02" });
		expect(fake.requests).toHaveLength(1);
	});

	test("leaves the week stale when publishing digest.html fails", async () => {
		const target = await fixture();
		const scope = scopeFor(target.store);
		const promptDate = new Date(
			endingFriday.getFullYear(),
			endingFriday.getMonth(),
			endingFriday.getDate() - 1,
			13,
		);
		await putRecords(target.store, [
			makeRecord(scope, "prompt-1", promptDate, "This are wrong."),
		]);
		const fake = fakeGrader([
			response([
				{
					id: "agreement",
					name: "Agreement",
					rule: "A singular subject takes a singular verb.",
					findingIds: ["prompt-1:1"],
				},
			]),
		]);
		const blocker = path.join(target.store, "digest.html");
		await mkdir(path.join(blocker, "occupied"), { recursive: true });
		const config = configFor(scope, target.root);
		const now = new Date(endingFriday.getTime());
		const failed = await runDigest(scope, config, fake.grader, now);
		expect(failed.kind).toBe("failed");
		await expect(
			readFile(path.join(target.store, "digests", "2026-10-02.json"), "utf8"),
		).rejects.toThrow();

		await rm(blocker, { recursive: true });
		const retried = await runDigest(scope, config, fake.grader, now);
		expect(retried.kind).toBe("written");
	});
});
