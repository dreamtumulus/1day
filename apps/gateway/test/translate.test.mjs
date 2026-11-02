// CCR translation layer (docs/ccr-supply.md §5–§6) — pure, against dist/.
import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionTranslator, buildSessionEvents, ccrUnsupportedReason, extractToolCall, messagesToPrompt, toolChoiceInstruction, workerSystemPrompt } from "../dist/ccr/translate.js";

const parseSse = (s) => s.split("\n\n").filter(Boolean).map((chunk) => JSON.parse(chunk.split("\n").find((l) => l.startsWith("data:")).slice(5)));

test("streamed empty text block never reaches the wire (2026-10-23: clients echoed it back as \".\"); output_tokens not over-counted", () => {
  const t = new SessionTranslator({ model: "m", simulateTools: false });
  const se = (event) => ({ type: "stream_event", event });
  let out = "";
  out += t.push(se({ type: "message_start", message: { id: "m1", usage: { input_tokens: 5, output_tokens: 1 } } }));
  out += t.push(se({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }));
  out += t.push(se({ type: "content_block_stop", index: 0 })); // empty block (worker emits one before tool_use)
  out += t.push(se({ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } }));
  out += t.push(se({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "hi" } }));
  out += t.push(se({ type: "content_block_stop", index: 1 }));
  out += t.push(se({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 23 } }));
  out += t.push({ type: "assistant", message: { id: "m1", content: [{ type: "text", text: "hi" }] } });
  out += t.push({ type: "result", subtype: "success", result: "hi" });
  out += t.end();
  const evs = parseSse(out);
  const starts = evs.filter((e) => e.type === "content_block_start").map((e) => e.index);
  const stops = evs.filter((e) => e.type === "content_block_stop").map((e) => e.index);
  assert.deepEqual(starts, [0], "the empty block is dropped, the real one takes index 0");
  assert.deepEqual(stops, [0]);
  assert.deepEqual(t.message().content, [{ type: "text", text: "hi" }]); // empty block filtered from the final message
  assert.equal(t.usageOut().output_tokens, 23);
  assert.equal(t.usageOut().input_tokens, 5);
});

test("single-turn text is sent verbatim; multi-turn is folded with role tags", () => {
  assert.equal(messagesToPrompt({ messages: [{ role: "user", content: "hi" }] }), "hi");
  assert.equal(messagesToPrompt({ messages: [{ role: "user", content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }] }), "a\nb");
  const folded = messagesToPrompt({
    system: "be brief",
    messages: [{ role: "user", content: "q1" }, { role: "assistant", content: "a1" }, { role: "user", content: "q2" }],
  });
  assert.equal(folded, "[system]\nbe brief\n\n[user]\nq1\n\n[assistant]\na1\n\n[user]\nq2");
});

test("tool definitions become a prompt-level protocol; tool_use/tool_result history is folded", () => {
  const p = messagesToPrompt({
    tools: [{ name: "get_weather", description: "w", input_schema: { type: "object" } }],
    messages: [
      { role: "user", content: "weather?" },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "get_weather", input: { city: "Paris" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "sunny" }] },
    ],
  });
  assert.ok(p.includes('"name":"get_weather"') && p.includes("fenced block tagged tool_call"));
  assert.ok(p.includes("```tool_call\n{\"id\":\"t1\",\"name\":\"get_weather\",\"input\":{\"city\":\"Paris\"}}\n```"));
  assert.ok(p.includes("[tool_result for t1]\nsunny"));
});

test("capability matrix rejections", () => {
  assert.equal(ccrUnsupportedReason({ messages: [{ role: "user", content: "x" }], tool_choice: { type: "auto" } }), null);
  assert.equal(ccrUnsupportedReason({ messages: [], tool_choice: { type: "any" } }).code, "ccr_unsupported_tool_choice");
  assert.equal(ccrUnsupportedReason({ messages: [], tool_choice: { type: "tool", name: "x" } }).code, "ccr_unsupported_tool_choice");
  assert.equal(ccrUnsupportedReason({ messages: [{ role: "user", content: [{ type: "image", source: {} }] }] }).code, "ccr_unsupported_content");
});

test("inbound events follow the documented shape", () => {
  const ev = buildSessionEvents("cse_1", "claude-x", "hello");
  assert.deepEqual(ev[0].payload, { type: "control_request", request: { subtype: "set_model", model: "claude-x" } });
  assert.equal(ev[1].payload.type, "user");
  assert.equal(ev[1].payload.session_id, "cse_1");
  assert.deepEqual(ev[1].payload.message, { role: "user", content: "hello" });
  assert.match(ev[1].payload.uuid, /^[0-9a-f-]{36}$/);
});

test("stream_event partials stream as deltas; assistant + result close without duplication", () => {
  const t = new SessionTranslator({ model: "claude-sonnet-5", simulateTools: false });
  const usage = { input_tokens: 10, output_tokens: 6, cache_read_input_tokens: 4, cache_creation_input_tokens: 0 };
  let out = "";
  out += t.push({ type: "system", subtype: "init" });
  out += t.push({ type: "stream_event", event: { type: "message_start", message: { id: "m1", usage: { ...usage, output_tokens: 1 } } } });
  out += t.push({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } });
  out += t.push({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello " } } });
  out += t.push({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "world" } } });
  out += t.push({ type: "stream_event", event: { type: "content_block_stop", index: 0 } });
  out += t.push({ type: "assistant", message: { id: "m1", role: "assistant", content: [{ type: "text", text: "Hello world" }], usage } });
  assert.ok(!t.finished);
  out += t.push({ type: "result", subtype: "success", result: "Hello world", usage });
  assert.ok(t.finished);
  out += t.end();
  const events = parseSse(out);
  assert.deepEqual(events.map((e) => e.type), ["message_start", "content_block_start", "content_block_delta", "content_block_delta", "content_block_stop", "message_delta", "message_stop"]);
  assert.equal(events[0].message.model, "claude-sonnet-5");
  assert.equal(events[5].usage.output_tokens, 6);
  assert.equal(events[5].delta.stop_reason, "end_turn");
  const msg = t.message();
  assert.deepEqual(msg.content, [{ type: "text", text: "Hello world" }]);
  assert.deepEqual(msg.usage, { input_tokens: 10, output_tokens: 6, cache_read_input_tokens: 4, cache_creation_input_tokens: 0 }, "no baseline configured: upstream cache passes through (§7.1)");
  assert.equal(events[5].usage.cache_read_input_tokens, 4, "message_delta carries the same cache figures");
});

test("without partials, each assistant text block is a content block; result text is not duplicated", () => {
  const t = new SessionTranslator({ model: "m", simulateTools: false });
  t.push({ type: "assistant", message: { id: "a", content: [{ type: "text", text: "Looking." }, { type: "tool_use", id: "x", name: "Read", input: {} }], usage: { input_tokens: 5, output_tokens: 2 } } });
  t.push({ type: "assistant", message: { id: "b", content: [{ type: "text", text: "Done." }], usage: { input_tokens: 7, output_tokens: 3 } } });
  t.push({ type: "result", subtype: "success", result: "Done." });
  const msg = t.message();
  assert.deepEqual(msg.content, [{ type: "text", text: "Looking." }, { type: "text", text: "Done." }]);
  assert.equal(msg.usage.input_tokens, 12);
  assert.equal(msg.usage.output_tokens, 5);
});

