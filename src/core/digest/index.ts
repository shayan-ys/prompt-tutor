import { randomUUID } from "node:crypto";
import {
	access,
	mkdir,
	open,
	readdir,
	readFile,
	stat,
	unlink,
} from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "../config.ts";
import { writeFileAtomic } from "../fsx.ts";
import { resolveScope } from "../scope.ts";
import { listMonths, readMonth } from "../store.ts";
import type {
	Config,
	Grader,
	GraderRequest,
	GraderTool,
	PromptRecord,
	Scope,
} from "../types.ts";
import { FORMAT_VERSION } from "../types.ts";
import { renderDigest } from "./render.ts";
import type {
	DigestArchive,
	DigestFinding,
	DigestGraderVersion,
	DigestPattern,
	DigestStats,
} from "./types.ts";

const CATEGORY_ORDER = ["spelling", "grammar", "fluency"] as const;
const LOCK_STALE_AFTER_MS = 10 * 60 * 1000;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export const DIGEST_PROMPT = `You are an English tutor analysing stored language Findings from one week. You receive no full Prompts and no session context.

Group every supplied Finding id into exactly one Pattern. Every id must appear once: do not omit, duplicate, or invent ids. A Pattern describes one underlying language rule or error. The Findings' free-text kinds are hints, not stable labels: different kinds can describe the same Pattern, and one kind can cover different Patterns. Group by the language issue shown by the quote, fix, and containing sentence. Reuse a prior Pattern id exactly when the underlying issue is the same; otherwise invent a short, stable kebab-case id. Do not match by name alone.

For each Pattern provide a concise name and a short, accurate rule. Write a brief lesson about the most important one or two Patterns, using corrected sentences drawn from the supplied Findings and ending with one thing to practise. If there are no Findings, say that no language errors were found and suggest a simple way to keep the prompts clear; do not invent errors. Write one concise paragraph for what to focus on next. Keep the lesson under 120 words and the focus paragraph under 60 words. Return the complete result using the required tool.`;

export const DIGEST_TOOL: GraderTool = {
	name: "submit_digest",
	description:
		"Submit the grouped Patterns, brief lesson, and focus paragraph for this weekly Digest.",
	strict: true,
	parameters: {
		type: "object",
		additionalProperties: false,
		properties: {
			patterns: {
				type: "array",
				items: {
					type: "object",
					additionalProperties: false,
					properties: {
						id: { type: "string", minLength: 1 },
						name: { type: "string", minLength: 1 },
						rule: { type: "string", minLength: 1 },
						findingIds: { type: "array", items: { type: "string" } },
					},
					required: ["id", "name", "rule", "findingIds"],
				},
			},
			lesson: { type: "string", minLength: 1 },
			focus: { type: "string", minLength: 1 },
		},
		required: ["patterns", "lesson", "focus"],
	},
};

interface DigestInput {
	id: string;
	sentence: string;
	category: DigestFinding["category"];
	kind: string;
	quote: string;
	fix: string;
	why: string;
}

interface ModelPattern {
	id: string;
	name: string;
	rule: string;
	findingIds: string[];
}

interface ValidDigest {
	patterns: ModelPattern[];
	lesson: string;
	focus: string;
}

interface History {
	byWeek: Map<string, DigestArchive>;
	priorDigests: DigestArchive[];
	htmlWeeks: string[];
}

function localDate(date: Date): string {
	const year = String(date.getFullYear()).padStart(4, "0");
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}

function latestEndedFriday(now: Date): Date {
	if (!Number.isFinite(now.getTime())) throw new Error("Invalid Digest date");
	const daysSinceFriday = (now.getDay() - 5 + 7) % 7;
	let friday = new Date(
		now.getFullYear(),
		now.getMonth(),
		now.getDate() - daysSinceFriday,
		12,
		0,
		0,
		0,
	);
	if (friday.getTime() > now.getTime()) {
		friday = new Date(
			friday.getFullYear(),
			friday.getMonth(),
			friday.getDate() - 7,
			12,
			0,
			0,
			0,
		);
	}
	return friday;
}

function previousFriday(friday: Date): Date {
	return new Date(
		friday.getFullYear(),
		friday.getMonth(),
		friday.getDate() - 7,
		12,
		0,
		0,
		0,
	);
}

