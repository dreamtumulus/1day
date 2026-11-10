// Catalog consistency (data/models.json ↔ data/pricing.json). These two files are edited by hand and shipped as
// they are; billing reads prices from them at runtime, so a model without a price, a zero / non-numeric price or a
// duplicated id must fail here and not on a customer's invoice.
//   pnpm --filter @1dayapi/catalog test
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const load = (name) => JSON.parse(readFileSync(new URL(`../data/${name}`, import.meta.url), "utf8"));
const models = load("models.json").data;
const pricing = load("pricing.json").data;

/** Meters every model must be priced for. Cache writes may be one SKU or the 5m / 1h pair. */
const REQUIRED_METERS = ["input_tokens", "output_tokens", "cache_read_tokens"];
const CACHE_WRITE_METERS = ["cache_write_tokens", "cache_write_5m_tokens", "cache_write_1h_tokens"];
const DECIMAL = /^\d+(\.\d+)?$/;

const duplicates = (values) => [...new Set(values.filter((v, i) => values.indexOf(v) !== i))];
const report = (problems) => (problems.length ? `\n  ${problems.join("\n  ")}` : "");

test("both files hold a non-empty data array", () => {
  assert.ok(Array.isArray(models) && models.length > 0, "models.json data");
  assert.ok(Array.isArray(pricing) && pricing.length > 0, "pricing.json data");
});

test("ids are unique", () => {
  const problems = [
    ...duplicates(models.map((m) => m.modelId)).map((id) => `models.json: modelId ${id} appears more than once`),
    ...duplicates(pricing.map((p) => p.id)).map((id) => `pricing.json: id ${id} appears more than once`),
    ...duplicates(pricing.flatMap((p) => (p.pricing_skus ?? []).map((s) => s.sku_id))).map((id) => `pricing.json: sku_id ${id} appears more than once`),
  ];
  for (const p of pricing) {
    for (const meter of duplicates((p.pricing_skus ?? []).map((s) => s.meter))) problems.push(`pricing.json: ${p.id} has more than one ${meter} SKU`);
  }
  assert.deepEqual(problems, [], report(problems));
});

test("every model has input / output / cache SKUs", () => {
  const byId = new Map(pricing.map((p) => [p.id, p]));
  const problems = [];
  for (const m of models) {
    assert.equal(typeof m.modelId, "string");
    const entry = byId.get(m.modelId);
    if (!entry) {
      problems.push(`${m.modelId}: no pricing.json entry`);
      continue;
    }
    const meters = new Set((entry.pricing_skus ?? []).map((s) => s.meter));
    for (const meter of REQUIRED_METERS) if (!meters.has(meter)) problems.push(`${m.modelId}: no ${meter} SKU`);
    if (!CACHE_WRITE_METERS.some((meter) => meters.has(meter))) problems.push(`${m.modelId}: no cache write SKU (${CACHE_WRITE_METERS.join(" / ")})`);
  }
  assert.deepEqual(problems, [], report(problems));
});

test("every SKU is well-formed with a positive numeric price", () => {
  const problems = [];
  for (const p of pricing) {
    if (!Array.isArray(p.pricing_skus) || p.pricing_skus.length === 0) {
      problems.push(`${p.id}: no pricing_skus`);
      continue;
    }
    if (p.currency !== "USD") problems.push(`${p.id}: currency is ${JSON.stringify(p.currency)}, expected "USD"`);
    for (const s of p.pricing_skus) {
      const where = `${p.id} / ${s.sku_id}`;
      if (s.sku_id !== `${p.id}:${s.meter}`) problems.push(`${where}: sku_id should be ${p.id}:${s.meter}`);
      if (s.unit !== "token") problems.push(`${where}: unit is ${JSON.stringify(s.unit)}`);
      if (!(Number.isInteger(s.quantity) && s.quantity > 0)) problems.push(`${where}: quantity ${JSON.stringify(s.quantity)} is not a positive integer`);
      for (const field of ["price_usd", "reference_price_usd"]) {
        const v = s[field];
        if (typeof v !== "string" || !DECIMAL.test(v)) problems.push(`${where}: ${field} ${JSON.stringify(v)} is not a decimal string`);
        else if (!(Number(v) > 0)) problems.push(`${where}: ${field} ${v} is not positive`);
      }
    }
  }
  assert.deepEqual(problems, [], report(problems));
});

test("no orphan pricing entries or SKUs", () => {
  const ids = new Set(models.map((m) => m.modelId));
  const problems = [];
  for (const p of pricing) {
    if (!ids.has(p.id)) problems.push(`pricing.json: ${p.id} (${(p.pricing_skus ?? []).length} SKUs) has no model in models.json`);
    for (const s of p.pricing_skus ?? []) {
      if (typeof s.sku_id !== "string" || !s.sku_id.startsWith(`${p.id}:`)) problems.push(`pricing.json: SKU ${s.sku_id} does not belong to its entry ${p.id}`);
    }
  }
  assert.deepEqual(problems, [], report(problems));
});

