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
  assert.ok(t.appendSystemPrompt.startsWith("You are Acme's assistant.\n\nEnvironment note:"), `caller text first, then the sandbox-environment note: ${t.appendSystemPrompt.slice(0, 80)}`);
  assert.equal(t.appendSystemPrompt.includes("x-anthropic-billing-header"), false, "the client's own billing header never travels inside the appended text");
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

// ---- WP3: native sessions ----
import { buildNativeTranscript, transcriptBlocks, countStrippedThinking } from "../dist/ccr/native-session.js";

test("buildNativeTranscript: Claude Code jsonl shape, parentUuid chain, tool pairs kept, thinking stripped (G3), empty turns skipped", () => {
  const SID = "11111111-2222-4333-8444-555555555555";
  const messages = [
    { role: "user", content: "hello" },
    { role: "assistant", content: [{ type: "thinking", thinking: "secret", signature: "sig" }, { type: "text", text: "hi" }] },
    { role: "user", content: [{ type: "text", text: "look it up" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "AA" } }] },
    { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "lookup", input: { q: "x" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "42", is_error: false }] },
    { role: "assistant", content: [{ type: "redacted_thinking", data: "zzz" }] }, // nothing importable → skipped
    { role: "system", content: "ignored role" },
  ];
  const lines = buildNativeTranscript(messages, SID, { model: "claude-opus-5-5", now: () => "2026-11-01T00:00:00.000Z" });
  assert.equal(lines.length, 5);
  assert.deepEqual(lines.map((l) => l.type), ["user", "assistant", "user", "assistant", "user"]);
  assert.equal(lines[0].parentUuid, null);
  for (let i = 1; i < lines.length; i++) assert.equal(lines[i].parentUuid, lines[i - 1].uuid, `line ${i} chains to its parent`);
  for (const l of lines) { assert.equal(l.sessionId, SID); assert.equal(l.version, "2.1.312"); assert.equal(l.entrypoint, "sdk-cli"); assert.equal(l.userType, "external"); assert.equal(l.cwd, ""); }
  assert.equal(lines[0].message.content, "hello"); assert.ok(lines[0].promptId);
  assert.deepEqual(lines[1].message.content, [{ type: "text", text: "hi" }], "thinking block stripped");
  assert.equal(lines[1].message.stop_reason, "end_turn"); assert.equal(lines[1].message.model, "claude-opus-5-5");
  assert.deepEqual(lines[2].message.content.map((b) => b.type), ["text", "image"]);
  assert.equal(lines[3].message.stop_reason, "tool_use"); assert.deepEqual(lines[3].message.content, [{ type: "tool_use", id: "toolu_1", name: "lookup", input: { q: "x" } }]);
  assert.deepEqual(lines[4].message.content, [{ type: "tool_result", tool_use_id: "toolu_1", content: "42" }]);
  assert.ok(!JSON.stringify(lines).includes("secret") && !JSON.stringify(lines).includes("sig\""), "no thinking text or signature travels");
  assert.equal(countStrippedThinking(messages), 2);
  assert.deepEqual(transcriptBlocks([{ type: "thinking", thinking: "x" }]), []);
});

test("canonicalTurn with history import on: history → importHistory, live turn raw; import never applies to a tool-round tail", () => {
  const body = { messages: [{ role: "user", content: "a" }, { role: "assistant", content: "b" }, { role: "user", content: "c" }] };
  const off = canonicalTurn(body, "fresh", false, false);
  assert.equal(off.error.code, "history_import_unsupported"); assert.equal(off.importHistory, null);
  const on = canonicalTurn(body, "fresh", false, true);
  assert.equal(on.error, null); assert.deepEqual(on.content, [{ type: "text", text: "c" }]); assert.equal(on.importHistory.length, 2);
  const toolTail = { messages: [{ role: "user", content: "a" }, { role: "assistant", content: [{ type: "tool_use", id: "t", name: "f", input: {} }] }, { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "r" }] }] };
  assert.equal(canonicalTurn(toolTail, "fresh", false, true).error.code, "history_import_unsupported", "a tool round cannot be resumed into a generation");
  assert.equal(canonicalTurn({ messages: [{ role: "user", content: "only" }] }, "fresh", false, true).importHistory, null, "single turn: nothing to import");
});