test("result-only sessions and error results", () => {
  const t = new SessionTranslator({ model: "m", simulateTools: false });
  t.push({ type: "result", subtype: "success", result: "only summary" });
  assert.deepEqual(t.message().content, [{ type: "text", text: "only summary" }]);
  const e = new SessionTranslator({ model: "m", simulateTools: false });
  e.push({ type: "result", subtype: "error_during_execution", is_error: true, result: "boom" });
  assert.equal(e.error, "boom");
  assert.ok(e.finished);
});

test("simulated tool call becomes a tool_use block while text before the fence streams immediately", () => {
  const t = new SessionTranslator({ model: "m", simulateTools: true });
  const text = 'Sure.\n\n```tool_call\n{"name":"get_weather","input":{"city":"Paris"}}\n```';
  const first = parseSse(t.push({ type: "assistant", message: { id: "a", content: [{ type: "text", text }] } }));
  assert.deepEqual(first.map((e) => e.type), ["message_start", "content_block_start", "content_block_delta"], "prefix streamed, fence held");
  assert.equal(first[2].delta.text, "Sure.\n\n");
  assert.equal(t.push({ type: "result", subtype: "success", result: text }), "", "block stays open until end() resolves the fence");
  const msg = t.message();
  assert.equal(msg.stop_reason, "tool_use");
  assert.equal(msg.content[0].text, "Sure.");
  assert.equal(msg.content[1].type, "tool_use");
  assert.deepEqual(msg.content[1].input, { city: "Paris" });
  const tail = parseSse(t.end());
  assert.deepEqual(tail.map((e) => e.type), ["content_block_stop", "content_block_start", "content_block_delta", "content_block_stop", "message_delta", "message_stop"]);
  assert.equal(tail[1].content_block.type, "tool_use");
  assert.equal(tail[1].index, 1);
  assert.equal(tail[4].delta.stop_reason, "tool_use");
  const types = [...first, ...tail].map((e) => e.type);
  assert.deepEqual(types, ["message_start", "content_block_start", "content_block_delta", "content_block_stop", "content_block_start", "content_block_delta", "content_block_stop", "message_delta", "message_stop"]);
  assert.equal(extractToolCall("no call here"), null);
});

test("images: rejected on cloud sessions, forwarded as stream-json content on worker accounts", async () => {
  const { messagesToContent, messageImages } = await import("../dist/ccr/translate.js");
  const img = { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } };
  const body = { model: "m", max_tokens: 8, messages: [{ role: "user", content: [{ type: "text", text: "what is this?" }, img] }] };
  assert.equal(ccrUnsupportedReason(body).code, "ccr_unsupported_content", "cloud session: still unsupported");
  assert.equal(ccrUnsupportedReason(body, { images: true }), null, "worker: accepted");
  assert.equal(ccrUnsupportedReason({ messages: [{ role: "user", content: [{ type: "document", source: {} }] }] }, { images: true }).code, "ccr_unsupported_content", "documents stay unsupported everywhere");
  assert.deepEqual(messageImages(body), [img]);
  const content = messagesToContent(body);
  assert.equal(content.length, 2);
  assert.equal(content[0].type, "text");
  assert.ok(content[0].text.includes("what is this?") && content[0].text.includes("[image attached]"), content[0].text);
  assert.deepEqual(content[1], img);
  assert.equal(messagesToContent({ messages: [{ role: "user", content: "hi" }] }), null, "bare single turn -> plain prompt path");
});

test("tool simulation streams chunked text without leaking fence characters; plain backticks flow through", () => {
  // Fence arrives split across deltas: nothing of the opener may reach the client.
  const t = new SessionTranslator({ model: "m", simulateTools: true });
  const ev = (text) => t.push({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } } });
  t.push({ type: "stream_event", event: { type: "message_start", message: { id: "m1", usage: { input_tokens: 1, output_tokens: 1 } } } });
  t.push({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } });
  let out = ev("Checking the weather ``") + ev("`tool_c") + ev('all\n{"name":"get_weather","input":{"city":"Oslo"}}\n```');
  const streamed = parseSse(out).filter((e) => e.type === "content_block_delta").map((e) => e.delta.text).join("");
  assert.equal(streamed, "Checking the weather ", "only the safe prefix was forwarded");
  t.push({ type: "stream_event", event: { type: "content_block_stop", index: 0 } });
  const full = 'Checking the weather ```tool_call\n{"name":"get_weather","input":{"city":"Oslo"}}\n```';
  t.push({ type: "assistant", message: { id: "m1", content: [{ type: "text", text: full }], usage: { input_tokens: 1, output_tokens: 9 } } });
  t.push({ type: "result", subtype: "success", result: full, usage: { input_tokens: 1, output_tokens: 9 } });
  const tail = parseSse(t.end());
  assert.ok(tail.some((e) => e.type === "content_block_start" && e.content_block.type === "tool_use" && e.content_block.name === "get_weather"));
  assert.equal(t.message().content[1].input.city, "Oslo");

  // Ordinary code fences / lone backticks are released once they can no longer become the opener.
  const t2 = new SessionTranslator({ model: "m", simulateTools: true });
  const text2 = "Use ```python\nprint(1)\n``` and `x`.";
  let out2 = t2.push({ type: "assistant", message: { id: "b", content: [{ type: "text", text: text2 }] } });
  out2 += t2.push({ type: "result", subtype: "success", result: text2 });
  out2 += t2.end();
  const deltas = parseSse(out2).filter((e) => e.type === "content_block_delta").map((e) => e.delta.text).join("");
  assert.equal(deltas, text2, "non-fence text is forwarded in full");
  assert.equal(t2.message().stop_reason, "end_turn");
  assert.equal(t2.message().content.length, 1);
});

test("is_error result after partial output is an error, not a clean success; error_max_turns after output stays a truncated answer", () => {
  const se = (event) => ({ type: "stream_event", event });
  const t = new SessionTranslator({ model: "m", simulateTools: false });
  t.push(se({ type: "message_start", message: { id: "m1", usage: { input_tokens: 5, output_tokens: 1 } } }));
  t.push(se({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }));
  t.push(se({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "partial answ" } }));
  t.push({ type: "result", subtype: "error_during_execution", is_error: true, result: "API Error: 529 overloaded", modelUsage: {} });
  assert.equal(t.finished, true);
  assert.match(t.error, /^API Error: 529 overloaded \(after partial output\)$/);
  assert.deepEqual(t.result, { subtype: "error_during_execution", isError: true, text: "API Error: 529 overloaded" });

  const m = new SessionTranslator({ model: "m", simulateTools: false });
  m.push(se({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }));
  m.push(se({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "long answer" } }));
  m.push({ type: "result", subtype: "error_max_turns", is_error: true, result: "" });
  assert.equal(m.error, null);
  assert.equal(m.message().stop_reason, "max_tokens");

  const n = new SessionTranslator({ model: "m", simulateTools: false });
  n.push({ type: "result", subtype: "error_max_turns", is_error: true, result: "" });
  assert.match(n.error, /error_max_turns/, "no output at all is still an error");
});

