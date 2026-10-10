import { lstat, mkdir, readlink, realpath, symlink } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
	type AssistantMessage,
	completeSimple,
	type Tool,
	type ToolCall,
} from "@oh-my-pi/pi-ai";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@oh-my-pi/pi-coding-agent";
import {
	capture,
	chipText,
	drainQueue,
	dueDigests,
	loadConfig,
	pruneExpiredMonths,
	review,
	runDigest,
} from "../core/index.ts";
import type {
	CaptureResult,
	Grader,
	GraderRequest,
	GraderResponse,
	Outcome,
} from "../core/types.ts";

const STATUS_KEY = "prompt-tutor";
const PACKAGE_ROOT = fileURLToPath(new URL("../../", import.meta.url));
type Effort = NonNullable<Parameters<typeof completeSimple>[2]>["reasoning"];

interface GraderRole {
	role: string;
	// `Effort` is a const enum in pi-catalog; its members' runtime values are these strings.
	reasoning: "medium" | "high";
	/** Stall limits; unset keeps the provider defaults, one call, and no overall cap. */
	timeouts?: {
		/** Wait for the first stream event before the call fails as stalled. */
		firstEventMs: number;
		/** Calls per request; each failed or stalled call is replaced by a fresh one. */
		tries: number;
		/** Last-resort cap on all calls together. */
		totalMs: number;
	};
}

/**
 * Reviews: fast per-Prompt grading (ADR 0008). A Review settles in a few seconds, but a stalled
 * provider stream otherwise waits up to five minutes for its first event, and the Drainer reviews
 * one Prompt at a time, so the stall would hold the whole queue. The Codex SSE transport cannot
 * retry inside a call once its first-event watchdog fires, so a fresh call does the retry.
 */
const REVIEW_GRADER: GraderRole = {
	role: "@task",
	reasoning: "medium",
	timeouts: { firstEventMs: 20_000, tries: 2, totalMs: 120_000 },
};
/** Weekly Digest: the stronger analysis (ADR 0008); long by nature, so no caps. */
const DIGEST_GRADER: GraderRole = { role: "@advisor", reasoning: "high" };

// omp maps canonical @oh-my-pi imports to its host-bundled packages at runtime.
function makeGrader(
	ctx: ExtensionContext,
	{ role, reasoning, timeouts }: GraderRole,
): Grader {
	return {
		async call(request: GraderRequest): Promise<GraderResponse> {
			const model = ctx.models.resolve(role);
			if (!model)
				throw new Error(`No available model is configured for ${role}.`);

			const tool: Tool = {
				name: request.tool.name,
				description: request.tool.description,
				strict: request.tool.strict,
				parameters: request.tool.parameters as Tool["parameters"],
			};
			const deadline = timeouts && AbortSignal.timeout(timeouts.totalMs);
			let result: AssistantMessage | undefined;
			let failure: unknown;
			for (let attempt = 1; attempt <= (timeouts?.tries ?? 1); attempt++) {
				try {
					const response = await completeSimple(
						model,
						{
							systemPrompt: [request.system],
							messages: [
								{ role: "user", content: request.user, timestamp: Date.now() },
							],
							tools: [tool],
						},
						{
							apiKey: ctx.modelRegistry.resolver(
								model,
								ctx.sessionManager.getSessionId(),
							),
							reasoning: reasoning as Effort,
							toolChoice: { type: "tool", name: request.tool.name },
							streamFirstEventTimeoutMs: timeouts?.firstEventMs,
							signal: deadline,
						},
					);
					if (
						response.stopReason !== "error" &&
						response.stopReason !== "aborted"
					) {
						result = response;
						break;
					}
					failure = new Error(
						response.errorMessage ?? `provider ${response.stopReason}`,
					);
				} catch (error) {
					failure = error;
				}
				if (timeouts && deadline?.aborted)
					throw new Error(
						`no response from ${model.provider}/${model.id} in ${timeouts.totalMs / 1000} s`,
					);
			}
			if (!result) throw failure;

			const toolCall = result.content.find(
				(content): content is ToolCall =>
					content.type === "toolCall" && content.name === request.tool.name,
			);
			const text = result.content
				.flatMap((content) => (content.type === "text" ? [content.text] : []))
				.join("");
			return {
				...(toolCall ? { toolArgs: toolCall.arguments } : { text }),
				model: `${model.provider}/${model.id}`,
				requestedReasoning: reasoning,
			};
		},
	};
}

