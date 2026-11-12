// X-55: acquireRequestBudgetDetailed says why a request was not admitted; the boolean acquireRequestBudget decides the same.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
const dir = mkdtempSync(join(tmpdir(), "1dayapi-admission-"));
process.env.DATA_DIR = dir;
delete process.env.USER_MAX_INFLIGHT;
delete process.env.USER_MAX_INFLIGHT_USD;
after(() => rmSync(dir, { recursive: true, force: true }));
const c = await import("../dist/index.js");

function user({ balance = 10, quota = 0, used = 0, maxInflight = null, maxInflightUsd = null } = {}) {
  const id = c.newId(), key = c.newId();
  c.run("INSERT INTO users(id,role,name,login_key_hash,login_key_preview,balance_usd,max_inflight,max_inflight_usd) VALUES (?,'consumer',?,?,'p',?,?,?)", id, id, id, balance, maxInflight, maxInflightUsd);
  c.run("INSERT INTO api_keys(id,user_id,name,key_hash,key_preview,group_id,quota_usd,used_usd) VALUES (?,?,'k',?,'p','default',?,?)", key, id, key, quota, used);
  return { id, key };
}
const acquire = (u, usd) => c.acquireRequestBudgetDetailed(c.newId(), u.id, u.key, usd);

test("admitted: ok, and the same request id is admitted again without a second reservation", () => {
  const u = user();
  const id = c.newId();
  assert.deepEqual(c.acquireRequestBudgetDetailed(id, u.id, u.key, 1), { ok: true });
  assert.deepEqual(c.acquireRequestBudgetDetailed(id, u.id, u.key, 1), { ok: true });
  assert.equal(c.one("SELECT COUNT(*) AS n FROM gateway_request_budgets WHERE user_id = ?", u.id).n, 1);
});

test("insufficient_funds: no balance and no credit left (also an unknown user / key)", () => {
  const r = acquire(user({ balance: 0 }), 0.01);
  assert.deepEqual([r.ok, r.reason, r.availableUsd, r.inFlight], [false, "insufficient_funds", 0, null]);
  assert.equal(c.acquireRequestBudgetDetailed(c.newId(), "nobody", "nokey", 0.01).reason, "insufficient_funds");
});

test("key_quota_exhausted: the key's quota is used up", () => {
  const r = acquire(user({ quota: 5, used: 5 }), 0.01);
  assert.deepEqual([r.ok, r.reason, r.keyRemainingUsd, r.availableUsd], [false, "key_quota_exhausted", 0, 10]);
});

test("concurrency_cap: the user's in-flight requests reached max_inflight, with the numbers", () => {
  const u = user({ maxInflight: 2 });
  assert.equal(acquire(u, 0.1).ok, true);
  assert.equal(acquire(u, 0.1).ok, true);
  const r = acquire(u, 0.1);
  assert.deepEqual([r.ok, r.reason, r.inFlight, r.maxInflight, r.reservedUsd, r.capUsd, r.capIsBalance], [false, "concurrency_cap", 2, 2, 0.2, 10, true]);
  assert.equal(c.acquireRequestBudget(c.newId(), u.id, u.key, 0.1), false, "the boolean caller sees the same decision");
  assert.equal(c.one("SELECT COUNT(*) AS n FROM gateway_request_budgets WHERE user_id = ?", u.id).n, 2, "a refusal reserves nothing");
});

test("rate_cap (X-72): admitted requests in the last 60 s reached max_rpm; refusals and other users do not count", () => {
  c.resetRequestRateWindows();
  const u = user({ maxInflight: 1 });
  c.run("UPDATE users SET max_rpm = 2 WHERE id = ?", u.id);
  const first = c.newId();
  assert.equal(c.acquireRequestBudgetDetailed(first, u.id, u.key, 0.1).ok, true);
  assert.equal(acquire(u, 0.1).reason, "concurrency_cap", "an in-flight refusal is not an admitted request");
  c.releaseRequestBudget(first);
  assert.equal(acquire(u, 0.1).ok, true, "second admitted request of the minute");
  c.run("DELETE FROM gateway_request_budgets WHERE user_id = ?", u.id);
  const r = acquire(u, 0.1);
  assert.deepEqual([r.ok, r.reason, r.rpm, r.maxRpm, r.inFlight, r.availableUsd], [false, "rate_cap", 2, 2, null, 10]);
  assert.equal(acquire(user(), 0.1).ok, true, "another user has its own window");
  const uncapped = user();
  for (let i = 0; i < 5; i++) { const id = c.newId(); assert.equal(c.acquireRequestBudgetDetailed(id, uncapped.id, uncapped.key, 0.1).ok, true); c.releaseRequestBudget(id); }
  c.resetRequestRateWindows();
});

test("reserved_spending_cap: in-flight requests reserve the whole balance (capIsBalance) or a configured cap", () => {
  const u = user({ balance: 1 });
  assert.equal(acquire(u, 0.6).ok, true);
  let r = acquire(u, 0.6);
  assert.deepEqual([r.reason, r.inFlight, r.maxInflight, r.reservedUsd, r.capUsd, r.capIsBalance, r.wantedUsd], ["reserved_spending_cap", 1, 1000, 0.6, 1, true, 0.6]);
  const capped = user({ balance: 100, maxInflightUsd: 5 });
  assert.equal(acquire(capped, 4).ok, true);
  r = acquire(capped, 4);
  assert.deepEqual([r.reason, r.reservedUsd, r.capUsd, r.capIsBalance, r.availableUsd], ["reserved_spending_cap", 4, 5, false, 100]);
});

test("key_quota_reserved: in-flight requests on the key reserve what is left of its quota", () => {
  const u = user({ balance: 100, quota: 10, used: 9 });
  assert.equal(acquire(u, 0.8).ok, true);
  const r = acquire(u, 0.8);
  assert.deepEqual([r.reason, r.keyRemainingUsd, r.keyReservedUsd, r.wantedUsd], ["key_quota_reserved", 1, 0.8, 0.8]);
});
