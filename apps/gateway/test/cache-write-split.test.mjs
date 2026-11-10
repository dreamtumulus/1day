// Official cache-billing parity (X-51): cache creation is carried, reported and billed per TTL tier
// (5-minute / 1-hour) on both lanes. Pure tests against dist/ — no upstream, no network.
import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionTranslator, addTranslatedUsage, cacheCreationSplit } from "../dist/ccr/translate.js";
import { UsageAccumulator, splitCacheCreation } from "../dist/usage.js";
import { anthropicMessageToOpenai, openaiChatToAnthropicMessage } from "../dist/convert.js";
import { responsesUsageFromAnthropic } from "../dist/adapters/responses.js";

const parseSse = (s) => s.split("\n\n").filter(Boolean).map((chunk) => JSON.parse(chunk.split("\n").find((l) => l.startsWith("data:")).slice(5)));
const split = (m5, h1) => ({ ephemeral_5m_input_tokens: m5, ephemeral_1h_input_tokens: h1 });
/** A worker `result` line whose snake-case usage carries the official nested split. */
const result = (usage) => ({ type: "result", subtype: "success", result: "ok", usage });
const translator = (opts = {}) => new SessionTranslator({ model: "m", simulateTools: false, ...opts });

// ---------- direct lane: UsageAccumulator ----------

test("direct lane, non-stream body: the nested cache_creation split is captured next to the total", () => {
  const acc = new UsageAccumulator();
  acc.addAnthropic({ input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 400, cache_creation_input_tokens: 1500, cache_creation: split(1000, 500) });
  assert.deepEqual(acc.finalize({}), {
    usage: { input_tokens: 10, output_tokens: 5, cache_read_tokens: 400, cache_write_tokens: 1500, cache_write_5m_tokens: 1000, cache_write_1h_tokens: 500 },
    estimated: false,
  });
});

test("direct lane: an upstream that reports only the total is attributed to the 5-minute tier", () => {
  const acc = new UsageAccumulator();
  acc.addAnthropic({ input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 1200 });
  const { usage } = acc.finalize({});
  assert.equal(usage.cache_write_tokens, 1200);
  assert.equal(usage.cache_write_5m_tokens, 1200);
  assert.equal(usage.cache_write_1h_tokens, 0);
});

test("direct lane, SSE: message_start carries the split, message_delta repeats only the totals — the split survives", () => {
  const acc = new UsageAccumulator();
  acc.addAnthropic({ input_tokens: 3, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 800, cache_creation: split(0, 800) });
  acc.addAnthropic({ input_tokens: 3, output_tokens: 42, cache_read_input_tokens: 0, cache_creation_input_tokens: 800 });
  const { usage, estimated } = acc.finalize({});
  assert.equal(estimated, false);
  assert.deepEqual([usage.output_tokens, usage.cache_write_tokens, usage.cache_write_5m_tokens, usage.cache_write_1h_tokens], [42, 800, 0, 800]);
  // message_delta with only output_tokens (older wire): everything from message_start stands
  const acc2 = new UsageAccumulator();
  acc2.addAnthropic({ input_tokens: 3, output_tokens: 1, cache_creation_input_tokens: 700, cache_creation: split(600, 100) });
  acc2.addAnthropic({ output_tokens: 9 });
  const u2 = acc2.finalize({}).usage;
  assert.deepEqual([u2.cache_write_tokens, u2.cache_write_5m_tokens, u2.cache_write_1h_tokens], [700, 600, 100]);
});

test("direct lane: the buckets always add up to the total (short split → rest is 5-minute; long split → cut, 1-hour kept first; nested only → sum)", () => {
  assert.deepEqual(splitCacheCreation(1000, 100, 300), { total: 1000, m5: 700, h1: 300 });
  assert.deepEqual(splitCacheCreation(500, 400, 300), { total: 500, m5: 200, h1: 300 });
  assert.deepEqual(splitCacheCreation(200, 400, 300), { total: 200, m5: 0, h1: 200 });
  assert.deepEqual(splitCacheCreation(undefined, 40, 60), { total: 100, m5: 40, h1: 60 });
  assert.deepEqual(splitCacheCreation(0, undefined, undefined), { total: 0, m5: 0, h1: 0 });
  const acc = new UsageAccumulator();
  acc.addAnthropic({ input_tokens: 1, output_tokens: 1, cache_creation: split(40, 60) });
  const { usage } = acc.finalize({});
  assert.deepEqual([usage.cache_write_tokens, usage.cache_write_5m_tokens, usage.cache_write_1h_tokens], [100, 40, 60]);
});

