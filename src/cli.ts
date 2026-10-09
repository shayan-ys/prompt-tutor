import { renderOnce, startWatcher } from "./watcher/index.ts";

const USAGE = `Usage: prompt-tutor [--help | --once]

With no arguments, run the terminal Watcher.
  --once   render one frame to stdout and exit (read-only)
  --help   show this help`;

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
	if (args.some((argument) => argument !== "--once")) {
		console.error(
			`Unknown argument: ${args.find((argument) => argument !== "--once")}`,
		);
		console.error(USAGE);
		process.exitCode = 2;
		return;
	}
	if (args.filter((argument) => argument === "--once").length > 1) {
		console.error("--once may be specified only once.");
		console.error(USAGE);
		process.exitCode = 2;
		return;
	}
	if (args.includes("--once")) {
		const width = process.stdout.columns ?? 80;
		const height = process.stdout.rows ?? 24;
		process.stdout.write(`${await renderOnce(width, height)}\n`);
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
