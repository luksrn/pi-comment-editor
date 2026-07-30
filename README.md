# pi-comment-editor

A [Pi](https://github.com/earendil-works/pi-mono) extension for reviewing the latest assistant response, attaching typed annotations to logical line ranges, and preparing the result as an editable user message.

## Install

```bash
pi install npm:@ramtinj95/pi-comment-editor
```

Then run `/reload` or restart Pi. Pi packages execute with full system access; review this extension before installation.

## Usage

After Pi produces a response, run:

```text
/comment
```

The native reviewer shows the latest completed assistant response on the current session branch as raw Markdown source with stable line numbers. Select logical lines, add comments, suggestions, or issues, and finish the review to load a structured message into Pi's prompt editor.

The command never submits the message. Review or continue editing it in Pi, then send it normally.

### Browse controls

| Key | Action |
| --- | --- |
| `j` / `k`, arrows | Move by logical response line |
| `Ctrl-d` / `Ctrl-u`, PageDown/PageUp | Move by a viewport page |
| `g` / `G` | First / last line |
| `v` | Start or cancel a line-range selection |
| `c` | Comment on the current line or selection |
| `s` | Suggestion on the current line or selection |
| `i` | Issue on the current line or selection |
| `C` | Comment on the overall response |
| `[` / `]` | Previous / next saved annotation |
| `e` | Edit the focused annotation |
| `d` | Delete the focused annotation |
| `y` | Finish and prepare the Pi prompt |
| `Esc` | Cancel selection or leave the reviewer |

In an annotation draft, use Pi's multiline editor. `Ctrl-s` saves and `Esc` cancels the draft. Leaving a review with saved annotations requires discard confirmation.

### Prepared message

The generated prompt contains exact quotes from the selected response lines rather than repeating the complete response:

```markdown
I reviewed your previous response. Please address these annotations.

1. **[ISSUE]** Response lines 8-11

   > Exact selected response text
   > continues here.

   This conclusion does not follow from the evidence above.
```

`/comment` is available only in Pi's interactive TUI and accepts no arguments. Cancelling, finishing without annotations, or encountering an error leaves the existing Pi prompt unchanged.

## Version 2 breaking change

Version 2 replaces the external `$VISUAL` / `$EDITOR` workflow with the native response reviewer. External-editor configuration and free-form edits to a quoted copy of the full response are no longer supported.

The current release was developed and validated against Pi `0.81.1`.

## Development

```bash
npm install
npm run check
```
