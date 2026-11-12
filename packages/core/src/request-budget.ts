import { one, run, tx } from "./db.js";
import { q8 } from "./money.js";

const LEASE_MS = 90_000;
function limit(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
/**
 * Why a request was not admitted (X-55):
 *  - insufficient_funds: balance + remaining credit is 0 or less;
 *  - key_quota_exhausted: the API key has used up its quota;
 *  - concurrency_cap: the user already has `maxInflight` requests in flight;
 *  - reserved_spending_cap: in-flight requests already reserve the user's in-flight spending cap — which is the
 *    available balance itself unless a lower cap is set (`capIsBalance`);
 *  - key_quota_reserved: in-flight requests on this key already reserve what is left of its quota.
 */
export type AdmissionRefusalReason = "insufficient_funds" | "key_quota_exhausted" | "concurrency_cap" | "rate_cap" | "reserved_spending_cap" | "key_quota_reserved";
export interface AdmissionRefusal {
  ok: false;
  reason: AdmissionRefusalReason;
  /** The user's requests in flight / the cap that applies (null when the user or key row is gone). */
  inFlight: number | null;
  maxInflight: number | null;
  /** Requests the user had admitted in the last 60 s / the per-minute cap (X-72; null = no cap, or no user row). */
  rpm: number | null;
  maxRpm: number | null;
  /** USD reserved by the user's in-flight requests / the in-flight spending cap (null = no cap known). */
  reservedUsd: number | null;
  capUsd: number | null;
  /** The cap is the user's available balance + credit, not a configured in-flight limit. */
  capIsBalance: boolean;
  availableUsd: number | null;
  /** What is left of the key's quota (null = the key has no quota) and what its in-flight requests reserve. */
  keyRemainingUsd: number | null;
  keyReservedUsd: number | null;
  /** What this request wanted to reserve. */
  wantedUsd: number;
}
export type AdmissionDecision = { ok: true } | AdmissionRefusal;

// X-72: requests admitted per user in the last RPM_WINDOW_MS, in this process (one live gateway; a blue/green switch
// starts the window empty, which only ever admits more). The cap is `users.max_rpm` (admin console), else USER_MAX_RPM;
// neither set = unlimited. It bounds how often one caller can make the gateway work (X-71: 60% of a day's requests from
// one key, each one a new conversation), where the in-flight cap alone does not — short requests never pile up.
const RPM_WINDOW_MS = 60_000;
const rpmHits = new Map<string, number[]>();
function rpmDefault(): number {
  const n = Number(process.env.USER_MAX_RPM);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : Infinity;
}
function rpmCount(userId: string, now: number): number {
  const cutoff = now - RPM_WINDOW_MS;
  const arr = (rpmHits.get(userId) ?? []).filter((t) => t > cutoff);
  if (arr.length === 0) rpmHits.delete(userId);
  else rpmHits.set(userId, arr);
  if (rpmHits.size > 20_000) for (const [k, v] of rpmHits) if (!v.some((t) => t > cutoff)) rpmHits.delete(k);
  return arr.length;
}
function rpmRecord(userId: string, now: number): void {
  const arr = rpmHits.get(userId) ?? [];
  arr.push(now);
  rpmHits.set(userId, arr);
}
/** Tests only: forget every user's per-minute window. */
export function resetRequestRateWindows(): void {
  rpmHits.clear();
}

/** Shared admission limits include every gateway, API Key and in-flight request. */
export function acquireRequestBudget(requestId: string, userId: string, apiKeyId: string, estimatedUsd: number): boolean {
  return acquireRequestBudgetDetailed(requestId, userId, apiKeyId, estimatedUsd).ok;
}

/** `acquireRequestBudget` that says why it refused (same decision, same reservation). */
export function acquireRequestBudgetDetailed(requestId: string, userId: string, apiKeyId: string, estimatedUsd: number): AdmissionDecision {
  if (!Number.isFinite(estimatedUsd) || estimatedUsd < 0) throw new RangeError("invalid request budget estimate");
  return tx((): AdmissionDecision => {
    const now = Date.now();
    run("DELETE FROM gateway_request_budgets WHERE expires_at <= ?", now);
    if (one("SELECT 1 FROM gateway_request_budgets WHERE request_id = ?", requestId)) return { ok: true };
    const num = (v: number | null | undefined): number | null => (typeof v === "number" && Number.isFinite(v) ? q8(v) : null);
    const funds = one<{ available: number; remaining: number | null; max_inflight: number | null; max_inflight_usd: number | null; max_rpm: number | null }>(`SELECT
      u.credit_limit_usd - u.credit_used_usd + u.balance_usd AS available,
      CASE WHEN k.quota_usd > 0 THEN k.quota_usd - k.used_usd ELSE NULL END AS remaining,
      u.max_inflight, u.max_inflight_usd, u.max_rpm
      FROM users u JOIN api_keys k ON k.user_id = u.id WHERE u.id = ? AND k.id = ?`, userId, apiKeyId);
    if (!funds || !Number.isFinite(funds.available) || funds.available <= 0
      || (funds.remaining !== null && (!Number.isFinite(funds.remaining) || funds.remaining <= 0))) {
      const noFunds = !funds || !Number.isFinite(funds.available) || funds.available <= 0;
      return { ok: false, reason: noFunds ? "insufficient_funds" : "key_quota_exhausted", inFlight: null, maxInflight: null, rpm: null, maxRpm: null, reservedUsd: null, capUsd: null, capIsBalance: false,
        availableUsd: num(funds?.available), keyRemainingUsd: num(funds?.remaining), keyReservedUsd: null, wantedUsd: q8(estimatedUsd) };
    }
    const maxRpm = funds.max_rpm && funds.max_rpm > 0 ? Math.floor(funds.max_rpm) : rpmDefault();
    const rpm = rpmCount(userId, now);
    if (rpm >= maxRpm) {
      return { ok: false, reason: "rate_cap", inFlight: null, maxInflight: null, rpm, maxRpm, reservedUsd: null, capUsd: null, capIsBalance: false,
        availableUsd: num(funds.available), keyRemainingUsd: num(funds.remaining), keyReservedUsd: null, wantedUsd: q8(estimatedUsd) };
    }
    const user = one<{ n: number; reserved: number }>("SELECT COUNT(*) AS n, COALESCE(SUM(reserved_usd),0) AS reserved FROM gateway_request_budgets WHERE user_id = ?", userId)!;
    const key = one<{ reserved: number }>("SELECT COALESCE(SUM(reserved_usd),0) AS reserved FROM gateway_request_budgets WHERE api_key_id = ?", apiKeyId)!;
    // Per-user overrides (migration 29, admin console → user → 并发上限); the env values stay the defaults.
    // Defaults since 2026-11-10 (operator decision, X-52): 1000 concurrent requests and no separate in-flight spending
    // cap. The reservation is still bounded by what the user can pay (`available`) and by the key's remaining quota,
    // so concurrent requests cannot overdraw a balance; USER_MAX_INFLIGHT_USD (a positive number) brings a cap back.
    const maxInflight = funds.max_inflight && funds.max_inflight > 0 ? funds.max_inflight : limit("USER_MAX_INFLIGHT", 1000);
    const cap = Math.min(funds.available, funds.max_inflight_usd && funds.max_inflight_usd > 0 ? funds.max_inflight_usd : limit("USER_MAX_INFLIGHT_USD", Infinity));
    // One postpaid request may overrun its final balance; it reserves the whole
    // remaining budget so that concurrent requests cannot multiply that exposure.
    const reserve = q8(Math.min(Math.max(0.000001, estimatedUsd), cap, funds.remaining ?? Infinity));
    const reason: AdmissionRefusalReason | null = user.n >= Math.floor(maxInflight) ? "concurrency_cap"
      : user.reserved + reserve > cap + 1e-9 ? "reserved_spending_cap"
      : funds.remaining !== null && key.reserved + reserve > funds.remaining + 1e-9 ? "key_quota_reserved" : null;
    if (reason) {
      return { ok: false, reason, inFlight: user.n, maxInflight: Math.floor(maxInflight), rpm, maxRpm: Number.isFinite(maxRpm) ? maxRpm : null, reservedUsd: num(user.reserved), capUsd: num(cap), capIsBalance: cap >= funds.available,
        availableUsd: num(funds.available), keyRemainingUsd: num(funds.remaining), keyReservedUsd: num(key.reserved), wantedUsd: reserve };
    }
    run("INSERT INTO gateway_request_budgets(request_id,user_id,api_key_id,reserved_usd,expires_at) VALUES (?,?,?,?,?)",
      requestId, userId, apiKeyId, reserve, now + LEASE_MS);
    rpmRecord(userId, now);
    return { ok: true };
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
