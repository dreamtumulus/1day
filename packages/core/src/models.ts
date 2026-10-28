import {
  estimateCost,
  getModel,
  getPricing,
  listModels,
  listPricing,
  type CatalogModel,
  type PricingEntry,
  type PricingSku,
  type TokenUsage,
} from "@1dayapi/catalog";
import { all, one } from "./db.js";

// Model registry = built-in catalog ∪ model_prices rows (docs/v3-design.md §6).

export interface BasicPrices {
  inputPerM: number;
  outputPerM: number;
  cacheReadPerM: number;
  cacheWritePerM: number;
}

export interface ModelEntry {
  modelId: string;
  displayName: string;
  platform: string;
  source: "catalog" | "custom";
  enabled: boolean;
  overridden: boolean;
  prices: BasicPrices;
  catalogPrices: BasicPrices | null;
  contextWindow: number | null;
  maxOutputTokens: number | null;
  /** Set when the client wrote the id differently from what the upstream expects (claude-opus-5.5 → claude-opus-5-5). */
  upstreamModelId?: string;
}

interface PriceRow {
  model_id: string;
  display_name: string | null;
  platform: string;
  input_per_m: number;
  output_per_m: number;
  cache_read_per_m: number;
  cache_write_per_m: number;
  enabled: number;
}

function catalogBasicPrices(p: PricingEntry | undefined): BasicPrices | null {
  if (!p) return null;
  const per = (meter: string): number => {
    const sku = p.pricing_skus.find((s) => s.meter === meter);
    return sku ? (Number(sku.price_usd) * 1_000_000) / sku.quantity : 0;
  };
  return {
    inputPerM: per("input_tokens"),
    outputPerM: per("output_tokens"),
    cacheReadPerM: per("cache_read_tokens"),
    cacheWritePerM: per("cache_write_tokens"),
  };
}

function rowPrices(r: PriceRow): BasicPrices {
  return {
    inputPerM: r.input_per_m,
    outputPerM: r.output_per_m,
    cacheReadPerM: r.cache_read_per_m,
    cacheWritePerM: r.cache_write_per_m,
  };
}

function fromCatalog(m: CatalogModel, row: PriceRow | undefined): ModelEntry {
  const catalogPrices = catalogBasicPrices(getPricing(m.modelId));
  return {
    modelId: m.modelId,
    displayName: row?.display_name || m.displayName,
    platform: row?.platform || m.vendor,
    source: "catalog",
    enabled: row ? row.enabled === 1 : m.status === "active",
    overridden: !!row,
    prices: row ? rowPrices(row) : (catalogPrices ?? rowPrices({} as PriceRow)),
    catalogPrices,
    contextWindow: m.contextWindow ?? null,
    maxOutputTokens: m.maxOutputTokens ?? null,
  };
}

function fromRow(r: PriceRow): ModelEntry {
  return {
    modelId: r.model_id,
    displayName: r.display_name || r.model_id,
    platform: r.platform,
    source: "custom",
    enabled: r.enabled === 1,
    overridden: true,
    prices: rowPrices(r),
    catalogPrices: null,
    contextWindow: null,
    maxOutputTokens: null,
  };
}

/** Every known model (enabled or not), catalog order first, then custom. */
export function listRegistry(): ModelEntry[] {
  const rows = new Map(all<PriceRow>("SELECT * FROM model_prices").map((r) => [r.model_id, r]));
  const out: ModelEntry[] = listModels().map((m) => fromCatalog(m, rows.get(m.modelId)));
  const catalogIds = new Set(out.map((e) => e.modelId));
  for (const r of rows.values()) {
    if (catalogIds.has(r.model_id)) continue;
    // Historical rows written using an alias remain visible, but cannot
    // advertise a different enabled/price policy from their canonical model.
    const entry = getModelEntry(r.model_id);
    if (entry) out.push(entry);
  }
  return out;
}

