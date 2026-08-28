import { basename } from "node:path";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

export type AnnotationKind = "comment" | "suggestion" | "issue";

export type AnnotationTarget =
	| { kind: "overall" }
	| { kind: "lines"; startLine: number; endLine: number };

export interface ResponseAnnotation {
	id: string;
	ordinal: number;
	target: AnnotationTarget;
	kind: AnnotationKind;
	body: string;
}

export interface ResponseDocument {
	sourceText: string;
	lines: readonly string[];
	displayLines: readonly string[];
	/** Display label for the reviewed source, e.g. a file path. Absent for assistant responses. */
	title?: string;
	/** True when the source is Markdown and should be styled with Markdown syntax highlighting. */
	markdown: boolean;
}

export interface AnnotationDraft {
	kind: AnnotationKind;
	target: AnnotationTarget;
	editingId?: string;
	initialBody: string;
	error?: string;
}

export type ReviewMode =
	| { kind: "browse" }
	| { kind: "select"; anchorLine: number }
	| { kind: "draft"; draft: AnnotationDraft }
	| { kind: "confirmDiscard" }
	| { kind: "completed" }
	| { kind: "cancelled" };

export interface ReviewState {
	document: ResponseDocument;
	cursorLine: number;
	mode: ReviewMode;
	annotations: readonly ResponseAnnotation[];
	activeAnnotationId?: string;
	nextOrdinal: number;
}

export type ReviewAction =
	| { type: "move"; delta: number }
	| { type: "moveTo"; line: number }
	| { type: "toggleSelection" }
	| { type: "beginDraft"; kind: AnnotationKind; target?: AnnotationTarget }
	| { type: "saveDraft"; body: string }
	| { type: "cancelDraft" }
	| { type: "edit"; id: string }
	| { type: "delete"; id: string }
	| { type: "navigateAnnotation"; delta: number }
	| { type: "requestCancel" }
	| { type: "confirmDiscard" }
	| { type: "cancelDiscard" }
	| { type: "finish" };

export interface WrappedSourceRow {
	sourceLine: number;
	text: string;
	continuation: boolean;
}

export interface PageTarget {
	line: number;
	viewportOffset: number;
}

export type CodeHighlighter = (code: string, language?: string) => string[];

const TAB_WIDTH = 4;

function isBidirectionalFormatControl(codePoint: number): boolean {
	return (
		codePoint === 0x061c ||
		codePoint === 0x200e ||
		codePoint === 0x200f ||
		(codePoint >= 0x202a && codePoint <= 0x202e) ||
		(codePoint >= 0x2066 && codePoint <= 0x2069)
	);
}

export function sanitizeDisplayText(text: string): string {
	let result = "";
	for (const character of text) {
		const codePoint = character.codePointAt(0) ?? 0;
		if (character === "\t") {
			result += " ".repeat(TAB_WIDTH);
		} else if (codePoint === 0x7f) {
			result += "␡";
		} else if (codePoint < 0x20) {
			result += String.fromCodePoint(0x2400 + codePoint);
		} else if (codePoint >= 0x80 && codePoint <= 0x9f) {
			result += `\\u{${codePoint.toString(16).toUpperCase()}}`;
		} else if (isBidirectionalFormatControl(codePoint)) {
			result += `\\u{${codePoint.toString(16).toUpperCase()}}`;
		} else {
			result += character;
		}
	}
	return result;
}

const MARKDOWN_EXTENSIONS = new Set([".md", ".markdown", ".mdown", ".mkd", ".mdx"]);
const MARKDOWN_BASENAMES = new Set(["readme", "changelog", "contributing", "code_of_conduct", "authors"]);

/**
 * True when a file path looks like Markdown: a known `.md`-family extension
 * (case-insensitive) or a well-known extension-less Markdown filename.
 */
export function isMarkdownPath(filePath: string): boolean {
	const normalized = filePath.toLowerCase();
	const base = basename(normalized);
	if (MARKDOWN_BASENAMES.has(base)) return true;
	const dot = base.lastIndexOf(".");
	if (dot <= 0) return false;
	return MARKDOWN_EXTENSIONS.has(base.slice(dot));
}

