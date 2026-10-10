import { loadConfig } from "./config.ts";
import { rebuildMonth, writeStubs } from "./log/index.ts";
import { preprocess } from "./preprocess.ts";
import { resolveScope } from "./scope.ts";
import { newPromptId, writeRecord } from "./store.ts";
import {
	type CaptureInput,
	type CaptureResult,
	FORMAT_VERSION,
	type PromptRecord,
} from "./types.ts";

export async function capture(
	input: CaptureInput,
	opts: { env?: NodeJS.ProcessEnv } = {},
): Promise<CaptureResult> {
	const result = await loadConfig({ env: opts.env });
	if (!result.ok) return { kind: "config_error", error: result.error };
	const profile = input.profile || "default";
	const scope = resolveScope(result.config, { profile, cwd: input.cwd });
	if (!scope) return { kind: "no_scope" };

	const processed = preprocess(input.text);
	const now = input.now;
	const year = String(now.getFullYear()).padStart(4, "0");
	const month = String(now.getMonth() + 1).padStart(2, "0");
	const record: PromptRecord = {
		version: FORMAT_VERSION,
		id: newPromptId(now),
		scope: scope.name,
		profile,
		...(input.harness ? { harness: input.harness } : {}),
		cwd: input.cwd,
		captured_at: now.toISOString(),
		utc_offset_minutes: -now.getTimezoneOffset(),
		log_month: `${year}-${month}`,
		text: processed.text,
		word_count: processed.wordCount,
		state: processed.skip === null ? "pending" : "skipped",
		...(processed.skip === null ? {} : { skip_reason: processed.skip }),
	};

	await writeRecord(scope.store, record);
	try {
		await writeStubs(result.config, scope, record);
	} finally {
		await rebuildMonth(result.config, scope, record.log_month);
	}
	return { kind: "captured", record, scope, config: result.config };
}