/** Claude Code 常发带日期后缀的具体快照 ID（claude-sonnet-4-5-20250929），目录只登记别名。 */
function datedSnapshotAlias(modelId: string): string | null {
  const m = /^(.*)-\d{8}$/.exec(modelId);
  return m ? m[1] : null;
}

/**
 * Clients also write the version with a dot (claude-opus-5.5; 22 × 404 on
 * 2026-10-18); Anthropic ids use dashes. Claude ids only: OpenAI-style ids
 * (gpt-5.5-mini) legitimately contain dots.
 */
export function dottedVersionAlias(modelId: string): string | null {
  if (!modelId.startsWith("claude-") || !/\d\.\d/.test(modelId)) return null;
  return modelId.replace(/(\d)\.(?=\d)/g, "$1-");
}

/** Ids to look up after the exact one, nearest spelling first. */
export function modelIdAliases(modelId: string): string[] {
  const out: string[] = [];
  const push = (v: string | null) => {
    if (v && v !== modelId && !out.includes(v)) out.push(v);
  };
  const dotted = dottedVersionAlias(modelId);
  push(dotted);
  push(datedSnapshotAlias(modelId));
  if (dotted) push(datedSnapshotAlias(dotted));
  return out;
}

/** Canonical policy identity shared by catalog spellings and dated aliases. */
export function canonicalModelId(modelId: string): string {
  const normalized = dottedVersionAlias(modelId) ?? modelId;
  const m = getModel(normalized);
  if (m) return m.modelId;
  // A known base model governs every spelling, even if an old explicit alias
  // override row exists. An otherwise unknown custom model keeps its exact ID.
  const aliases = new Set([datedSnapshotAlias(normalized), datedSnapshotAlias(modelId), ...modelIdAliases(normalized), ...modelIdAliases(modelId)]);
  for (const alias of aliases) {
    if (!alias || alias === modelId) continue;
    const am = getModel(alias);
    if (am) return am.modelId;
    if (one("SELECT 1 FROM model_prices WHERE model_id = ?", alias)) return alias;
  }
  if (one("SELECT 1 FROM model_prices WHERE model_id = ?", normalized)) return normalized;
  if (normalized !== modelId && one("SELECT 1 FROM model_prices WHERE model_id = ?", modelId)) return modelId;
  return normalized;
}

export function getModelEntry(modelId: string): ModelEntry | undefined {
  const id = canonicalModelId(modelId);
  const row = one<PriceRow>("SELECT * FROM model_prices WHERE model_id = ?", id);
  const m = getModel(id);
  const entry = m ? fromCatalog(m, row) : row ? fromRow(row) : undefined;
  if (!entry) return undefined;
  // Snapshot IDs stay intact upstream; only dotted versions are corrected.
  const dotted = dottedVersionAlias(modelId);
  return { ...entry, modelId, ...(dotted && id !== modelId ? { upstreamModelId: dotted } : {}) };
}

export const MAX_USAGE_TOKENS = 1_000_000_000;
/** Do not coerce numeric strings or accept fractional, negative, NaN/Infinity usage. */
export function validateTokenUsage(usage: TokenUsage): void {
  if (!usage || typeof usage !== "object") throw new TypeError("usage must be an object");
  for (const field of ["input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens", "cache_write_5m_tokens", "cache_write_1h_tokens"] as const) {
    const n = usage[field];
    if (n === undefined && field !== "input_tokens" && field !== "output_tokens") continue;
    if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0 || n > MAX_USAGE_TOKENS) {
      throw new RangeError(`invalid usage count: ${field}`);
    }
  }
  const prompt = usage.input_tokens + (usage.cache_read_tokens ?? 0) + (usage.cache_write_tokens ?? 0)
    + (usage.cache_write_5m_tokens ?? 0) + (usage.cache_write_1h_tokens ?? 0);
  if (prompt > MAX_USAGE_TOKENS) throw new RangeError("invalid usage count: total prompt tokens");
}

