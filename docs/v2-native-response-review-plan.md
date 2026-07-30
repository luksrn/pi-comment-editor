# V2 native response review plan

Status: **Implemented on `feat/native-response-review`; automated validation complete, manual Pi TUI acceptance pending**

## Executive recommendation

Replace the external-editor `/comment` experience with a native Pi response
reviewer built with `ctx.ui.custom()`. Reuse `tuicr`'s interaction concepts—modal
navigation, logical line-range selection, typed annotations, stable annotation
identity, and deterministic export—but do not depend on or embed `tuicr`.

Remove the existing external-editor workflow rather than carrying two parallel
interaction models. This is an intentional breaking V2 change. Native failures
remain explicit; there is no silent fallback.

The implementation should be split into:

1. A pure response-review model, state machine, layout model, and formatter.
2. A thin Pi TUI adapter that owns rendering, key decoding, and an embedded Pi
   `Editor` for annotation text.
3. The existing command handler as the effectful coordinator.

This separation is load-bearing. Most correctness should be established without
a live terminal; the custom component should not become the feature's source of
truth.

## Research basis

Four non-interactive explorer passes independently examined the current
extension, Pi's installed APIs and examples, `tuicr`, and release/testing risks.
Their findings converged on the following:

- `getLastAssistantText(ctx.sessionManager.getBranch())` already correctly
  preserves current-branch semantics and refuses to fall back past an incomplete
  latest response.
- `ctx.ui.custom()` is a supported Pi extension API. A custom component receives
  the TUI, theme, keybindings, and a `done(result)` callback.
- Pi provides a multiline `Editor`, key matching, terminal width utilities, and
  terminal dimensions. It does not provide a documented generic scroll-view;
  the response viewport must be component-owned.
- A component embedding `Editor` must propagate `focused` state for IME cursor
  positioning.
- Normal replacement UI is lower risk than overlay mode, which Pi documents as
  experimental.
- `tuicr`'s interaction state translates well, but its implementation is tightly
  coupled to VCS diffs, file/side anchors, persistence, Ratatui, and forge review
  submission.
- Pi package documentation says `@earendil-works/pi-tui` should be a `"*"` peer
  dependency rather than bundled.
- The current npm package ships only `extensions/comment-editor/index.ts`; new
  runtime files require an explicit package-files change.

Primary evidence:

- Current extension: `extensions/comment-editor/index.ts`
- Current tests: `test/comment-editor.test.ts`
- Pi component API: installed `docs/tui.md` and `docs/extensions.md`
- Pi embedded editor example: installed `examples/extensions/question.ts`
- Pi package dependency rules: installed `docs/packages.md`
- `tuicr` selection and comments: `/tmp/tuicr/src/app/visual.rs` and
  `/tmp/tuicr/src/app/comments.rs`
- `tuicr` export: `/tmp/tuicr/src/output/markdown.rs`

## Goals

1. Let the user review the latest completed assistant response without leaving
   Pi.
2. Support multiple overall or line-range annotations in one `/comment` session.
3. Classify annotations as comment, suggestion, or issue.
4. Return compact, exact, deterministic context to the agent.
5. Load the result into Pi's prompt editor for final human review.
6. Preserve current-branch, completed-response, TUI-only, and never-auto-submit
   invariants.
7. Keep terminal rendering, cancellation, Unicode, and packaging behavior
   explainable and testable.

## Non-goals for the first native release

- Arbitrary character-level selection.
- Mouse selection or mouse-driven editing.
- Rendering the response as interpreted Markdown.
- Persisting unfinished reviews across Pi restarts or `/reload`.
- Attaching annotations to assistant tool calls, thinking blocks, or images.
- Sending the resulting message automatically.
- Depending on the `tuicr` executable, CLI, storage, or Rust library.
- User-configurable annotation types or keybindings.
- Side-by-side panes or an experimental overlay.

