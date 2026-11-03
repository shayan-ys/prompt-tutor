import { randomUUID } from "node:crypto";
import { access, mkdir, open, readFile, stat, unlink } from "node:fs/promises";
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
import { exportDigests } from "./export.ts";
import {
	baseCopy,
	type History,
	previousWeekName,
	readHistory,
	renderContext,
} from "./history.ts";
import { renderDigest } from "./render.ts";
import { digestTargets } from "./targets.ts";
import type {
	DigestArchive,
	DigestFinding,
	DigestGraderVersion,
	DigestPattern,
	DigestPractice,
	DigestStats,
	DigestTarget,
} from "./types.ts";

const CATEGORY_ORDER = ["spelling", "grammar", "fluency"] as const;
const LOCK_STALE_AFTER_MS = 10 * 60 * 1000;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
/** Patterns that get an explanation, tip, and practice; caps the Digest's output in a busy week. */
const TAUGHT_PATTERNS = 8;

export const DIGEST_PROMPT = `You are an experienced English teacher writing weekly written feedback for one adult learner. The learner is advanced but makes recurring mistakes when typing quickly to AI coding agents. You receive one week of language Findings (each with its containing sentence, the quoted error, the fix, and a short reason), this week's counts, and the Patterns, counts, and focus of earlier weeks. You receive no full Prompts and no session context.

GROUPING. Group every supplied Finding id into exactly one Pattern. Every id must appear once: do not omit, duplicate, or invent ids. A Pattern describes one underlying language rule or error. The Findings' free-text kinds are hints, not stable labels: different kinds can describe the same Pattern, and one kind can cover different Patterns. Group by the language issue shown by the quote, fix, and containing sentence. Reuse a prior Pattern id exactly when the underlying issue is the same; otherwise invent a short, stable kebab-case id. Do not match by name alone. Prefer teachable Patterns: one rule the learner can learn and check, not a catch-all bucket.

EACH PATTERN. Give a concise name and a one-sentence rule. For each of the ${TAUGHT_PATTERNS} Patterns with the most Findings, among those with two or more, also write:
- explanation: 60 to 150 words, as a teacher talking to this learner. Explain how the rule works, show why the learner's own sentences break it by quoting one or two of them with their corrections, and contrast the wrong and right form. Name a common exception or a confusable case when one exists. Do not lecture with grammar jargon the learner does not need.
- tip: one concrete self-check, under 40 words, that the learner can apply while rereading a prompt before sending it.
- practice: three short exercises. Each is a new sentence, in the same topics and register as the learner's prompts, that contains exactly this Pattern's error, with its corrected answer. Do not copy the learner's sentences.
For every other Pattern, set explanation and tip to empty strings and practice to an empty list. Keep to these limits even in a week with many Findings.

LESSON. Write the teacher's note for the week: 150 to 300 words in two to four short paragraphs separated by blank lines. Open with what improved or held steady, using the counts and earlier weeks when they show it, and say whether last week's focus shows progress. Then teach the two or three Patterns that matter most, ranked by how often they occur and how much they affect clarity, quoting the learner's corrected sentences. Be specific, warm, and honest; do not pad with praise.

FOCUS. One paragraph under 80 words: the single habit to practise next week and how to check it.

If there are no Findings, say that no language errors were found and suggest one way to keep the prompts clear; do not invent errors. Return the complete result using the required tool.`;
export function digestPromptForLanguage(language: string): string {
	if (language.toLowerCase() === "english") return DIGEST_PROMPT;
	return `${DIGEST_PROMPT}\n\nLANGUAGE. English remains the target language. Write Pattern names, rules, explanations and tips, the lesson, and the focus paragraph in ${language}. Keep quoted sentences, corrected example sentences, and practice sentences and answers in English.`;
}

export const DIGEST_TOOL: GraderTool = {
	name: "submit_digest",
	description:
		"Submit the grouped Patterns with their teaching, the teacher's note, and the focus paragraph for this weekly Digest.",
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
						explanation: { type: "string" },
						tip: { type: "string" },
						practice: {
							type: "array",
							items: {
								type: "object",
								additionalProperties: false,
								properties: {
									sentence: { type: "string", minLength: 1 },
									answer: { type: "string", minLength: 1 },
								},
								required: ["sentence", "answer"],
							},
						},
					},
					required: [
						"id",
						"name",
						"rule",
						"findingIds",
						"explanation",
						"tip",
						"practice",
					],
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
	explanation: string;
	tip: string;
	practice: DigestPractice[];
}

