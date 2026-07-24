import { describe, expect, test } from "bun:test";
import path from "node:path";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
	editWithExternalEditor,
	formatCommentEditorText,
	getLastAssistantText,
	parseEditorCommand,
	prepareCommentEditorResult,
} from "../extensions/comment-editor/index.ts";

function entries(messages: unknown[]): SessionEntry[] {
	return messages.map(
		(message, index) =>
			({
				type: "message",
				id: `entry-${index}`,
				parentId: index === 0 ? null : `entry-${index - 1}`,
				timestamp: new Date(0).toISOString(),
				message,
			}) as SessionEntry,
	);
}

describe("getLastAssistantText", () => {
	test("returns text from the latest completed assistant response", () => {
		const branch = entries([
			{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "older" }] },
			{ role: "toolResult", content: [{ type: "text", text: "tool output" }] },
			{
				role: "assistant",
				stopReason: "stop",
				content: [
					{ type: "thinking", thinking: "hidden" },
					{ type: "text", text: " latest " },
					{ type: "text", text: "response" },
				],
			},
		]);

		expect(getLastAssistantText(branch)).toBe("latest \nresponse");
	});

	test("does not fall back past an incomplete latest response", () => {
		const branch = entries([
			{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "older" }] },
			{ role: "assistant", stopReason: "aborted", content: [{ type: "text", text: "partial" }] },
		]);

		expect(getLastAssistantText(branch)).toBeUndefined();
	});
});

test("starts with a comment area followed by the quoted assistant response", () => {
	expect(formatCommentEditorText("one\n\ntwo")).toBe(
		"\n\n## Previous assistant response\n\n> one\n> \n> two",
	);
});

describe("prepareCommentEditorResult", () => {
	const initialText = formatCommentEditorText("one\ntwo");

	test("extracts a general comment above an unchanged response", () => {
		expect(prepareCommentEditorResult(`Please simplify this.${initialText}`, initialText)).toEqual({
			kind: "comment",
			text: "Please simplify this.",
		});
	});

	test("returns empty when no comment was entered", () => {
		expect(prepareCommentEditorResult(`\n \t\n${initialText}`, initialText)).toEqual({
			kind: "empty",
			text: "",
		});
	});

	test("trims blank boundary lines without changing comment formatting", () => {
		const savedText = `\n\n  Keep this indentation\n\n    and this  \n\n${initialText}`;

		expect(prepareCommentEditorResult(savedText, initialText)).toEqual({
			kind: "comment",
			text: "  Keep this indentation\n\n    and this  ",
		});
	});

	test("accepts line-ending conversion as an unchanged response", () => {
		const savedText = `Use fewer abstractions.${initialText}`.replaceAll("\n", "\r\n");

		expect(prepareCommentEditorResult(savedText, initialText)).toEqual({
			kind: "comment",
			text: "Use fewer abstractions.",
		});
	});

	test("preserves an inline annotation exactly", () => {
		const savedText = initialText.replace("> one\n> two", "> one\nThis part is unclear.\n> two");

		expect(prepareCommentEditorResult(savedText, initialText)).toEqual({
			kind: "annotated",
			text: savedText,
		});
	});

	test("preserves malformed or edited reference sections exactly", () => {
		for (const savedText of [
			initialText.replace("## Previous assistant response", "## Earlier response"),
			initialText.replace("> two", "> changed"),
			initialText.replace("> two", ""),
		]) {
			expect(prepareCommentEditorResult(savedText, initialText)).toEqual({
				kind: "annotated",
				text: savedText,
			});
		}
	});
});

describe("parseEditorCommand", () => {
	test("supports flags and quoted paths", () => {
		expect(parseEditorCommand("'Visual Studio Code' --wait \"profile name\"")).toEqual([
			"Visual Studio Code",
			"--wait",
			"profile name",
		]);
	});

	test("rejects an unterminated quote", () => {
		expect(() => parseEditorCommand("editor 'unfinished")).toThrow("unterminated quote");
	});
});

test("loads the editor's saved contents", () => {
	const fixture = path.join(import.meta.dir, "fixtures", "editor.mjs");
	const result = editWithExternalEditor("quoted response", `"${process.execPath}" "${fixture}"`);

	expect(result).toBe("quoted response\n\nMy comment");
});
