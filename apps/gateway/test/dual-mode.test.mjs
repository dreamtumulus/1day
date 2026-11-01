// Dual-mode routing (docs/ccr-supply.md §5.2): modeFor's ccClient branch and
// the Claude Code UA detector — pure, against dist/. dist/upstream.js pulls in
// @1dayapi/core (opens the DB on import) — isolate DATA_DIR first.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";

const dir = mkdtempSync(join(tmpdir(), "1dayapi-gw-dualmode-"));
process.env.DATA_DIR = dir;
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));

const { isClaudeCodeUa } = await import("@1dayapi/core");
const { modeFor, isCcrMode, wireModeFor } = await import("../dist/upstream.js");

const ccrAcc = { protocol: "anthropic", type: "oauth", platform: "anthropic", executor: "ccr" };
const workerAcc = { protocol: "anthropic", type: "oauth", platform: "anthropic", executor: "ccr_worker" };
const directAcc = { protocol: "anthropic", type: "oauth", platform: "anthropic", executor: "direct" };
const keyAcc = { protocol: "anthropic", type: "apikey", platform: "anthropic", executor: "direct" };

test("Claude Code UA detection (same rule as the fingerprint layer)", () => {
  assert.ok(isClaudeCodeUa("claude-cli/2.1.300 (external, cli)"));
  assert.ok(isClaudeCodeUa("claude-code/2.1.300"));
  assert.ok(!isClaudeCodeUa("curl/8.5.0"));
  assert.ok(!isClaudeCodeUa("x-claude-cli/2.1.300"), "must anchor at the start");
  assert.ok(!isClaudeCodeUa(undefined));
  assert.ok(!isClaudeCodeUa(""));
});

test("R1: CC client + executor=ccr account -> direct mode, never a ccr mode", () => {
  assert.equal(modeFor("anthropic", ccrAcc, true), "passthrough-anthropic");
  assert.equal(modeFor("openai-chat", ccrAcc, true), "chat-via-anthropic");
  assert.equal(modeFor("responses", ccrAcc, true), "responses-via-anthropic", "Responses API first tier (spec WP4.3): mapped to Messages on the direct path");
  assert.ok(!isCcrMode(modeFor("anthropic", ccrAcc, true)));
});

test("R2: non-CC client + executor=ccr -> cloud session (unchanged)", () => {
  assert.equal(modeFor("anthropic", ccrAcc), "ccr-anthropic");
  assert.equal(modeFor("openai-chat", ccrAcc), "ccr-chat");
  assert.equal(modeFor("responses", ccrAcc), "ccr-responses", "Responses API first tier: worker path");
  assert.ok(isCcrMode(modeFor("anthropic", ccrAcc, false)));
});

test("R3: executor=direct ignores the ccClient flag entirely", () => {
  for (const acc of [directAcc, keyAcc]) {
    for (const cc of [true, false]) {
      assert.equal(modeFor("anthropic", acc, cc), "passthrough-anthropic");
      assert.equal(modeFor("openai-chat", acc, cc), "chat-via-anthropic");
    }
  }
});

test("wireModeFor of the dual-mode direct mode is itself (no ccr mapping)", () => {
  assert.equal(wireModeFor(modeFor("anthropic", ccrAcc, true)), "passthrough-anthropic");
  assert.equal(wireModeFor(modeFor("anthropic", ccrAcc, false)), "passthrough-anthropic", "ccr mode still maps to anthropic wire");
});

test("executor=ccr_worker follows the same dual-mode rule (§5.2 R1 + §8.1)", () => {
  // Non-CC client: worker mode serves the ccr wire modes (dispatch to the
  // on-node worker happens on executor in proxy.ts, not on Mode).
  assert.equal(modeFor("anthropic", workerAcc), "ccr-anthropic");
  assert.equal(modeFor("openai-chat", workerAcc), "ccr-chat");
  assert.equal(modeFor("responses", workerAcc), "ccr-responses");
  // CC client: direct mode, never the worker.
  assert.equal(modeFor("anthropic", workerAcc, true), "passthrough-anthropic");
  assert.equal(modeFor("openai-chat", workerAcc, true), "chat-via-anthropic");
  assert.ok(!isCcrMode(modeFor("anthropic", workerAcc, true)));
});
