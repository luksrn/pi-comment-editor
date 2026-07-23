# Agent guide

This repository is the canonical source for `@ramtinj95/pi-comment-editor`.

- Keep `/comment` focused on preparing a user-editable response; it must never submit text automatically.
- Preserve current-branch semantics when reading session entries.
- External editors must run only in Pi's interactive TUI.
- Keep editor command parsing shell-free so environment configuration cannot introduce implicit shell evaluation.
- Run `npm run check` after changes; it type-checks, tests, and verifies the npm package contents.
