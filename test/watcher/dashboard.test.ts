import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const binPath = join(import.meta.dir, "../../bin/prompt-tutor");

interface Fixture {
	root: string;
	configHome: string;
	dataHome: string;
}

async function makeFixture(): Promise<Fixture> {
	const root = await mkdtemp(join(tmpdir(), "prompt-tutor-dashboard-"));
	const configHome = join(root, "config");
	const dataHome = join(root, "data");
	const configDirectory = join(configHome, "prompt-tutor");
	await mkdir(configDirectory, { recursive: true });
	await writeFile(
		join(configDirectory, "config.yml"),
		"scopes:\n  - name: work\n  - name: personal\n",
	);
	for (const [id, scope, capturedAt, text] of [
		[
			"20261009T120000000-a1b2c3",
			"work",
			"2026-10-09T12:00:00.000Z",
			"Latest fixture Prompt.",
		],
		[
			"20261009T110000000-a1b2c3",
			"personal",
			"2026-10-09T11:00:00.000Z",
			"Middle fixture Prompt.",
		],
		[
			"20261009T100000000-a1b2c3",
			"work",
			"2026-10-09T10:00:00.000Z",
			"Oldest fixture Prompt.",
		],
	] as const) {
		const directory = join(
			dataHome,
			"prompt-tutor",
			scope,
			"prompts",
			"2026-10",
		);
		await mkdir(directory, { recursive: true });
		await writeFile(
			join(directory, `${id}.json`),
			JSON.stringify({
				version: 1,
				id,
				scope,
				profile: "default",
				cwd: "/tmp",
				captured_at: capturedAt,
				utc_offset_minutes: 0,
				log_month: "2026-10",
				text,
				word_count: 3,
				state: "pending",
			}),
		);
	}
	return { root, configHome, dataHome };
}

function childEnvironment(
	fixture: Fixture,
	extra: Record<string, string> = {},
): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {
		...process.env,
		XDG_CONFIG_HOME: fixture.configHome,
		XDG_DATA_HOME: fixture.dataHome,
		COLUMNS: "50",
		LINES: "16",
	};
	delete env.DEVDASH_ACTION;
	delete env.DEVDASH_STATE_FILE;
	Object.assign(env, extra);
	return env;
}

function runOnce(env: NodeJS.ProcessEnv) {
	return spawnSync(process.execPath, [binPath, "--once"], {
		env,
		encoding: "utf8",
	});
}

function plain(text: string): string {
	return text
		.replace(/\x1b\]8;;[^\x1b]*\x1b\\/g, "")
		.replace(/\x1b\[[0-9;]*m/g, "");
}

const stateDefaults: Array<[string, string | undefined]> = [
	["missing", undefined],
	["empty", ""],
	["invalid JSON", "not JSON"],
	["unsupported version", '{"version":2,"view":"work","selected":null}'],
];