These are deferred deliberately. Logical line ranges provide the `tuicr`-like
workflow without making wrapped terminal rows or Unicode grapheme positions part
of persisted review identity.

## Proposed product contract

### Command surface

#### `/comment`

Open the native response reviewer for the latest completed assistant response on
the current session branch.

#### Invalid arguments

`/comment` accepts no arguments in V2. Report a visible usage error rather than
guessing or silently switching modes.

### Response source

Continue to use `getLastAssistantText(ctx.sessionManager.getBranch())`.

- Only assistant text parts participate.
- The newest assistant entry must have `stopReason === "stop"`.
- An incomplete newest assistant response remains an error; `/comment` must not
  silently review an older response.
- Source text is immutable for the lifetime of the reviewer.

### Annotation targets

```ts
type AnnotationTarget =
  | { kind: "overall" }
  | { kind: "lines"; startLine: number; endLine: number };
```

Line indices are zero-based and inclusive internally. User-facing output is
one-based. `startLine <= endLine` is always normalized before storage.

Terminal wrapping never changes a target. A logical response line may occupy
several display rows, but all of those rows map back to the same source line.

### Annotation types

```ts
type AnnotationKind = "comment" | "suggestion" | "issue";
```

- **Comment**: question, observation, or ordinary feedback.
- **Suggestion**: a non-blocking proposed improvement.
- **Issue**: a problem the agent should address before proceeding.

The initial release uses these fixed meanings and colors. Configuration can be
considered after the interaction proves useful.

### Annotation identity and ordering

```ts
interface ResponseAnnotation {
  id: string;
  ordinal: number;
  target: AnnotationTarget;
  kind: AnnotationKind;
  body: string;
}
```

- IDs are stable across edits within the review session.
- Array indices are never used as persistent identity.
- Overlapping line ranges are allowed; different concerns can legitimately
  refer to the same passage.
- Output order is: overall annotations first, then line annotations by start
  line, end line, and creation ordinal.
- Blank annotation bodies cannot be saved.

### Recommended interaction

#### Browse mode

| Key | Action |
| --- | --- |
| `j` / `k`, arrows | Move by logical response line |
| `Ctrl-d` / `Ctrl-u`, PageDown/PageUp | Move by viewport page |
| `g` / `G` | First / last logical line |
| `v` | Start line-range selection at the cursor |
| `c` | Comment on current line or active range |
| `s` | Suggestion on current line or active range |
| `i` | Issue on current line or active range |
| `C` | Overall-response comment |
| `[` / `]` | Previous / next annotation |
| `e` | Edit an annotation at the cursor |
| `d` | Delete an annotation at the cursor |
| `y` | Finish and prepare the Pi prompt |
| `Esc` | Cancel selection, or leave the reviewer |

While visual selection is active, movement changes the selection head while the
anchor remains fixed. Pressing `c`, `s`, or `i` opens an annotation draft for the
normalized range.

#### Draft mode

- Use Pi's built-in multiline `Editor`; do not implement text editing manually.
- `Ctrl-s` saves a nonblank draft.
- `Esc` cancels the draft and returns to browse mode without changing existing
  annotations.
- The selected annotation kind remains visible while drafting.
- Editing an existing annotation is transactional: cancellation restores the
  previous body and kind.

#### Leaving the reviewer

- `y` with at least one annotation returns a completed result.
- `y` with no annotations reports `No comments entered` and leaves Pi's existing
  prompt untouched.
- `Esc` with no annotations cancels immediately.
- `Esc` with saved annotations enters a discard-confirmation mode so feedback
  cannot be lost accidentally.
- Cancellation never calls `ctx.ui.setEditorText()`.

### Display behavior

The response is displayed as read-only Markdown source with one-based line
numbers. It is not interpreted as Markdown because rendered headings, lists, and
code blocks would destroy the stable relationship between visible content and
logical source lines.

The component owns:

