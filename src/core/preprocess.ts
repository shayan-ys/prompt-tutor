import type { SkipReason } from "./types.ts";

export function preprocess(raw: string): {
	text: string;
	wordCount: number;
	skip: SkipReason | null;
} {
	let text = raw.replace(/^\/\S+\s*/u, "");
	text = text.replace(/```[\s\S]*?(?:```|$)/gu, "[code]").trim();
	const countableText = text.replace(
		/(?:https?:\/\/|ftp:\/\/|www\.)[^\s<>"'`]+/giu,
		" ",
	);
	const words = countableText.match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu);
	const wordCount = words?.length ?? 0;
	let skip: SkipReason | null = null;
	if (wordCount > 600) skip = "too_long";
	else if (wordCount === 0) skip = "nothing_to_review";
	return { text, wordCount, skip };
}