test("worker system prompt: caller system text verbatim + no-tools note; prompt can omit the [system] section", async () => {
  const { workerSystemPrompt, messagesToPrompt: fold } = await import("../dist/ccr/translate.js");
  const body = { system: "be brief", tools: [{ name: "lookup", input_schema: { type: "object" } }], messages: [{ role: "user", content: "q1" }] };
  const sp = workerSystemPrompt(body);
  assert.ok(sp.startsWith("be brief\n\n"), sp);
  assert.match(sp, /no built-in tools/);
  assert.match(sp, /tool_call/);
  assert.match(sp, /Never output tool-invocation markup/);
  const noTools = workerSystemPrompt({ messages: [{ role: "user", content: "hi" }] });
  assert.match(noTools, /No tools are available/);
  assert.ok(!noTools.includes("undefined"));
  assert.equal(fold(body, { omitSystem: true }).includes("[system]"), false);
  assert.ok(fold(body, { omitSystem: true }).includes("[tools]"));
  assert.ok(fold(body).startsWith("[system]\nbe brief"));
  assert.match(fold(body), /Never write tool-invocation markup/);
});

test("per-turn blocks: stable prefix across turns, images in place, long histories chunked with fixed boundaries", async () => {
  const { messagesToBlocks } = await import("../dist/ccr/translate.js");
  const img = { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } };
  const turn1 = { system: "sys", messages: [{ role: "user", content: "q1" }, { role: "assistant", content: "a1" }, { role: "user", content: [{ type: "text", text: "q2" }, img] }] };
  const b1 = messagesToBlocks(turn1, { omitSystem: true });
  assert.deepEqual(b1.map((b) => b.type), ["text", "text", "text", "image"]);
  assert.equal(b1[0].text, "[user]\nq1");
  assert.equal(b1[1].text, "[assistant]\na1");
  assert.ok(b1[2].text.includes("q2") && b1[2].text.includes("[image attached]"));
  // Next turn: the earlier blocks are byte-identical (cacheable prefix), new turns appended.
  const turn2 = { ...turn1, messages: [...turn1.messages, { role: "assistant", content: "a2" }, { role: "user", content: "q3" }] };
  const b2 = messagesToBlocks(turn2, { omitSystem: true });
  assert.deepEqual(b2.slice(0, 4), b1);
  assert.equal(b2.length, 6);
  // System kept in-band when not omitted; tools preamble is its own block.
  const withTools = messagesToBlocks({ ...turn1, tools: [{ name: "t", input_schema: { type: "object" } }] });
  assert.ok(withTools[0].text.startsWith("[system]\nsys"));
  assert.ok(withTools[1].text.startsWith("[tools]\n"));
  // 200 messages -> 3 groups of 64 + 8 single blocks; adding turns keeps every earlier block identical and
  // the new turns are blocks of their own (the persistent-session planner needs the last answer + new turn separate).
  const many = { messages: Array.from({ length: 200 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `m${i}` })) };
  const bm = messagesToBlocks(many);
  assert.equal(bm.length, 3 + 8, `blocks: ${bm.length}`);
  assert.ok(bm[0].text.startsWith("[user]\nm0\n\n[assistant]\nm1") && bm[0].text.endsWith("[assistant]\nm63"));
  assert.equal(bm[3].text, "[user]\nm192");
  assert.equal(bm[10].text, "[assistant]\nm199");
  const more = { messages: [...many.messages, { role: "user", content: "m200" }, { role: "assistant", content: "m201" }, { role: "user", content: "m202" }, { role: "assistant", content: "m203" }] };
  const bm2 = messagesToBlocks(more);
  assert.deepEqual(bm2.slice(0, bm.length), bm, "earlier blocks unchanged");
  assert.equal(bm2.length, bm.length + 4);
  // The 256th message closes a 4th group: the 64 single blocks collapse into one (one fresh plan per 64 messages).
  const m256 = { messages: Array.from({ length: 256 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `m${i}` })) };
  assert.equal(messagesToBlocks(m256).length, 4);
  assert.equal(messagesToBlocks({ messages: m256.messages.slice(0, 255) }).length, 3 + 63);
  // Beyond 64 groups the group doubles so the block count stays bounded.
  const huge = { messages: Array.from({ length: 64 * 65 + 3 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `m${i}` })) };
  const bh = messagesToBlocks(huge);
  assert.ok(bh.length < 128, `blocks: ${bh.length}`);
  assert.equal(messagesToBlocks({ messages: [{ role: "user", content: "hi" }] }), null);
});

