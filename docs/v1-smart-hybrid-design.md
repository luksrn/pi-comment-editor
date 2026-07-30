# V1 smart-hybrid comment output

## Workflow status

```text
Mode: compact
Current phase: complete

Product review: approved
System architecture: approved
Program design: approved
Vertical slices: approved

Direct change: n/a
Approved slice batches: Slice 1
Implemented slice batches: Slice 1
Human-reviewed slice batches: Slice 1
```

## Product review

### Problem

**Observed at the V0.2.0 planning baseline:** `/comment` copied the complete
saved external-editor buffer into Pi's prompt editor. This included the quoted
assistant response, even when the user only added a general comment above it
(`extensions/comment-editor/index.ts:153-156` at V0.2.0).

**Observed:** The documented workflow supports both general comments above the
response and inline annotations among quoted response lines (`README.md:36-48`).

**Decided:** Use smart-hybrid output so the common general-comment workflow does
not duplicate the response, while inline annotations retain their positional
context.

### Approved behavior

| Saved editor state | Text loaded into Pi |
| --- | --- |
| General comment above an otherwise unchanged reference | General comment only |
| No comment and unchanged reference | Empty prompt; notify `No comment entered` |
| Inline comment among quoted lines | Complete annotated buffer |
| Quoted response edited or partially removed | Complete edited buffer |
| Heading or scaffold changed or unrecognizable | Complete saved buffer; never discard uncertain content |
| Editor fails or exits unsuccessfully | Existing error behavior; do not replace Pi's editor |

Surrounding template whitespace is removed from an extracted general comment.
Its internal formatting remains intact.

### Examples

#### General comment

External editor:

```markdown
Please simplify the implementation and add a regression test.

## Previous assistant response

> Here is the proposed implementation...
```

Pi's prompt receives:

```markdown
Please simplify the implementation and add a regression test.
```

#### Inline annotation

External editor:

```markdown
## Previous assistant response

> Introduce another abstraction here.

I don't think this abstraction is necessary.

> Then add a fallback layer.
```

Pi receives the complete annotated document because the quote provides
positional context.

### Acceptance criteria

1. An unchanged reference is not duplicated when the user only writes above it.
2. Inline or quoted-region edits retain their complete context.
3. Uncertain parsing never silently removes user text.
4. Saving without commenting does not place the assistant response in the
   prompt.
5. `/comment` still never submits automatically.
6. Current-branch, TUI-only, and shell-free editor behavior remains unchanged.

### Success signal

For a general comment, Pi's prompt editor contains only what the user wrote. For
an inline annotation or uncertain buffer shape, it contains the complete saved
buffer without data loss.

### Non-goals

- Generating textual anchors for inline comments.
- Adding output modes or configuration.
- Automatically submitting the resulting prompt.
- Changing response selection, editor launching, or command parsing.

## System architecture

### Classification

**Decided:** This change **fits** the current architecture. It adds one
transformation between the existing external-editor result and Pi's prompt
editor. It requires no new component, persistence, event hook, or Pi API.

### Current flow

```text
User             Extension          External editor        Pi prompt editor
 |                   |                     |                       |
 |-- /comment ------>|                     |                       |
 |                   |-- open scaffold --->|                       |
 |                   |<-- saved buffer ----|                       |
 |                   |-- complete saved buffer ------------------->|
 |                   |                     |                       |
```

### Proposed flow

```text
User            -> Extension:       /comment
Extension       -> Extension:       Read latest completed response
                                      from the current branch
Extension       -> External editor: Open generated scaffold
External editor -> Extension:       Return saved buffer
Extension       -> Extension:       Compare saved buffer with the
                                      original reference scaffold

                         +----------------------+
                         | Unchanged reference? |
                         +----------+-----------+
                                    |
                         +----------+----------+
                         |                     |
                        yes                    no
                         |                     |
                         v                     v
                Extract prefix as      Preserve complete
                general comment        saved buffer
                         |                     |
                         +----------+----------+
                                    |
                                    v
Extension       -> Pi prompt editor: Load selected text

If the extracted comment is empty:
Extension       -> User:             Notify `No comment entered`
```

### Contract and ownership

- The extension owns the exact generated reference scaffold for each command
  invocation.
- The external editor owns only the saved buffer returned to the extension.
- The extension classifies that buffer before calling Pi's prompt-editor API.
- Pi remains responsible for displaying the resulting text and for submission.
- No state persists after the command finishes.

### Classification rule

1. Normalize line endings for comparison.
2. Check whether the saved buffer ends with the exact generated reference
   scaffold.
