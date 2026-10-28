// Unit tests for side-effect-free core modules (no DB opened).
import assert from "node:assert/strict";
import { test } from "node:test";
import { isModelAllowed, matchesAny, validateAllowlistInput, wildcardMatch } from "../dist/allowlist.js";
import { q8 } from "../dist/money.js";
import { effectiveBaseUrl } from "../dist/platforms.js";
import { parseModelSuspension } from "../dist/window.js";

test("wildcard matching is anchored and case-insensitive", () => {
  assert.ok(wildcardMatch("claude-*", "Claude-Sonnet-5"));
  assert.ok(wildcardMatch("*-mini", "gpt-5-mini"));
  assert.ok(wildcardMatch("gpt-*-mini", "gpt-5.5-mini"));
  assert.ok(!wildcardMatch("gpt-*-mini", "gpt-mini"));
  assert.ok(!wildcardMatch("claude", "claude-sonnet"));
  assert.ok(wildcardMatch("*", "anything"));
});

test("allowlist semantics", () => {
  assert.ok(isModelAllowed({ enabled: false, models: [] }, "x"));
  assert.ok(!isModelAllowed({ enabled: true, models: [] }, "x"));
  assert.ok(isModelAllowed({ enabled: true, models: ["gemini-*"] }, "models/gemini-3.5-flash"));
  assert.ok(matchesAny(["a", "b*"], "bee"));
  assert.ok(validateAllowlistInput({ enabled: true, models: [] }).error);
  assert.equal(validateAllowlistInput(null).value, null);
});

test("q8 rounds half away from zero to 8 decimals", () => {
  assert.equal(q8(0.000000005), 0.00000001);
  assert.equal(q8(-0.000000005), -0.00000001);
  assert.equal(q8(1.23456789123), 1.23456789);
  assert.equal(q8(NaN), 0);
});

test("effective base URL", () => {
  assert.equal(effectiveBaseUrl({ platform: "openai", type: "apikey", base_url: null }), "https://api.openai.com/v1");
  assert.equal(effectiveBaseUrl({ platform: "custom", type: "upstream", base_url: "https://x.io/v1/" }), "https://x.io/v1");
  assert.equal(effectiveBaseUrl({ platform: "custom", type: "upstream", base_url: null }), null);
  assert.equal(effectiveBaseUrl({ platform: "openai", type: "oauth", base_url: null }), "https://chatgpt.com/backend-api/codex");
});

test("parseModelSuspension: Anthropic per-model org suspension, direct and worker texts", () => {
  const direct = 'upstream 403: {"type":"error","error":{"type":"permission_error","message":"model: \\"claude-opus-5-5\\" is suspended for this organization until 2026-10-20T05:36:03Z"},"request_id":"req_x"}';
  assert.deepEqual(parseModelSuspension(direct), { model: "claude-opus-5-5", until: "2026-10-20T05:36:03Z" });
  const worker = 'Stream failed before its terminator: ccr_worker: Failed to authenticate. API Error: 403 model: "claude-sonnet-5-5" is suspended for this organization until 2026-10-20T05:36:04Z (after partial output)';
  assert.deepEqual(parseModelSuspension(worker), { model: "claude-sonnet-5-5", until: "2026-10-20T05:36:04Z" });
  assert.equal(parseModelSuspension("Failed to authenticate: OAuth token revoked"), null);
  assert.equal(parseModelSuspension(null), null);
  const noUntil = parseModelSuspension('model: "claude-opus-5-5" is suspended for this organization');
  assert.equal(noUntil?.model, "claude-opus-5-5");
  assert.ok(noUntil && noUntil.until > new Date().toISOString().slice(0, 19), "falls back to one hour from now");
});
