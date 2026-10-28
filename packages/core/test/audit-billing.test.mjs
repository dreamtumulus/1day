import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
const dir = mkdtempSync(join(tmpdir(), "1dayapi-audit-billing-"));
process.env.DATA_DIR = dir;
after(() => rmSync(dir, { recursive: true, force: true }));
const c = await import("../dist/index.js");
const model = "claude-opus-5-5";
function user(balance = 10, quota = 0) {
  const id = c.newId(), key = c.newId();
  c.run("INSERT INTO users(id,role,name,login_key_hash,login_key_preview,balance_usd) VALUES (?,'consumer',? ,?,'p',?)", id, id, id, balance);
  c.run("INSERT INTO api_keys(id,user_id,name,key_hash,key_preview,group_id,quota_usd) VALUES (?,?,'k',?,'p','default',?)", key, id, key, quota);
  return { id, key };
}
function input(u, extra = {}) {
  return { requestId: c.newId(), userId: u.id, apiKeyId: u.key, groupId: "default", rateMultiplier: 1,
    accountId: null, providerId: null, payoutRate: 0, model, upstreamModel: model, endpoint: "/v1/messages",
    stream: false, statusCode: 200, usage: { input_tokens: 100, output_tokens: 20 }, usageEstimated: false, ...extra };
}

test("invalid counts and nonfinite rates never create or reverse a charge", () => {
  const u = user();
  for (const value of [-1, NaN, Infinity, 1.5, "20", 1_000_000_001]) {
    const p = input(u, { usage: { input_tokens: value, output_tokens: 1 } });
    assert.throws(() => c.settleRequest(p), /invalid usage count/);
    assert.equal(c.one("SELECT 1 FROM usage_logs WHERE request_id=?", p.requestId), undefined);
  }
  for (const rateMultiplier of [NaN, Infinity, -1]) assert.throws(() => c.settleRequest(input(u, { rateMultiplier })), RangeError);
  assert.throws(() => c.settleRequest(input(u, { payoutRate: 1.1 })), RangeError);
  assert.throws(() => c.settleRequest(input(u, { usage: { input_tokens: 900_000_000, output_tokens: 0, cache_read_tokens: 900_000_000 } })), RangeError);
  assert.equal(c.one("SELECT used_usd FROM api_keys WHERE id=?", u.key).used_usd, 0);
  assert.equal(c.one("SELECT balance_usd FROM users WHERE id=?", u.id).balance_usd, 10);
});

test("only a duplicate request id is ignored; other SQLite constraints surface", () => {
  const u = user(), p = input(u);
  const settled = c.settleRequest(p);
  assert.ok(settled.settled);
  assert.equal(c.settleRequest(p).settled, false);
  const bad = input(u, { userId: null });
  assert.throws(() => c.settleRequest(bad), /NOT NULL/);
  assert.equal(c.one("SELECT 1 FROM usage_logs WHERE request_id=?", bad.requestId), undefined);
  assert.equal(c.one("SELECT COUNT(*) AS n FROM usage_logs WHERE user_id=?", u.id).n, 1);
});

test("durable retry survives a settlement fault and keeps the original tariff exactly once", () => {
  const u = user(), p = input(u);
  const expected = c.q8(c.computeCost(model, p.usage));
  c.db.exec("CREATE TRIGGER injected_accounting_failure BEFORE INSERT ON usage_logs BEGIN SELECT RAISE(FAIL,'injected temporary accounting failure'); END");
  const queued = c.settleRequestDurably(p);
  assert.equal(queued.pending, true);
  assert.equal(c.settlementHealthy(), false);
  assert.equal(readdirSync(join(dir, "settlement-journal")).filter(x => x.endsWith(".json")).length, 1);
  assert.equal(c.one("SELECT used_usd FROM api_keys WHERE id=?", u.key).used_usd, 0);
  c.db.exec("DROP TRIGGER injected_accounting_failure");
  c.run("INSERT INTO model_prices(model_id,platform,input_per_m,output_per_m,cache_read_per_m,cache_write_per_m,enabled) VALUES (?,'anthropic',1000,1000,1000,1000,1)", model);
  try {
    assert.equal(c.retryPendingSettlements(), 0);
    assert.equal(c.one("SELECT actual_cost FROM usage_logs WHERE request_id=?", p.requestId).actual_cost, expected);
    assert.equal(c.one("SELECT used_usd FROM api_keys WHERE id=?", u.key).used_usd, expected);
    assert.equal(c.retryPendingSettlements(), 0);
    assert.equal(c.one("SELECT used_usd FROM api_keys WHERE id=?", u.key).used_usd, expected);
    assert.equal(readdirSync(join(dir, "settlement-journal")).filter(x => x.endsWith(".json")).length, 0);
  } finally { c.run("DELETE FROM model_prices WHERE model_id=?", model); }
});

test("aliases share disabled policy, canonical pricing and explicit allowlists", () => {
  c.run("INSERT INTO model_prices(model_id,platform,input_per_m,output_per_m,cache_read_per_m,cache_write_per_m,enabled) VALUES (?,'anthropic',2,3,0.2,2.5,0)", model);
  try {
    for (const alias of [model, "claude-opus-5.5", "claude-opus-5-5-20261001", "claude-opus-5.5-20261001"]) {
      assert.equal(c.getModelEntry(alias).enabled, false, alias);
      assert.equal(c.getModelEntry(alias).prices.inputPerM, 2, alias);
      assert.equal(c.computeCost(alias, { input_tokens: 1_000_000, output_tokens: 0 }), 2, alias);
      assert.equal(c.isModelAllowed({ enabled: true, models: [model] }, alias), true, alias);
    }
  } finally { c.run("DELETE FROM model_prices WHERE model_id=?", model); }
});

