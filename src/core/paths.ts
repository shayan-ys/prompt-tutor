import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

type Env = NodeJS.ProcessEnv;

function expandHomeWithEnv(path: string, env: Env): string {
	const home = env.HOME || homedir();
	if (path === "~") return home;
	if (path.startsWith("~/")) return join(home, path.slice(2));
	return path;
}

export function expandHome(path: string): string {
	return expandHomeWithEnv(path, process.env);
}

export function configPath(env: Env = process.env): string {
	const base = env.XDG_CONFIG_HOME
		? expandHomeWithEnv(env.XDG_CONFIG_HOME, env)
		: join(env.HOME || homedir(), ".config");
	return resolve(base, "prompt-tutor", "config.yml");
}

export function dataHome(env: Env = process.env): string {
	const base = env.XDG_DATA_HOME
		? expandHomeWithEnv(env.XDG_DATA_HOME, env)
		: join(env.HOME || homedir(), ".local", "share");
	return resolve(base, "prompt-tutor");
}

export function absoluteExpandedPath(
	path: string,
	env: Env,
	relativeTo: string,
): string {
	const expanded = expandHomeWithEnv(path, env);
	return resolve(isAbsolute(expanded) ? expanded : join(relativeTo, expanded));
}
