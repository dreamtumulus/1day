// Device affinity (proxy.ts, 2026-10-19): a client device's recent accounts rank right
// after the sticky account. Pure ordering logic against dist/proxy.js — isolate DATA_DIR
// because the module pulls in @1dayapi/core (opens the DB on import).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";

const dir = mkdtempSync(join(tmpdir(), "1dayapi-gw-affinity-"));
process.env.DATA_DIR = dir;
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));

const { deviceIdFromMetadata, deviceKey, forgetAffinityMemoryForTests, orderByAffinity, rememberDevice, rememberStickyForTests, resetAffinityForTests, stickyKey } = await import("../dist/proxy.js");
const { NODE_MACHINE_HEADERS, anthropicFingerprintHeaders, loadTurnMemory, saveTurnMemory, deleteTurnMemory } = await import("@1dayapi/core");
const { SessionMemory, planTurn, blockHash } = await import("../dist/ccr/session-memory.js");

const DEV = "a".repeat(64);
const cands = (...ids) => ids.map((id) => ({ id }));
const ids = (list) => list.map((c) => c.id);
const caller = { apiKeyId: "key1" };

test("device id: JSON form, legacy form, garbage", () => {
  assert.equal(deviceIdFromMetadata(JSON.stringify({ device_id: DEV.toUpperCase(), session_id: "s" })), DEV);
  assert.equal(deviceIdFromMetadata(`user_${DEV}_account_x_session_y`), DEV);
  assert.equal(deviceIdFromMetadata(JSON.stringify({ device_id: "short" })), null);
  assert.equal(deviceIdFromMetadata("not json"), null);
  assert.equal(deviceIdFromMetadata(undefined), null);
  assert.equal(deviceKey(caller, { metadata: { user_id: JSON.stringify({ device_id: DEV }) } }), `d:key1:${DEV}`);
  assert.equal(deviceKey(caller, {}), null);
});

test("ordering: sticky first, then the device's accounts in recorded order, then the rest", () => {
  resetAffinityForTests();
  const dk = `d:key1:${DEV}`;
  rememberDevice(dk, "b");
  rememberDevice(dk, "d");
  assert.deepEqual(ids(orderByAffinity(cands("a", "b", "c", "d", "e"), null, dk)), ["b", "d", "a", "c", "e"]);
  rememberStickyForTests("s:key1:sess", "c");
  assert.deepEqual(ids(orderByAffinity(cands("a", "b", "c", "d", "e"), "s:key1:sess", dk)), ["c", "b", "d", "a", "e"]);
  // no device key / unknown device → plain sticky ordering
  assert.deepEqual(ids(orderByAffinity(cands("a", "b", "c"), "s:key1:sess", null)), ["c", "a", "b"]);
  assert.deepEqual(ids(orderByAffinity(cands("a", "b", "c"), null, "d:key1:" + "f".repeat(64))), ["a", "b", "c"]);
});

test("pool is bounded: overflow accounts are not remembered; expiry forgets the pool", () => {
  resetAffinityForTests();
  const dk = `d:key1:${DEV}`;
  for (const id of ["a", "b", "c", "d", "e"]) rememberDevice(dk, id); // default pool size 3
  assert.deepEqual(ids(orderByAffinity(cands("e", "d", "c", "b", "a"), null, dk)), ["a", "b", "c", "e", "d"]);
  const later = Date.now() + 3 * 3600 * 1000; // past the 2 h default TTL
  assert.deepEqual(ids(orderByAffinity(cands("e", "d", "c", "b", "a"), null, dk, later)), ["e", "d", "c", "b", "a"]);
  // candidates the pool knows but that are absent (busy / cooling) are simply skipped
  assert.deepEqual(ids(orderByAffinity(cands("x", "c", "y"), null, dk)), ["c", "x", "y"]);
});

test("bindings survive a gateway restart: the new process reads what the old one wrote", () => {
  resetAffinityForTests();
  const dk = `d:key1:${DEV}`;
  rememberDevice(dk, "b");
  rememberDevice(dk, "d");
  rememberStickyForTests("s:key1:sess", "c");
  forgetAffinityMemoryForTests(); // blue/green: fresh process, same DB
  assert.deepEqual(ids(orderByAffinity(cands("a", "b", "c", "d", "e"), "s:key1:sess", dk)), ["c", "b", "d", "a", "e"]);
  // the restored pool keeps growing from where it was (size 3 → one more slot)
  rememberDevice(dk, "e");
  forgetAffinityMemoryForTests();
  assert.deepEqual(ids(orderByAffinity(cands("a", "b", "c", "d", "e"), null, dk)), ["b", "d", "e", "a", "c"]);
  rememberDevice(dk, "a"); // pool full → not remembered
  forgetAffinityMemoryForTests();
  assert.deepEqual(ids(orderByAffinity(cands("a", "b", "c", "d", "e"), null, dk)), ["b", "d", "e", "a", "c"]);
  // expiry applies to the stored copy too
  const later = Date.now() + 3 * 3600 * 1000;
  assert.deepEqual(ids(orderByAffinity(cands("e", "d", "b"), "s:key1:sess", dk, later)), ["e", "d", "b"]);
});

