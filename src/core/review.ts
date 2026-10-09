import {
	GRADER_PROMPT,
	GRADER_PROMPT_HASH,
	REVIEW_TOOL,
	validateReview,
} from "./grader.ts";
import { rebuildMonth } from "./log/index.ts";
import { writeRecord } from "./store.ts";
import type {
	CaptureResult,
	Grader,
	GraderInfo,
	GraderResponse,
	Outcome,
} from "./types.ts";

export async function review(
	captured: Extract<CaptureResult, { kind: "captured" }>,
	grader: Grader,
): Promise<Outcome> {
	let record = captured.record;
	let changed = false;
	if (record.state === "pending") {
		changed = true;
		let attempts = 0;
		let lastResponse: GraderResponse | undefined;
		let problems: string[] = [];
		let failureReason = "invalid Review after 2 attempts";
		try {
			for (let attempt = 1; attempt <= 2; attempt++) {
				attempts = attempt;
				const system =
					attempt === 1
						? GRADER_PROMPT
						: `${GRADER_PROMPT}\n\nYour previous response was invalid. Submit a corrected Review that fixes these problems: ${problems.join("; ")}`;
				const response = await grader.call({
					system,
					user: record.text,
					tool: REVIEW_TOOL,
				});
				lastResponse = response;
				let candidate: unknown;
				if (response.toolArgs !== undefined) {
					candidate = response.toolArgs;
				} else if (typeof response.text === "string") {
					try {
						candidate = JSON.parse(response.text);
					} catch {
						problems = ["response text was not valid JSON"];
						if (attempt === 2) break;
						continue;
					}
				} else {
					problems = ["response had no tool arguments or JSON text"];
					if (attempt === 2) break;
					continue;
				}
				const validation = validateReview(candidate, record.text);
				if (validation.review) {
					const graderInfo: GraderInfo = {
						model: response.model,
						requested_reasoning: response.requestedReasoning,
						prompt_hash: GRADER_PROMPT_HASH,
						attempts,
					};
					record = {
						...record,
						state: "reviewed",
						review: validation.review,
						grader: graderInfo,
						settled_at: new Date().toISOString(),
					};
					break;
				}
				problems = validation.problems;
				if (attempt === 2) break;
			}
			if (record.state === "pending")
				record = {
					...record,
					state: "failed",
					failure: failureReason,
					settled_at: new Date().toISOString(),
				};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			failureReason = `grader failed: ${message.replace(/\s+/gu, " ").trim().slice(0, 120)}`;
			record = {
				...record,
				state: "failed",
				failure: failureReason,
				settled_at: new Date().toISOString(),
			};
		}
		if (record.state === "failed" && lastResponse) {
			record = {
				...record,
				grader: {
					model: lastResponse.model,
					requested_reasoning: lastResponse.requestedReasoning,
					prompt_hash: GRADER_PROMPT_HASH,
					attempts,
				},
			};
		}
	}
	try {
		if (changed) await writeRecord(captured.scope.store, record);
	} finally {
		await rebuildMonth(captured.config, captured.scope, record.log_month);
	}
	return { record };
}
