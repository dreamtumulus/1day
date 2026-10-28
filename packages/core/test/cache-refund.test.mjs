// Cache-rebuild refunds (docs/data-model.md §3 cache_refunds, migration 15): switched requests are
// marked at settlement, the excess over the no-switch price is computed from the price table, and a
// run pays `percent` of it back — credit line first, prepaid balance second — exactly once.
// Temp DATA_DIR, real migrations.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const dir = mkdtempSync(join(tmpdir(), "1dayapi-core-cache-refund-"));
process.env.DATA_DIR = dir;
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));

const core = await import("../dist/index.js");
const {
  db, run, one, all, tx, settleRequest, setCreditLimit, creditSummary, newId, nowIso, computeCost, setSetting,
  cacheExcessUsd, pendingCacheRefund, pendingCacheRefundAll, runCacheRefund, runCacheRefundsForAll,
  lastScheduledCacheRefundAt, markScheduledCacheRefundRun, nextScheduledCacheRefundAt, cacheRefundPercent,
} = core;

const MODEL = "claude-opus-5-5";
const entry = core.getModelEntry(MODEL);
assert.ok(entry, "catalog entry for the test model");
// Same per-M prices computeCost uses (catalog fallback on a fresh DB, model_prices row when present).
const price = { cache_read_per_m: entry.prices.cacheReadPerM, cache_write_per_m: entry.prices.cacheWritePerM };
assert.ok(price.cache_write_per_m > price.cache_read_per_m, "write price above read price");
const now = nowIso();

function mkUser(name, balance = 0) {
  const id = newId();
  run("INSERT INTO users (id, role, name, login_key_hash, login_key_preview, status, balance_usd, created_at) VALUES (?, 'consumer', ?, ?, 'x', 'active', ?, ?)", id, name, `h-${id}`, balance, now);
  const gid = one("SELECT id FROM groups ORDER BY rowid LIMIT 1")?.id ?? (() => { run("INSERT INTO groups (id, name, created_at) VALUES ('g-test', 'test', ?)", now); return "g-test"; })();
  run("INSERT INTO api_keys (id, user_id, name, key_hash, key_preview, group_id, status, created_at) VALUES (?, ?, 'k', ?, 'p', ?, 'active', ?)", `k-${id}`, id, `kh-${id}`, gid, now);
  return id;
}
/** One settled request; `switched` marks it like the gateway does after ForceCacheBilling (input already moved to cache_read). */
function req(userId, { cacheWrite = 0, cacheRead = 0, input = 0, output = 100, switched = false, multiplier = 1 } = {}) {
  const requestId = newId();
  const r = settleRequest({
    requestId, userId, apiKeyId: `k-${userId}`, groupId: null, rateMultiplier: multiplier, accountId: null, providerId: null, payoutRate: 0,
    model: MODEL, upstreamModel: null, endpoint: "/v1/messages", stream: false, statusCode: 200,
    usage: { input_tokens: input, output_tokens: output, cache_read_tokens: cacheRead, cache_write_tokens: cacheWrite }, usageEstimated: false,
    accountSwitched: switched,
  });
  return { requestId, ...r };
}
const r8 = (x) => Math.round(x * 1e8) / 1e8;

test("migration 15: columns, table, partial index", () => {
  const cols = new Set(db.prepare("PRAGMA table_info(usage_logs)").all().map((c) => c.name));
  assert.ok(cols.has("account_switched") && cols.has("cache_refund_id"));
  assert.ok(one("SELECT 1 FROM sqlite_master WHERE type='table' AND name='cache_refunds'"));
  assert.ok(one("SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_usage_cache_refund_pending'"));
  assert.ok(one("SELECT 1 FROM schema_migrations WHERE version = 15"));
  assert.equal(cacheRefundPercent(), 80, "default percent");
});