3. If it does, treat the preceding prefix as the general comment.
4. If it does not, preserve the complete saved buffer.
5. Never heuristically parse or remove modified quoted content.

This deliberately makes the fallback lossless: ambiguity costs context rather
than user-authored text.

### Failure behavior

- Missing or incomplete assistant response: preserve the current error.
- Missing editor configuration: preserve the current error.
- Editor launch failure or unsuccessful exit: preserve the current error and do
  not replace Pi's prompt text.
- Unrecognized scaffold: load the complete buffer rather than failing or
  stripping text.
- Empty extracted comment: load empty text and visibly report that no comment
  was entered.

### Security and compatibility

- External editors remain restricted to Pi's interactive TUI.
- Editor commands remain shell-free.
- Response lookup continues using the current session branch.
- Existing inline-comment documents continue to reach Pi unchanged.
- The behavior change is limited to comments placed above an unchanged
  reference.

### Rejected alternatives

#### Always strip the quoted response

Rejected because inline comments lose their positional context.

#### Always preserve the complete buffer

Rejected because it duplicates the response in the common general-comment
workflow.

#### Generate anchors for inline comments

Rejected for V1 because it introduces heuristic parsing and generated wording
without sufficient benefit.

#### Add modes or configuration

Rejected for V1 because the lossless classification rule can infer the desired
behavior without adding user-facing configuration.

## Program design

### Current execution model

```text
commentEditorExtension
  -> registerCommand("comment")
     -> command handler
        -> reject non-TUI mode
        -> sessionManager.getBranch()
        -> getLastAssistantText(branch)
        -> formatCommentEditorText(response)
        -> editWithExternalEditor(initialText)
           -> parseEditorCommand(command)
           -> create temporary directory and file
           -> spawnSync(editor, arguments + temporary file)
           -> read saved buffer
           -> remove temporary directory
        -> ui.setEditorText(saved buffer)
        -> ui.notify("Comment loaded into the editor")
```

The current handler has only one post-editor outcome: every successful saved
buffer is passed unchanged to Pi. Editor errors propagate to the handler's
existing `catch`, which reports them without calling `setEditorText`.

### Proposed execution model

```diff
 commentEditorExtension
   -> registerCommand("comment")
      -> command handler
         -> reject non-TUI mode
         -> sessionManager.getBranch()
         -> getLastAssistantText(branch)
-        -> editWithExternalEditor(formatCommentEditorText(response))
-        -> ui.setEditorText(saved buffer)
+        -> initialText = formatCommentEditorText(response)
+        -> savedText = editWithExternalEditor(initialText)
+        -> result = prepareCommentEditorResult(savedText, initialText)
+        -> ui.setEditorText(result.text)
+        -> notify according to result.kind
```

`prepareCommentEditorResult` is a pure transformation. It owns all
classification and extraction behavior; the command handler retains ownership
of Pi UI side effects.

### Types and signatures

Add one exported discriminated union beside the existing formatting helpers:

```typescript
export type CommentEditorResult =
  | { kind: "empty"; text: "" }
  | { kind: "comment"; text: string }
  | { kind: "annotated"; text: string };
```

Add one exported pure helper:

```typescript
export function prepareCommentEditorResult(
  savedText: string,
  initialText: string,
): CommentEditorResult;
```

Invariants:

- `empty` always carries an empty string.
- `comment` contains only the general-comment prefix and is non-empty.
- `annotated` contains the complete saved buffer exactly as returned by
  `editWithExternalEditor`.
- Classification never mutates the supplied strings.

The helpers used only to normalize line endings for comparison and trim blank
boundary lines remain private to the extension module.

### Classification algorithm

```text
normalizedSaved   = normalize CRLF and CR to LF in savedText
normalizedInitial = normalize CRLF and CR to LF in initialText

if normalizedSaved does not end with normalizedInitial:
    return { kind: "annotated", text: savedText }

prefix = portion of normalizedSaved before normalizedInitial
comment = remove leading and trailing blank lines from prefix

if comment is empty:
    return { kind: "empty", text: "" }

return { kind: "comment", text: comment }
```

Blank-line trimming removes lines containing only spaces or tabs. It does not
trim indentation or trailing spaces from non-blank content lines. Extracted
general comments use LF line endings; lossless fallback text keeps the editor's
original line endings.

### Representative stacks

#### General comment

```text
handler
  -> create initial scaffold
  -> external editor returns `comment + unchanged scaffold`
  -> prepareCommentEditorResult returns `comment`
  -> setEditorText(comment)
  -> notify `Comment loaded into the editor`
```

#### Empty comment

