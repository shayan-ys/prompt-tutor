// Shared data contract for prompt-tutor. Every module codes against these types.
// Core must not import anything from src/omp/ or from @oh-my-pi/*.

export const FORMAT_VERSION = 1 as const;

export type Category = "spelling" | "grammar" | "fluency";

/** One language error. `start`/`end` are offsets into `PromptRecord.text`, resolved by code from `quote`. */
export interface Finding {
	quote: string;
	fix: string;
	category: Category;
	why: string;
	/** Free-text 2–5 word name of the kind of error, written by the grader. */
	kind: string;
	start: number;
	end: number;
}

export interface Review {
	findings: Finding[];
	/** null exactly when findings is empty. */
	rewrite: string | null;
	/** null exactly when findings is empty. */
	tip: string | null;
}

/** Grader details written by code, never by the model. */
export interface GraderInfo {
	model: string;
	requested_reasoning: string;
	/** Short hash of the grader prompt text plus the submit_review schema. */
	prompt_hash: string;
	/** 1, or 2 after a retry. */
	attempts: number;
}

export type PromptState = "pending" | "reviewed" | "skipped" | "failed";
export type SkipReason = "too_long" | "nothing_to_review";

/**
 * One Prompt and its Review: `<store>/prompts/<log_month>/<id>.json`, written to a temp file then renamed.
 * Only the preprocessed text is stored (slash token removed, fenced code replaced by `[code]`).
 */
export interface PromptRecord {
	version: typeof FORMAT_VERSION;
	/** Sortable and unique: `<UTC yyyymmddThhmmssSSS>-<6 hex>`, e.g. `20261008T141502123-a1b2c3`. */
	id: string;
	scope: string;
	/** omp profile name; the unnamed profile is `default`. Claude Code records store `claude-code`. */
	profile: string;
	/** Harness that captured the Prompt; absent means omp. */
	harness?: "claude-code";
	cwd: string;
	/** ISO 8601 UTC with milliseconds. */
	captured_at: string;
	/** Local UTC offset at capture, in minutes east of UTC (e.g. -240 for EDT). */
	utc_offset_minutes: number;
	/** `YYYY-MM` in local time at capture; fixes the Review log page forever. */
	log_month: string;
	/** Preprocessed Prompt text: what the grader saw and what offsets refer to. */
	text: string;
	/** Word count after preprocessing and URL removal. */
	word_count: number;
	state: PromptState;
	skip_reason?: SkipReason;
	review?: Review;
	grader?: GraderInfo;
	/** Short human-readable reason when state is `failed`. */
	failure?: string;
	/** ISO 8601 UTC, set when the state leaves `pending`. */
	settled_at?: string;
}

/** One `when` entry: all keys present must match (AND). Entries are ORed. */
export interface Condition {
	profile?: string;
	/** Glob, `~` expanded; matched against the cwd's realpath; `dir/**` also matches `dir`. */
	cwd?: string;
}

export interface Scope {
	name: string;
	/** Position in the config's scopes list; fixes badge colour in the all-Scopes log. */
	index: number;
	/** Absolute store directory. */
	store: string;
	/** Empty list = matches everything. */
	when: Condition[];
	/** Profile whose sessions may run this Scope's Digest; null = any session resolving to this Scope. */
	digestProfile: string | null;
	/** The only omp profile allowed to drain this Scope's Claude Code records; null = none. */
	reviewProfile: string | null;
}

export interface Config {
	scopes: Scope[];
	/** Absolute directory of the all-Scopes Review log; written only when scopes.length >= 2. */
	allScopesLog: string;
	/** Number of local Review log months to retain, or null to keep everything. */
	keepMonths: number | null;
	/** Language used for Review explanations and Digest prose; English remains the target. */
	explanationLanguage: string;
	/** Absolute config path, or null when no config file exists (one Scope named `default`). */
	path: string | null;
}

export type ConfigResult =
	| { ok: true; config: Config }
	| { ok: false; error: string; path: string };

/** The one port an adapter supplies: a single model call with only what core gives it. */
export interface GraderTool {
	name: string;
	description: string;
	strict?: boolean;
	parameters: Record<string, unknown>;
}

export interface GraderRequest {
	system: string;
	user: string;
	tool: GraderTool;
}

export interface GraderResponse {
	/** Arguments of the forced tool call, when the provider returned one. */
	toolArgs?: unknown;
	/** Plain assistant text, used only when no tool call came back. */
	text?: string;
	/** Resolved model id, e.g. `anthropic/claude-sonnet-4-5`. */
	model: string;
	requestedReasoning: string;
}

export interface Grader {
	call(request: GraderRequest): Promise<GraderResponse>;
}

export interface CaptureInput {
	text: string;
	profile: string;
	cwd: string;
	now: Date;
	/** Absent means omp. */
	harness?: "claude-code";
}

export type CaptureResult =
	| { kind: "config_error"; error: string }
	| { kind: "no_scope" }
	/** Record already written (pending, or skipped) with stubs and the month's log rebuilt. */
	| { kind: "captured"; record: PromptRecord; scope: Scope; config: Config };

/** Final state of one Prompt after `review`, or right after capture for skips. */
export interface Outcome {
	record: PromptRecord;
}
