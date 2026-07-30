import { describe, expect, test } from "bun:test";
import {
	annotationsAtLine,
	createResponseDocument,
	createReviewState,
	getCurrentTarget,
	reduceReviewState,
	type ReviewState,
} from "../extensions/comment-editor/response-review.ts";

function saveAnnotation(
	state: ReviewState,
	kind: "comment" | "suggestion" | "issue",
	body: string,
): ReviewState {
	return reduceReviewState(
		reduceReviewState(state, { type: "beginDraft", kind }),
		{ type: "saveDraft", body },
	);
}

describe("response review model", () => {
	test("normalizes forward and backward selections", () => {
		let state = createReviewState(createResponseDocument("zero\none\ntwo\nthree"));
		state = reduceReviewState(state, { type: "moveTo", line: 3 });
		state = reduceReviewState(state, { type: "toggleSelection" });
		state = reduceReviewState(state, { type: "moveTo", line: 1 });

		expect(getCurrentTarget(state)).toEqual({ kind: "lines", startLine: 1, endLine: 3 });
	});

	test("clamps cursor movement and targets", () => {
		let state = createReviewState(createResponseDocument("one\ntwo"));
		state = reduceReviewState(state, { type: "move", delta: 99 });
		expect(state.cursorLine).toBe(1);
		state = reduceReviewState(state, { type: "move", delta: -99 });
		expect(state.cursorLine).toBe(0);
	});

	test("uses stable IDs and ordinals across edits", () => {
		let state = createReviewState(createResponseDocument("one"));
		state = saveAnnotation(state, "comment", "first");
		const original = state.annotations[0];

		state = reduceReviewState(state, { type: "edit", id: original.id });
		state = reduceReviewState(state, { type: "saveDraft", body: "edited" });

		expect(state.annotations).toEqual([{ ...original, body: "edited" }]);
		expect(state.nextOrdinal).toBe(2);
	});

	test("rejects blank drafts without leaving draft mode", () => {
		let state = createReviewState(createResponseDocument("one"));
		state = reduceReviewState(state, { type: "beginDraft", kind: "issue" });
		state = reduceReviewState(state, { type: "saveDraft", body: " \n\t" });

		expect(state.annotations).toHaveLength(0);
		expect(state.mode).toEqual({
			kind: "draft",
			draft: {
				kind: "issue",
				target: { kind: "lines", startLine: 0, endLine: 0 },
				initialBody: "",
				error: "Annotation text cannot be blank",
			},
		});
	});

	test("editing is transactional when cancelled", () => {
		let state = createReviewState(createResponseDocument("one"));
		state = saveAnnotation(state, "comment", "original");
		const original = state.annotations[0];
		state = reduceReviewState(state, { type: "edit", id: original.id });
		state = reduceReviewState(state, { type: "cancelDraft" });

		expect(state.annotations).toEqual([original]);
		expect(state.mode).toEqual({ kind: "browse" });
	});

	test("allows overlapping line annotations", () => {
		let state = createReviewState(createResponseDocument("zero\none\ntwo"));
		state = reduceReviewState(state, { type: "toggleSelection" });
		state = reduceReviewState(state, { type: "moveTo", line: 1 });
		state = saveAnnotation(state, "comment", "first");
		state = reduceReviewState(state, { type: "moveTo", line: 1 });
		state = reduceReviewState(state, { type: "toggleSelection" });
		state = reduceReviewState(state, { type: "moveTo", line: 2 });
		state = saveAnnotation(state, "issue", "second");

		expect(annotationsAtLine(state.annotations, 1).map((annotation) => annotation.body)).toEqual([
			"first",
			"second",
		]);
	});

	test("navigates annotations in deterministic order", () => {
		let state = createReviewState(createResponseDocument("zero\none\ntwo"));
		state = reduceReviewState(state, { type: "moveTo", line: 2 });
		state = saveAnnotation(state, "issue", "last");
		state = reduceReviewState(state, { type: "beginDraft", kind: "comment", target: { kind: "overall" } });
		state = reduceReviewState(state, { type: "saveDraft", body: "overall" });
		state = reduceReviewState(state, { type: "navigateAnnotation", delta: 1 });

		expect(state.activeAnnotationId).toBe("annotation-1");
		state = reduceReviewState(state, { type: "navigateAnnotation", delta: 1 });
		expect(state.activeAnnotationId).toBe("annotation-2");
		expect(state.cursorLine).toBe(2);
	});

	test("uses nested cancellation and discard confirmation", () => {
		let state = createReviewState(createResponseDocument("one"));
		state = reduceReviewState(state, { type: "toggleSelection" });
		state = reduceReviewState(state, { type: "requestCancel" });
		expect(state.mode).toEqual({ kind: "browse" });

		state = saveAnnotation(state, "comment", "saved");
		state = reduceReviewState(state, { type: "requestCancel" });
		expect(state.mode).toEqual({ kind: "confirmDiscard" });
		state = reduceReviewState(state, { type: "cancelDiscard" });
		expect(state.mode).toEqual({ kind: "browse" });
		state = reduceReviewState(state, { type: "requestCancel" });
		state = reduceReviewState(state, { type: "confirmDiscard" });
		expect(state.mode).toEqual({ kind: "cancelled" });
	});

	test("handles an empty source defensively as one logical line", () => {
		const state = createReviewState(createResponseDocument(""));
		expect(state.document.lines).toEqual([""]);
		expect(state.cursorLine).toBe(0);
	});
});
