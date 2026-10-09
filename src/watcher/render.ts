import { stubUrl } from "../core/log/index.ts";
import type { Category, Config, PromptRecord, Scope } from "../core/types.ts";

const ESC = "\x1b[";
const RESET = `${ESC}0m`;
const BOLD = `${ESC}1m`;
const DIM = `${ESC}2m`;
const ITALIC = `${ESC}3m`;
const INVERSE = `${ESC}7m`;
const STRIKE = `${ESC}9m`;
const fg = (colour: number) => `${ESC}38;5;${colour}m`;
const bg = (colour: number) => `${ESC}48;5;${colour}m`;
const OSC_OPEN = "\x1b]8;;";
const OSC_CLOSE = "\x1b]8;;\x1b\\";

const CATEGORY_ORDER: Category[] = ["spelling", "grammar", "fluency"];
const CATEGORY_STYLE: Record<
	Category,
	{ foreground: number; background: number; glyph: string }
> = {
	spelling: { foreground: 213, background: 89, glyph: "S" },
	grammar: { foreground: 214, background: 94, glyph: "G" },
	fluency: { foreground: 81, background: 24, glyph: "F" },
};
const DELETION = fg(203) + STRIKE;
const INSERTION = fg(114) + BOLD;
const SPINNER = "⠋⠙⠹⠸⠼⠴⠦⠧⠏";

interface Segment {
	text: string;
	style?: string;
	href?: string;
}

type DiffToken = { text: string; operation: "same" | "delete" | "insert" };

export interface RenderFrameOptions {
	config: Config;
	records: PromptRecord[];
	/** `all` or a configured Scope name. */
	view: string;
	/** `null` follows the newest Prompt in `view`; otherwise the selected Prompt id. */
	selectedId: string | null;
	scroll?: number;
	width?: number;
	height?: number;
	now?: number;
	newerVersion?: number;
	/** One frame for a host such as devdash: no title line, tabs, follow indicator, or key row. */
	embedded?: boolean;
	/** Reserve selected-body room and fit the trail around it for scrollable frames. */
	scrollAware?: boolean;
	/** Include the Watcher's view tabs and follow indicator in an embedded frame. */
	showNavigation?: boolean;
}

function safeText(text: string): string {
	return text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, " ");
}

function codePointLength(text: string): number {
	return Array.from(safeText(text)).length;
}

function visibleLength(text: string): number {
	return codePointLength(
		text.replace(/\x1b\]8;;[^\x1b]*\x1b\\/g, "").replace(/\x1b\[[0-9;]*m/g, ""),
	);
}

function renderSegment(segment: Segment): string {
	const text = safeText(segment.text);
	const styled = segment.style ? `${segment.style}${text}${RESET}` : text;
	return segment.href
		? `${OSC_OPEN}${segment.href}\x1b\\${styled}${OSC_CLOSE}`
		: styled;
}

function padRight(text: string, width: number): string {
	return text + " ".repeat(Math.max(0, width - visibleLength(text)));
}

function clip(text: string, width: number): string {
	const points = Array.from(safeText(text));
	if (points.length <= width) return points.join("");
	if (width <= 0) return "";
	return `${points.slice(0, Math.max(0, width - 1)).join("")}…`;
}

/** Greedy wrapping over styled segments, keeping explicit line breaks. */
function wrap(
	segments: Segment[],
	width: number,
	indent = "",
	firstIndent = indent,
): string[] {
	const output: string[] = [];
	let line: Segment[] = [];
	let lineLength = 0;
	let prefix = firstIndent;
	const room = () => Math.max(1, width - codePointLength(prefix));
	const flush = () => {
		while (line.length && /^\s+$/.test(line[line.length - 1]!.text)) line.pop();
		output.push(prefix + line.map(renderSegment).join(""));
		line = [];
		lineLength = 0;
		prefix = indent;
	};

	for (const segment of segments) {
		for (const token of segment.text.split(/(\n|\s+)/u)) {
			if (!token) continue;
			if (token === "\n") {
				flush();
				continue;
			}
			if (/^\s+$/u.test(token)) {
				if (lineLength) {
					line.push({ ...segment, text: " " });
					lineLength++;
				}
				continue;
			}
			let word = token;
			while (codePointLength(word) > room()) {
				if (lineLength) flush();
				const points = Array.from(word);
				const fragment = points.slice(0, room()).join("");
				line.push({ ...segment, text: fragment });
				lineLength = codePointLength(fragment);
				flush();
				word = points.slice(codePointLength(fragment)).join("");
			}
			if (lineLength + codePointLength(word) > room()) flush();
			line.push({ ...segment, text: word });
			lineLength += codePointLength(word);
		}
	}
	if (lineLength || output.length === 0) flush();
	return output;
}