test("cache prices are ordered: read < input <= write", () => {
  const problems = [];
  for (const p of pricing) {
    const price = Object.fromEntries((p.pricing_skus ?? []).map((s) => [s.meter, Number(s.price_usd) / Number(s.quantity)]));
    if (!(price.input_tokens > 0)) continue;
    if (price.cache_read_tokens >= price.input_tokens) problems.push(`${p.id}: cache_read_tokens is not cheaper than input_tokens`);
    for (const meter of CACHE_WRITE_METERS) {
      if (meter in price && price[meter] < price.input_tokens) problems.push(`${p.id}: ${meter} is cheaper than input_tokens`);
    }
  }
  assert.deepEqual(problems, [], report(problems));
});

// Official parity (X-51): cache writes are billed per TTL tier, 5-minute at 1.25x input and 1-hour at 2x input.
// The single `cache_write_tokens` SKU prices records written before the split existed and must stay the 1-hour price.
// A model whose official price really deviates goes into EXCEPTIONS with the reason, never a silent price change.
const CACHE_WRITE_RATIO_EXCEPTIONS = new Map([
  // ["model-id", "reason"],
]);
const near = (a, b) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b));

test("every model has both cache-write tiers: 5m = 1.25x input, 1h = 2x input, single SKU = 1h", () => {
  const problems = [];
  for (const p of pricing) {
    if (CACHE_WRITE_RATIO_EXCEPTIONS.has(p.id)) continue;
    const price = Object.fromEntries((p.pricing_skus ?? []).map((s) => [s.meter, Number(s.price_usd) / Number(s.quantity)]));
    const ref = Object.fromEntries((p.pricing_skus ?? []).map((s) => [s.meter, Number(s.reference_price_usd) / Number(s.quantity)]));
    for (const [label, m] of [["price_usd", price], ["reference_price_usd", ref]]) {
      if (!(m.input_tokens > 0)) continue;
      if (!("cache_write_5m_tokens" in m)) problems.push(`${p.id}: no cache_write_5m_tokens SKU`);
      else if (!near(m.cache_write_5m_tokens, m.input_tokens * 1.25)) problems.push(`${p.id}: ${label} cache_write_5m_tokens is ${(m.cache_write_5m_tokens / m.input_tokens).toFixed(4)}x input, expected 1.25x`);
      if (!("cache_write_1h_tokens" in m)) problems.push(`${p.id}: no cache_write_1h_tokens SKU`);
      else if (!near(m.cache_write_1h_tokens, m.input_tokens * 2)) problems.push(`${p.id}: ${label} cache_write_1h_tokens is ${(m.cache_write_1h_tokens / m.input_tokens).toFixed(4)}x input, expected 2x`);
      if ("cache_write_tokens" in m && "cache_write_1h_tokens" in m && !near(m.cache_write_tokens, m.cache_write_1h_tokens)) problems.push(`${p.id}: ${label} cache_write_tokens differs from cache_write_1h_tokens (old rows are priced with it)`);
    }
  }
  for (const id of CACHE_WRITE_RATIO_EXCEPTIONS.keys()) if (!pricing.some((p) => p.id === id)) problems.push(`exception list names unknown model ${id}`);
  assert.deepEqual(problems, [], report(problems));
});

test("estimateCost prices each cache-write tier with its own SKU and the unsplit remainder with the single SKU", async () => {
  const { estimateCost, cacheWriteBuckets } = await import("../dist/src/index.js");
  const M = 1_000_000;
  const base = { input_tokens: 0, output_tokens: 0 };
  // claude-opus-5-5: input 4, 5m 5, 1h 8, single 8 (USD / 1M)
  assert.equal(estimateCost("claude-opus-5-5", { ...base, cache_write_tokens: M, cache_write_5m_tokens: M }), 5);
  assert.equal(estimateCost("claude-opus-5-5", { ...base, cache_write_tokens: M, cache_write_1h_tokens: M }), 8);
  assert.equal(estimateCost("claude-opus-5-5", { ...base, cache_write_tokens: M }), 8, "pre-split record: old single price");
  assert.equal(estimateCost("claude-opus-5-5", { ...base, cache_write_tokens: 3 * M, cache_write_5m_tokens: M, cache_write_1h_tokens: M }), 5 + 8 + 8);
  assert.equal(estimateCost("claude-opus-5-5", { ...base, cache_write_5m_tokens: M }), 5, "buckets without a total are not lost");
  assert.equal(estimateCost("claude-opus-5-5", { input_tokens: M, output_tokens: M, cache_read_tokens: M }), 4 + 20 + 0.2);
  assert.deepEqual(cacheWriteBuckets({ cache_write_tokens: 10, cache_write_5m_tokens: 3, cache_write_1h_tokens: 4 }), { total: 10, m5: 3, h1: 4, unsplit: 3 });
  assert.deepEqual(cacheWriteBuckets({ cache_write_5m_tokens: 3, cache_write_1h_tokens: 4 }), { total: 7, m5: 3, h1: 4, unsplit: 0 });
  assert.deepEqual(cacheWriteBuckets({}), { total: 0, m5: 0, h1: 0, unsplit: 0 });
});