test("usageOut: cache writes beyond the baseline are billed as input when cacheWriteAsInput is on; reads stay reads", () => {
  const mk = (opts) => {
    const t = new SessionTranslator({ model: "m", simulateTools: false, cacheBaseline: 700, ...opts });
    t.push({ type: "result", subtype: "success", result: "ok", modelUsage: { m: { inputTokens: 2, outputTokens: 10, cacheReadInputTokens: 900, cacheCreationInputTokens: 5000 } } });
    return t.usageOut();
  };
  assert.deepEqual(mk({ cacheWriteAsInput: true }), { input_tokens: 5002, output_tokens: 10, cache_read_input_tokens: 200, cache_creation_input_tokens: 0 });
  assert.deepEqual(mk({ cacheWriteAsInput: false }), { input_tokens: 2, output_tokens: 10, cache_read_input_tokens: 200, cache_creation_input_tokens: 5000 });
  // Baseline larger than the read: leftover comes off the write first, then the rest is input.
  const t2 = new SessionTranslator({ model: "m", simulateTools: false, cacheBaseline: 700, cacheWriteAsInput: true });
  t2.push({ type: "result", subtype: "success", result: "ok", modelUsage: { m: { inputTokens: 2, outputTokens: 1, cacheReadInputTokens: 100, cacheCreationInputTokens: 1000 } } });
  assert.deepEqual(t2.usageOut(), { input_tokens: 402, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
});

test("messagesToBlocks alwaysBlocks: a bare single message still becomes a [user] block (persistent turn 1 shape)", async () => {
  const { messagesToBlocks } = await import("../dist/ccr/translate.js");
  const one = { messages: [{ role: "user", content: "hi" }] };
  assert.equal(messagesToBlocks(one, { omitSystem: true }), null);
  assert.deepEqual(messagesToBlocks(one, { omitSystem: true, alwaysBlocks: true }), [{ type: "text", text: "[user]\nhi" }]);
});

test("usageBaseline: a continued turn bills only the increment over the process total; a fresh init drops the baseline", () => {
  const baseline = { input_tokens: 2, output_tokens: 4, cache_read_input_tokens: 1959, cache_creation_input_tokens: 2105 };
  const result = { type: "result", subtype: "success", result: "ok", modelUsage: { m: { inputTokens: 4, outputTokens: 19, cacheReadInputTokens: 6531, cacheCreationInputTokens: 5457 } } };
  const cont = new SessionTranslator({ model: "m", simulateTools: false, cacheBaseline: 0, usageBaseline: baseline });
  cont.push(result);
  assert.deepEqual(cont.usageOut(), { input_tokens: 2, output_tokens: 15, cache_read_input_tokens: 4572, cache_creation_input_tokens: 3352 });
  assert.deepEqual(cont.cumulativeUsage, { input_tokens: 4, output_tokens: 19, cache_read_input_tokens: 6531, cache_creation_input_tokens: 5457 });
  const fresh = new SessionTranslator({ model: "m", simulateTools: false, cacheBaseline: 0, usageBaseline: baseline });
  fresh.push({ type: "system", subtype: "init" });
  fresh.push(result);
  assert.deepEqual(fresh.usageOut(), { input_tokens: 4, output_tokens: 19, cache_read_input_tokens: 6531, cache_creation_input_tokens: 5457 }, "init = new process, totals are this turn's");
});

test("native tools: mcp__caller__ tool_use streams as the client's tool_use; awaitingTools once the parked call arrives", async () => {
  const { NATIVE_TOOL_PREFIX } = await import("../dist/ccr/translate.js");
  const tr = new SessionTranslator({ model: "m", simulateTools: false, nativeTools: true });
  const se = (event) => ({ type: "stream_event", event });
  let out = "";
  out += tr.push(se({ type: "message_start", message: { id: "m1", usage: { input_tokens: 5, output_tokens: 1 } } }));
  out += tr.push(se({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_9", name: `${NATIVE_TOOL_PREFIX}get_weather`, input: {} } }));
  out += tr.push(se({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"city":' } }));
  out += tr.push(se({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '"Oslo"}' } }));
  out += tr.push(se({ type: "content_block_stop", index: 0 }));
  out += tr.push(se({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 9 } }));
  out += tr.push({ type: "assistant", message: { id: "m1", content: [{ type: "tool_use", id: "toolu_9", name: `${NATIVE_TOOL_PREFIX}get_weather`, input: { city: "Oslo" } }] } });
  assert.equal(tr.awaitingTools, null, "no parked call yet");
  out += tr.push({ type: "1dayapi_tool_call", callId: "call_1", name: "get_weather", input: { city: "Oslo" } });
  assert.deepEqual(tr.awaitingTools, [{ toolUseId: "toolu_9", callId: "call_1", name: "get_weather" }]);
  const evs = parseSse(out);
  const start = evs.find((e) => e.type === "content_block_start" && e.content_block.type === "tool_use");
  assert.equal(start.content_block.name, "get_weather", "prefix stripped for the client");
  assert.equal(evs.filter((e) => e.type === "content_block_delta" && e.delta.type === "input_json_delta").length, 2);
  const msg = tr.message();
  assert.equal(msg.stop_reason, "tool_use");
  assert.deepEqual(msg.content, [{ type: "tool_use", id: "toolu_9", name: "get_weather", input: { city: "Oslo" } }]);
  const tail = parseSse(tr.end());
  assert.equal(tail.find((e) => e.type === "message_delta").delta.stop_reason, "tool_use");
});

test("thinking passthrough: forwarded only when the client enabled thinking; documents accepted on worker", async () => {
  const { messagesToBlocks, messageImages } = await import("../dist/ccr/translate.js");
  const se = (event) => ({ type: "stream_event", event });
  const feed = (tr) => {
    let out = "";
    out += tr.push(se({ type: "message_start", message: { id: "m1", usage: { input_tokens: 5, output_tokens: 1 } } }));
    out += tr.push(se({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }));
    out += tr.push(se({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Let me think" } }));
    out += tr.push(se({ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig123" } }));
    out += tr.push(se({ type: "content_block_stop", index: 0 }));
    out += tr.push(se({ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } }));
    out += tr.push(se({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "42" } }));
    out += tr.push(se({ type: "content_block_stop", index: 1 }));
    out += tr.push(se({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 9 } }));
    out += tr.push({ type: "result", subtype: "success", result: "42", modelUsage: { m: { inputTokens: 5, outputTokens: 9, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } } });
    return out + tr.end();
  };
  const on = new SessionTranslator({ model: "m", simulateTools: false, thinking: true });
  const outOn = feed(on);
  assert.deepEqual(on.message().content, [{ type: "thinking", thinking: "Let me think", signature: "sig123" }, { type: "text", text: "42" }]);
  const evs = parseSse(outOn);
  assert.ok(evs.some((e) => e.type === "content_block_start" && e.content_block.type === "thinking"));
  assert.ok(evs.some((e) => e.type === "content_block_delta" && e.delta.type === "signature_delta" && e.delta.signature === "sig123"));
  assert.equal(evs.find((e) => e.type === "content_block_start" && e.content_block.type === "text").index, 1, "text block index follows the thinking block");
  const off = new SessionTranslator({ model: "m", simulateTools: false });
  const outOff = feed(off);
  assert.deepEqual(off.message().content, [{ type: "text", text: "42" }], "thinking dropped when not requested");
  assert.ok(!parseSse(outOff).some((e) => e.type === "content_block_start" && e.content_block.type === "thinking"));
  // Documents: rejected everywhere by default, accepted on the worker path, forwarded with their turn.
  const doc = { type: "document", source: { type: "base64", media_type: "application/pdf", data: "JVBERi0=" }, title: "spec.pdf", cache_control: { type: "ephemeral" } };
  const body = { messages: [{ role: "user", content: [{ type: "text", text: "summarize" }, doc] }] };
  assert.equal(ccrUnsupportedReason(body).code, "ccr_unsupported_content");
  assert.equal(ccrUnsupportedReason(body, { images: true }).code, "ccr_unsupported_content", "images alone do not admit documents");
  assert.equal(ccrUnsupportedReason(body, { images: true, documents: true }), null);
  assert.deepEqual(messageImages(body), [{ type: "document", source: doc.source, title: "spec.pdf" }], "client cache_control not forwarded");
  const blocks = messagesToBlocks(body, { omitSystem: true });
  assert.equal(blocks[0].type, "text");
  assert.ok(blocks[0].text.includes("[document attached: spec.pdf]"));
  assert.equal(blocks[1].type, "document");
});

// ---- 2026-10-17 fidelity fixes (veridrop + 11-case battery): stop_sequences, max_tokens, message_start usage, tool_choice, uncached baseline ----

const se = (event) => ({ type: "stream_event", event });

test("stop_sequences: split across deltas, cut before the match, held-back tail never leaks, message ends early (cutShort)", () => {
  const t = new SessionTranslator({ model: "m", simulateTools: false, stopSequences: ["FIVE"] });
  let out = "";
  out += t.push(se({ type: "message_start", message: { id: "m1", usage: { input_tokens: 9, output_tokens: 1 } } }));
  out += t.push(se({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }));
  out += t.push(se({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ONE\nTWO\nTHREE\nFOUR\nFI" } }));
  const emittedSoFar = parseSse(out).filter((e) => e.type === "content_block_delta").map((e) => e.delta.text).join("");
  assert.equal(emittedSoFar, "ONE\nTWO\nTHREE\nFOUR", "the last 3 chars (any of which could start FIVE) are held back");
  out += t.push(se({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "VE\nSIX\nSEVEN" } }));
  assert.equal(t.finished, true);
  assert.equal(t.cutShort, true);
  out += t.push(se({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: " ignored" } })); // after done: dropped
  out += t.end();
  const evs = parseSse(out);
  const text = evs.filter((e) => e.type === "content_block_delta").map((e) => e.delta.text).join("");
  assert.equal(text, "ONE\nTWO\nTHREE\nFOUR\n");
  assert.deepEqual(t.message().content, [{ type: "text", text: "ONE\nTWO\nTHREE\nFOUR\n" }]);
  assert.equal(t.message().stop_reason, "stop_sequence");
  assert.equal(t.message().stop_sequence, "FIVE");
  const delta = evs.find((e) => e.type === "message_delta");
  assert.equal(delta.delta.stop_reason, "stop_sequence");
  assert.equal(delta.delta.stop_sequence, "FIVE");
  assert.equal(evs.filter((e) => e.type === "content_block_stop").length, 1);
  // Without stop sequences nothing is held back and text flows unchanged.
  const u = new SessionTranslator({ model: "m", simulateTools: false });
  const o2 = u.push(se({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })) + u.push(se({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "FIVE SIX" } }));
  assert.equal(parseSse(o2).filter((e) => e.type === "content_block_delta").map((e) => e.delta.text).join(""), "FIVE SIX");
  assert.equal(u.cutShort, false);
});

test("max_tokens: upstream stop_reason max_tokens ends the message before the result (stream and assistant paths); usage from the stream events", () => {
  const t = new SessionTranslator({ model: "m", simulateTools: false });
  let out = "";
  out += t.push(se({ type: "message_start", message: { id: "m1", usage: { input_tokens: 40, output_tokens: 1 } } }));
  out += t.push(se({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }));
  out += t.push(se({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Rivers are" } }));
  out += t.push(se({ type: "content_block_stop", index: 0 }));
  out += t.push(se({ type: "message_delta", delta: { stop_reason: "max_tokens" }, usage: { output_tokens: 50 } }));
  assert.equal(t.finished, true, "done without a result event");
  assert.equal(t.cutShort, true);
  assert.equal(t.stopReasonOut, "max_tokens");
  out += t.push({ type: "assistant", message: { id: "m1", content: [{ type: "text", text: "Rivers are" }], stop_reason: "max_tokens" } }); // ignored after done
  out += t.end();
  const m = t.message();
  assert.equal(m.stop_reason, "max_tokens");
  assert.equal(m.stop_sequence, null);
  assert.deepEqual(m.content, [{ type: "text", text: "Rivers are" }]);
  assert.deepEqual(m.usage, { input_tokens: 40, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
  assert.equal(parseSse(out).find((e) => e.type === "message_delta").delta.stop_reason, "max_tokens");
  // Non-stream process (no partials): the assistant message carries the stop reason.
  const a = new SessionTranslator({ model: "m", simulateTools: false });
  a.push({ type: "assistant", message: { id: "m2", content: [{ type: "text", text: "cut" }], stop_reason: "max_tokens", usage: { input_tokens: 3, output_tokens: 16 } } });
  assert.equal(a.finished, true);
  assert.equal(a.cutShort, true);
  assert.equal(a.message().stop_reason, "max_tokens");
  assert.equal(a.message().usage.output_tokens, 16);
  // end_turn does not cut short.
  const b = new SessionTranslator({ model: "m", simulateTools: false });
  b.push({ type: "assistant", message: { id: "m3", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" } });
  assert.equal(b.finished, false);
  assert.equal(b.cutShort, false);
});

test("message_start carries the client-visible input usage (upstream message_start precedes the first content)", () => {
  const t = new SessionTranslator({ model: "m", simulateTools: false, cacheBaseline: 700, cacheWriteAsInput: true });
  let out = t.push(se({ type: "message_start", message: { id: "m1", usage: { input_tokens: 2, output_tokens: 1, cache_creation_input_tokens: 770, cache_read_input_tokens: 0 } } }));
  out += t.push(se({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }));
  out += t.push(se({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } }));
  const start = parseSse(out).find((e) => e.type === "message_start");
  assert.deepEqual(start.message.usage, { input_tokens: 72, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
});

test("usageOut: the part of the baseline no cache field absorbed comes off plain input (Haiku: Claude Code prefix below the cache minimum)", () => {
  const mk = (u) => {
    const t = new SessionTranslator({ model: "m", simulateTools: false, cacheBaseline: 700, cacheWriteAsInput: true });
    t.push({ type: "result", subtype: "success", result: "ok", modelUsage: { m: u } });
    return t.usageOut();
  };
  // Haiku 4.5: nothing cached, the ~600-token prefix is metered as input → not billed to the client.
  assert.deepEqual(mk({ inputTokens: 606, outputTokens: 4, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }), { input_tokens: 0, output_tokens: 4, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
  // Sonnet: prefix cached (creation 770) → unchanged behaviour: 2 + (770 - 700).
  assert.deepEqual(mk({ inputTokens: 2, outputTokens: 4, cacheReadInputTokens: 0, cacheCreationInputTokens: 770 }), { input_tokens: 72, output_tokens: 4, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
  // Continued turn: the read covers the baseline, input is the client's own.
  assert.deepEqual(mk({ inputTokens: 5, outputTokens: 4, cacheReadInputTokens: 3000, cacheCreationInputTokens: 100 }), { input_tokens: 105, output_tokens: 4, cache_read_input_tokens: 2300, cache_creation_input_tokens: 0 });
});

test("tool_choice: forced any/tool becomes a turn instruction (native and fence wording); auto/none/unknown → null; worker accepts it", () => {
  const tools = [{ name: "get_weather", input_schema: { type: "object" } }, { name: "lookup" }];
  assert.equal(toolChoiceInstruction({ tools, tool_choice: { type: "auto" } }), null);
  assert.equal(toolChoiceInstruction({ tools, tool_choice: { type: "none" } }), null);
  assert.equal(toolChoiceInstruction({ tools: [], tool_choice: { type: "any" } }), null);
  assert.equal(toolChoiceInstruction({ tools, tool_choice: { type: "tool", name: "nope" } }), null);
  const nat = toolChoiceInstruction({ tools, tool_choice: { type: "tool", name: "get_weather" } }, { nativeTools: true });
  assert.ok(nat.includes("exactly one tool call invoking `get_weather`"), nat);
  const fence = toolChoiceInstruction({ tools, tool_choice: { type: "tool", name: "get_weather" } });
  assert.ok(fence.includes("```tool_call block invoking `get_weather`"), fence);
  const any = toolChoiceInstruction({ tools, tool_choice: { type: "any" } }, { nativeTools: true });
  assert.ok(any.includes("exactly one tool call invoking whichever"), any);
  // Capability check: still a 400 for cloud sessions, accepted for the worker executor.
  assert.equal(ccrUnsupportedReason({ tools, tool_choice: { type: "any" } })?.code, "ccr_unsupported_tool_choice");
  assert.equal(ccrUnsupportedReason({ tools, tool_choice: { type: "any" } }, { toolChoice: true }), null);
  // Identity guidance rides in the worker system prompt note.
  assert.ok(workerSystemPrompt({ system: "You are Bob." }).includes("Never describe yourself as Claude Code"));
});

test("worker system prompt drops the client's Claude Code billing header line", () => {
  const sp = workerSystemPrompt({ system: [{ type: "text", text: "x-anthropic-billing-header: cc_version=2.1.237; cc_entrypoint=cli;" }, { type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." }, { type: "text", text: "Main prompt body." }] });
  assert.equal(sp.includes("x-anthropic-billing-header"), false);
  assert.equal(sp.includes("cc_version=2.1.237"), false);
  assert.ok(sp.startsWith("You are Claude Code, Anthropic's official CLI for Claude.\nMain prompt body."));
  assert.equal(workerSystemPrompt({ system: "plain system" }).startsWith("plain system"), true);
});

test("native tools: a message holding tool_use blocks is a tool_use stop even when upstream says end_turn (haiku 300 s stall, 2026-10-22)", async () => {
  const { NATIVE_TOOL_PREFIX } = await import("../dist/ccr/translate.js");
  const tr = new SessionTranslator({ model: "m", simulateTools: false, nativeTools: true });
  const se = (event) => ({ type: "stream_event", event });
  tr.push(se({ type: "message_start", message: { id: "m1", usage: { input_tokens: 5, output_tokens: 1 } } }));
  tr.push(se({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name: `${NATIVE_TOOL_PREFIX}output_json`, input: {} } }));
  tr.push(se({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"a":1}' } }));
  tr.push(se({ type: "content_block_stop", index: 0 }));
  assert.equal(tr.toolUseStopAt, null, "block closed, message not ended yet");
  tr.push(se({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 9 } }));
  tr.push(se({ type: "message_stop" }));
  assert.notEqual(tr.toolUseStopAt, null, "the park grace clock starts at message end");
  assert.equal(tr.awaitingTools, null, "no parked call yet");
  tr.push({ type: "1dayapi_tool_call", callId: "call_1", name: "output_json", input: { a: 1 } });
  assert.deepEqual(tr.awaitingTools, [{ toolUseId: "toolu_1", callId: "call_1", name: "output_json" }], "handed over as soon as the call parks");
  assert.equal(tr.message().stop_reason, "tool_use");
  assert.equal(tr.finished, false);
});

test("native tools: max_tokens on a tool_use turn still reports max_tokens", async () => {
  const { NATIVE_TOOL_PREFIX } = await import("../dist/ccr/translate.js");
  const tr = new SessionTranslator({ model: "m", simulateTools: false, nativeTools: true });
  const se = (event) => ({ type: "stream_event", event });
  tr.push(se({ type: "message_start", message: { id: "m1", usage: { input_tokens: 5, output_tokens: 1 } } }));
  tr.push(se({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name: `${NATIVE_TOOL_PREFIX}t`, input: {} } }));
  tr.push(se({ type: "content_block_stop", index: 0 }));
  tr.push(se({ type: "message_delta", delta: { stop_reason: "max_tokens" }, usage: { output_tokens: 9 } }));
  assert.equal(tr.message().stop_reason, "max_tokens");
  assert.equal(tr.cutShort, true);
  assert.equal(tr.awaitingTools, null);
});

// ---- 2026-10-23 transcript guard (opencode customer: model continued the folded transcript as prose) ----

test("fold style: native-tool histories fold tool_use as plain [tool_use] lines, fence style unchanged elsewhere", async () => {
  const { messagesToBlocks, messagesToPrompt: fold, contentText, workerSystemPrompt } = await import("../dist/ccr/translate.js");
  const body = {
    tools: [{ name: "bash", input_schema: { type: "object" } }],
    messages: [
      { role: "user", content: "run it" },
      { role: "assistant", content: [{ type: "text", text: "ok" }, { type: "tool_use", id: "toolu_1", name: "bash", input: { command: "ls" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "a.txt" }] },
    ],
  };
  const native = messagesToBlocks(body, { omitSystem: true, omitTools: true });
  assert.equal(native[1].text, '[assistant]\nok\n[tool_use toolu_1 bash]\n{"command":"ls"}');
  assert.equal(native[2].text, "[user]\n[tool_result for toolu_1]\na.txt");
  assert.ok(!native.some((b) => b.text.includes("```tool_call")));
  const fence = messagesToBlocks(body, { omitSystem: true });
  assert.ok(fence[2].text.includes("```tool_call"), "fence style when tools are simulated");
  assert.ok(fold(body, { omitSystem: true, omitTools: true }).includes("[tool_use toolu_1 bash]"));
  assert.equal(contentText(body.messages[1].content, "plain"), native[1].text.slice("[assistant]\n".length));
  // The system note explains the transcript and forbids continuing it.
  const sp = workerSystemPrompt(body, { nativeTools: true });
  assert.match(sp, /folded into one message as a transcript/);
  assert.match(sp, /never invent a tool's output/);
});

test("transcript guard: a leading [assistant] heading is dropped (held back while it could still be one)", () => {
  const t = new SessionTranslator({ model: "m", simulateTools: false, transcriptGuard: true });
  let out = "";
  out += t.push(se({ type: "message_start", message: { id: "m1", usage: { input_tokens: 1, output_tokens: 1 } } }));
  out += t.push(se({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }));
  out += t.push(se({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "[assist" } }));
  assert.equal(parseSse(out).filter((e) => e.type === "content_block_delta").length, 0, "held");
  out += t.push(se({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ant]\nHello there, this is the real answer text." } }));
  out += t.push(se({ type: "content_block_stop", index: 0 }));
  out += t.push({ type: "result", subtype: "success", result: "", usage: { input_tokens: 1, output_tokens: 5 } });
  out += t.end();
  const text = parseSse(out).filter((e) => e.type === "content_block_delta").map((e) => e.delta.text).join("");
  assert.equal(text, "Hello there, this is the real answer text.");
  assert.deepEqual(t.message().content, [{ type: "text", text: "Hello there, this is the real answer text." }]);
  assert.deepEqual(t.guardHits, ["assistant_heading"]);
  assert.equal(t.cutShort, false);
  // A normal answer that merely starts with "[" is untouched; a "[assistant]" later in the text too.
  const u = new SessionTranslator({ model: "m", simulateTools: false, transcriptGuard: true });
  let o2 = u.push(se({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }));
  o2 += u.push(se({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "[ok] see the [assistant]\nsection of the docs for details, it is long enough" } }));
  o2 += u.push(se({ type: "content_block_stop", index: 0 }));
  assert.equal(parseSse(o2).filter((e) => e.type === "content_block_delta").map((e) => e.delta.text).join(""), "[ok] see the [assistant]\nsection of the docs for details, it is long enough");
  assert.deepEqual(u.guardHits, []);
});

test("transcript guard: an invented [tool_result for …] ends the message before it (end_turn, cut short), dangling [user] stripped, nothing leaked while streaming", () => {
  const t = new SessionTranslator({ model: "m", simulateTools: false, transcriptGuard: true });
  let out = "";
  out += t.push(se({ type: "message_start", message: { id: "m1", usage: { input_tokens: 1, output_tokens: 1 } } }));
  out += t.push(se({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }));
  out += t.push(se({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Let me clean up the diagnostic file and reload.\n\n[user]\n[tool_result fo" } }));
  const soFar = parseSse(out).filter((e) => e.type === "content_block_delta").map((e) => e.delta.text).join("");
  assert.ok(!soFar.includes("[user]"), `leaked: ${JSON.stringify(soFar)}`);
  out += t.push(se({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "r toolu_01DBS]\nremoved '/etc/nginx/conf.d/geo-diag.conf'\nnginx: configuration file test is successful" } }));
  assert.equal(t.finished, true);
  assert.equal(t.cutShort, true);
  out += t.end();
  const text = parseSse(out).filter((e) => e.type === "content_block_delta").map((e) => e.delta.text).join("");
  assert.equal(text, "Let me clean up the diagnostic file and reload.\n");
  assert.deepEqual(t.message().content, [{ type: "text", text: "Let me clean up the diagnostic file and reload.\n" }]);
  assert.equal(t.message().stop_reason, "end_turn");
  assert.equal(t.message().stop_sequence, null);
  assert.deepEqual(t.guardHits, ["fabricated_tool_result"]);
  // Non-stream (assistant message) path: same cut.
  const a = new SessionTranslator({ model: "m", simulateTools: false, transcriptGuard: true });
  a.push({ type: "assistant", message: { id: "m2", content: [{ type: "text", text: "[assistant]\nDone.\n[user]\n[tool_result for toolu_9]\nfake output" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } } });
  assert.deepEqual(a.message().content, [{ type: "text", text: "Done." }]);
  assert.deepEqual(a.guardHits.sort(), ["assistant_heading", "fabricated_tool_result"]);
  // Without the guard the text is passed through (cloud executor / other paths unchanged).
  const p = new SessionTranslator({ model: "m", simulateTools: false });
  p.push({ type: "assistant", message: { id: "m3", content: [{ type: "text", text: "Done.\n[user]\n[tool_result for toolu_9]\nx" }], stop_reason: "end_turn" } });
  assert.equal(p.message().content[0].text, "Done.\n[user]\n[tool_result for toolu_9]\nx");
});

test("transcript guard + native tools: a ```tool_call fence written as text becomes a tool_use; the transcript after it is dropped", () => {
  const mk = () => new SessionTranslator({ model: "m", simulateTools: false, nativeTools: true, transcriptGuard: true, toolNames: ["bash", "read"] });
  const t = mk();
  let out = "";
  out += t.push(se({ type: "message_start", message: { id: "m1", usage: { input_tokens: 1, output_tokens: 1 } } }));
  out += t.push(se({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }));
  out += t.push(se({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "[assistant]\nI will remove the diagnostic file now.\n```tool_c" } }));
  const soFar = parseSse(out).filter((e) => e.type === "content_block_delta").map((e) => e.delta.text).join("");
  assert.ok(!soFar.includes("```"), `fence opener leaked: ${JSON.stringify(soFar)}`);
  out += t.push(se({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: 'all\n{"id":"toolu_01DBS","name":"bash","input":{"command":"rm -v /etc/nginx/conf.d/geo-diag.conf"}}\n```\n[user]\n[tool_result for toolu_01DBS]\nremoved\n[assistant]\nAll done.' } }));
  out += t.push(se({ type: "content_block_stop", index: 0 }));
  assert.equal(t.finished, true);
  assert.equal(t.cutShort, true);
  out += t.push(se({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ignored" } }));
  out += t.end();
  const evs = parseSse(out);
  assert.equal(evs.filter((e) => e.type === "content_block_delta" && e.delta.type === "text_delta").map((e) => e.delta.text).join(""), "I will remove the diagnostic file now.\n");
  const m = t.message();
  assert.equal(m.stop_reason, "tool_use");
  assert.equal(m.content.length, 2);
  assert.equal(m.content[0].text, "I will remove the diagnostic file now.\n", "stream and message agree");
  assert.equal(m.content[1].type, "tool_use");
  assert.equal(m.content[1].name, "bash");
  assert.deepEqual(m.content[1].input, { command: "rm -v /etc/nginx/conf.d/geo-diag.conf" });
  assert.match(m.content[1].id, /^toolu_[A-Za-z0-9]{24}$/);
  assert.equal(evs.find((e) => e.type === "content_block_start" && e.content_block.type === "tool_use").index, 1);
  assert.equal(JSON.parse(evs.find((e) => e.type === "content_block_delta" && e.delta.type === "input_json_delta").delta.partial_json).command, "rm -v /etc/nginx/conf.d/geo-diag.conf");
  assert.equal(evs.filter((e) => e.type === "content_block_stop").length, 2);
  assert.equal(evs.find((e) => e.type === "message_delta").delta.stop_reason, "tool_use");
  assert.equal(t.awaitingTools, null, "no parked MCP call: the worker treats the turn as finished");
  assert.deepEqual(t.guardHits.sort(), ["assistant_heading", "fence_tool_use", "transcript_tail"]);
  // Unknown tool name: the fence stays text, but the invented turns after it are still dropped.
  const u = mk();
  u.push({ type: "assistant", message: { id: "m2", content: [{ type: "text", text: 'Hmm.\n```tool_call\n{"name":"nope","input":{}}\n```\n[user]\n[tool_result for x]\nfake' }], stop_reason: "end_turn" } });
  u.push({ type: "result", subtype: "success", result: "" });
  assert.deepEqual(u.message().content, [{ type: "text", text: 'Hmm.\n```tool_call\n{"name":"nope","input":{}}\n```' }]);
  assert.equal(u.message().stop_reason, "end_turn");
  assert.deepEqual(u.guardHits.sort(), ["fence_unparsed", "transcript_tail"]);
  // A real native tool_use is unaffected.
  const n = mk();
  n.push(se({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_real", name: "mcp__caller__read" } }));
  n.push(se({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"path":"a"}' } }));
  n.push(se({ type: "content_block_stop", index: 0 }));
  n.push(se({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 3 } }));
  assert.deepEqual(n.message().content, [{ type: "tool_use", id: "toolu_real", name: "read", input: { path: "a" } }]);
  assert.deepEqual(n.guardHits, []);
});

test("simulated tools: a transcript written after the fenced call is dropped and the call still becomes a tool_use", () => {
  const t = new SessionTranslator({ model: "m", simulateTools: true });
  let out = "";
  out += t.push(se({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }));
  out += t.push(se({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: 'Checking.\n```tool_call\n{"name":"lookup","input":{"q":1}}\n```\n[user]\n[tool_result for toolu_x]\ninvented\n[assistant]\nmore' } }));
  out += t.push(se({ type: "content_block_stop", index: 0 }));
  out += t.push({ type: "result", subtype: "success", result: "" });
  out += t.end();
  const m = t.message();
  assert.equal(m.stop_reason, "tool_use");
  assert.deepEqual(m.content.map((b) => b.type), ["text", "tool_use"]);
  assert.equal(m.content[0].text, "Checking.");
  assert.equal(m.content[1].name, "lookup");
  const evs = parseSse(out);
  // (The simulate path streams the text before the opener as it arrives, newline included; message() trims it — pre-existing.)
  assert.equal(evs.filter((e) => e.type === "content_block_delta" && e.delta.type === "text_delta").map((e) => e.delta.text).join(""), "Checking.\n");
  assert.deepEqual(t.guardHits, ["transcript_tail"]);
  // Unparseable fence + transcript: text kept up to the fence close, transcript dropped, stream matches message().
  const u = new SessionTranslator({ model: "m", simulateTools: true });
  let o2 = u.push(se({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }));
  o2 += u.push(se({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "See:\n```tool_call\nnot json\n```\n[user]\nfake question" } }));
  o2 += u.push(se({ type: "content_block_stop", index: 0 }));
  o2 += u.push({ type: "result", subtype: "success", result: "" });
  o2 += u.end();
  assert.deepEqual(u.message().content, [{ type: "text", text: "See:\n```tool_call\nnot json\n```" }]);
  assert.equal(parseSse(o2).filter((e) => e.type === "content_block_delta").map((e) => e.delta.text).join(""), "See:\n```tool_call\nnot json\n```");
});

test("lazy text blocks: empty text before a native tool_use is dropped and the tool_use takes index 0; fence at the very start too", () => {
  const t = new SessionTranslator({ model: "m", simulateTools: false, nativeTools: true });
  let out = "";
  out += t.push(se({ type: "message_start", message: { id: "m1", usage: { input_tokens: 1, output_tokens: 1 } } }));
  out += t.push(se({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }));
  out += t.push(se({ type: "content_block_stop", index: 0 }));
  out += t.push(se({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_a", name: "mcp__caller__read" } }));
  out += t.push(se({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"p":1}' } }));
  out += t.push(se({ type: "content_block_stop", index: 1 }));
  out += t.push(se({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 3 } }));
  const evs = parseSse(out);
  assert.deepEqual(evs.filter((e) => e.type === "content_block_start").map((e) => [e.index, e.content_block.type]), [[0, "tool_use"]]);
  assert.deepEqual(evs.filter((e) => e.type === "content_block_stop").map((e) => e.index), [0]);
  assert.deepEqual(t.message().content, [{ type: "tool_use", id: "toolu_a", name: "read", input: { p: 1 } }]);
  // Fence fallback with nothing before the fence: tool_use at index 0, consistent between wire and message().
  const f = new SessionTranslator({ model: "m", simulateTools: false, nativeTools: true, transcriptGuard: true, toolNames: ["bash"] });
  let o2 = f.push(se({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }));
  o2 += f.push(se({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: '```tool_call\n{"name":"bash","input":{"command":"ls"}}\n```\n[user]\nfake' } }));
  o2 += f.push(se({ type: "content_block_stop", index: 0 }));
  o2 += f.end();
  const e2 = parseSse(o2);
  assert.deepEqual(e2.filter((e) => e.type === "content_block_start").map((e) => [e.index, e.content_block.type]), [[0, "tool_use"]]);
  assert.deepEqual(f.message().content.map((b) => b.type), ["tool_use"]);
  // Simulated tools, fence first: same.
  const s2 = new SessionTranslator({ model: "m", simulateTools: true });
  let o3 = s2.push(se({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }));
  o3 += s2.push(se({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: '```tool_call\n{"name":"lookup","input":{}}\n```' } }));
  o3 += s2.push(se({ type: "content_block_stop", index: 0 }));
  o3 += s2.push({ type: "result", subtype: "success", result: "" });
  o3 += s2.end();
  const e3 = parseSse(o3);
  assert.deepEqual(e3.filter((e) => e.type === "content_block_start").map((e) => [e.index, e.content_block.type]), [[0, "tool_use"]]);
  assert.deepEqual(e3.filter((e) => e.type === "content_block_stop").map((e) => e.index), [0]);
  assert.deepEqual(s2.message().content.map((b) => b.type), ["tool_use"]);
});

test("messagesToBlocksWithRoles / isSuggestionRequest: system-role blocks are marked, the suggestion side request detected", async () => {
  const { messagesToBlocksWithRoles, isSuggestionRequest } = await import("../dist/ccr/translate.js");
  const sys = (text) => ({ role: "system", content: [{ type: "text", text }] });
  const img = { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } };
  const body = { messages: [{ role: "user", content: "q1" }, { role: "assistant", content: "a1" }, sys("<total_tokens>15000000 tokens left</total_tokens>"), { role: "user", content: [{ type: "text", text: "q2" }, img] }, sys("<total_tokens>14999000 tokens left</total_tokens>\nFirst privately list…")] };
  const r = messagesToBlocksWithRoles(body, { omitSystem: true, alwaysBlocks: true });
  assert.deepEqual(r.roles, ["user", "assistant", "system", "user", "user", "system"], "image block carries its message's role");
  assert.equal(r.blocks.length, 6);
  assert.ok(r.blocks[2].text.startsWith("[user]\n<total_tokens>"), "system messages still fold as [user] text");
  assert.equal(messagesToBlocksWithRoles({ messages: [...body.messages, sys("")] }, { omitSystem: true, alwaysBlocks: true }).roles.length, 6, "empty system message folds to no block");
  // Grouped prefix: one role "group" per 64-message block, singles keep their roles.
  const many = { messages: [...Array.from({ length: 64 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `m${i}` })), sys("x"), { role: "user", content: "q" }] };
  assert.deepEqual(messagesToBlocksWithRoles(many, { omitSystem: true, alwaysBlocks: true }).roles, ["group", "system", "user"]);
  assert.equal(isSuggestionRequest({ messages: [...body.messages.slice(0, 2), { role: "user", content: "[SUGGESTION MODE: Suggest what the user might naturally say next]" }] }), true);
  assert.equal(isSuggestionRequest(body), false);
  assert.equal(isSuggestionRequest({ messages: [] }), false);
});

test("Claude Code's synthetic 'API Error' assistant text is held and becomes the session error, never content (2026-10-29)", () => {
  const refusal = "API Error: Opus 5.5's safeguards flagged this session (https://www.anthropic.com/legal/aup). Start a new session to continue.";
  const t = new SessionTranslator({ model: "m", simulateTools: false });
  const out = t.push({ type: "assistant", message: { id: "a1", role: "assistant", content: [{ type: "text", text: refusal }], usage: { input_tokens: 10, output_tokens: 1 } } });
  assert.doesNotMatch(out, /text_delta/, "the refusal must not stream as assistant text");
  t.push({ type: "result", subtype: "error_during_execution", is_error: true, result: refusal, modelUsage: {} });
  assert.equal(t.finished, true);
  assert.equal(t.error, refusal, "clean error, no '(after partial output)'");
  assert.deepEqual(t.message().content, []);
  // Even when the worker reports the turn as a success, an API Error text is never an answer.
  const u = new SessionTranslator({ model: "m", simulateTools: false });
  u.push({ type: "assistant", message: { id: "a2", role: "assistant", content: [{ type: "text", text: "API Error: 529 {\"type\":\"error\",\"error\":{\"type\":\"overloaded_error\"}}" }] } });
  u.push({ type: "result", subtype: "success", is_error: false, result: "" });
  assert.match(u.error ?? "", /^API Error: 529/);
  // The 5-hour-limit sentence (after real partial output) is still an error, not content.
  const v = new SessionTranslator({ model: "m", simulateTools: false });
  v.push({ type: "assistant", message: { id: "a3", role: "assistant", content: [{ type: "text", text: "You've hit your 5-hour limit · resets 1:20pm (Europe/Berlin)" }] } });
  v.push({ type: "result", subtype: "error_during_execution", is_error: true, result: "" });
  assert.match(v.error ?? "", /hit your 5-hour limit/);
  assert.deepEqual(v.message().content, []);
  // A normal answer is untouched.
  const w = new SessionTranslator({ model: "m", simulateTools: false });
  const ok = w.push({ type: "assistant", message: { id: "a4", role: "assistant", content: [{ type: "text", text: "The API error handling guide says: retry." }] } });
  assert.match(ok, /text_delta/);
});

test("system/api_retry events are counted into turnFacts (canary 2026-11-02 §8.1: hidden upstream retries)", () => {
  const t = new SessionTranslator({ model: "m", simulateTools: false });
  assert.deepEqual(t.turnFacts, { upstreamRetries: 0, retryStatuses: [], retryDelayMs: 0 });
  t.push({ type: "system", subtype: "init" });
  t.push({ type: "system", subtype: "api_retry", attempt: 1, max_retries: 10, retry_delay_ms: 25_000, error_status: 429, error: "rate_limit" });
  t.push({ type: "system", subtype: "api_retry", attempt: 2, max_retries: 10, retry_delay_ms: 36_000, error_status: 529, error: "overloaded" });
  t.push({ type: "system", subtype: "api_retry", attempt: 3, max_retries: 10, retry_delay_ms: "n/a", error_status: null });
  assert.deepEqual(t.turnFacts, { upstreamRetries: 3, retryStatuses: [429, 529], retryDelayMs: 61_000 });
  assert.match(t.eventTimeline, /system\/api_retry/);
});
