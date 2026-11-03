import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Leaf-module imports: test/omp mocks src/core/index.ts, and bun applies that mock to an index loaded earlier.
import { capture } from "../../src/core/capture.ts";
import { parseConfig } from "../../src/core/config.ts";
import {
	drainerMayDigest,
	dueDrainerDigests,
} from "../../src/core/digest/index.ts";
import { drainQueue, queuedRecords } from "../../src/core/drain.ts";
import {
	acquireDrainLock,
	drainLockPath,
	liveDrainLock,
	readDrainLock,
	releaseDrainLockSync,
} from "../../src/core/drain-lock.ts";
import { recordPath, writeRecord } from "../../src/core/store.ts";
import {
	FORMAT_VERSION,
	type Grader,
	type GraderRequest,
	type PromptRecord,
} from "../../src/core/types.ts";

let root: string;
let env: NodeJS.ProcessEnv;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "prompt-tutor-drain-"));
	env = {
		HOME: root,
		XDG_CONFIG_HOME: join(root, "config"),
		XDG_DATA_HOME: join(root, "data"),
	};
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

async function writeConfig(yaml: string): Promise<void> {
	await mkdir(join(root, "config", "prompt-tutor"), { recursive: true });
	await writeFile(join(root, "config", "prompt-tutor", "config.yml"), yaml);
}

function record(
	store: string,
	overrides: Partial<PromptRecord> & Pick<PromptRecord, "id" | "captured_at">,
): Promise<void> {
	return writeRecord(store, {
		version: FORMAT_VERSION,
		scope: "work",
		profile: "claude-code",
		harness: "claude-code",
		cwd: root,
		utc_offset_minutes: 0,
		log_month: overrides.captured_at.slice(0, 7),
		text: "I has a apple.",
		word_count: 4,
		state: "pending",
		...overrides,
	});
}

const cleanGrader = (calls: string[]): Grader => ({
	async call(request: GraderRequest) {
		calls.push(request.user);
		return {
			toolArgs: { findings: [], rewrite: null, tip: null },
			model: "fake/model",
			requestedReasoning: "medium",
		};
	},
});

describe("review_profile config", () => {
	const parse = (extra: string) =>
		parseConfig(
			`scopes:\n  - name: work\n    when:\n      - profile: work\n${extra}`,
			join(root, "config.yml"),
			env,
		);

	test("absent is null, with no default from when", () => {
		const result = parse("");
		expect(result.ok && result.config.scopes[0].reviewProfile).toBeNull();
		expect(result.ok && result.config.scopes[0].digestProfile).toBe("work");
	});

	test("accepts a string and null", () => {
		const named = parse("    review_profile: work\n");
		expect(named.ok && named.config.scopes[0].reviewProfile).toBe("work");
		const none = parse("    review_profile: null\n");
		expect(none.ok && none.config.scopes[0].reviewProfile).toBeNull();
	});

	test("rejects empty and non-string values", () => {
		for (const value of ['""', "3", "[a]"]) {
			const result = parse(`    review_profile: ${value}\n`);
			expect(result.ok).toBe(false);
			if (!result.ok)
				expect(result.error).toBe(
					"scopes[0].review_profile must be a non-empty string or null",
				);
		}
	});
});