test("new refund snapshots keep historical excess after price changes", () => {
  const u = user(), p = input(u, { accountSwitched: true, usage: { input_tokens: 0, output_tokens: 20, cache_write_tokens: 1000 } });
  c.settleRequest(p);
  const before = c.pendingCacheRefund(u.id);
  assert.ok(before.excessUsd > 0);
  c.run("INSERT INTO model_prices(model_id,platform,input_per_m,output_per_m,cache_read_per_m,cache_write_per_m,enabled) VALUES (?,'anthropic',1000,1000,1000,1000,1)", model);
  try { assert.equal(c.pendingCacheRefund(u.id).excessUsd, before.excessUsd); }
  finally { c.run("DELETE FROM model_prices WHERE model_id=?", model); }
  const legacy = input(u, { accountSwitched: true });
  c.settleRequest(legacy);
  c.run("DELETE FROM usage_pricing_snapshots WHERE request_id=?", legacy.requestId);
  assert.equal(c.pendingCacheRefund(u.id).rows, 1, "historic rows without a snapshot remain untouched");
  c.runCacheRefund(u.id);
  assert.equal(c.one("SELECT cache_refund_id FROM usage_logs WHERE request_id=?", legacy.requestId).cache_refund_id, null);
});

test("in-flight budget is shared across Keys, obeys funds and quota, and recovers expired leases", () => {
  const u = user(1, 1);
  const a = c.newId(), b = c.newId();
  assert.equal(c.acquireRequestBudget(a, u.id, u.key, 0.6), true);
  assert.equal(c.acquireRequestBudget(b, u.id, u.key, 0.6), false);
  c.releaseRequestBudget(a);
  assert.equal(c.acquireRequestBudget(b, u.id, u.key, 20), true, "one postpaid call with low balance is still admitted");
  assert.equal(c.acquireRequestBudget(c.newId(), u.id, u.key, 0.001), false);
  c.run("UPDATE gateway_request_budgets SET expires_at=0 WHERE request_id=?", b);
  assert.throws(() => c.renewRequestBudget(b), /lease lost/, "an expired owner cannot revive its reservation");
  const next = c.newId();
  assert.equal(c.acquireRequestBudget(next, u.id, u.key, 0.2), true);
  c.renewRequestBudget(next);
  assert.ok(c.one("SELECT expires_at FROM gateway_request_budgets WHERE request_id=?", next).expires_at > Date.now() + 80_000);
  c.releaseRequestBudget(next);
  assert.throws(() => c.renewRequestBudget(next), /lease lost/, "missing reservations fence the original call");
  const rich = user(1000);
  const ids = Array.from({ length: 4 }, () => c.newId());
  for (const id of ids) assert.equal(c.acquireRequestBudget(id, rich.id, rich.key, 0.1), true);
  assert.equal(c.acquireRequestBudget(c.newId(), rich.id, rich.key, 0.1), false, "default concurrency four");
  for (const id of ids) c.releaseRequestBudget(id);
});

test("journal storage failure closes admission and never reports a successful unrecorded charge", () => {
  const u = user(), p = input(u);
  const path = join(dir, "settlement-journal"), backup = path + "-saved";
  renameSync(path, backup);
  writeFileSync(path, "filesystem fault fixture");
  try {
    assert.throws(() => c.settleRequestDurably(p));
    assert.equal(c.settlementHealthy(), false);
    assert.equal(c.one("SELECT 1 FROM usage_logs WHERE request_id=?", p.requestId), undefined);
  } finally {
    unlinkSync(path);
    renameSync(backup, path);
  }
  assert.equal(c.retryPendingSettlements(), 0);
  assert.equal(c.settlementHealthy(), true);
});

test("stored alias overrides cannot advertise enabled access; unknown custom dotted IDs survive", () => {
  const insert = c.db.prepare("INSERT INTO model_prices(model_id,platform,input_per_m,output_per_m,cache_read_per_m,cache_write_per_m,enabled) VALUES (?,'anthropic',2,3,0.2,2.5,?)");
  insert.run(model, 0);
  insert.run("claude-opus-5.5", 1);
  insert.run("claude-custom-123.4", 1);
  try {
    const alias = c.listRegistry().find(e => e.modelId === "claude-opus-5.5");
    assert.equal(alias.enabled, false);
    assert.equal(c.publicModels().some(e => e.modelId === "claude-opus-5.5"), false);
    assert.equal(c.getModelEntry("claude-custom-123.4").enabled, true);
    assert.equal(c.getModelEntry("claude-custom-123.4").upstreamModelId, undefined);
    assert.equal(c.computeCost("claude-custom-123.4", { input_tokens: 1_000_000, output_tokens: 0 }), 2);
  } finally { c.run("DELETE FROM model_prices WHERE model_id IN (?,?,?)", model, "claude-opus-5.5", "claude-custom-123.4"); }
});
