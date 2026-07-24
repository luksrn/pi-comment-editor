import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";

export function getLastAssistantText(branch: readonly SessionEntry[]): string | undefined {
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (entry.type !== "message" || entry.message.role !== "assistant") {
			continue;
		}

		if (entry.message.stopReason !== "stop") {
			return undefined;
		}

		const text = entry.message.content
			.filter((part): part is { type: "text"; text: string } => part.type === "text")
			.map((part) => part.text)
			.join("\n")
			.trim();
		return text || undefined;
	}

	return undefined;
}

export function formatCommentEditorText(text: string): string {
	const quotedResponse = text
		.split(/\r?\n/)
		.map((line) => `> ${line}`)
		.join("\n");

	return `\n\n## Previous assistant response\n\n${quotedResponse}`;
}

export type CommentEditorResult =
	| { kind: "empty"; text: "" }
	| { kind: "comment"; text: string }
	| { kind: "annotated"; text: string };

function normalizeLineEndings(text: string): string {
	return text.replace(/\r\n?/g, "\n");
}

function trimBlankBoundaryLines(text: string): string {
	const lines = text.split("\n");
	let start = 0;
	let end = lines.length;

	while (start < end && /^[ \t]*$/.test(lines[start])) {
		start++;
	}
	while (end > start && /^[ \t]*$/.test(lines[end - 1])) {
		end--;
	}

	return lines.slice(start, end).join("\n");
}

export function prepareCommentEditorResult(
	savedText: string,
	initialText: string,
): CommentEditorResult {
	const normalizedSavedText = normalizeLineEndings(savedText);
	const normalizedInitialText = normalizeLineEndings(initialText);

	if (!normalizedInitialText || !normalizedSavedText.endsWith(normalizedInitialText)) {
		return { kind: "annotated", text: savedText };
	}

	const commentText = trimBlankBoundaryLines(
		normalizedSavedText.slice(0, -normalizedInitialText.length),
	);
	if (!commentText) {
		return { kind: "empty", text: "" };
	}

	return { kind: "comment", text: commentText };
}

export function parseEditorCommand(command: string): string[] {
	const args: string[] = [];
	let current = "";
	let quote: "single" | "double" | undefined;
	let tokenStarted = false;

	for (let index = 0; index < command.length; index++) {
		const character = command[index];

		if (quote === "single") {
			if (character === "'") {
				quote = undefined;
			} else {
				current += character;
			}
			continue;
		}

		if (quote === "double") {
			if (character === '"') {
				quote = undefined;
				continue;
			}
			if (character === "\\" && (command[index + 1] === '"' || command[index + 1] === "\\")) {
				current += command[++index];
				continue;
			}
			current += character;
			continue;
		}

		if (/\s/.test(character)) {
			if (tokenStarted) {
				args.push(current);
				current = "";
				tokenStarted = false;
			}
			continue;
		}

		tokenStarted = true;
		if (character === "'") {
			quote = "single";
		} else if (character === '"') {
			quote = "double";
		} else if (character === "\\") {
			if (index + 1 >= command.length) {
				throw new Error("Editor command ends with an escape character");
			}
			current += command[++index];
		} else {
			current += character;
		}
	}

	if (quote) {
		throw new Error("Editor command contains an unterminated quote");
	}
	if (tokenStarted) {
		args.push(current);
	}

	return args;
}

export function editWithExternalEditor(
	initialText: string,
	editorCommand = process.env.VISUAL || process.env.EDITOR,
): string {
	if (!editorCommand) {
		throw new Error("No editor configured. Set $VISUAL or $EDITOR.");
	}

	const [editor, ...editorArgs] = parseEditorCommand(editorCommand);
	if (!editor) {
		throw new Error("No editor configured. Set $VISUAL or $EDITOR.");
	}

	const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-comment-editor-"));
	const temporaryFile = path.join(temporaryDirectory, "comment.md");

	try {
		fs.writeFileSync(temporaryFile, initialText, "utf8");
		const result = spawnSync(editor, [...editorArgs, temporaryFile], {
			stdio: "inherit",
		});

		if (result.error) {
			throw result.error;
		}
		if (result.status !== 0) {
			throw new Error(`Editor exited with status ${result.status ?? "unknown"}`);
		}

		return fs.readFileSync(temporaryFile, "utf8").replace(/\r?\n$/, "");
	} finally {
		fs.rmSync(temporaryDirectory, { recursive: true, force: true });
	}
}

export default function commentEditorExtension(pi: ExtensionAPI) {
	pi.registerCommand("comment", {
		description: "Comment on the last assistant response in your external editor",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("comment requires interactive mode", "error");
				return;
			}

			const lastAssistantText = getLastAssistantText(ctx.sessionManager.getBranch());
			if (!lastAssistantText) {
				ctx.ui.notify("No completed assistant response found on the current branch", "error");
				return;
			}

			try {
				const initialText = formatCommentEditorText(lastAssistantText);
				const savedText = editWithExternalEditor(initialText);
				const result = prepareCommentEditorResult(savedText, initialText);
				ctx.ui.setEditorText(result.text);

				if (result.kind === "empty") {
					ctx.ui.notify("No comment entered", "info");
				} else if (result.kind === "annotated") {
					ctx.ui.notify(
						"Reference section changed; loaded the complete text into the editor",
						"info",
					);
				} else {
					ctx.ui.notify("Comment loaded into the editor", "info");
				}
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});
}