test("direct lane: a malformed split invalidates the usage (estimated, no cache billed) like any other bad count", () => {
  const acc = new UsageAccumulator();
  acc.addAnthropic({ input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 100, cache_creation: { ephemeral_5m_input_tokens: -1, ephemeral_1h_input_tokens: 0 } });
  const { usage, estimated } = acc.finalize({ messages: [] });
  assert.equal(estimated, true);
  assert.deepEqual([usage.cache_write_tokens, usage.cache_write_5m_tokens, usage.cache_write_1h_tokens], [0, 0, 0]);
});

test("partial stream settlement keeps the split seen at message_start and only raises the output count", () => {
  const acc = new UsageAccumulator();
  acc.addAnthropic({ input_tokens: 3, output_tokens: 1, cache_creation_input_tokens: 900, cache_creation: split(900, 0) });
  acc.addText("x".repeat(400));
  const { usage, estimated } = acc.finalize({}, { partial: true });
  assert.equal(estimated, true);
  assert.deepEqual([usage.output_tokens, usage.cache_write_tokens, usage.cache_write_5m_tokens, usage.cache_write_1h_tokens], [100, 900, 900, 0]);
});

test("OpenAI-wire upstream usage has no cache writes: all three counts are 0", () => {
  const acc = new UsageAccumulator();
  acc.addOpenaiChat({ prompt_tokens: 100, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 60 } });
  assert.deepEqual(acc.finalize({}).usage, { input_tokens: 40, output_tokens: 7, cache_read_tokens: 60, cache_write_tokens: 0, cache_write_5m_tokens: 0, cache_write_1h_tokens: 0 });
});

// ---------- worker lane: SessionTranslator ----------

test("cacheCreationSplit: nested split is used; total only → 5-minute; inconsistent split is forced to the total", () => {
  assert.deepEqual(cacheCreationSplit({ cache_creation_input_tokens: 900, cache_creation: split(100, 800) }), split(100, 800));
  assert.deepEqual(cacheCreationSplit({ cache_creation_input_tokens: 900 }), split(900, 0));
  assert.deepEqual(cacheCreationSplit({ cache_creation_input_tokens: 900, cache_creation: split(0, 500) }), split(400, 500));
  assert.deepEqual(cacheCreationSplit({ cache_creation_input_tokens: 300, cache_creation: split(200, 500) }), split(0, 300));
  assert.deepEqual(cacheCreationSplit({ cache_creation: split(20, 30) }), split(20, 30));
  assert.deepEqual(cacheCreationSplit(undefined), split(0, 0));
});

test("worker lane default (cacheWriteAsInput off): cache creation beyond the baseline is reported as cache creation with its split", () => {
  const t = translator({ cacheBaseline: 16600 });
  t.push(result({ input_tokens: 12, output_tokens: 7, cache_read_input_tokens: 33725, cache_creation_input_tokens: 1200, cache_creation: split(200, 1000) }));
  assert.deepEqual(t.usageOut(), { input_tokens: 12, output_tokens: 7, cache_read_input_tokens: 17125, cache_creation_input_tokens: 1200, cache_creation: split(200, 1000) });
  assert.deepEqual(t.message().usage, t.usageOut(), "non-stream body carries the same object");
});

test("worker lane: result.modelUsage (camelCase, no split) → the whole cache creation counts as 5-minute", () => {
  const t = translator({ cacheBaseline: 16600 });
  t.push({ type: "result", subtype: "success", result: "ok", modelUsage: { m: { inputTokens: 12, outputTokens: 7, cacheReadInputTokens: 33725, cacheCreationInputTokens: 1200 } } });
  assert.deepEqual(t.usageOut(), { input_tokens: 12, output_tokens: 7, cache_read_input_tokens: 17125, cache_creation_input_tokens: 1200, cache_creation: split(1200, 0) });
});