- logical cursor line;
- optional visual-selection anchor and head;
- wrapped display-row mapping;
- viewport offset;
- annotation markers and current annotation preview;
- current mode and draft metadata.

Long source lines wrap. Tabs receive a documented display expansion while the
original source remains unchanged for export. Control characters and embedded
ANSI escape sequences are neutralized for display so assistant text cannot alter
terminal state; export still uses the original source text.

The initial UI should use compact annotation markers in the line-number gutter
and show the focused annotation body in a bounded preview region. It should not
insert full annotation cards into the response flow in V2 because those cards
would make viewport and cursor accounting substantially harder.

### Output contract

The formatter produces one editable user message. It includes exact quoted
source text rather than repeating the complete assistant response.

```markdown
I reviewed your previous response. Please address these annotations.

1. **[ISSUE]** Response lines 8-11

   > Exact selected response text
   > continues here.

   This conclusion does not follow from the evidence above.

2. **[SUGGESTION]** Response line 19

   > Another selected passage.

   Replace this with a concrete example.
```

Overall annotations omit a quote and use `Overall response`. Every source line is
Markdown-quoted independently, including blank lines. Annotation bodies retain
their internal formatting. Output is deterministic and covered by golden tests.

On completion the command calls only:

```ts
ctx.ui.setEditorText(formattedReview);
```

It never calls `pi.sendUserMessage()`.

## Architecture

### Runtime modules

Keep the module count small:

```text
extensions/comment-editor/
  index.ts                       command orchestration
  response-review.ts             pure document, state, layout, and formatting
  response-review-component.ts   Pi Component/Focusable adapter and rendering
```

#### `index.ts`

Retains ownership of effects:

1. Parse command arguments.
2. Reject non-TUI mode.
3. Read the current branch and latest completed response.
4. Await the native component result.
5. Format successful results.
6. Call `setEditorText()` exactly once on success.
7. Notify on success, cancellation, no-op, or error.

Delete `formatCommentEditorText`, `prepareCommentEditorResult`,
`parseEditorCommand`, `editWithExternalEditor`, and their obsolete tests once
the native vertical path is accepted. Do not leave dead compatibility code in
the package.

#### `response-review.ts`

Contains no Pi objects and no terminal side effects. It owns:

- response document construction and logical lines;
- annotation and mode types;
- pure state transitions and invariants;
- line-range normalization;
- viewport/layout view models;
- display sanitization inputs;
- deterministic output formatting.

The reducer accepts semantic actions, not raw key sequences:

```ts
type ReviewAction =
  | { type: "move"; delta: number }
  | { type: "page"; delta: number }
  | { type: "select" }
  | { type: "beginDraft"; kind: AnnotationKind; target: AnnotationTarget }
  | { type: "saveDraft"; body: string }
  | { type: "cancelDraft" }
  | { type: "edit"; id: string }
  | { type: "delete"; id: string }
  | { type: "cancel" }
  | { type: "confirmDiscard" };
```

Exact action names can change during implementation; the boundary cannot.

#### `response-review-component.ts`

Implements Pi's `Component` and `Focusable` contracts. It owns only:

- decoding terminal input with `Key` and `matchesKey()`;
- delegating draft input to Pi's `Editor`;
- propagating focus to that editor for IME support;
- rendering themed view-model rows within the supplied width;
- deriving usable body height from `tui.terminal.rows`;
- invalidating caches and calling `tui.requestRender()`;
- invoking `done(result)` once.

Use a normal `ctx.ui.custom()` replacement component. Do not use overlay mode.

### State boundaries

The component must keep three coordinate systems explicit:

1. **Source line**: immutable annotation identity.
2. **Wrapped display row**: derived from source, width, and presentation.
3. **Terminal screen row**: derived from viewport position.

No code may infer an annotation target from a wrapped or terminal row without
going through the view-model mapping.

### Dependency and package changes

Following Pi package guidance:

