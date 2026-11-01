// Canonical worker (spec WP2): what a request may send to the native process (I1 / I3), and the translator's handling
// of the process's own --restricted tool rounds (I4: internal tool events never reach the client).
import assert from "node:assert/strict";
import { test } from "node:test";
import { canonicalTurn } from "../dist/ccr/worker.js";
import { SessionTranslator, callerSystemText } from "../dist/ccr/translate.js";

const parseSse = (s) => s.split("\n\n").filter(Boolean).map((chunk) => JSON.parse(chunk.split("\n").find((l) => l.startsWith("data:")).slice(5)));

test("canonicalTurn: single user turn → raw content + appended system (billing line dropped); history / tool rounds without a live session → history_import_unsupported", () => {
  const body = {
    system: [{ type: "text", text: "x-anthropic-billing-header: cc_version=2.1.237; cc_entrypoint=cli;" }, { type: "text", text: "You are Acme's assistant." }],
    messages: [{ role: "user", content: [{ type: "text", text: "Hello" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }] }],
  };
  const t = canonicalTurn(body, "fresh", false);
  assert.equal(t.error, null);
  assert.equal(t.appendSystemPrompt, "You are Acme's assistant.", "the client's own billing header never travels inside the appended text");
  assert.deepEqual(t.content, body.messages[0].content, "the user's blocks, verbatim — no [user] fold, no platform note");
  assert.equal(callerSystemText({ system: "plain string system" }), "plain string system");
  // string content
  assert.deepEqual(canonicalTurn({ messages: [{ role: "user", content: "hi" }] }, "fresh", false).content, [{ type: "text", text: "hi" }]);
  // external history on a fresh process: refused, not folded
  const hist = canonicalTurn({ messages: [{ role: "user", content: "a" }, { role: "assistant", content: "b" }, { role: "user", content: "c" }] }, "fresh", false);
  assert.equal(hist.error.code, "history_import_unsupported"); assert.equal(hist.content, null);
  // a tool round nobody holds
  const tr = canonicalTurn({ messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "42" }] }] }, "fresh", false);
  assert.equal(tr.error.code, "history_import_unsupported");
  assert.equal(canonicalTurn({ messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "42" }] }] }, "tool_result", false).error.code, "history_import_unsupported");
  // live session continue: only the last turn, raw
  const cont = canonicalTurn({ messages: [{ role: "user", content: "a" }, { role: "assistant", content: "b" }, { role: "user", content: "c" }] }, "continue", true);
  assert.equal(cont.error, null); assert.deepEqual(cont.content, [{ type: "text", text: "c" }]);
  // parked tool round answered through MCP results: no content of its own
  const park = canonicalTurn({ messages: [{ role: "user", content: "a" }, { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "f", input: {} }] }, { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "42" }] }] }, "tool_result", true);
  assert.equal(park.error, null); assert.equal(park.content, null);
});

test("translator internalTools: a --restricted tool round (tool_use stop without caller tools) is consumed, not a client stop; caller MCP tools still stop the turn", () => {
  const t = new SessionTranslator({ model: "m", simulateTools: false, nativeTools: true, internalTools: true, toolNames: ["lookup"] });
  const se = (event) => ({ type: "stream_event", event });
  let out = "";
  // API call 1: the model reads a file with the built-in Read tool
  out += t.push(se({ type: "message_start", message: { id: "m1", usage: { input_tokens: 10, output_tokens: 1 } } }));
  out += t.push(se({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }));
  out += t.push(se({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Let me check. " } }));
  out += t.push(se({ type: "content_block_stop", index: 0 }));
  out += t.push(se({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_int", name: "Read", input: {} } }));
  out += t.push(se({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"file_path":"/x"}' } }));
  out += t.push(se({ type: "content_block_stop", index: 1 }));
  out += t.push(se({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 7 } }));
  out += t.push({ type: "assistant", message: { id: "m1", content: [{ type: "text", text: "Let me check. " }, { type: "tool_use", id: "toolu_int", name: "Read", input: { file_path: "/x" } }] } });
  out += t.push({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_int", content: "file body" }] } });
  assert.equal(t.stopReason, "end_turn", "not a client tool_use stop");
  assert.equal(t.internalToolRounds, 1);
  assert.equal(t.awaitingTools, null);
  // API call 2: the answer, then a caller tool via MCP
  out += t.push(se({ type: "message_start", message: { id: "m2", usage: { input_tokens: 20, output_tokens: 1 } } }));
  out += t.push(se({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }));
  out += t.push(se({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Done." } }));
  out += t.push(se({ type: "content_block_stop", index: 0 }));
  out += t.push(se({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_c", name: "mcp__caller__lookup", input: {} } }));
  out += t.push(se({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"q":"x"}' } }));
  out += t.push(se({ type: "content_block_stop", index: 1 }));
  out += t.push(se({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 9 } }));
  out += t.push({ type: "1dayapi_tool_call", callId: "c1", name: "lookup", input: { q: "x" } });
  assert.equal(t.stopReason, "tool_use");
  assert.deepEqual(t.awaitingTools, [{ toolUseId: "toolu_c", callId: "c1", name: "lookup" }]);
  const evs = parseSse(out);
  const toolStarts = evs.filter((e) => e.type === "content_block_start" && e.content_block.type === "tool_use");
  assert.deepEqual(toolStarts.map((e) => e.content_block.name), ["lookup"], "only the caller's tool reaches the wire; Read never does");
  assert.ok(!out.includes("toolu_int") && !out.includes("file body") && !out.includes('"Read"'), "internal tool id / result text never leak");
  const content = t.message().content;
  assert.deepEqual(content.filter((b) => b.type === "tool_use").map((b) => b.name), ["lookup"]);
  assert.equal(content.filter((b) => b.type === "text").map((b) => b.text).join(""), "Let me check. Done.");
  assert.equal(t.usageOut().output_tokens, 16, "both API calls' output is billed");
});