test("identity baseline: read first, then the 1-hour bucket, then the 5-minute bucket, then plain input", () => {
  const run = (cacheBaseline, usage) => {
    const t = translator({ cacheBaseline });
    t.push(result(usage));
    return t.usageOut();
  };
  const u = { input_tokens: 50, output_tokens: 7, cache_read_input_tokens: 1000, cache_creation_input_tokens: 5000, cache_creation: split(2000, 3000) };
  assert.deepEqual(run(600, u), { input_tokens: 50, output_tokens: 7, cache_read_input_tokens: 400, cache_creation_input_tokens: 5000, cache_creation: split(2000, 3000) }, "covered by cache read");
  assert.deepEqual(run(2500, u), { input_tokens: 50, output_tokens: 7, cache_read_input_tokens: 0, cache_creation_input_tokens: 3500, cache_creation: split(2000, 1500) }, "remainder off the 1-hour bucket");
  assert.deepEqual(run(4000, u), { input_tokens: 50, output_tokens: 7, cache_read_input_tokens: 0, cache_creation_input_tokens: 2000, cache_creation: split(2000, 0) }, "1-hour bucket exactly consumed");
  assert.deepEqual(run(5500, u), { input_tokens: 50, output_tokens: 7, cache_read_input_tokens: 0, cache_creation_input_tokens: 500, cache_creation: split(500, 0) }, "then the 5-minute bucket");
  assert.deepEqual(run(6020, u), { input_tokens: 30, output_tokens: 7, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, cache_creation: split(0, 0) }, "then plain input");
  assert.deepEqual(run(999999, u), { input_tokens: 0, output_tokens: 7, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, cache_creation: split(0, 0) }, "never negative");
});

test("escape hatch cacheWriteAsInput: creation beyond the baseline (both buckets) is folded into input, cache creation reported as 0", () => {
  const usage = { input_tokens: 2, output_tokens: 10, cache_read_input_tokens: 900, cache_creation_input_tokens: 5000, cache_creation: split(1000, 4000) };
  const on = translator({ cacheBaseline: 700, cacheWriteAsInput: true });
  on.push(result(usage));
  assert.deepEqual(on.usageOut(), { input_tokens: 5002, output_tokens: 10, cache_read_input_tokens: 200, cache_creation_input_tokens: 0, cache_creation: split(0, 0) });
  const off = translator({ cacheBaseline: 700, cacheWriteAsInput: false });
  off.push(result(usage));
  assert.deepEqual(off.usageOut(), { input_tokens: 2, output_tokens: 10, cache_read_input_tokens: 200, cache_creation_input_tokens: 5000, cache_creation: split(1000, 4000) });
  // input + cache creation is the same number of prompt tokens either way: only the label (and the price) differs
  const sum = (u) => u.input_tokens + u.cache_creation_input_tokens + u.cache_read_input_tokens;
  assert.equal(sum(on.usageOut()), sum(off.usageOut()));
  // the option defaults to off: official presentation
  const dflt = translator({ cacheBaseline: 700 });
  dflt.push(result(usage));
  assert.deepEqual(dflt.usageOut(), off.usageOut());
});

test("worker SSE: message_start and message_delta both carry cache_creation_input_tokens and the nested split", () => {
  const t = translator({ cacheBaseline: 100 });
  const se = (event) => ({ type: "stream_event", event });
  let out = "";
  out += t.push(se({ type: "message_start", message: { id: "m1", usage: { input_tokens: 5, output_tokens: 1, cache_read_input_tokens: 300, cache_creation_input_tokens: 900, cache_creation: split(100, 800) } } }));
  out += t.push(se({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }));
  out += t.push(se({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } }));
  out += t.push(se({ type: "content_block_stop", index: 0 }));
  out += t.push(se({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 9 } }));
  out += t.push({ type: "assistant", message: { id: "m1", content: [{ type: "text", text: "hi" }] } });
  out += t.push(result({ input_tokens: 5, output_tokens: 9, cache_read_input_tokens: 300, cache_creation_input_tokens: 900, cache_creation: split(100, 800) }));
  out += t.end();
  const evs = parseSse(out);
  const start = evs.find((e) => e.type === "message_start").message.usage;
  const delta = evs.find((e) => e.type === "message_delta").usage;
  assert.deepEqual(start, { input_tokens: 5, output_tokens: 0, cache_read_input_tokens: 200, cache_creation_input_tokens: 900, cache_creation: split(100, 800) });
  assert.deepEqual(delta, { output_tokens: 9, input_tokens: 5, cache_read_input_tokens: 200, cache_creation_input_tokens: 900, cache_creation: split(100, 800) });
  // What the gateway bills is what it parses back from this wire (proxy → UsageAccumulator).
  const acc = new UsageAccumulator();
  acc.addAnthropic(start);
  acc.addAnthropic(delta);
  assert.deepEqual(acc.finalize({}).usage, { input_tokens: 5, output_tokens: 9, cache_read_tokens: 200, cache_write_tokens: 900, cache_write_5m_tokens: 100, cache_write_1h_tokens: 800 });
});

