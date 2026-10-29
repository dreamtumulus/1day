import { one, run, tx } from "./db.js";
import { q8 } from "./money.js";

const LEASE_MS = 90_000;
function limit(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
/** Shared admission limits include every gateway, API Key and in-flight request. */
export function acquireRequestBudget(requestId: string, userId: string, apiKeyId: string, estimatedUsd: number): boolean {
  if (!Number.isFinite(estimatedUsd) || estimatedUsd < 0) throw new RangeError("invalid request budget estimate");
  return tx(() => {
    const now = Date.now();
    run("DELETE FROM gateway_request_budgets WHERE expires_at <= ?", now);
    if (one("SELECT 1 FROM gateway_request_budgets WHERE request_id = ?", requestId)) return true;
    const funds = one<{ available: number; remaining: number | null; max_inflight: number | null; max_inflight_usd: number | null }>(`SELECT
      u.credit_limit_usd - u.credit_used_usd + u.balance_usd AS available,
      CASE WHEN k.quota_usd > 0 THEN k.quota_usd - k.used_usd ELSE NULL END AS remaining,
      u.max_inflight, u.max_inflight_usd
      FROM users u JOIN api_keys k ON k.user_id = u.id WHERE u.id = ? AND k.id = ?`, userId, apiKeyId);
    if (!funds || !Number.isFinite(funds.available) || funds.available <= 0
      || (funds.remaining !== null && (!Number.isFinite(funds.remaining) || funds.remaining <= 0))) return false;
    const user = one<{ n: number; reserved: number }>("SELECT COUNT(*) AS n, COALESCE(SUM(reserved_usd),0) AS reserved FROM gateway_request_budgets WHERE user_id = ?", userId)!;
    const key = one<{ reserved: number }>("SELECT COALESCE(SUM(reserved_usd),0) AS reserved FROM gateway_request_budgets WHERE api_key_id = ?", apiKeyId)!;
    // Per-user overrides (migration 29, admin console → user → 并发上限); the env values stay the defaults.
    const maxInflight = funds.max_inflight && funds.max_inflight > 0 ? funds.max_inflight : limit("USER_MAX_INFLIGHT", 4);
    const cap = Math.min(funds.available, funds.max_inflight_usd && funds.max_inflight_usd > 0 ? funds.max_inflight_usd : limit("USER_MAX_INFLIGHT_USD", 10));
    // One postpaid request may overrun its final balance; it reserves the whole
    // remaining budget so that concurrent requests cannot multiply that exposure.
    const reserve = q8(Math.min(Math.max(0.000001, estimatedUsd), cap, funds.remaining ?? Infinity));
    if (user.n >= Math.floor(maxInflight) || user.reserved + reserve > cap + 1e-9
      || (funds.remaining !== null && key.reserved + reserve > funds.remaining + 1e-9)) return false;
    run("INSERT INTO gateway_request_budgets(request_id,user_id,api_key_id,reserved_usd,expires_at) VALUES (?,?,?,?,?)",
      requestId, userId, apiKeyId, reserve, now + LEASE_MS);
    return true;
  });
}
export function renewRequestBudget(requestId: string): void {
  const now = Date.now();
  const result = run("UPDATE gateway_request_budgets SET expires_at = ? WHERE request_id = ? AND expires_at > ?", now + LEASE_MS, requestId, now);
  if (result.changes !== 1) throw new Error("request budget lease lost");
}
export function releaseRequestBudget(requestId: string): void {
  run("DELETE FROM gateway_request_budgets WHERE request_id = ?", requestId);
}
