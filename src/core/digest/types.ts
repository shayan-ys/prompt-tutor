import type { Category, Scope } from "../types.ts";

/**
 * What one Digest covers: a single Scope, or every Scope at once (`combined_digest`, ADR 0012).
 * `store` holds `digests/` and `digest.html`; `sources` are the Scopes whose Prompts are read.
 */
export interface DigestTarget {
	name: string;
	store: string;
	sources: Scope[];
}

/** A short exercise the tutor writes: a new sentence with the Pattern's error, and its fix. */
export interface DigestPractice {
	sentence: string;
	answer: string;
}

export interface DigestFinding {
	id: string;
	promptId: string;
	capturedAt: string;
	sentence: string;
	category: Category;
	kind: string;
	quote: string;
	fix: string;
	why: string;
}

export interface DigestGraderVersion {
	model: string;
	promptHash: string;
}

export interface DigestPattern {
	id: string;
	name: string;
	rule: string;
	categories: Category[];
	count: number;
	findingIds: string[];
	/** Every distinct example, newest first; the page shows the first few and folds the rest. */
	examples: DigestFinding[];
	/** The tutor's explanation of the rule and of why these sentences break it; absent before ADR 0012. */
	explanation?: string;
	/** One self-check to catch the error before sending; absent before ADR 0012. */
	tip?: string;
	/** Exercises for this Pattern; absent before ADR 0012. */
	practice?: DigestPractice[];
	/** True when the Pattern meets this Digest's recurrence rule. */
	recurring: boolean;
	/** Count for the same Pattern in the immediately preceding week, or null if absent. */
	previousCount: number | null;
	trend: { week: string; count: number }[];
}

export interface DigestStats {
	prompts: number;
	reviewed: number;
	clean: number;
	cleanPercent: number;
	categories: Record<Category, number>;
	notReviewed: {
		tooLong: number;
		nothingToReview: number;
		failed: number;
		pending: number;
	};
}

export interface DigestArchive {
	version: number;
	week: string;
	scope: string;
	from: string;
	stats: DigestStats;
	graderVersions: DigestGraderVersion[];
	lesson: string | null;
	focus: string | null;
	patterns: DigestPattern[];
	oneOffs: DigestFinding[];
}

export interface DigestRenderContext {
	previousWeek: DigestArchive | null;
	previousArchive: string | null;
	archiveWeeks: string[];
	graderChanged: {
		from: DigestGraderVersion[];
		to: DigestGraderVersion[];
	} | null;
}
