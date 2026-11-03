import type { Config } from "../types.ts";
import type { DigestTarget } from "./types.ts";

/** The Digest of each Scope, or with `combined_digest` one Digest over every Scope (ADR 0012). */
export function digestTargets(config: Config): DigestTarget[] {
	if (config.combinedDigest !== null)
		return [
			{
				name: "all",
				store: config.combinedDigest.store,
				sources: config.scopes,
			},
		];
	return config.scopes.map((scope) => ({
		name: scope.name,
		store: scope.store,
		sources: [scope],
	}));
}
