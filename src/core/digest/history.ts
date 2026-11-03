import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { FORMAT_VERSION } from "../types.ts";
import type {
	DigestArchive,
	DigestGraderVersion,
	DigestRenderContext,
} from "./types.ts";

export interface History {
	byWeek: Map<string, DigestArchive>;
	priorDigests: DigestArchive[];
	htmlWeeks: string[];
}

export function previousWeekName(week: string): string {
	const [year, month, day] = week.split("-").map(Number);
	const previous = new Date(Date.UTC(year, month - 1, day - 7));
	return `${previous.getUTCFullYear()}-${String(previous.getUTCMonth() + 1).padStart(2, "0")}-${String(previous.getUTCDate()).padStart(2, "0")}`;
}

/** Validate a parsed `<week>.json` Digest archive; null when it is not one for `expectedWeek`. */
export function parseArchive(
	value: unknown,
	expectedWeek: string,
): DigestArchive | null {
	const root =
		value !== null && typeof value === "object" && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: null;
	if (!root || root.version !== FORMAT_VERSION || root.week !== expectedWeek)
		return null;
	if (
		!Array.isArray(root.patterns) ||
		root.stats === null ||
		typeof root.stats !== "object" ||
		Array.isArray(root.stats) ||
		!Array.isArray(root.graderVersions)
	)
		return null;
	return root as unknown as DigestArchive;
}

/** Read the Digests before `currentWeek` that a new Digest compares against. */
export async function readHistory(
	store: string,
	currentWeek: string,
): Promise<History> {
	const directory = path.join(store, "digests");
	let entries: string[];
	try {
		entries = await readdir(directory);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return { byWeek: new Map(), priorDigests: [], htmlWeeks: [] };
		}
		throw error;
	}
	const jsonWeeks = entries
		.filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/u.test(name))
		.map((name) => name.slice(0, -5))
		.filter((week) => week < currentWeek)
		.toSorted((a, b) => b.localeCompare(a));
	const htmlWeeks = entries
		.filter((name) => /^\d{4}-\d{2}-\d{2}\.html$/u.test(name))
		.map((name) => name.slice(0, -5))
		.toSorted((a, b) => a.localeCompare(b));
	const previousWeek = previousWeekName(currentWeek);
	const toRead = new Set(jsonWeeks.slice(0, 7));
	if (jsonWeeks.includes(previousWeek)) toRead.add(previousWeek);
	const loaded = await Promise.all(
		[...toRead].map(async (week) => {
			try {
				const content = await readFile(
					path.join(directory, `${week}.json`),
					"utf8",
				);
				return [week, parseArchive(JSON.parse(content), week)] as const;
			} catch {
				return [week, null] as const;
			}
		}),
	);
	const byWeek = new Map<string, DigestArchive>();
	for (const [week, digest] of loaded) {
		if (digest) byWeek.set(week, digest);
	}
	const priorDigests = [...byWeek.values()].toSorted((a, b) =>
		b.week.localeCompare(a.week),
	);
	return { byWeek, priorDigests, htmlWeeks };
}

function changedGrader(
	current: DigestGraderVersion[],
	previous: DigestArchive | undefined,
): { from: DigestGraderVersion[]; to: DigestGraderVersion[] } | null {
	if (!previous) return null;
	const versionKey = ({ model, promptHash }: DigestGraderVersion) =>
		`${model}\u0000${promptHash}`;
	const currentKeys = current.map(versionKey).toSorted();
	const previousKeys = previous.graderVersions.map(versionKey).toSorted();
	if (
		currentKeys.length === previousKeys.length &&
		currentKeys.every((key, index) => key === previousKeys[index])
	)
		return null;
	return { from: previous.graderVersions, to: current };
}

/** The comparison and navigation a week's Digest page shows. */
export function renderContext(
	week: string,
	graderVersions: DigestGraderVersion[],
	history: History,
): DigestRenderContext {
	return {
		previousWeek: history.byWeek.get(previousWeekName(week)) ?? null,
		previousArchive:
			history.htmlWeeks
				.filter((candidate) => candidate < week)
				.toSorted()
				.at(-1) ?? null,
		archiveWeeks: [...history.htmlWeeks, week],
		graderChanged: changedGrader(graderVersions, history.priorDigests[0]),
	};
}

/** `<store>/digest.html`: the latest page, with links resolved against `digests/`. */
export function baseCopy(html: string): string {
	return html.replace("<head>", '<head>\n<base href="digests/">');
}
