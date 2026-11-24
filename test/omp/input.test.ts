import { expect, mock, test } from "bun:test";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@oh-my-pi/pi-coding-agent";
import { isAgentMessage } from "../../src/core/capture.ts";
import { digestWeeksSince } from "../../src/core/digest/index.ts";

type TestOutcome = { record: { id: string; state: string } };

let nextCaptured = 0;
const pendingReviews = new Map<string, (outcome: TestOutcome) => void>();
const capture = mock(async ({ text }: { text: string }) => ({
	kind: "captured" as const,
	record: { id: `${++nextCaptured}:${text}`, state: "pending" as const },
	scope: {},
	config: {},
}));
const review = mock(
	(captured: { record: { id: string } }) =>
		new Promise<TestOutcome>((resolve) => {
			pendingReviews.set(captured.record.id, resolve);
		}),
);
const chipText = mock(
	(record: { id: string; state: string }) => `${record.state}:${record.id}`,
);
const dueDigests = mock(async () => []);
const loadConfig = mock(async () => ({
	ok: false as const,
	error: "not used",
	path: "",
}));
const runDigest = mock(async () => ({
	kind: "empty" as const,
	week: "2026-10-09",
}));
const pruneExpiredMonths = mock(async () => {});
const drainQueue = mock(async () => {});

mock.module("../../src/core/index.ts", () => ({
	capture,
	chipText,
	digestWeeksSince,
	drainQueue,
	dueDigests,
	isAgentMessage,
	loadConfig,
	pruneExpiredMonths,
	review,
	runDigest,
}));
const { default: promptTutor } = await import("../../src/omp/index.ts");

async function flushMicrotasks(): Promise<void> {
	for (let i = 0; i < 8; i++) await Promise.resolve();
}

test("input passes through synchronously, filters sources and agents, and ignores stale updates", async () => {
	nextCaptured = 0;
	pendingReviews.clear();
	capture.mockClear();
	review.mockClear();
	chipText.mockClear();
	const handlers = new Map<string, unknown>();
	const timers: Array<() => void> = [];
	const statuses: Array<[string, string | undefined]> = [];
	const notifications: string[] = [];
	// This fake intentionally implements only extension registration exercised by this unit.
	const pi = {
		on: (event: string, handler: unknown) => handlers.set(event, handler),
		registerCommand: () => undefined,
	} as unknown as ExtensionAPI;
	promptTutor(pi);

	const ctx = {
		cwd: "/fixture",
		agent: { kind: "main" },
		setTimeout: (callback: () => void, milliseconds: number) => {
			expect(milliseconds).toBe(0);
			timers.push(callback);
		},
		ui: {
			setStatus: (key: string, value: string | undefined) =>
				statuses.push([key, value]),
			notify: (message: string) => notifications.push(message),
		},
		models: { resolve: () => undefined },
		modelRegistry: { resolver: () => undefined },
		sessionManager: { getSessionId: () => "test-session" },
	};
	// The fake context is deliberately limited to the input handler's exercised fields.
	const fakeCtx = ctx as unknown as ExtensionContext;
	const input = handlers.get("input") as
		| ((
				event: { source: "interactive" | "rpc" | "extension"; text: string },
				ctx: ExtensionContext,
		  ) => unknown)
		| undefined;
	if (!input) throw new Error("The input handler was not registered.");

	expect(input({ source: "rpc", text: "rpc" }, fakeCtx)).toBeUndefined();
	const subCtx = {
		...fakeCtx,
		agent: { kind: "sub", id: "sub-1", name: "sub", depth: 1 },
	} as ExtensionContext;
	expect(
		input({ source: "interactive", text: "subagent" }, subCtx),
	).toBeUndefined();
	expect(timers).toHaveLength(0);
	expect(capture).not.toHaveBeenCalled();

	expect(
		input({ source: "interactive", text: "older" }, fakeCtx),
	).toBeUndefined();
	expect(
		input({ source: "interactive", text: "newest" }, fakeCtx),
	).toBeUndefined();
	expect(timers).toHaveLength(2);
	timers[0]!();
	timers[1]!();
	await flushMicrotasks();
	expect(review).toHaveBeenCalledTimes(2);
	expect(statuses.at(-1)?.[1]).toContain("newest");

	input(
		{ source: "interactive", text: " \n<hc from=x>agent update</hc>" },
		fakeCtx,
	);
	expect(timers).toHaveLength(2);

	const olderId = [...pendingReviews.keys()].find((id) => id.includes("older"));
	const newestId = [...pendingReviews.keys()].find((id) =>
		id.includes("newest"),
	);
	expect(olderId).toBeDefined();
	expect(newestId).toBeDefined();
	pendingReviews.get(olderId!)!({
		record: { id: olderId!, state: "reviewed" },
	});
	await flushMicrotasks();
	expect(statuses.at(-1)?.[1]).toContain("newest");
	pendingReviews.get(newestId!)!({
		record: { id: newestId!, state: "reviewed" },
	});
	await flushMicrotasks();
	expect(statuses.at(-1)?.[1]).toContain("newest");
	expect(statuses.at(-1)?.[1]).toBe(`reviewed:${newestId}`);
	expect(notifications).toHaveLength(0);
});

