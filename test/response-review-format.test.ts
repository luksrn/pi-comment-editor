import { describe, expect, test } from "bun:test";
import {
	createResponseDocument,
	formatReviewMessage,
	type ResponseAnnotation,
} from "../extensions/comment-editor/response-review.ts";

describe("formatReviewMessage", () => {
	test("formats overall, single-line, and multi-line annotations deterministically", () => {
		const document = createResponseDocument("# Heading\n\n> quoted\n```ts\nconst x = `value`;\n```\n界");
		const annotations: ResponseAnnotation[] = [
			{
				id: "late",
				ordinal: 1,
				target: { kind: "lines", startLine: 3, endLine: 5 },
				kind: "suggestion",
				body: "Use a runnable example.\nKeep the formatting.",
			},
			{
				id: "overall",
				ordinal: 2,
				target: { kind: "overall" },
				kind: "comment",
				body: "Please make this shorter.",
			},
			{
				id: "first",
				ordinal: 3,
				target: { kind: "lines", startLine: 1, endLine: 1 },
				kind: "issue",
				body: "This blank line is significant.",
			},
		];

		expect(formatReviewMessage(document, annotations)).toBe(
			[
				"I reviewed your previous response. Please address these annotations.",
				"",
				"1. **[COMMENT]** Overall response",
				"",
				"   Please make this shorter.",
				"",
				"2. **[ISSUE]** Response line 2",
				"",
				"   > ",
				"",
				"   This blank line is significant.",
				"",
				"3. **[SUGGESTION]** Response lines 4-6",
				"",
				"   > ```ts",
				"   > const x = `value`;",
				"   > ```",
				"",
				"   Use a runnable example.",
				"   Keep the formatting.",
			].join("\n"),
		);
	});

	test("preserves overlapping exact quotes, whitespace, and Unicode", () => {
		const document = createResponseDocument("  indented  \n界\n");
		const annotations: ResponseAnnotation[] = [
			{
				id: "a",
				ordinal: 2,
				target: { kind: "lines", startLine: 0, endLine: 1 },
				kind: "comment",
				body: "First",
			},
			{
				id: "b",
				ordinal: 1,
				target: { kind: "lines", startLine: 0, endLine: 0 },
				kind: "issue",
				body: "Second",
			},
		];
		const output = formatReviewMessage(document, annotations);

		expect(output).toContain("1. **[ISSUE]** Response line 1\n\n   >   indented  ");
		expect(output).toContain("2. **[COMMENT]** Response lines 1-2\n\n   >   indented  \n   > 界");
		expect(output.endsWith("\n")).toBe(false);
	});

	test("returns an empty message for no annotations", () => {
		expect(formatReviewMessage(createResponseDocument("one"), [])).toBe("");
	});

	test("aligns continuation content with multi-digit list markers", () => {
		const document = createResponseDocument("quoted");
		const annotations: ResponseAnnotation[] = Array.from({ length: 10 }, (_, index) => ({
			id: `annotation-${index + 1}`,
			ordinal: index + 1,
			target: { kind: "lines", startLine: 0, endLine: 0 },
			kind: "comment",
			body: `Body ${index + 1}`,
		}));

		const output = formatReviewMessage(document, annotations);
		expect(output).toContain("9. **[COMMENT]** Response line 1\n\n   > quoted\n\n   Body 9");
		expect(output).toContain("10. **[COMMENT]** Response line 1\n\n    > quoted\n\n    Body 10");
	});
});
