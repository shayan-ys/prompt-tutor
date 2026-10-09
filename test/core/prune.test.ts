import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rebuildMonth, writeStubs } from "../../src/core/log/index.ts";
import { pruneExpiredMonths } from "../../src/core/prune.ts";
import { newPromptId, writeRecord } from "../../src/core/store.ts";
import type { Config, PromptRecord, Scope } from "../../src/core/types.ts";

test("prunes expired Review log months and repairs oldest kept pages", async () => {
	const root = await mkdtemp(join(tmpdir(), "prompt-tutor-prune-"));
	try {
		const scopes: Scope[] = [
			{
				name: "work",
				index: 0,
				store: join(root, "work"),
				when: [],
				digestProfile: null,
			},
			{
				name: "personal",
				index: 1,
				store: join(root, "personal"),
				when: [],
				digestProfile: null,
			},
		];
		const config: Config = {
			scopes,
			allScopesLog: join(root, "all", "log"),
			keepMonths: 2,
			explanationLanguage: "English",
			path: null,
		};
		const monthsByScope = [
			["2026-07", "2026-08", "2026-09", "2026-10"],
			["2026-08", "2026-09", "2026-10"],
		];
		const records = new Map<string, PromptRecord>();
		for (const [index, scope] of scopes.entries()) {
			for (const month of monthsByScope[index] ?? []) {
				const [year, monthNumber] = month.split("-").map(Number);
				const capturedAt = new Date(year, monthNumber - 1, 15, 12);
				const record: PromptRecord = {
					version: 1,
					id: newPromptId(capturedAt),
					scope: scope.name,
					profile: scope.name,
					cwd: "/tmp",
					captured_at: capturedAt.toISOString(),
					utc_offset_minutes: -capturedAt.getTimezoneOffset(),
					log_month: month,
					text: `Please review the ${month} fixture.`,
					word_count: 5,
					state: "pending",
				};
				records.set(`${scope.name}/${month}`, record);
				await writeRecord(scope.store, record);
				await writeStubs(config, scope, record);
				await rebuildMonth(config, scope, month);
			}
		}

		const workStore = scopes[0]!.store;
		await mkdir(join(workStore, "digests"), { recursive: true });
		await writeFile(
			join(workStore, "digests", "2026-10-02.json"),
			"digest archive",
		);
		await writeFile(join(workStore, "digest.html"), "latest digest");
		const expired = await pruneExpiredMonths(config, new Date(2026, 9, 8, 12));

		expect(expired).toEqual(["2026-07", "2026-08"]);
		for (const [key, record] of records) {
			const scope = scopes.find(({ name }) => key.startsWith(`${name}/`))!;
			const isExpired = record.log_month < "2026-09";
			for (const path of [
				join(scope.store, "prompts", record.log_month, `${record.id}.json`),
				join(scope.store, "log", `${record.log_month}.html`),
				join(scope.store, "log", "r", `${record.id}.html`),
				join(config.allScopesLog, "r", `${record.id}.html`),
			])
				expect([path, existsSync(path)]).toEqual([path, !isExpired]);
		}
		for (const scope of scopes)
			for (const month of ["2026-07", "2026-08"])
				expect(existsSync(join(scope.store, "prompts", month))).toBe(false);
		for (const month of ["2026-07", "2026-08"])
			expect(existsSync(join(config.allScopesLog, `${month}.html`))).toBe(
				false,
			);
		expect(
			await Bun.file(join(workStore, "digests", "2026-10-02.json")).text(),
		).toBe("digest archive");
		expect(await Bun.file(join(workStore, "digest.html")).text()).toBe(
			"latest digest",
		);

		const keptScopePage = await readFile(
			join(workStore, "log", "2026-09.html"),
			"utf8",
		);
		const keptAllScopesPage = await readFile(
			join(config.allScopesLog, "2026-09.html"),
			"utf8",
		);
		expect(keptScopePage).not.toContain('rel="prev"');
		expect(keptAllScopesPage).not.toContain('rel="prev"');
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