```text
handler
  -> external editor returns unchanged scaffold
  -> prepareCommentEditorResult returns `empty`
  -> setEditorText("")
  -> notify `No comment entered`
```

#### Inline or otherwise modified reference section

```text
handler
  -> external editor returns a buffer that no longer ends with the scaffold
  -> prepareCommentEditorResult returns `annotated` with the exact saved buffer
  -> setEditorText(saved buffer)
  -> notify `Reference section changed; loaded the complete text into the editor`
```

#### Editor failure

```text
handler
  -> editWithExternalEditor throws
  -> existing catch reports the error
  -> prepareCommentEditorResult is not called
  -> setEditorText is not called
```

### File-tree diff

```text
M extensions/comment-editor/index.ts
  Add the pure result classifier and route successful editor output through it.

M test/comment-editor.test.ts
  Cover general, empty, inline, malformed, whitespace, and line-ending cases.

M README.md
  Document when only the comment is loaded and when complete annotations remain.

M docs/v1-smart-hybrid-design.md
  Track approvals, detailed design, implementation slices, and review outcomes.
```

No new runtime files, dependencies, configuration, persistence, schemas, or Pi
hooks are introduced.

### Validation seams

Automated tests will establish that:

1. A general comment above an unchanged scaffold returns `comment` without the
   scaffold.
2. An unchanged scaffold and a blank-only prefix return `empty`.
3. Internal blank lines and indentation in a general comment are preserved.
4. CRLF conversion alone does not force the annotated fallback.
5. Inline insertion, heading edits, and quoted-response edits return
   `annotated` with the exact saved buffer.
6. Existing response selection, editor command parsing, and external-editor
   tests continue passing.

Repository validation remains `npm run check`, which type-checks, runs tests,
and verifies package contents.

Hands-on validation in Pi's TUI will cover three flows with a wait-capable
editor:

1. Add a general comment and confirm only that comment appears in Pi.
2. Add an inline annotation and confirm the complete annotated response appears.
3. Save without adding a comment and confirm Pi stays empty with a visible
   notification.

### Rejected code shapes

- An `input` event hook is unnecessary because classification can happen before
  `setEditorText`; a hook would add persistent state and affect later input.
- Injecting editor or UI dependencies into the pure classifier would broaden a
  local transformation and require unnecessary mocks.
- Returning only a string would hide whether the handler should report an empty,
  general-comment, or annotated outcome.
- Parsing Markdown quote blocks would conflict with the approved exact-scaffold,
  lossless-fallback contract.

### Program-design risks

- Some editors may alter whitespace beyond newline style. Those cases
  deliberately take the lossless annotated path.
- The exact notification wording is user-visible. The proposed wording above is
  part of this program-design approval.

## Vertical slices

### Slice 1: Smart-hybrid `/comment` output

**Behavior delivered:** A general comment is loaded without the unchanged
assistant response; inline or otherwise modified reference content is retained
in full; an unchanged buffer produces an empty prompt and a visible notice.

**Entry point:** Run `/comment` in Pi's interactive TUI after a completed
assistant response, edit the generated buffer, save, and close the editor.

**Observable result:** Pi's prompt editor receives the classified text but does
not submit it.

**Call path exercised:**

```text
/comment handler
  -> current-branch response selection
  -> scaffold formatting
  -> external editor
  -> saved-buffer classification
  -> Pi prompt editor and notification
```

**Production changes:**

- Add `CommentEditorResult` and `prepareCommentEditorResult` to
  `extensions/comment-editor/index.ts`.
- Retain the generated initial scaffold through the editor invocation.
- Route the saved buffer through the classifier before `setEditorText`.
- Select the approved notification from the result kind.
- Update `README.md` with the smart-hybrid behavior and empty-comment outcome.

**Temporary behavior:** None.

**Automated tests:**

- Extract a general comment from an unchanged scaffold.
- Return empty for unchanged content with no substantive prefix.
- Preserve general-comment indentation and internal blank lines.
- Treat line-ending conversion alone as unchanged.
- Preserve the exact saved buffer for inline comments, modified quotes, and a
  modified heading.
- Run all existing tests and package checks.

**Hands-on validation:**

1. General comment: confirm only the comment appears in Pi.
2. Inline annotation: confirm the complete annotated buffer appears in Pi.
3. No comment: confirm Pi's prompt remains empty and the notice is visible.

**Dependencies:** None beyond the approved design.

**Compatibility and rollout:** No migration or feature flag. The changed output
applies only when the generated scaffold is unchanged. The lossless fallback
preserves prior behavior for every uncertain case. Reverting the slice restores
the prior always-complete-buffer behavior.

