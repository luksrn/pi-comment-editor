# pi-comment-editor

A [Pi](https://github.com/earendil-works/pi-mono) extension for composing comments on assistant responses in your external editor.

## Install

```bash
pi install npm:@ramtinj95/pi-comment-editor
```

Then run `/reload` or restart Pi. Pi packages execute with full system access; review this extension before installation.

## Usage

Configure an editor that waits until you close the file:

```bash
export VISUAL="code --wait"
# or
export EDITOR="nvim"
```

After Pi produces a response, run:

```text
/comment
```

The command:

1. Takes the latest completed assistant response on the current session branch.
2. Opens with an empty comment area followed by the assistant response under a clear Markdown heading.
3. Opens the quoted response in `$VISUAL`, falling back to `$EDITOR`.
4. Loads only your comment when the quoted response is unchanged.
5. Loads the complete saved text when you add inline comments or otherwise change the reference section.

The editor buffer starts in this form, with the cursor in the empty comment area:

```markdown


## Previous assistant response

> The assistant response appears here.
```

Write your response above the heading to avoid repeating the unchanged assistant response in the next prompt. You can instead add unquoted inline comments between quoted sections; Pi will retain the complete annotated response so those comments keep their context.

If you save without entering a comment, Pi's prompt editor remains empty.

The command does not submit the comment. Review or continue editing it in Pi, then send it normally.

`/comment` is available only in Pi's interactive TUI. The editor command may contain arguments and quoted paths, but shell operators and expansions are not evaluated.

## Development

```bash
npm install
npm run check
```
