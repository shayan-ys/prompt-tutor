import { type FSWatcher, watch } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig } from "../core/config.ts";
import {
	listMonths,
	type ReadStats,
	readMonth,
	readRecentRecords,
} from "../core/store.ts";
import type { Config, ConfigResult, PromptRecord } from "../core/types.ts";
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

	return {
		kind: "ready",
		config: configResult.config,
		records: [...recordsByKey.values()].sort(compareNewest),
		newerVersion: stats.newerVersion,
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
	});
}

/** Render the current configured view once, without opening a TTY or writing to the store. */
export async function renderOnce(width = 80, height = 24): Promise<string> {
	let snapshot: WatcherSnapshot;
	try {
		snapshot = await loadWatcherSnapshot();
	} catch (error) {
		snapshot = { kind: "read_error", error: failureMessage(error) };
	}
	return renderSnapshot(snapshot, "all", null, width, height, Date.now());
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
				if (selectedId !== null && snapshot.kind === "ready") {
					const inView = visibleRecords(snapshot, view);
					if (!inView.some((record) => record.id === selectedId))
						selectedId = null;
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
		if (key === "s") {
			const views = [
				"all",
				...snapshot.config.scopes.map((scope) => scope.name),
			];
			const currentIndex = views.indexOf(view);
			view =
				currentIndex >= views.length - 1 ? "all" : views[currentIndex + 1]!;
			selectedId = null;
			draw();
			return;
		}
		const records = visibleRecords(snapshot, view);
		const selectedIndex =
			selectedId === null
				? 0
				: Math.max(
						0,
						records.findIndex((record) => record.id === selectedId),
					);
		if (key === "k" || key === "\x1b[B") {
			if (selectedIndex + 1 < records.length)
				selectedId = records[selectedIndex + 1]!.id;
		} else if (key === "j" || key === "\x1b[A") {
			if (selectedIndex <= 1) selectedId = null;
			else selectedId = records[selectedIndex - 1]!.id;
		}
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
