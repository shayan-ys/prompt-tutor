import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Leaf-module imports: test/omp mocks src/core/index.ts, and bun applies that mock to an index loaded earlier.
import { parseConfig } from "../../src/core/config.ts";
import { drainQueue } from "../../src/core/drain.ts";
import { isRegradable, regradeFailed } from "../../src/core/regrade.ts";
import { readRecord, writeRecord } from "../../src/core/store.ts";
import {
	type Config,
	FORMAT_VERSION,
	type PromptRecord,
} from "../../src/core/types.ts";

let root: string;
let env: NodeJS.ProcessEnv;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "prompt-tutor-regrade-"));
	env = {
		HOME: root,
		XDG_CONFIG_HOME: join(root, "config"),
		XDG_DATA_HOME: join(root, "data"),
	};
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

const CONFIG = `scopes:
  - name: personal
    review_profile: personal
  - name: work
`;

async function loadConfig(): Promise<Config> {
	await mkdir(join(root, "config", "prompt-tutor"), { recursive: true });
	const path = join(root, "config", "prompt-tutor", "config.yml");
	await writeFile(path, CONFIG);
	const parsed = parseConfig(CONFIG, path, env);
	if (!parsed.ok) throw new Error(parsed.error);
	return parsed.config;
}

function failed(
	id: string,
	overrides: Partial<PromptRecord> = {},
): PromptRecord {
	return {
		version: FORMAT_VERSION,
		id,
		scope: "personal",
		profile: "personal",
		cwd: root,
		captured_at: "2026-11-10T15:00:00.000Z",
		utc_offset_minutes: -300,
		log_month: "2026-11",
		text: "I has a apple.",
		word_count: 4,
		state: "failed",
		failure: "grader failed: No available model is configured for @task.",
		grader: {
			model: "openai/gpt",
			requested_reasoning: "medium",
			prompt_hash: "abc",
			attempts: 1,
		},
		settled_at: "2026-11-10T15:00:05.000Z",
		...overrides,
	};
}

describe("isRegradable", () => {
	test("only failures of the grader call itself", () => {
		expect(isRegradable(failed("a"))).toBe(true);
		expect(
			isRegradable(
				failed("b", {
					failure:
						"grader failed: Couldn't reach chatgpt.com (getaddrinfo ENOTFOUND).",
				}),
			),
		).toBe(true);
		expect(
			isRegradable(
				failed("c", {
					failure: "grader failed: no response from cursor/grok in 120 s",
				}),
			),
		).toBe(true);
		expect(
			isRegradable(failed("d", { failure: "invalid Review after 2 attempts" })),
		).toBe(false);
		expect(
			isRegradable(
				failed("e", {
					state: "skipped",
					skip_reason: "too_long",
					failure: undefined,
				}),
			),
		).toBe(false);
		expect(
			isRegradable(
				failed("f", {
					state: "reviewed",
					failure: "grader failed: earlier",
				}),
			),
		).toBe(false);
	});
});

describe("regradeFailed", () => {
	test("queues grader failures as pending regrade records and keeps everything else", async () => {
		const config = await loadConfig();
		const [personal, work] = config.scopes;
		const store = personal.store;
		await writeRecord(store, failed("grader"));
		await writeRecord(
			store,
			failed("invalid", { failure: "invalid Review after 2 attempts" }),
		);
		const skipped: PromptRecord = {
			...failed("skipped"),
			state: "skipped",
			skip_reason: "too_long",
			failure: undefined,
			grader: undefined,
			settled_at: undefined,
		};
		await writeRecord(store, skipped);
		await writeRecord(work.store, failed("work", { scope: "work" }));

		const results = await regradeFailed(config, { scopes: config.scopes });

		expect(
			results.map(({ scope, regradable, kept, queued }) => ({
				scope: scope.name,
				regradable,
				kept,
				queued,
			})),
		).toEqual([
			{ scope: "personal", regradable: 1, kept: 1, queued: true },
			// No review_profile: no Drainer would ever take the record, so it stays failed.
			{ scope: "work", regradable: 1, kept: 0, queued: false },
		]);
		const queued = await readRecord(store, failed("grader"));
		expect(queued).toEqual({
			...failed("grader"),
			state: "pending",
			regrade: true,
			failure: undefined,
			grader: undefined,
			settled_at: undefined,
		} as PromptRecord);
		expect(queued && "failure" in queued).toBe(false);
		expect((await readRecord(store, failed("invalid")))?.state).toBe("failed");
		expect((await readRecord(store, skipped))?.state).toBe("skipped");
		expect((await readRecord(work.store, failed("work")))?.state).toBe(
			"failed",
		);
		// The Review log page shows the record as pending again.
		expect(
			await readFile(join(store, "log", "2026-11.html"), "utf8"),
		).toContain('id="grader"');
	});

	test("--since compares the local capture date; a dry run writes nothing", async () => {
		const config = await loadConfig();
		const [personal] = config.scopes;
		// 2026-11-01T03:00Z is still 2026-10-31 at UTC-5.
		await writeRecord(
			personal.store,
			failed("before", {
				captured_at: "2026-11-01T03:00:00.000Z",
				log_month: "2026-10",
			}),
		);
		await writeRecord(
			personal.store,
			failed("on", { captured_at: "2026-11-01T06:00:00.000Z" }),
		);

		const dry = await regradeFailed(config, {
			scopes: [personal],
			since: "2026-11-01",
			dryRun: true,
		});
		expect(dry[0]).toMatchObject({ regradable: 1, queued: false });
		expect((await readRecord(personal.store, failed("on")))?.state).toBe(
			"failed",
		);

		await regradeFailed(config, { scopes: [personal], since: "2026-11-01" });
		expect((await readRecord(personal.store, failed("on")))?.state).toBe(
			"pending",
		);
		expect(
			(
				await readRecord(personal.store, {
					id: "before",
					log_month: "2026-10",
				})
			)?.state,
		).toBe("failed");
	});

	test("the review_profile Drainer reviews a regraded omp record and clears the flag", async () => {
		const config = await loadConfig();
		const [personal] = config.scopes;
		await writeRecord(personal.store, failed("omp"));
		await regradeFailed(config, { scopes: [personal] });

		const controller = new AbortController();
		const graded: string[] = [];
		await drainQueue({
			profile: "personal",
			grader: {
				async call(request) {
					graded.push(request.user);
					return {
						toolArgs: { findings: [], rewrite: null, tip: null },
						model: "fake/task",
						requestedReasoning: "medium",
					};
				},
			},
			log: (line) => {
				if (line === "personal omp clean") controller.abort();
			},
			signal: controller.signal,
			env,
			pollMs: 20,
		});

		expect(graded).toEqual(["I has a apple."]);
		const settled = await readRecord(personal.store, failed("omp"));
		expect(settled?.state).toBe("reviewed");
		expect(settled?.grader?.model).toBe("fake/task");
		expect(settled && "regrade" in settled).toBe(false);
		expect(settled && "failure" in settled).toBe(false);
	});
});