describe("drain lock", () => {
	test("acquire, held, and release only own lock", async () => {
		const store = join(root, "store");
		expect(await acquireDrainLock(store, "work")).toEqual({ acquired: true });
		const again = await acquireDrainLock(store, "other");
		expect(again.acquired).toBe(false);
		if (!again.acquired) expect(again.held.pid).toBe(process.pid);
		expect((await liveDrainLock(store))?.profile).toBe("work");
		releaseDrainLockSync(store);
		expect(await readDrainLock(store)).toBeNull();

		await writeFile(
			drainLockPath(store),
			JSON.stringify({ pid: 1, profile: "x", started_at: "t" }),
		);
		releaseDrainLockSync(store);
		expect((await readDrainLock(store))?.pid).toBe(1);
	});

	test("takes over a stale or malformed lock", async () => {
		const store = join(root, "store");
		await mkdir(store, { recursive: true });
		const dead = Bun.spawnSync(["true"]).pid;
		await writeFile(
			drainLockPath(store),
			JSON.stringify({ pid: dead, profile: "x", started_at: "t" }),
		);
		expect(await liveDrainLock(store)).toBeNull();
		expect(await acquireDrainLock(store, "work")).toEqual({ acquired: true });
		expect((await readDrainLock(store))?.pid).toBe(process.pid);
		releaseDrainLockSync(store);

		await writeFile(drainLockPath(store), "not json");
		expect(await acquireDrainLock(store, "work")).toEqual({ acquired: true });
		releaseDrainLockSync(store);
	});

	test("two concurrent takeovers of a stale lock: exactly one wins", async () => {
		const store = join(root, "store");
		await mkdir(store, { recursive: true });
		const dead = Bun.spawnSync(["true"]).pid;
		for (let round = 0; round < 20; round++) {
			await writeFile(
				drainLockPath(store),
				JSON.stringify({ pid: dead, profile: "x", started_at: "t" }),
			);
			const results = await Promise.all([
				acquireDrainLock(store, "a"),
				acquireDrainLock(store, "b"),
			]);
			expect(results.filter((result) => result.acquired)).toHaveLength(1);
			const lock = await readDrainLock(store);
			expect(lock?.pid).toBe(process.pid);
			expect(["a", "b"]).toContain(lock?.profile ?? "");
			releaseDrainLockSync(store);
		}
	});
});

describe("queued records", () => {
	test("only pending Claude Code records, oldest first across months", async () => {
		const store = join(root, "store");
		await record(store, { id: "b", captured_at: "2026-10-02T00:00:00.000Z" });
		await record(store, { id: "a", captured_at: "2026-09-30T00:00:00.000Z" });
		await record(store, {
			id: "omp",
			captured_at: "2026-09-01T00:00:00.000Z",
			harness: undefined,
			profile: "work",
		});
		await record(store, {
			id: "done",
			captured_at: "2026-09-02T00:00:00.000Z",
			state: "failed",
			failure: "x",
		});
		await writeFile(
			join(store, "prompts", "2026-10", "bad.json"),
			JSON.stringify({ version: FORMAT_VERSION, harness: "cursor" }),
		);
		expect((await queuedRecords(store)).map((r) => r.id)).toEqual(["a", "b"]);
	});
});

describe("drainQueue", () => {
	test("grades this profile's queue only and never regrades settled records", async () => {
		await writeConfig(
			`scopes:\n  - name: work\n    when:\n      - cwd: ${root}/w/**\n    review_profile: work\n  - name: home\n    review_profile: home\n`,
		);
		const work = join(root, "data", "prompt-tutor", "work");
		const home = join(root, "data", "prompt-tutor", "home");
		await record(work, { id: "w1", captured_at: "2026-10-01T00:00:00.000Z" });
		await record(work, {
			id: "w2",
			captured_at: "2026-10-01T00:00:01.000Z",
			state: "failed",
			failure: "x",
		});
		await record(home, {
			id: "h1",
			scope: "home",
			captured_at: "2026-10-01T00:00:00.000Z",
		});

		const calls: string[] = [];
		const lines: string[] = [];
		const controller = new AbortController();
		await drainQueue({
			profile: "work",
			grader: cleanGrader(calls),
			log: (line) => {
				lines.push(line);
				if (line === "work w1 clean") controller.abort();
			},
			signal: controller.signal,
			env,
			pollMs: 20,
		});

		expect(calls).toHaveLength(1);
		expect(lines).toContain("draining work");
		expect(lines).toContain("work w1 clean");
		const settled: PromptRecord = JSON.parse(
			await readFile(
				recordPath(work, { log_month: "2026-10", id: "w1" }),
				"utf8",
			),
		);
		expect(settled.state).toBe("reviewed");
		expect((await queuedRecords(home)).map((r) => r.id)).toEqual(["h1"]);
		expect(await readDrainLock(work)).toBeNull();
		expect(await readDrainLock(home)).toBeNull();
	});

	test("skips a Scope whose lock another live process holds", async () => {
		await writeConfig("scopes:\n  - name: work\n    review_profile: work\n");
		const work = join(root, "data", "prompt-tutor", "work");
		await mkdir(work, { recursive: true });
		const other = Bun.spawn(["sleep", "30"]);
		await writeFile(
			drainLockPath(work),
			JSON.stringify({ pid: other.pid, profile: "work", started_at: "t" }),
		);
		await record(work, { id: "w1", captured_at: "2026-10-01T00:00:00.000Z" });
		const calls: string[] = [];
		const lines: string[] = [];
		const controller = new AbortController();
		await drainQueue({
			profile: "work",
			grader: cleanGrader(calls),
			log: (line) => {
				lines.push(line);
				controller.abort();
			},
			signal: controller.signal,
			env,
			pollMs: 20,
		});
		other.kill();
		expect(lines).toEqual([
			`already draining work (pid ${other.pid}, ${drainLockPath(work)})`,
		]);
		expect(calls).toHaveLength(0);
	});
});

