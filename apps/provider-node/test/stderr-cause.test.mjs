// stderrCause (cc-worker.ts): what a "claude exited N" message quotes from the shim's stderr —
// the cause line ("claude-tui: …") first, not only the tail of the screen (2026-11-10).
//   bun apps/provider-node/test/stderr-cause.test.mjs
import assert from "node:assert/strict";
import { stderrCause } from "../dist/cc-worker.js";

const screen = "─".repeat(60) + " ❯ [Pasted text #1 +58 lines]/var/lib/1dayapi-cc-worker-tui/cc-sessions/84152209882e23/oneday-cc-images-1/image-1.png";
const line = `claude-tui: Claude Code did not take the message: ${screen}\n`;
// The cause survives even when the screen tail is long.
const quoted = stderrCause(line);
assert.ok(quoted.startsWith("claude-tui: Claude Code did not take the message:"), quoted);
assert.ok(quoted.length <= 460, String(quoted.length));
// A long quote keeps both ends: the cause and the end of the screen.
const long = stderrCause(`claude-tui: Claude Code ended (exit status 1): ${"x".repeat(900)} END`);
assert.ok(long.startsWith("claude-tui: Claude Code ended (exit status 1)"), long);
assert.ok(long.endsWith("END"), long.slice(-20));
assert.ok(long.includes(" … "), long);
// Several shim lines: the last cause wins (a retry's reason), and whitespace is collapsed.
assert.equal(stderrCause("claude-tui: first\nclaude-tui: second   reason\n"), "claude-tui: second reason");
// No shim line (plain -p worker): the tail as before.
assert.equal(stderrCause("a".repeat(500) + "tail-end"), ("a".repeat(500) + "tail-end").slice(-460));
assert.equal(stderrCause(""), "");
console.log("stderr-cause.test: ok");
