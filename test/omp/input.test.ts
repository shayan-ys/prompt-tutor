import { expect, mock, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

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

mock.module("../../src/core/index.ts", () => ({
	capture,
	chipText,
	dueDigests,
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
	expect(notifications).toHaveLength(0);
});
