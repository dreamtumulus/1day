// Sampled worker turn capture (ccr/capture.ts): record shape, sampling, review flags — against dist/.
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { after, test } from "node:test";

const dir = mkdtempSync(join(tmpdir(), "1dayapi-capture-"));
process.env.DATA_DIR = dir;
after(() => rmSync(dir, { recursive: true, force: true }));
const { TurnCapture, captureWanted, summarizeBlock, clip, captureDir } = await import("../dist/ccr/capture.js");
const { SessionTranslator } = await import("../dist/ccr/translate.js");

test("captureWanted: keys always, rate deterministic per request id", () => {
  assert.equal(captureWanted("k1", "r1", { sample: "0", keys: "" }), false);
  assert.equal(captureWanted("k1", "r1", { sample: "1", keys: "" }), true);
  assert.equal(captureWanted("abcdef-1", "r1", { sample: "0", keys: "zzz, abcdef" }), true);
  let hits = 0;
  for (let i = 0; i < 2000; i++) if (captureWanted(null, `req-${i}`, { sample: "0.1", keys: "" })) hits++;
  assert.ok(hits > 120 && hits < 280, `≈10% sampled, got ${hits}`);
  assert.equal(captureWanted(null, "req-7", { sample: "0.1", keys: "" }), captureWanted(null, "req-7", { sample: "0.1", keys: "" }));
});

test("summarizeBlock clips and keeps the judging fields", () => {
  const big = "x".repeat(10_000);
  assert.equal(clip(big, 100).length, 100 + "…[+9900 chars]".length);
  assert.deepEqual(summarizeBlock({ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "ok" }] }), { type: "tool_result", tool_use_id: "t1", is_error: false, content: "ok" });
  assert.equal(summarizeBlock({ type: "image", source: { media_type: "image/png", data: "AAAA" } }).bytes, 4);
});

test("a turn is written as one NDJSON record with request and response halves", async () => {
  const tr = new SessionTranslator({ model: "claude-sonnet-5-5", simulateTools: false });
  for (const p of [
    { type: "system", subtype: "init", model: "claude-sonnet-5-5" },
    { type: "stream_event", event: { type: "message_start", message: { id: "m1", usage: { input_tokens: 12, output_tokens: 1 } } } },
    { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
    { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "[assistant]\n答案是 42。" } } },
    { type: "stream_event", event: { type: "content_block_stop", index: 0 } },
    { type: "stream_event", event: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 7 } } },
    { type: "result", subtype: "success", is_error: false },
  ]) tr.push(p);
  const body = { messages: [{ role: "user", content: "问题一" }, { role: "assistant", content: "回答一" }, { role: "user", content: [{ type: "text", text: "生命的意义是什么？" }] }], tools: [{ name: "read_file" }], max_tokens: 4096 };
  const cap = new TurnCapture({ requestId: "req-cap-1", apiKeyId: "key-1", userId: "u-1", groupId: "default", account: { id: "acct-1", name: "claude-acct" }, clientModel: "claude-sonnet-5-5", upstreamModel: "claude-sonnet-5-5", stream: false, canonical: false, persistent: true, nativeTools: true, body, systemText: "You are helpful", plan: { mode: "fresh", reason: "no_memory", content: [], hashes: [] }, sent: [{ type: "text", text: "[user]\n问题一" }, { type: "text", text: "[assistant]\n回答一" }, { type: "text", text: "[user]\n生命的意义是什么？" }], maxTokens: 4096, stopSequences: [], thinking: { thinkingWanted: false, thinkingBudget: 0, effort: "" } });
  cap.finish(tr, { status: 200 });
  cap.finish(tr, { status: 500 }); // second call ignored
  await new Promise((r) => setTimeout(r, 150));
  const files = readdirSync(captureDir());
  assert.equal(files.length, 1);
  const lines = readFileSync(join(captureDir(), files[0]), "utf8").trim().split("\n");
  assert.equal(lines.length, 1);
  const rec = JSON.parse(lines[0]);
  assert.equal(rec.requestId, "req-cap-1");
  assert.equal(rec.request.messages, 3);
  assert.equal(rec.request.roles, "uau");
  assert.deepEqual(rec.request.tools, ["read_file"]);
  assert.equal(rec.request.lastUserText, "生命的意义是什么？");
  assert.equal(rec.sent.blocks, 3);
  assert.equal(rec.plan.mode, "fresh");
  assert.equal(rec.response.status, 200);
  assert.equal(rec.response.stopReason, "end_turn");
  assert.equal(rec.response.content[0].type, "text");
  assert.equal(rec.response.usage.output_tokens, 7);
  // the review script flags the transcript-style heading the guard did not strip in this bare translator
  const out = execFileSync("node", [new URL("../../../ops/bin/worker-capture-review", import.meta.url).pathname, "--dir", captureDir(), "--hours", "1", "--show", "1"], { encoding: "utf8" });
  assert.match(out, /turns=1/);
  assert.match(out, /transcript_continuation/);
  assert.match(out, /USER> 生命的意义是什么/);
});
