// X-53 (2026-11-10): the TUI shim cannot paste document blocks (every PDF request on a TUI node was a 502) and often
// fails on images; such a turn must run as a plain `-p --input-format stream-json` process, also on a TUI node.
import assert from "node:assert/strict";
import fs from "node:fs";
import { needsPlainProcess } from "../dist/cc-worker.js";

assert.equal(needsPlainProcess(undefined), false);
assert.equal(needsPlainProcess([{ type: "text", text: "hi" }]), false);
assert.equal(needsPlainProcess([{ type: "text", text: "see" }, { type: "document", source: { type: "base64", media_type: "application/pdf", data: "JVBERi0=" } }]), true);
assert.equal(needsPlainProcess([{ type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0=" } }]), true);
assert.equal(needsPlainProcess([{ type: "tool_result", tool_use_id: "t", content: "x" }]), false);
assert.equal(needsPlainProcess("a string"), false);

// wiring: the spawn decision and the continue path both consult it, and the process remembers how it was started
const src = fs.readFileSync(new URL("../src/cc-worker.ts", import.meta.url), "utf8");
// X-60: one-shot opens (stdin is closed after the message) never go through the shim either
assert.match(src, /const tui = canonical && this\.tuiEnabled && persist && !needsPlainProcess\(firstContent\)/);
assert.match(src, /const mediaOnTui = !!proc && proc\.tui && needsPlainProcess\(msg\.content\)/);
assert.match(src, /hasTools: nativeTools\.length > 0, tui, credHash/);
console.log("media-plain: ALL PASSED");
