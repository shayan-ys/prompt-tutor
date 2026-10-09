import type { Dirent } from "node:fs";
import { lstat, readdir, rm, rmdir, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { loadConfig } from "./config.ts";
import { configPath, dataHome } from "./paths.ts";
import type { Config } from "./types.ts";

export interface DeleteDataReport {
	configPath: string;
	paths: string[];
	unknown: string[];
}

interface DeletePlan extends DeleteDataReport {
	recursive: string[];
	files: string[];
	directories: string[];
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await lstat(path);
		return true;
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT")
			return false;
		throw error;
	}
}

async function directoryEntries(path: string): Promise<Dirent[]> {
	try {
		return await readdir(path, { withFileTypes: true });
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT")
			return [];
		throw error;
	}
}

async function planDeletions(
	config: Config,
	configuredPath: string,
	home: string,
): Promise<DeletePlan> {
	const recursive: string[] = [];
	const files: string[] = [];
	const directories: string[] = [];
	const unknown: string[] = [];
	const removalSet = new Set<string>();

	for (const scope of config.scopes) {
		for (const name of ["prompts", "log", "digests"]) {
			const path = join(scope.store, name);
			if (await pathExists(path)) {
				recursive.push(path);
				removalSet.add(path);
			}
		}
		const digestPath = join(scope.store, "digest.html");
		if (await pathExists(digestPath)) {
			files.push(digestPath);
			removalSet.add(digestPath);
		}
		if (await pathExists(scope.store)) {
			const remaining = (await directoryEntries(scope.store)).filter(
				(entry) => !removalSet.has(join(scope.store, entry.name)),
			);
			if (remaining.length === 0) {
				directories.push(scope.store);
				removalSet.add(scope.store);
			} else {
				unknown.push(
					...remaining.map((entry) => join(scope.store, entry.name)),
				);
			}
		}
	}

	if (config.scopes.length > 1) {
		const stubDirectory = join(config.allScopesLog, "r");
		if (await pathExists(stubDirectory)) {
			recursive.push(stubDirectory);
			removalSet.add(stubDirectory);
		}
		const entries = await directoryEntries(config.allScopesLog);
		for (const entry of entries) {
			const path = join(config.allScopesLog, entry.name);
			if (entry.isFile() && entry.name.endsWith(".html")) {
				files.push(path);
				removalSet.add(path);
			}
		}
		const remaining = entries.filter(
			(entry) => !removalSet.has(join(config.allScopesLog, entry.name)),
		);
		if (remaining.length === 0 && (await pathExists(config.allScopesLog))) {
			directories.push(config.allScopesLog);
			removalSet.add(config.allScopesLog);
		} else {
			unknown.push(
				...remaining.map((entry) => join(config.allScopesLog, entry.name)),
			);
		}

		const parent = dirname(config.allScopesLog);
		if (parent !== home && (await pathExists(parent))) {
			const parentEntries = await directoryEntries(parent);
			if (
				parentEntries.every((entry) => removalSet.has(join(parent, entry.name)))
			) {
				directories.push(parent);
				removalSet.add(parent);
			} else {
				unknown.push(
					...parentEntries
						.filter((entry) => !removalSet.has(join(parent, entry.name)))
						.filter((entry) => join(parent, entry.name) !== config.allScopesLog)
						.map((entry) => join(parent, entry.name)),
				);
			}
		}
	}

	if (await pathExists(home)) {
		const homeEntries = await directoryEntries(home);
		const remaining = homeEntries.filter(
			(entry) => !removalSet.has(join(home, entry.name)),
		);
		if (remaining.length === 0) {
			directories.push(home);
			removalSet.add(home);
		} else {
			unknown.push(...remaining.map((entry) => join(home, entry.name)));
		}
	}

	const paths = [...recursive, ...files, ...directories];
	return {
		configPath: configuredPath,
		paths: [...new Set(paths)],
		unknown: [...new Set(unknown)],
		recursive: [...new Set(recursive)],
		files: [...new Set(files)],
		directories: [...new Set(directories)],
	};
}

/** List or remove only prompt-tutor's known data paths from the active config. */
export async function deleteData(
	options: { yes?: boolean; env?: NodeJS.ProcessEnv } = {},
): Promise<DeleteDataReport | { error: string; configPath: string }> {
	const env = options.env ?? process.env;
	const loaded = await loadConfig({ env });
	const configuredPath = loaded.ok
		? (loaded.config.path ?? configPath(env))
		: loaded.path;
	if (!loaded.ok) return { error: loaded.error, configPath: configuredPath };

	const plan = await planDeletions(
		loaded.config,
		configuredPath,
		dataHome(env),
	);
	if (options.yes) {
		for (const path of plan.recursive)
			await rm(path, { recursive: true, force: true });
		for (const path of plan.files) await unlink(path);
		for (const path of plan.directories) await rmdir(path);
	}
	return {
		configPath: plan.configPath,
		paths: plan.paths,
		unknown: plan.unknown,
	};
}
