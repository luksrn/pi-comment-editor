import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";
import commentEditorExtension, {
	completeFilePath,
	expandHome,
	handleCommentCommand,
	looksBinary,
} from "../extensions/comment-editor/index.ts";
import type { ResponseReviewResult } from "../extensions/comment-editor/response-review-component.ts";

function assistantEntry(text: string, stopReason = "stop"): SessionEntry {
	return {
		type: "message",
		id: "assistant-entry",
		parentId: null,
		timestamp: new Date(0).toISOString(),
		message: {
			role: "assistant",
			stopReason,
			content: [{ type: "text", text }],
		},
	} as SessionEntry;
}

interface FakeContextRecord {
	ctx: ExtensionCommandContext;
	notifications: Array<[string, string | undefined]>;
	editorValues: string[];
	branchReads: { count: number };
	customCalls: { count: number };
}

const temporaryDirectories: string[] = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

function temporaryDirectory(): string {
	const directory = mkdtempSync(path.join(os.tmpdir(), "pi-comment-editor-test-"));
	temporaryDirectories.push(directory);
	return directory;
}

function fakeContext(options: {
	mode?: "tui" | "rpc";
	cwd?: string;
	branch?: SessionEntry[];
	result?: ResponseReviewResult;
	error?: Error;
} = {}): FakeContextRecord {
	const notifications: Array<[string, string | undefined]> = [];
	const editorValues: string[] = [];
	const branchReads = { count: 0 };
	const customCalls = { count: 0 };
	const branch = options.branch ?? [assistantEntry("one\ntwo")];
	const ctx = {
		mode: options.mode ?? "tui",
		cwd: options.cwd ?? process.cwd(),
		ui: {
			notify(message: string, type?: string) {
				notifications.push([message, type]);
			},
			setEditorText(value: string) {
				editorValues.push(value);
			},
			async custom() {
				customCalls.count++;
				if (options.error) throw options.error;
				return options.result ?? { kind: "cancelled" };
			},
		},
		sessionManager: {
			getBranch() {
				branchReads.count++;
				return branch;
			},
		},
		sendUserMessage() {
			throw new Error("must never submit");
		},
	} as unknown as ExtensionCommandContext;
	return { ctx, notifications, editorValues, branchReads, customCalls };
}