test("canonicalTurn (X-42): trailing role:system messages are the live turn's tail, not history — fresh [user, system] is accepted; history import excludes them; continue keeps them", async () => {
  const { CANONICAL_ENV_NOTE, CANONICAL_ENV_NOTE_V2, canonicalBuiltInToolProfile } = await import("../dist/ccr/worker.js");
  const env = { role: "system", content: [{ type: "text", text: "# Environment\n - Platform: win32", cache_control: { type: "ephemeral" } }] };
  // Claude Code 2.1.31x first request: [user, system(# Environment)] — before X-42 refused as history_import_unsupported.
  const on = (body, mode, live, imp = false) => canonicalTurn(body, mode, live, imp, true);
  // flag off (default): exactly the old behaviour — [user, system] is still refused
  assert.equal(canonicalTurn({ messages: [{ role: "user", content: "hi" }, env] }, "fresh", false).error.code, "history_import_unsupported");
  const first = on({ messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }, env] }, "fresh", false);
  assert.equal(first.error, null, "a trailing system message is not external history");
  assert.deepEqual(first.content, [{ type: "text", text: "hi" }, { type: "text", text: "# Environment\n - Platform: win32" }], "user blocks first, then the system text (cache_control dropped)");
  assert.equal(first.importHistory, null);
  // two trailing system messages (environment + task notification), string content
  const two = on({ messages: [{ role: "user", content: "q" }, { role: "system", content: "env" }, { role: "system", content: "note" }] }, "fresh", false);
  assert.deepEqual(two.content, [{ type: "text", text: "q" }, { type: "text", text: "env" }, { type: "text", text: "note" }]);
  // history import on: the trailing system is not imported, the earlier turns are
  const hist = on({ messages: [{ role: "user", content: "a" }, { role: "assistant", content: "b" }, { role: "user", content: "c" }, env] }, "fresh", false, true);
  assert.equal(hist.error, null);
  assert.deepEqual(hist.importHistory, [{ role: "user", content: "a" }, { role: "assistant", content: "b" }]);
  assert.equal(hist.content.length, 2); assert.equal(hist.content[0].text, "c");
  // history import off: still refused (the history, not the system tail, is the problem)
  assert.equal(on({ messages: [{ role: "user", content: "a" }, { role: "assistant", content: "b" }, { role: "user", content: "c" }, env] }, "fresh", false, false).error.code, "history_import_unsupported");
  // a tool-round tail behind a trailing system message is still a tool round nobody holds
  const tr = on({ messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "42" }] }, env] }, "fresh", false);
  assert.equal(tr.error.code, "history_import_unsupported");
  // continue on a live session: the live user turn plus the system tail
  const cont = on({ messages: [{ role: "user", content: "a" }, { role: "assistant", content: "b" }, { role: "user", content: "c" }, env] }, "continue", true);
  assert.equal(cont.error, null); assert.deepEqual(cont.content.map((b) => b.text), ["c", "# Environment\n - Platform: win32"]);
  // only system messages, no user: nothing to send
  assert.deepEqual(on({ messages: [env] }, "fresh", false).content, [{ type: "text", text: "# Environment\n - Platform: win32" }], "no user turn at all: the system text is what gets sent (unchanged behaviour)");
  // environment note: v1 by default, v2 with the compat flag; caller text always first
  const v1 = canonicalTurn({ system: "S", messages: [{ role: "user", content: "x" }] }, "fresh", false, false, false);
  const v2 = canonicalTurn({ system: "S", messages: [{ role: "user", content: "x" }] }, "fresh", false, false, true);
  assert.equal(v1.appendSystemPrompt, `S\n\n${CANONICAL_ENV_NOTE}`);
  assert.equal(v2.appendSystemPrompt, `S\n\n${CANONICAL_ENV_NOTE_V2}`);
  assert.ok(CANONICAL_ENV_NOTE_V2.includes("mcp__caller__") && /never mention this sandbox/.test(CANONICAL_ENV_NOTE_V2));
  // built-in tool profile: tools-disabled only with the compat flag on AND caller tools present
  assert.equal(canonicalBuiltInToolProfile(true, true), "tools-disabled-canonical");
  assert.equal(canonicalBuiltInToolProfile(true, false), "restricted-default");
  assert.equal(canonicalBuiltInToolProfile(false, true), "restricted-default");
  assert.equal(canonicalBuiltInToolProfile(false, false), "restricted-default");
});