describe("prompt-tutor dashboard state", () => {
	for (const [label, initialContents] of stateDefaults) {
		test(`${label} state starts in all while following latest`, async () => {
			const fixture = await makeFixture();
			const statePath = join(fixture.root, "state.json");
			try {
				if (initialContents !== undefined)
					await writeFile(statePath, initialContents);
				const output = runOnce(
					childEnvironment(fixture, { DEVDASH_STATE_FILE: statePath }),
				);
				expect(output.status).toBe(0);
				expect(output.stderr).toBe("");
				const frame = plain(output.stdout);
				expect(frame).toContain("all");
				expect(frame).toContain("following latest");
				expect(frame).toContain("Latest fixture Prompt.");
				expect(frame).not.toContain("j/k prompts");
				expect(JSON.parse(await readFile(statePath, "utf8"))).toEqual({
					version: 1,
					view: "all",
					selected: null,
				});
				const info = await stat(statePath);
				expect(info.mode & 0o777).toBe(0o600);
			} finally {
				await rm(fixture.root, { recursive: true, force: true });
			}
		});
	}

	test("older actions persist selection and render it on subsequent frames", async () => {
		const fixture = await makeFixture();
		const statePath = join(fixture.root, "state.json");
		try {
			const first = runOnce(
				childEnvironment(fixture, {
					DEVDASH_STATE_FILE: statePath,
					DEVDASH_ACTION: "older",
				}),
			);
			expect(first.status).toBe(0);
			expect(plain(first.stdout)).toContain("Middle fixture Prompt.");
			expect(plain(first.stdout)).toContain("◀ 1 newer");
			expect(JSON.parse(await readFile(statePath, "utf8"))).toEqual({
				version: 1,
				view: "all",
				selected: "20261009T110000000-a1b2c3",
			});

			const second = runOnce(
				childEnvironment(fixture, {
					DEVDASH_STATE_FILE: statePath,
					DEVDASH_ACTION: "older",
				}),
			);
			expect(second.status).toBe(0);
			expect(plain(second.stdout)).toContain("Oldest fixture Prompt.");
			expect(plain(second.stdout)).toContain("◀ 2 newer");
			expect(JSON.parse(await readFile(statePath, "utf8"))).toEqual({
				version: 1,
				view: "all",
				selected: "20261009T100000000-a1b2c3",
			});
			expect(await readdir(fixture.root)).toContain("state.json");
			expect(
				(await readdir(fixture.root)).filter((name) => name.endsWith(".tmp")),
			).toEqual([]);
		} finally {
			await rm(fixture.root, { recursive: true, force: true });
		}
	});

	test("newer from the oldest Prompt moves to the previous Prompt", async () => {
		const fixture = await makeFixture();
		const statePath = join(fixture.root, "state.json");
		try {
			await writeFile(
				statePath,
				'{"version":1,"view":"all","selected":"20261009T100000000-a1b2c3"}\n',
			);
			const output = runOnce(
				childEnvironment(fixture, {
					DEVDASH_STATE_FILE: statePath,
					DEVDASH_ACTION: "newer",
				}),
			);
			expect(output.status).toBe(0);
			expect(plain(output.stdout)).toContain("Middle fixture Prompt.");
			expect(JSON.parse(await readFile(statePath, "utf8"))).toEqual({
				version: 1,
				view: "all",
				selected: "20261009T110000000-a1b2c3",
			});
		} finally {
			await rm(fixture.root, { recursive: true, force: true });
		}
	});

	test("a removed Scope falls back to all and keeps a visible selection", async () => {
		const fixture = await makeFixture();
		const statePath = join(fixture.root, "state.json");
		try {
			await writeFile(
				statePath,
				'{"version":1,"view":"removed","selected":"20261009T110000000-a1b2c3"}\n',
			);
			const output = runOnce(
				childEnvironment(fixture, { DEVDASH_STATE_FILE: statePath }),
			);
			expect(output.status).toBe(0);
			expect(plain(output.stdout)).toContain("Middle fixture Prompt.");
			expect(JSON.parse(await readFile(statePath, "utf8"))).toEqual({
				version: 1,
				view: "all",
				selected: "20261009T110000000-a1b2c3",
			});
		} finally {
			await rm(fixture.root, { recursive: true, force: true });
		}
	});

	test("scope actions cycle stored views and reset selection", async () => {
		const fixture = await makeFixture();
		const statePath = join(fixture.root, "state.json");
		try {
			await writeFile(
				statePath,
				'{"version":1,"view":"all","selected":"20261009T110000000-a1b2c3"}\n',
			);
			for (const view of ["work", "personal", "all"]) {
				const output = runOnce(
					childEnvironment(fixture, {
						DEVDASH_STATE_FILE: statePath,
						DEVDASH_ACTION: "scope",
					}),
				);
				expect(output.status).toBe(0);
				expect(JSON.parse(await readFile(statePath, "utf8"))).toEqual({
					version: 1,
					view,
					selected: null,
				});
			}
		} finally {
			await rm(fixture.root, { recursive: true, force: true });
		}
	});

	test("an unknown action exits without changing the state file", async () => {
		const fixture = await makeFixture();
		const statePath = join(fixture.root, "state.json");
		const original = '{"version":1,"view":"work","selected":"old"}\n';
		try {
			await writeFile(statePath, original);
			const output = runOnce(
				childEnvironment(fixture, {
					DEVDASH_STATE_FILE: statePath,
					DEVDASH_ACTION: "sideways",
				}),
			);
			expect(output.status).toBe(1);
			expect(output.stdout).toBe("");
			expect(output.stderr).toContain("unknown DEVDASH_ACTION");
			expect(await readFile(statePath, "utf8")).toBe(original);
		} finally {
			await rm(fixture.root, { recursive: true, force: true });
		}
	});

	test("config and store read failures leave dashboard state untouched", async () => {
		for (const failure of ["config", "store"] as const) {
			const fixture = await makeFixture();
			const statePath = join(fixture.root, "state.json");
			const original = '{"version":1,"view":"work","selected":null}\n';
			try {
				await writeFile(statePath, original);
				if (failure === "config") {
					await writeFile(
						join(fixture.configHome, "prompt-tutor", "config.yml"),
						"scopes: [\n",
					);
				} else {
					const prompts = join(
						fixture.dataHome,
						"prompt-tutor",
						"work",
						"prompts",
					);
					await rm(prompts, { recursive: true });
					await writeFile(prompts, "not a directory");
				}
				const output = runOnce(
					childEnvironment(fixture, {
						DEVDASH_STATE_FILE: statePath,
						DEVDASH_ACTION: "older",
					}),
				);
				expect(output.status).toBe(1);
				expect(output.stdout).toBe("");
				expect(output.stderr).not.toBe("");
				expect(await readFile(statePath, "utf8")).toBe(original);
			} finally {
				await rm(fixture.root, { recursive: true, force: true });
			}
		}
	});

	test("without a state file, action is ignored and writes nothing", async () => {
		const fixture = await makeFixture();
		const statePath = join(fixture.root, "state.json");
		try {
			const output = runOnce(
				childEnvironment(fixture, { DEVDASH_ACTION: "sideways" }),
			);
			expect(output.status).toBe(0);
			expect(output.stderr).toBe("");
			expect(plain(output.stdout)).toContain("Latest fixture Prompt.");
			expect(plain(output.stdout)).not.toContain("following latest");
			expect(await Bun.file(statePath).exists()).toBe(false);
		} finally {
			await rm(fixture.root, { recursive: true, force: true });
		}
	});

	test("an empty state-file variable is treated as unset", async () => {
		const fixture = await makeFixture();
		try {
			const output = runOnce(
				childEnvironment(fixture, {
					DEVDASH_STATE_FILE: "",
					DEVDASH_ACTION: "sideways",
				}),
			);
			expect(output.status).toBe(0);
			expect(output.stderr).toBe("");
			expect(plain(output.stdout)).toContain("Latest fixture Prompt.");
			expect(plain(output.stdout)).not.toContain("following latest");
		} finally {
			await rm(fixture.root, { recursive: true, force: true });
		}
	});
});
