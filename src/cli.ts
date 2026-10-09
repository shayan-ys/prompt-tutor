import { deleteData } from "./core/index.ts";
import { renderOnce, startWatcher } from "./watcher/index.ts";

const USAGE = `Usage: prompt-tutor [--help | --once | --delete-data [--yes]]

With no arguments, run the terminal Watcher.
  --once          render one frame to stdout and exit (read-only)
  --delete-data   list known data paths without removing them
  --yes           with --delete-data, remove the listed paths
  --help          show this help`;

function sizeFromEnv(name: string): number | undefined {
	const value = Number(process.env[name]);
	return Number.isInteger(value) && value > 0 ? value : undefined;
}

export async function main(args = process.argv.slice(2)): Promise<void> {
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
		// Piped output has no terminal size; a host such as devdash passes its room in COLUMNS and LINES.
		const width = process.stdout.columns ?? sizeFromEnv("COLUMNS") ?? 80;
		const height = process.stdout.rows ?? sizeFromEnv("LINES") ?? 24;
		const result = await renderOnce(width, height);
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
