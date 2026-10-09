import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

function stripTerminal(text: string): string {
	return text
		.replace(/\x1b\]8;;[^\x1b]*\x1b\\/g, "")
		.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("prompt-tutor --once", () => {
	test("renders a configured Prompt from XDG fixture paths without changing the store", async () => {
		const root = await mkdtemp(join(tmpdir(), "prompt-tutor-watcher-"));
		const configHome = join(root, "config");
		const dataHome = join(root, "data");
		const store = join(dataHome, "prompt-tutor", "work");
		const promptId = "20261008T134100000-a1b2c3";
		const promptPath = join(store, "prompts", "2026-10", `${promptId}.json`);
		const configDir = join(configHome, "prompt-tutor");
		const configPath = join(configDir, "config.yml");
		const binPath = join(import.meta.dir, "../../bin/prompt-tutor");
		const promptText = JSON.stringify({
			version: 1,
			id: promptId,
			scope: "work",
			profile: "default",
			cwd: "/tmp",
			captured_at: "2026-10-08T13:41:00.000Z",
			utc_offset_minutes: 0,
			log_month: "2026-10",
			text: "The build are broken.",
			word_count: 4,
			state: "reviewed",
			review: {
				findings: [
					{
						quote: "are",
						fix: "is",
						category: "grammar",
						why: "Subject agreement.",
						kind: "agreement",
						start: 10,
						end: 13,
					},
				],
				rewrite: "The build is broken.",
				tip: "Match the verb to its subject.",
			},
		});

		try {
			await mkdir(join(store, "prompts", "2026-10"), { recursive: true });
			await mkdir(configDir, { recursive: true });
			await writeFile(configPath, "scopes:\n  - name: work\n");
			await writeFile(promptPath, promptText);
			const output = spawnSync(process.execPath, [binPath, "--once"], {
				env: {
					...process.env,
					XDG_CONFIG_HOME: configHome,
					XDG_DATA_HOME: dataHome,
				},
				encoding: "utf8",
			});
			expect(output.status).toBe(0);
			expect(output.stderr).toBe("");
			const frame = stripTerminal(output.stdout);
			expect(frame).toContain("work");
			expect(frame).toContain("grammar 1");
			expect(frame).toContain("The build");
			expect(frame).toContain("Match the verb to its subject.");
			expect(frame).toContain("log ↗");
			expect(output.stdout).toContain("\x1b]8;;file:");
			expect(await readFile(promptPath, "utf8")).toBe(promptText);
			expect(await Bun.file(join(store, "log")).exists()).toBe(false);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
