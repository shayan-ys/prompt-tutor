import type { Config, Scope } from "../types.ts";
import type { DigestTarget } from "./types.ts";

function scopeTarget(scope: Scope): DigestTarget {
	return { name: scope.name, store: scope.store, sources: [scope] };
}

/**
 * The Digest of each Scope, or with `combined_digest` one Digest over every Scope plus the
 * Digests of the Scopes it names in `scope_digests` (ADR 0012, amended).
 */
export function digestTargets(config: Config): DigestTarget[] {
	if (config.combinedDigest === null) return config.scopes.map(scopeTarget);
	const { store, scopeDigests } = config.combinedDigest;
	return [
		{ name: "all", store, sources: config.scopes },
		...config.scopes
			.filter((scope) => scopeDigests.includes(scope.name))
			.map(scopeTarget),
	];
}
