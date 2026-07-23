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
2. Formats every line as a Markdown quote.
3. Opens the quoted response in `$VISUAL`, falling back to `$EDITOR`.
4. Replaces Pi's prompt editor contents with the saved text.

The command does not submit the comment. Review or continue editing it in Pi, then send it normally.

`/comment` is available only in Pi's interactive TUI. The editor command may contain arguments and quoted paths, but shell operators and expansions are not evaluated.

## Development

```bash
npm install
npm run check
```
