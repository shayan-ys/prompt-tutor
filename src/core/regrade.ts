import { rebuildMonth } from "./log/index.ts";
import { listMonths, readMonth, writeRecord } from "./store.ts";
import type { Config, PromptRecord, Scope } from "./types.ts";

/**
 * True for a Review that failed because the grader call itself failed: no model configured for
 * the role, a provider or network error, or a stalled request. Those are worth another try. A
 * model that returned an invalid Review twice is not, and a skip never reached a grader.
 */
export function isRegradable(record: PromptRecord): boolean {
	return (
		record.state === "failed" &&
		record.failure?.startsWith("grader failed:") === true
	);
}

/** `YYYY-MM-DD` of the capture in the record's own UTC offset. */
function localCaptureDate(record: PromptRecord): string {
	const local =
		Date.parse(record.captured_at) + record.utc_offset_minutes * 60_000;
	return Number.isFinite(local)
		? new Date(local).toISOString().slice(0, 10)
		: "";
}

/** A failed record returned to `pending` for the Scope's Drainer (ADR 0013). */
export function queuedForRegrade(record: PromptRecord): PromptRecord {
	const {
		failure: _failure,
		grader: _grader,
		settled_at: _settledAt,
		...rest
	} = record;
	return { ...rest, state: "pending", regrade: true };
}

export interface RegradeResult {
	scope: Scope;
	/** Failed by a grader error: queued again, or, in a dry run or without a `review_profile`, left failed. */
	regradable: number;
	/** Failed for another reason (an invalid Review twice) and left as it is. */
	kept: number;
	/** Whether the regradable records were written back as `pending`. */
	queued: boolean;
}

/**
 * Return each Scope's failed records whose grader call failed, captured on or after local date
 * `since`, to `pending` with `regrade: true`, so the Drainer of the Scope's `review_profile`
 * reviews them. A Scope without a `review_profile` is only counted: no Drainer would ever take
 * its queue. Rebuilds each changed Review log month.
 */
export async function regradeFailed(
	config: Config,
	options: { scopes: Scope[]; since?: string; dryRun?: boolean },
): Promise<RegradeResult[]> {
	const results: RegradeResult[] = [];
	for (const scope of options.scopes) {
		const queue = !options.dryRun && scope.reviewProfile !== null;
		let regradable = 0;
		let kept = 0;
		for (const month of await listMonths(scope.store)) {
			if (options.since !== undefined && month < options.since.slice(0, 7))
				continue;
			let changed = false;
			for (const record of await readMonth(scope.store, month)) {
				if (record.state !== "failed") continue;
				if (
					options.since !== undefined &&
					localCaptureDate(record) < options.since
				)
					continue;
				if (!isRegradable(record)) {
					kept++;
					continue;
				}
				regradable++;
				if (!queue) continue;
				await writeRecord(scope.store, queuedForRegrade(record));
				changed = true;
			}
			if (changed) await rebuildMonth(config, scope, month);
		}
		results.push({ scope, regradable, kept, queued: queue });
	}
	return results;
}
