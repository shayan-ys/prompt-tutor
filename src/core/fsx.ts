import { randomUUID } from "node:crypto";
import { type FileHandle, mkdir, open, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export async function writeFileAtomic(
	path: string,
	data: string,
): Promise<void> {
	const directory = dirname(path);
	await mkdir(directory, { recursive: true });
	const temporaryPath = join(
		directory,
		`.${basename(path)}.${randomUUID()}.tmp`,
	);
	let handle: FileHandle | undefined;
	try {
		handle = await open(temporaryPath, "wx", 0o600);
		await handle.writeFile(data, "utf8");
		await handle.close();
		handle = undefined;
		await rename(temporaryPath, path);
	} catch (error) {
		if (handle) await handle.close().catch(() => undefined);
		await unlink(temporaryPath).catch(() => undefined);
		throw error;
	}
}