export function createResponseDocument(
	sourceText: string,
	title?: string,
	options?: { markdown?: boolean },
): ResponseDocument {
	const lines = sourceText.split(/\r\n|\r|\n/);
	if (lines.length === 0) lines.push("");
	const markdown = options?.markdown ?? (title !== undefined ? isMarkdownPath(title) : false);
	return {
		sourceText,
		lines,
		displayLines: lines.map(sanitizeDisplayText),
		markdown,
		...(title !== undefined ? { title } : {}),
	};
}

export function createReviewState(document: ResponseDocument): ReviewState {
	return {
		document,
		cursorLine: 0,
		mode: { kind: "browse" },
		annotations: [],
		nextOrdinal: 1,
	};
}

function clampLine(document: ResponseDocument, line: number): number {
	return Math.max(0, Math.min(document.lines.length - 1, Math.trunc(line)));
}

export function normalizeTarget(target: AnnotationTarget, document: ResponseDocument): AnnotationTarget {
	if (target.kind === "overall") return target;
	const first = clampLine(document, Math.min(target.startLine, target.endLine));
	const last = clampLine(document, Math.max(target.startLine, target.endLine));
	return { kind: "lines", startLine: first, endLine: last };
}

export function getCurrentTarget(state: ReviewState): AnnotationTarget {
	if (state.mode.kind !== "select") {
		return { kind: "lines", startLine: state.cursorLine, endLine: state.cursorLine };
	}
	return normalizeTarget(
		{ kind: "lines", startLine: state.mode.anchorLine, endLine: state.cursorLine },
		state.document,
	);
}

export function sortAnnotations(
	annotations: readonly ResponseAnnotation[],
): ResponseAnnotation[] {
	return [...annotations].sort((left, right) => {
		if (left.target.kind !== right.target.kind) return left.target.kind === "overall" ? -1 : 1;
		if (left.target.kind === "lines" && right.target.kind === "lines") {
			return (
				left.target.startLine - right.target.startLine ||
				left.target.endLine - right.target.endLine ||
				left.ordinal - right.ordinal
			);
		}
		return left.ordinal - right.ordinal;
	});
}

export function annotationsAtLine(
	annotations: readonly ResponseAnnotation[],
	line: number,
): ResponseAnnotation[] {
	return sortAnnotations(
		annotations.filter(
			(annotation) =>
				annotation.target.kind === "lines" &&
				annotation.target.startLine <= line &&
				annotation.target.endLine >= line,
		),
	);
}

export function getActiveAnnotation(state: ReviewState): ResponseAnnotation | undefined {
	const active = state.annotations.find((annotation) => annotation.id === state.activeAnnotationId);
	if (active) return active;
	return annotationsAtLine(state.annotations, state.cursorLine)[0];
}

function updateCursor(state: ReviewState, cursorLine: number): ReviewState {
	return {
		...state,
		cursorLine: clampLine(state.document, cursorLine),
		activeAnnotationId: undefined,
	};
}

