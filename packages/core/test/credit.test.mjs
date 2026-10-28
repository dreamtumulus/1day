// Credit billing (docs/data-model.md §4, migration 13): usage charges the prepaid balance first and
// then accrues to the credit line; admission compares limit − used + balance against 0; settling
// restores the line. Temp DATA_DIR, real migrations.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const dir = mkdtempSync(join(tmpdir(), "1dayapi-core-credit-"));
process.env.DATA_DIR = dir;
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));

const core = await import("../dist/index.js");
const { db, run, one, tx, settleRequest, setCreditLimit, settleCredit, creditSummary, availableUsd, newId, nowIso } = core;

const cols = new Set(db.prepare("PRAGMA table_info(users)").all().map((c) => c.name));
const now = nowIso();
function mkUser(name, balance = 0) {
  const id = newId();
  run("INSERT INTO users (id, role, name, login_key_hash, login_key_preview, status, balance_usd, created_at) VALUES (?, 'consumer', ?, ?, 'x', 'active', ?, ?)", id, name, `h-${id}`, balance, now);
  const gid = one("SELECT id FROM groups ORDER BY rowid LIMIT 1")?.id ?? (() => { run("INSERT INTO groups (id, name, created_at) VALUES ('g-test', 'test', ?)", now); return "g-test"; })();
  run("INSERT INTO api_keys (id, user_id, name, key_hash, key_preview, group_id, status, created_at) VALUES (?, ?, 'k', ?, 'p', ?, 'active', ?)", `k-${id}`, id, `kh-${id}`, gid, now);
  return id;
}
const charge = (userId, cost) => {
  // model price lookup is irrelevant here: feed the cost through computeCost by using a real model with known price
  // (claude-opus-5-5: $4/M input) → cost tokens so that actual == `cost` at multiplier 1.
  const tokens = Math.round(cost / 4e-6);
  return settleRequest({ requestId: newId(), userId, apiKeyId: `k-${userId}`, groupId: null, rateMultiplier: 1, accountId: null, providerId: null, payoutRate: 0,
    model: "claude-opus-5-5", upstreamModel: null, endpoint: "/v1/messages", stream: false, statusCode: 200, usage: { input_tokens: tokens, output_tokens: 0 }, usageEstimated: false });
};

test("migration 13: credit columns and credit_events exist", () => {
  assert.ok(cols.has("credit_limit_usd") && cols.has("credit_used_usd") && cols.has("credit_settled_at"));
  assert.ok(one("SELECT 1 FROM sqlite_master WHERE type='table' AND name='credit_events'"));
  assert.ok(one("SELECT 1 FROM schema_migrations WHERE version = 13"));
});

test("usage charges prepaid balance first, then the credit line; available = limit - used + balance", () => {
  const uid = mkUser("alice", 1); // $1 prepaid
  tx(() => setCreditLimit(uid, 10, { note: "trial" }));
  let s = creditSummary(uid);
  assert.equal(s.availableUsd, 11);
  charge(uid, 0.4); // from balance
  s = creditSummary(uid);
  assert.equal(s.balanceUsd, 0.6); assert.equal(s.creditUsedUsd, 0); assert.equal(s.availableUsd, 10.6);
  charge(uid, 1); // 0.6 from balance, 0.4 to credit
  s = creditSummary(uid);
  assert.equal(s.balanceUsd, 0); assert.equal(s.creditUsedUsd, 0.4); assert.equal(s.availableUsd, 9.6);
  charge(uid, 12); // overdraft allowed: the request already happened
  s = creditSummary(uid);
  assert.equal(s.creditUsedUsd, 12.4); assert.equal(s.availableUsd, -2.4, "admission would now reject (<= 0)");
  assert.equal(availableUsd({ credit_limit_usd: 10, credit_used_usd: 12.4, balance_usd: 0 }), -2.4);
});

test("settlement restores the line; partial and full; audit rows", () => {
  const uid = mkUser("bob");
  tx(() => setCreditLimit(uid, 50));
  charge(uid, 30);
  const part = tx(() => settleCredit(uid, 10, { note: "wire 1" }));
  assert.equal(part.settledUsd, 10); assert.equal(part.creditUsedUsd, 20); assert.equal(part.availableUsd, 30);
  assert.throws(() => tx(() => settleCredit(uid, 25)), /exceeds outstanding/);
  const full = tx(() => settleCredit(uid, null, { note: "wire 2" }));
  assert.equal(full.settledUsd, 20); assert.equal(full.creditUsedUsd, 0); assert.equal(full.availableUsd, 50);
  assert.ok(full.creditSettledAt);
  assert.throws(() => tx(() => settleCredit(uid, null)), /nothing to settle/);
  const events = db.prepare("SELECT kind, amount_usd, used_before, used_after, limit_after FROM credit_events WHERE user_id = ? ORDER BY rowid").all(uid);
  assert.deepEqual(events.map((e) => [e.kind, e.amount_usd, e.used_before, e.used_after, e.limit_after]), [
    ["limit_set", 50, 0, 0, 50],
    ["settlement", 10, 30, 20, 50],
    ["settlement", 20, 20, 0, 50],
  ]);
});

test("a user without a credit line behaves exactly as before (prepaid balance only)", () => {
  const uid = mkUser("carol", 2);
  charge(uid, 3);
  const s = creditSummary(uid);
  assert.equal(s.balanceUsd, -1, "overdraft lands on the balance when there is no line");
  assert.equal(s.creditUsedUsd, 0);
  assert.equal(s.availableUsd, -1);
});
