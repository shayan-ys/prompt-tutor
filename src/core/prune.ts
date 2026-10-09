import { readdir, rm, unlink } from "node:fs/promises";
import { join } from "node:path";
import { rebuildMonth } from "./log/index.ts";
import { listMonthFiles, listMonths } from "./store.ts";
import type { Config } from "./types.ts";

function localMonth(date: Date): string {
	return `${String(date.getFullYear()).padStart(4, "0")}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

async function unlinkIfPresent(path: string): Promise<void> {
	try {
		await unlink(path);
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT")
			return;
		throw error;
	}
}

async function pruneMonth(config: Config, month: string): Promise<void> {
	for (const scope of config.scopes) {
		const promptsDirectory = join(scope.store, "prompts", month);
		const recordFiles = await listMonthFiles(promptsDirectory);
		for (const { name } of recordFiles) {
			const stub = `${name.slice(0, -".json".length)}.html`;
			await unlinkIfPresent(join(scope.store, "log", "r", stub));
			if (config.scopes.length > 1)
				await unlinkIfPresent(join(config.allScopesLog, "r", stub));
		}
		await unlinkIfPresent(join(scope.store, "log", `${month}.html`));
	}

	for (const scope of config.scopes)
		await rm(join(scope.store, "prompts", month), {
			recursive: true,
			force: true,
		});

	if (
		config.scopes.length > 1 &&
		!(
			await Promise.all(config.scopes.map((scope) => listMonths(scope.store)))
		).some((months) => months.includes(month))
	)
		await unlinkIfPresent(join(config.allScopesLog, `${month}.html`));
}

/** Remove expired Review log months and repair the oldest retained month pages. */
export async function pruneExpiredMonths(
	config: Config,
	now: Date,
): Promise<string[]> {
	if (config.keepMonths === null) return [];
	const firstKept = localMonth(
		new Date(now.getFullYear(), now.getMonth() - (config.keepMonths - 1), 1),
	);
	const monthsByScope = await Promise.all(
		config.scopes.map((scope) => listMonths(scope.store)),
	);
	const expiredMonths = new Set(
		monthsByScope.flat().filter((month) => month < firstKept),
	);

	if (config.scopes.length > 1) {
		try {
			const entries = await readdir(config.allScopesLog, {
				withFileTypes: true,
			});
			for (const entry of entries) {
				const match = /^(\d{4}-\d{2})\.html$/u.exec(entry.name);
				if (
					entry.isFile() &&
					match?.[1] !== undefined &&
					match[1] < firstKept &&
					!monthsByScope.some((months) => months.includes(match[1]!))
				)
					expiredMonths.add(match[1]);
			}
		} catch (error) {
			if (
				!(error instanceof Error && "code" in error && error.code === "ENOENT")
			)
				throw error;
		}
	}

	const orderedExpired = [...expiredMonths].toSorted();
	for (const month of orderedExpired) await pruneMonth(config, month);

	for (const scope of config.scopes) {
		const oldest = (await listMonths(scope.store))[0];
		if (oldest !== undefined) await rebuildMonth(config, scope, oldest);
	}
	return orderedExpired;
}