- Add `@earendil-works/pi-tui: "*"` to `peerDependencies`.
- Add a matching pinned development dependency so local typechecks and tests do
  not rely on transitive installation layout.
- Keep `@earendil-works/pi-coding-agent: "*"` as the runtime peer.
- Change npm `files` from one entry file to the
  `extensions/comment-editor/` directory so all runtime modules ship.
- Continue to exclude tests, fixtures, design documents, and `.lavish/` files.

The package should document the Pi version used for release validation even
though Pi's package convention uses `"*"` for bundled core peers.

## Test strategy

### Pure model tests

Cover:

- forward and backward selection normalization;
- cursor and range clamping;
- page movement and viewport margins;
- stable annotation IDs across edits;
- blank-draft rejection;
- overlapping ranges;
- deterministic ordering;
- nested cancellation semantics;
- deletion and annotation navigation;
- zero-line and one-line defensive behavior.

Use table-driven transitions. Add randomized action-sequence tests if the reducer
remains simple enough to assert invariants after every action.

### Layout and rendering tests

Cover:

- every rendered line has `visibleWidth(line) <= width`;
- logical-to-wrapped-row mapping;
- cursor visibility after navigation and resize;
- very narrow and very short terminals;
- empty lines and long unbroken content;
- tabs;
- CJK full-width characters;
- combining marks;
- emoji variation selectors and ZWJ sequences;
- right-to-left text width safety;
- literal and real ANSI/control sequences;
- repeated resize sequences without state changes.

Rendering tests should use a fake TUI surface only for terminal dimensions and
`requestRender()`. There is no official installed custom-component test harness,
so the pure view model remains the primary correctness seam.

### Formatter golden tests

Cover:

- overall, single-line, and multi-line targets;
- multiple and overlapping annotations;
- Markdown headings, blockquotes, backticks, and fenced code in source text;
- blank selected lines;
- multiline annotation bodies;
- exact whitespace and Unicode preservation;
- stable numbering and final newline behavior.

### Command integration tests

Register the extension against fake Pi APIs and assert:

- non-TUI rejection;
- current-branch lookup;
- missing or incomplete latest response;
- native success calls `setEditorText()` exactly once;
- native cancellation never mutates the editor;
- no-annotation completion never mutates the editor;
- component or formatter failure notifies and preserves the editor;
- no path calls `sendUserMessage()`.

### Package tests

Extend the current package check to verify:

- all three runtime modules are present in `npm pack --dry-run`;
- tests, fixtures, `.lavish/`, and design docs are absent;
- the packed tarball can be installed and its extension entry imported in a
  temporary project;
- runtime imports resolve from declared peers rather than accidental transitive
  layout.

### Manual Pi acceptance pass

Before release, test from the packed artifact:

1. Current-branch response selection after using Pi's session tree.
2. Forward and backward range selection across wrapped lines.
3. Overall, comment, suggestion, and issue annotations.
4. Multiple annotations; navigate, edit, and delete them.
5. Draft cancellation and review discard confirmation.
6. Successful completion loads text without submitting it.
7. Existing prompt remains unchanged on every cancellation/error path.
8. Repeated terminal resizing, including narrow and short dimensions.
9. CJK, combining characters, ZWJ emoji, RTL, tabs, long URLs, and Markdown
   fences.
10. IME composition and candidate-window positioning.
11. `/reload` or session shutdown while the reviewer is open; terminal state
    remains healthy.

Run `npm run check` after every implementation slice.

## Implementation slices

Each slice must leave the repository in a testable state. Do not build the entire
component before establishing the model and output contracts.

### Slice 1: contracts and pure model

- Add response-review types and document construction.
- Add state transitions for navigation, selection, draft lifecycle, stable IDs,
  edit/delete, and cancellation.
- Add deterministic formatter and golden tests.
- No command behavior changes.

Success signal: all product semantics can be reviewed through tests without a
terminal.

### Slice 2: native single-annotation vertical path

