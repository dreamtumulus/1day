// Official cache-billing parity (X-51): cache writes are priced per TTL tier (5-minute 1.25x / 1-hour 2x input),
// usage_logs stores the split (migration 41), admin overrides get a 5-minute price (migration 42), and everything
// written before the split — usage rows, settlement-journal entries — keeps its old cost.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
const dir = mkdtempSync(join(tmpdir(), "1dayapi-cache-write-tiers-"));
process.env.DATA_DIR = dir;
after(() => rmSync(dir, { recursive: true, force: true }));
const c = await import("../dist/index.js");
const { runMigrations } = await import("../dist/migrations.js");

// claude-opus-5-5 (USD / 1M): input 4, output 20, cache read 0.2, cache write 5m 5, 1h 8 (single SKU 8)
const model = "claude-opus-5-5";
const M = 1_000_000;
const cols = (t) => new Set(c.db.prepare(`PRAGMA table_info(${t})`).all().map((x) => x.name));
function user(balance = 1000) {
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
const row = (requestId) => c.one("SELECT * FROM usage_logs WHERE request_id = ?", requestId);
const override = (id, { input = 4, output = 20, read = 0.2, write = 8, write5m = null } = {}) =>
  c.run(`INSERT INTO model_prices(model_id,display_name,platform,input_per_m,output_per_m,cache_read_per_m,cache_write_per_m,cache_write_5m_per_m,enabled)
         VALUES (?,?,'anthropic',?,?,?,?,?,1)
         ON CONFLICT(model_id) DO UPDATE SET input_per_m=excluded.input_per_m, output_per_m=excluded.output_per_m, cache_read_per_m=excluded.cache_read_per_m,
           cache_write_per_m=excluded.cache_write_per_m, cache_write_5m_per_m=excluded.cache_write_5m_per_m`, id, id, input, output, read, write, write5m);

test("schema: fresh database has the split columns and the 5-minute override column; migrations 41 / 42 are recorded", () => {
  const u = cols("usage_logs");
  assert.ok(u.has("cache_write_tokens") && u.has("cache_write_5m_tokens") && u.has("cache_write_1h_tokens"));
  assert.ok(cols("model_prices").has("cache_write_5m_per_m"));
  assert.ok(c.one("SELECT 1 FROM schema_migrations WHERE version = 41"));
  assert.ok(c.one("SELECT 1 FROM schema_migrations WHERE version = 42"));
});

test("upgrade: migrations 41 / 42 add the columns to a pre-split database, keep existing rows (0 / 0, NULL) and re-apply as a no-op", () => {
  const u = user();
  const p = input(u, { usage: { input_tokens: 10, output_tokens: 1, cache_write_tokens: 500 } });
  c.settleRequest(p);
  const before = row(p.requestId);
  override("upgrade-model", { write: 8 });
  c.db.exec("ALTER TABLE usage_logs DROP COLUMN cache_write_5m_tokens");
  c.db.exec("ALTER TABLE usage_logs DROP COLUMN cache_write_1h_tokens");
  c.db.exec("ALTER TABLE model_prices DROP COLUMN cache_write_5m_per_m");
  c.run("DELETE FROM schema_migrations WHERE version IN (41, 42)");
  const log = [];
  runMigrations(c.db, (m) => log.push(m));
  assert.ok(cols("usage_logs").has("cache_write_5m_tokens") && cols("usage_logs").has("cache_write_1h_tokens"));
  assert.ok(cols("model_prices").has("cache_write_5m_per_m"));
  const after = row(p.requestId);
  assert.deepEqual([after.cache_write_tokens, after.cache_write_5m_tokens, after.cache_write_1h_tokens], [500, 0, 0], "old row: total kept, split unknown");
  assert.equal(after.total_cost, before.total_cost);
  assert.equal(c.one("SELECT cache_write_5m_per_m AS v FROM model_prices WHERE model_id='upgrade-model'").v, null);
  assert.ok(log.some((m) => m.includes("migration 41")) && log.some((m) => m.includes("migration 42")));
  runMigrations(c.db, () => { throw new Error("second run must be a no-op"); });
  assert.equal(c.all("SELECT version FROM schema_migrations WHERE version IN (41, 42)").length, 2);
  c.run("DELETE FROM model_prices WHERE model_id='upgrade-model'");
});

test("catalog path: each tier at its own SKU; a record without a split at the old single price", () => {
  const base = { input_tokens: 0, output_tokens: 0 };
  assert.equal(c.computeCost(model, { ...base, cache_write_tokens: M, cache_write_5m_tokens: M }), 5);
  assert.equal(c.computeCost(model, { ...base, cache_write_tokens: M, cache_write_1h_tokens: M }), 8);
  assert.equal(c.computeCost(model, { ...base, cache_write_tokens: M }), 8, "old row: unchanged");
  assert.equal(c.computeCost(model, { ...base, cache_write_tokens: 2 * M, cache_write_5m_tokens: M, cache_write_1h_tokens: M }), 13);
  assert.equal(c.computeCost(model, { ...base, cache_read_tokens: M }), 0.2, "cache read unchanged");
  // the total is never counted on top of its buckets
  assert.equal(c.computeCost(model, { ...base, cache_write_5m_tokens: M }), c.computeCost(model, { ...base, cache_write_tokens: M, cache_write_5m_tokens: M }));
});

test("admin override: cache_write_per_m is the 1-hour price; the 5-minute price is its own column or 0.625 x the 1-hour price", () => {
  const id = "tier-override-model";
  const base = { input_tokens: 0, output_tokens: 0 };
  override(id, { write: 8, write5m: null });
  assert.equal(c.computeCost(id, { ...base, cache_write_tokens: M, cache_write_1h_tokens: M }), 8);
  assert.equal(c.computeCost(id, { ...base, cache_write_tokens: M, cache_write_5m_tokens: M }), 5, "NULL → 8 x 0.625");
  assert.equal(c.computeCost(id, { ...base, cache_write_tokens: M }), 8, "pre-split record: the single price it was charged with");
  let e = c.getModelEntry(id);
  assert.deepEqual([e.prices.cacheWritePerM, e.prices.cacheWrite5mPerM, e.cacheWrite5mExplicit], [8, 5, false]);
  override(id, { write: 8, write5m: 6 });
  assert.equal(c.computeCost(id, { ...base, cache_write_tokens: M, cache_write_5m_tokens: M }), 6, "explicit 5-minute price");
  assert.equal(c.computeCost(id, { ...base, cache_write_tokens: 3 * M, cache_write_5m_tokens: M, cache_write_1h_tokens: M }), 6 + 8 + 8);
  e = c.getModelEntry(id);
  assert.deepEqual([e.prices.cacheWrite5mPerM, e.cacheWrite5mExplicit], [6, true]);
  override(id, { write: 8, write5m: 0 });
  assert.equal(c.computeCost(id, { ...base, cache_write_tokens: M, cache_write_5m_tokens: M }), 0, "an explicit 0 is a price, not a missing value");
  // public pricing of an overridden model lists both tiers (and keeps the single SKU for older readers)
  override(id, { write: 8, write5m: null });
  const skus = Object.fromEntries(c.publicPricing().find((p) => p.id === id).pricing_skus.map((s) => [s.meter, Number(s.price_usd)]));
  assert.deepEqual([skus.cache_write_tokens, skus.cache_write_5m_tokens, skus.cache_write_1h_tokens], [8, 5, 8]);
  c.run("DELETE FROM model_prices WHERE model_id = ?", id);
});

test("catalog registry entry exposes both tier prices", () => {
  const e = c.getModelEntry(model);
  assert.deepEqual([e.prices.inputPerM, e.prices.cacheReadPerM, e.prices.cacheWrite5mPerM, e.prices.cacheWritePerM, e.cacheWrite5mExplicit], [4, 0.2, 5, 8, true]);
});

test("validateTokenUsage: buckets are part of the total (not added to it); bad bucket counts are rejected", () => {
  c.validateTokenUsage({ input_tokens: 1, output_tokens: 1, cache_write_tokens: 900_000_000, cache_write_5m_tokens: 400_000_000, cache_write_1h_tokens: 500_000_000 });
  assert.throws(() => c.validateTokenUsage({ input_tokens: 200_000_000, output_tokens: 1, cache_write_tokens: 900_000_000 }), /total prompt tokens/);
  assert.throws(() => c.validateTokenUsage({ input_tokens: 1, output_tokens: 1, cache_write_5m_tokens: 600_000_000, cache_write_1h_tokens: 600_000_000 }), /total prompt tokens/);
  for (const bad of [-1, 1.5, NaN, "3"]) assert.throws(() => c.validateTokenUsage({ input_tokens: 1, output_tokens: 1, cache_write_1h_tokens: bad }), /invalid usage count/);
  assert.deepEqual(c.cacheWriteBuckets({ cache_write_tokens: 10, cache_write_5m_tokens: 3, cache_write_1h_tokens: 4 }), { total: 10, m5: 3, h1: 4, unsplit: 3 });
});

test("settlement stores total + split, charges the tiered cost through the group multiplier and the provider payout", () => {
  const u = user(), provider = user(0);
  const usage = { input_tokens: 1000, output_tokens: 100, cache_read_tokens: 20_000, cache_write_tokens: 3000, cache_write_5m_tokens: 1000, cache_write_1h_tokens: 2000 };
  const standard = (1000 * 4 + 100 * 20 + 20_000 * 0.2 + 1000 * 5 + 2000 * 8) / M;
  const p = input(u, { usage, rateMultiplier: 0.5, providerId: provider.id, payoutRate: 0.6 });
  const r = c.settleRequest(p);
  assert.ok(r.settled);
  assert.equal(r.totalCost, c.q8(standard));
  assert.equal(r.actualCost, c.q8(standard * 0.5));
  assert.equal(r.providerEarning, c.q8(standard * 0.6));
  const l = row(p.requestId);
  assert.deepEqual([l.input_tokens, l.cache_read_tokens, l.cache_write_tokens, l.cache_write_5m_tokens, l.cache_write_1h_tokens], [1000, 20_000, 3000, 1000, 2000]);
  assert.equal(l.total_cost, c.q8(standard));
  assert.equal(c.one("SELECT balance_usd AS b FROM users WHERE id = ?", u.id).b, c.q8(1000 - c.q8(standard * 0.5)));
  assert.equal(c.one("SELECT balance_usd AS b FROM users WHERE id = ?", provider.id).b, c.q8(standard * 0.6));
  // the tariff snapshot carries both write prices
  const snap = JSON.parse(c.one("SELECT pricing_json AS j FROM usage_pricing_snapshots WHERE request_id = ?", p.requestId).j);
  assert.deepEqual([snap.prices.cacheWritePerM, snap.prices.cacheWrite5mPerM], [8, 5]);
});

test("a usage object carrying only buckets (no total) is stored with the total filled in", () => {
  const u = user();
  const p = input(u, { usage: { input_tokens: 1, output_tokens: 1, cache_write_5m_tokens: 40, cache_write_1h_tokens: 60 } });
  c.settleRequest(p);
  const l = row(p.requestId);
  assert.deepEqual([l.cache_write_tokens, l.cache_write_5m_tokens, l.cache_write_1h_tokens], [100, 40, 60]);
});

test("switched request (cache refund): the excess over the all-read price counts every prompt token once, both tiers included", () => {
  const u = user();
  const usage = { input_tokens: 0, output_tokens: 10, cache_read_tokens: 1000, cache_write_tokens: 3000, cache_write_5m_tokens: 1000, cache_write_1h_tokens: 2000 };
  const price = c.prepareSettlementPricing(input(u, { usage, accountSwitched: true }));
  const total = (10 * 20 + 1000 * 0.2 + 1000 * 5 + 2000 * 8) / M;
  const ideal = (10 * 20 + 4000 * 0.2) / M;
  assert.equal(price.totalCost, c.q8(total));
  assert.equal(price.cacheExcessUsd, c.q8(total - ideal));
});

test("usageCostLines: one line per meter with its unit price; the lines add up to computeCost", () => {
  const prices = c.getModelEntry(model).prices;
  const usage = { input_tokens: 1000, output_tokens: 100, cache_read_tokens: 20_000, cache_write_tokens: 3500, cache_write_5m_tokens: 1000, cache_write_1h_tokens: 2000 };
  const lines = c.usageCostLines(usage, prices);
  assert.deepEqual(lines.map((l) => [l.meter, l.tokens, l.pricePerM]), [
    ["input", 1000, 4], ["output", 100, 20], ["cache_read", 20_000, 0.2], ["cache_write_5m", 1000, 5], ["cache_write_1h", 2000, 8], ["cache_write", 500, 8],
  ]);
  const sum = lines.reduce((s, l) => s + l.costUsd, 0);
  assert.ok(Math.abs(sum - c.computeCost(model, usage)) < 1e-12);
  // an old row: a single cache-write line at the old price, no tier lines
  assert.deepEqual(c.usageCostLines({ input_tokens: 0, output_tokens: 0, cache_write_tokens: 500 }, prices).map((l) => [l.meter, l.tokens, l.pricePerM]), [["cache_write", 500, 8]]);
  // a settlement snapshot from before X-51 has no 5-minute price: 0.625 x the 1-hour price
  const { cacheWrite5mPerM: _drop, ...oldSnapshot } = prices;
  assert.equal(c.usageCostLines({ input_tokens: 0, output_tokens: 0, cache_write_tokens: 10, cache_write_5m_tokens: 10 }, oldSnapshot)[0].pricePerM, 5);
});

test("journal replay: an entry written by the previous version (no split fields, no 5-minute price) settles without error at its persisted tariff", () => {
  const u = user();
  const requestId = c.newId();
  // Byte shape of a pre-X-51 journal entry: usage has only the total, prices only the four old meters.
  const entry = {
    version: 1,
    input: { requestId, userId: u.id, apiKeyId: u.key, groupId: "default", rateMultiplier: 1, accountId: null, providerId: null, payoutRate: 0,
      model, upstreamModel: model, endpoint: "/v1/messages", stream: true, statusCode: 200,
      usage: { input_tokens: 100, output_tokens: 20, cache_read_tokens: 5000, cache_write_tokens: 1200 }, usageEstimated: false, mode: "passthrough-anthropic" },
    pricing: { modelId: model, prices: { inputPerM: 4, outputPerM: 20, cacheReadPerM: 0.2, cacheWritePerM: 8 }, totalCost: 0.0114, actualCost: 0.0114, providerEarning: 0, cacheExcessUsd: 0 },
  };
  const journal = join(dir, "settlement-journal");
  mkdirSync(journal, { recursive: true });
  writeFileSync(join(journal, createHash("sha256").update(requestId).digest("hex") + ".json"), JSON.stringify(entry));
  assert.equal(c.retryPendingSettlements(), 0, "nothing left pending");
  assert.deepEqual(readdirSync(journal).filter((n) => /^[a-f0-9]{64}\.json$/.test(n)), []);
  const l = row(requestId);
  assert.deepEqual([l.cache_write_tokens, l.cache_write_5m_tokens, l.cache_write_1h_tokens], [1200, 0, 0]);
  assert.equal(l.total_cost, 0.0114, "the persisted tariff, not a re-pricing");
  assert.equal(l.actual_cost, 0.0114);
  // and that old amount is exactly what today's code computes for a record without a split
  assert.equal(c.q8(c.computeCost(model, entry.input.usage)), 0.0114);
  assert.equal(c.retryPendingSettlements(), 0);
});

test("settings: the worker-lane presentation defaults to the official one; the escape hatch is still a valid value", () => {
  assert.equal(c.SETTING_DEFAULTS.ccr_cache_write_as_input, "0");
  assert.equal(c.getSetting("ccr_cache_write_as_input"), "0");
  c.setSetting("ccr_cache_write_as_input", "1");
  assert.equal(c.getSetting("ccr_cache_write_as_input"), "1");
  c.run("DELETE FROM settings WHERE key = 'ccr_cache_write_as_input'");
});
