import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { capture } from "../../src/core/capture.ts";
import { loadConfig, parseConfig } from "../../src/core/config.ts";
import { validateReview } from "../../src/core/grader.ts";
import { preprocess } from "../../src/core/preprocess.ts";
import { review } from "../../src/core/review.ts";
import { resolveScope } from "../../src/core/scope.ts";
import { readMonth, recordPath } from "../../src/core/store.ts";
import type { Grader, GraderRequest } from "../../src/core/types.ts";

describe("core configuration and scope matching", () => {
	test("routes the README example by profile or cwd, with first match winning", async () => {
		const root = await mkdtemp(join(tmpdir(), "prompt-tutor-config-"));
		try {
			const home = join(root, "home");
			const personal = join(home, "Documents", "personal");
			await mkdir(personal, { recursive: true });
			const yaml = `scopes:\n  - name: personal\n    when:\n      - profile: personal\n      - cwd: ~/Documents/personal/**\n  - name: work\n`;
			const parsed = parseConfig(yaml, join(root, "config.yml"), {
				HOME: home,
				XDG_DATA_HOME: join(root, "data"),
			});
			expect(parsed.ok).toBe(true);
			if (!parsed.ok) return;
			expect(
				resolveScope(parsed.config, { profile: "personal", cwd: root })?.name,
			).toBe("personal");
			expect(
				resolveScope(parsed.config, { profile: "work", cwd: personal })?.name,
			).toBe("personal");
			expect(
				resolveScope(parsed.config, { profile: "work", cwd: root })?.name,
			).toBe("work");
			expect(parsed.config.scopes[0]?.digestProfile).toBe("personal");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("matches cwd by realpath and lets dir/** match dir itself", async () => {
		const root = await mkdtemp(join(tmpdir(), "prompt-tutor-realpath-"));
		try {
			const home = join(root, "home");
			const target = join(home, "Documents", "personal");
			await mkdir(target, { recursive: true });
			await symlink(target, join(home, "alias"), "dir");
			const parsed = parseConfig(
				`scopes:\n  - name: personal\n    when:\n      - cwd: ~/Documents/personal/**\n`,
				join(root, "config.yml"),
				{ HOME: home },
			);
			expect(parsed.ok).toBe(true);
			if (!parsed.ok) return;
			expect(
				resolveScope(parsed.config, {
					profile: "default",
					cwd: join(home, "alias"),
				})?.name,
			).toBe("personal");
			const directoryRule = parseConfig(
				`scopes:\n  - name: project\n    when:\n      - cwd: ${target}/**\n`,
				join(root, "other.yml"),
				{ HOME: home },
			);
			expect(directoryRule.ok).toBe(true);
			if (directoryRule.ok) {
				expect(
					resolveScope(directoryRule.config, {
						profile: "default",
						cwd: target,
					})?.name,
				).toBe("project");
			}
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("applies AND within one when entry and reports invalid configuration", async () => {
		const root = await mkdtemp(join(tmpdir(), "prompt-tutor-invalid-config-"));
		try {
			const dir = join(root, "match");
			await mkdir(dir);
			const parsed = parseConfig(
				`scopes:\n  - name: both\n    when:\n      - profile: personal\n        cwd: ${dir}/**\n`,
				join(root, "config.yml"),
				{ XDG_DATA_HOME: join(root, "data") },
			);
			expect(parsed.ok).toBe(true);
			if (parsed.ok) {
				expect(
					resolveScope(parsed.config, { profile: "personal", cwd: dir })?.name,
				).toBe("both");
				expect(
					resolveScope(parsed.config, { profile: "work", cwd: dir }),
				).toBeNull();
				expect(
					resolveScope(parsed.config, { profile: "personal", cwd: root }),
				).toBeNull();
			}
			expect(parseConfig("scopes: [", join(root, "bad.yml")).ok).toBe(false);
			expect(
				parseConfig("scopes:\n  - name: all\n", join(root, "reserved.yml")).ok,
			).toBe(false);
			expect(
				parseConfig(
					`scopes:\n  - name: work\n    store: ${join(root, "work")}\nall_scopes_log: ${join(root, "work", "log")}\n`,
					join(root, "inside.yml"),
				).ok,
			).toBe(false);
			expect(parseConfig("scopes: []", join(root, "empty.yml")).ok).toBe(false);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("uses one default Scope when the config file is absent", async () => {
		const root = await mkdtemp(join(tmpdir(), "prompt-tutor-default-config-"));
		try {
			const env = {
				HOME: root,
				XDG_CONFIG_HOME: join(root, "config"),
				XDG_DATA_HOME: join(root, "data"),
			};
			const result = await loadConfig({ env });
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.config.scopes).toHaveLength(1);
				expect(result.config.scopes[0]?.name).toBe("default");
				expect(result.config.path).toBeNull();
			}
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});

describe("prompt preprocessing", () => {
	test("removes a leading slash token and substitutes fenced code", () => {
		expect(preprocess("/review fix my prompt").text).toBe("fix my prompt");
		expect(preprocess("before ```ts\nconst value = 1;\n``` after").text).toBe(
			"before [code] after",
		);
	});

	test("omits URLs only from counting and applies both skip reasons", () => {
		expect(preprocess("/command https://example.test/path")).toEqual({
			text: "https://example.test/path",
			wordCount: 0,
			skip: "nothing_to_review",
		});
		expect(
			preprocess("/command one https://example.test/path two").wordCount,
		).toBe(2);
		expect(preprocess("word ".repeat(600)).skip).toBeNull();
		const long = preprocess("word ".repeat(601));
		expect(long.wordCount).toBe(601);
		expect(long.skip).toBe("too_long");
	});
});

describe("Review validation and orchestration", () => {
	test("resolves quote offsets and rejects malformed, no-op, mismatched, and blank-kind results", () => {
		const text = "I has apple. They was nice.";
		const valid = validateReview(
			{
				findings: [
					{
						quote: "has",
						fix: "have",
						category: "grammar",
						why: "Use the plural verb.",
						kind: "verb agreement",
					},
					{
						quote: "was",
						fix: "were",
						category: "grammar",
						why: "Match the plural subject.",
						kind: "verb agreement",
					},
				],
				rewrite: "I have apple. They were nice.",
				tip: "Match a verb to its subject.",
			},
			text,
		);
		expect(valid.problems).toEqual([]);
		expect(
			valid.review?.findings.map(({ start, end }) => [start, end]),
		).toEqual([
			[2, 5],
			[18, 21],
		]);
		expect(
			validateReview({ findings: [], rewrite: "not null", tip: null }, text)
				.problems.length,
		).toBeGreaterThan(0);
		expect(
			validateReview(
				{
					findings: [
						{
							quote: "has",
							fix: "has",
							category: "grammar",
							why: "No change.",
							kind: "verb",
						},
					],
					rewrite: "x",
					tip: "x",
				},
				text,
			).problems.length,
		).toBeGreaterThan(0);
		expect(
			validateReview(
				{
					findings: [
						{
							quote: "has",
							fix: "have",
							category: "grammar",
							why: "Rule.",
							kind: "   ",
						},
					],
					rewrite: "x",
					tip: "x",
				},
				text,
			).problems.length,
		).toBeGreaterThan(0);
		expect(
			validateReview(
				{
					findings: [
						{
							quote: "missing",
							fix: "found",
							category: "grammar",
							why: "Rule.",
							kind: "word order",
						},
					],
					rewrite: "x",
					tip: "x",
				},
				text,
			).problems.length,
		).toBeGreaterThan(0);
		expect(
			validateReview(
				{
					findings: [
						{
							quote: "has apple",
							fix: "have apple",
							category: "grammar",
							why: "Rule.",
							kind: "agreement",
						},
						{
							quote: "apple",
							fix: "fruit",
							category: "grammar",
							why: "Rule.",
							kind: "noun",
						},
					],
					rewrite: "x",
					tip: "x",
				},
				text,
			).problems.length,
		).toBeGreaterThan(0);
	});

	test("captures the pending record and retries an invalid grader response before failing", async () => {
		const root = await mkdtemp(join(tmpdir(), "prompt-tutor-capture-review-"));
		try {
			const env = {
				HOME: root,
				XDG_CONFIG_HOME: join(root, "config"),
				XDG_DATA_HOME: join(root, "data"),
			};
			const cwd = join(root, "working");
			await mkdir(cwd, { recursive: true });
			const now = new Date("2026-10-08T14:15:02.123Z");
			const captured = await capture(
				{ text: "check the logs", profile: "default", cwd, now },
				{ env },
			);
			expect(captured.kind).toBe("captured");
			if (captured.kind !== "captured") return;
			expect(captured.record.state).toBe("pending");
			expect(captured.record.log_month).toBe(
				`${String(now.getFullYear()).padStart(4, "0")}-${String(now.getMonth() + 1).padStart(2, "0")}`,
			);
			expect(captured.record.utc_offset_minutes).toBe(-now.getTimezoneOffset());
			expect(
				await readFile(
					recordPath(captured.scope.store, captured.record),
					"utf8",
				),
			).toContain('"version": 1');
			expect(
				await readFile(
					join(captured.scope.store, "log", "r", `${captured.record.id}.html`),
					"utf8",
				),
			).toContain(captured.record.log_month);
			expect(
				(await readMonth(captured.scope.store, captured.record.log_month))[0]
					?.state,
			).toBe("pending");

			let calls = 0;
			let secondRequest: GraderRequest | undefined;
			const grader: Grader = {
				async call(request) {
					calls++;
					if (calls === 2) secondRequest = request;
					return {
						toolArgs: {
							findings: [],
							rewrite: "invalid for an empty Review",
							tip: null,
						},
						model: "test/model",
						requestedReasoning: "medium",
					};
				},
			};
			const outcome = await review(captured, grader);
			expect(calls).toBe(2);
			expect(secondRequest?.user).toBe(captured.record.text);
			expect(secondRequest?.system).toContain("previous response was invalid");
			expect(outcome.record.state).toBe("failed");
			expect(outcome.record.failure).toBeTruthy();
			expect(outcome.record.review).toBeUndefined();
			expect(outcome.record.grader?.attempts).toBe(2);
			expect(
				(await readMonth(captured.scope.store, captured.record.log_month))[0]
					?.state,
			).toBe("failed");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
