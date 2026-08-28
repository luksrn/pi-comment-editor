import type {
	ExtensionAPI,
	ExtensionCommandContext,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { readdirSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
	ResponseReviewComponent,
	type ResponseReviewResult,
} from "./response-review-component.ts";
import {
	createResponseDocument,
	formatReviewMessage,
	type ResponseDocument,
} from "./response-review.ts";

export function getLastAssistantText(branch: readonly SessionEntry[]): string | undefined {
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		if (entry.message.stopReason !== "stop") return undefined;

		const text = entry.message.content
			.filter((part): part is { type: "text"; text: string } => part.type === "text")
			.map((part) => part.text)
			.join("\n")
			.trim();
		return text || undefined;
	}

	return undefined;
}

function parseFilePath(args: string): string | undefined {
	const path = args.trim();
	if (!path) return undefined;
	if (
		path.length >= 2 &&
		((path.startsWith('"') && path.endsWith('"')) ||
			(path.startsWith("'") && path.endsWith("'")))
	) {
		return path.slice(1, -1);
	}
	return path;
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function stripQuotes(value: string): string {
	if (
		value.length >= 2 &&
		((value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'")))
	) {
		return value.slice(1, -1);
	}
	return value;
}

/**
 * Expand a leading `~` to the user's home directory. Other values are returned
 * untouched so they resolve relative to the session working directory.
 */
export function expandHome(value: string, home: string = homedir()): string {
	if (value === "~") return home;
	if (value.startsWith("~/")) return join(home, value.slice(2));
	return value;
}

/**
 * Reject content that is clearly not UTF-8 text: any NUL byte, or more than
 * one control character / undecodable sequence in the first 8000 bytes
 * (mirroring Git's buffer_is_binary). So .zip, images, and other binary
 * files fail closed while any text file (.md, .json, ...) passes regardless
 * of its extension.
 */
export function looksBinary(data: Uint8Array): boolean {
	const sample = data.subarray(0, 8000);
	if (sample.length === 0) return false;
	for (const byte of sample) {
		if (byte === 0) return true;
	}
	let nonPrintable = 0;
	for (const char of new TextDecoder("utf-8", { fatal: false }).decode(sample)) {
		const code = char.codePointAt(0)!;
		if (code === 0xfffd || (code < 0x20 && !"\t\n\r\f\b".includes(char))) nonPrintable++;
	}
	return nonPrintable > 1;
}

/**
 * Suggest file paths for `/comment <path>`, mirroring pi's own file
 * completion: relative to the process working directory, `~` expanded, with
 * directories marked by a trailing slash. No shell is involved.
 */
export function completeFilePath(
	prefix: string,
	cwd: string = process.cwd(),
): AutocompleteItem[] | null {
	const path = stripQuotes(prefix.trim());

	const expanded = expandHome(path);

	let searchDir: string;
	let searchPrefix: string;
	if (path.endsWith("/") || path === "~") {
		searchDir =
			expanded.startsWith("/") || expanded.startsWith("~") ? expanded : join(cwd, expanded);
		searchPrefix = "";
	} else {
		const directory = dirname(expanded);
		searchDir = directory.startsWith("/") || directory.startsWith("~") ? directory : join(cwd, directory);
		searchPrefix = basename(expanded);
	}

	let entries;
	try {
		entries = readdirSync(searchDir, { withFileTypes: true });
	} catch {
		return null;
	}

	const items: AutocompleteItem[] = [];
	const sorted = [...entries].sort((left, right) =>
		left.name.localeCompare(right.name, undefined, { sensitivity: "base" }),
	);
	for (const entry of sorted) {
		if (!entry.name.toLowerCase().startsWith(searchPrefix.toLowerCase())) continue;
		let isDirectory = entry.isDirectory();
		if (!isDirectory && entry.isSymbolicLink()) {
			try {
				isDirectory = statSync(join(searchDir, entry.name)).isDirectory();
			} catch {
				isDirectory = false;
			}
		}
		const directoryPart =
			path === "~" ? "~/" : path.endsWith("/") ? path : path.slice(0, path.lastIndexOf("/") + 1);
		items.push({
			value: `${directoryPart}${entry.name}${isDirectory ? "/" : ""}`,
			label: `${directoryPart}${entry.name}${isDirectory ? "/" : ""}`,
		});
	}
	return items.length > 0 ? items : null;
}

export async function handleCommentCommand(
	args: string,
	ctx: ExtensionCommandContext,
): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("comment requires interactive mode", "error");
		return;
	}

	const filePath = parseFilePath(args);
	let document: ResponseDocument;
	if (filePath !== undefined) {
		try {
			const data = await readFile(resolve(ctx.cwd, expandHome(filePath)));
			if (looksBinary(data)) {
				ctx.ui.notify(`Cannot review ${filePath}: not a text file`, "error");
				return;
			}
			const text = data.toString("utf8");
			document = createResponseDocument(text, filePath);
		} catch (error) {
			ctx.ui.notify(`Cannot read ${filePath}: ${errorText(error)}`, "error");
			return;
		}
	} else {
		const lastAssistantText = getLastAssistantText(ctx.sessionManager.getBranch());
		if (!lastAssistantText) {
			ctx.ui.notify("No completed assistant response found on the current branch", "error");
			return;
		}
		document = createResponseDocument(lastAssistantText, undefined, { markdown: true });
	}

	try {
		const result = await ctx.ui.custom<ResponseReviewResult>((tui, theme, _keybindings, done) =>
			new ResponseReviewComponent(tui, theme, document, done),
		);

		if (result.kind === "cancelled") {
			ctx.ui.notify("Response review cancelled", "info");
			return;
		}
		if (result.kind === "empty") {
			ctx.ui.notify("No comments entered", "info");
			return;
		}

		const message = formatReviewMessage(document, result.annotations);
		if (!message) {
			ctx.ui.notify("No comments entered", "info");
			return;
		}
		ctx.ui.setEditorText(message);
		ctx.ui.notify("Review loaded into the editor", "info");
	} catch (error) {
		ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
	}
}

export default function commentEditorExtension(pi: ExtensionAPI) {
	pi.registerCommand("comment", {
		description:
			"Review and annotate the latest assistant response, or a file passed as an argument",
		handler: handleCommentCommand,
		getArgumentCompletions: (prefix) => completeFilePath(prefix),
	});
}
