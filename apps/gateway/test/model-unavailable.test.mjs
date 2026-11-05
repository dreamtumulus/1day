// Worker-path "model unavailable" classification (docs/gateway.md §3) — pure, against dist/.
import assert from "node:assert/strict";
import { test } from "node:test";
import { isCcModelUnavailable } from "../dist/ccr/model-unavailable.js";

test("matches Claude Code's selected-model error, not other worker failures", () => {
  assert.ok(isCcModelUnavailable('{"type":"error","error":{"type":"api_error","message":"ccr_worker: There\'s an issue with the selected model (claude-sonnet-4-5). It may not exist or you may not have access to it. Run --model to pick a different model. (after partial output)"}}'));
  assert.equal(isCcModelUnavailable("ccr_worker: fetch failed"), false);
  assert.equal(isCcModelUnavailable("Failed to authenticate: OAuth token revoked"), false);
  assert.equal(isCcModelUnavailable("You've hit your session limit · resets 8:50am (Europe/Berlin)"), false);
});

test("prompt-too-long classification and client text", async () => {
  const { isCcPromptTooLong, promptTooLongMessage } = await import("../dist/ccr/model-unavailable.js");
  const raw = "ccr_worker: Prompt is too long · the request is ~1088871 tokens (limit 1000000) but this conversation is only ~384968 tokens — the rest is system prompt, tool definitions, and attachment content.";
  assert.ok(isCcPromptTooLong(raw));
  assert.ok(isCcPromptTooLong("stream: ccr_worker: prompt is too long"));
  assert.equal(isCcPromptTooLong("ccr_worker: fetch failed"), false);
  assert.equal(isCcPromptTooLong("There's an issue with the selected model (x)"), false);
  assert.ok(promptTooLongMessage(raw).startsWith("Prompt is too long · the request is ~1088871 tokens"));
  assert.equal(promptTooLongMessage(raw).includes("ccr_worker"), false);
});

test("safety-classifier refusals are request errors; ordinary failures are not", async () => {
  const { classifyCcRequestError } = await import("../dist/ccr/model-unavailable.js");
  const a = classifyCcRequestError("stream: ccr_worker: API Error: Opus 5.5's safeguards flagged this session (https://www.anthropic.com/legal/aup). You may be seeing this for the first time: Opus 5.5 is more capable.");
  assert.equal(a.code, "safeguards_refusal");
  assert.ok(a.message.startsWith("Opus 5.5's safeguards flagged this session"), a.message);
  const b = classifyCcRequestError("ccr_worker: API Error: Opus 4.6 can't help with this. Start a new session to continue.\\n\\nLearn more: https://www.anthropic.com/legal/aup\\n\\nDetails: `[bio]`");
  assert.equal(b.code, "safeguards_refusal");
  assert.ok(b.message.startsWith("Opus 4.6 can't help with this."), b.message);
  assert.equal(classifyCcRequestError("ccr_worker: Prompt is too long · the request is ~1 tokens").code, "prompt_too_long");
  assert.equal(classifyCcRequestError("ccr_worker: fetch failed"), null);
  assert.equal(classifyCcRequestError("You've hit your session limit · resets 8:50am"), null);
  assert.equal(classifyCcRequestError("Failed to authenticate: OAuth token revoked"), null);
});

test("upstream 400 rendered by Claude Code is a request error (no failover); account-scoped 400s are not", async () => {
  const { classifyCcRequestError } = await import("../dist/ccr/model-unavailable.js");
  const ttl = "ccr_worker: API Error: 400 messages.1.content.0.cache_control.ttl: a ttl='1h' cache_control block must not come after a ttl='5m' cache_control block. Note that blocks are processed in order.";
  const r = classifyCcRequestError(ttl);
  assert.equal(r?.code, "upstream_invalid_request");
  assert.ok(r.message.startsWith("Upstream rejected the request: messages.1.content.0.cache_control.ttl"));
  assert.equal(r.message.includes("ccr_worker"), false);
  assert.equal(classifyCcRequestError("stream: ccr_worker: API Error: 400 A maximum of 4 blocks with cache_control may be provided. Found 5.")?.code, "upstream_invalid_request");
  assert.equal(classifyCcRequestError("ccr_worker: API Error: 400 Your credit balance is too low to access the Anthropic API."), null);
  assert.equal(classifyCcRequestError("ccr_worker: API Error: 429 rate limited"), null);
  assert.equal(classifyCcRequestError("ccr_worker: API Error: 529 overloaded"), null);
  assert.equal(classifyCcRequestError("ccr_worker: fetch failed"), null);
});