test("worker SSE: when only the final result knows the split, message_delta is the authority the accumulator ends with", () => {
  const t = translator({ cacheBaseline: 0 });
  const se = (event) => ({ type: "stream_event", event });
  let out = "";
  out += t.push(se({ type: "message_start", message: { id: "m1", usage: { input_tokens: 5, output_tokens: 1, cache_creation_input_tokens: 600 } } }));
  out += t.push(se({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }));
  out += t.push(se({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } }));
  out += t.push(se({ type: "content_block_stop", index: 0 }));
  out += t.push({ type: "assistant", message: { id: "m1", content: [{ type: "text", text: "hi" }] } });
  out += t.push(result({ input_tokens: 5, output_tokens: 9, cache_read_input_tokens: 0, cache_creation_input_tokens: 600, cache_creation: split(0, 600) }));
  out += t.end();
  const evs = parseSse(out);
  assert.deepEqual(evs.find((e) => e.type === "message_start").message.usage.cache_creation, split(600, 0), "no split yet: 5-minute");
  const acc = new UsageAccumulator();
  acc.addAnthropic(evs.find((e) => e.type === "message_start").message.usage);
  acc.addAnthropic(evs.find((e) => e.type === "message_delta").usage);
  const u = acc.finalize({}).usage;
  assert.deepEqual([u.cache_write_tokens, u.cache_write_5m_tokens, u.cache_write_1h_tokens], [600, 0, 600]);
});

test("persistent session: a continued turn bills the increment of each bucket; a baseline remembered without a split gets the smallest 1-hour share", () => {
  const cumulative = { input_tokens: 4, output_tokens: 19, cache_read_input_tokens: 6531, cache_creation_input_tokens: 5457, cache_creation: split(457, 5000) };
  const withSplit = translator({ cacheBaseline: 0, usageBaseline: { input_tokens: 2, output_tokens: 4, cache_read_input_tokens: 1959, cache_creation_input_tokens: 2105, cache_creation: split(105, 2000) } });
  withSplit.push(result(cumulative));
  assert.deepEqual(withSplit.usageOut(), { input_tokens: 2, output_tokens: 15, cache_read_input_tokens: 4572, cache_creation_input_tokens: 3352, cache_creation: split(352, 3000) });
  assert.deepEqual(withSplit.cumulativeUsage, cumulative, "the next turn's baseline keeps the split");
  // Memory written by the previous gateway version: no split. The increment still adds up to the total increment.
  const legacy = translator({ cacheBaseline: 0, usageBaseline: { input_tokens: 2, output_tokens: 4, cache_read_input_tokens: 1959, cache_creation_input_tokens: 2105 } });
  legacy.push(result(cumulative));
  const out = legacy.usageOut();
  assert.equal(out.cache_creation_input_tokens, 3352);
  assert.equal(out.cache_creation.ephemeral_5m_input_tokens + out.cache_creation.ephemeral_1h_input_tokens, 3352);
  assert.deepEqual(out.cache_creation, split(457, 2895), "unknown baseline split: the smallest 1-hour share the totals allow");
});

test("addTranslatedUsage (parked tool turn): totals and buckets add; a legacy operand without a split counts as 5-minute", () => {
  const a = { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 10, cache_creation: split(4, 6) };
  const b = { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 100 };
  assert.deepEqual(addTranslatedUsage(a, b), { input_tokens: 11, output_tokens: 22, cache_read_input_tokens: 33, cache_creation_input_tokens: 110, cache_creation: split(104, 6) });
  assert.equal(addTranslatedUsage(null, b), b);
});

