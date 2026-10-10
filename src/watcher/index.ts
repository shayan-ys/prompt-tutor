import { randomUUID } from "node:crypto";
import { type FSWatcher, watch } from "node:fs";
import {
	open,
	readdir,
	readFile,
	rename,
	stat,
	unlink,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { loadConfig } from "../core/config.ts";
import { liveDrainLock } from "../core/drain-lock.ts";
import {
	listMonths,
	type ReadStats,
	readMonth,
	readRecentRecords,
} from "../core/store.ts";
import type { Config, ConfigResult, PromptRecord } from "../core/types.ts";
import {
	applyWatcherAction,
	reconcileWatcherSelection,
	type WatcherAction,
	type WatcherSelection,
} from "./navigation.ts";
import { renderErrorFrame, renderFrame } from "./render.ts";

const RECENT_LIMIT = 100;
const POLL_INTERVAL_MS = 2_000;
const SPINNER_INTERVAL_MS = 125;
const WATCH_DEBOUNCE_MS = 80;

export type WatcherView = "all" | string;

export type WatcherSnapshot =
	| { kind: "config_error"; error: string; path: string }
	| {
			kind: "ready";
			config: Config;
			records: PromptRecord[];
			newerVersion: number;
			/** Stores whose drain lock is held by a live process, read with the records. */
			liveDrainStores: ReadonlySet<string>;
	  }
	| { kind: "read_error"; error: string };

function failureMessage(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}

function compareNewest(left: PromptRecord, right: PromptRecord): number {
	return (
		right.captured_at.localeCompare(left.captured_at) ||
		right.id.localeCompare(left.id)
	);
}

function configKey(result: ConfigResult): string {
	if (result.ok) return JSON.stringify(result.config);
	return JSON.stringify({ path: result.path, error: result.error });
}

function recordKey(record: PromptRecord): string {
	return `${record.scope}\u0000${record.id}`;
}

/** Stores with a pending Claude Code Prompt and a live drain lock; one lock read per store, not per record. */
async function loadLiveDrainStores(
	config: Config,
	records: PromptRecord[],
): Promise<Set<string>> {
	const scopeNames = new Set(
		records
			.filter(
				(record) =>
					record.state === "pending" && record.harness === "claude-code",
			)
			.map((record) => record.scope),
	);
	const stores = new Set(
		config.scopes
			.filter((scope) => scopeNames.has(scope.name))
			.map((scope) => scope.store),
	);
	const live = await Promise.all(
		[...stores].map(async (store) =>
			(await liveDrainLock(store)) === null ? null : store,
		),
	);
	return new Set(live.filter((store) => store !== null));
}

/** Read all months so j/k can navigate older Prompts, with the recent read covering concurrent month creation. */
export async function loadWatcherSnapshot(): Promise<WatcherSnapshot> {
	const configResult = await loadConfig();
	if (!configResult.ok)
		return {
			kind: "config_error",
			error: configResult.error,
			path: configResult.path,
		};

	const stores = [
		...new Set(configResult.config.scopes.map((scope) => scope.store)),
	];
	const stats: ReadStats = { newerVersion: 0 };
	const recent = await readRecentRecords(stores, RECENT_LIMIT, stats);
	const monthsByStore = new Map<string, Set<string>>();
	for (const store of stores)
		monthsByStore.set(store, new Set(await listMonths(store)));
	for (const record of recent) {
		const scope = configResult.config.scopes.find(
			(candidate) => candidate.name === record.scope,
		);
		if (!scope) continue;
		const months = monthsByStore.get(scope.store);
		if (months) months.add(record.log_month);
	}

	const monthlyRecords = await Promise.all(
		[...monthsByStore].flatMap(([store, months]) =>
			[...months].map((month) => readMonth(store, month, stats)),
		),
	);
	const recordsByKey = new Map<string, PromptRecord>();
	for (const record of recent) recordsByKey.set(recordKey(record), record);
	for (const monthRecords of monthlyRecords) {
		for (const record of monthRecords)
			recordsByKey.set(recordKey(record), record);
	}

	const records = [...recordsByKey.values()].sort(compareNewest);
	return {
		kind: "ready",
		config: configResult.config,
		records,
		newerVersion: stats.newerVersion,
		liveDrainStores: await loadLiveDrainStores(configResult.config, records),
	};
}

function renderSnapshot(
	snapshot: WatcherSnapshot,
	view: WatcherView,
	selectedId: string | null,
	width: number,
	height: number,
	now: number,
): string {
	if (snapshot.kind === "config_error")
		return renderErrorFrame(snapshot.error, snapshot.path, width, height);
	if (snapshot.kind === "read_error")
		return renderErrorFrame(
			snapshot.error,
			"Watcher could not read the prompt store",
			width,
			height,
		);
	return renderFrame({
		config: snapshot.config,
		records: snapshot.records,
		view,
		selectedId,
		width,
		height,
		now,
		newerVersion: snapshot.newerVersion,
		liveDrainStores: snapshot.liveDrainStores,
	});
}

export type OnceResult =
	| { ok: true; frame: string }
	| { ok: false; error: string };

function defaultSelection(): WatcherSelection {
	return { view: "all", selectedId: null };
}

function parseDashboardState(
	contents: string,
	snapshot: Extract<WatcherSnapshot, { kind: "ready" }>,
): WatcherSelection {
	try {
		const value: unknown = JSON.parse(contents);
		if (!value || typeof value !== "object" || Array.isArray(value))
			return defaultSelection();
		const state = value as {
			version?: unknown;
			view?: unknown;
			selected?: unknown;
		};
		if (
			state.version !== 1 ||
			typeof state.view !== "string" ||
			(state.selected !== null && typeof state.selected !== "string")
		)
			return defaultSelection();
		return reconcileWatcherSelection(
			{ view: state.view, selectedId: state.selected },
			snapshot.config.scopes,
			snapshot.records,
		);
	} catch {
		return defaultSelection();
	}
}

async function readDashboardState(
	path: string,
	snapshot: Extract<WatcherSnapshot, { kind: "ready" }>,
): Promise<WatcherSelection> {
	try {
		return parseDashboardState(await readFile(path, "utf8"), snapshot);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT")
			return defaultSelection();
		throw error;
	}
}

async function writeDashboardState(
	path: string,
	selection: WatcherSelection,
): Promise<void> {
	const temporary = join(
		dirname(path),
		`.${basename(path)}.${process.pid}.${randomUUID()}.tmp`,
	);
	let temporaryCreated = false;
	try {
		const handle = await open(temporary, "wx", 0o600);
		temporaryCreated = true;
		try {
			await handle.writeFile(
				`${JSON.stringify({
					version: 1,
					view: selection.view,
					selected: selection.selectedId,
				})}\n`,
				"utf8",
			);
		} finally {
			await handle.close();
		}
		await rename(temporary, path);
		temporaryCreated = false;
	} finally {
		if (temporaryCreated) {
			await unlink(temporary).catch((error: unknown) => {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			});
		}
	}
}

/**
 * Render one frame for a host such as devdash. The frame is as tall as its content because the host scrolls it.
 * Dashboard state is separate from the read-only Prompt store.
 * A config or store read failure is returned as a one-line error so the host can keep its last good frame.
 */
export async function renderOnce(width = 80): Promise<OnceResult> {
	let snapshot: WatcherSnapshot;
	try {
		snapshot = await loadWatcherSnapshot();
	} catch (error) {
		snapshot = { kind: "read_error", error: failureMessage(error) };
	}
	const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();
	if (snapshot.kind === "config_error")
		return {
			ok: false,
			error: oneLine(
				`configuration error in ${snapshot.path}: ${snapshot.error}`,
			),
		};
	if (snapshot.kind === "read_error")
		return {
			ok: false,
			error: oneLine(`could not read the prompt store: ${snapshot.error}`),
		};

	const statePath = process.env.DEVDASH_STATE_FILE || undefined;
	let selection = defaultSelection();
	if (statePath !== undefined) {
		try {
			selection = await readDashboardState(statePath, snapshot);
		} catch (error) {
			return {
				ok: false,
				error: oneLine(
					`could not read DEVDASH_STATE_FILE: ${failureMessage(error)}`,
				),
			};
		}
	}

	if (statePath !== undefined) {
		const actionValue = process.env.DEVDASH_ACTION;
		let action: WatcherAction | undefined;
		if (actionValue !== undefined) {
			if (
				actionValue !== "newer" &&
				actionValue !== "older" &&
				actionValue !== "scope"
			)
				return {
					ok: false,
					error: `unknown DEVDASH_ACTION: ${JSON.stringify(actionValue)}`,
				};
			action = actionValue;
		}
		if (action)
			selection = applyWatcherAction(
				selection,
				action,
				snapshot.config.scopes,
				snapshot.records,
			);
	}

	const frame = renderFrame({
		config: snapshot.config,
		records: snapshot.records,
		view: selection.view,
		selectedId: selection.selectedId,
		width,
		now: Date.now(),
		newerVersion: snapshot.newerVersion,
		liveDrainStores: snapshot.liveDrainStores,
		embedded: true,
		showNavigation: statePath !== undefined,
	});
	if (statePath !== undefined) {
		try {
			await writeDashboardState(statePath, selection);
		} catch (error) {
			return {
				ok: false,
				error: oneLine(
					`could not write DEVDASH_STATE_FILE: ${failureMessage(error)}`,
				),
			};
		}
	}
	return { ok: true, frame };
}

function visibleRecords(
	snapshot: WatcherSnapshot,
	view: WatcherView,
): PromptRecord[] {
	if (snapshot.kind !== "ready") return [];
	if (view === "all") return snapshot.records;
	return snapshot.records.filter((record) => record.scope === view);
}

async function promptsDirectorySignature(config: Config): Promise<string> {
	const scopes = [...config.scopes].sort((left, right) =>
		left.store.localeCompare(right.store),
	);
	const signatures: string[] = [];
	for (const scope of scopes) {
		const prompts = join(scope.store, "prompts");
		try {
			const entries = await readdir(prompts, { withFileTypes: true });
			const months = entries
				.filter((entry) => entry.isDirectory())
				.map((entry) => entry.name)
				.sort();
			const monthStats = await Promise.all(
				months.map(async (month) => {
					try {
						const info = await stat(join(prompts, month));
						return `${month}:${info.mtimeMs}:${info.size}`;
					} catch (error) {
						return `${month}:error:${failureMessage(error)}`;
					}
				}),
			);
			signatures.push(`${scope.store}:${monthStats.join(",")}`);
		} catch (error) {
			signatures.push(`${scope.store}:error:${failureMessage(error)}`);
		}
	}
	return signatures.join("\n");
}

function isPendingInView(
	snapshot: WatcherSnapshot,
	view: WatcherView,
	selectedId: string | null,
): boolean {
	const records = visibleRecords(snapshot, view);
	const selected =
		selectedId === null
			? records[0]
			: records.find((record) => record.id === selectedId);
	return selected?.state === "pending";
}

/** Run the terminal Watcher until q or Ctrl-C; filesystem notifications are backed by a light directory poll. */
export async function startWatcher(): Promise<void> {
	if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== "function") {
		throw new Error("The Watcher needs a TTY; use --once to render one frame.");
	}

	let snapshot: WatcherSnapshot = {
		kind: "read_error",
		error: "Loading prompt-tutor…",
	};
	let view: WatcherView = "all";
	let selectedId: string | null = null;
	let currentConfigKey = "";
	let currentDirectorySignature = "";
	let isRefreshing = false;
	let refreshAgain = false;
	let stopped = false;
	let debounceTimer: ReturnType<typeof setTimeout> | undefined;
	const watchers: FSWatcher[] = [];

	const draw = () => {
		if (stopped) return;
		const columns = process.stdout.columns ?? 80;
		const rows = process.stdout.rows ?? 24;
		process.stdout.write(
			`\x1b[H\x1b[2J${renderSnapshot(snapshot, view, selectedId, columns, rows, Date.now())}`,
		);
	};

	const closeWatchers = () => {
		for (const watcher of watchers.splice(0)) watcher.close();
	};

	const installWatchers = (config: Config) => {
		closeWatchers();
		const promptsDirs = [
			...new Set(config.scopes.map((scope) => join(scope.store, "prompts"))),
		];
		for (const directory of promptsDirs) {
			try {
				watchers.push(
					watch(directory, { recursive: true }, () => scheduleRefresh()),
				);
			} catch {
				// The directory may not exist until the first Prompt; the poll detects its creation.
			}
		}
	};

	const refresh = async () => {
		if (isRefreshing) {
			refreshAgain = true;
			return;
		}
		isRefreshing = true;
		try {
			do {
				refreshAgain = false;
				try {
					snapshot = await loadWatcherSnapshot();
				} catch (error) {
					snapshot = { kind: "read_error", error: failureMessage(error) };
				}
				if (snapshot.kind === "ready") {
					currentConfigKey = JSON.stringify(snapshot.config);
					installWatchers(snapshot.config);
					currentDirectorySignature = await promptsDirectorySignature(
						snapshot.config,
					);
				} else {
					currentConfigKey =
						snapshot.kind === "config_error"
							? JSON.stringify({ error: snapshot.error, path: snapshot.path })
							: `read-error:${snapshot.error}`;
					closeWatchers();
					currentDirectorySignature = "";
				}
				if (snapshot.kind === "ready") {
					const selection = reconcileWatcherSelection(
						{ view, selectedId },
						snapshot.config.scopes,
						snapshot.records,
					);
					view = selection.view;
					selectedId = selection.selectedId;
				}
				draw();
			} while (refreshAgain && !stopped);
		} finally {
			isRefreshing = false;
		}
	};

	const scheduleRefresh = () => {
		if (stopped) return;
		clearTimeout(debounceTimer);
		debounceTimer = setTimeout(() => {
			debounceTimer = undefined;
			void refresh();
		}, WATCH_DEBOUNCE_MS);
	};

	const poll = async () => {
		if (stopped) return;
		try {
			const configResult = await loadConfig();
			const nextConfigKey = configKey(configResult);
			if (nextConfigKey !== currentConfigKey) {
				await refresh();
				return;
			}
			if (configResult.ok) {
				const nextSignature = await promptsDirectorySignature(
					configResult.config,
				);
				if (nextSignature !== currentDirectorySignature) {
					await refresh();
					return;
				}
			}
			if (snapshot.kind === "ready") {
				const captured = snapshot;
				const live = await loadLiveDrainStores(
					captured.config,
					captured.records,
				);
				const known = captured.liveDrainStores;
				if (
					snapshot === captured &&
					(live.size !== known.size || [...live].some((s) => !known.has(s)))
				) {
					snapshot = { ...captured, liveDrainStores: live };
					draw();
					return;
				}
			}
			if (isPendingInView(snapshot, view, selectedId)) draw();
		} catch {
			// The next poll or a filesystem notification retries transient read errors.
		}
	};

	let resolveDone: (() => void) | undefined;
	const done = new Promise<void>((resolve) => {
		resolveDone = resolve;
	});
	const quit = () => {
		if (stopped) return;
		stopped = true;
		resolveDone?.();
	};
	const onData = (input: Buffer) => {
		const key = input.toString();
		if (key === "q" || key === "\x03") {
			quit();
			return;
		}
		if (snapshot.kind !== "ready") return;
		let action: WatcherAction;
		if (key === "s") action = "scope";
		else if (key === "k" || key === "\x1b[B") action = "older";
		else if (key === "j" || key === "\x1b[A") action = "newer";
		else return;
		const selection = applyWatcherAction(
			{ view, selectedId },
			action,
			snapshot.config.scopes,
			snapshot.records,
		);
		view = selection.view;
		selectedId = selection.selectedId;
		draw();
	};
	const onResize = () => draw();

	process.stdin.setRawMode(true);
	process.stdin.resume();
	process.stdin.on("data", onData);
	process.stdout.on("resize", onResize);
	process.on("SIGINT", quit);
	process.stdout.write("\x1b[?1049h\x1b[?25l");
	const pollTimer = setInterval(() => void poll(), POLL_INTERVAL_MS);
	const spinnerTimer = setInterval(() => {
		if (!stopped && isPendingInView(snapshot, view, selectedId)) draw();
	}, SPINNER_INTERVAL_MS);

	try {
		await refresh();
		await done;
	} finally {
		stopped = true;
		clearInterval(pollTimer);
		clearInterval(spinnerTimer);
		clearTimeout(debounceTimer);
		closeWatchers();
		process.stdin.off("data", onData);
		process.stdout.off("resize", onResize);
		process.off("SIGINT", quit);
		process.stdin.setRawMode(false);
		process.stdin.pause();
		process.stdout.write("\x1b[?25h\x1b[?1049l");
	}
}
