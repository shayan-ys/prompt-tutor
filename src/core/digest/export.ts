import { mkdir, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { writeFileAtomic } from "../fsx.ts";
import type { Config } from "../types.ts";
import {
	baseCopy,
	parseArchive,
	readHistory,
	renderContext,
} from "./history.ts";
import { noteName, noteSummary, renderDigestMarkdown } from "./markdown.ts";
import { renderDigest } from "./render.ts";
import { digestTargets } from "./targets.ts";

/** Write only changed files, so a synced export directory does not upload identical copies. */
async function writeIfChanged(
	filePath: string,
	content: string,
	written: string[],
): Promise<void> {
	try {
		if ((await readFile(filePath, "utf8")) === content) return;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	await mkdir(path.dirname(filePath), { recursive: true });
	await writeFileAtomic(filePath, content);
	written.push(filePath);
}

async function digestWeeks(store: string): Promise<string[]> {
	try {
		return (await readdir(path.join(store, "digests")))
			.filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/u.test(name))
			.map((name) => name.slice(0, -5))
			.toSorted();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
}

/**
 * Rebuild `config.digestExport` from every stored Digest — each Scope's, or the combined one
 * (ADR 0012): a Markdown note and a re-rendered HTML page per week, each target's latest page,
 * and an `_index.md` table. Files are rebuilt from the archives, never appended to, and nothing
 * is deleted. Returns the paths that changed.
 */
export async function exportDigests(config: Config): Promise<string[]> {
	const root = config.digestExport;
	if (root === null) return [];
	const written: string[] = [];
	const notes: { name: string; summary: string; week: string }[] = [];
	for (const scope of digestTargets(config)) {
		if (!/^[\p{L}\p{N}][\p{L}\p{N} ._-]*$/u.test(scope.name))
			throw new Error(
				`Scope name ${JSON.stringify(scope.name)} cannot be used as an export directory name`,
			);
		let previousNote: string | null = null;
		let latestHtml: string | null = null;
		for (const week of await digestWeeks(scope.store)) {
			const archive = parseArchive(
				JSON.parse(
					await readFile(
						path.join(scope.store, "digests", `${week}.json`),
						"utf8",
					),
				),
				week,
			);
			// An empty week records only that it was checked; it has no page.
			if (archive === null || archive.stats.reviewed === 0) continue;
			const context = renderContext(
				week,
				archive.graderVersions,
				await readHistory(scope.store, week),
			);
			const htmlPath = `${scope.name}/digests/${week}.html`;
			latestHtml = renderDigest(archive, context);
			await writeIfChanged(path.join(root, htmlPath), latestHtml, written);
			const name = noteName(archive);
			await writeIfChanged(
				path.join(root, `${name}.md`),
				renderDigestMarkdown(archive, context, { htmlPath, previousNote }),
				written,
			);
			notes.push({ name, summary: noteSummary(archive), week });
			previousNote = name;
		}
		if (latestHtml !== null)
			await writeIfChanged(
				path.join(root, scope.name, "digest.html"),
				baseCopy(latestHtml),
				written,
			);
	}
	notes.sort((a, b) => a.name.localeCompare(b.name));
	const latestWeek = notes
		.map((note) => note.week)
		.toSorted()
		.at(-1);
	const rows = notes.map(
		(note) =>
			`| [[${note.name}]] | note | seed | ${note.summary.replaceAll("|", "\\|")} |`,
	);
	await writeIfChanged(
		path.join(root, "_index.md"),
		[
			"# Prompt Tutor Digests",
			"",
			`> Auto-maintained by prompt-tutor. Last updated: ${latestWeek ?? "never"}`,
			"",
			"| Note | Type | Status | Summary |",
			"|------|------|--------|---------|",
			...rows,
			"",
		].join("\n"),
		written,
	);
	return written;
}
