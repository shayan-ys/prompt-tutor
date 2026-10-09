import { describe, expect, test } from "bun:test";
import type { PromptRecord, Scope } from "../../src/core/types.ts";
import {
	applyWatcherAction,
	reconcileWatcherSelection,
} from "../../src/watcher/navigation.ts";

const scopes: Scope[] = [
	{
		name: "work",
		index: 0,
		store: "/tmp/work",
		when: [],
		digestProfile: null,
	},
	{
		name: "personal",
		index: 1,
		store: "/tmp/personal",
		when: [],
		digestProfile: null,
	},
];

function record(id: string, scope: string, hour: number): PromptRecord {
	return {
		version: 1,
		id,
		scope,
		profile: "default",
		cwd: "/tmp",
		captured_at: `2026-10-09T${String(hour).padStart(2, "0")}:00:00.000Z`,
		utc_offset_minutes: 0,
		log_month: "2026-10",
		text: `${id} fixture Prompt.`,
		word_count: 3,
		state: "pending",
	};
}

const records = [
	record("newest", "work", 12),
	record("middle", "personal", 11),
	record("oldest", "work", 10),
];

describe("Watcher navigation", () => {
	test("newer returns the top and immediately-older selections to following latest", () => {
		expect(
			applyWatcherAction(
				{ view: "all", selectedId: "newest", scroll: 3 },
				"newer",
				scopes,
				records,
			),
		).toEqual({ view: "all", selectedId: null, scroll: 0 });
		expect(
			applyWatcherAction(
				{ view: "all", selectedId: "middle", scroll: 3 },
				"newer",
				scopes,
				records,
			),
		).toEqual({ view: "all", selectedId: null, scroll: 0 });
	});

	test("older at the end stays on the oldest Prompt", () => {
		expect(
			applyWatcherAction(
				{ view: "all", selectedId: "oldest", scroll: 2 },
				"older",
				scopes,
				records,
			),
		).toEqual({ view: "all", selectedId: "oldest", scroll: 2 });
	});

	test("scroll actions move one line and clamp at both ends", () => {
		const selection = { view: "all", selectedId: "middle", scroll: 1 };
		expect(
			applyWatcherAction(selection, "scroll-down", scopes, records, 2),
		).toEqual({ ...selection, scroll: 2 });
		expect(
			applyWatcherAction(
				{ ...selection, scroll: 2 },
				"scroll-down",
				scopes,
				records,
				2,
			),
		).toEqual({ ...selection, scroll: 2 });
		expect(
			applyWatcherAction(selection, "scroll-up", scopes, records, 2),
		).toEqual({ ...selection, scroll: 0 });
		expect(
			applyWatcherAction(
				{ ...selection, scroll: 0 },
				"scroll-up",
				scopes,
				records,
				2,
			),
		).toEqual({ ...selection, scroll: 0 });
	});
	test("scroll-up clamps a stale scroll before applying the key", () => {
		expect(
			applyWatcherAction(
				{ view: "all", selectedId: "middle", scroll: 5 },
				"scroll-up",
				scopes,
				records,
				2,
			),
		).toEqual({ view: "all", selectedId: "middle", scroll: 1 });
	});

	test("selection and view changes reset scrolling", () => {
		expect(
			applyWatcherAction(
				{ view: "all", selectedId: "middle", scroll: 2 },
				"older",
				scopes,
				records,
			),
		).toEqual({ view: "all", selectedId: "oldest", scroll: 0 });
		expect(
			applyWatcherAction(
				{ view: "all", selectedId: "middle", scroll: 2 },
				"scope",
				scopes,
				records,
			),
		).toEqual({ view: "work", selectedId: null, scroll: 0 });
	});

	test("scope cycles through configured views and resets selection", () => {
		let selection = {
			view: "all",
			selectedId: "oldest" as string | null,
			scroll: 3,
		};
		selection = applyWatcherAction(selection, "scope", scopes, records);
		expect(selection).toEqual({ view: "work", selectedId: null, scroll: 0 });
		selection = applyWatcherAction(
			{ view: selection.view, selectedId: "newest", scroll: 2 },
			"scope",
			scopes,
			records,
		);
		expect(selection).toEqual({
			view: "personal",
			selectedId: null,
			scroll: 0,
		});
		selection = applyWatcherAction(selection, "scope", scopes, records);
		expect(selection).toEqual({ view: "all", selectedId: null, scroll: 0 });
	});

	test("a selection that leaves its view follows latest and resets scrolling", () => {
		expect(
			reconcileWatcherSelection(
				{ view: "work", selectedId: "middle", scroll: 2 },
				scopes,
				records,
			),
		).toEqual({ view: "work", selectedId: null, scroll: 0 });
		expect(
			reconcileWatcherSelection(
				{ view: "retired", selectedId: "oldest", scroll: 2 },
				scopes,
				records,
			),
		).toEqual({ view: "all", selectedId: "oldest", scroll: 0 });
	});
});