- Add the normal custom component.
- Render line-numbered raw source with width-safe wrapping.
- Navigate, select a range, add one typed annotation with Pi's `Editor`, and
  finish.
- Add command orchestration behind an explicit temporary development argument
  if needed; do not change `/comment` default until the vertical path is manually
  validated.

Success signal: one annotation reaches Pi's prompt editor and is never submitted.

### Slice 3: complete review lifecycle

- Add multiple annotations, overall comments, markers, annotation preview,
  previous/next navigation, edit, delete, and discard confirmation.
- Harden resize, Unicode, display sanitization, focus, and cache invalidation.
- Add command-level tests.

Success signal: the native workflow fully covers the proposed V2 contract.

### Slice 4: breaking migration and release hardening

- Make native review the `/comment` default.
- Remove the external-editor implementation and obsolete tests.
- Update README usage and V2 breaking-change notes.
- Update peer/dev dependencies and npm package contents.
- Add packed-install smoke coverage.
- Run the complete manual acceptance pass and `npm run check`.

Success signal: native review works from the packed artifact, with the removal of
the external-editor workflow documented explicitly.

## Failure behavior

| Failure or exit | Required behavior |
| --- | --- |
| Non-TUI invocation | Error notification; no editor mutation |
| No completed response | Error notification; no editor mutation |
| Latest response incomplete | Error notification; do not fall back |
| Blank draft save | Stay in draft mode with visible validation |
| Cancel draft | Return to browse; preserve prior annotations |
| Cancel review with annotations | Require discard confirmation |
| Finish with no annotations | Informational notification; no editor mutation |
| Component or formatter throws | Error notification; no editor mutation |
| Terminal too small | Render bounded fallback/help; retain model state |
| Duplicate completion callback | Ignore after first completion |

## Main risks and mitigations

### Logical lines accidentally coupled to wrapped rows

Mitigation: explicit source/display/screen coordinate types and pure mapping
tests. This is the highest correctness risk.

### Unicode or ANSI corrupts cursor/layout behavior

Mitigation: use Pi width utilities, Pi's `Editor`, display sanitization, and a
dedicated adversarial fixture set. Never slice user-authored text by JavaScript
code unit for editing.

### Cancellation destroys existing Pi prompt text

Mitigation: only call `setEditorText()` after successful completion with at least
one annotation. Make this a command-integration assertion.

### Embedded editor loses focus or IME positioning

Mitigation: implement `Focusable`, propagate `focused`, and manually validate IME
behavior. Do not stack overlays.

### Component becomes difficult to test

Mitigation: keep state and layout pure; the component only adapts raw keys,
themes, terminal dimensions, and the child editor.

### Package works from the repository but not after installation

Mitigation: declare the Pi TUI peer, ship the full runtime directory, and install
the generated tarball in a smoke test.

### Removing the current workflow surprises existing users

Mitigation: release as V2, call out the breaking change prominently, and document
the native replacement. Do not preserve the old implementation under another
command after product review explicitly chose one interaction model.

## Approved alignment decisions

Product review accepted these constraints:

1. **Native only:** `/comment` becomes native and the external-editor workflow is
   removed.
2. **Selection granularity:** logical line ranges only in V2.
3. **Targets:** support overall-response and line-range annotations.
4. **Types:** fixed comment, suggestion, and issue types.
5. **Display:** raw Markdown source with stable line numbers, not rendered
   Markdown.
6. **Output:** exact selected quotes plus annotation text; do not repeat the full
   response.
7. **Overlap:** allow overlapping annotations and order deterministically.
8. **Persistence:** review state exists only while the custom UI is open.
9. **Submission:** finish loads Pi's prompt editor and never submits.
10. **Integration:** no `tuicr` runtime dependency and no experimental Pi overlay.

Any later change to these decisions can materially alter the model, UI, tests, or
migration path and should trigger a plan revision before implementation continues.
