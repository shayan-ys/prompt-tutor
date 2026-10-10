import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const binPath = join(import.meta.dir, "../../bin/prompt-tutor");

function plain(text: string): string {
	return text
		.replace(/\x1b\]8;;[^\x1b]*\x1b\\/g, "")
		.replace(/\x1b\[[0-9;]*m/g, "");
}

async function withFixture(
	lock: unknown | null,
	run: (output: string) => void,
): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), "prompt-tutor-queued-"));
	const configHome = join(root, "config");
	const dataHome = join(root, "data");
	const store = join(dataHome, "prompt-tutor", "work");
	const id = "20261009T120000000-a1b2c3";
	try {
		await mkdir(join(configHome, "prompt-tutor"), { recursive: true });
		await writeFile(
			join(configHome, "prompt-tutor", "config.yml"),
			"scopes:\n  - name: work\n",
		);
		await mkdir(join(store, "prompts", "2026-10"), { recursive: true });
		await writeFile(
			join(store, "prompts", "2026-10", `${id}.json`),
			JSON.stringify({
				version: 1,
				id,
				scope: "work",
				profile: "claude-code",
				harness: "claude-code",
				cwd: "/tmp",
				captured_at: "2026-10-09T12:00:00.000Z",
				utc_offset_minutes: 0,
				log_month: "2026-10",
				text: "Typed in Claude Code.",
				word_count: 4,
				state: "pending",
			}),
		);
		if (lock !== null)
			await writeFile(join(store, "drain.lock"), JSON.stringify(lock));
		const env: NodeJS.ProcessEnv = {
			...process.env,
			XDG_CONFIG_HOME: configHome,
			XDG_DATA_HOME: dataHome,
		};
		delete env.DEVDASH_ACTION;
		delete env.DEVDASH_STATE_FILE;
		const result = spawnSync(process.execPath, [binPath, "--once"], {
			env,
			encoding: "utf8",
		});
		expect(result.status).toBe(0);
		run(plain(result.stdout));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

describe("prompt-tutor --once with a pending Claude Code Prompt", () => {
	test("shows queued when no drain lock exists", async () => {
		await withFixture(null, (output) => {
			expect(output).toContain("queued — waiting for prompt-tutor drain");
			expect(output).not.toContain("reviewing…");
		});
	});

	test("shows queued when the drain lock's process is gone", async () => {
		await withFixture(
			{
				pid: 2 ** 22 + 12345,
				profile: "default",
				started_at: "2026-10-09T12:00:00.000Z",
			},
			(output) => {
				expect(output).toContain("queued — waiting for prompt-tutor drain");
			},
		);
	});

	test("shows the spinner when a live process holds the drain lock", async () => {
		await withFixture(
			{
				pid: process.pid,
				profile: "default",
				started_at: "2026-10-09T12:00:00.000Z",
			},
			(output) => {
				expect(output).toContain("reviewing…");
				expect(output).not.toContain("queued");
			},
		);
	});
});