describe("/comment command", () => {
	test("registers the native reviewer command", () => {
		let registered:
			| {
					name: string;
					options: {
						description?: string;
						handler: typeof handleCommentCommand;
						getArgumentCompletions?: (prefix: string) => unknown;
					};
				}
			| undefined;
		const pi = {
			registerCommand(name: string, options: {
				description?: string;
				handler: typeof handleCommentCommand;
				getArgumentCompletions?: (prefix: string) => unknown;
			}) {
				registered = { name, options };
			},
		} as unknown as ExtensionAPI;

		commentEditorExtension(pi);

		expect(registered?.name).toBe("comment");
		expect(registered?.options.handler).toBe(handleCommentCommand);
		expect(registered?.options.description).toContain("annotate");
		expect(registered?.options.getArgumentCompletions).toBeTypeOf("function");
	});

	test("reviews a file passed as an argument without reading the branch", async () => {
		const directory = temporaryDirectory();
		writeFileSync(path.join(directory, "notes.md"), "alpha\nbeta\n");
		const fake = fakeContext({
			cwd: directory,
			result: {
				kind: "completed",
				annotations: [
					{
						id: "annotation-1",
						ordinal: 1,
						target: { kind: "lines", startLine: 1, endLine: 1 },
						kind: "issue",
						body: "This is incorrect.",
					},
				],
			},
		});
		await handleCommentCommand("notes.md", fake.ctx);

		expect(fake.branchReads.count).toBe(0);
		expect(fake.customCalls.count).toBe(1);
		expect(fake.editorValues).toEqual([
			[
				"I reviewed `notes.md`. Please address these annotations.",
				"",
				"1. **[ISSUE]** File line 2",
				"",
				"   > beta",
				"",
				"   This is incorrect.",
			].join("\n"),
		]);
		expect(fake.notifications.at(-1)).toEqual(["Review loaded into the editor", "info"]);
	});

	test("resolves quoted and absolute file arguments against the session cwd", async () => {
		const directory = temporaryDirectory();
		writeFileSync(path.join(directory, "my notes.md"), "line one\n");
		const fake = fakeContext({ cwd: directory });

		await handleCommentCommand(`"my notes.md"`, fake.ctx);
		expect(fake.customCalls.count).toBe(1);

		const absolute = fakeContext({ cwd: directory });
		await handleCommentCommand(path.join(directory, "my notes.md"), absolute.ctx);
		expect(absolute.customCalls.count).toBe(1);
		expect(absolute.branchReads.count).toBe(0);
	});

	test("reports unreadable file arguments without opening the reviewer", async () => {
		const fake = fakeContext({ cwd: temporaryDirectory() });
		await handleCommentCommand("missing.md", fake.ctx);

		expect(fake.notifications).toHaveLength(1);
		expect(fake.notifications[0][0]).toMatch(/^Cannot read missing\.md:/);
		expect(fake.notifications[0][1]).toBe("error");
		expect(fake.branchReads.count).toBe(0);
		expect(fake.customCalls.count).toBe(0);
		expect(fake.editorValues).toEqual([]);
	});

	test("treats whitespace-only arguments as no file argument", async () => {
		const fake = fakeContext({ cwd: temporaryDirectory() });
		await handleCommentCommand("   ", fake.ctx);

		expect(fake.branchReads.count).toBe(1);
		expect(fake.customCalls.count).toBe(1);
		expect(fake.notifications).toEqual([["Response review cancelled", "info"]]);
	});

	test("rejects non-TUI invocation", async () => {
		const fake = fakeContext({ mode: "rpc" });
		await handleCommentCommand("", fake.ctx);

		expect(fake.notifications).toEqual([["comment requires interactive mode", "error"]]);
		expect(fake.branchReads.count).toBe(0);
	});

	test("uses the current branch and rejects a missing completed response", async () => {
		const fake = fakeContext({ branch: [assistantEntry("partial", "aborted")] });
		await handleCommentCommand("", fake.ctx);

		expect(fake.branchReads.count).toBe(1);
		expect(fake.customCalls.count).toBe(0);
		expect(fake.editorValues).toEqual([]);
		expect(fake.notifications).toEqual([
			["No completed assistant response found on the current branch", "error"],
		]);
	});

	test("loads a completed review into the editor exactly once", async () => {
		const fake = fakeContext({
			result: {
				kind: "completed",
				annotations: [
					{
						id: "annotation-1",
						ordinal: 1,
						target: { kind: "lines", startLine: 1, endLine: 1 },
						kind: "issue",
						body: "This is incorrect.",
					},
				],
			},
		});
		await handleCommentCommand("", fake.ctx);

		expect(fake.customCalls.count).toBe(1);
		expect(fake.editorValues).toEqual([
			[
				"I reviewed your previous response. Please address these annotations.",
				"",
				"1. **[ISSUE]** Response line 2",
				"",
				"   > two",
				"",
				"   This is incorrect.",
			].join("\n"),
		]);
		expect(fake.notifications.at(-1)).toEqual(["Review loaded into the editor", "info"]);
	});

	for (const result of [{ kind: "cancelled" }, { kind: "empty" }] as const) {
		test(`${result.kind} review preserves the existing prompt`, async () => {
			const fake = fakeContext({ result });
			await handleCommentCommand("", fake.ctx);

			expect(fake.editorValues).toEqual([]);
			expect(fake.notifications).toHaveLength(1);
			expect(fake.notifications[0][1]).toBe("info");
		});
	}

	test("component failures are visible and preserve the prompt", async () => {
		const fake = fakeContext({ error: new Error("reviewer failed") });
		await handleCommentCommand("", fake.ctx);

		expect(fake.editorValues).toEqual([]);
		expect(fake.notifications).toEqual([["reviewer failed", "error"]]);
	});

	test("expands a leading tilde to the home directory", () => {
		expect(expandHome("~")).toBe(os.homedir());
		expect(expandHome("~/docs/notes.md")).toBe(path.join(os.homedir(), "docs/notes.md"));
		expect(expandHome("plain.md")).toBe("plain.md");
		expect(expandHome("/abs/file.md")).toBe("/abs/file.md");
		expect(expandHome("~", "/fake/home")).toBe("/fake/home");
		expect(expandHome("~/x", "/fake/home")).toBe("/fake/home/x");
	});

	test("reviews a file argument with a tilde against the home directory", async () => {
		const home = mkdtempSync(path.join(os.homedir(), ".pi-comment-editor-tilde-"));
		temporaryDirectories.push(home);
		writeFileSync(path.join(home, "notes.md"), "alpha\nbeta\n");
		const fake = fakeContext({
			cwd: temporaryDirectory(),
			result: {
				kind: "completed",
				annotations: [
					{
						id: "annotation-1",
						ordinal: 1,
						target: { kind: "lines", startLine: 1, endLine: 1 },
						kind: "comment",
						body: "Nice.",
					},
				],
			},
		});

		await handleCommentCommand(`~/${path.basename(home)}/notes.md`, fake.ctx);

		expect(fake.branchReads.count).toBe(0);
		expect(fake.customCalls.count).toBe(1);
		expect(fake.notifications.at(-1)).toEqual(["Review loaded into the editor", "info"]);
	});

	test("rejects binary file arguments without opening the reviewer", async () => {
		const directory = temporaryDirectory();
		const zip = Buffer.concat([
			Buffer.from("PK\x03\x04"),
			Buffer.from([0x14, 0x00, 0x00, 0x00, 0x00, 0x00]),
			Buffer.from("compressed-data\x00\x01\x02\x03"),
		]);
		writeFileSync(path.join(directory, "archive.zip"), zip);
		const fake = fakeContext({ cwd: directory });

		await handleCommentCommand("archive.zip", fake.ctx);

		expect(fake.notifications).toEqual([[`Cannot review archive.zip: not a text file`, "error"]]);
		expect(fake.branchReads.count).toBe(0);
		expect(fake.customCalls.count).toBe(0);
		expect(fake.editorValues).toEqual([]);
	});

	describe("looksBinary", () => {
		test("accepts plain text and empty files", () => {
			expect(looksBinary(Buffer.from(""))).toBe(false);
			expect(looksBinary(Buffer.from("plain text\nwith tabs\tand newlines\n"))).toBe(false);
			expect(looksBinary(Buffer.from("{\"json\": \"value\"}\n"))).toBe(false);
			expect(looksBinary(Buffer.from("Markdown with émoji 🎉 and accents\n"))).toBe(false);
		});

		test("rejects NUL bytes and control-character-heavy content", () => {
			expect(looksBinary(Buffer.from([0x61, 0x00, 0x62]))).toBe(true);
			const controls = Buffer.from(Array.from({ length: 100 }, () => 0x01));
			expect(looksBinary(controls)).toBe(true);
		});

		test("rejects binary signatures and undecodable UTF-8", () => {
			expect(looksBinary(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(true);
			const jpegish = Buffer.from(Array.from({ length: 64 }, (_, i) => 0xc0 + (i % 8)));
			expect(looksBinary(jpegish)).toBe(true);
		});
	});

	describe("completeFilePath", () => {
		test("suggests files and directories under the given prefix", () => {
			const directory = temporaryDirectory();
			mkdirSync(path.join(directory, "sub"));
			writeFileSync(path.join(directory, "alpha.md"), "");
			writeFileSync(path.join(directory, "beta.md"), "");

			const items = completeFilePath("a", directory);
			expect(items?.map((item) => item.value)).toEqual(["alpha.md"]);

			const subdir = completeFilePath("", directory);
			expect(subdir?.map((item) => item.value)).toEqual(["alpha.md", "beta.md", "sub/"]);

			const nested = completeFilePath("su", directory);
			expect(nested?.map((item) => item.value)).toEqual(["sub/"]);

			expect(completeFilePath("zzz", directory)).toBeNull();
		});

		test("expands home directories and absolute paths", () => {
			const directory = temporaryDirectory();
			writeFileSync(path.join(directory, "file.md"), "");

			const absolute = completeFilePath(path.join(directory, "fi"), process.cwd());
			expect(absolute?.map((item) => item.value)).toEqual([path.join(directory, "file.md")]);

			const home = completeFilePath("~", process.cwd());
			expect(home?.some((item) => item.value.startsWith("~/"))).toBe(true);
		});
	});
});
