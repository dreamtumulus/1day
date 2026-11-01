// Responses API first tier (spec WP4.3) golden vectors + strict parameter contract (WP4.2). Pure, against dist/.
import assert from "node:assert/strict";
import { test } from "node:test";
import { responsesToAnthropic, anthropicMessageToResponses, AnthropicToResponsesStream, ResponsesUnsupported, strictUnsupportedParams, responsesUsageFromAnthropic } from "../dist/adapters/responses.js";
import { modeFor, isCcrMode, wireModeFor } from "../dist/upstream.js";

const parse = (s) => s.split("\n\n").filter(Boolean).map((chunk) => { const lines = chunk.split("\n"); return { event: lines.find((l) => l.startsWith("event:"))?.slice(6).trim(), data: JSON.parse(lines.find((l) => l.startsWith("data:")).slice(5)) }; });

test("responsesToAnthropic: instructions + mixed input items → Messages (text/image/function_call/function_call_output), tools and tool_choice mapped", () => {
  const req = {
    model: "claude-sonnet-5-5", instructions: "Be terse.", max_output_tokens: 300, temperature: 1.5, top_p: 0.9, stream: true,
    input: [
      { role: "developer", content: "Developer note." },
      { role: "user", content: [{ type: "input_text", text: "What is in this image?" }, { type: "input_image", image_url: "data:image/png;base64,AAAA" }] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "A cat. Let me look it up." }] },
      { type: "function_call", call_id: "call_1", name: "lookup", arguments: "{\"q\":\"cat\"}" },
      { type: "function_call_output", call_id: "call_1", output: "Felis catus" },
      { type: "reasoning", id: "rs_1", summary: [] },
      { role: "user", content: "Thanks, and by URL?" },
      { role: "user", content: [{ type: "input_image", image_url: { url: "https://example.com/a.png" } }] },
    ],
    tools: [{ type: "function", name: "lookup", description: "look", parameters: { type: "object", properties: { q: { type: "string" } } } }],
    tool_choice: { type: "function", name: "lookup" },
  };
  const a = responsesToAnthropic(req, "claude-sonnet-5-5-20260101");
  assert.equal(a.model, "claude-sonnet-5-5-20260101"); assert.equal(a.max_tokens, 300); assert.equal(a.stream, true);
  assert.equal(a.system, "Be terse.\n\nDeveloper note.");
  assert.equal(a.temperature, 1, "clamped to Claude's range; top_p dropped when temperature is set");
  assert.equal(a.top_p, undefined);
  assert.deepEqual(a.messages.map((m) => m.role), ["user", "assistant", "user"], "adjacent same-role items merge (function_call joins the assistant turn; outputs + later user texts join one user turn)");
  assert.deepEqual(a.messages[0].content, [{ type: "text", text: "What is in this image?" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }]);
  assert.deepEqual(a.messages[1].content, [{ type: "text", text: "A cat. Let me look it up." }, { type: "tool_use", id: "call_1", name: "lookup", input: { q: "cat" } }]);
  assert.deepEqual(a.messages[2].content, [{ type: "tool_result", tool_use_id: "call_1", content: "Felis catus" }, { type: "text", text: "Thanks, and by URL?" }, { type: "image", source: { type: "url", url: "https://example.com/a.png" } }]);
  assert.deepEqual(a.tools, [{ name: "lookup", description: "look", input_schema: { type: "object", properties: { q: { type: "string" } } } }]);
  assert.deepEqual(a.tool_choice, { type: "tool", name: "lookup" });
  assert.deepEqual(responsesToAnthropic({ input: "hi", tools: [{ type: "function", name: "f" }], tool_choice: "required" }, "m").tool_choice, { type: "any" });
  assert.deepEqual(responsesToAnthropic({ input: "hi" }, "m"), { model: "m", max_tokens: 8192, messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] });
});

test("responsesToAnthropic: everything outside the first tier is a named ResponsesUnsupported", () => {
  const bad = (body, param) => { try { responsesToAnthropic(body, "m"); assert.fail(`expected ${param}`); } catch (e) { assert.ok(e instanceof ResponsesUnsupported, String(e)); assert.equal(e.parameter, param); } };
  bad({ input: "x", previous_response_id: "resp_1" }, "previous_response_id");
  bad({ input: "x", background: true }, "background");
  bad({ input: "x", store: true }, "store");
  bad({ input: "x", text: { format: { type: "json_schema", schema: {} } } }, "text.format");
  bad({ input: "x", tools: [{ type: "web_search_preview" }] }, "tools[0].type");
  bad({ input: [{ type: "file_search_call", id: "fs_1" }] }, "input[0].type");
  bad({ input: [{ role: "user", content: [{ type: "input_file", file_id: "file_1" }] }] }, "input[0].content[0].input_file");
  bad({ input: [{ type: "item_reference", id: "msg_1" }] }, "input[0].type");
  bad({ input: 42 }, "input");
  assert.doesNotThrow(() => responsesToAnthropic({ input: "x", store: false, text: { format: { type: "text" } } }, "m"));
});

