import type { PromptRecord, Scope } from "../core/types.ts";

export type WatcherAction =
	| "newer"
	| "older"
	| "scope"
	| "scroll-down"
	| "scroll-up";

export interface WatcherSelection {
	view: string;
	selectedId: string | null;
	scroll: number;
}

/** Keep a selection valid when the configured views or visible Prompts change. */
export function reconcileWatcherSelection(
	selection: WatcherSelection,
	scopes: Scope[],
	records: PromptRecord[],
): WatcherSelection {
	const viewExists =
		selection.view === "all" ||
		scopes.some((scope) => scope.name === selection.view);
	const view = viewExists ? selection.view : "all";
	let selectedId = selection.selectedId;
	if (
		selectedId !== null &&
		!records.some(
			(record) =>
				record.id === selectedId && (view === "all" || record.scope === view),
		)
	)
		selectedId = null;
	return {
		view,
		selectedId,
		scroll:
			view === selection.view && selectedId === selection.selectedId
				? selection.scroll
				: 0,
	};
}

/** Apply the Watcher's key semantics to a view and selection. Records are newest first. */
export function applyWatcherAction(
	selection: WatcherSelection,
	action: WatcherAction,
	scopes: Scope[],
	records: PromptRecord[],
	maxScroll = Number.MAX_SAFE_INTEGER,
): WatcherSelection {
	const current = reconcileWatcherSelection(selection, scopes, records);
	const currentScroll = Math.max(0, Math.min(maxScroll, current.scroll));
	if (action === "scope") {
		const scopeIndex = scopes.findIndex((scope) => scope.name === current.view);
		const nextScope = scopes[scopeIndex + 1];
		return {
			view:
				scopeIndex >= scopes.length - 1 ? "all" : (nextScope?.name ?? "all"),
			selectedId: null,
			scroll: 0,
		};
	}
	if (action === "scroll-down")
		return { ...current, scroll: Math.min(maxScroll, currentScroll + 1) };
	if (action === "scroll-up")
		return { ...current, scroll: Math.max(0, currentScroll - 1) };

	const visible =
		current.view === "all"
			? records
			: records.filter((record) => record.scope === current.view);
	const selectedIndex =
		current.selectedId === null
			? 0
			: visible.findIndex((record) => record.id === current.selectedId);
	if (action === "older") {
		const nextOlder = visible[selectedIndex + 1];
		return nextOlder
			? { ...current, selectedId: nextOlder.id, scroll: 0 }
			: current;
	}
	if (selectedIndex <= 1) return { ...current, selectedId: null, scroll: 0 };
	const nextNewer = visible[selectedIndex - 1];
	return nextNewer
		? { ...current, selectedId: nextNewer.id, scroll: 0 }
		: current;
}