interface ValidDigest {
	patterns: ModelPattern[];
	lesson: string;
	focus: string;
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

/** The targets among `targets` whose Digest for the week ending at `now` is not yet written. */
async function staleTargets(
	targets: DigestTarget[],
	now: Date,
): Promise<DigestTarget[]> {
	const week = localDate(latestEndedFriday(now));
	const stale: DigestTarget[] = [];
	for (const target of targets) {
		const digestPath = path.join(target.store, "digests", `${week}.json`);
		if (!(await pathExists(digestPath))) stale.push(target);
	}
	return stale;
}

/**
 * The Digests `allowed` admits: the combined Digest when `combined_digest` names `profile`, or
 * else each Scope's Digest that `allowed` accepts. A combined Digest replaces every per-Scope one.
 */
function permittedTargets(
	config: Config,
	profile: string,
	allowed: (scope: Scope) => boolean,
): DigestTarget[] {
	if (config.combinedDigest !== null)
		return config.combinedDigest.profile === profile
			? digestTargets(config)
			: [];
	return digestTargets(config).filter((target) => allowed(target.sources[0]));
}

/** Return the stale Digests this session is allowed to build. */
export async function dueDigests(
	at: { profile: string; cwd: string; now: Date },
	opts?: { env?: NodeJS.ProcessEnv },
): Promise<DigestTarget[]> {
	const result = await loadConfig({ env: opts?.env });
	if (!result.ok) return [];

	const resolved = resolveScope(result.config, {
		profile: at.profile,
		cwd: at.cwd,
	});
	const candidates = permittedTargets(result.config, at.profile, (scope) => {
		if (scope.digestProfile === at.profile) return true;
		return scope.digestProfile === null && scopeMatches(resolved, scope);
	});
	return staleTargets(candidates, at.now);
}

/**
 * Whether a Drainer of `profile` may build `scope`'s Digest (ADR 0007, amended): the Scope's
 * `digest_profile` is that profile, or it names none and that profile already reviewed the
 * Scope's Prompts, so their Findings reach no new provider. Unlike a session, a Drainer's cwd
 * says nothing about the Scope, so cwd resolution plays no part.
 */
export function drainerMayDigest(scope: Scope, profile: string): boolean {
	return (
		scope.digestProfile === profile ||
		(scope.digestProfile === null && scope.reviewProfile === profile)
	);
}

/** Return the stale Digests of `config` that a Drainer of `profile` may build. */
export function dueDrainerDigests(
	at: { profile: string; now: Date },
	config: Config,
): Promise<DigestTarget[]> {
	return staleTargets(
		permittedTargets(config, at.profile, (scope) =>
			drainerMayDigest(scope, at.profile),
		),
		at.now,
	);
}

function capturedWithin(record: PromptRecord, start: Date, end: Date): boolean {
	const capturedAt = Date.parse(record.captured_at);
	return (
		Number.isFinite(capturedAt) &&
		capturedAt >= start.getTime() &&
		capturedAt < end.getTime()
	);
}

async function readScopeWeek(
	scope: Scope,
	firstMonth: string,
	lastMonth: string,
	start: Date,
	end: Date,
): Promise<PromptRecord[]> {
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

async function readWeekRecords(
	target: DigestTarget,
	start: Date,
	end: Date,
): Promise<PromptRecord[]> {
	const firstMonth = localDate(start).slice(0, 7);
	const lastMonth = localDate(end).slice(0, 7);
	const perScope = await Promise.all(
		target.sources.map((scope) =>
			readScopeWeek(scope, firstMonth, lastMonth, start, end),
		),
	);
	return perScope.flat();
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
			const explanation =
				typeof pattern.explanation === "string"
					? pattern.explanation.trim()
					: null;
			const tip = typeof pattern.tip === "string" ? pattern.tip.trim() : null;
			if (explanation === null || tip === null)
				problems.push(
					`Pattern ${index + 1} needs explanation and tip strings.`,
				);
			const practice: DigestPractice[] = [];
			if (!Array.isArray(pattern.practice))
				problems.push(`Pattern ${index + 1} practice must be an array.`);
			else
				for (const rawExercise of pattern.practice) {
					const exercise = asObject(rawExercise);
					const sentence =
						typeof exercise?.sentence === "string"
							? exercise.sentence.trim()
							: "";
					const answer =
						typeof exercise?.answer === "string" ? exercise.answer.trim() : "";
					if (sentence.length === 0 || answer.length === 0)
						problems.push(
							`Pattern ${index + 1} practice items need a non-empty sentence and answer.`,
						);
					else practice.push({ sentence, answer });
				}
			if (id && name && rule)
				patterns.push({
					id,
					name,
					rule,
					findingIds: [...findingIds],
					explanation: explanation ?? "",
					tip: tip ?? "",
					practice,
				});
		});
	}
	for (const id of expectedIds) {
		if (!assignedFindings.has(id)) problems.push(`Missing Finding id ${id}.`);
	}
	const untaught = patterns
		.filter(({ findingIds }) => findingIds.length >= 2)
		.toSorted((a, b) => b.findingIds.length - a.findingIds.length)
		.slice(0, TAUGHT_PATTERNS)
		.filter(({ explanation, tip }) => !explanation || !tip);
	for (const pattern of untaught)
		problems.push(
			`Pattern ${pattern.id} is among the ${TAUGHT_PATTERNS} largest and needs a non-empty explanation and tip.`,
		);

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
	stats: DigestStats,
	history: DigestArchive[],
): string {
	const counts = (digest: Pick<DigestArchive, "stats">) => ({
		prompts: digest.stats.prompts,
		reviewed: digest.stats.reviewed,
		cleanPercent: digest.stats.cleanPercent,
		categories: digest.stats.categories,
	});
	const priorDigests = history
		.slice(0, 6)
		.toSorted((a, b) => a.week.localeCompare(b.week))
		.map((digest) => ({
			week: digest.week,
			...counts(digest),
			focus: digest.focus,
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
	return JSON.stringify({
		thisWeek: counts({ stats }),
		findings: modelFindings,
		priorDigests,
	});
}

async function askForDigest(
	grader: Grader,
	findings: DigestFinding[],
	stats: DigestStats,
	history: DigestArchive[],
	explanationLanguage: string,
): Promise<{ digest?: ValidDigest; error?: string }> {
	const initialUser = modelInput(findings, stats, history);
	const systemPrompt = digestPromptForLanguage(explanationLanguage);
	const expectedIds = new Set(findings.map(({ id }) => id));
	let retryProblems = "";
	let lastError = "The grader did not return valid Digest tool arguments.";
	for (let attempt = 0; attempt < 2; attempt += 1) {
		const request: GraderRequest = {
			system: systemPrompt,
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
			explanation: modelPattern.explanation,
			tip: modelPattern.tip,
			practice: modelPattern.practice,
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
	target: DigestTarget,
	from: Date,
	stats: DigestStats,
	versions: DigestGraderVersion[],
): DigestArchive {
	return {
		version: FORMAT_VERSION,
		week,
		scope: target.name,
		from: localDate(from),
		stats,
		graderVersions: versions,
		lesson: null,
		focus: null,
		patterns: [],
		oneOffs: [],
	};
}

/** Generate the current weekly Digest behind an exclusive, expiring lock in the target's store. */
export async function runDigest(
	target: DigestTarget,
	config: Config,
	grader: Grader,
	now: Date,
): Promise<
	| { kind: "written"; htmlPath: string; week: string; exportError?: string }
	| { kind: "empty"; week: string }
	| { kind: "current"; week: string }
	| { kind: "locked" }
	| { kind: "failed"; error: string }
> {
	const digestDirectory = path.join(target.store, "digests");
	const lockPath = path.join(digestDirectory, ".lock");
	let lockToken: string | null = null;
	try {
		const ending = latestEndedFriday(now);
		const week = localDate(ending);
		const start = previousFriday(ending);
		await mkdir(digestDirectory, { recursive: true });
		lockToken = await acquireLock(lockPath);
		if (lockToken === null) return { kind: "locked" };

		// `<week>.json` is the completion marker. Another session may have finished this
		// week between our stale check and acquiring the lock, so check again under it.
		const jsonPath = path.join(digestDirectory, `${week}.json`);
		if (await pathExists(jsonPath)) return { kind: "current", week };

		const records = await readWeekRecords(target, start, ending);
		const findings = collectFindings(records);
		const stats = makeStats(records, findings);
		const versions = graderVersions(records);
		if (stats.reviewed === 0) {
			await writeFileAtomic(
				jsonPath,
				`${JSON.stringify(emptyDigest(week, target, start, stats, versions), null, 2)}\n`,
			);
			return { kind: "empty", week };
		}

		const history = await readHistory(target.store, week);
		const modelResult = await askForDigest(
			grader,
			findings,
			stats,
			history.priorDigests,
			config.explanationLanguage,
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
			scope: target.name,
			from: localDate(start),
			stats,
			graderVersions: versions,
			lesson: modelResult.digest.lesson,
			focus: modelResult.digest.focus,
			patterns: grouped.patterns,
			oneOffs: grouped.oneOffs,
		};
		const html = renderDigest(archive, renderContext(week, versions, history));
		const htmlPath = path.join(digestDirectory, `${week}.html`);
		await writeFileAtomic(htmlPath, html);
		await writeFileAtomic(
			path.join(target.store, "digest.html"),
			baseCopy(html),
		);
		// Written last: if an earlier write fails, the week stays stale and the next session retries.
		await writeFileAtomic(jsonPath, `${JSON.stringify(archive, null, 2)}\n`);
		if (config.digestExport === null)
			return { kind: "written", htmlPath, week };
		try {
			await exportDigests(config);
			return { kind: "written", htmlPath, week };
		} catch (error) {
			return {
				kind: "written",
				htmlPath,
				week,
				exportError: errorMessage(error),
			};
		}
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

export { exportDigests } from "./export.ts";
export { renderDigest } from "./render.ts";
