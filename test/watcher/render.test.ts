import { describe, expect, test } from "bun:test";
import type { Config, PromptRecord } from "../../src/core/types.ts";
import {
	bodyScrollRange,
	renderErrorFrame,
	renderFrame,
} from "../../src/watcher/render.ts";

const config: Config = {
	path: null,
	allScopesLog: "/tmp/prompt-tutor/all/log",
	keepMonths: null,
	explanationLanguage: "English",
	scopes: [
		{
			name: "work",
			index: 0,
			store: "/tmp/prompt-tutor/work",
			when: [],
			digestProfile: null,
		},
		{
			name: "personal",
			index: 1,
			store: "/tmp/prompt-tutor/personal",
			when: [],
			digestProfile: null,
		},
	],
};

function record(overrides: Partial<PromptRecord> = {}): PromptRecord {
	return {
		version: 1,
		id: "20261008T134100000-a1b2c3",
		scope: "work",
		profile: "default",
		cwd: "/tmp",
		captured_at: "2026-10-08T13:41:00.000Z",
		utc_offset_minutes: 0,
		log_month: "2026-10",
		text: "The build are broken.",
		word_count: 4,
		state: "reviewed",
		review: {
			findings: [
				{
					quote: "are",
					fix: "is",
					category: "grammar",
					why: "Subject agreement.",
					kind: "agreement",
					start: 10,
					end: 13,
				},
			],
			rewrite: "The build is broken.",
			tip: "Match the verb to its subject.",
		},
		...overrides,
	};
}

function plain(text: string): string {
	return text
		.replace(/\x1b\]8;;[^\x1b]*\x1b\\/g, "")
		.replace(/\x1b\[[0-9;]*m/g, "");
}

function frame(
	selected: PromptRecord,
	records = [selected],
	newerVersion = 0,
): string {
	return plain(
		renderFrame({
			config,
			records,
			view: "all",
			selectedId: selected.id,
			width: 100,
			height: 60,
			now: Date.parse("2026-10-08T13:41:03.000Z"),
			newerVersion,
		}),
	);
}

