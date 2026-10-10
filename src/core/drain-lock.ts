import { randomUUID } from "node:crypto";
import { readFileSync, unlinkSync } from "node:fs";
import {
	link,
	mkdir,
	readFile,
	rename,
	unlink,
	writeFile,
} from "node:fs/promises";
import { join } from "node:path";

/** `<store>/drain.lock`: the one drainer allowed to grade this Scope's Claude Code records. */
export interface DrainLock {
	pid: number;
	profile: string;
	started_at: string;
}

export function drainLockPath(store: string): string {
	return join(store, "drain.lock");
}

function parseDrainLock(text: string): DrainLock | null {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return null;
	}
	if (typeof value !== "object" || value === null) return null;
	const { pid, profile, started_at } = value as Partial<
		Record<keyof DrainLock, unknown>
	>;
	if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0)
		return null;
	if (typeof profile !== "string" || typeof started_at !== "string")
		return null;
	return { pid, profile, started_at };
}

export async function readDrainLock(store: string): Promise<DrainLock | null> {
	try {
		return parseDrainLock(await readFile(drainLockPath(store), "utf8"));
	} catch {
		return null;
	}
}

function isCode(error: unknown, code: string): boolean {
	return error instanceof Error && "code" in error && error.code === code;
}

/** `process.kill(pid, 0)` succeeds, or fails with `EPERM` (alive under another user). */
function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return isCode(error, "EPERM");
	}
}

/** The lock, only while its PID is alive. */
export async function liveDrainLock(store: string): Promise<DrainLock | null> {
	const lock = await readDrainLock(store);
	return lock && pidAlive(lock.pid) ? lock : null;
}

/**
 * Publishes a complete lock file atomically: write a private temp file, then hard-link it into place.
 * False when a lock file already exists.
 */
async function linkDrainLock(store: string, text: string): Promise<boolean> {
	const temporary = join(
		store,
		`.drain.lock.${process.pid}.${randomUUID()}.tmp`,
	);
	await writeFile(temporary, text, {
		encoding: "utf8",
		mode: 0o600,
		flag: "wx",
	});
	try {
		await link(temporary, drainLockPath(store));
		return true;
	} catch (error) {
		if (isCode(error, "EEXIST")) return false;
		throw error;
	} finally {
		await unlink(temporary).catch(() => undefined);
	}
}

async function readLockText(path: string): Promise<string | null> {
	try {
		return await readFile(path, "utf8");
	} catch (error) {
		if (isCode(error, "ENOENT")) return null;
		throw error;
	}
}

export async function acquireDrainLock(
	store: string,
	profile: string,
): Promise<{ acquired: true } | { acquired: false; held: DrainLock }> {
	const path = drainLockPath(store);
	const lock: DrainLock = {
		pid: process.pid,
		profile,
		started_at: new Date().toISOString(),
	};
	const text = `${JSON.stringify(lock)}\n`;
	await mkdir(store, { recursive: true });
	for (let attempt = 0; attempt < 3; attempt++) {
		if (await linkDrainLock(store, text)) {
			// Confirm: a racing stale takeover could have moved ours aside.
			const current = await readLockText(path);
			if (current === text) return { acquired: true };
			const held = current === null ? null : parseDrainLock(current);
			if (held) return { acquired: false, held };
			continue;
		}
		const existing = await readLockText(path);
		if (existing === null) continue;
		const held = parseDrainLock(existing);
		if (held && pidAlive(held.pid)) return { acquired: false, held };
		// Stale or malformed: move it aside, and discard it only if it is still what we judged stale.
		const aside = `${path}.stale-${process.pid}-${randomUUID()}`;
		try {
			await rename(path, aside);
		} catch (error) {
			if (isCode(error, "ENOENT")) continue;
			throw error;
		}
		const moved = await readLockText(aside);
		if (moved === existing || moved === null) {
			await unlink(aside).catch(() => undefined);
			continue;
		}
		// We moved a lock another drainer just published: put it back unless a lock exists again.
		await link(aside, path).catch(() => undefined);
		await unlink(aside).catch(() => undefined);
		const fresh = parseDrainLock(moved);
		if (fresh) return { acquired: false, held: fresh };
	}
	const held = await readDrainLock(store);
	if (held) return { acquired: false, held };
	throw new Error(`cannot acquire ${path}`);
}

/**
 * Removes the lock only if `pid` (default: this process) holds it; safe inside `process.on("exit")`.
 * `prompt-tutor drain` passes a child's pid after it exits, because omp can exit on a signal without
 * running exit handlers.
 */
export function releaseDrainLockSync(store: string, pid = process.pid): void {
	const path = drainLockPath(store);
	try {
		if (parseDrainLock(readFileSync(path, "utf8"))?.pid !== pid) return;
		unlinkSync(path);
	} catch {
		// Missing or already removed.
	}
}
