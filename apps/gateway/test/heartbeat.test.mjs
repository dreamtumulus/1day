// Slow-request heartbeats (src/heartbeat.ts) — pure, against dist/, with a fake Fastify reply.
import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { armNonStreamHeartbeat, beginEarlyStream, earlyStreamHeartbeat, endEarlyJson, endEarlyJsonWithError, endEarlyStreamWithError, stopNonStreamHeartbeat } from "../dist/heartbeat.js";

function fakeReply() {
  const raw = {
    status: null,
    headers: null,
    chunks: [],
    writableEnded: false,
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    flushHeaders() {},
    write(s) {
      this.chunks.push(String(s));
    },
    end(s) {
      if (s !== undefined) this.chunks.push(String(s));
      this.writableEnded = true;
    },
  };
  const headers = new Map();
  return {
    sent: false, raw,
    header(name, value) { headers.set(name.toLowerCase(), value); return this; },
    getHeader(name) { return headers.get(name.toLowerCase()); },
    hijack() { this.sent = true; },
  };
}
const ctxFor = (format, stream) => ({ reply: fakeReply(), format, stream, requestId: "r1", clientGone: false, early: null, jsonArm: null, jsonEarly: null });

test("streaming: Anthropic clients get ping events, OpenAI-dialect clients get comments", () => {
  assert.equal(earlyStreamHeartbeat("anthropic"), 'event: ping\ndata: {"type": "ping"}\n\n');
  assert.equal(earlyStreamHeartbeat("openai-chat"), ": keepalive\n\n");
  const ctx = ctxFor("anthropic", true);
  ctx.reply.header("x-1day-conversation-id", "conversation-1");
  ctx.reply.header("x-1day-conversation-generation", "2");
  ctx.reply.header("x-1day-context-reset", "1");
  beginEarlyStream(ctx);
  assert.equal(ctx.reply.sent, true, "hijacked");
  assert.equal(ctx.reply.raw.status, 200);
  assert.equal(ctx.reply.raw.headers["content-type"], "text/event-stream; charset=utf-8");
  assert.equal(ctx.reply.raw.headers["x-1day-conversation-id"], "conversation-1");
  assert.equal(ctx.reply.raw.headers["x-1day-conversation-generation"], "2");
  assert.equal(ctx.reply.raw.headers["x-1day-context-reset"], "1");
  assert.deepEqual(ctx.reply.raw.chunks, ['event: ping\ndata: {"type": "ping"}\n\n']);
  endEarlyStreamWithError(ctx, "upstream_error", "boom", "upstream_error");
  assert.equal(ctx.reply.raw.writableEnded, true);
  assert.match(ctx.reply.raw.chunks.at(-1), /^event: error\n/);
  assert.equal(ctx.early.keepalive, null, "interval cleared");
});

test("non-stream: nothing is sent before the delay; a request that finishes first keeps its real status", async () => {
  const ctx = ctxFor("anthropic", false);
  armNonStreamHeartbeat(ctx, 50, 10);
  assert.ok(ctx.jsonArm);
  armNonStreamHeartbeat(ctx, 50, 10); // idempotent
  await sleep(10);
  assert.equal(ctx.reply.sent, false);
  stopNonStreamHeartbeat(ctx); // the request answered normally
  assert.equal(ctx.jsonArm, null);
  await sleep(70);
  assert.equal(ctx.reply.sent, false, "cleared timer never commits");
  assert.deepEqual(ctx.reply.raw.chunks, []);
});

test("non-stream: after the delay a 200 is committed and padded with newlines; the body still parses as JSON", async () => {
  const ctx = ctxFor("anthropic", false);
  armNonStreamHeartbeat(ctx, 20, 15);
  await sleep(60);
  assert.equal(ctx.reply.sent, true);
  assert.equal(ctx.reply.raw.status, 200);
  assert.equal(ctx.reply.raw.headers["content-type"], "application/json");
  assert.equal(ctx.reply.raw.headers["x-accel-buffering"], "no");
  assert.ok(ctx.reply.raw.chunks.length >= 2, `padding written: ${ctx.reply.raw.chunks.length}`);
  assert.ok(ctx.reply.raw.chunks.every((c) => c === "\n"));
  endEarlyJson(ctx, JSON.stringify({ id: "msg_1", type: "message" }));
  assert.equal(ctx.reply.raw.writableEnded, true);
  assert.equal(ctx.jsonEarly.keepalive, null, "padding stopped");
  const body = ctx.reply.raw.chunks.join("");
  assert.deepEqual(JSON.parse(body), { id: "msg_1", type: "message" }, "leading whitespace is insignificant");
  const before = ctx.reply.raw.chunks.length;
  await sleep(40);
  assert.equal(ctx.reply.raw.chunks.length, before, "nothing written after end");
});

test("non-stream: a failure after the commit is a JSON error body in the client's dialect", async () => {
  const ctx = ctxFor("openai-chat", false);
  armNonStreamHeartbeat(ctx, 5, 1000);
  await sleep(30);
  assert.equal(ctx.reply.sent, true);
  endEarlyJsonWithError(ctx, 502, "upstream_error", "Upstream request failed", "upstream_error");
  const body = JSON.parse(ctx.reply.raw.chunks.join(""));
  assert.deepEqual(body, { error: { code: "upstream_error", message: "Upstream request failed", type: "upstream_error" } });
  assert.equal(ctx.reply.raw.writableEnded, true);
});

test("non-stream: a client that is gone, or a streaming request, never arms", async () => {
  const gone = { ...ctxFor("anthropic", false), clientGone: true };
  armNonStreamHeartbeat(gone, 1, 1);
  assert.equal(gone.jsonArm, null);
  const stream = ctxFor("anthropic", true);
  armNonStreamHeartbeat(stream, 1, 1);
  assert.equal(stream.jsonArm, null);
  // Client leaves while armed: the commit is skipped.
  const leaves = ctxFor("anthropic", false);
  armNonStreamHeartbeat(leaves, 10, 1000);
  leaves.clientGone = true;
  await sleep(30);
  assert.equal(leaves.reply.sent, false);
});
