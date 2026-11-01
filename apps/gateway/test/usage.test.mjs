// Request-size estimate (fallback billing when upstream reports no usage):
// text at chars/4, base64 media at a flat per-block cost, never by byte length.
import assert from "node:assert/strict";
import { test } from "node:test";
import { estimateRequestTokens, estimateTokens, UsageAccumulator } from "../dist/usage.js";

test("estimateRequestTokens: media blocks cost a flat amount, not their base64 length", () => {
  const big = "A".repeat(8_000_000); // ~8 MB image payload
  const text = "x".repeat(4000); // 1000 tokens
  const anthropic = { model: "m", messages: [{ role: "user", content: [{ type: "text", text }, { type: "image", source: { type: "base64", media_type: "image/png", data: big } }] }] };
  const n = estimateRequestTokens(anthropic);
  assert.ok(n < 4000, `image must not be counted as 2M tokens: ${n}`);
  assert.ok(n >= 1000 + 1600, `text + one media block: ${n}`);
  const openai = { model: "m", messages: [{ role: "user", content: [{ type: "text", text }, { type: "image_url", image_url: { url: `data:image/png;base64,${big}` } }] }] };
  assert.ok(estimateRequestTokens(openai) < 4000);
  const doc = { messages: [{ role: "user", content: [{ type: "document", source: { type: "base64", media_type: "application/pdf", data: big } }] }] };
  assert.ok(estimateRequestTokens(doc) < 2000);
  // Plain text requests: chars/4 over the text itself; JSON keys are not billed, so never above the old whole-body estimate.
  const plain = { model: "m", messages: [{ role: "user", content: "hello world" }] };
  assert.ok(estimateRequestTokens(plain) >= estimateTokens("hello world"));
  assert.ok(estimateRequestTokens(plain) <= estimateTokens(JSON.stringify(plain)));
});

test("usage observation keeps actual model and counts tools without duplicate stream deltas", () => {
  const acc = new UsageAccumulator();
  acc.observeRequest({ messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "one", content: "result" }] }] });
  acc.observeModel("claude-sonnet-5-20260101");
  acc.addAnthropicContent([{ type: "text", text: "x" }, { type: "tool_use", id: "one", name: "weather" }]);
  acc.addOpenAIToolCalls([{ index: 0, id: "call-one" }, { index: 0, function: { arguments: "{}" } }]);
  acc.addResponsesItem({ type: "function_call", id: "item-one" });
  acc.addResponsesItem({ type: "function_call", id: "item-one" });
  assert.equal(acc.actualModel, "claude-sonnet-5-20260101");
  assert.equal(acc.toolResults, 1);
  assert.equal(acc.toolCalls, 3);
});