export function reduceReviewState(state: ReviewState, action: ReviewAction): ReviewState {
	switch (action.type) {
		case "move":
			if (state.mode.kind !== "browse" && state.mode.kind !== "select") return state;
			return updateCursor(state, state.cursorLine + action.delta);
		case "moveTo":
			if (state.mode.kind !== "browse" && state.mode.kind !== "select") return state;
			return updateCursor(state, action.line);
		case "toggleSelection":
			if (state.mode.kind === "browse") {
				return { ...state, mode: { kind: "select", anchorLine: state.cursorLine } };
			}
			if (state.mode.kind === "select") return { ...state, mode: { kind: "browse" } };
			return state;
		case "beginDraft": {
			if (state.mode.kind !== "browse" && state.mode.kind !== "select") return state;
			const target = normalizeTarget(action.target ?? getCurrentTarget(state), state.document);
			return {
				...state,
				mode: {
					kind: "draft",
					draft: { kind: action.kind, target, initialBody: "" },
				},
			};
		}
		case "saveDraft": {
			if (state.mode.kind !== "draft") return state;
			if (!action.body.trim()) {
				return {
					...state,
					mode: {
						kind: "draft",
						draft: { ...state.mode.draft, error: "Annotation text cannot be blank" },
					},
				};
			}

			const draft = state.mode.draft;
			if (draft.editingId) {
				const annotations = state.annotations.map((annotation) =>
					annotation.id === draft.editingId
						? { ...annotation, kind: draft.kind, target: draft.target, body: action.body }
						: annotation,
				);
				return {
					...state,
					annotations,
					activeAnnotationId: draft.editingId,
					mode: { kind: "browse" },
				};
			}

			const annotation: ResponseAnnotation = {
				id: `annotation-${state.nextOrdinal}`,
				ordinal: state.nextOrdinal,
				target: draft.target,
				kind: draft.kind,
				body: action.body,
			};
			return {
				...state,
				annotations: [...state.annotations, annotation],
				activeAnnotationId: annotation.id,
				nextOrdinal: state.nextOrdinal + 1,
				mode: { kind: "browse" },
			};
		}
		case "cancelDraft":
			return state.mode.kind === "draft" ? { ...state, mode: { kind: "browse" } } : state;
		case "edit": {
			if (state.mode.kind !== "browse") return state;
			const annotation = state.annotations.find((candidate) => candidate.id === action.id);
			if (!annotation) return state;
			return {
				...state,
				activeAnnotationId: annotation.id,
				mode: {
					kind: "draft",
					draft: {
						kind: annotation.kind,
						target: annotation.target,
						editingId: annotation.id,
						initialBody: annotation.body,
					},
				},
			};
		}
		case "delete": {
			if (state.mode.kind !== "browse") return state;
			const annotations = state.annotations.filter((annotation) => annotation.id !== action.id);
			if (annotations.length === state.annotations.length) return state;
			return {
				...state,
				annotations,
				activeAnnotationId: undefined,
			};
		}
		case "navigateAnnotation": {
			if (state.mode.kind !== "browse" || state.annotations.length === 0) return state;
			const annotations = sortAnnotations(state.annotations);
			const currentIndex = annotations.findIndex(
				(annotation) => annotation.id === state.activeAnnotationId,
			);
			const baseIndex = currentIndex < 0 ? (action.delta > 0 ? -1 : 0) : currentIndex;
			const nextIndex = (baseIndex + action.delta + annotations.length) % annotations.length;
			const annotation = annotations[nextIndex];
			return {
				...state,
				activeAnnotationId: annotation.id,
				cursorLine:
					annotation.target.kind === "lines" ? annotation.target.startLine : state.cursorLine,
			};
		}
		case "requestCancel":
			if (state.mode.kind === "select") return { ...state, mode: { kind: "browse" } };
			if (state.mode.kind !== "browse") return state;
			return {
				...state,
				mode: state.annotations.length > 0 ? { kind: "confirmDiscard" } : { kind: "cancelled" },
			};
		case "confirmDiscard":
			return state.mode.kind === "confirmDiscard"
				? { ...state, mode: { kind: "cancelled" } }
				: state;
		case "cancelDiscard":
			return state.mode.kind === "confirmDiscard" ? { ...state, mode: { kind: "browse" } } : state;
		case "finish":
			return state.mode.kind === "browse" || state.mode.kind === "select"
				? { ...state, mode: { kind: "completed" } }
				: state;
	}
}

export function buildWrappedSourceRows(
	document: ResponseDocument,
	bodyWidth: number,
	displayLines: readonly string[] = document.displayLines,
): WrappedSourceRow[] {
	const safeWidth = Math.max(1, Math.trunc(bodyWidth));
	const rows: WrappedSourceRow[] = [];
	for (let sourceLine = 0; sourceLine < displayLines.length; sourceLine++) {
		const wrapped = wrapTextWithAnsi(displayLines[sourceLine] ?? "", safeWidth);
		const chunks = (wrapped.length > 0 ? wrapped : [""]).map((chunk) =>
			visibleWidth(chunk) <= safeWidth ? chunk : truncateToWidth(chunk, safeWidth, ""),
		);
		for (let index = 0; index < chunks.length; index++) {
			rows.push({ sourceLine, text: chunks[index], continuation: index > 0 });
		}
	}
	return rows;
}