test("anthropicMessageToResponses: text + tool_use → message + function_call items, usage mapped, max_tokens → incomplete", () => {
  const msg = { id: "msg_abc", role: "assistant", model: "claude-sonnet-5-5", stop_reason: "tool_use", content: [{ type: "thinking", thinking: "…", signature: "s" }, { type: "text", text: "Looking " }, { type: "text", text: "it up." }, { type: "tool_use", id: "toolu_9", name: "lookup", input: { q: "cat" } }], usage: { input_tokens: 10, cache_read_input_tokens: 90, cache_creation_input_tokens: 5, output_tokens: 20 } };
  const r = anthropicMessageToResponses(msg, "claude-sonnet-5-5", { instructions: "Be terse.", tools: [{ type: "function", name: "lookup" }] });
  assert.equal(r.object, "response"); assert.equal(r.id, "resp_abc"); assert.equal(r.status, "completed"); assert.equal(r.model, "claude-sonnet-5-5"); assert.equal(r.store, false);
  assert.equal(r.instructions, "Be terse."); assert.equal(r.tools.length, 1);
  assert.equal(r.output.length, 2);
  assert.equal(r.output[0].type, "message"); assert.equal(r.output[0].role, "assistant"); assert.deepEqual(r.output[0].content, [{ type: "output_text", text: "Looking it up.", annotations: [] }]);
  assert.equal(r.output[1].type, "function_call"); assert.equal(r.output[1].call_id, "toolu_9"); assert.equal(r.output[1].name, "lookup"); assert.equal(r.output[1].arguments, '{"q":"cat"}');
  assert.deepEqual(r.usage, { input_tokens: 105, input_tokens_details: { cached_tokens: 90 }, output_tokens: 20, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 125 });
  assert.ok(!JSON.stringify(r).includes("thinking"), "thinking never reaches the client");
  const cut = anthropicMessageToResponses({ ...msg, stop_reason: "max_tokens" }, "m");
  assert.equal(cut.status, "incomplete"); assert.deepEqual(cut.incomplete_details, { reason: "max_output_tokens" });
  assert.deepEqual(responsesUsageFromAnthropic(undefined), { input_tokens: 0, input_tokens_details: { cached_tokens: 0 }, output_tokens: 0, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 0 });
});

test("AnthropicToResponsesStream: event sequence for text then function call; sequence numbers; completed carries the full response", () => {
  const s = new AnthropicToResponsesStream("claude-sonnet-5-5", { instructions: "x" });
  let out = "";
  out += s.push({ type: "message_start", message: { id: "msg_1", usage: { input_tokens: 7, output_tokens: 1 } } }).join("");
  out += s.push({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }).join("");
  out += s.push({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hmm" } }).join("");
  out += s.push({ type: "content_block_stop", index: 0 }).join("");
  out += s.push({ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } }).join("");
  out += s.push({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Hel" } }).join("");
  out += s.push({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "lo" } }).join("");
  out += s.push({ type: "content_block_stop", index: 1 }).join("");
  out += s.push({ type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "toolu_1", name: "lookup", input: {} } }).join("");
  out += s.push({ type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '{"q":' } }).join("");
  out += s.push({ type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '"cat"}' } }).join("");
  out += s.push({ type: "content_block_stop", index: 2 }).join("");
  out += s.push({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 11 } }).join("");
  out += s.push({ type: "message_stop" }).join("");
  out += s.end().join("");
  const evs = parse(out);
  assert.deepEqual(evs.map((e) => e.event), [
    "response.created", "response.in_progress",
    "response.output_item.added", "response.content_part.added", "response.output_text.delta", "response.output_text.delta", "response.output_text.done", "response.content_part.done", "response.output_item.done",
    "response.output_item.added", "response.function_call_arguments.delta", "response.function_call_arguments.delta", "response.function_call_arguments.done", "response.output_item.done",
    "response.completed",
  ]);
  evs.forEach((e, i) => { assert.equal(e.data.type, e.event); assert.equal(e.data.sequence_number, i); });
  assert.ok(!out.includes("hmm"), "thinking deltas produce no events");
  const textDone = evs.find((e) => e.event === "response.output_text.done"); assert.equal(textDone.data.text, "Hello"); assert.equal(textDone.data.output_index, 0);
  const argsDone = evs.find((e) => e.event === "response.function_call_arguments.done"); assert.equal(argsDone.data.arguments, '{"q":"cat"}'); assert.equal(argsDone.data.output_index, 1);
  const completed = evs[evs.length - 1].data.response;
  assert.equal(completed.status, "completed"); assert.equal(completed.output.length, 2);
  assert.equal(completed.output[0].content[0].text, "Hello"); assert.equal(completed.output[0].status, "completed");
  assert.equal(completed.output[1].call_id, "toolu_1"); assert.equal(completed.output[1].arguments, '{"q":"cat"}');
  assert.deepEqual(completed.usage, { input_tokens: 7, input_tokens_details: { cached_tokens: 0 }, output_tokens: 11, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 18 });
  assert.equal(completed.instructions, "x");
  // max_tokens → response.incomplete; upstream error → error event, no completed
  const s2 = new AnthropicToResponsesStream("m");
  const o2 = parse([...s2.push({ type: "message_start", message: {} }), ...s2.push({ type: "message_delta", delta: { stop_reason: "max_tokens" }, usage: { output_tokens: 3 } }), ...s2.push({ type: "message_stop" })].join(""));
  assert.equal(o2[o2.length - 1].event, "response.incomplete"); assert.deepEqual(o2[o2.length - 1].data.response.incomplete_details, { reason: "max_output_tokens" });
  const s3 = new AnthropicToResponsesStream("m");
  const o3 = parse([...s3.push({ type: "message_start", message: {} }), ...s3.push({ type: "error", error: { type: "overloaded_error", message: "busy" } }), ...s3.push({ type: "message_stop" })].join(""));
  assert.equal(o3[o3.length - 1].event, "error"); assert.equal(o3[o3.length - 1].data.code, "overloaded_error"); assert.ok(s3.errored);
});

