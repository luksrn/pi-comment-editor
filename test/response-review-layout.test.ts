import { describe, expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	buildWrappedSourceRows,
	createResponseDocument,
	ensureCursorVisible,
	highlightFencedCodeLines,
	pageTarget,
	sanitizeDisplayText,
} from "../extensions/comment-editor/response-review.ts";

describe("response review layout", () => {
	test("maps wrapped rows back to immutable logical lines", () => {
		const rows = buildWrappedSourceRows(createResponseDocument("abcdefgh\nxy"), 3);

		expect(rows.map(({ sourceLine, text, continuation }) => ({ sourceLine, text, continuation }))).toEqual([
			{ sourceLine: 0, text: "abc", continuation: false },
			{ sourceLine: 0, text: "def", continuation: true },
			{ sourceLine: 0, text: "gh", continuation: true },
			{ sourceLine: 1, text: "xy", continuation: false },
		]);
	});

	test("keeps every wrapped body row within its width", () => {
		const document = createResponseDocument(
			"plain words and https://example.test/a/very/long/path\n界界界\né\n👩‍💻 family 👨‍👩‍👧‍👦\nمرحبا",
		);
		for (const width of [1, 2, 4, 8, 16]) {
			for (const row of buildWrappedSourceRows(document, width)) {
				expect(visibleWidth(row.text)).toBeLessThanOrEqual(width);
			}
		}
	});

	test("sanitizes terminal controls for display without changing source", () => {
		const source = "a\tb\u001b[31mred\u0007\u007f";
		const document = createResponseDocument(source);

		expect(document.lines[0]).toBe(source);
		expect(document.displayLines[0]).toBe("a    b␛[31mred␇␡");
		expect(sanitizeDisplayText("\u0085")).toBe("\\u{85}");
	});

	test("syntax-highlights fenced code without changing source-line identity", () => {
		const document = createResponseDocument(
			"Before\n```typescript\nconst value = 1;\nconsole.log(value);\n```\nAfter",
		);
		const highlighted = highlightFencedCodeLines(
			document,
			(code, language) => {
				expect(language).toBe("typescript");
				return code.split("\n").map((line) => `\x1b[35m${line}\x1b[39m`);
			},
			(line) => `\x1b[2m${line}\x1b[22m`,
		);

		expect(document.lines[2]).toBe("const value = 1;");
		expect(highlighted[1]).toBe("\x1b[2m```typescript\x1b[22m");
		expect(highlighted[2]).toBe("\x1b[35mconst value = 1;\x1b[39m");
		expect(highlighted[4]).toBe("\x1b[2m```\x1b[22m");
		expect(buildWrappedSourceRows(document, 80, highlighted).map((row) => row.sourceLine)).toEqual([
			0, 1, 2, 3, 4, 5,
		]);
	});

	test("keeps the cursor's wrapped row visible", () => {
		const rows = buildWrappedSourceRows(createResponseDocument("aaaaaa\nb\ncccccc"), 2);
		expect(ensureCursorVisible(rows, 2, 0, 3)).toBe(4);
		expect(ensureCursorVisible(rows, 0, 4, 3)).toBe(0);
	});

	test("moves pages by display rows and returns a logical line and viewport", () => {
		const rows = buildWrappedSourceRows(createResponseDocument("aaaaaa\nb\nc\nd"), 2);
		expect(pageTarget(rows, 0, 0, 1, 4)).toEqual({ line: 1, viewportOffset: 2 });
		expect(pageTarget(rows, 3, 2, -1, 4)).toEqual({ line: 0, viewportOffset: 0 });
	});

	test("pages through a logical line taller than the viewport", () => {
		const rows = buildWrappedSourceRows(createResponseDocument(`${"a".repeat(20)}\nnext`), 2);
		const firstPage = pageTarget(rows, 0, 0, 1, 4);
		const secondPage = pageTarget(rows, firstPage.line, firstPage.viewportOffset, 1, 4);

		expect(firstPage).toEqual({ line: 0, viewportOffset: 3 });
		expect(secondPage).toEqual({ line: 0, viewportOffset: 6 });
		expect(ensureCursorVisible(rows, 0, secondPage.viewportOffset, 4)).toBe(6);
	});
});
