import { type FSWatcher, watch } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig } from "./config.ts";
import { dueDrainerDigests, runDigest } from "./digest/index.ts";
import {
	acquireDrainLock,
	drainLockPath,
	readDrainLock,
	releaseDrainLockSync,
} from "./drain-lock.ts";
import { review } from "./review.ts";
import { listMonths, readMonth, readRecord } from "./store.ts";
import type {
	Grader,
	GraderRequest,
	GraderResponse,
	PromptRecord,
	Scope,
} from "./types.ts";

const DIGEST_CHECK_MS = 60 * 60 * 1000;

function sleep(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		const done = (): void => {
			clearTimeout(timer);
			signal.removeEventListener("abort", done);
			resolve();
		};
		const timer = setTimeout(done, ms);
		signal.addEventListener("abort", done, { once: true });
		if (signal.aborted) done();
	});
}

/** A grader whose pending call rejects as soon as `signal` aborts. */
function abortable(grader: Grader, signal: AbortSignal): Grader {
	return {
		call(request: GraderRequest): Promise<GraderResponse> {
			if (signal.aborted) return Promise.reject(new Error("aborted"));
			return new Promise<GraderResponse>((resolve, reject) => {
				const onAbort = (): void => reject(new Error("aborted"));
				signal.addEventListener("abort", onAbort, { once: true });
				grader
					.call(request)
					.then(resolve, reject)
					.finally(() => {
						signal.removeEventListener("abort", onAbort);
					});
			});
		},
	};
}

/** Queued Claude Code records of one store, oldest first, across all months. */
export async function queuedRecords(store: string): Promise<PromptRecord[]> {
	const queued: PromptRecord[] = [];
	for (const month of await listMonths(store)) {
		for (const record of await readMonth(store, month)) {
			if (record.state === "pending" && record.harness === "claude-code")
				queued.push(record);
		}
	}
	return queued.sort(
		(a, b) =>
			a.captured_at.localeCompare(b.captured_at) || a.id.localeCompare(b.id),
	);
}

export interface DrainOptions {
	/** The omp profile this process runs as; only Scopes whose `reviewProfile` equals it are drained. */
	profile: string;
	grader: Grader;
	/** One line per event; never contains Prompt text. */
	log: (line: string) => void;
	signal: AbortSignal;
	/**
	 * Grader for weekly Digests (`@advisor`). When set, the Drainer also builds the due Digests
	 * of the Scopes its profile may digest (ADR 0007, amended); without it, it builds none.
	 */
	digestGrader?: Grader;
	/** How often to look for a due Digest; the first look is at start. Default one hour. */
	digestCheckMs?: number;
	/** Clock for the Digest week; defaults to the current time. */
	now?: () => Date;
	env?: NodeJS.ProcessEnv;
	/** Poll fallback when no file event arrives. */
	pollMs?: number;
}

interface HeldScope {
	scope: Scope;
	watcher: FSWatcher | null;
}

/**
 * Drains queued Claude Code records of this profile's Scopes until `signal` aborts, and builds
 * the weekly Digests this profile may run. Never throws: errors are logged and the loops continue.
 */
