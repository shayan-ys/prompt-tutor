import { realpathSync, type Stats } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { absoluteExpandedPath, configPath, dataHome } from "./paths.ts";
import type { Condition, Config, ConfigResult, Scope } from "./types.ts";

type Env = NodeJS.ProcessEnv;
type CacheEntry = {
	mtimeMs: number | null;
	size: number | null;
	result: ConfigResult;
};

const configCache = new Map<string, CacheEntry>();

function isObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Resolve symlinks in a glob's literal leading directories, so it compares with a realpath cwd. */
function realpathGlobPrefix(pattern: string): string {
	const parts = pattern.split("/");
	const firstGlob = parts.findIndex((part) => /[*?[{]/u.test(part));
	const literalCount = firstGlob === -1 ? parts.length : firstGlob;
	for (let count = literalCount; count > 1; count -= 1) {
		try {
			const real = realpathSync(parts.slice(0, count).join("/"));
			return [real, ...parts.slice(count)].join("/");
		} catch {
			// Try a shorter prefix; a path that doesn't exist yet is matched as written.
		}
	}
	return pattern;
}

function configError(message: string, path: string): ConfigResult {
	return { ok: false, error: message, path };
}

function isWithin(directory: string, path: string): boolean {
	const base = resolve(directory);
	const candidate = resolve(path);
	const subpath = relative(base, candidate);
	return (
		subpath === "" ||
		(subpath !== ".." &&
			!subpath.startsWith(`..${sep}`) &&
			!isAbsolute(subpath))
	);
}

function defaultConfig(env: Env): Config {
	const base = dataHome(env);
	return {
		scopes: [
			{
				name: "default",
				index: 0,
				store: resolve(base, "default"),
				when: [],
				digestProfile: null,
			},
		],
		allScopesLog: resolve(base, "all", "log"),
		keepMonths: null,
		explanationLanguage: "English",
		path: null,
	};
}

export function parseConfig(
	yamlText: string,
	path: string,
	env: Env = process.env,
): ConfigResult {
	const sourcePath = resolve(path);
	let parsed: unknown;
	try {
		parsed = Bun.YAML.parse(yamlText);
	} catch (error) {
		return configError(
			`invalid YAML: ${error instanceof Error ? error.message : String(error)}`,
			sourcePath,
		);
	}
	if (!isObject(parsed))
		return configError("config must be a YAML object", sourcePath);
	for (const key of Object.keys(parsed)) {
		if (
			key !== "scopes" &&
			key !== "all_scopes_log" &&
			key !== "keep_months" &&
			key !== "explanation_language"
		) {
			return configError(`unknown config key: ${key}`, sourcePath);
		}
	}
	let keepMonths: number | null = null;
	if (parsed.keep_months !== undefined && parsed.keep_months !== null) {
		if (
			typeof parsed.keep_months !== "number" ||
			!Number.isInteger(parsed.keep_months) ||
			parsed.keep_months < 2
		) {
			return configError(
				"keep_months must be an integer of at least 2 or null",
				sourcePath,
			);
		}
		keepMonths = parsed.keep_months;
	}
	let explanationLanguage = "English";
	if (parsed.explanation_language !== undefined) {
		if (
			typeof parsed.explanation_language !== "string" ||
			Array.from(parsed.explanation_language).length > 40 ||
			!/^\p{L}[\p{L} ()'-]*$/u.test(parsed.explanation_language)
		) {
			return configError(
				"explanation_language must be 1–40 letters, spaces, parentheses, apostrophes, or hyphens, starting with a letter",
				sourcePath,
			);
		}
		explanationLanguage = parsed.explanation_language;
	}
	if (!Array.isArray(parsed.scopes) || parsed.scopes.length === 0) {
		return configError("scopes must be a non-empty list", sourcePath);
	}

	const base = dataHome(env);
	const configDirectory = dirname(sourcePath);
	const names = new Set<string>();
	const scopes: Scope[] = [];
	for (const [index, value] of parsed.scopes.entries()) {
		if (!isObject(value))
			return configError(`scopes[${index}] must be an object`, sourcePath);
		for (const key of Object.keys(value)) {
			if (!["name", "when", "store", "digest_profile"].includes(key)) {
				return configError(
					`unknown key in scopes[${index}]: ${key}`,
					sourcePath,
				);
			}
		}
		if (typeof value.name !== "string" || value.name.trim().length === 0) {
			return configError(
				`scopes[${index}].name must be a non-empty string`,
				sourcePath,
			);
		}
		const name = value.name.trim();
		if (name === "all")
			return configError('scope name "all" is reserved', sourcePath);
		if (names.has(name))
			return configError(`duplicate scope name: ${name}`, sourcePath);
		names.add(name);

		let when: Condition[] = [];
		if (value.when !== undefined) {
			if (!Array.isArray(value.when))
				return configError(`scopes[${index}].when must be a list`, sourcePath);
			when = [];
			for (const [conditionIndex, conditionValue] of value.when.entries()) {
				if (!isObject(conditionValue)) {
					return configError(
						`scopes[${index}].when[${conditionIndex}] must be an object`,
						sourcePath,
					);
				}
				for (const key of Object.keys(conditionValue)) {
					if (key !== "profile" && key !== "cwd") {
						return configError(`unknown condition key: ${key}`, sourcePath);
					}
				}
				const condition: Condition = {};
				if (Object.hasOwn(conditionValue, "profile")) {
					if (
						typeof conditionValue.profile !== "string" ||
						conditionValue.profile.trim().length === 0
					) {
						return configError(
							`scopes[${index}].when[${conditionIndex}].profile must be a non-empty string`,
							sourcePath,
						);
					}
					condition.profile = conditionValue.profile;
				}
				if (Object.hasOwn(conditionValue, "cwd")) {
					if (
						typeof conditionValue.cwd !== "string" ||
						conditionValue.cwd.trim().length === 0
					) {
						return configError(
							`scopes[${index}].when[${conditionIndex}].cwd must be a non-empty string`,
							sourcePath,
						);
					}
					condition.cwd = realpathGlobPrefix(
						absoluteExpandedPath(conditionValue.cwd, env, configDirectory),
					);
					try {
						new Bun.Glob(condition.cwd);
					} catch (error) {
						return configError(
							`invalid cwd glob in scopes[${index}]: ${error instanceof Error ? error.message : String(error)}`,
							sourcePath,
						);
					}
				}
				if (condition.profile === undefined && condition.cwd === undefined) {
					return configError(
						`scopes[${index}].when[${conditionIndex}] must contain profile or cwd`,
						sourcePath,
					);
				}
				when.push(condition);
			}
		}

		let store = resolve(base, name);
		if (value.store !== undefined) {
			if (typeof value.store !== "string" || value.store.trim().length === 0) {
				return configError(
					`scopes[${index}].store must be a non-empty string`,
					sourcePath,
				);
			}
			store = absoluteExpandedPath(value.store, env, configDirectory);
		}

		let digestProfile: string | null;
		if (Object.hasOwn(value, "digest_profile")) {
			if (
				value.digest_profile !== null &&
				(typeof value.digest_profile !== "string" ||
					value.digest_profile.trim().length === 0)
			) {
				return configError(
					`scopes[${index}].digest_profile must be a non-empty string or null`,
					sourcePath,
				);
			}
			digestProfile =
				typeof value.digest_profile === "string" ? value.digest_profile : null;
		} else {
			const profiles = when.filter(
				(condition) => condition.profile !== undefined,
			);
			digestProfile = profiles.length === 1 ? profiles[0].profile! : null;
		}
		scopes.push({ name, index, store, when, digestProfile });
	}

	let allScopesLog = resolve(base, "all", "log");
	if (parsed.all_scopes_log !== undefined) {
		if (
			typeof parsed.all_scopes_log !== "string" ||
			parsed.all_scopes_log.trim().length === 0
		) {
			return configError(
				"all_scopes_log must be a non-empty string",
				sourcePath,
			);
		}
		allScopesLog = absoluteExpandedPath(
			parsed.all_scopes_log,
			env,
			configDirectory,
		);
	}
	for (const scope of scopes) {
		if (isWithin(scope.store, allScopesLog)) {
			return configError(
				`all_scopes_log cannot be inside the ${scope.name} store`,
				sourcePath,
			);
		}
	}

	return {
		ok: true,
		config: {
			scopes,
			allScopesLog,
			keepMonths,
			explanationLanguage,
			path: sourcePath,
		},
	};
}

export async function loadConfig(
	opts: { env?: Env; path?: string } = {},
): Promise<ConfigResult> {
	const env = opts.env ?? process.env;
	const sourcePath = resolve(opts.path ?? configPath(env));
	const cacheKey = `${sourcePath}\0${dataHome(env)}\0${env.HOME ?? ""}`;
	let fileInfo: Stats;
	try {
		fileInfo = await stat(sourcePath);
	} catch (error) {
		if (
			!(error instanceof Error && "code" in error && error.code === "ENOENT")
		) {
			return configError(
				`cannot read config: ${error instanceof Error ? error.message : String(error)}`,
				sourcePath,
			);
		}
		const cached = configCache.get(cacheKey);
		if (cached?.mtimeMs === null) return cached.result;
		const result: ConfigResult = { ok: true, config: defaultConfig(env) };
		configCache.set(cacheKey, { mtimeMs: null, size: null, result });
		return result;
	}
	const cached = configCache.get(cacheKey);
	if (cached?.mtimeMs === fileInfo.mtimeMs && cached.size === fileInfo.size)
		return cached.result;
	try {
		const yamlText = await readFile(sourcePath, "utf8");
		const result = parseConfig(yamlText, sourcePath, env);
		configCache.set(cacheKey, {
			mtimeMs: fileInfo.mtimeMs,
			size: fileInfo.size,
			result,
		});
		return result;
	} catch (error) {
		return configError(
			`cannot read config: ${error instanceof Error ? error.message : String(error)}`,
			sourcePath,
		);
	}
}
