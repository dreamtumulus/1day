import { estimateRequestTokens } from "./usage.js";
import type { Json, TokenUsage } from "./types.js";

function asksForCaching(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(asksForCaching);
  const object = value as Json;
  if (object.cache_control || object.cacheControl) return true;
  return Object.values(object).some(asksForCaching);
}

export function clientVisibleUsage(raw: TokenUsage, native: boolean, originalRequest: Json, upstreamBody: Json): TokenUsage {
  if (native) return raw;
  let overhead = estimateRequestTokens({ system: Array.isArray(upstreamBody.system) ? upstreamBody.system.slice(0, 3) : [] });
  const read = Math.max(0, (raw.cache_read_tokens ?? 0) - Math.min(raw.cache_read_tokens ?? 0, overhead));
  overhead -= Math.min(raw.cache_read_tokens ?? 0, overhead);
  let h1 = raw.cache_write_1h_tokens ?? 0;
  let m5 = raw.cache_write_5m_tokens ?? 0;
  const h1Deducted = Math.min(h1, overhead);
  h1 -= h1Deducted;
  overhead -= h1Deducted;
  const m5Deducted = Math.min(m5, overhead);
  m5 -= m5Deducted;
  overhead -= m5Deducted;
  let input = Math.max(0, raw.input_tokens - Math.min(raw.input_tokens, overhead));
  if (!asksForCaching(originalRequest)) {
    input += h1 + m5;
    h1 = 0;
    m5 = 0;
  }
  return {
    ...raw,
    input_tokens: input,
    cache_read_tokens: read,
    cache_write_tokens: h1 + m5,
    cache_write_5m_tokens: m5,
    cache_write_1h_tokens: h1,
  };
}
