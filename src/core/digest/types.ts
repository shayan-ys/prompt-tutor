import type { Category } from "../types.ts";

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
	examples: DigestFinding[];
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