function countBadges(record: PromptRecord): Segment[] {
	if (!record.review) return [];
	const counts: Partial<Record<Category, number>> = {};
	for (const finding of record.review.findings)
		counts[finding.category] = (counts[finding.category] ?? 0) + 1;
	const segments: Segment[] = [];
	for (const category of CATEGORY_ORDER) {
		const count = counts[category];
		if (!count) continue;
		segments.push({
			text: ` ${category} ${count} `,
			style: bg(CATEGORY_STYLE[category].background) + fg(231) + BOLD,
		});
		segments.push({ text: " " });
	}
	return segments;
}

function scopeColour(scope: Scope): number {
	if (scope.name === "work") return 25;
	if (scope.name === "personal") return 28;
	const palette = [31, 90, 24, 30, 54, 23, 60, 29];
	return palette[scope.index % palette.length]!;
}

function scopeTag(config: Config, name: string): Segment {
	const scope = config.scopes.find((candidate) => candidate.name === name);
	return {
		text: ` ${name} `,
		style: bg(scope ? scopeColour(scope) : 25) + fg(231) + BOLD,
	};
}

function captureTime(record: PromptRecord): string {
	const timestamp = Date.parse(record.captured_at);
	if (!Number.isFinite(timestamp)) return "??:??";
	const offset = Number.isFinite(record.utc_offset_minutes)
		? record.utc_offset_minutes
		: 0;
	return new Date(timestamp + offset * 60_000).toISOString().slice(11, 16);
}

function displayPrompt(record: PromptRecord): string {
	return record.text.replace(/\s+/gu, " ").trim();
}

function categoryStatus(
	record: PromptRecord,
	dimmed: boolean,
	now: number,
): Segment[] {
	const review = record.review;
	if (record.state === "pending") {
		const frame = Math.floor(now / 125) % SPINNER.length;
		return [
			{ text: SPINNER[frame]!, style: `${dimmed ? DIM : ""}${fg(220)}${BOLD}` },
		];
	}
	if (record.state === "failed")
		return [{ text: "EN ?", style: `${dimmed ? DIM : ""}${fg(203)}${BOLD}` }];
	if (record.state === "skipped")
		return [{ text: "– skipped", style: `${dimmed ? DIM : ""}${fg(244)}` }];
	if (!review?.findings.length)
		return [
			{ text: "✓ clean", style: `${dimmed ? DIM : ""}${fg(114)}${BOLD}` },
		];
	return review.findings.map((finding) => ({
		text: CATEGORY_STYLE[finding.category].glyph,
		style: `${dimmed ? DIM : ""}${fg(CATEGORY_STYLE[finding.category].foreground)}${BOLD}`,
	}));
}

function trailLine(record: PromptRecord, width: number, now: number): string {
	const scope =
		record.scope === "work"
			? "W"
			: record.scope === "personal"
				? "P"
				: (Array.from(record.scope)[0]?.toLocaleUpperCase() ?? "?");
	const prefix = `  ${captureTime(record)} ${scope} `;
	const status = categoryStatus(record, true, now);
	const statusWidth = status.reduce(
		(total, segment) => total + codePointLength(segment.text),
		0,
	);
	const statusText = status.map(renderSegment).join("");
	const gap = statusWidth < 8 ? " ".repeat(8 - statusWidth) : " ";
	const promptWidth = Math.max(
		0,
		width - codePointLength(prefix) - statusWidth - gap.length,
	);
	const prompt = clip(displayPrompt(record), promptWidth);
	return `${DIM}${prefix}${RESET}${statusText}${gap}${DIM}${safeText(prompt)}${RESET}`;
}

