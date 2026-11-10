// Official cache-billing parity (X-51), console side: usage rows show cache write as its own line with the 5m / 1h
// split and unit prices (consumer, admin, provider views), usage stats carry the split, public pricing lists both
// write prices, and the admin model-price form reads / writes the 5-minute override. Real console app, temp DATA_DIR.
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const dir = mkdtempSync(join(tmpdir(), "1dayapi-console-cache-tiers-"));
process.env.DATA_DIR = dir;
process.env.CCR_WINDOW_POLL = "0";
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));

const core = await import("@1dayapi/core");
const { buildApp } = await import("../dist/app.js");
const { createUser } = await import("../dist/session.js");
const { run, one, settleRequest, newId } = core;

const app = await buildApp();
await app.listen({ port: 0, host: "127.0.0.1" });
const BASE = `http://127.0.0.1:${app.server.address().port}`;

async function login(key) {
  const r = await fetch(`${BASE}/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key }) });
  assert.equal(r.status, 200);
  const cookie = (r.headers.get("set-cookie") ?? "").split(";")[0];
  return async (method, path, body) => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { cookie, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const j = await res.json().catch(() => ({}));
    return { status: res.status, ...j };
  };
}

const admin = await login(readFileSync(join(dir, "admin-key.txt"), "utf8").trim());
const alice = createUser("consumer", "cw-alice");
const provider = createUser("provider", "cw-provider");
const aliceCall = await login(alice.loginKey);
const providerCall = await login(provider.loginKey);
const key = (await aliceCall("POST", "/api/user/keys", { name: "cw-k" })).data;

// claude-opus-5-5 (USD / 1M): input 4, output 20, cache read 0.2, cache write 5m 5 / 1h 8
const model = "claude-opus-5-5";
const settle = (usage, extra = {}) => {
  const requestId = newId();
  settleRequest({ requestId, userId: alice.id, apiKeyId: key.id, groupId: "default", rateMultiplier: 0.5, accountId: null, providerId: provider.id, payoutRate: 0.6,
    model, upstreamModel: model, endpoint: "/v1/messages", stream: false, statusCode: 200, usage, usageEstimated: false, ...extra });
  return requestId;
};
const splitReq = settle({ input_tokens: 1000, output_tokens: 100, cache_read_tokens: 20_000, cache_write_tokens: 3000, cache_write_5m_tokens: 1000, cache_write_1h_tokens: 2000 });
// A row from before the split: total only, and no pricing snapshot (older than the snapshots table).
const oldReq = "cw-old-row";
run(`INSERT INTO usage_logs (id, request_id, user_id, api_key_id, provider_id, model, endpoint, status_code, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
       total_cost, rate_multiplier, actual_cost, provider_earning, created_at)
     VALUES ('cw-old', ?, ?, ?, ?, ?, '/v1/messages', 200, 10, 5, 0, 500, 0.00414, 1, 0.00414, 0, '2026-10-01T00:00:00Z')`, oldReq, alice.id, key.id, provider.id, model);
const failedReq = settle({ input_tokens: 0, output_tokens: 0 }, { statusCode: 502, errorCode: "upstream_error" });

const byMeter = (b) => Object.fromEntries(b.lines.map((l) => [l.meter, l]));

await test("consumer usage list: cache write total with its 5m / 1h split and a per-meter cost breakdown with unit prices", async () => {
  const r = await aliceCall("GET", "/api/user/usage?pageSize=50");
  assert.equal(r.status, 200);
  const row = r.data.items.find((x) => x.requestId === splitReq);
  assert.deepEqual([row.cacheReadTokens, row.cacheWriteTokens, row.cacheWrite5mTokens, row.cacheWrite1hTokens], [20_000, 3000, 1000, 2000]);
  assert.equal(row.costBreakdown.priceSource, "settlement");
  const m = byMeter(row.costBreakdown);
  assert.deepEqual(Object.keys(m), ["input", "output", "cache_read", "cache_write_5m", "cache_write_1h"]);
  assert.deepEqual([m.cache_write_5m.tokens, m.cache_write_5m.pricePerM, m.cache_write_1h.tokens, m.cache_write_1h.pricePerM, m.cache_read.pricePerM], [1000, 5, 2000, 8, 0.2]);
  // amounts are after the group multiplier (0.5) and add up to what was charged
  assert.ok(Math.abs(m.cache_write_1h.costUsd - (2000 * 8 * 0.5) / 1e6) < 1e-12);
  const sum = row.costBreakdown.lines.reduce((s, l) => s + l.costUsd, 0);
  assert.ok(Math.abs(sum - row.actualCost) < 1e-7, `${sum} vs ${row.actualCost}`);
});

await test("a row from before the split: one cache-write line at the old single price, split 0 / 0, cost untouched", async () => {
  const r = await aliceCall("GET", "/api/user/usage?pageSize=50");
  const row = r.data.items.find((x) => x.requestId === oldReq);
  assert.deepEqual([row.cacheWriteTokens, row.cacheWrite5mTokens, row.cacheWrite1hTokens, row.actualCost], [500, 0, 0, 0.00414]);
  assert.equal(row.costBreakdown.priceSource, "current", "no snapshot: today's price, flagged");
  const m = byMeter(row.costBreakdown);
  assert.deepEqual([m.cache_write.tokens, m.cache_write.pricePerM], [500, 8]);
  assert.equal(m.cache_write_5m, undefined);
  const sum = row.costBreakdown.lines.reduce((s, l) => s + l.costUsd, 0);
  assert.ok(Math.abs(sum - 0.00414) < 1e-9, "10 x 4 + 5 x 20 + 500 x 8 per 1M = what the row was charged");
});

await test("a failed row has no cost breakdown", async () => {
  const r = await aliceCall("GET", "/api/user/usage?pageSize=50");
  assert.equal(r.data.items.find((x) => x.requestId === failedReq).costBreakdown, null);
});

await test("admin usage list carries the same fields", async () => {
  const r = await admin("GET", `/api/admin/usage?userId=${alice.id}&pageSize=50`);
  assert.equal(r.status, 200);
  const row = r.data.items.find((x) => x.requestId === splitReq);
  assert.deepEqual([row.cacheWriteTokens, row.cacheWrite5mTokens, row.cacheWrite1hTokens], [3000, 1000, 2000]);
  assert.equal(byMeter(row.costBreakdown).cache_write_5m.pricePerM, 5);
});

await test("usage stats: totals and daily rows carry the split next to the total", async () => {
  const r = await aliceCall("GET", "/api/user/usage/stats");
  assert.equal(r.status, 200);
  const t = r.data.totals;
  assert.deepEqual([t.cacheWriteTokens, t.cacheWrite5mTokens, t.cacheWrite1hTokens], [3500, 1000, 2000]);
  const day = r.data.daily.find((d) => d.cacheWrite1hTokens > 0);
  assert.deepEqual([day.cacheWriteTokens, day.cacheWrite5mTokens, day.cacheWrite1hTokens], [3000, 1000, 2000]);
});

await test("provider earnings rows: cache read and cache write (with split) next to the combined cache count", async () => {
  const r = await providerCall("GET", "/api/provider/earnings?pageSize=50");
  assert.equal(r.status, 200);
  const row = r.data.items.find((x) => x.cacheWrite1hTokens === 2000);
  assert.deepEqual([row.cacheTokens, row.cacheReadTokens, row.cacheWriteTokens, row.cacheWrite5mTokens], [23_000, 20_000, 3000, 1000]);
  // payout is a share of the tiered standard cost
  const standard = (1000 * 4 + 100 * 20 + 20_000 * 0.2 + 1000 * 5 + 2000 * 8) / 1e6;
  assert.ok(Math.abs(row.providerEarning - standard * 0.6) < 1e-8);
});

await test("public pricing lists both cache write prices for every model", async () => {
  const r = await (await fetch(`${BASE}/api/models/pricing`)).json();
  assert.ok(r.data.length > 0);
  for (const p of r.data) {
    const price = Object.fromEntries(p.pricing_skus.map((s) => [s.meter, Number(s.price_usd)]));
    assert.ok(price.cache_write_5m_tokens > 0 && price.cache_write_1h_tokens > 0, p.id);
    assert.ok(Math.abs(price.cache_write_5m_tokens - price.input_tokens * 1.25) < 1e-9 && Math.abs(price.cache_write_1h_tokens - price.input_tokens * 2) < 1e-9, p.id);
  }
});

await test("admin model price override: cacheWritePerM is the 1-hour price; the 5-minute price can be set, cleared (0.625 x 1h) or left alone", async () => {
  const id = "cw-custom-model";
  const get = async () => (await admin("GET", "/api/admin/models")).data.find((m) => m.modelId === id);
  const db5m = () => one("SELECT cache_write_5m_per_m AS v FROM model_prices WHERE model_id = ?", id).v;
  // a client that does not know the field (older UI / scripts): no own 5-minute price → derived
  let r = await admin("PUT", `/api/admin/models/${id}`, { platform: "anthropic", inputPerM: 4, outputPerM: 20, cacheReadPerM: 0.4, cacheWritePerM: 8 });
  assert.equal(r.status, 200);
  assert.equal(db5m(), null);
  let m = await get();
  assert.deepEqual([m.prices.cacheWritePerM, m.prices.cacheWrite5mPerM, m.cacheWrite5mExplicit], [8, 5, false]);
  // explicit value
  r = await admin("PUT", `/api/admin/models/${id}`, { cacheWrite5mPerM: 6 });
  assert.equal(r.status, 200);
  assert.equal(db5m(), 6);
  m = await get();
  assert.deepEqual([m.prices.cacheWritePerM, m.prices.cacheWrite5mPerM, m.cacheWrite5mExplicit], [8, 6, true]);
  // an update that does not mention it keeps it
  await admin("PUT", `/api/admin/models/${id}`, { cacheWritePerM: 10 });
  assert.equal(db5m(), 6);
  // null clears it: back to 0.625 x the 1-hour price
  await admin("PUT", `/api/admin/models/${id}`, { cacheWrite5mPerM: null });
  assert.equal(db5m(), null);
  m = await get();
  assert.deepEqual([m.prices.cacheWritePerM, m.prices.cacheWrite5mPerM, m.cacheWrite5mExplicit], [10, 6.25, false]);
  // a derived price stays derived across an update that does not mention it
  await admin("PUT", `/api/admin/models/${id}`, { enabled: false });
  assert.equal(db5m(), null);
  r = await admin("PUT", `/api/admin/models/${id}`, { cacheWrite5mPerM: -1 });
  assert.equal(r.status, 400);
  await admin("DELETE", `/api/admin/models/${id}`);
});

await test("overriding a catalog model for the first time starts from the catalog's 5-minute price", async () => {
  const r = await admin("PUT", `/api/admin/models/${model}`, { cacheWritePerM: 8 });
  assert.equal(r.status, 200);
  assert.equal(one("SELECT cache_write_5m_per_m AS v FROM model_prices WHERE model_id = ?", model).v, 5);
  await admin("DELETE", `/api/admin/models/${model}`);
});

await test("settings: ccr_cache_write_as_input defaults to 0 (official presentation) and still accepts the escape hatch", async () => {
  const s = await admin("GET", "/api/admin/settings");
  assert.equal(s.status, 200);
  const values = s.data.settings ?? s.data;
  assert.equal(values.ccr_cache_write_as_input, "0");
});

await app.close();