function previousWeekName(week: string): string {
	const [year, month, day] = week.split("-").map(Number);
	const previous = new Date(Date.UTC(year, month - 1, day - 7));
	return `${previous.getUTCFullYear()}-${String(previous.getUTCMonth() + 1).padStart(2, "0")}-${String(previous.getUTCDate()).padStart(2, "0")}`;
}

function scopeMatches(left: Scope | null, right: Scope): boolean {
	return (
		left !== null && left.name === right.name && left.store === right.store
	);
}

async function pathExists(filePath: string): Promise<boolean> {
	try {
		await access(filePath);
		return true;
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") return false;
		throw error;
	}
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return (
		error instanceof Error &&
		"code" in error &&
		typeof (error as NodeJS.ErrnoException).code === "string"
	);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Return the stale configured Scopes this session is allowed to digest. */
export async function dueDigests(
	at: { profile: string; cwd: string; now: Date },
	opts?: { env?: NodeJS.ProcessEnv },
): Promise<Scope[]> {
	const result = await loadConfig({ env: opts?.env });
	if (!result.ok) return [];

	const week = localDate(latestEndedFriday(at.now));
	const resolved = resolveScope(result.config, {
		profile: at.profile,
		cwd: at.cwd,
	});
	const candidates = result.config.scopes.filter((scope) => {
		if (scope.digestProfile === at.profile) return true;
		return scope.digestProfile === null && scopeMatches(resolved, scope);
	});
	const eligible: Scope[] = [];
	for (const scope of candidates) {
		const digestPath = path.join(scope.store, "digests", `${week}.json`);
		if (!(await pathExists(digestPath))) eligible.push(scope);
	}
	return eligible;
}

function capturedWithin(record: PromptRecord, start: Date, end: Date): boolean {
	const capturedAt = Date.parse(record.captured_at);
	return (
		Number.isFinite(capturedAt) &&
		capturedAt >= start.getTime() &&
		capturedAt < end.getTime()
	);
}

async function readWeekRecords(
	scope: Scope,
	start: Date,
	end: Date,
): Promise<PromptRecord[]> {
	const firstMonth = localDate(start).slice(0, 7);
	const lastMonth = localDate(end).slice(0, 7);
	const months = await listMonths(scope.store);
	const selectedMonths = months.filter(
		(month) => month >= firstMonth && month <= lastMonth,
	);
	const records = await Promise.all(
		selectedMonths.map((month) => readMonth(scope.store, month)),
	);
	return records
		.flat()
		.filter(
			(record) =>
				record.scope === scope.name && capturedWithin(record, start, end),
		);
}

function sentenceFor(text: string, start: number, end: number): string {
	const findingStart = Math.max(0, Math.min(text.length, start));
	const findingEnd = Math.max(findingStart, Math.min(text.length, end));
	let sentenceStart = 0;
	for (let index = findingStart - 1; index >= 0; index -= 1) {
		if (".!?\n".includes(text[index])) {
			sentenceStart = index + 1;
			break;
		}
	}
	let sentenceEnd = text.length;
	for (let index = findingEnd; index < text.length; index += 1) {
		if (".!?\n".includes(text[index])) {
			sentenceEnd = index + 1;
			break;
		}
	}
	return text.slice(sentenceStart, sentenceEnd).trim();
}

function collectFindings(records: PromptRecord[]): DigestFinding[] {
	const findings: DigestFinding[] = [];
	for (const record of records) {
		if (record.state !== "reviewed" || !record.review) continue;
		record.review.findings.forEach((finding, index) => {
			findings.push({
				id: `${record.id}:${index + 1}`,
				promptId: record.id,
				capturedAt: record.captured_at,
				sentence: sentenceFor(record.text, finding.start, finding.end),
				category: finding.category,
				kind: finding.kind,
				quote: finding.quote,
				fix: finding.fix,
				why: finding.why,
			});
		});
	}
	return findings;
}

function graderVersions(records: PromptRecord[]): DigestGraderVersion[] {
	const versions = new Map<string, DigestGraderVersion>();
	for (const record of records) {
		if (!record.grader?.model || !record.grader.prompt_hash) continue;
		const version = {
			model: record.grader.model,
			promptHash: record.grader.prompt_hash,
		};
		versions.set(`${version.model}\u0000${version.promptHash}`, version);
	}
	return [...versions.values()].sort(
		(a, b) =>
			a.model.localeCompare(b.model) ||
			a.promptHash.localeCompare(b.promptHash),
	);
}

function makeStats(
	records: PromptRecord[],
	findings: DigestFinding[],
): DigestStats {
	const reviewed = records.filter(
		(record) => record.state === "reviewed" && record.review,
	);
	const clean = reviewed.filter(
		(record) => record.review?.findings.length === 0,
	).length;
	const categories = { spelling: 0, grammar: 0, fluency: 0 };
	for (const finding of findings) categories[finding.category] += 1;
	const notReviewed = {
		tooLong: records.filter(
			(record) =>
				record.state === "skipped" && record.skip_reason === "too_long",
		).length,
		nothingToReview: records.filter(
			(record) =>
				record.state === "skipped" &&
				record.skip_reason === "nothing_to_review",
		).length,
		failed: records.filter((record) => record.state === "failed").length,
		pending: records.filter((record) => record.state === "pending").length,
	};
	return {
		prompts: records.length,
		reviewed: reviewed.length,
		clean,
		cleanPercent:
			reviewed.length === 0 ? 0 : Math.round((100 * clean) / reviewed.length),
		categories,
		notReviewed,
	};
}

function asObject(value: unknown): Record<string, unknown> | null {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		return null;
	return value as Record<string, unknown>;
}

function validateDigest(
	value: unknown,
	expectedIds: Set<string>,
): { digest?: ValidDigest; problems: string[] } {
	const problems: string[] = [];
	const root = asObject(value);
	if (!root) return { problems: ["The tool arguments must be an object."] };
	if (typeof root.lesson !== "string" || root.lesson.trim().length === 0)
		problems.push("lesson must be a non-empty string.");
	if (typeof root.focus !== "string" || root.focus.trim().length === 0)
		problems.push("focus must be a non-empty string.");
	if (!Array.isArray(root.patterns))
		problems.push("patterns must be an array.");

	const patterns: ModelPattern[] = [];
	const seenPatternIds = new Set<string>();
	const assignedFindings = new Set<string>();
	if (Array.isArray(root.patterns)) {
		root.patterns.forEach((rawPattern, index) => {
			const pattern = asObject(rawPattern);
			if (!pattern) {
				problems.push(`Pattern ${index + 1} must be an object.`);
				return;
			}
			const id = typeof pattern.id === "string" ? pattern.id.trim() : "";
			const name = typeof pattern.name === "string" ? pattern.name.trim() : "";
			const rule = typeof pattern.rule === "string" ? pattern.rule.trim() : "";
			if (id.length === 0)
				problems.push(`Pattern ${index + 1} needs a non-empty id.`);
			else if (seenPatternIds.has(id))
				problems.push(`Pattern id ${id} appears more than once.`);
			else seenPatternIds.add(id);
			if (name.length === 0)
				problems.push(`Pattern ${index + 1} needs a non-empty name.`);
			if (rule.length === 0)
				problems.push(`Pattern ${index + 1} needs a non-empty rule.`);
			if (
				!Array.isArray(pattern.findingIds) ||
				pattern.findingIds.some((findingId) => typeof findingId !== "string")
			) {
				problems.push(
					`Pattern ${index + 1} findingIds must be an array of strings.`,
				);
				return;
			}
			const findingIds = pattern.findingIds as string[];
			if (findingIds.length === 0)
				problems.push(
					`Pattern ${index + 1} must contain at least one Finding.`,
				);
			for (const findingId of findingIds) {
				if (!expectedIds.has(findingId))
					problems.push(`Unknown Finding id ${findingId}.`);
				if (assignedFindings.has(findingId))
					problems.push(`Finding id ${findingId} appears more than once.`);
				assignedFindings.add(findingId);
			}
			if (id && name && rule)
				patterns.push({ id, name, rule, findingIds: [...findingIds] });
		});
	}
	for (const id of expectedIds) {
		if (!assignedFindings.has(id)) problems.push(`Missing Finding id ${id}.`);
	}

	if (problems.length > 0) return { problems };
	return {
		digest: {
			patterns,
			lesson: (root.lesson as string).trim(),
			focus: (root.focus as string).trim(),
		},
		problems: [],
	};
}

function modelInput(
	findings: DigestFinding[],
	history: DigestArchive[],
): string {
	const priorDigests = history
		.slice(0, 6)
		.toSorted((a, b) => a.week.localeCompare(b.week))
		.map((digest) => ({
			week: digest.week,
			patterns: digest.patterns.map(
				({ id, name, rule, categories, count }) => ({
					id,
					name,
					rule,
					categories,
					count,
				}),
			),
		}));
	const modelFindings: DigestInput[] = findings.map(
		({ id, sentence, category, kind, quote, fix, why }) => ({
			id,
			sentence,
			category,
			kind,
			quote,
			fix,
			why,
		}),
	);
	return JSON.stringify({ findings: modelFindings, priorDigests });
}

async function askForDigest(
	grader: Grader,
	findings: DigestFinding[],
	history: DigestArchive[],
): Promise<{ digest?: ValidDigest; error?: string }> {
	const initialUser = modelInput(findings, history);
	const expectedIds = new Set(findings.map(({ id }) => id));
	let retryProblems = "";
	let lastError = "The grader did not return valid Digest tool arguments.";
	for (let attempt = 0; attempt < 2; attempt += 1) {
		const request: GraderRequest = {
			system: DIGEST_PROMPT,
			user:
				attempt === 0
					? initialUser
					: `${initialUser}\n\nThe prior result was invalid: ${retryProblems}. Return a corrected complete result, using every supplied Finding id exactly once.`,
			tool: DIGEST_TOOL,
		};
		try {
			const response = await grader.call(request);
			const validation = validateDigest(response.toolArgs, expectedIds);
			if (validation.digest) return { digest: validation.digest };
			retryProblems = validation.problems.join(" ");
			lastError = `Invalid Digest response: ${retryProblems}`;
		} catch (error) {
			lastError = `Digest grader call failed: ${errorMessage(error)}`;
			retryProblems = lastError;
		}
	}
	return { error: lastError };
}

function historyArchive(
	value: unknown,
	expectedWeek: string,
): DigestArchive | null {
	const root = asObject(value);
	if (!root || root.version !== FORMAT_VERSION || root.week !== expectedWeek)
		return null;
	if (
		!Array.isArray(root.patterns) ||
		!asObject(root.stats) ||
		!Array.isArray(root.graderVersions)
	)
		return null;
	return root as unknown as DigestArchive;
}

async function readHistory(
	store: string,
	currentWeek: string,
): Promise<History> {
	const directory = path.join(store, "digests");
	let entries: string[];
	try {
		entries = await readdir(directory);
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") {
			return { byWeek: new Map(), priorDigests: [], htmlWeeks: [] };
		}
		throw error;
	}
	const jsonWeeks = entries
		.filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/u.test(name))
		.map((name) => name.slice(0, -5))
		.filter((week) => week < currentWeek)
		.toSorted((a, b) => b.localeCompare(a));
	const htmlWeeks = entries
		.filter((name) => /^\d{4}-\d{2}-\d{2}\.html$/u.test(name))
		.map((name) => name.slice(0, -5))
		.toSorted((a, b) => a.localeCompare(b));
	const previousWeek = previousWeekName(currentWeek);
	const toRead = new Set(jsonWeeks.slice(0, 7));
	if (jsonWeeks.includes(previousWeek)) toRead.add(previousWeek);
	const loaded = await Promise.all(
		[...toRead].map(async (week) => {
			try {
				const content = await readFile(
					path.join(directory, `${week}.json`),
					"utf8",
				);
				return [week, historyArchive(JSON.parse(content), week)] as const;
			} catch {
				return [week, null] as const;
			}
		}),
	);
	const byWeek = new Map<string, DigestArchive>();
	for (const [week, digest] of loaded) {
		if (digest) byWeek.set(week, digest);
	}
	const priorDigests = [...byWeek.values()].toSorted((a, b) =>
		b.week.localeCompare(a.week),
	);
	return { byWeek, priorDigests, htmlWeeks };
}