describe("Watcher frame", () => {
	test("renders the anchored Rewrite diff, category badge, Tip, and Review-log link in order", () => {
		const output = frame(record());
		expect(output).toContain("grammar 1");
		expect(output).toContain("log ↗");
		expect(output).toContain("The build");
		expect(output).toContain("are");
		expect(output).toContain("is");
		expect(output).toContain("Match the verb to its subject.");
		expect(output.indexOf("The build")).toBeLessThan(
			output.indexOf("Match the verb to its subject."),
		);
		expect(output).not.toContain("Subject agreement.");
	});

	test("renders a clean Prompt with a check and no Review Tip", () => {
		const clean = record({
			id: "clean",
			text: "Please add the receipt to the folder.",
			state: "reviewed",
			review: { findings: [], rewrite: null, tip: null },
		});
		const output = frame(clean);
		expect(output).toContain("✓");
		expect(output).toContain("Please add the receipt to the folder.");
		expect(output).not.toContain("Match the verb to its subject.");
	});

	test("renders a pending spinner, elapsed time, and dimmed Prompt", () => {
		const pending = record({
			state: "pending",
			captured_at: "2026-10-08T13:41:00.000Z",
		});
		delete pending.review;
		const output = frame(pending);
		expect(output).toContain("reviewing… 3s");
		expect(output).toContain("The build are broken.");
	});

	test("renders a failed Review badge and reason", () => {
		const failed = record({
			state: "failed",
			failure: "invalid output after retry",
		});
		delete failed.review;
		const output = frame(failed);
		expect(output).toContain("EN ?");
		expect(output).toContain("Review failed: invalid output after retry");
		expect(output).toContain("The build are broken.");
	});

	test("renders skipped word-count status", () => {
		const skipped = record({
			state: "skipped",
			skip_reason: "too_long",
			word_count: 601,
		});
		delete skipped.review;
		const output = frame(skipped);
		expect(output).toContain("skipped: too long (601 words)");
		expect(output).toContain("The build are broken.");
	});

	test("shows the three nearest older Prompts newest-first, after the focused Tip", () => {
		const selected = record({
			id: "newest",
			captured_at: "2026-10-08T14:00:00.000Z",
			text: "The selected Prompt.",
		});
		const olderNewest = record({
			id: "older-1",
			scope: "personal",
			captured_at: "2026-10-08T13:00:00.000Z",
			text: "The first earlier Prompt.",
		});
		const olderMiddle = record({
			id: "older-2",
			captured_at: "2026-10-08T12:00:00.000Z",
			text: "The second earlier Prompt.",
		});
		const olderOldest = record({
			id: "older-3",
			scope: "personal",
			captured_at: "2026-10-08T11:00:00.000Z",
			text: "The third earlier Prompt.",
		});
		const outsideTrail = record({
			id: "older-4",
			captured_at: "2026-10-08T10:00:00.000Z",
			text: "Outside the trail.",
		});
		const output = frame(selected, [
			selected,
			olderNewest,
			olderMiddle,
			olderOldest,
			outsideTrail,
		]);
		const tipAt = output.indexOf("Match the verb to its subject.");
		const earlierAt = output.indexOf("earlier");
		const newestAt = output.indexOf("The first earlier Prompt.");
		const middleAt = output.indexOf("The second earlier Prompt.");
		const oldestAt = output.indexOf("The third earlier Prompt.");
		expect(tipAt).toBeGreaterThan(-1);
		expect(tipAt).toBeLessThan(earlierAt);
		expect(earlierAt).toBeLessThan(newestAt);
		expect(newestAt).toBeLessThan(middleAt);
		expect(middleAt).toBeLessThan(oldestAt);
		expect(output).not.toContain("Outside the trail.");
	});

	test("shows the newer-format upgrade warning", () => {
		const output = frame(record(), [record()], 1);
		expect(output).toContain("written by a newer prompt-tutor — upgrade");
	});

	test("scrolls the final Review line into view in embedded and interactive frames", () => {
		const reviewed = record({
			review: {
				findings: record().review?.findings ?? [],
				rewrite: null,
				tip: Array.from(
					{ length: 13 },
					(_, index) => `Review line ${String(index + 1).padStart(2, "0")}`,
				).join("\n"),
			},
		});
		for (const [width, height] of [
			[50, 12],
			[80, 14],
		]) {
			for (const embedded of [false, true]) {
				const options = {
					config,
					records: [reviewed],
					view: "all",
					selectedId: reviewed.id,
					width,
					height,
					embedded,
					newerVersion: 1,
					scrollAware: true,
				};
				const maxScroll = bodyScrollRange(options);
				expect(maxScroll).toBeGreaterThanOrEqual(0);
				let scroll = 0;
				let output = "";
				while (scroll <= maxScroll) {
					output = plain(renderFrame({ ...options, scroll }));
					if (!/… \d+ more lines?/.test(output)) break;
					scroll++;
				}
				expect(output).not.toMatch(/… \d+ more lines?/);
				expect(output).toContain("Review line 13");
			}
		}
	});
	test("keeps body room ahead of the trail in compact scroll-aware frames", () => {
		const selected = record({
			id: "selected",
			captured_at: "2026-10-08T14:00:00.000Z",
			review: {
				findings: record().review?.findings ?? [],
				rewrite: null,
				tip: Array.from(
					{ length: 20 },
					(_, index) =>
						`Selected Review line ${String(index + 1).padStart(2, "0")}`,
				).join("\n"),
			},
		});
		const records = [
			selected,
			...["first", "second", "final"].map((name, index) =>
				record({
					id: `older-${name}`,
					captured_at: `2026-10-08T${String(13 - index).padStart(2, "0")}:00:00.000Z`,
					text: `Older ${name} Prompt.`,
				}),
			),
		];
		for (const [height, embedded] of [
			[12, false],
			[10, true],
		] as const) {
			const options = {
				config,
				records,
				view: "all",
				selectedId: selected.id,
				width: 80,
				height,
				embedded,
				showNavigation: true,
				scrollAware: true,
			};
			const initial = plain(renderFrame(options));
			expect(initial).toContain("Selected Review line 01");

			let output = initial;
			for (let scroll = 1; scroll <= bodyScrollRange(options); scroll++) {
				output = plain(renderFrame({ ...options, scroll }));
			}
			expect(output).toContain("Selected Review line 20");
		}
	});

	test("fits stateless embedded frames body-first before clipping the trail", () => {
		const selected = record({
			id: "stateless-selected",
			review: {
				findings: record().review?.findings ?? [],
				rewrite: null,
				tip: Array.from(
					{ length: 20 },
					(_, index) =>
						`Stateless Review line ${String(index + 1).padStart(2, "0")}`,
				).join("\n"),
			},
		});
		const records = [
			selected,
			...["one", "two", "three"].map((name, index) =>
				record({
					id: `older-${name}`,
					captured_at: `2026-10-08T${String(12 - index).padStart(2, "0")}:00:00.000Z`,
					text: `Older ${name} Prompt.`,
				}),
			),
		];
		const output = plain(
			renderFrame({
				config,
				records,
				view: "all",
				selectedId: selected.id,
				width: 80,
				height: 12,
				embedded: true,
				showNavigation: false,
				scrollAware: false,
			}),
		);
		expect(output).toContain("Stateless Review line 07");
		expect(output).not.toContain("Stateless Review line 08");
		expect(output).toContain("… ");
		expect(output).toContain("more lines");
		expect(output).not.toContain("Older one Prompt.");
	});

	test("keeps trail rows visible when a tiny body room cannot fit scroll markers", () => {
		const selected = record({
			id: "selected",
			captured_at: "2026-10-08T14:00:00.000Z",
			review: {
				findings: [],
				rewrite: null,
				tip: Array.from(
					{ length: 13 },
					(_, index) => `Review line ${String(index + 1).padStart(2, "0")}`,
				).join("\n"),
			},
		});
		const trail = [
			record({
				id: "trail-1",
				captured_at: "2026-10-08T13:00:00.000Z",
				text: "Trail row one.",
			}),
			record({
				id: "trail-2",
				captured_at: "2026-10-08T12:00:00.000Z",
				text: "Trail row two.",
			}),
		];
		const output = plain(
			renderFrame({
				config,
				records: [selected, ...trail],
				view: "all",
				selectedId: selected.id,
				scroll: 1,
				width: 50,
				height: 12,
				embedded: true,
				showNavigation: true,
			}),
		);
		expect(output).toContain("Trail row one.");
		expect(output).toContain("Trail row two.");
		expect(output).not.toMatch(/… \d+ lines? above/);
		expect(output).not.toMatch(/… \d+ more lines?/);
	});

	test("renders config errors with their path and explanation", () => {
		const output = plain(
			renderErrorFrame("invalid YAML", "/tmp/config.yml", 80, 24),
		);
		expect(output).toContain("configuration error");
		expect(output).toContain("/tmp/config.yml");
		expect(output).toContain("invalid YAML");
	});
});
