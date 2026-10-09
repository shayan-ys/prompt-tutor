import { randomBytes } from "node:crypto";
import type { Dirent } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "./fsx.ts";
import { FORMAT_VERSION, type PromptRecord } from "./types.ts";

export type ReadStats = { newerVersion: number };

export function recordPath(
	store: string,
	record: Pick<PromptRecord, "log_month" | "id">,
): string {
	return join(store, "prompts", record.log_month, `${record.id}.json`);
}

export async function writeRecord(
	store: string,
	record: PromptRecord,
): Promise<void> {
	await writeFileAtomic(
		recordPath(store, record),
		`${JSON.stringify(record, null, 2)}\n`,
	);
}

export async function listMonthFiles(
	dir: string,
): Promise<{ name: string; mtimeMs: number }[]> {
	let entries: Dirent[];
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT")
			return [];
		throw error;
	}
	const files: { name: string; mtimeMs: number }[] = [];
	for (const entry of entries) {
		if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
		try {
			const info = await stat(join(dir, entry.name));
			if (info.isFile())
				files.push({ name: entry.name, mtimeMs: info.mtimeMs });
		} catch {
			// A file removed during listing is not part of this snapshot.
		}
	}
	files.sort((a, b) => a.name.localeCompare(b.name));
	return files;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isPromptRecord(value: unknown): value is PromptRecord {
	if (!isObject(value)) return false;
	if (value.version !== FORMAT_VERSION) return false;
	if (
		typeof value.id !== "string" ||
		typeof value.scope !== "string" ||
		typeof value.profile !== "string"
	)
		return false;
	if (
		typeof value.cwd !== "string" ||
		typeof value.captured_at !== "string" ||
		typeof value.text !== "string"
	)
		return false;
	if (
		typeof value.utc_offset_minutes !== "number" ||
		!Number.isFinite(value.utc_offset_minutes)
	)
		return false;
	if (
		typeof value.log_month !== "string" ||
		!/^\d{4}-\d{2}$/u.test(value.log_month)
	)
		return false;
	if (
		typeof value.word_count !== "number" ||
		!Number.isInteger(value.word_count) ||
		value.word_count < 0
	)
		return false;
	if (
		value.state !== "pending" &&
		value.state !== "reviewed" &&
		value.state !== "skipped" &&
		value.state !== "failed"
	)
		return false;
	if (
		value.skip_reason !== undefined &&
		value.skip_reason !== "too_long" &&
		value.skip_reason !== "nothing_to_review"
	)
		return false;
	if (value.state === "skipped" && value.skip_reason === undefined)
		return false;
	if (value.failure !== undefined && typeof value.failure !== "string")
		return false;
	if (value.settled_at !== undefined && typeof value.settled_at !== "string")
		return false;
	if (value.review !== undefined) {
		if (!isObject(value.review) || !Array.isArray(value.review.findings))
			return false;
		if (
			value.review.rewrite !== null &&
			typeof value.review.rewrite !== "string"
		)
			return false;
		if (value.review.tip !== null && typeof value.review.tip !== "string")
			return false;
		for (const finding of value.review.findings) {
			if (!isObject(finding)) return false;
			if (
				typeof finding.quote !== "string" ||
				typeof finding.fix !== "string" ||
				typeof finding.why !== "string" ||
				typeof finding.kind !== "string"
			)
				return false;
			if (
				finding.category !== "spelling" &&
				finding.category !== "grammar" &&
				finding.category !== "fluency"
			)
				return false;
			if (typeof finding.start !== "number" || typeof finding.end !== "number")
				return false;
		}
	}
	if (value.grader !== undefined) {
		if (!isObject(value.grader)) return false;
		if (
			typeof value.grader.model !== "string" ||
			typeof value.grader.requested_reasoning !== "string" ||
			typeof value.grader.prompt_hash !== "string"
		)
			return false;
		if (value.grader.attempts !== 1 && value.grader.attempts !== 2)
			return false;
	}
	return true;
}
export async function readMonth(
	store: string,
	month: string,
	stats?: ReadStats,
): Promise<PromptRecord[]> {
	const files = await listMonthFiles(join(store, "prompts", month));
	const records: PromptRecord[] = [];
	for (const file of files) {
		try {
			const value: unknown = JSON.parse(
				await readFile(join(store, "prompts", month, file.name), "utf8"),
			);
			if (
				isObject(value) &&
				typeof value.version === "number" &&
				value.version > FORMAT_VERSION
			) {
				if (stats) stats.newerVersion++;
				continue;
			}
			if (!isPromptRecord(value)) continue;
			records.push(value);
		} catch {
			// Malformed or unreadable records are isolated to their own file.
		}
	}
	records.sort(
		(a, b) =>
			a.captured_at.localeCompare(b.captured_at) || a.id.localeCompare(b.id),
	);
	return records;
}

export async function listMonths(store: string): Promise<string[]> {
	let entries: Dirent[];
	try {
		entries = await readdir(join(store, "prompts"), { withFileTypes: true });
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT")
			return [];
		throw error;
	}
	return entries
		.filter((entry) => entry.isDirectory() && /^\d{4}-\d{2}$/u.test(entry.name))
		.map((entry) => entry.name)
		.sort();
}

export function newPromptId(now: Date): string {
	const stamp = now
		.toISOString()
		.replace(/[-:]/gu, "")
		.replace(/\.(\d{3})Z$/u, "$1");
	return `${stamp}-${randomBytes(3).toString("hex")}`;
}

export async function readRecentRecords(
	stores: string[],
	limit: number,
	stats?: ReadStats,
): Promise<PromptRecord[]> {
	const records: PromptRecord[] = [];
	for (const store of stores) {
		for (const month of await listMonths(store)) {
			records.push(...(await readMonth(store, month, stats)));
		}
	}
	records.sort(
		(a, b) =>
			b.captured_at.localeCompare(a.captured_at) || b.id.localeCompare(a.id),
	);
	return records.slice(0, Math.max(0, Math.floor(limit)));
}