function uniqueCategories(
	findings: DigestFinding[],
): DigestFinding["category"][] {
	return [...new Set(findings.map(({ category }) => category))].sort(
		(a, b) => CATEGORY_ORDER.indexOf(a) - CATEGORY_ORDER.indexOf(b),
	);
}

function examplesFor(findings: DigestFinding[]): DigestFinding[] {
	const examples: DigestFinding[] = [];
	const seenQuotes = new Set<string>();
	const newestFirst = findings.toSorted(
		(a, b) =>
			b.capturedAt.localeCompare(a.capturedAt) || b.id.localeCompare(a.id),
	);
	for (const finding of newestFirst) {
		const quote = finding.quote.toLowerCase();
		if (seenQuotes.has(quote)) continue;
		seenQuotes.add(quote);
		examples.push(finding);
		if (examples.length === 2) break;
	}
	return examples;
}

function makePatterns(
	modelPatterns: ModelPattern[],
	findings: DigestFinding[],
	week: string,
	history: History,
): { patterns: DigestPattern[]; oneOffs: DigestFinding[] } {
	const findingById = new Map(findings.map((finding) => [finding.id, finding]));
	const previousWeek = history.byWeek.get(previousWeekName(week));
	const recentWeeks = history.priorDigests.slice(0, 5).toReversed();
	const patterns: DigestPattern[] = [];
	const oneOffs: DigestFinding[] = [];
	for (const modelPattern of modelPatterns) {
		const groupedFindings = modelPattern.findingIds.flatMap((id) => {
			const finding = findingById.get(id);
			return finding ? [finding] : [];
		});
		const previousPattern = previousWeek?.patterns.find(
			(pattern) => pattern.id === modelPattern.id,
		);
		const recurring =
			groupedFindings.length >= 2 || previousPattern !== undefined;
		const pattern: DigestPattern = {
			id: modelPattern.id,
			name: modelPattern.name,
			rule: modelPattern.rule,
			categories: uniqueCategories(groupedFindings),
			count: groupedFindings.length,
			findingIds: [...modelPattern.findingIds],
			examples: examplesFor(groupedFindings),
			recurring,
			previousCount: previousPattern?.count ?? null,
			trend: [
				...recentWeeks.map((digest) => ({
					week: digest.week,
					count:
						digest.patterns.find((pattern) => pattern.id === modelPattern.id)
							?.count ?? 0,
				})),
				{ week, count: groupedFindings.length },
			],
		};
		patterns.push(pattern);
		if (!recurring) oneOffs.push(...groupedFindings);
	}
	patterns.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
	oneOffs.sort(
		(a, b) =>
			b.capturedAt.localeCompare(a.capturedAt) || b.id.localeCompare(a.id),
	);
	return { patterns, oneOffs };
}

