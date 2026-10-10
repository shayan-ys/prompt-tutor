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
		reviewProfile: null,
	},
	{
		name: "personal",
		index: 1,
		store: "/tmp/personal",
		when: [],
		digestProfile: null,
		reviewProfile: null,
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
				{ view: "all", selectedId: "newest" },
				"newer",
				scopes,
				records,
			),
		).toEqual({ view: "all", selectedId: null });
		expect(
			applyWatcherAction(
				{ view: "all", selectedId: "middle" },
				"newer",
				scopes,
				records,
			),
		).toEqual({ view: "all", selectedId: null });
	});

	test("older at the end stays on the oldest Prompt", () => {
		expect(
			applyWatcherAction(
				{ view: "all", selectedId: "oldest" },
				"older",
				scopes,
				records,
			),
		).toEqual({ view: "all", selectedId: "oldest" });
	});

	test("scope cycles through configured views and resets selection", () => {
		let selection = {
			view: "all",
			selectedId: "oldest" as string | null,
		};
		selection = applyWatcherAction(selection, "scope", scopes, records);
		expect(selection).toEqual({ view: "work", selectedId: null });
		selection = applyWatcherAction(
			{ view: selection.view, selectedId: "newest" },
			"scope",
			scopes,
			records,
		);
		expect(selection).toEqual({ view: "personal", selectedId: null });
		selection = applyWatcherAction(selection, "scope", scopes, records);
		expect(selection).toEqual({ view: "all", selectedId: null });
	});

	test("a selection that leaves its view follows latest", () => {
		expect(
			reconcileWatcherSelection(
				{ view: "work", selectedId: "middle" },
				scopes,
				records,
			),
		).toEqual({ view: "work", selectedId: null });
		expect(
			reconcileWatcherSelection(
				{ view: "retired", selectedId: "oldest" },
				scopes,
				records,
			),
		).toEqual({ view: "all", selectedId: "oldest" });
	});
});
