// X-57: a cache write is the caller's only when the caller asked for caching (cache_control somewhere in the request).
import test from "node:test";
import assert from "node:assert/strict";
import { requestAsksForCaching, requestCacheTier } from "../dist/ccr/translate.js";

test("no cache_control anywhere → not asked", () => {
  assert.equal(requestAsksForCaching({ messages: [{ role: "user", content: "hi" }] }), false);
  assert.equal(requestAsksForCaching({ system: "s", tools: [{ name: "t" }], messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] }), false);
  assert.equal(requestAsksForCaching(null), false);
});
test("a marker on a system / tool / message block, nested tool_result content, or top-level → asked", () => {
  const cc = { type: "ephemeral" };
  assert.equal(requestAsksForCaching({ system: [{ type: "text", text: "s", cache_control: cc }], messages: [] }), true);
  assert.equal(requestAsksForCaching({ tools: [{ name: "t", cache_control: cc }], messages: [] }), true);
  assert.equal(requestAsksForCaching({ messages: [{ role: "user", content: [{ type: "text", text: "a" }, { type: "text", text: "b", cache_control: { type: "ephemeral", ttl: "1h" } }] }] }), true);
  assert.equal(requestAsksForCaching({ messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "x", content: [{ type: "text", text: "r", cache_control: cc }] }] }] }), true);
  assert.equal(requestAsksForCaching({ cache_control: cc, messages: [] }), true);
});

test("the caller's tier: default ephemeral → 5m, any ttl 1h → 1h, no marker → null", () => {
  assert.equal(requestCacheTier({ messages: [{ role: "user", content: "hi" }] }), null);
  assert.equal(requestCacheTier({ messages: [{ role: "user", content: [{ type: "text", text: "a", cache_control: { type: "ephemeral" } }] }] }), "5m");
  assert.equal(requestCacheTier({ system: [{ type: "text", text: "s", cache_control: { type: "ephemeral", ttl: "5m" } }], messages: [{ role: "user", content: [{ type: "text", text: "a", cache_control: { type: "ephemeral", ttl: "1h" } }] }] }), "1h");
  assert.equal(requestCacheTier({ tools: [{ name: "t", cache_control: { type: "ephemeral", ttl: "1h" } }], messages: [] }), "1h");
});
