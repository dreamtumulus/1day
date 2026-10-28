import { INTERNAL_HEADER, internalToken } from "@1dayapi/core";

// Best-effort loopback read of the gateway's live per-account in-flight counts
// (GET {GATEWAY_URL}/internal/inflight, shared internal.key). The gateway keeps
// these in memory, so the console asks it instead of the DB. Any failure
// (gateway down, wrong token) yields null and the UI shows "—"; a short cache
// keeps page reloads from hammering the gateway.

const GATEWAY_URL = (process.env.GATEWAY_URL ?? "http://127.0.0.1:8400").replace(/\/+$/, "");
const CACHE_MS = 2_000;
const TIMEOUT_MS = 800;

let cached: { at: number; data: Record<string, number> | null } | null = null;

export async function gatewayInFlight(): Promise<Record<string, number> | null> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.data;
  let data: Record<string, number> | null = null;
  try {
    const res = await fetch(`${GATEWAY_URL}/internal/inflight`, {
      headers: { [INTERNAL_HEADER]: internalToken },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.ok) data = ((await res.json()) as { data?: Record<string, number> }).data ?? {};
  } catch {
    data = null;
  }
  cached = { at: Date.now(), data };
  return data;
}