function schedule(ctx: ExtensionContext, work: () => Promise<void>): void {
	try {
		ctx.setTimeout(() => {
			void Promise.resolve()
				.then(work)
				.catch(() => {});
		}, 0);
	} catch {
		// Extension background work must never escape into the omp session loop.
	}
}

function notifySafely(
	ctx: ExtensionContext,
	message: string,
	type: "info" | "warning" | "error" = "info",
): void {
	try {
		ctx.ui.notify(message, type);
	} catch {
		// Headless omp contexts expose a no-op UI; keep notifications best-effort.
	}
}

function homePath(value: string): string {
	if (value === "~") return homedir();
	if (value.startsWith(`~${sep}`)) return join(homedir(), value.slice(2));
	return resolve(value);
}

async function installWatcher(
	args: string,
	ctx: ExtensionCommandContext,
): Promise<void> {
	const requestedDirectory = args.trim();
	const localBin = join(homedir(), ".local", "bin");
	const pathDirectories = new Set(
		(process.env.PATH ?? "")
			.split(delimiter)
			.filter(Boolean)
			.map((entry) => resolve(entry)),
	);
	const directory = pathDirectories.has(resolve(localBin))
		? localBin
		: requestedDirectory
			? homePath(requestedDirectory)
			: undefined;
	if (!directory) {
		throw new Error(
			`~/.local/bin is not on PATH; pass a PATH directory, for example /prompt-tutor install-watcher ~/.local/bin`,
		);
	}
	if (!pathDirectories.has(resolve(directory))) {
		throw new Error(
			`${directory} is not on PATH; pass a directory that is already on PATH.`,
		);
	}

	const executable = await realpath(join(PACKAGE_ROOT, "bin", "prompt-tutor"));
	await mkdir(directory, { recursive: true });
	const linkPath = join(directory, "prompt-tutor");
	try {
		const existing = await lstat(linkPath);
		if (!existing.isSymbolicLink())
			throw new Error(
				`${linkPath} already exists and is not a prompt-tutor symlink.`,
			);
		const target = await readlink(linkPath);
		const resolvedTarget = await realpath(
			resolve(dirname(linkPath), target),
		).catch(() => "");
		if (resolvedTarget !== executable)
			throw new Error(
				`${linkPath} is a symlink to a different target; refusing to replace it.`,
			);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		await symlink(executable, linkPath);
	}
	ctx.ui.notify(linkPath, "info");
}

