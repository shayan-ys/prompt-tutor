import { type ChildProcess, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import {
	capture,
	configPath,
	deleteData,
	drainLockPath,
	liveDrainLock,
	loadConfig,
	releaseDrainLockSync,
	type Scope,
} from "./core/index.ts";
import { renderOnce, startWatcher } from "./watcher/index.ts";

const USAGE = `Usage: prompt-tutor [--help | --once | --delete-data [--yes]]
       prompt-tutor capture --harness claude-code [--cwd DIR]
       prompt-tutor drain

With no arguments, run the terminal Watcher.
  --once          render one frame to stdout and exit (read-only)
  --delete-data   list known data paths without removing them
  --yes           with --delete-data, remove the listed paths
  --help          show this help

  capture         queue the Prompt text read from stdin for review;
                  prints one JSON line without the text
  drain           review queued Claude Code Prompts with one headless omp
                  per Scope review_profile, until interrupted`;

function usageError(message: string): void {
	console.error(message);
	console.error(USAGE);
	process.exitCode = 2;
}

async function runCapture(args: string[]): Promise<void> {
	const values: Record<string, string> = {};
	for (let index = 0; index < args.length; index += 2) {
		const flag = args[index];
		const value = args[index + 1];
		if (flag !== "--harness" && flag !== "--cwd")
			return usageError(`Unknown argument: ${flag}`);
		if (flag in values)
			return usageError(`${flag} may be specified only once.`);
		if (value === undefined || value.startsWith("--"))
			return usageError(`${flag} requires a value.`);
		values[flag] = value;
	}
	if (values["--harness"] !== "claude-code")
		return usageError("capture requires --harness claude-code.");
	const result = await capture({
		text: await Bun.stdin.text(),
		profile: "claude-code",
		cwd: values["--cwd"] ?? process.cwd(),
		now: new Date(),
		harness: "claude-code",
	});
	if (result.kind === "captured") {
		const { id, scope, state } = result.record;
		console.log(JSON.stringify({ kind: result.kind, id, scope, state }));
		return;
	}
	console.log(JSON.stringify({ kind: result.kind }));
	if (result.kind === "config_error") {
		console.error(`prompt-tutor: configuration error: ${result.error}`);
		process.exitCode = 1;
	}
}

interface DrainChild {
	profile: string;
	scopes: Scope[];
	child: ChildProcess;
	exited: Promise<void>;
	startError: Error | null;
}

/** How long a child may stay silent before the CLI suspects the extension is missing. */
const DRAIN_START_TIMEOUT_MS =
	Number(process.env.PROMPT_TUTOR_DRAIN_START_TIMEOUT_MS) || 30_000;
const DRAIN_KILL_TIMEOUT_MS = 10_000;

async function runDrain(args: string[]): Promise<void> {
	if (args.length > 0) return usageError(`Unknown argument: ${args[0]}`);
	const loaded = await loadConfig();
	if (!loaded.ok) {
		console.error(`Configuration error at ${loaded.path}: ${loaded.error}`);
		process.exitCode = 1;
		return;
	}
	const byProfile = new Map<string, Scope[]>();
	for (const scope of loaded.config.scopes) {
		if (scope.reviewProfile === null) continue;
		byProfile.set(scope.reviewProfile, [
			...(byProfile.get(scope.reviewProfile) ?? []),
			scope,
		]);
	}
	if (byProfile.size === 0) {
		console.error(
			`No Scope has a review_profile. Add \`review_profile: <omp profile>\` to a Scope in ${loaded.config.path ?? configPath()}.`,
		);
		process.exitCode = 1;
		return;
	}

	const omp = process.env.PROMPT_TUTOR_OMP || "omp";
	const children: DrainChild[] = [];
	const finished = Promise.withResolvers<number>();
	let stopping = false;
	const running = (child: ChildProcess): boolean =>
		child.exitCode === null && child.signalCode === null;
	const stop = async (code: number): Promise<void> => {
		if (stopping) return;
		stopping = true;
		process.off("SIGINT", onSignal);
		process.off("SIGTERM", onSignal);
		for (const { child } of children) if (running(child)) child.kill("SIGTERM");
		const killTimer = setTimeout(() => {
			for (const { child } of children)
				if (running(child)) child.kill("SIGKILL");
		}, DRAIN_KILL_TIMEOUT_MS);
		await Promise.all(children.map(({ exited }) => exited));
		clearTimeout(killTimer);
		finished.resolve(code);
	};
	const onSignal = (): void => void stop(0);

	for (const [profile, scopes] of byProfile) {
		if (stopping) break;
		const locks = await Promise.all(
			scopes.map((scope) => liveDrainLock(scope.store)),
		);
		if (locks.every((lock) => lock !== null)) {
			for (const [index, scope] of scopes.entries())
				console.log(
					`already draining ${scope.name} (pid ${locks[index]?.pid}, ${drainLockPath(scope.store)})`,
				);
			continue;
		}
		const env: NodeJS.ProcessEnv = { ...process.env, PROMPT_TUTOR_DRAIN: "1" };
		if (profile === "default") {
			delete env.OMP_PROFILE;
			delete env.PI_PROFILE;
		} else {
			env.OMP_PROFILE = profile;
		}
		const child = spawn(
			omp,
			[
				...(profile === "default" ? [] : ["--profile", profile]),
				"--mode",
				"rpc",
				"--no-ui",
				"--no-session",
			],
			// stdin stays an open, never-written pipe: omp's RPC mode exits when it closes.
			{ env, stdio: ["pipe", "ignore", "pipe"] },
		);
		const entry: DrainChild = {
			profile,
			scopes,
			child,
			exited: Promise.resolve(),
			startError: null,
		};
		let started = false;
		const startTimer = setTimeout(() => {
			if (started || stopping) return;
			console.error(
				`omp for ${profile} has not started draining after ${Math.round(DRAIN_START_TIMEOUT_MS / 1000)} s; is prompt-tutor installed in profile ${profile}?`,
			);
		}, DRAIN_START_TIMEOUT_MS);
		startTimer.unref();
		child.once("error", (error) => {
			entry.startError = error;
			if (stopping) return;
			console.error(`omp for ${profile} failed to start: ${error.message}`);
			void stop(1);
		});
		entry.exited = new Promise<void>((resolve) => {
			const done = (): void => {
				clearTimeout(startTimer);
				// A signalled omp may skip its exit handler; clear only locks this child still holds.
				if (child.pid !== undefined)
					for (const scope of scopes)
						releaseDrainLockSync(scope.store, child.pid);
				resolve();
			};
			child.once("exit", done);
			child.once("error", done);
		});
		void entry.exited.then(() => {
			if (stopping || entry.startError) return;
			console.error(
				`omp for ${profile} exited with code ${child.exitCode ?? child.signalCode}`,
			);
			void stop(1);
		});
		if (child.stderr)
			createInterface({ input: child.stderr }).on("line", (line) => {
				if (line.includes("prompt-tutor drain:")) started = true;
				process.stderr.write(`[${profile}] ${line}\n`);
			});
		children.push(entry);
		console.log(
			`draining ${profile}: ${scopes.map((scope) => scope.name).join(", ")}`,
		);
	}
	if (children.length === 0) {
		process.exitCode = 1;
		return;
	}
	if (!stopping) {
		process.on("SIGINT", onSignal);
		process.on("SIGTERM", onSignal);
	}
	process.exitCode = await finished.promise;
}

function sizeFromEnv(name: string): number | undefined {
	const value = Number(process.env[name]);
	return Number.isInteger(value) && value > 0 ? value : undefined;
}

export async function main(args = process.argv.slice(2)): Promise<void> {
	if (args[0] === "capture") return runCapture(args.slice(1));
	if (args[0] === "drain") return runDrain(args.slice(1));
	if (args.includes("--help")) {
		if (args.length !== 1) {
			console.error("--help cannot be combined with other arguments.");
			console.error(USAGE);
			process.exitCode = 2;
			return;
		}
		console.log(USAGE);
		return;
	}
	const allowed = ["--once", "--delete-data", "--yes"];
	const unknown = args.find((argument) => !allowed.includes(argument));
	if (unknown) {
		console.error(`Unknown argument: ${unknown}`);
		console.error(USAGE);
		process.exitCode = 2;
		return;
	}
	for (const flag of allowed) {
		if (args.filter((argument) => argument === flag).length > 1) {
			console.error(`${flag} may be specified only once.`);
			console.error(USAGE);
			process.exitCode = 2;
			return;
		}
	}
	const deleteRequested = args.includes("--delete-data");
	if (args.includes("--yes") && !deleteRequested) {
		console.error("--yes requires --delete-data.");
		console.error(USAGE);
		process.exitCode = 2;
		return;
	}
	if (args.includes("--once") && deleteRequested) {
		console.error("--once cannot be combined with --delete-data.");
		console.error(USAGE);
		process.exitCode = 2;
		return;
	}
	if (deleteRequested) {
		const yes = args.includes("--yes");
		console.log("Quit all omp sessions before deleting prompt-tutor data.");
		try {
			const report = await deleteData({ yes });
			if ("error" in report) {
				console.error(
					`Configuration error at ${report.configPath}: ${report.error}`,
				);
				console.error("Data stores are unknown; no data was removed.");
				process.exitCode = 1;
				return;
			}
			console.log(`Config file (not deleted): ${report.configPath}`);
			console.log(yes ? "Removed paths:" : "Paths that would be removed:");
			if (report.paths.length === 0) console.log("(none)");
			else for (const path of report.paths) console.log(path);
			if (report.unknown.length > 0) {
				console.log("Unknown paths left in place:");
				for (const path of report.unknown) console.log(path);
			}
		} catch (error) {
			console.error(error instanceof Error ? error.message : String(error));
			process.exitCode = 1;
		}
		return;
	}
	if (args.includes("--once")) {
		// Piped output has no terminal size; a host such as devdash passes its width in COLUMNS.
		// The frame is as tall as its content: the host scrolls it.
		const width = process.stdout.columns ?? sizeFromEnv("COLUMNS") ?? 80;
		const result = await renderOnce(width);
		if (result.ok) {
			process.stdout.write(`${result.frame}\n`);
		} else {
			console.error(`prompt-tutor: ${result.error}`);
			process.exitCode = 1;
		}
		return;
	}
	try {
		await startWatcher();
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}

if (import.meta.main) await main();
