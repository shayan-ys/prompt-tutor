import { afterEach, beforeEach, expect, test } from "bun:test";
import {
	chmod,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Leaf-module imports: test/omp mocks src/core/index.ts, and bun applies that mock to an index loaded earlier.
import { queuedRecords } from "../src/core/drain.ts";
import { drainLockPath } from "../src/core/drain-lock.ts";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");
let root: string;
let env: Record<string, string>;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "prompt-tutor-cli-"));
	env = {
		...(process.env as Record<string, string>),
		HOME: root,
		XDG_CONFIG_HOME: join(root, "config"),
		XDG_DATA_HOME: join(root, "data"),
	};
	await mkdir(join(root, "config", "prompt-tutor"), { recursive: true });
	await writeFile(
		join(root, "config", "prompt-tutor", "config.yml"),
		"scopes:\n  - name: work\n    review_profile: work\n  - name: home\n    review_profile: default\n",
	);
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

function run(args: string[], stdin = "") {
	const result = Bun.spawnSync(["bun", CLI, ...args], {
		env,
		stdin: Buffer.from(stdin),
	});
	return {
		code: result.exitCode,
		stdout: result.stdout.toString(),
		stderr: result.stderr.toString(),
	};
}

test("capture queues stdin as a pending Claude Code record without echoing it", async () => {
	const result = run(
		["capture", "--harness", "claude-code", "--cwd", root],
		"Pleese check this sentense for me.",
	);
	expect(result.code).toBe(0);
	expect(result.stdout).not.toContain("Pleese");
	const line = JSON.parse(result.stdout);
	expect(line).toMatchObject({
		kind: "captured",
		scope: "work",
		state: "pending",
	});
	const [record] = await queuedRecords(
		join(root, "data", "prompt-tutor", "work"),
	);
	expect(record.id).toBe(line.id);
	expect(record.profile).toBe("claude-code");
	expect(record.harness).toBe("claude-code");
});

test("capture rejects a missing or wrong harness", () => {
	expect(run(["capture"]).code).toBe(2);
	expect(run(["capture", "--harness", "cursor"]).code).toBe(2);
});

test("drain spawns headless omp per review_profile and relays stderr", async () => {
	const fake = join(root, "fake-omp");
	const out = join(root, "calls");
	await writeFile(
		fake,
		// Each fake writes its call, then waits until both have, so neither is stopped before reporting.
		`#!/usr/bin/env bun\nimport { appendFileSync, readFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(out)}, JSON.stringify({ argv: process.argv.slice(2), drain: process.env.PROMPT_TUTOR_DRAIN, profile: process.env.OMP_PROFILE ?? null }) + "\\n");\nconsole.error("hello");\nwhile (readFileSync(${JSON.stringify(out)}, "utf8").trim().split("\\n").length < 2) await Bun.sleep(10);\n`,
	);
	await chmod(fake, 0o755);
	env.PROMPT_TUTOR_OMP = fake;
	// The parent's own profile must not leak into the unnamed default profile's child.
	env.OMP_PROFILE = "x";
	const result = run(["drain"]);
	expect(result.stdout).toContain("draining work: work");
	expect(result.stdout).toContain("draining default: home");
	expect(result.stderr).toMatch(/exited with code 0/u);
	expect(result.stderr).toContain("[work] hello");
	expect(result.stderr).toContain("[default] hello");
	expect(result.code).toBe(1);
	const calls = (await readFile(out, "utf8"))
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	expect(calls).toContainEqual({
		argv: ["--profile", "work", "--mode", "rpc", "--no-ui", "--no-session"],
		drain: "1",
		profile: "work",
	});
	expect(calls).toContainEqual({
		argv: ["--mode", "rpc", "--no-ui", "--no-session"],
		drain: "1",
		profile: null,
	});
});

test("drain refuses Scopes whose live lock is held", async () => {
	for (const name of ["work", "home"]) {
		const store = join(root, "data", "prompt-tutor", name);
		await mkdir(store, { recursive: true });
		await writeFile(
			drainLockPath(store),
			JSON.stringify({ pid: process.pid, profile: name, started_at: "t" }),
		);
	}
	env.PROMPT_TUTOR_OMP = join(root, "missing");
	const result = run(["drain"]);
	for (const name of ["work", "home"])
		expect(result.stdout).toContain(
			`already draining ${name} (pid ${process.pid}, ${drainLockPath(join(root, "data", "prompt-tutor", name))})`,
		);
	expect(result.code).toBe(1);
});
