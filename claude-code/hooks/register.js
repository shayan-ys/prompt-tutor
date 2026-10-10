const CAPTURE_TIMEOUT_MS = 15_000;
const FAILURE_STATUS = "prompt-tutor: capture failed";

/**
 * Capture-only mod: queue each Prompt typed at the terminal for prompt-tutor.
 * It never changes the event, never adds context, and never writes to
 * `$.ui.log` (those lines are saved in Claude's transcript files).
 */
export function register(on) {
	let failed = false;

	on("prompt.submit", async ($, e, next) => {
		if (e.origin?.kind === "composer") {
			const text = e.text;
			$.clock.after(0, async () => {
				try {
					const cwd = await $.session.cwd();
					const result = await $.process.run(
						["prompt-tutor", "capture", "--harness", "claude-code", "--cwd", cwd],
						{ stdin: text, timeoutMs: CAPTURE_TIMEOUT_MS },
					);
					if (result.exitCode !== 0) {
						failed = true;
						$.ui.status(FAILURE_STATUS);
					} else if (failed) {
						failed = false;
						$.ui.status(undefined);
					}
				} catch {
					failed = true;
					try {
						$.ui.status(FAILURE_STATUS);
					} catch {}
				}
			});
		}
		return next(e);
	});
}
