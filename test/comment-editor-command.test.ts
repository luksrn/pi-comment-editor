import { describe, expect, test } from "bun:test";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";
import commentEditorExtension, {
	handleCommentCommand,
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

function fakeContext(options: {
	mode?: "tui" | "rpc";
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
			| { name: string; options: { description?: string; handler: typeof handleCommentCommand } }
			| undefined;
		const pi = {
			registerCommand(name: string, options: { description?: string; handler: typeof handleCommentCommand }) {
				registered = { name, options };
			},
		} as unknown as ExtensionAPI;

		commentEditorExtension(pi);

		expect(registered?.name).toBe("comment");
		expect(registered?.options.handler).toBe(handleCommentCommand);
		expect(registered?.options.description).toContain("annotate");
	});

	test("rejects arguments without opening the reviewer", async () => {
		const fake = fakeContext();
		await handleCommentCommand("unexpected", fake.ctx);

		expect(fake.notifications).toEqual([["Usage: /comment", "error"]]);
		expect(fake.branchReads.count).toBe(0);
		expect(fake.customCalls.count).toBe(0);
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
});