test("routing: Responses API reaches the worker (ccr-responses) and direct Anthropic accounts (responses-via-anthropic)", () => {
  assert.equal(modeFor("responses", { executor: "ccr_worker", protocol: "anthropic", type: "oauth", platform: "anthropic" }), "ccr-responses");
  assert.equal(modeFor("responses", { executor: "direct", protocol: "anthropic", type: "oauth", platform: "anthropic" }), "responses-via-anthropic");
  assert.equal(modeFor("responses", { executor: "direct", protocol: "openai", type: "api_key", platform: "openai" }), "passthrough-responses");
  assert.equal(isCcrMode("ccr-responses"), true); assert.equal(wireModeFor("ccr-responses"), "responses-via-anthropic");
});

test("strict parameter contract: ignored-list + explicit refusals per dialect; warn-equivalent empty when nothing is set", () => {
  assert.deepEqual(strictUnsupportedParams({ messages: [] }, "openai-chat", [], true), []);
  const chat = strictUnsupportedParams({ n: 2, logprobs: true, seed: 7, presence_penalty: 0.5, frequency_penalty: 0, service_tier: "auto", parallel_tool_calls: false, response_format: { type: "json_object" }, tool_choice: "required", temperature: 0.2 }, "openai-chat", ["temperature"], true);
  assert.deepEqual(chat.map((p) => p.parameter).sort(), ["logprobs", "n", "parallel_tool_calls", "presence_penalty", "response_format", "seed", "service_tier", "temperature", "tool_choice"]);
  assert.equal(chat.find((p) => p.parameter === "response_format").path, "response_format.type");
  assert.ok(!chat.some((p) => p.parameter === "frequency_penalty"), "a zero penalty is a no-op, not a refusal");
  assert.deepEqual(strictUnsupportedParams({ n: 1, tool_choice: "auto" }, "openai-chat", [], false), [], "n=1 / auto are semantic defaults");
  const resp = strictUnsupportedParams({ reasoning: { effort: "high" }, truncation: "auto", tool_choice: "required" }, "responses", [], true);
  assert.deepEqual(resp.map((p) => p.parameter).sort(), ["reasoning", "tool_choice", "truncation"]);
  assert.deepEqual(strictUnsupportedParams({ truncation: "disabled", tool_choice: "required" }, "responses", [], false), [], "direct path honours a forced tool_choice natively");
  const anth = strictUnsupportedParams({ tool_choice: { type: "any" }, output_format: { type: "json_schema" }, service_tier: "auto" }, "anthropic", ["top_k"], true);
  assert.deepEqual(anth.map((p) => p.parameter).sort(), ["output_format", "service_tier", "tool_choice", "top_k"]);
  assert.deepEqual(strictUnsupportedParams({ tool_choice: { type: "auto" } }, "anthropic", [], true), []);
});