function changedGrader(
	current: DigestGraderVersion[],
	previous: DigestArchive | undefined,
): { from: DigestGraderVersion[]; to: DigestGraderVersion[] } | null {
	if (!previous) return null;
	const versionKey = ({ model, promptHash }: DigestGraderVersion) =>
		`${model}\u0000${promptHash}`;
	const currentKeys = current.map(versionKey).toSorted();
	const previousKeys = previous.graderVersions.map(versionKey).toSorted();
	if (
		currentKeys.length === previousKeys.length &&
		currentKeys.every((key, index) => key === previousKeys[index])
	)
		return null;
	return { from: previous.graderVersions, to: current };
}

function baseCopy(html: string): string {
	return html.replace("<head>", '<head>\n<base href="digests/">');
}

async function acquireLock(lockPath: string): Promise<string | null> {
	const token = `${process.pid}:${randomUUID()}`;
	for (let attempt = 0; attempt < 3; attempt += 1) {
		try {
			const handle = await open(lockPath, "wx", 0o600);
			try {
				await handle.writeFile(token, "utf8");
			} finally {
				await handle.close();
			}
			return token;
		} catch (error) {
			if (!isNodeError(error) || error.code !== "EEXIST") throw error;
			try {
				const existing = await stat(lockPath);
				if (Date.now() - existing.mtimeMs < LOCK_STALE_AFTER_MS) return null;
				await unlink(lockPath);
			} catch (statOrUnlinkError) {
				if (
					isNodeError(statOrUnlinkError) &&
					statOrUnlinkError.code === "ENOENT"
				)
					continue;
				throw statOrUnlinkError;
			}
		}
	}
	return null;
}

