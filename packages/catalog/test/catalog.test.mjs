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
