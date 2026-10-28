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
  for (const r of rows.values()) if (!catalogIds.has(r.model_id)) out.push(fromRow(r));
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

export function getModelEntry(modelId: string): ModelEntry | undefined {
  const row = one<PriceRow>("SELECT * FROM model_prices WHERE model_id = ?", modelId);
  const m = getModel(modelId);
  if (m) return fromCatalog(m, row);
  if (row) return fromRow(row);
  const dotted = dottedVersionAlias(modelId);
  // Dated snapshots travel upstream as written; a dotted spelling is corrected.
  const upstream = dotted ? { upstreamModelId: dotted } : {};
  for (const alias of modelIdAliases(modelId)) {
    const am = getModel(alias);
    if (am) return { ...fromCatalog(am, undefined), modelId, ...upstream };
    const arow = one<PriceRow>("SELECT * FROM model_prices WHERE model_id = ?", alias);
    if (arow) return { ...fromRow(arow), modelId, ...upstream };
  }
  return undefined;
}

/** Standard (pre-multiplier) USD cost of a request. */
export function computeCost(modelId: string, usage: TokenUsage): number {
  const row = one<PriceRow>("SELECT * FROM model_prices WHERE model_id = ?", modelId);
  if (!row) {
    for (const alias of modelIdAliases(modelId)) {
      const arow = one<PriceRow>("SELECT * FROM model_prices WHERE model_id = ?", alias);
      if (arow) return computeCostFromRow({ ...arow, model_id: modelId }, usage);
    }
    return estimateCost(dottedVersionAlias(modelId) ?? modelId, usage);
  }
  return computeCostFromRow(row, usage);
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
