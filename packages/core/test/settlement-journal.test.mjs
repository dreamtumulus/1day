// Settlement fail-closed blast radius (review 2026-11-09 G): zero-cost rows are best-effort and never close
// admission; a poisoned journal entry is dead-lettered after N counted replay failures; money rows stay durable
// and idempotent by request_id.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
const dir = mkdtempSync(join(tmpdir(), "1dayapi-settlement-journal-"));
process.env.DATA_DIR = dir;
process.env.SETTLEMENT_REPLAY_MAX_ATTEMPTS = "3";
process.env.SETTLEMENT_REPLAY_MIN_INTERVAL_MS = "0";
after(() => rmSync(dir, { recursive: true, force: true }));
const c = await import("../dist/index.js");
const model = "claude-opus-5-5";
const journal = join(dir, "settlement-journal");
const dead = join(journal, "dead-letter");
const entries = (d) => (existsSync(d) ? readdirSync(d).filter((x) => /^[a-f0-9]{64}\.json$/.test(x)) : []);
function user(balance = 10) {
  const id = c.newId(), key = c.newId();
  c.run("INSERT INTO users(id,role,name,login_key_hash,login_key_preview,balance_usd) VALUES (?,'consumer',? ,?,'p',?)", id, id, id, balance);
  c.run("INSERT INTO api_keys(id,user_id,name,key_hash,key_preview,group_id,quota_usd) VALUES (?,?,'k',?,'p','default',0)", key, id, key);
  return { id, key };
}
function input(u, extra = {}) {
  return { requestId: c.newId(), userId: u.id, apiKeyId: u.key, groupId: "default", rateMultiplier: 1,
    accountId: null, providerId: null, payoutRate: 0, model, upstreamModel: model, endpoint: "/v1/messages",
    stream: false, statusCode: 200, usage: { input_tokens: 100, output_tokens: 20 }, usageEstimated: false, ...extra };
}
const zero = { usage: { input_tokens: 0, output_tokens: 0 } };
const breakDb = () => c.db.exec("CREATE TRIGGER injected_failure BEFORE INSERT ON usage_logs BEGIN SELECT RAISE(FAIL,'injected accounting failure'); END");
const fixDb = () => c.db.exec("DROP TRIGGER IF EXISTS injected_failure");

// One row per kind of zero-cost write the gateway makes.
const ZERO_COST_ROWS = [
  { name: "402 insufficient_balance reject", extra: { ...zero, statusCode: 402, errorCode: "insufficient_balance" } },
  { name: "429 quota_exhausted reject", extra: { ...zero, statusCode: 429, errorCode: "quota_exhausted" } },
  { name: "502 upstream failure log", extra: { ...zero, statusCode: 502, errorCode: "upstream_error", errorMessage: "boom" } },
  { name: "499 client_closed log", extra: { ...zero, statusCode: 499, errorCode: "client_closed" } },
  { name: "409 context_reset log", extra: { ...zero, statusCode: 409, errorCode: "context_reset" } },
  { name: "failure row that still reports tokens (non-2xx prices to zero)", extra: { statusCode: 502, errorCode: "upstream_stream_error" } },
];

for (const row of ZERO_COST_ROWS) {
  test(`zero-cost row is a plain write when the database works: ${row.name}`, () => {
    const u = user(), p = input(u, row.extra);
    const r = c.settleRequestDurably(p);
    assert.equal(r.settled, true);
    assert.equal(r.actualCost, 0);
    assert.equal(c.one("SELECT status_code s FROM usage_logs WHERE request_id=?", p.requestId).s, row.extra.statusCode);
    assert.equal(entries(journal).length, 0, "never journalled");
    assert.equal(c.settlementHealthy(), true);
  });

  test(`zero-cost row failing to write never closes admission and is not journalled: ${row.name}`, () => {
    const u = user(), p = input(u, row.extra);
    assert.equal(c.retryPendingSettlements(), 0);
    const before = c.settlementJournalStats().bestEffortFailures;
    breakDb();
    try {
      let r;
      assert.doesNotThrow(() => { r = c.settleRequestDurably(p); });
      assert.equal(r.settled, false);
      assert.notEqual(r.pending, true, "not queued");
      assert.equal(entries(journal).length, 0, "no journal entry for a log row");
      assert.equal(c.settlementHealthy(), true, "admission stays open");
      assert.equal(c.settlementJournalStats().healthy, true);
      assert.equal(c.settlementJournalStats().bestEffortFailures, before + 1, "the drop is counted");
    } finally { fixDb(); }
    assert.equal(c.one("SELECT 1 FROM usage_logs WHERE request_id=?", p.requestId), undefined);
  });
}

