// cc_worker gateway side (docs/ccr-supply.md §8.1): stream-json line splitting
// and the line family -> SessionTranslator -> Messages wire translation.
// dist/ccr/worker.js pulls in tunnel.js -> config.js (no DB), but translate.js
// is pure; isolate DATA_DIR anyway for safety.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";

const dir = mkdtempSync(join(tmpdir(), "1dayapi-gw-worker-"));
process.env.DATA_DIR = dir;
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));

const { StreamJsonLines, parseStreamJsonLine } = await import("../dist/ccr/worker.js");
const { SessionTranslator } = await import("../dist/ccr/translate.js");

const LINES = [
  { type: "system", subtype: "init", model: "claude-sonnet-5-5" },
  { type: "stream_event", event: { type: "message_start", message: { id: "m1", usage: { input_tokens: 12, output_tokens: 1, cache_read_input_tokens: 3 } } } },
  { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
  { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello " } } },
  { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "worker." } } },
  { type: "stream_event", event: { type: "content_block_stop", index: 0 } },
  { type: "stream_event", event: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 7 } } },
  { type: "assistant", message: { id: "m1", role: "assistant", content: [{ type: "text", text: "Hello worker." }], usage: { input_tokens: 12, output_tokens: 7, cache_read_input_tokens: 3 } } },
  { type: "result", subtype: "success", is_error: false, result: "Hello worker.", modelUsage: { "claude-sonnet-5-5": { inputTokens: 12, outputTokens: 7, cacheReadInputTokens: 33725, cacheCreationInputTokens: 1200, costUSD: 0.0051 } } },
];

test("line splitting: chunk boundaries, blank lines, malformed JSON, trailing partial", () => {
  assert.equal(parseStreamJsonLine("not json"), null);
  assert.equal(parseStreamJsonLine("{}"), null, "no type -> dropped");
  const s = new StreamJsonLines();
  const wire = LINES.map((l) => JSON.stringify(l)).join("\n") + "\n";
  const mid = Math.floor(wire.length / 2);
  const a = s.push(wire.slice(0, mid));
  const b = s.push(wire.slice(mid));
  assert.equal(a.length + b.length, LINES.length);
  const s2 = new StreamJsonLines();
  assert.equal(s2.push('{"type":"system"}').length, 0, "no newline yet");
  assert.equal(s2.end()[0].type, "system", "trailing partial line at EOF");
  const s3 = new StreamJsonLines();
  assert.equal(s3.push('\n{"type":"bogus\n').length, 0);
  assert.equal(s3.end().length, 0);
});

test("worker line family -> SessionTranslator -> final Messages JSON", () => {
  const t = new SessionTranslator({ model: "claude-sonnet-5", simulateTools: false });
  const s = new StreamJsonLines();
  for (const l of LINES) for (const p of s.push(JSON.stringify(l) + "\n")) t.push(p);
  for (const p of s.end()) t.push(p);
  assert.ok(t.finished);
  assert.equal(t.error, null);
  const msg = t.message();
  assert.equal(msg.content[0].text, "Hello worker.");
  assert.equal(msg.model, "claude-sonnet-5");
  assert.deepEqual(msg.usage, { input_tokens: 12, output_tokens: 7, cache_read_input_tokens: 33725, cache_creation_input_tokens: 1200 }, "no baseline: upstream modelUsage cache passes through");
  assert.equal(t.upstreamUsage["claude-sonnet-5-5"].costUSD, 0.0051, "upstream meter (with costUSD) kept for the platform ledger");
  assert.equal(msg.stop_reason, "end_turn");
});

test("worker line family -> SSE stream text", () => {
  const t = new SessionTranslator({ model: "claude-sonnet-5", simulateTools: false });
  let sse = "";
  for (const l of LINES) sse += t.push(l);
  sse += t.end();
  assert.ok(sse.includes("event: message_start"));
  assert.ok(sse.includes('"text":"Hello "') && sse.includes('"text":"worker."'), "stream_event deltas forwarded");
  assert.ok(sse.includes("event: message_stop"));
  assert.ok(sse.includes('"output_tokens":7'));
});