test("worker turn memory survives a gateway restart through the core store", () => {
  const mk = () => new SessionMemory(60_000, 20_000, { load: (k, now) => loadTurnMemory(k, now), save: (k, e) => saveTurnMemory(k, e, e.expiresAt), delete: (k) => deleteTurnMemory(k) });
  const t = (text) => ({ type: "text", text });
  const old = mk();
  old.remember("rk", { hashes: [t("[user]\nq1")].map(blockHash), assistantFold: "[assistant]\na1", turn: 1, usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } });
  const fresh = mk(); // new instance, empty cache, same DB
  const mem = fresh.get("rk");
  assert.equal(mem?.turn, 1);
  assert.equal(mem?.usage?.input_tokens, 10, "usage baseline comes back, so the continued turn bills only the increment");
  assert.equal(planTurn(mem, [t("[user]\nq1"), t("[assistant]\na1"), t("[user]\nq2")]).mode, "continue");
  fresh.forget("rk");
  assert.equal(mk().get("rk"), undefined);
});

test("direct path reports the node machine, whatever the client machine says", () => {
  const h = anthropicFingerprintHeaders({
    "user-agent": "claude-cli/2.1.303 (external, cli)",
    "x-stainless-os": "Darwin",
    "x-stainless-arch": "arm64",
    "x-stainless-runtime": "node",
    "x-stainless-runtime-version": "v24.1.0",
    "x-stainless-package-version": "0.129.0",
  });
  for (const [k, v] of Object.entries(NODE_MACHINE_HEADERS)) assert.equal(h[k], v, k);
  assert.equal(h["user-agent"], "claude-cli/2.1.303 (external, cli)", "client UA still passes through");
  assert.equal(h["x-stainless-package-version"], "0.129.0", "SDK version stays the client's");
  assert.equal(h["x-stainless-os"], "Linux");
  assert.equal(h["x-stainless-arch"], "x64");
});

test("sticky binding is per session × model: a Sonnet side task cannot move the Opus session", () => {
  const req = { headers: { "user-agent": "claude-cli/2.1.303 (external, cli)" }, ip: "1.2.3.4" };
  const meta = { user_id: JSON.stringify({ device_id: DEV, session_id: "11111111-2222-3333-4444-555555555555" }) };
  const opus = stickyKey(caller, { model: "claude-opus-5-5", metadata: meta, messages: [] }, req);
  const sonnet = stickyKey(caller, { model: "claude-sonnet-5", metadata: meta, messages: [] }, req);
  assert.ok(opus && sonnet && opus !== sonnet);
  assert.equal(stickyKey(caller, { model: "claude-opus-5-5", metadata: meta, messages: [] }, req), opus, "same session + model → same key");
  // cacheable-prefix and fingerprint forms also carry the model
  const body = (model) => ({ model, system: [{ type: "text", text: "sys", cache_control: { type: "ephemeral" } }], messages: [{ role: "user", content: "hi" }] });
  assert.notEqual(stickyKey(caller, body("claude-opus-5-5"), req), stickyKey(caller, body("claude-haiku-5-5"), req));
});

test("stickyKey: cache_control on trailing messages (opencode) does not change the key between turns; root breakpoints do", async () => {
  const { stickyKey } = await import("../dist/proxy.js");
  const caller = { apiKeyId: "key-1" };
  const req = { headers: { "user-agent": "opencode/1.2.3" }, ip: "10.0.0.1" };
  const cc = { type: "ephemeral" };
  const sys = [{ type: "text", text: "You are a helper", cache_control: cc }];
  const turn1 = { model: "claude-opus-4-7", system: sys, messages: [{ role: "user", content: [{ type: "text", text: "fix nginx", cache_control: cc }] }] };
  const turn2 = {
    model: "claude-opus-4-7",
    system: sys,
    messages: [
      { role: "user", content: [{ type: "text", text: "fix nginx" }] },
      { role: "assistant", content: [{ type: "text", text: "ok", cache_control: cc }] },
      { role: "user", content: [{ type: "text", text: "now reload", cache_control: cc }] },
    ],
  };
  const turn3 = { ...turn2, messages: [...turn2.messages, { role: "assistant", content: "done" }, { role: "user", content: [{ type: "text", text: "check cert", cache_control: cc }] }] };
  const k1 = stickyKey(caller, turn1, req);
  assert.ok(k1.startsWith("c:"));
  assert.equal(stickyKey(caller, turn2, req), k1, "moving breakpoints on later turns are ignored");
  assert.equal(stickyKey(caller, turn3, req), k1);
  // A different conversation root (first user message) is a different key; so is a different system prompt.
  assert.notEqual(stickyKey(caller, { ...turn1, messages: [{ role: "user", content: [{ type: "text", text: "other task", cache_control: cc }] }] }, req), k1);
  assert.notEqual(stickyKey(caller, { ...turn1, system: [{ type: "text", text: "You are strict", cache_control: cc }] }, req), k1);
  // No breakpoints at all → fingerprint path, still stable across turns.
  const plain = (msgs) => ({ model: "claude-opus-4-7", system: "sys", messages: msgs });
  const f1 = stickyKey(caller, plain([{ role: "user", content: "q1" }]), req);
  assert.ok(f1.startsWith("f:"));
  assert.equal(stickyKey(caller, plain([{ role: "user", content: "q1" }, { role: "assistant", content: "a1" }, { role: "user", content: "q2" }]), req), f1);
});