test("money row keeps the durable path: queued on failure, admission closed, replayed exactly once (idempotent by request_id)", () => {
  const u = user(), p = input(u);
  breakDb();
  let queued;
  try {
    queued = c.settleRequestDurably(p);
    assert.equal(queued.pending, true);
    assert.equal(entries(journal).length, 1);
    assert.equal(c.settlementHealthy(), false, "a pending charge still fails closed");
    assert.equal(c.settlementJournalStats().pending, 1);
  } finally { fixDb(); }
  assert.equal(c.retryPendingSettlements(), 0);
  assert.equal(c.settlementHealthy(), true);
  assert.equal(c.settlementJournalStats().pending, 0);
  assert.equal(c.one("SELECT COUNT(*) n FROM usage_logs WHERE request_id=?", p.requestId).n, 1);
  const used = c.one("SELECT used_usd FROM api_keys WHERE id=?", u.key).used_usd;
  assert.equal(c.settleRequestDurably(p).settled, false, "a second settle of the same request id is a no-op");
  assert.equal(c.one("SELECT used_usd FROM api_keys WHERE id=?", u.key).used_usd, used);
  assert.equal(c.one("SELECT COUNT(*) n FROM usage_logs WHERE request_id=?", p.requestId).n, 1);
});

test("a 2xx row that prices to zero (free group) is still durable, not best-effort", () => {
  const u = user(), p = input(u, { rateMultiplier: 0, usage: { input_tokens: 0, output_tokens: 0 } });
  breakDb();
  try {
    assert.equal(c.settleRequestDurably(p).pending, true);
    assert.equal(entries(journal).length, 1);
  } finally { fixDb(); }
  assert.equal(c.retryPendingSettlements(), 0);
  assert.equal(c.one("SELECT COUNT(*) n FROM usage_logs WHERE request_id=?", p.requestId).n, 1);
});

test("a poisoned entry is dead-lettered after N counted replay failures and stops blocking admission; moving it back replays it", () => {
  const u = user(), p = input(u), healthyRow = input(u);
  breakDb();
  try {
    c.settleRequestDurably(p);
    assert.equal(c.retryPendingSettlements(), 1, "failure 1 of 3");
    assert.equal(c.settlementHealthy(), false);
    assert.equal(c.retryPendingSettlements(), 1, "failure 2 of 3");
    assert.equal(entries(dead).length, 0);
    assert.equal(c.retryPendingSettlements(), 0, "failure 3 of 3: moved out of the replay set");
    assert.equal(entries(journal).length, 0);
    assert.equal(entries(dead).length, 1);
    assert.equal(c.settlementHealthy(), true, "admission reopens");
    assert.deepEqual({ pending: c.settlementJournalStats().pending, deadLetter: c.settlementJournalStats().deadLetter }, { pending: 0, deadLetter: 1 });
    assert.equal(c.one("SELECT 1 FROM usage_logs WHERE request_id=?", p.requestId), undefined, "not billed while dead-lettered");
  } finally { fixDb(); }
  // other traffic settles normally meanwhile
  assert.equal(c.settleRequestDurably(healthyRow).settled, true);
  // operator fixes the cause and moves the file back: replayed once, with the original tariff
  const name = entries(dead)[0];
  renameSync(join(dead, name), join(journal, name));
  assert.equal(c.retryPendingSettlements(), 0);
  assert.equal(c.one("SELECT COUNT(*) n FROM usage_logs WHERE request_id=?", p.requestId).n, 1);
  assert.equal(c.settlementJournalStats().deadLetter, 0);
});

test("a busy / locked database is never counted toward dead-lettering", () => {
  const u = user(), p = input(u);
  c.db.exec("CREATE TRIGGER injected_failure BEFORE INSERT ON usage_logs BEGIN SELECT RAISE(FAIL,'database is locked'); END");
  try {
    c.settleRequestDurably(p);
    for (let i = 0; i < 6; i++) assert.equal(c.retryPendingSettlements(), 1, `attempt ${i + 1} stays pending`);
    assert.equal(entries(dead).length, 0);
    assert.equal(c.settlementHealthy(), false, "still fail-closed while the charge is unposted");
  } finally { fixDb(); }
  assert.equal(c.retryPendingSettlements(), 0);
  assert.equal(c.one("SELECT COUNT(*) n FROM usage_logs WHERE request_id=?", p.requestId).n, 1);
});

test("counted failures are spaced by SETTLEMENT_REPLAY_MIN_INTERVAL_MS: a burst of rescans is one failure", () => {
  const u = user(), p = input(u);
  process.env.SETTLEMENT_REPLAY_MIN_INTERVAL_MS = "60000";
  breakDb();
  try {
    c.settleRequestDurably(p);
    for (let i = 0; i < 10; i++) assert.equal(c.retryPendingSettlements(), 1);
    assert.equal(entries(dead).length, 0, "ten rescans inside the interval count once");
  } finally { fixDb(); process.env.SETTLEMENT_REPLAY_MIN_INTERVAL_MS = "0"; }
  assert.equal(c.retryPendingSettlements(), 0);
});
