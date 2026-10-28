export class ApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, message: string, code = "http_error") {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  let res: Response;
  try {
    res = await fetch(path, { credentials: "include", ...init, headers });
  } catch {
    throw new ApiError(0, "network_error", "network_error");
  }
  const text = await res.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = undefined;
  }
  if (!res.ok) {
    const err = (body as { error?: { code?: string; message?: string } } | undefined)
      ?.error;
    throw new ApiError(
      res.status,
      err?.message || `${res.status} ${res.statusText}`,
      err?.code || "http_error",
    );
  }
  return body as T;
}

/** Unwrap `{ data: ... }` envelopes (console responses). */
export function unwrap<T>(body: unknown): T {
  const d = (body as { data?: unknown } | undefined)?.data;
  return (d === undefined ? body : d) as T;
}

/** Unwrap `{ data: [...] }` / `{ object: "list", data: [...] }` envelopes. */
export function listData<T>(body: unknown): T[] {
  if (Array.isArray(body)) return body as T[];
  const d = (body as { data?: unknown } | undefined)?.data;
  return Array.isArray(d) ? (d as T[]) : [];
}

export interface CatalogModel {
  modelId: string;
  displayName: string;
  vendor: string;
  providers: string[];
  status: string;
  modelFamily: string;
  contextWindow: number;
  maxOutputTokens: number;
}

export interface PricingSku {
  sku_id: string;
  meter: string;
  unit: string;
  quantity: number;
  price_usd: string;
  reference_price_usd?: string;
  savings_pct?: string;
}

export interface PricingEntry {
  id: string;
  name: string;
  owned_by: string;
  available: boolean;
  currency: string;
  pricing_mode: string;
  pricing_skus: PricingSku[];
}

export type Role = "admin" | "consumer" | "provider" | "ops";

/** GET /auth/me (docs/v3-design.md §8.1). */
export interface AuthMe {
  id: string;
  role: Role;
  name: string;
  status: string;
  keyPreview: string;
  balanceUsd: number;
  creditLimitUsd: number;
  creditUsedUsd: number;
  availableUsd: number;
}

export function fmtUsd(n: number | string | undefined, digits = 4): string {
  const v = typeof n === "string" ? Number(n) : n;
  if (v == null || Number.isNaN(v)) return "—";
  return `$${v.toFixed(digits)}`;
}

export function fmtTokens(n: number | undefined): string {
  if (n == null) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}
