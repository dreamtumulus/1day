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

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  cache_write_5m_tokens?: number;
  cache_write_1h_tokens?: number;
}

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

/** USD cost for a token usage record, based on catalog pricing SKUs. */
export function estimateCost(modelId: string, usage: TokenUsage): number {
  const entry = getPricing(modelId);
  if (!entry) return 0;
  let total = 0;
  for (const sku of entry.pricing_skus) {
    const qty = usage[sku.meter as keyof TokenUsage];
    if (typeof qty !== "number" || qty <= 0) continue;
    total += (qty / sku.quantity) * Number(sku.price_usd);
  }
  return total;
}