test("worker error result without content -> translator error", () => {
  const t = new SessionTranslator({ model: "m", simulateTools: false });
  t.push({ type: "result", subtype: "error_during_execution", is_error: true, result: "boom" });
  assert.ok(t.finished);
  assert.equal(t.error, "boom");
});

test("identity cache baseline is subtracted once: read first, then creation, clamped at 0 (§7.1)", () => {
  const run = (cacheBaseline) => {
    const t = new SessionTranslator({ model: "claude-sonnet-5", simulateTools: false, cacheBaseline });
    for (const l of LINES) t.push(l);
    return t.message().usage;
  };
  // upstream: cache_read 33725 (identity prefix hit + client content), cache_creation 1200 (client content)
  assert.deepEqual(run(16600), { input_tokens: 12, output_tokens: 7, cache_read_input_tokens: 17125, cache_creation_input_tokens: 1200 }, "baseline fully covered by cache_read");
  assert.deepEqual(run(34000), { input_tokens: 12, output_tokens: 7, cache_read_input_tokens: 0, cache_creation_input_tokens: 925 }, "remainder of the baseline comes off cache_creation");
  // A baseline no cache field could absorb comes off plain input (an uncached Claude Code prefix is metered as input), never below 0.
  assert.deepEqual(run(100000), { input_tokens: 0, output_tokens: 7, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, "never negative");
  assert.deepEqual(run(0), { input_tokens: 12, output_tokens: 7, cache_read_input_tokens: 33725, cache_creation_input_tokens: 1200 });
});

test("planThinking: enabled → budget; adaptive → thinking wanted + default effort high; effort passthrough; none → off", async () => {
  const { planThinking } = await import("../dist/ccr/worker.js");
  assert.deepEqual(planThinking({}), { thinkingBudget: 0, thinkingWanted: false, effort: "" });
  assert.deepEqual(planThinking({ thinking: { type: "enabled", budget_tokens: 2000 } }), { thinkingBudget: 2000, thinkingWanted: true, effort: "" });
  assert.deepEqual(planThinking({ thinking: { type: "enabled", budget_tokens: 10 } }).thinkingBudget, 1024, "budget floor");
  // Claude 5 adaptive API: the switch in Claude Code is --effort; the API default level is used when the client gives none.
  assert.deepEqual(planThinking({ thinking: { type: "adaptive", display: "summarized" } }), { thinkingBudget: 0, thinkingWanted: true, effort: "high" });
  assert.deepEqual(planThinking({ thinking: { type: "adaptive" }, output_config: { effort: "xhigh" } }), { thinkingBudget: 0, thinkingWanted: true, effort: "xhigh" });
  assert.deepEqual(planThinking({ thinking: { type: "disabled" }, effort: "low" }), { thinkingBudget: 0, thinkingWanted: false, effort: "low" });
  assert.equal(planThinking({ thinking: { type: "enabled", budget_tokens: 2000 }, effort: "bogus" }).effort, "", "unknown effort levels are dropped");
});

test("ids are Anthropic-shaped: msg_/toolu_ + 24 base62 chars, no underscore or ccr marker (ztest D17, 2026-10-18)", async () => {
  const { anthropicId } = await import("../dist/ccr/translate.js");
  const t = new SessionTranslator({ model: "m", simulateTools: false });
  assert.match(t.messageId, /^msg_[A-Za-z0-9]{24}$/);
  assert.match(anthropicId("toolu"), /^toolu_[A-Za-z0-9]{24}$/);
  assert.notEqual(anthropicId("msg"), anthropicId("msg"), "fresh per call");
  assert.match(t.message().id, /^msg_[A-Za-z0-9]{24}$/, "final message carries the same id");
});
