import { expect, mock, test } from "claude-code/testing";

const CWD = "/work/project";

interface CaptureCall {
	argv: readonly string[];
	init: { cwd?: string; stdin?: string; timeoutMs?: number } | undefined;
}

function stubSession(
	on: Parameters<Parameters<typeof test>[1]>[1],
	run: (call: CaptureCall) => { exitCode: number; stdout: string; stderr: string },
) {
	const clock = mock.clock(on);
	const calls: CaptureCall[] = [];
	const statuses: (string | undefined)[] = [];
	on("session.cwd", () => ({ value: CWD }));
	on("process.run", (_$, e) => {
		const call = { argv: e.argv, init: e.init };
		calls.push(call);
		return { value: run(call) };
	});
	on("ui.status", (_$, e) => {
		statuses.push(e.text);
		return { value: undefined };
	});
	on("prompt.submit", (_$, e) => ({ text: e.text }));
	return { clock, calls, statuses };
}

const ok = { exitCode: 0, stdout: "", stderr: "" };

test("a composer Prompt is captured on stdin and passed through unchanged", async ($, on) => {
	const { clock, calls, statuses } = stubSession(on, () => ok);
	const event = {
		text: "fix the the bug",
		origin: { kind: "composer" },
		wait: false,
	} as const;

	const result = await $.prompt.submit(event);
	// The capture is a background job: nothing has run when the hook returns
	expect(calls.length).toBe(0);
	expect(result.text).toBe("fix the the bug");
	expect(result.context).toBeUndefined();

	await clock.settle();
	expect(calls.length).toBe(1);
	expect(calls[0]?.argv).toEqual([
		"prompt-tutor",
		"capture",
		"--harness",
		"claude-code",
		"--cwd",
		CWD,
	]);
	expect(calls[0]?.init?.stdin).toBe("fix the the bug");
	expect(calls[0]?.init?.timeoutMs).toBe(15000);
	expect(statuses).toEqual([]);
});

for (const kind of ["sdk", "bridge", "task-notification", "peer"] as const) {
	test(`a ${kind} Prompt is not captured`, async ($, on) => {
		const { clock, calls, statuses } = stubSession(on, () => ok);
		const result = await $.prompt.submit({
			text: "not typed here",
			origin: { kind },
			wait: false,
		});
		await clock.settle();
		expect(result.text).toBe("not typed here");
		expect(calls.length).toBe(0);
		expect(statuses).toEqual([]);
	});
}

test("a failed capture shows a status and the next success clears it", async ($, on) => {
	let exitCode = 2;
	const { clock, calls, statuses } = stubSession(on, () => ({
		exitCode,
		stdout: "",
		stderr: "boom",
	}));
	const submit = (text: string) =>
		$.prompt.submit({ text, origin: { kind: "composer" }, wait: false });

	const first = await submit("first");
	await clock.settle();
	expect(first.text).toBe("first");
	expect(statuses).toEqual(["prompt-tutor: capture failed"]);

	exitCode = 0;
	await submit("second");
	await clock.settle();
	expect(calls.length).toBe(2);
	expect(statuses).toEqual(["prompt-tutor: capture failed", undefined]);

	await submit("third");
	await clock.settle();
	expect(statuses).toEqual(["prompt-tutor: capture failed", undefined]);
});

test("a capture that cannot start shows the status and does not break the Prompt", async ($, on) => {
	const clock = mock.clock(on);
	const statuses: (string | undefined)[] = [];
	on("session.cwd", () => ({ value: CWD }));
	on("process.run", () => ({ deny: "spawn prompt-tutor ENOENT" }));
	on("ui.status", (_$, e) => {
		statuses.push(e.text);
		return { value: undefined };
	});
	on("prompt.submit", (_$, e) => ({ text: e.text }));

	const result = await $.prompt.submit({
		text: "hello",
		origin: { kind: "composer" },
		wait: false,
	});
	await clock.settle();
	expect(result.text).toBe("hello");
	expect(statuses).toEqual(["prompt-tutor: capture failed"]);
});