async function releaseLock(lockPath: string, token: string): Promise<void> {
	try {
		const current = await readFile(lockPath, "utf8");
		if (current === token) await unlink(lockPath);
	} catch (error) {
		if (!isNodeError(error) || error.code !== "ENOENT") throw error;
	}
}

function emptyDigest(
	week: string,
	scope: Scope,
	from: Date,
	stats: DigestStats,
	versions: DigestGraderVersion[],
): DigestArchive {
	return {
		version: FORMAT_VERSION,
		week,
		scope: scope.name,
		from: localDate(from),
		stats,
		graderVersions: versions,
		lesson: null,
		focus: null,
		patterns: [],
		oneOffs: [],
	};
}

/** Generate the current weekly Digest behind an exclusive, expiring Scope lock. */
export async function runDigest(
	scope: Scope,
	_config: Config,
	grader: Grader,
	now: Date,
): Promise<
	| { kind: "written"; htmlPath: string; week: string }
	| { kind: "empty"; week: string }
	| { kind: "locked" }
	| { kind: "failed"; error: string }
> {
	const digestDirectory = path.join(scope.store, "digests");
	const lockPath = path.join(digestDirectory, ".lock");
	let lockToken: string | null = null;
	try {
		const ending = latestEndedFriday(now);
		const week = localDate(ending);
		const start = previousFriday(ending);
		await mkdir(digestDirectory, { recursive: true });
		lockToken = await acquireLock(lockPath);
		if (lockToken === null) return { kind: "locked" };

		const records = await readWeekRecords(scope, start, ending);
		const findings = collectFindings(records);
		const stats = makeStats(records, findings);
		const versions = graderVersions(records);
		const jsonPath = path.join(digestDirectory, `${week}.json`);
		if (stats.reviewed === 0) {
			await writeFileAtomic(
				jsonPath,
				`${JSON.stringify(emptyDigest(week, scope, start, stats, versions), null, 2)}\n`,
			);
			return { kind: "empty", week };
		}

		const history = await readHistory(scope.store, week);
		const modelResult = await askForDigest(
			grader,
			findings,
			history.priorDigests,
		);
		if (!modelResult.digest)
			return {
				kind: "failed",
				error:
					modelResult.error ?? "The Digest grader returned invalid output.",
			};
		const grouped = makePatterns(
			modelResult.digest.patterns,
			findings,
			week,
			history,
		);
		const archive: DigestArchive = {
			version: FORMAT_VERSION,
			week,
			scope: scope.name,
			from: localDate(start),
			stats,
			graderVersions: versions,
			lesson: modelResult.digest.lesson,
			focus: modelResult.digest.focus,
			patterns: grouped.patterns,
			oneOffs: grouped.oneOffs,
		};
		const previousWeek = history.byWeek.get(previousWeekName(week)) ?? null;
		const previousArchive =
			history.htmlWeeks
				.filter((candidate) => candidate < week)
				.toSorted()
				.at(-1) ?? null;
		const graderChange = changedGrader(versions, history.priorDigests[0]);
		const archiveWeeks = [...history.htmlWeeks, week];
		const html = renderDigest(archive, {
			previousWeek,
			previousArchive,
			archiveWeeks,
			graderChanged: graderChange,
		});
		const htmlPath = path.join(digestDirectory, `${week}.html`);
		await writeFileAtomic(htmlPath, html);
		await writeFileAtomic(jsonPath, `${JSON.stringify(archive, null, 2)}\n`);
		await writeFileAtomic(
			path.join(scope.store, "digest.html"),
			baseCopy(html),
		);
		return { kind: "written", htmlPath, week };
	} catch (error) {
		return {
			kind: "failed",
			error: error instanceof Error ? error.message : String(error),
		};
	} finally {
		if (lockToken !== null) {
			try {
				await releaseLock(lockPath, lockToken);
			} catch {
				// A later run can recover an uncleared lock after the stale timeout.
			}
		}
	}
}

export { renderDigest } from "./render.ts";
