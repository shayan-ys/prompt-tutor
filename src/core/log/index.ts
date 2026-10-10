import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { writeFileAtomic } from "../fsx.ts";
import { listMonthFiles, listMonths, readMonth } from "../store.ts";
import type { Config, PromptRecord, Scope } from "../types.ts";
import { renderMonthPage, renderStubPage } from "./render.ts";

function logDirectory(config: Config, scope: Scope | null): string {
	if (scope) return join(scope.store, "log");
	if (config.scopes.length > 1) return config.allScopesLog;
	if (config.scopes.length === 1) return join(config.scopes[0].store, "log");
	throw new Error("Cannot resolve a Review log without a configured Scope");
}

export function stubUrl(
	config: Config,
	scope: Scope | null,
	id: string,
): string {
	return pathToFileURL(join(logDirectory(config, scope), "r", `${id}.html`))
		.href;
}

export async function writeStubs(
	config: Config,
	scope: Scope,
	record: PromptRecord,
): Promise<void> {
	const page = renderStubPage(record.log_month, record.id);
	const writes = [
		writeFileAtomic(join(scope.store, "log", "r", `${record.id}.html`), page),
	];
	if (config.scopes.length > 1) {
		writes.push(
			writeFileAtomic(
				join(config.allScopesLog, "r", `${record.id}.html`),
				page,
			),
		);
	}
	await Promise.all(writes);
}

interface MonthFile {
	name: string;
	mtimeMs: number;
}

async function fileSignature(
	scopes: readonly Scope[],
	month: string,
): Promise<string> {
	const listings = await Promise.all(
		scopes.map(async (scope) => {
			const files: MonthFile[] = await listMonthFiles(
				join(scope.store, "prompts", month),
			);
			files.sort((a, b) =>
				a.name < b.name ? -1 : a.name > b.name ? 1 : a.mtimeMs - b.mtimeMs,
			);
			return {
				scope: scope.name,
				files: files.map(({ name, mtimeMs }) => [name, mtimeMs]),
			};
		}),
	);
	return JSON.stringify(listings);
}

function adjacentMonths(
	months: readonly string[],
	month: string,
): { previousMonth?: string; nextMonth?: string } {
	const earlier = months.filter((candidate) => candidate < month);
	const later = months.filter((candidate) => candidate > month);
	return {
		...(earlier.length > 0
			? { previousMonth: earlier[earlier.length - 1] }
			: {}),
		...(later.length > 0 ? { nextMonth: later[0] } : {}),
	};
}

async function monthsForScopes(scopes: readonly Scope[]): Promise<string[]> {
	const monthsByScope = await Promise.all(
		scopes.map((scope) => listMonths(scope.store)),
	);
	return [...new Set(monthsByScope.flat())].sort();
}

async function rebuildScopePage(scope: Scope, month: string): Promise<void> {
	const destination = join(scope.store, "log", `${month}.html`);
	for (;;) {
		const before = await fileSignature([scope], month);
		const [records, months] = await Promise.all([
			readMonth(scope.store, month),
			listMonths(scope.store),
		]);
		const navigation = adjacentMonths(months, month);
		const html = renderMonthPage({
			month,
			records,
			scopes: [scope],
			allScopes: false,
			...navigation,
		});
		await writeFileAtomic(destination, html);
		if (before === (await fileSignature([scope], month))) return;
	}
}

async function rebuildAllScopesPage(
	config: Config,
	month: string,
): Promise<void> {
	const scopes = config.scopes;
	const destination = join(config.allScopesLog, `${month}.html`);
	for (;;) {
		const before = await fileSignature(scopes, month);
		const [recordsByScope, months] = await Promise.all([
			Promise.all(scopes.map((scope) => readMonth(scope.store, month))),
			monthsForScopes(scopes),
		]);
		const records = recordsByScope.flat();
		const navigation = adjacentMonths(months, month);
		const html = renderMonthPage({
			month,
			records,
			scopes,
			allScopes: true,
			...navigation,
		});
		await writeFileAtomic(destination, html);
		if (before === (await fileSignature(scopes, month))) return;
	}
}

export async function rebuildMonth(
	config: Config,
	scope: Scope,
	month: string,
): Promise<void> {
	await rebuildScopePage(scope, month);
	if (config.scopes.length > 1) await rebuildAllScopesPage(config, month);
}
