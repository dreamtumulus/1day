// Cross-dialect converters (convert.ts): error propagation and request mapping — pure, against dist/.
import assert from "node:assert/strict";
import { test } from "node:test";
import { AnthropicToOpenaiStream, OpenaiToAnthropicStream, openaiChatToAnthropic } from "../dist/convert.js";

const datas = (parts) => parts.join("").split("\n\n").filter(Boolean).map((c) => JSON.parse(c.split("\n").find((l) => l.startsWith("data:")).slice(5)));

test("anthropic -> openai stream: upstream error event becomes an {error} chunk and suppresses [DONE]", () => {
  const s = new AnthropicToOpenaiStream("m", true);
  const out = [
    ...s.push({ type: "message_start", message: { usage: { input_tokens: 5, output_tokens: 1 } } }),
    ...s.push({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hel" } }),
    ...s.push({ type: "error", error: { type: "overloaded_error", message: "boom" } }),
    ...s.end(),
  ];
  const js = datas(out);
  assert.equal(js.at(-1).error.message, "boom");
  assert.ok(!out.join("").includes("[DONE]"));
  assert.ok(!js.some((j) => j.usage));
  assert.equal(s.errored, true);
});

test("openai -> anthropic stream: {error} chunk becomes `event: error` and suppresses message_stop", () => {
  const s = new OpenaiToAnthropicStream("m");
  const out = [
    ...s.push({ choices: [{ index: 0, delta: { role: "assistant", content: "Hel" }, finish_reason: null }] }),
    ...s.push({ error: { message: "upstream died", type: "server_error" } }),
    ...s.end(),
  ].join("");
  assert.ok(out.includes("event: content_block_stop")); // open block closed before the error
  assert.ok(out.includes('event: error\ndata: {"type":"error","error":{"type":"server_error","message":"upstream died"}}'));
  assert.ok(!out.includes("message_stop") && !out.includes("message_delta"));
  assert.equal(s.errored, true);
});

test("openai -> anthropic stream: normal end still emits message_delta + message_stop", () => {
  const s = new OpenaiToAnthropicStream("m");
  const out = [...s.push({ choices: [{ index: 0, delta: { content: "x" }, finish_reason: "stop" }] }), ...s.end()].join("");
  assert.ok(out.includes("event: message_stop") && out.includes('"stop_reason":"end_turn"'));
});

test("chat request -> anthropic: top_p is dropped when temperature is present (Claude rejects both)", () => {
  const both = openaiChatToAnthropic({ messages: [{ role: "user", content: "hi" }], temperature: 0.7, top_p: 0.9 }, "m");
  assert.equal(both.temperature, 0.7);
  assert.equal(both.top_p, undefined);
  const only = openaiChatToAnthropic({ messages: [{ role: "user", content: "hi" }], top_p: 0.9 }, "m");
  assert.equal(only.top_p, 0.9);
});
