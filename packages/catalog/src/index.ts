import modelsData from "../data/models.json" with { type: "json" };
import pricingData from "../data/pricing.json" with { type: "json" };

export interface CatalogModel {
  modelId: string;
  displayName: string;
  vendor: string;
  providers: string[];
  supplyVendors: string[];
  status: string;
  modelFamily: string;
  contextWindow: number;
  maxOutputTokens: number;
}

export interface PricingSku {
  sku_id: string;
  meter:
    | "input_tokens"
    | "output_tokens"
    | "cache_read_tokens"
    | "cache_write_tokens"
    | "cache_write_5m_tokens"
    | "cache_write_1h_tokens"
    | string;
  unit: string;
  quantity: number;
  price_usd: string;
  reference_price_usd: string;
  savings_pct?: string;
}

export interface PricingEntry {
  id: string;
  name: string;
  owned_by: string;
  providers: string[];
  available: boolean;
  currency: string;
  pricing_mode: string;
  tags: string[];
  architecture: {
    modality: string;
    input_modalities: string[];
    output_modalities: string[];
  };
  pricing_skus: PricingSku[];
}

/**
 * Token usage of one request. `cache_write_tokens` is the TOTAL cache creation
 * (Anthropic `cache_creation_input_tokens`); `cache_write_5m_tokens` and
 * `cache_write_1h_tokens` are its split by cache TTL (Anthropic
 * `cache_creation.ephemeral_5m_input_tokens` / `ephemeral_1h_input_tokens`).
 * A record whose split is unknown (rows and journal entries written before the
 * split existed) carries only the total: see `cacheWriteBuckets`.
 */
export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  cache_write_5m_tokens?: number;
  cache_write_1h_tokens?: number;
}

export interface CacheWriteBuckets {
  /** Total cache creation tokens. */
  total: number;
  /** Written with the 5-minute TTL (official price 1.25x input). */
  m5: number;
  /** Written with the 1-hour TTL (official price 2x input). */
  h1: number;
  /** total - m5 - h1: split unknown (pre-split record); priced at the old single `cache_write_tokens` price. */
  unsplit: number;
}

/**
 * The one place that defines how the three cache-write counts relate: the total is
 * `cache_write_tokens`, never less than the two buckets together (a record carrying only
 * buckets is accepted), and whatever the buckets do not cover is the unsplit remainder.
 */
export function cacheWriteBuckets(usage: Pick<TokenUsage, "cache_write_tokens" | "cache_write_5m_tokens" | "cache_write_1h_tokens">): CacheWriteBuckets {
  const m5 = usage.cache_write_5m_tokens ?? 0;
  const h1 = usage.cache_write_1h_tokens ?? 0;
  const total = Math.max(usage.cache_write_tokens ?? 0, m5 + h1);
  return { total, m5, h1, unsplit: total - m5 - h1 };
}

/** Catalog cache-write ratios to the input price (official: 5-minute 1.25x, 1-hour 2x). */
export const CACHE_WRITE_5M_RATIO = 1.25;
export const CACHE_WRITE_1H_RATIO = 2;

const models = (modelsData as { data: CatalogModel[] }).data;
const pricing = (pricingData as { data: PricingEntry[] }).data;

export function listModels(): CatalogModel[] {
  return models;
}

export function listPricing(): PricingEntry[] {
  return pricing;
}

/** claude-sonnet-4-5-20250929 这类带日期快照 ID 回退到别名（Claude Code 客户端常发）。 */
function aliasOf(id: string): string | null {
  const m = /^(.*)-\d{8}$/.exec(id);
  return m ? m[1] : null;
}

export function getModel(id: string): CatalogModel | undefined {
  return models.find((m) => m.modelId === id) ?? (aliasOf(id) ? models.find((m) => m.modelId === aliasOf(id)) : undefined);
}

export function getPricing(id: string): PricingEntry | undefined {
  return pricing.find((p) => p.id === id) ?? (aliasOf(id) ? pricing.find((p) => p.id === aliasOf(id)) : undefined);
}

/**
 * USD cost for a token usage record, based on catalog pricing SKUs.
 * Cache writes: the 5-minute bucket at the `cache_write_5m_tokens` SKU, the 1-hour bucket at
 * `cache_write_1h_tokens`, the unsplit remainder (pre-split records) at the single `cache_write_tokens`
 * SKU those records were originally priced with. An entry lacking a tier SKU falls back to the single one.
 */
export function estimateCost(modelId: string, usage: TokenUsage): number {
  const entry = getPricing(modelId);
  if (!entry) return 0;
  const sku = (meter: string): PricingSku | undefined => entry.pricing_skus.find((s) => s.meter === meter);
  // (qty / quantity) * price: the arithmetic order billing has always used, so old rows reprice to the same float.
  const cost = (s: PricingSku | undefined, qty: number | undefined): number =>
    s && typeof qty === "number" && qty > 0 ? (qty / s.quantity) * Number(s.price_usd) : 0;
  const w = cacheWriteBuckets(usage);
  const single = sku("cache_write_tokens");
  const s1h = sku("cache_write_1h_tokens") ?? single;
  const s5m = sku("cache_write_5m_tokens") ?? single;
  return (
    cost(sku("input_tokens"), usage.input_tokens) +
    cost(sku("output_tokens"), usage.output_tokens) +
    cost(sku("cache_read_tokens"), usage.cache_read_tokens) +
    cost(single ?? s1h, w.unsplit) +
    cost(s5m, w.m5) +
    cost(s1h, w.h1)
  );
}
