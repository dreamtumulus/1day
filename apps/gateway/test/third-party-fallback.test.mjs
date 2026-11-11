import assert from "node:assert/strict";
import { test } from "node:test";

const { thirdPartyPromptKey, inspectThirdPartyResponse, THIRD_PARTY_FALLBACK_TTL_MS, THIRD_PARTY_KEY_CHARS } = await import("../dist/ccr/third-party-fallback.js");

const REFUSALS = [
  "API Error: 400 Third-party apps now draw from extra usage, not plan limits. Ask your workspace admin to add more and keep going.",
  "API Error: 400 Third-party apps now draw from your extra usage, not your plan limits. Add more at claude.ai/settings/usage and keep going.",
];

function jsonError(message, status = 502) {
  return new Response(JSON.stringify({ type: "error", error: { type: "api_error", message: `ccr_worker: ${message}` } }), { status, headers: { "content-type": "application/json" } });
}

function sse(...chunks) {
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    },
  }), { status: 200, headers: { "content-type": "text/event-stream; charset=utf-8" } });
}

function errorEvent(message) {
  return `event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "api_error", message: `ccr_worker: ${message}` } })}\n\n`;
}

test("fingerprint drops the billing line and ignores instructions after the agent prefix", () => {
  const prefix = "You are an agent.\n" + "x".repeat(THIRD_PARTY_KEY_CHARS);
  const body = (suffix, version = "2.1.322") => ({
    system: [{ type: "text", text: `x-anthropic-billing-header: cc_version=${version}; cc_entrypoint=cli;` }, { type: "text", text: prefix + suffix }],
    messages: [],
  });
  assert.equal(thirdPartyPromptKey(body(" date=2026-11-11 cwd=/a")), thirdPartyPromptKey(body(" date=2026-11-12 cwd=/b", "2.1.319")));
  assert.equal(thirdPartyPromptKey({ system: "x-anthropic-billing-header: cc_version=2.1.322; cc_entrypoint=cli;" }), "");
  assert.equal(THIRD_PARTY_FALLBACK_TTL_MS, 43_200_000);
});

test("non-stream: an unanswered third-party refusal is retryable in both upstream wordings", async () => {
  for (const message of REFUSALS) {
    const checked = await inspectThirdPartyResponse(jsonError(message), false);
    assert.equal(checked.refused, true);
    assert.equal(checked.response, null);
  }
});

test("non-stream: partial output and other errors are preserved, never replayed", async () => {
  const partial = REFUSALS[0] + " (after partial output)";
  for (const message of [partial, "API Error: 400 cache_control is invalid"]) {
    const checked = await inspectThirdPartyResponse(jsonError(message), false);
    assert.equal(checked.refused, false);
    const text = await checked.response.text();
    assert.match(text, /ccr_worker:/);
    assert.ok(text.includes(message), `response preserves: ${message}`);
  }
  const ok = jsonError("unused", 200);
  assert.equal((await inspectThirdPartyResponse(ok, false)).response, ok);
});

test("stream: an error-only first chunk is refused before anything reaches the client", async () => {
  const checked = await inspectThirdPartyResponse(sse(errorEvent(REFUSALS[0])), true);
  assert.equal(checked.refused, true);
  assert.equal(checked.response, null);
});

test("stream: a normal first chunk is prepended losslessly and a later refusal is not retried", async () => {
  const start = "event: message_start\ndata: {\"type\":\"message_start\"}\n\n";
  const checked = await inspectThirdPartyResponse(sse(start, errorEvent(REFUSALS[0])), true);
  assert.equal(checked.refused, false);
  assert.equal(await checked.response.text(), start + errorEvent(REFUSALS[0]));
});

test("stream: a refusal marked after partial output is forwarded, not replayed", async () => {
  const event = errorEvent(REFUSALS[0] + " (after partial output)");
  const checked = await inspectThirdPartyResponse(sse(event), true);
  assert.equal(checked.refused, false);
  assert.equal(await checked.response.text(), event);
});


test("stream: ping and comment keepalives do not suppress a safe retry", async () => {
  const ping = "event: ping\ndata: {}\n\n";
  const comment = ": keepalive\n\n";
  const checked = await inspectThirdPartyResponse(sse(ping, comment, errorEvent(REFUSALS[0])), true);
  assert.equal(checked.refused, true);
  assert.equal(checked.response, null);
});

test("stream: ping followed by message_start is an answer and is replayed losslessly without retry", async () => {
  const ping = "event: ping\ndata: {}\n\n";
  const start = "event: message_start\ndata: {\"type\":\"message_start\"}\n\n";
  const checked = await inspectThirdPartyResponse(sse(ping, start, errorEvent(REFUSALS[0])), true);
  assert.equal(checked.refused, false);
  assert.equal(await checked.response.text(), ping + start + errorEvent(REFUSALS[0]));
});
