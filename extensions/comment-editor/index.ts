import type {
	ExtensionAPI,
	ExtensionCommandContext,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { ResponseReviewComponent, type ResponseReviewResult } from "./response-review-component.ts";
import { createResponseDocument, formatReviewMessage } from "./response-review.ts";

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

export async function handleCommentCommand(
	args: string,
	ctx: ExtensionCommandContext,
): Promise<void> {
	if (args.trim()) {
		ctx.ui.notify("Usage: /comment", "error");
		return;
	}
	if (ctx.mode !== "tui") {
		ctx.ui.notify("comment requires interactive mode", "error");
		return;
	}

	const lastAssistantText = getLastAssistantText(ctx.sessionManager.getBranch());
	if (!lastAssistantText) {
		ctx.ui.notify("No completed assistant response found on the current branch", "error");
		return;
	}

	const document = createResponseDocument(lastAssistantText);
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
		description: "Review and annotate the latest assistant response",
		handler: handleCommentCommand,
	});
}