export default function promptTutor(pi: ExtensionAPI): void {
	let latestPrompt = 0;
	let scopeErrorNotified = false;
	const profile = (): string => process.env.OMP_PROFILE ?? "default";
	const notifyScopeError = (
		ctx: Parameters<Parameters<ExtensionAPI["on"]>[1]>[1],
		message: string,
	): void => {
		if (scopeErrorNotified) return;
		scopeErrorNotified = true;
		notifySafely(ctx, message, "warning");
	};
	// Drain mode (ADR 0011): one loop for the process lifetime, started by `prompt-tutor drain`.
	let drain: AbortController | null = null;

	pi.on("session_shutdown", () => {
		drain?.abort();
		drain = null;
	});

	pi.on("session_start", (_event, ctx) => {
		if (process.env.PROMPT_TUTOR_DRAIN === "1" && !drain) {
			drain = new AbortController();
			// Started directly, not via schedule(): the loop waits on its own process timers,
			// which ctx.setTimeout would unref and clear on session_shutdown.
			void drainQueue({
				profile: profile(),
				grader: makeGrader(ctx, REVIEW_GRADER),
				log: (line) => {
					process.stderr.write(`prompt-tutor drain: ${line}\n`);
				},
				signal: drain.signal,
			});
		}
		scopeErrorNotified = false;
		const now = new Date();
		schedule(ctx, async () => {
			try {
				const loaded = await loadConfig();
				if (!loaded.ok) {
					notifyScopeError(
						ctx,
						`prompt-tutor configuration error: ${loaded.error}`,
					);
					return;
				}
				const config = loaded.config;
				await Promise.all([
					(async () => {
						try {
							await pruneExpiredMonths(config, now);
						} catch (error) {
							notifySafely(
								ctx,
								`prompt-tutor retention prune failed: ${String(error)}`,
								"warning",
							);
						}
					})(),
					(async () => {
						try {
							const scopes = await dueDigests({
								profile: profile(),
								cwd: ctx.cwd,
								now,
							});
							const grader = makeGrader(ctx, DIGEST_GRADER);
							await Promise.all(
								scopes.map(async (scope) => {
									try {
										const digest = await runDigest(scope, config, grader, now);
										if (digest.kind === "written")
											notifySafely(
												ctx,
												`prompt-tutor Digest written: ${digest.htmlPath}`,
											);
										else if (digest.kind === "failed")
											notifySafely(
												ctx,
												`prompt-tutor Digest failed: ${digest.error}`,
												"error",
											);
									} catch (error) {
										notifySafely(
											ctx,
											`prompt-tutor Digest failed: ${String(error)}`,
											"error",
										);
									}
								}),
							);
						} catch (error) {
							notifySafely(
								ctx,
								`prompt-tutor Digest check failed: ${String(error)}`,
								"error",
							);
						}
					})(),
				]);
			} catch (error) {
				notifySafely(
					ctx,
					`prompt-tutor session-start work failed: ${String(error)}`,
					"error",
				);
			}
		});
	});

	pi.on("input", (event, ctx) => {
		if (event.source !== "interactive" || ctx.agent.kind !== "main") return;

		const sequence = ++latestPrompt;
		schedule(ctx, async () => {
			try {
				const result: CaptureResult = await capture({
					text: event.text,
					profile: profile(),
					cwd: ctx.cwd,
					now: new Date(),
				});
				if (result.kind === "config_error") {
					notifyScopeError(
						ctx,
						`prompt-tutor configuration error: ${result.error}`,
					);
					return;
				}
				if (result.kind === "no_scope") {
					notifyScopeError(
						ctx,
						"prompt-tutor has no matching Scope for this profile and directory.",
					);
					return;
				}

				if (sequence === latestPrompt)
					ctx.ui.setStatus(STATUS_KEY, chipText(result.record));
				const outcome: Outcome =
					result.record.state === "pending"
						? await review(result, makeGrader(ctx, REVIEW_GRADER))
						: { record: result.record };
				if (sequence === latestPrompt)
					ctx.ui.setStatus(STATUS_KEY, chipText(outcome.record));
			} catch {
				if (sequence === latestPrompt) {
					try {
						ctx.ui.setStatus(STATUS_KEY, "EN ?");
					} catch {
						// A UI failure must not escape the managed background callback.
					}
				}
			}
		});
	});

	pi.registerCommand("prompt-tutor", {
		description: "Install the prompt-tutor Watcher on PATH",
		handler: async (args, ctx) => {
			const match = /^install-watcher(?:\s+(.+))?$/.exec(args.trim());
			if (!match) {
				ctx.ui.notify(
					"Usage: /prompt-tutor install-watcher [PATH directory]",
					"warning",
				);
				return;
			}
			try {
				await installWatcher(match[1] ?? "", ctx);
			} catch (error) {
				ctx.ui.notify(
					`Could not install prompt-tutor Watcher: ${String(error)}`,
					"error",
				);
			}
		},
	});
}
