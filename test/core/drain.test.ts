import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Leaf-module imports: test/omp mocks src/core/index.ts, and bun applies that mock to an index loaded earlier.
import { capture } from "../../src/core/capture.ts";
import { parseConfig } from "../../src/core/config.ts";
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
