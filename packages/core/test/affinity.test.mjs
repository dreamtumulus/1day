// Affinity bindings (migration 16): the gateway's sticky-session / device-pool maps written
// through to SQLite so a blue/green release keeps conversations and devices on their accounts.
// Temp DATA_DIR, real migrations.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const dir = mkdtempSync(join(tmpdir(), "1dayapi-core-affinity-"));
process.env.DATA_DIR = dir;
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));

const {
  one, loadStickyBinding, saveStickyBinding, loadDeviceBinding, saveDeviceBinding,
  sweepAffinityBindings, countAffinityBindings, clearAffinityBindings,
  loadTurnMemory, saveTurnMemory, deleteTurnMemory,
} = await import("../dist/index.js");

test("migrations 16/17 created the tables", () => {
  assert.equal(one("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='affinity_bindings'")?.ok, 1);
  assert.equal(one("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='worker_turn_memory'")?.ok, 1);
  assert.ok(one("SELECT 1 AS ok FROM schema_migrations WHERE version = 17"));
});

test("worker turn memory: opaque JSON round-trips, expires, deletes, is swept and counted", () => {
  clearAffinityBindings();
  const now = Date.now();
  const mem = { hashes: ["a", "b"], assistantFold: "[assistant]\nhi", turn: 2, usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 }, pendingCalls: [{ toolUseId: "t", callId: "c", name: "n" }], expiresAt: now + 1000 };
  saveTurnMemory("k1", mem, mem.expiresAt);
  assert.deepEqual(loadTurnMemory("k1", now), mem);
  assert.equal(loadTurnMemory("k1", now + 1001), undefined, "expired reads as missing");
  saveTurnMemory("k2", { turn: 1 }, now - 1);
  assert.equal(countAffinityBindings(now).turn, 1);
  assert.equal(sweepAffinityBindings(now), 1, "only the expired one is swept");
  deleteTurnMemory("k1");
  assert.equal(loadTurnMemory("k1", now), undefined);
  assert.equal(one("SELECT COUNT(*) AS n FROM worker_turn_memory").n, 0);
});

test("sticky: save, load, overwrite, expire", () => {
  clearAffinityBindings();
  const now = Date.now();
  assert.equal(loadStickyBinding("s:k:1", now), undefined);
  saveStickyBinding("s:k:1", "acc-a", now + 60_000);
  assert.deepEqual(loadStickyBinding("s:k:1", now), { accountId: "acc-a", expiresAt: now + 60_000 });
  saveStickyBinding("s:k:1", "acc-b", now + 120_000);
  assert.equal(loadStickyBinding("s:k:1", now).accountId, "acc-b", "upsert replaces the account");
  assert.equal(loadStickyBinding("s:k:1", now + 120_001), undefined, "expired bindings read as missing");
  assert.equal(loadDeviceBinding("s:k:1", now), undefined, "kind is part of the lookup");
});

test("device pool: save, load, bad JSON is ignored", () => {
  clearAffinityBindings();
  const now = Date.now();
  saveDeviceBinding("d:k:dev", ["a", "b"], now + 60_000);
  assert.deepEqual(loadDeviceBinding("d:k:dev", now), { accounts: ["a", "b"], expiresAt: now + 60_000 });
  saveDeviceBinding("d:k:dev", ["a", "b", "c"], now + 60_000);
  assert.deepEqual(loadDeviceBinding("d:k:dev", now).accounts, ["a", "b", "c"]);
  assert.equal(loadStickyBinding("d:k:dev", now), undefined);
});

test("sweep removes only expired rows; counts are per kind", () => {
  clearAffinityBindings();
  const now = Date.now();
  saveStickyBinding("s:1", "a", now - 1);
  saveStickyBinding("s:2", "a", now + 1000);
  saveDeviceBinding("d:1", ["a"], now - 1);
  saveDeviceBinding("d:2", ["a"], now + 1000);
  assert.deepEqual(countAffinityBindings(now), { session: 1, device: 1, turn: 0 });
  assert.equal(sweepAffinityBindings(now), 2);
  assert.equal(one("SELECT COUNT(*) AS n FROM affinity_bindings").n, 2);
  assert.equal(sweepAffinityBindings(now), 0);
});