test("session_start builds a Digest only in an interactive main-agent session", async () => {
	const handlers = new Map<string, unknown>();
	const pi = {
		on: (event: string, handler: unknown) => handlers.set(event, handler),
		registerCommand: () => undefined,
	} as unknown as ExtensionAPI;
	promptTutor(pi);
	const sessionStart = handlers.get("session_start") as (
		event: object,
		ctx: ExtensionContext,
	) => unknown;
	if (!sessionStart) throw new Error("session_start was not registered.");
	loadConfig.mockImplementation((async () => ({
		ok: true as const,
		config: {},
	})) as unknown as typeof loadConfig);

	const start = async (
		mode: string,
		agent: { kind: string },
	): Promise<void> => {
		dueDigests.mockClear();
		pruneExpiredMonths.mockClear();
		// This fake implements only the fields the session_start handler reads.
		const ctx = {
			cwd: "/fixture",
			mode,
			agent,
			setTimeout: (callback: () => void) => callback(),
			ui: { notify: () => undefined },
			models: { resolve: () => undefined },
			modelRegistry: { resolver: () => undefined },
			sessionManager: { getSessionId: () => "test-session" },
		} as unknown as ExtensionContext;
		sessionStart({}, ctx);
		await flushMicrotasks();
	};

	await start("tui", { kind: "main" });
	expect(dueDigests).toHaveBeenCalledTimes(1);
	expect(pruneExpiredMonths).toHaveBeenCalledTimes(1);

	for (const mode of ["print", "rpc", "json"]) {
		await start(mode, { kind: "main" });
		expect(dueDigests).not.toHaveBeenCalled();
		// Retention is not Digest work and still runs.
		expect(pruneExpiredMonths).toHaveBeenCalledTimes(1);
	}
	await start("tui", { kind: "sub" });
	expect(dueDigests).not.toHaveBeenCalled();
});

test("/prompt-tutor digest --since builds each missing week oldest first and reports on stderr without a UI", async () => {
	let handler:
		| ((args: string, ctx: ExtensionCommandContext) => Promise<void>)
		| undefined;
	const pi = {
		on: () => undefined,
		registerCommand: (_name: string, options: { handler: typeof handler }) => {
			handler = options.handler;
		},
	} as unknown as ExtensionAPI;
	promptTutor(pi);
	if (!handler) throw new Error("/prompt-tutor was not registered.");
	loadConfig.mockImplementation((async () => ({
		ok: true as const,
		config: { scopes: [] },
	})) as unknown as typeof loadConfig);
	const target = { name: "personal", store: "/store", sources: [] };
	dueDigests.mockClear();
	dueDigests.mockImplementation((async () => [target]) as never);
	runDigest.mockClear();
	runDigest.mockImplementation((async () => ({
		kind: "written" as const,
		week: "w",
		htmlPath: "/store/digests/w.html",
	})) as never);
	const stderr: string[] = [];
	const write = process.stderr.write;
	process.stderr.write = ((chunk: string) => {
		stderr.push(chunk);
		return true;
	}) as typeof process.stderr.write;
	const now = new Date();
	const since = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 21);
	const sinceText = `${since.getFullYear()}-${String(since.getMonth() + 1).padStart(2, "0")}-${String(since.getDate()).padStart(2, "0")}`;
	const ctx = {
		cwd: "/fixture",
		hasUI: false,
		ui: { notify: () => undefined },
		models: { resolve: () => undefined },
		modelRegistry: { resolver: () => undefined },
		sessionManager: { getSessionId: () => "test-session" },
	} as unknown as ExtensionCommandContext;
	try {
		await handler(`digest --since ${sinceText}`, ctx);
		await handler("digest --since soon", ctx);
	} finally {
		process.stderr.write = write;
	}

	const weeks = digestWeeksSince(sinceText, now);
	expect(weeks.length).toBeGreaterThanOrEqual(2);
	expect((dueDigests.mock.calls as unknown[][]).map(([at]) => at)).toEqual(
		weeks.map((week) => ({
			profile: process.env.OMP_PROFILE ?? "default",
			cwd: "/fixture",
			now: week,
		})),
	);
	expect((runDigest.mock.calls as unknown[][]).map((call) => call[3])).toEqual(
		weeks,
	);
	expect(stderr.filter((line) => line.includes("written"))).toHaveLength(
		weeks.length,
	);
	expect(stderr.at(-1)).toContain("Invalid date");
});