export async function drainQueue(options: DrainOptions): Promise<void> {
	const { profile, grader, log, signal } = options;
	const pollMs = options.pollMs ?? 30_000;
	const held = new Map<string, HeldScope>();
	const reportedHolders = new Map<string, number>();
	let lastConfigError: string | null = null;
	let dirty = false;
	let wake: (() => void) | null = null;
	const releaseAll = (): void => {
		for (const store of held.keys()) releaseDrainLockSync(store);
	};
	const notify = (): void => {
		dirty = true;
		wake?.();
	};
	const release = (store: string): void => {
		held.get(store)?.watcher?.close();
		held.delete(store);
		releaseDrainLockSync(store);
	};
	process.on("exit", releaseAll);

	const lockScopes = async (scopes: Scope[]): Promise<void> => {
		const wanted = new Set(scopes.map((scope) => scope.store));
		for (const [store, entry] of held) {
			const lock = await readDrainLock(store);
			if (!wanted.has(store) || lock?.pid !== process.pid) {
				release(store);
				log(`stopped draining ${entry.scope.name}`);
			}
		}
		for (const scope of scopes) {
			const entry = held.get(scope.store);
			if (entry) {
				entry.scope = scope;
				continue;
			}
			const result = await acquireDrainLock(scope.store, profile);
			if (!result.acquired) {
				if (reportedHolders.get(scope.store) !== result.held.pid)
					log(
						`already draining ${scope.name} (pid ${result.held.pid}, ${drainLockPath(scope.store)})`,
					);
				reportedHolders.set(scope.store, result.held.pid);
				continue;
			}
			reportedHolders.delete(scope.store);
			let watcher: FSWatcher | null = null;
			try {
				const prompts = join(scope.store, "prompts");
				await mkdir(prompts, { recursive: true });
				watcher = watch(prompts, { recursive: true }, notify);
				watcher.on("error", () => undefined);
			} catch (error) {
				log(`cannot watch ${scope.name}, polling instead: ${String(error)}`);
			}
			held.set(scope.store, { scope, watcher });
			log(`draining ${scope.name}`);
		}
	};

	const pass = async (): Promise<void> => {
		const loaded = await loadConfig({ env: options.env });
		if (!loaded.ok) {
			if (loaded.error !== lastConfigError)
				log(`configuration error: ${loaded.error}`);
			lastConfigError = loaded.error;
			return;
		}
		lastConfigError = null;
		const config = loaded.config;
		await lockScopes(
			config.scopes.filter((scope) => scope.reviewProfile === profile),
		);
		for (const [store, { scope }] of held) {
			for (const queued of await queuedRecords(store)) {
				if (signal.aborted) return;
				if ((await readDrainLock(store))?.pid !== process.pid) {
					release(store);
					log(`lost drain lock for ${scope.name}`);
					break;
				}
				// The file may have settled since it was listed; never regrade it.
				const record = await readRecord(scope.store, queued);
				if (record?.state !== "pending" || record.harness !== "claude-code")
					continue;
				try {
					const outcome = await review(
						{ kind: "captured", record, scope, config },
						grader,
					);
					const settled = outcome.record;
					const result =
						settled.state === "failed"
							? "failed"
							: settled.review?.findings.length === 0
								? "clean"
								: "reviewed";
					log(`${scope.name} ${settled.id} ${result}`);
				} catch (error) {
					log(`${scope.name} ${record.id} error: ${String(error)}`);
				}
			}
		}
	};

	// Digests run beside the review loop, never inside it, so a long `@advisor` call cannot
	// hold up the queue. Each check lists due Scopes afresh, so a week that became due
	// after Friday 12:00 is picked up by the next check, and a failed Digest is retried.
	const digestPass = async (digestGrader: Grader): Promise<void> => {
		const loaded = await loadConfig({ env: options.env });
		// The review loop already reports an invalid configuration.
		if (!loaded.ok) return;
		const now = (options.now ?? (() => new Date()))();
		for (const scope of await dueDrainerDigests(
			{ profile, now },
			loaded.config,
		)) {
			if (signal.aborted) return;
			const result = await runDigest(scope, loaded.config, digestGrader, now);
			if (signal.aborted) return;
			switch (result.kind) {
				case "written":
					log(
						`${scope.name} digest ${result.week} written: ${result.htmlPath}`,
					);
					if (result.exportError)
						log(`${scope.name} digest export failed: ${result.exportError}`);
					break;
				case "empty":
					log(`${scope.name} digest ${result.week} empty`);
					break;
				case "current":
					log(`${scope.name} digest ${result.week} already written`);
					break;
				case "locked":
					log(`${scope.name} digest locked by another run`);
					break;
				case "failed":
					log(`${scope.name} digest failed: ${result.error}`);
					break;
			}
		}
	};
	const digestLoop = async (digestGrader: Grader): Promise<void> => {
		const grader = abortable(digestGrader, signal);
		while (!signal.aborted) {
			try {
				await digestPass(grader);
			} catch (error) {
				log(`digest check failed: ${String(error)}`);
			}
			await sleep(options.digestCheckMs ?? DIGEST_CHECK_MS, signal);
		}
	};
	const digests = options.digestGrader
		? digestLoop(options.digestGrader)
		: Promise.resolve();

	try {
		while (!signal.aborted) {
			dirty = false;
			try {
				await pass();
			} catch (error) {
				log(`drain pass failed: ${String(error)}`);
			}
			if (dirty || signal.aborted) continue;
			await new Promise<void>((resolve) => {
				const done = (): void => {
					clearTimeout(timer);
					signal.removeEventListener("abort", done);
					wake = null;
					resolve();
				};
				const timer = setTimeout(done, pollMs);
				wake = done;
				signal.addEventListener("abort", done, { once: true });
			});
		}
	} finally {
		await digests;
		for (const store of [...held.keys()]) release(store);
		process.off("exit", releaseAll);
	}
}