/** Standard (pre-multiplier) USD cost of a request. */
export function computeCost(modelId: string, usage: TokenUsage): number {
  validateTokenUsage(usage);
  const id = canonicalModelId(modelId);
  const row = one<PriceRow>("SELECT * FROM model_prices WHERE model_id = ?", id);
  const result = row ? computeCostFromRow(row, usage) : estimateCost(id, usage);
  if (!Number.isFinite(result) || result < 0) throw new RangeError("invalid computed request cost");
  return result;
}

function computeCostFromRow(row: PriceRow, usage: TokenUsage): number {
  return (
    (usage.input_tokens * row.input_per_m +
      usage.output_tokens * row.output_per_m +
      (usage.cache_read_tokens ?? 0) * row.cache_read_per_m +
      ((usage.cache_write_tokens ?? 0) +
        (usage.cache_write_5m_tokens ?? 0) +
        (usage.cache_write_1h_tokens ?? 0)) *
        row.cache_write_per_m) /
    1_000_000
  );
}

// ---------- public catalog shapes (web Models / Pricing pages) ----------

export function publicModels(): CatalogModel[] {
  return listRegistry()
    .filter((e) => e.enabled)
    .map((e) => {
      const m = getModel(e.modelId);
      return {
        modelId: e.modelId,
        displayName: e.displayName,
        vendor: e.platform,
        providers: m?.providers ?? [e.platform],
        supplyVendors: m?.supplyVendors ?? [e.platform],
        status: "active",
        modelFamily: m?.modelFamily ?? e.modelId.split("-").slice(0, 2).join("-"),
        contextWindow: e.contextWindow ?? m?.contextWindow ?? 0,
        maxOutputTokens: e.maxOutputTokens ?? m?.maxOutputTokens ?? 0,
      };
    });
}

function fmt(n: number): string {
  return n.toFixed(6);
}

export function publicPricing(): PricingEntry[] {
  const catalogPricing = new Map(listPricing().map((p) => [p.id, p]));
  return listRegistry()
    .filter((e) => e.enabled)
    .map((e) => {
      const base = catalogPricing.get(e.modelId);
      if (base && !e.overridden) return base;
      const ref = catalogBasicPrices(base);
      const sku = (meter: string, price: number, refPrice: number | undefined): PricingSku => {
        const s: PricingSku = {
          sku_id: `${e.modelId}:${meter}`,
          meter,
          unit: "token",
          quantity: 1_000_000,
          price_usd: fmt(price),
          reference_price_usd: fmt(refPrice ?? price),
        };
        const refSku = base?.pricing_skus.find((x) => x.meter === meter);
        if (refSku?.reference_price_usd) {
          s.reference_price_usd = refSku.reference_price_usd;
          const r = Number(refSku.reference_price_usd);
          if (r > 0 && price < r) s.savings_pct = String(Math.round((1 - price / r) * 100));
        }
        return s;
      };
      const skus: PricingSku[] = [
        sku("input_tokens", e.prices.inputPerM, ref?.inputPerM),
        sku("output_tokens", e.prices.outputPerM, ref?.outputPerM),
      ];
      if (e.prices.cacheReadPerM > 0) skus.push(sku("cache_read_tokens", e.prices.cacheReadPerM, ref?.cacheReadPerM));
      if (e.prices.cacheWritePerM > 0) skus.push(sku("cache_write_tokens", e.prices.cacheWritePerM, ref?.cacheWritePerM));
      return {
        id: e.modelId,
        name: e.displayName,
        owned_by: e.platform,
        providers: base?.providers ?? [e.platform],
        available: true,
        currency: "USD",
        pricing_mode: base?.pricing_mode ?? "fixed",
        tags: base?.tags ?? [],
        architecture: base?.architecture ?? {
          modality: "text->text",
          input_modalities: ["text"],
          output_modalities: ["text"],
        },
        pricing_skus: skus,
      };
    });
}

export type { TokenUsage };