function tokens(text: string): string[] {
	return (
		text.match(
			/[\p{L}\p{M}\p{N}_]+(?:['’][\p{L}\p{M}\p{N}_]+)*|[^\p{L}\p{M}\p{N}_]+/gu,
		) ?? []
	);
}

/** Token-level LCS for an unanchored region; punctuation and word boundaries stay independent. */
function diffRegion(before: string, after: string): DiffToken[] {
	if (before === after)
		return before ? [{ text: before, operation: "same" }] : [];
	const oldTokens = tokens(before);
	const newTokens = tokens(after);
	const columns = newTokens.length + 1;
	const table = new Uint16Array((oldTokens.length + 1) * columns);
	for (let oldIndex = oldTokens.length - 1; oldIndex >= 0; oldIndex--) {
		const row = oldIndex * columns;
		const nextRow = (oldIndex + 1) * columns;
		for (let newIndex = newTokens.length - 1; newIndex >= 0; newIndex--) {
			const cell = row + newIndex;
			table[cell] =
				oldTokens[oldIndex] === newTokens[newIndex]
					? table[nextRow + newIndex + 1]! + 1
					: Math.max(table[nextRow + newIndex]!, table[cell + 1]!);
		}
	}
	const output: DiffToken[] = [];
	const push = (text: string, operation: DiffToken["operation"]) => {
		if (!text) return;
		const last = output[output.length - 1];
		if (last?.operation === operation) last.text += text;
		else output.push({ text, operation });
	};
	let oldIndex = 0;
	let newIndex = 0;
	while (oldIndex < oldTokens.length || newIndex < newTokens.length) {
		if (
			oldIndex < oldTokens.length &&
			newIndex < newTokens.length &&
			oldTokens[oldIndex] === newTokens[newIndex]
		) {
			push(oldTokens[oldIndex]!, "same");
			oldIndex++;
			newIndex++;
		} else if (
			oldIndex < oldTokens.length &&
			(newIndex >= newTokens.length ||
				table[(oldIndex + 1) * columns + newIndex]! >=
					table[oldIndex * columns + newIndex + 1]!)
		) {
			push(oldTokens[oldIndex]!, "delete");
			oldIndex++;
		} else {
			push(newTokens[newIndex]!, "insert");
			newIndex++;
		}
	}
	return output;
}

/** Anchor Finding spans to their exact fixes before diffing surrounding prose. */
function rewriteDiff(record: PromptRecord): DiffToken[] {
	const review = record.review;
	const rewrite = review?.rewrite;
	if (!review || rewrite === null || rewrite === undefined) return [];
	const findings = [...review.findings].sort(
		(left, right) => left.start - right.start,
	);
	let promptOffset = 0;
	let rewriteOffset = 0;
	const output: DiffToken[] = [];
	const append = (part: DiffToken[]) => {
		for (const token of part) {
			const last = output[output.length - 1];
			if (last?.operation === token.operation) last.text += token.text;
			else output.push({ ...token });
		}
	};
	for (const finding of findings) {
		if (
			finding.start < promptOffset ||
			finding.end < finding.start ||
			record.text.slice(finding.start, finding.end) !== finding.quote
		) {
			return diffRegion(record.text, rewrite);
		}
		const fixStart = rewrite.indexOf(finding.fix, rewriteOffset);
		if (fixStart < rewriteOffset) return diffRegion(record.text, rewrite);
		append(
			diffRegion(
				record.text.slice(promptOffset, finding.start),
				rewrite.slice(rewriteOffset, fixStart),
			),
		);
		append([
			{ text: finding.quote, operation: "delete" },
			{ text: finding.fix, operation: "insert" },
		]);
		promptOffset = finding.end;
		rewriteOffset = fixStart + finding.fix.length;
	}
	append(
		diffRegion(record.text.slice(promptOffset), rewrite.slice(rewriteOffset)),
	);
	return output;
}

function diffSegments(record: PromptRecord): Segment[] {
	return rewriteDiff(record).map((token) => ({
		text: token.text,
		style:
			token.operation === "delete"
				? DELETION
				: token.operation === "insert"
					? INSERTION
					: undefined,
	}));
}

function stateBody(record: PromptRecord, width: number, now: number): string[] {
	if (record.state === "pending") {
		const elapsed = Math.max(
			0,
			Math.floor((now - Date.parse(record.captured_at)) / 1000),
		);
		const spinner = SPINNER[Math.floor(now / 125) % SPINNER.length]!;
		return [
			...wrap(
				[{ text: `${spinner} reviewing… ${elapsed}s`, style: fg(220) + BOLD }],
				width,
				"  ",
			),
			...wrap([{ text: record.text, style: DIM }], width, "  "),
		];
	}
	if (record.state === "failed") {
		return [
			...wrap(
				[
					{ text: " EN ? ", style: bg(160) + fg(231) + BOLD },
					{ text: "  Review failed: " },
					{ text: record.failure ?? "unknown error", style: DIM },
				],
				width,
				"  ",
			),
			...wrap([{ text: record.text, style: DIM }], width, "  "),
		];
	}
	if (record.state === "skipped") {
		const label =
			record.skip_reason === "nothing_to_review"
				? " skipped: nothing to review "
				: ` skipped: too long (${record.word_count} words) `;
		return [
			...wrap([{ text: label, style: bg(238) + fg(250) }], width, "  "),
			...wrap([{ text: clip(record.text, 140), style: DIM }], width, "  "),
		];
	}
	const review = record.review;
	if (!review?.findings.length) {
		return wrap(
			[{ text: "✓ ", style: fg(114) + BOLD }, { text: record.text }],
			width,
			"   ",
		);
	}
	return [
		...wrap(diffSegments(record), width, "   "),
		"",
		...wrap(
			[{ text: review.tip ?? "", style: fg(222) + ITALIC }],
			width,
			`   ${fg(220)}▌ ${RESET}`,
		),
	];
}

function sortNewestFirst(records: PromptRecord[]): PromptRecord[] {
	return [...records].sort(
		(left, right) =>
			right.captured_at.localeCompare(left.captured_at) ||
			right.id.localeCompare(left.id),
	);
}

export function renderErrorFrame(
	message: string,
	path: string,
	width: number,
	height: number,
): string {
	const frameWidth = Math.max(20, Math.min(width - 2, 100));
	const lines = [
		` ${BOLD}prompt-tutor${RESET}  ${fg(203)}configuration error${RESET}`,
		"",
		...wrap([{ text: path, style: DIM }], frameWidth, "  "),
		...wrap([{ text: message, style: fg(203) }], frameWidth, "  "),
	];
	return fitFrame(lines, height);
}
interface PreparedFrame {
	width: number;
	height: number;
	now: number;
	selected: PromptRecord | undefined;
	lines: string[];
	body: string[];
	older: PromptRecord[];
	frameCapacity: number;
	bodyRoom: number;
	trailSeparatorRows: number;
}

function prepareFrame(options: RenderFrameOptions): PreparedFrame {
	const { config } = options;
	const width = Math.max(20, Math.min((options.width ?? 80) - 2, 100));
	const height = options.height ?? 24;
	const now = options.now ?? Date.now();
	const sortedRecords = sortNewestFirst(options.records);
	const inView =
		options.view === "all"
			? sortedRecords
			: sortedRecords.filter((record) => record.scope === options.view);
	const selectedIndex =
		options.selectedId === null
			? 0
			: Math.max(
					0,
					inView.findIndex((record) => record.id === options.selectedId),
				);
	const selected = inView[selectedIndex];
	const title: Segment[] = [
		{ text: " prompt-tutor ", style: BOLD },
		{ text: " " },
		{ text: " all ", style: options.view === "all" ? INVERSE + BOLD : DIM },
		...config.scopes.flatMap((scope) => [
			{ text: " " },
			{
				text: ` ${scope.name} `,
				style: options.view === scope.name ? INVERSE + BOLD : DIM,
			},
		]),
	];
	const following = options.selectedId === null || selectedIndex === 0;
	const indicator: Segment = following
		? { text: "● following latest", style: fg(114) }
		: { text: `◀ ${selectedIndex} newer`, style: fg(220) };
	const titleRoom = Math.max(
		1,
		width - visibleLength(renderSegment(indicator)),
	);
	const titleLines = wrap(title, titleRoom, " ");
	const showNavigation = options.showNavigation ?? !options.embedded;
	const lines = showNavigation
		? [
				padRight(
					titleLines[0] ?? "",
					width - visibleLength(renderSegment(indicator)),
				) + renderSegment(indicator),
				...titleLines.slice(1),
				"",
			]
		: [];

	if (options.newerVersion && options.newerVersion > 0) {
		lines.push(
			`${fg(220)}written by a newer prompt-tutor — upgrade${RESET}`,
			"",
		);
	}

	const older = selected
		? inView.slice(selectedIndex + 1, selectedIndex + 4)
		: [];
	let body: string[] = [];
	if (selected) {
		const head: Segment[] = [
			scopeTag(config, selected.scope),
			{ text: `  ${captureTime(selected)}   ` },
			...countBadges(selected),
		];
		const logScope =
			options.view === "all"
				? null
				: (config.scopes.find((scope) => scope.name === options.view) ?? null);
		const headerLink: Segment = {
			text: "log ↗",
			style: fg(75) + "\x1b[4m",
			href: stubUrl(config, logScope, selected.id),
		};
		const renderedLink = renderSegment(headerLink);
		const linkWidth = visibleLength(renderedLink);
		const headLines = wrap(head, Math.max(1, width - linkWidth - 1), " ");
		lines.push(
			padRight(headLines[0] ?? "", width - linkWidth - 1) + renderedLink,
			...headLines.slice(1),
			"",
		);
		body = stateBody(selected, width, now);
	}

	const frameCapacity = Math.max(1, options.embedded ? height : height - 2);
	const availableRoom = Math.max(0, frameCapacity - lines.length);
	const scrollAware = options.scrollAware ?? false;
	let bodyRoom = 0;
	let trailSeparatorRows = older.length ? 3 : 0;
	if (scrollAware) {
		bodyRoom = Math.min(3, availableRoom);
		const trailRoom = availableRoom - bodyRoom;
		while (older.length && trailRoom < trailSeparatorRows + older.length) {
			older.pop();
		}
		if (!older.length) trailSeparatorRows = 0;
		while (trailRoom < trailSeparatorRows + older.length) {
			trailSeparatorRows--;
		}
		bodyRoom = availableRoom - trailSeparatorRows - older.length;
	}
	return {
		width,
		height,
		now,
		selected,
		lines,
		body,
		older,
		frameCapacity,
		bodyRoom: scrollAware ? bodyRoom : body.length,
		trailSeparatorRows,
	};
}

function maxBodyScroll(bodyLength: number, bodyRoom: number): number {
	if (bodyRoom < 1 || bodyLength <= bodyRoom) return 0;
	const visibleRoom = bodyRoom >= 3 ? Math.max(1, bodyRoom - 2) : bodyRoom;
	return Math.max(0, bodyLength - visibleRoom);
}

/** Return the maximum body offset renderFrame can display for this selection and frame size. */
export function bodyScrollRange(options: RenderFrameOptions): number {
	const { body, bodyRoom } = prepareFrame(options);
	return maxBodyScroll(body.length, bodyRoom);
}

function lineWord(count: number): string {
	return count === 1 ? "line" : "lines";
}

function fitFrame(lines: string[], height: number, keyRow = true): string {
	const available = Math.max(1, keyRow ? height - 2 : height);
	const shown =
		lines.length > available
			? [
					...lines.slice(0, available - 1),
					`${DIM}  … ${lines.length - available + 1} more ${lineWord(lines.length - available + 1)}${RESET}`,
				]
			: lines;
	if (!keyRow) return shown.join("\n");
	return [
		...shown,
		"",
		`${DIM}  j/k prompts  J/K scroll  s scope  q quit${RESET}`,
	].join("\n");
}

/** Render a complete, side-effect-free Watcher frame. */
export function renderFrame(options: RenderFrameOptions): string {
	const prepared = prepareFrame(options);
	const {
		width,
		height,
		now,
		selected,
		lines,
		body,
		older,
		bodyRoom,
		trailSeparatorRows,
	} = prepared;
	if (!selected) {
		lines.push(
			...wrap(
				[
					{
						text:
							options.view === "all"
								? "No Prompts yet."
								: `No Prompts in ${options.view} yet.`,
						style: DIM,
					},
				],
				width,
				"  ",
			),
		);
		return fitFrame(lines, height, !options.embedded);
	}

	let scroll = Math.max(0, Math.floor(options.scroll ?? 0));
	const maxScroll = maxBodyScroll(body.length, bodyRoom);
	scroll = Math.min(scroll, maxScroll);
	if (body.length > bodyRoom) {
		if (bodyRoom < 3) {
			lines.push(...body.slice(scroll, scroll + bodyRoom));
		} else {
			const above = scroll > 0;
			const visibleCount = bodyRoom - (above ? 1 : 0) - 1;
			const visible = body.slice(scroll, scroll + visibleCount);
			if (above)
				lines.push(`${DIM}  … ${scroll} ${lineWord(scroll)} above${RESET}`);
			lines.push(...visible);
			const below = body.length - scroll - visible.length;
			if (below > 0)
				lines.push(`${DIM}  … ${below} more ${lineWord(below)}${RESET}`);
		}
	} else {
		lines.push(...body);
	}
	if (older.length) {
		if (trailSeparatorRows >= 2) lines.push("", "");
		if (trailSeparatorRows >= 3)
			lines.push(
				` ${fg(238)}earlier ${"┄".repeat(Math.max(0, width - 10))}${RESET}`,
			);
		for (const record of older) lines.push(trailLine(record, width, now));
	}
	return fitFrame(lines, height, !options.embedded);
}