**Cross-repository coordination:** None.

**Review surface:** One extension module, its existing test module, README usage
documentation, and this design artifact.

**Completion point:** `npm run check` passes, all three hands-on flows match the
acceptance criteria, and the resulting diff receives human code review.

### Approved implementation batch

Batch 1 contains Slice 1 only. Splitting the classifier, command wiring, tests,
or documentation into separate slices would create horizontal intermediate
states without independently useful behavior.

The safe stopping point is after Slice 1 implementation and automated
validation, before human hands-on validation and code review.

## Slice batch reviews

### Slice 1 implementation review

**Implementation status:** Implemented and human-reviewed.

**Observable behavior available:**

- A general comment above the unchanged generated scaffold is loaded without
  the quoted assistant response.
- Saving the unchanged scaffold loads an empty prompt and reports
  `No comment entered`.
- Inline comments or any other scaffold mismatch load the complete saved buffer
  and visibly report the lossless fallback.
- `/comment` still only prepares Pi's prompt editor and never submits it.

**Files changed:**

- `extensions/comment-editor/index.ts`: adds the pure discriminated result
  classifier and wires all three outcomes into the command handler.
- `test/comment-editor.test.ts`: adds six classifier tests covering extraction,
  emptiness, formatting, line endings, inline comments, and edited scaffolds.
- `README.md`: documents smart-hybrid output and the no-comment outcome.
- `docs/v1-smart-hybrid-design.md`: records design approvals, implementation,
  validation, and review state.

**Actual call-path change:**

```text
external editor saved buffer
  -> prepareCommentEditorResult(savedText, initialText)
     -> empty | comment | annotated
  -> ui.setEditorText(result.text)
  -> outcome-specific notification
```

The response-selection, editor-launch, temporary-file, command-parsing, and Pi
submission boundaries were not changed.

**Automated validation:**

- Red test confirmed the new contract was absent before implementation:
  `bun test test/comment-editor.test.ts` failed because
  `prepareCommentEditorResult` was not exported.
- Narrow green test: `bun test test/comment-editor.test.ts` passed with 12 tests.
- Full validation: `git diff --check && npm run check` passed.
  - TypeScript type-check passed.
  - 12 tests passed with 0 failures.
  - `npm pack --dry-run` passed with the intended four package files.

**Hands-on validation completed in Pi's TUI:**

1. Run `/comment`, write only above the heading, save, and verify Pi contains
   only that comment.
2. Run `/comment`, add an unquoted inline annotation among quoted lines, save,
   and verify Pi contains the complete annotated buffer.
3. Run `/comment`, save without editing, and verify Pi remains empty and shows
   `No comment entered`.

The user confirmed all three flows and approved the code diff.

**Deviations from approved design:** None. The implementation explicitly treats
an impossible empty `initialText` as an annotated, lossless fallback rather than
risk dropping `savedText`; normal command execution always generates a non-empty
initial scaffold.

**Discoveries and remaining risks:** Editors that reformat scaffold whitespace
beyond line endings will intentionally trigger the complete-buffer fallback.
This preserves content but may still duplicate context.

**Temporary behavior:** None.

**Code-review focus:**

- Verify suffix comparison cannot discard content on uncertain input.
- Verify blank-boundary trimming preserves substantive indentation and spaces.
- Verify each result kind maps to the approved prompt text and notification.
- Verify current-branch, TUI-only, shell-free, and no-auto-submit behavior is
  untouched.

There is no next implementation batch in this feature.

## Traceability

| Requested behavior | Acceptance criteria | Architectural owner | Status |
| --- | --- | --- | --- |
| Avoid resending an unchanged response | 1, 4 | Saved-buffer classification | Implemented; extraction and empty tests pass; TUI validation approved |
| Preserve inline annotation context | 2 | Lossless complete-buffer fallback | Implemented; inline fallback test passes; TUI validation approved |
| Never silently discard uncertain content | 3 | Exact suffix comparison and annotated result | Implemented; malformed and modified scaffold tests pass |
| Never submit automatically | 5 | Existing Pi prompt-editor boundary | Unchanged in code; human review approved |
| Preserve existing safety and branch semantics | 6 | Existing command and response-selection boundaries | Full regression suite passes; human review approved |

## Decisions and rejected alternatives

- **Decided:** Use the smart-hybrid approach.
- Other alternatives and their rejection reasons are recorded under System
  architecture.

## Open questions and risks

- No open implementation or review questions remain for Slice 1.
- The lossless fallback can still duplicate context when an editor reformats the
  scaffold. This is intentional unless testing shows common editors trigger it
  without user edits.
