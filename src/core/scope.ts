import { realpathSync } from "node:fs";
import type { Config, Scope } from "./types.ts";

export function resolveScope(
	config: Config,
	at: { profile: string; cwd: string },
): Scope | null {
	let cwd = at.cwd;
	try {
		cwd = realpathSync(at.cwd);
	} catch {
		// A not-yet-created working directory is matched as supplied.
	}
	cwd = cwd.replaceAll("\\", "/");
	for (const scope of config.scopes) {
		if (scope.when.length === 0) return scope;
		for (const condition of scope.when) {
			if (condition.profile !== undefined && condition.profile !== at.profile)
				continue;
			if (condition.cwd !== undefined) {
				// Config loading already expanded `~` and resolved symlinks in the literal prefix.
				const pattern = condition.cwd.replaceAll("\\", "/");
				let matched = false;
				try {
					matched = new Bun.Glob(pattern).match(cwd);
				} catch {
					matched = false;
				}
				if (!matched && pattern.endsWith("/**")) {
					matched = cwd === pattern.slice(0, -3).replace(/\/$/u, "");
				}
				if (!matched) continue;
			}
			return scope;
		}
	}
	return null;
}