interface MarkdownFence {
	character: "`" | "~";
	length: number;
	language?: string;
}

function openingFence(line: string): MarkdownFence | undefined {
	const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
	if (!match) return undefined;
	const marker = match[1];
	const info = match[2].trim();
	if (marker[0] === "`" && info.includes("`")) return undefined;
	return {
		character: marker[0] as "`" | "~",
		length: marker.length,
		language: info ? info.split(/\s+/, 1)[0] : undefined,
	};
}

function isClosingFence(line: string, fence: MarkdownFence): boolean {
	const match = /^ {0,3}(`+|~+)[ \t]*$/.exec(line);
	return Boolean(
		match && match[1][0] === fence.character && match[1].length >= fence.length,
	);
}

export function highlightFencedCodeLines(
	document: ResponseDocument,
	highlight: CodeHighlighter,
	decorateFence: (line: string) => string = (line) => line,
): string[] {
	const output = [...document.displayLines];
	let line = 0;
	while (line < document.displayLines.length) {
		const fence = openingFence(document.displayLines[line]);
		if (!fence) {
			line++;
			continue;
		}

		let closingLine = line + 1;
		while (
			closingLine < document.displayLines.length &&
			!isClosingFence(document.displayLines[closingLine], fence)
		) {
			closingLine++;
		}
		const codeLines = document.displayLines.slice(line + 1, closingLine);
		const highlighted = highlight(codeLines.join("\n"), fence.language);
		if (highlighted.length === codeLines.length) {
			for (let index = 0; index < highlighted.length; index++) {
				output[line + 1 + index] = highlighted[index];
			}
		}
		output[line] = decorateFence(output[line]);
		if (closingLine < output.length) output[closingLine] = decorateFence(output[closingLine]);
		line = closingLine + 1;
	}
	return output;
}

/**
 * Styling callbacks for Markdown syntax highlighting. Each function wraps text in
 * the ANSI styling for that Markdown element; no function may change visible text.
 */
export interface MarkdownDecorator {
	heading: (text: string) => string;
	link: (text: string) => string;
	linkUrl: (text: string) => string;
	code: (text: string) => string;
	codeBlockBorder: (text: string) => string;
	quote: (text: string) => string;
	quoteBorder: (text: string) => string;
	hr: (text: string) => string;
	listBullet: (text: string) => string;
	bold: (text: string) => string;
	italic: (text: string) => string;
	strikethrough: (text: string) => string;
	underline?: (text: string) => string;
}

const ESCAPE_PATTERN = /^\\([\\`*_[\]{}()#+.!|<>~-])/;
const CODE_SPAN_PATTERN = /^(`+)([\s\S]*?)\1(?!`)/;
const LINK_PATTERN = /^!?\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/;
const BOLD_ITALIC_PATTERN = /^(\*\*\*|___)([\s\S]*?)\1/;
const BOLD_PATTERN = /^(\*\*|__)([\s\S]*?)\1/;
const STRIKE_PATTERN = /^~~([\s\S]*?)~~/;
const ITALIC_PATTERN = /^(\*|_)([\s\S]*?)\1/;
const HEADING_PATTERN = /^ {0,3}(#{1,6})(?:([ \t]+)([\s\S]*)|$)/;
const HR_PATTERN = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE_PATTERN = /^ {0,3}(>+)([ \t]?)([\s\S]*)$/;
const LIST_PATTERN = /^ {0,3}([-+*]|\d{1,9}[.)])([ \t]+)([\s\S]*)$/;

/**
 * Style the inline Markdown constructs in a single line: code spans, links, bold,
 * italic, strikethrough, and backslash escapes. Markers stay visible so the line
 * still reads as the original source; only the styling is added.
 */
function styleInlineMarkdown(text: string, decorate: MarkdownDecorator): string {
	let output = "";
	let index = 0;
	while (index < text.length) {
		const rest = text.slice(index);

		const escape = ESCAPE_PATTERN.exec(rest);
		if (escape) {
			output += escape[0];
			index += escape[0].length;
			continue;
		}

		const codeSpan = CODE_SPAN_PATTERN.exec(rest);
		if (codeSpan) {
			output += decorate.code(codeSpan[0]);
			index += codeSpan[0].length;
			continue;
		}

		const link = LINK_PATTERN.exec(rest);
		if (link) {
			const alt = styleInlineMarkdown(link[1], decorate);
			output += decorate.link(`[${alt}]`) + decorate.linkUrl(`(${link[2]})`);
			index += link[0].length;
			continue;
		}

		const boldItalic = BOLD_ITALIC_PATTERN.exec(rest);
		if (boldItalic) {
			const inner = styleInlineMarkdown(boldItalic[2], decorate);
			output += decorate.bold(decorate.italic(boldItalic[1] + inner + boldItalic[1]));
			index += boldItalic[0].length;
			continue;
		}

		const bold = BOLD_PATTERN.exec(rest);
		if (bold && !(bold[1] === "__" && index > 0 && /\w/.test(text[index - 1]))) {
			const inner = styleInlineMarkdown(bold[2], decorate);
			output += decorate.bold(bold[1] + inner + bold[1]);
			index += bold[0].length;
			continue;
		}

		const strike = STRIKE_PATTERN.exec(rest);
		if (strike) {
			const inner = styleInlineMarkdown(strike[1], decorate);
			output += decorate.strikethrough(`~~${inner}~~`);
			index += strike[0].length;
			continue;
		}

		const italic = ITALIC_PATTERN.exec(rest);
		if (italic) {
			const marker = italic[1];
			const beforeIsWord = index > 0 && /\w/.test(text[index - 1]);
			const afterIsWord =
				index + italic[0].length < text.length && /\w/.test(text[index + italic[0].length]);
			if (!(beforeIsWord || afterIsWord) && italic[2].trim().length > 0) {
				const inner = styleInlineMarkdown(italic[2], decorate);
				output += decorate.italic(marker + inner + marker);
				index += italic[0].length;
				continue;
			}
		}

		output += text[index];
		index++;
	}
	return output;
}

function decorateMarkdownLine(text: string, decorate: MarkdownDecorator): string {
	if (HR_PATTERN.test(text)) return decorate.hr(text);

	const heading = HEADING_PATTERN.exec(text);
	if (heading) {
		const marker = heading[1];
		const separator = heading[2] ?? "";
		const rest = heading[3] ?? "";
		const content = styleInlineMarkdown(rest, decorate);
		const styled =
			marker.length === 1 && decorate.underline
				? decorate.bold(decorate.underline(separator + content))
				: decorate.bold(separator + content);
		return decorate.heading(marker + styled);
	}

	const quote = QUOTE_PATTERN.exec(text);
	if (quote) {
		const markers = quote[1];
		const separator = quote[2];
		const rest = quote[3];
		return (
			decorate.quoteBorder(markers) +
			decorate.quote(separator + decorate.italic(styleInlineMarkdown(rest, decorate)))
		);
	}

	const list = LIST_PATTERN.exec(text);
	if (list) {
		const marker = list[1];
		const separator = list[2];
		const rest = list[3];
		return decorate.listBullet(marker + separator) + styleInlineMarkdown(rest, decorate);
	}

	return styleInlineMarkdown(text, decorate);
}

/**
 * Decorate Markdown display lines with syntax highlighting while preserving the
 * 1:1 source-line identity that annotations rely on. Fenced code blocks are
 * highlighted via `highlight` and their delimiter lines styled with
 * `codeBlockBorder`; every other line gets inline Markdown styling.
 */
export function decorateMarkdownLines(
	displayLines: readonly string[],
	decorate: MarkdownDecorator,
	highlight: CodeHighlighter,
): string[] {
	const output = [...displayLines];
	let line = 0;
	while (line < displayLines.length) {
		const fence = openingFence(displayLines[line]);
		if (!fence) {
			output[line] = decorateMarkdownLine(displayLines[line], decorate);
			line++;
			continue;
		}

		let closingLine = line + 1;
		while (
			closingLine < displayLines.length &&
			!isClosingFence(displayLines[closingLine], fence)
		) {
			closingLine++;
		}
		const codeLines = displayLines.slice(line + 1, closingLine);
		const highlighted = highlight(codeLines.join("\n"), fence.language);
		if (highlighted.length === codeLines.length) {
			for (let index = 0; index < highlighted.length; index++) {
				output[line + 1 + index] = highlighted[index];
			}
		}
		output[line] = decorate.codeBlockBorder(output[line]);
		if (closingLine < output.length) output[closingLine] = decorate.codeBlockBorder(output[closingLine]);
		line = closingLine + 1;
	}
	return output;
}

export function ensureCursorVisible(
	rows: readonly WrappedSourceRow[],
	cursorLine: number,
	viewportOffset: number,
	viewportHeight: number,
): number {
	if (rows.length === 0) return 0;
	const height = Math.max(1, Math.trunc(viewportHeight));
	const cursorStart = Math.max(
		0,
		rows.findIndex((row) => row.sourceLine === cursorLine),
	);
	let cursorEnd = cursorStart;
	while (cursorEnd + 1 < rows.length && rows[cursorEnd + 1].sourceLine === cursorLine) cursorEnd++;
	const maxOffset = Math.max(0, rows.length - height);
	let offset = Math.max(0, Math.min(Math.trunc(viewportOffset), maxOffset));
	if (cursorEnd < offset || cursorStart >= offset + height) {
		offset = Math.min(cursorStart, maxOffset);
	}
	return offset;
}

export function pageTarget(
	rows: readonly WrappedSourceRow[],
	cursorLine: number,
	viewportOffset: number,
	delta: number,
	viewportHeight: number,
): PageTarget {
	if (rows.length === 0) return { line: 0, viewportOffset: 0 };
	const height = Math.max(1, Math.trunc(viewportHeight));
	const distance = Math.max(1, height - 1);
	const direction = Math.sign(delta);
	const maxOffset = Math.max(0, rows.length - height);
	const offset = Math.max(0, Math.min(Math.trunc(viewportOffset), maxOffset));
	const cursorStart = Math.max(
		0,
		rows.findIndex((row) => row.sourceLine === cursorLine),
	);
	let cursorEnd = cursorStart;
	while (cursorEnd + 1 < rows.length && rows[cursorEnd + 1].sourceLine === cursorLine) cursorEnd++;
	const currentRow =
		direction < 0
			? Math.min(cursorEnd, offset + height - 1)
			: Math.max(cursorStart, offset);
	const targetRow = Math.max(0, Math.min(rows.length - 1, currentRow + direction * distance));
	return {
		line: rows[targetRow].sourceLine,
		viewportOffset: Math.max(0, Math.min(maxOffset, offset + direction * distance)),
	};
}

function annotationLocation(
	document: ResponseDocument,
	target: AnnotationTarget,
): string {
	if (target.kind === "overall") return `Overall ${document.title ?? "response"}`;
	const start = target.startLine + 1;
	const end = target.endLine + 1;
	const unit = document.title ? "File" : "Response";
	return start === end ? `${unit} line ${start}` : `${unit} lines ${start}-${end}`;
}

export function formatReviewMessage(
	document: ResponseDocument,
	annotations: readonly ResponseAnnotation[],
): string {
	const ordered = sortAnnotations(annotations);
	if (ordered.length === 0) return "";

	const output: string[] = [
		document.title
			? `I reviewed \`${document.title}\`. Please address these annotations.`
			: "I reviewed your previous response. Please address these annotations.",
		"",
	];

	for (let index = 0; index < ordered.length; index++) {
		const annotation = ordered[index];
		const marker = `${index + 1}. `;
		const continuationIndent = " ".repeat(marker.length);
		const location = annotationLocation(document, annotation.target);

		output.push(`${marker}**[${annotation.kind.toUpperCase()}]** ${location}`, "");

		if (annotation.target.kind === "lines") {
			for (
				let line = annotation.target.startLine;
				line <= annotation.target.endLine;
				line++
			) {
				output.push(`${continuationIndent}> ${document.lines[line] ?? ""}`);
			}
			output.push("");
		}

		for (const bodyLine of annotation.body.split(/\r\n|\r|\n/)) {
			output.push(`${continuationIndent}${bodyLine}`);
		}
		if (index < ordered.length - 1) output.push("");
	}

	return output.join("\n");
}
