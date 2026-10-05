// PROTOTYPE — throwaway omp extension that grades data/prompts.json with the @advisor role.
// Run: omp -p --no-session --no-tools --no-skills --no-rules --no-extensions -e prototypes/review-grader/harness.ts "/pt-grade"
import { completeSimple } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { GRADER_PROMPT, REVIEW_TOOL, preprocess, validate } from "./grader.ts";

const DATA = new URL("./data/", import.meta.url).pathname;

type Block = { type: string; name?: string; arguments?: unknown; text?: string };

function extract(content: Block[]): { via: string; review: unknown } {
	const call = content.find(b => b.type === "toolCall" && b.name === REVIEW_TOOL.name);
	if (call) return { via: "tool", review: call.arguments };
	const text = content.filter(b => b.type === "text").map(b => b.text).join("");
	const json = text.match(/\{[\s\S]*\}/);
	if (json) {
		try {
			return { via: "text-json", review: JSON.parse(json[0]) };
		} catch {}
	}
	return { via: "none", review: null };
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("pt-grade", {
		description: "PROTOTYPE: grade data/prompts.json",
		handler: async (_args, ctx) => {
			const prompts: { id: number; text: string }[] = await Bun.file(DATA + "prompts.json").json();
			const model = ctx.models.resolve("@advisor");
			if (!model) throw new Error("no @advisor model");
			const grade = async (p: { id: number; text: string }) => {
				const text = preprocess(p.text);
				const attempts = [];
				for (let attempt = 0; attempt < 2; attempt++) {
					const t0 = Date.now();
					const msg = await completeSimple(
						model,
						{ systemPrompt: [GRADER_PROMPT], messages: [{ role: "user", content: text, timestamp: Date.now() }], tools: [REVIEW_TOOL] },
						{
							apiKey: ctx.modelRegistry.resolver(model, ctx.sessionManager.getSessionId()),
							reasoning: "medium",
							toolChoice: { type: "function", name: REVIEW_TOOL.name },
						},
					);
					const { via, review } = extract(msg.content as Block[]);
					const problems = validate(review, text);
					attempts.push({ ms: Date.now() - t0, via, review, problems, usage: msg.usage, stop: msg.stopReason, error: msg.errorMessage, raw: via === "none" ? msg.content : undefined });
					if (problems.length === 0) break;
				}
				return { id: p.id, original: p.text, text, words: text.split(/\s+/).length, attempts };
			};
			const results = [];
			for (let i = 0; i < prompts.length; i += 5) results.push(...(await Promise.all(prompts.slice(i, i + 5).map(grade))));
			await Bun.write(DATA + "results.json", JSON.stringify({ model: `${model.provider}/${model.id}`, prompt: GRADER_PROMPT, results }, null, 1));
			console.log(`graded ${results.length} with ${model.provider}/${model.id}`);
		},
	});
}