test("settlement writes account_switched only for successful switched requests", () => {
  const uid = mkUser("flag");
  const a = req(uid, { cacheWrite: 1000, switched: true });
  const b = req(uid, { cacheWrite: 1000, switched: false });
  assert.equal(one("SELECT account_switched FROM usage_logs WHERE request_id = ?", a.requestId).account_switched, 1);
  assert.equal(one("SELECT account_switched FROM usage_logs WHERE request_id = ?", b.requestId).account_switched, 0);
  const fail = settleRequest({ requestId: newId(), userId: uid, apiKeyId: `k-${uid}`, groupId: null, rateMultiplier: 1, accountId: null, providerId: null, payoutRate: 0,
    model: MODEL, upstreamModel: null, endpoint: "/v1/messages", stream: false, statusCode: 502, usage: { input_tokens: 0, output_tokens: 0 }, usageEstimated: false, accountSwitched: true });
  assert.equal(fail.actualCost, 0);
  assert.equal(all("SELECT 1 FROM usage_logs WHERE user_id = ? AND account_switched = 1", uid).length, 1, "failed rows never count");
});

test("excess = cache writes priced as writes minus the same tokens as reads, times the multiplier, capped at actual_cost", () => {
  const row = { id: "x", model: MODEL, input_tokens: 0, output_tokens: 500, cache_read_tokens: 20000, cache_write_tokens: 40000, rate_multiplier: 1.5, actual_cost: 10, created_at: now };
  const expected = r8(((price.cache_write_per_m - price.cache_read_per_m) * 40000 / 1e6) * 1.5);
  assert.equal(cacheExcessUsd(row), expected);
  assert.equal(cacheExcessUsd({ ...row, cache_write_tokens: 0 }), 0, "nothing rebuilt → nothing to refund");
  assert.equal(cacheExcessUsd({ ...row, actual_cost: 0.001 }), 0.001, "never more than what was charged");
  // Sanity: output tokens cancel out of the difference.
  const withOut = computeCost(MODEL, { input_tokens: 0, output_tokens: 500, cache_read_tokens: 20000, cache_write_tokens: 40000 });
  const ideal = computeCost(MODEL, { input_tokens: 0, output_tokens: 500, cache_read_tokens: 60000, cache_write_tokens: 0 });
  assert.equal(r8((withOut - ideal) * 1.5), expected);
});

test("run: prepaid user gets 80% of the excess on the balance, rows are bound, second run is a no-op", () => {
  const uid = mkUser("prepaid", 50);
  req(uid, { cacheWrite: 100000, switched: true });
  req(uid, { cacheWrite: 50000, cacheRead: 30000, switched: true });
  req(uid, { cacheWrite: 70000, switched: false }); // ordinary request, untouched
  const spent = one("SELECT SUM(actual_cost) AS c FROM usage_logs WHERE user_id = ?", uid).c;
  const pend = pendingCacheRefund(uid);
  assert.equal(pend.rows, 2);
  const excess = r8((price.cache_write_per_m - price.cache_read_per_m) * 150000 / 1e6);
  assert.equal(pend.excessUsd, excess);
  assert.equal(pend.refundUsd, r8(excess * 0.8));
  assert.ok(pend.from && pend.to);

  const r = runCacheRefund(uid, { createdBy: "scheduler" });
  assert.ok(r);
  assert.equal(r.rows, 2);
  assert.equal(r.percent, 80);
  assert.equal(r.refund_usd, pend.refundUsd);
  assert.equal(r.to_credit_usd, 0);
  assert.equal(r.to_balance_usd, pend.refundUsd);
  assert.ok(r.ledger_id && !r.credit_event_id);
  const led = one("SELECT * FROM ledger WHERE id = ?", r.ledger_id);
  assert.equal(led.kind, "cache_refund");
  assert.equal(led.amount_usd, pend.refundUsd);
  assert.equal(led.ref, r.id);
  assert.equal(one("SELECT balance_usd FROM users WHERE id = ?", uid).balance_usd, r8(50 - spent + pend.refundUsd));
  assert.equal(all("SELECT 1 FROM usage_logs WHERE user_id = ? AND cache_refund_id = ?", uid, r.id).length, 2);
  assert.equal(pendingCacheRefund(uid).rows, 0);
  assert.equal(runCacheRefund(uid), null, "nothing pending → no row, no money");
  assert.equal(all("SELECT 1 FROM cache_refunds WHERE user_id = ?", uid).length, 1);
});

