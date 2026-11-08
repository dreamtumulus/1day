# magpie-claudetui → cc-tui-shim

`internal/claudetui/` is **magpie's** (yetone/magpie, MIT) interactive-Claude-Code driver, vendored verbatim and re-synced
with `./sync.sh <magpie checkout>`. It is what `cc-tui-shim` is: the provider node runs `cc-tui-shim <claude> <-p argv>`
in place of `claude` for TUI canonical opens (docs/tui-worker-2026-11-08.md).

- `rename.sed`: mechanical identifier renames (env names, temp-dir prefixes, MCP server name `mcp__caller`); no behaviour.
- `patches/`: the only behaviour we add on top of upstream (unified diffs, applied with `patch -p1`).
- `internal/{proc,appdir,wslrun}`: stubs for the three upstream internals the package touches (Linux only; no WSL/Windows).
- `UPSTREAM`: the upstream commit the tree was synced to. `LICENSE.magpie`: upstream's MIT text, kept as the licence requires.
- `dist/cc-tui-shim`: the built static binary (not committed); the console serves it to nodes.

Never edit `internal/claudetui/` by hand: change `rename.sed` or add a patch, then re-run `sync.sh`.