// The reported setup: work Prompts come from Claude Code and the Drainers run in
// personal directories, so cwd never resolves a Drainer to the work Scope.
const REPORTED_CONFIG = `scopes:
  - name: personal
    when:
      - profile: personal
      - cwd: ~/Documents/personal/**
    review_profile: personal
  - name: work
    review_profile: default
`;
const SATURDAY = new Date(2026, 9, 3, 12, 0, 0, 0);
const WEEK = "2026-10-02";

async function loadedConfig() {
	await writeConfig(REPORTED_CONFIG);
	const parsed = parseConfig(
		REPORTED_CONFIG,
		join(root, "config", "prompt-tutor", "config.yml"),
		env,
	);
	if (!parsed.ok) throw new Error(parsed.error);
	return parsed.config;
}

describe("Drainer Digests", () => {
	test("a Drainer may digest Scopes whose digest_profile or review_profile is its profile", async () => {
		const config = await loadedConfig();
		const [personal, work] = config.scopes;
		expect(personal.digestProfile).toBe("personal");
		expect(work.digestProfile).toBeNull();
		expect(drainerMayDigest(work, "default")).toBe(true);
		expect(drainerMayDigest(personal, "personal")).toBe(true);
		expect(drainerMayDigest(work, "personal")).toBe(false);
		expect(drainerMayDigest(personal, "default")).toBe(false);

		const named = { ...work, digestProfile: "a", reviewProfile: "b" };
		expect(drainerMayDigest(named, "a")).toBe(true);
		// An explicit digest_profile is never overridden by the review profile.
		expect(drainerMayDigest(named, "b")).toBe(false);
		// With no review_profile, a Drainer has no claim on a Scope with no digest_profile.
		expect(drainerMayDigest({ ...work, reviewProfile: null }, "default")).toBe(
			false,
		);
	});

	test("selects each Scope for its own Drainer only, and not once its week is written", async () => {
		const config = await loadedConfig();
		const names = async (profile: string) =>
			(await dueDrainerDigests({ profile, now: SATURDAY }, config)).map(
				(scope) => scope.name,
			);
		expect(await names("default")).toEqual(["work"]);
		expect(await names("personal")).toEqual(["personal"]);
		expect(await names("other")).toEqual([]);

		const work = config.scopes[1];
		await mkdir(join(work.store, "digests"), { recursive: true });
		await writeFile(join(work.store, "digests", `${WEEK}.json`), "{}\n");
		expect(await names("default")).toEqual([]);
		expect(await names("personal")).toEqual(["personal"]);
		// The next week is due again once its Friday noon has passed.
		const nextFriday = new Date(2026, 9, 9, 12, 0, 0, 0);
		expect(
			(
				await dueDrainerDigests({ profile: "default", now: nextFriday }, config)
			).map((scope) => scope.name),
		).toEqual(["work"]);
	});

	async function reviewedWorkPrompt(): Promise<string> {
		const config = await loadedConfig();
		const store = config.scopes[1].store;
		const capturedAt = new Date(2026, 8, 30, 13, 0, 0, 0);
		await record(store, {
			id: "w1",
			captured_at: capturedAt.toISOString(),
			utc_offset_minutes: -capturedAt.getTimezoneOffset(),
			text: "This are wrong.",
			state: "reviewed",
			review: {
				findings: [
					{
						quote: "are",
						fix: "is",
						category: "grammar",
						why: "A singular subject takes a singular verb.",
						kind: "subject verb agreement",
						start: 5,
						end: 8,
					},
				],
				rewrite: "This is wrong.",
				tip: "Match the verb to the subject.",
			},
			grader: {
				model: "test/task",
				requested_reasoning: "medium",
				prompt_hash: "a1b2c3d4",
				attempts: 1,
			},
		});
		return store;
	}

	const digestGrader = (calls: GraderRequest[]): Grader => ({
		async call(request: GraderRequest) {
			calls.push(request);
			return {
				toolArgs: {
					patterns: [
						{
							id: "subject-agreement",
							name: "Subject-verb agreement",
							rule: "A singular subject takes a singular verb.",
							findingIds: ["w1:1"],
							explanation: "",
							tip: "",
							practice: [],
						},
					],
					lesson: "Match the verb to the subject.",
					focus: "Check each subject and verb.",
				},
				model: "test/advisor",
				requestedReasoning: "high",
			};
		},
	});

	test("builds the due Digest at start, beside an empty review queue", async () => {
		const store = await reviewedWorkPrompt();
		const calls: GraderRequest[] = [];
		const lines: string[] = [];
		const controller = new AbortController();
		await drainQueue({
			profile: "default",
			grader: cleanGrader([]),
			digestGrader: digestGrader(calls),
			now: () => SATURDAY,
			log: (line) => {
				lines.push(line);
				if (line.includes("digest")) controller.abort();
			},
			signal: controller.signal,
			env,
			pollMs: 20,
		});
		expect(calls).toHaveLength(1);
		expect(lines).toContain("draining work");
		expect(
			lines.some((line) =>
				line.startsWith(`work digest ${WEEK} written: ${store}`),
			),
		).toBe(true);
		const archive = JSON.parse(
			await readFile(join(store, "digests", `${WEEK}.json`), "utf8"),
		);
		expect(archive.scope).toBe("work");
		expect(lines.some((line) => line.startsWith("personal digest"))).toBe(
			false,
		);
	});

	test("builds nothing without a digest grader or for another profile", async () => {
		const store = await reviewedWorkPrompt();
		for (const options of [
			{ profile: "default", digestGrader: undefined },
			{ profile: "personal", digestGrader: digestGrader([]) },
		]) {
			const lines: string[] = [];
			const controller = new AbortController();
			setTimeout(() => controller.abort(), 150);
			await drainQueue({
				...options,
				grader: cleanGrader([]),
				now: () => SATURDAY,
				log: (line) => lines.push(line),
				signal: controller.signal,
				env,
				pollMs: 20,
			});
			expect(lines.filter((line) => line.startsWith("work digest"))).toEqual(
				[],
			);
			await expect(
				readFile(join(store, "digests", `${WEEK}.json`), "utf8"),
			).rejects.toThrow();
		}
	});

	test("picks up a week that becomes due while running, and stops on abort mid-Digest", async () => {
		const store = await reviewedWorkPrompt();
		let now = new Date(2026, 9, 2, 11, 0, 0, 0); // Friday before noon: the week before is done
		const lines: string[] = [];
		const controller = new AbortController();
		let started: () => void = () => undefined;
		const callStarted = new Promise<void>((resolve) => {
			started = resolve;
		});
		const hanging: Grader = {
			call: () => {
				started();
				return new Promise(() => undefined);
			},
		};
		await mkdir(join(store, "digests"), { recursive: true });
		await writeFile(join(store, "digests", "2026-09-25.json"), "{}\n");
		const finished = drainQueue({
			profile: "default",
			grader: cleanGrader([]),
			digestGrader: hanging,
			digestCheckMs: 20,
			now: () => now,
			log: (line) => lines.push(line),
			signal: controller.signal,
			env,
			pollMs: 20,
		});
		await Bun.sleep(100);
		expect(lines.filter((line) => line.includes(" digest "))).toEqual([]);
		now = SATURDAY;
		await callStarted;
		controller.abort();
		await finished;
		// The aborted Digest left no marker and released its lock.
		await expect(
			readFile(join(store, "digests", `${WEEK}.json`), "utf8"),
		).rejects.toThrow();
		await expect(
			readFile(join(store, "digests", ".lock"), "utf8"),
		).rejects.toThrow();
		expect(lines.filter((line) => line.includes(" digest "))).toEqual([]);
	});
});

test("capture writes harness when given", async () => {
	await writeConfig("scopes:\n  - name: work\n");
	const result = await capture(
		{
			text: "I has a apple.",
			profile: "claude-code",
			cwd: root,
			now: new Date("2026-10-01T00:00:00Z"),
			harness: "claude-code",
		},
		{ env },
	);
	expect(result.kind === "captured" && result.record.harness).toBe(
		"claude-code",
	);
});
