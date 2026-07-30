import { describe, expect, test } from "bun:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { getLastAssistantText } from "../extensions/comment-editor/index.ts";

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

	test("ignores non-text assistant content", () => {
		const branch = entries([
			{
				role: "assistant",
				stopReason: "stop",
				content: [{ type: "thinking", thinking: "not reviewable" }],
			},
		]);

		expect(getLastAssistantText(branch)).toBeUndefined();
	});
});