test("run: credit-line user is refunded against outstanding usage first, overflow goes to balance", () => {
  const uid = mkUser("credit", 0);
  tx(() => setCreditLimit(uid, 100));
  req(uid, { cacheWrite: 200000, switched: true, multiplier: 2 });
  const s0 = creditSummary(uid);
  assert.ok(s0.creditUsedUsd > 0 && s0.balanceUsd === 0);
  const pend = pendingCacheRefund(uid);
  assert.equal(pend.excessUsd, r8((price.cache_write_per_m - price.cache_read_per_m) * 200000 / 1e6 * 2));
  const r = runCacheRefund(uid, { createdBy: "admin-1", note: "manual" });
  assert.equal(r.to_credit_usd, pend.refundUsd, "whole refund fits in the outstanding usage");
  assert.equal(r.to_balance_usd, 0);
  assert.ok(r.credit_event_id && !r.ledger_id);
  const ev = one("SELECT * FROM credit_events WHERE id = ?", r.credit_event_id);
  assert.equal(ev.kind, "cache_refund");
  assert.equal(ev.amount_usd, pend.refundUsd);
  assert.equal(ev.created_by, "admin-1");
  assert.equal(ev.note, "manual");
  const s1 = creditSummary(uid);
  assert.equal(s1.creditUsedUsd, r8(s0.creditUsedUsd - pend.refundUsd));
  assert.equal(s1.creditSettledAt, null, "a refund is not a settlement");

  // Outstanding smaller than the refund: the remainder lands on the prepaid balance.
  const uid2 = mkUser("credit-small", 0);
  tx(() => setCreditLimit(uid2, 100));
  req(uid2, { cacheWrite: 100000, switched: true });
  const used = creditSummary(uid2).creditUsedUsd;
  tx(() => core.settleCredit(uid2, used - 0.001)); // user already paid almost everything
  const r2 = runCacheRefund(uid2);
  assert.equal(r2.to_credit_usd, 0.001);
  assert.equal(r2.to_balance_usd, r8(r2.refund_usd - 0.001));
  assert.ok(r2.credit_event_id && r2.ledger_id);
  assert.equal(creditSummary(uid2).creditUsedUsd, 0);
});

test("percent 0 still closes the pending rows without moving money; percent setting is honoured", () => {
  const uid = mkUser("zero", 5);
  req(uid, { cacheWrite: 10000, switched: true });
  const r = runCacheRefund(uid, { percent: 0 });
  assert.equal(r.refund_usd, 0);
  assert.equal(r.ledger_id, null);
  assert.equal(pendingCacheRefund(uid).rows, 0);

  setSetting("cache_refund_percent", "50");
  assert.equal(cacheRefundPercent(), 50);
  const uid2 = mkUser("half", 5);
  req(uid2, { cacheWrite: 10000, switched: true });
  const p = pendingCacheRefund(uid2);
  assert.equal(p.percent, 50);
  const r2 = runCacheRefund(uid2);
  assert.equal(r2.percent, 50);
  assert.equal(r2.refund_usd, r8(p.excessUsd * 0.5));
  setSetting("cache_refund_percent", "80");
});

test("run for all users + scheduler bookkeeping", () => {
  const a = mkUser("all-a", 10);
  const b = mkUser("all-b", 10);
  req(a, { cacheWrite: 10000, switched: true });
  req(b, { cacheWrite: 20000, switched: true });
  req(b, { cacheWrite: 20000, switched: true });
  const allPending = pendingCacheRefundAll();
  assert.ok(allPending.users >= 2 && allPending.rows >= 3);
  const s = runCacheRefundsForAll({ createdBy: "scheduler" });
  assert.ok(s.users >= 2);
  assert.equal(pendingCacheRefundAll().rows, 0);
  assert.equal(s.refundUsd, r8(s.toCreditUsd + s.toBalanceUsd));

  assert.equal(lastScheduledCacheRefundAt(), null);
  const before = Date.now();
  assert.ok(Date.parse(nextScheduledCacheRefundAt()) <= before + 2000, "never ran → due now");
  markScheduledCacheRefundRun("2026-10-21T00:00:00Z");
  assert.equal(lastScheduledCacheRefundAt(), "2026-10-21T00:00:00Z");
  assert.equal(nextScheduledCacheRefundAt(), "2026-10-22T00:00:00Z");
  assert.ok(!("cache_refund_last_run_at" in core.getSettings()), "bookkeeping key is not an admin setting");
});
