import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deleteData } from "../../src/core/delete-data.ts";

test("dry-runs and removes only known configured data paths", async () => {
	const root = await mkdtemp(join(tmpdir(), "prompt-tutor-delete-data-"));
	try {
		const configHome = join(root, "config");
		const dataHome = join(root, "data", "prompt-tutor");
		const workStore = join(dataHome, "work");
		const personalStore = join(dataHome, "personal");
		const allScopesLog = join(dataHome, "all", "log");
		const configFile = join(configHome, "prompt-tutor", "config.yml");
		const env = {
			...process.env,
			XDG_CONFIG_HOME: configHome,
			XDG_DATA_HOME: join(root, "data"),
		};
		await mkdir(join(configHome, "prompt-tutor"), { recursive: true });
		await writeFile(
			configFile,
			`scopes:\n  - name: work\n  - name: personal\nall_scopes_log: ${allScopesLog}\n`,
		);
		const knownPaths = [
			join(workStore, "prompts", "2026-10", "prompt.json"),
			join(workStore, "log", "r", "prompt.html"),
			join(workStore, "log", "2026-10.html"),
			join(workStore, "digests", ".lock"),
			join(workStore, "digests", "2026-10-02.json"),
			join(workStore, "digest.html"),
			join(personalStore, "prompts", "2026-10", "personal.json"),
			join(allScopesLog, "r", "prompt.html"),
			join(allScopesLog, "2026-10.html"),
		];
		for (const path of knownPaths) {
			await mkdir(join(path, ".."), { recursive: true });
			await writeFile(path, "known data");
		}
		const unknownPaths = [
			join(workStore, "keep.txt"),
			join(allScopesLog, "keep.txt"),
			join(allScopesLog, "keep.html"),
		];
		for (const path of unknownPaths) await writeFile(path, "keep this");

		const dryRun = await deleteData({ env });
		expect("error" in dryRun).toBe(false);
		if ("error" in dryRun) return;
		expect(dryRun.configPath).toBe(configFile);
		for (const path of knownPaths)
			expect(await Bun.file(path).exists()).toBe(true);
		expect(dryRun.paths).toContain(join(workStore, "prompts"));
		expect(dryRun.paths).toContain(join(workStore, "digests"));
		expect(dryRun.paths).toContain(join(workStore, "digest.html"));
		expect(dryRun.paths).toContain(join(allScopesLog, "r"));
		for (const path of unknownPaths) expect(dryRun.unknown).toContain(path);

		const removed = await deleteData({ env, yes: true });
		expect("error" in removed).toBe(false);
		for (const path of knownPaths)
			expect(await Bun.file(path).exists()).toBe(false);
		expect(await readFile(configFile, "utf8")).toContain("name: work");
		for (const path of unknownPaths)
			expect(await readFile(path, "utf8")).toBe("keep this");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