test("per-turn assistant usage (no result yet) sums the buckets across turns", () => {
  const t = translator({ cacheBaseline: 0 });
  t.push({ type: "assistant", message: { id: "a1", content: [{ type: "text", text: "one" }], usage: { input_tokens: 1, output_tokens: 2, cache_creation_input_tokens: 50, cache_creation: split(50, 0) } } });
  t.push({ type: "assistant", message: { id: "a2", content: [{ type: "text", text: "two" }], usage: { input_tokens: 1, output_tokens: 2, cache_creation_input_tokens: 70, cache_creation: split(0, 70) } } });
  assert.deepEqual(t.usageOut(), { input_tokens: 2, output_tokens: 4, cache_read_input_tokens: 0, cache_creation_input_tokens: 120, cache_creation: split(50, 70) });
});

// ---------- OpenAI-style protocols ----------

test("OpenAI mappings: prompt/input tokens = input + cache read + cache creation; cached_tokens = cache read only; no non-standard fields", () => {
  const usage = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 400, cache_creation_input_tokens: 1500, cache_creation: split(1000, 500) };
  const chat = anthropicMessageToOpenai({ id: "msg_1", content: [{ type: "text", text: "hi" }], stop_reason: "end_turn", usage }, "m");
  assert.deepEqual(chat.usage, { prompt_tokens: 1910, completion_tokens: 5, total_tokens: 1915, prompt_tokens_details: { cached_tokens: 400 } });
  assert.deepEqual(responsesUsageFromAnthropic(usage), { input_tokens: 1910, input_tokens_details: { cached_tokens: 400 }, output_tokens: 5, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 1915 });
});

test("Anthropic protocol over an OpenAI upstream: the official usage shape with zero cache creation", () => {
  const msg = openaiChatToAnthropicMessage({ id: "chatcmpl-1", choices: [{ message: { role: "assistant", content: "hi" }, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 60 } } }, "m");
  assert.deepEqual(msg.usage, { input_tokens: 40, output_tokens: 7, cache_read_input_tokens: 60, cache_creation_input_tokens: 0, cache_creation: split(0, 0) });
});

test("a result that knows only the total (modelUsage, cloud sessions) keeps the 1-hour split the turn's stream events reported", () => {
  const t = translator({ cacheBaseline: 28000 });
  const usage = { input_tokens: 10, output_tokens: 6, cache_read_input_tokens: 33725, cache_creation_input_tokens: 1200, cache_creation: split(0, 1200) };
  t.push({ type: "stream_event", event: { type: "message_start", message: { id: "m1", usage: { ...usage, output_tokens: 1 } } } });
  t.push({ type: "assistant", message: { id: "m1", content: [{ type: "text", text: "hi" }], usage } });
  t.push({ type: "result", subtype: "success", result: "hi", modelUsage: { m: { inputTokens: 10, outputTokens: 6, cacheReadInputTokens: 33725, cacheCreationInputTokens: 1200 } } });
  assert.deepEqual(t.usageOut(), { input_tokens: 10, output_tokens: 6, cache_read_input_tokens: 5725, cache_creation_input_tokens: 1200, cache_creation: split(0, 1200) });
  // continued turn of a persistent process: the remembered 1-hour total plus what this turn's events reported
  const cont = translator({ cacheBaseline: 0, usageBaseline: { input_tokens: 10, output_tokens: 6, cache_read_input_tokens: 0, cache_creation_input_tokens: 1200, cache_creation: split(200, 1000) } });
  cont.push({ type: "assistant", message: { id: "m2", content: [{ type: "text", text: "hi" }], usage: { input_tokens: 5, output_tokens: 3, cache_creation_input_tokens: 700, cache_creation: split(100, 600) } } });
  cont.push({ type: "result", subtype: "success", result: "hi", modelUsage: { m: { inputTokens: 15, outputTokens: 9, cacheReadInputTokens: 0, cacheCreationInputTokens: 1900 } } });
  assert.deepEqual(cont.usageOut(), { input_tokens: 5, output_tokens: 3, cache_read_input_tokens: 0, cache_creation_input_tokens: 700, cache_creation: split(100, 600) });
});
