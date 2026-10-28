import { applyLedger, refundCredit } from "./billing.js";
import { newId } from "./crypto.js";
import { all, one, run, tx } from "./db.js";
import { q8 } from "./money.js";
import { getSetting } from "./settings.js";
import { nowIso } from "./time.js";

// Cache-rebuild refunds (docs/data-model.md §3 cache_refunds, docs/gateway.md §6; user 2026-10-21).
//
// When a sticky conversation is forced onto another account (cooldown, failover,
// proxy down) its prompt cache is rebuilt on the new account and the client pays
// cache writes (1.25×) for tokens that would have been cache reads (0.1×) had the
// session stayed put. The gateway marks such requests (usage_logs.account_switched,
// ForceCacheBilling already bills their input at the read price); this module pays
// a percentage of the remaining excess back: first against the credit line the
// usage accrued to, the rest onto the prepaid balance. One cache_refunds row per
// user per run; the covered usage rows point at it (cache_refund_id), so a run is
// idempotent and the pending set is always "switched rows without a refund id".

export interface CacheRefundCandidate {
  id: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  rate_multiplier: number;
  actual_cost: number;
  created_at: string;
  cache_excess_usd?: number | null;
}

// Historic rows without a settlement-time snapshot remain read-only. They cannot
// be repriced safely and are deliberately excluded from automatic refunds.
const CANDIDATE_SQL = `SELECT id, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, rate_multiplier, actual_cost, u.created_at, s.cache_excess_usd
   FROM usage_logs u JOIN usage_pricing_snapshots s ON s.request_id = u.request_id
   WHERE account_switched = 1 AND cache_refund_id IS NULL AND status_code < 300`;

/** 0–100 integer; anything unparsable falls back to the default 80. */
export function cacheRefundPercent(): number {
  const n = Math.round(Number(getSetting("cache_refund_percent")));
  if (!Number.isFinite(n)) return 80;
  return Math.min(100, Math.max(0, n));
}

/** Seconds between scheduled runs; never below one hour. */
export function cacheRefundIntervalSec(): number {
  const n = Math.round(Number(getSetting("cache_refund_interval_sec")));
  return Number.isFinite(n) && n >= 3600 ? n : 86400;
}

export function cacheRefundEnabled(): boolean {
  return getSetting("cache_refund_enabled") !== "0";
}

/**
 * What this switched request paid over the no-switch price, after the group
 * multiplier: billed cost − the cost with every prompt token (input + cache read +
 * cache write) at the cache-read price. Settlement stores this value once;
 * later price changes never revalue a historical bill. Missing snapshots do
 * not participate in automatic refunds.
 */
export function cacheExcessUsd(r: CacheRefundCandidate): number {
  const excess = r.cache_excess_usd;
  if (typeof excess !== "number" || !Number.isFinite(excess) || excess < 0) return 0;
  return Math.min(q8(excess), Math.max(0, q8(r.actual_cost)));
}

export interface CacheRefundPending {
  rows: number;
  /** Σ excess (actual, after multiplier) of the rows not refunded yet. */
  excessUsd: number;
  /** excess × percent, what the next run would pay. */
  refundUsd: number;
  percent: number;
  from: string | null;
  to: string | null;
}

function summarize(rows: CacheRefundCandidate[], percent: number): CacheRefundPending {
  let excess = 0;
  let from: string | null = null;
  let to: string | null = null;
  for (const r of rows) {
    excess += cacheExcessUsd(r);
    if (!from || r.created_at < from) from = r.created_at;
    if (!to || r.created_at > to) to = r.created_at;
  }
  excess = q8(excess);
  return { rows: rows.length, excessUsd: excess, refundUsd: q8((excess * percent) / 100), percent, from, to };
}

export function pendingCacheRefund(userId: string, percent = cacheRefundPercent()): CacheRefundPending {
  return summarize(all<CacheRefundCandidate>(`${CANDIDATE_SQL} AND user_id = ? ORDER BY u.created_at`, userId), percent);
}

/** Platform-wide pending excess (admin dashboard). */
export function pendingCacheRefundAll(percent = cacheRefundPercent()): CacheRefundPending & { users: number } {
  const rows = all<CacheRefundCandidate & { user_id: string }>(`${CANDIDATE_SQL.replace("SELECT id,", "SELECT user_id, id,")} ORDER BY u.created_at`);
  return { ...summarize(rows, percent), users: new Set(rows.map((r) => r.user_id)).size };
}

export interface CacheRefundRow {
  id: string;
  user_id: string;
  rows: number;
  excess_usd: number;
  percent: number;
  refund_usd: number;
  to_credit_usd: number;
  to_balance_usd: number;
  ledger_id: string | null;
  credit_event_id: string | null;
  period_from: string | null;
  period_to: string | null;
  note: string | null;
  created_by: string | null;
  created_at: string;
}

export interface RunCacheRefundOpts {
  /** "scheduler" for the timer, otherwise the admin user id. */
  createdBy?: string | null;
  note?: string | null;
  percent?: number;
}

function fmtPeriod(from: string | null, to: string | null): string {
  const f = (s: string | null) => (s ? s.slice(0, 16).replace("T", " ") : "?");
  return `${f(from)} → ${f(to)} UTC`;
}

/**
 * Refund one user's pending switched requests. Returns null when there is nothing
 * pending. Credit first (whatever is still outstanding on the line), remainder to
 * the prepaid balance; a zero-amount run (percent 0, or excess rounds to 0) still
 * writes the cache_refunds row so the rows stop counting as pending.
 */
export function runCacheRefund(userId: string, opts: RunCacheRefundOpts = {}): CacheRefundRow | null {
  const percent = Math.min(100, Math.max(0, Math.round(opts.percent ?? cacheRefundPercent())));
  return tx(() => {
    const rows = all<CacheRefundCandidate>(`${CANDIDATE_SQL} AND user_id = ? ORDER BY u.created_at`, userId);
    if (rows.length === 0) return null;
    const pending = summarize(rows, percent);
    const id = newId();
    const now = nowIso();
    const note = opts.note ?? `缓存重建返还 ${percent}% · ${rows.length} 笔请求 · ${fmtPeriod(pending.from, pending.to)}`;
    let toCredit = 0;
    let creditEventId: string | null = null;
    let ledgerId: string | null = null;
    let toBalance = 0;
    if (pending.refundUsd > 0) {
      const u = one<{ credit_used_usd: number }>("SELECT credit_used_usd FROM users WHERE id = ?", userId);
      if (!u) throw new Error(`user ${userId} not found`);
      if (u.credit_used_usd > 0) {
        const r = refundCredit(userId, pending.refundUsd, { note, createdBy: opts.createdBy ?? null });
        toCredit = r.refundedUsd;
        creditEventId = r.eventId;
      }
      toBalance = q8(pending.refundUsd - toCredit);
      if (toBalance > 0) {
        ledgerId = applyLedger(userId, "cache_refund", toBalance, { ref: id, note, createdBy: opts.createdBy ?? null }).ledgerId;
      }
    }
    run(
      `INSERT INTO cache_refunds (id, user_id, rows, excess_usd, percent, refund_usd, to_credit_usd, to_balance_usd, ledger_id, credit_event_id,
                                  period_from, period_to, note, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      userId,
      rows.length,
      pending.excessUsd,
      percent,
      pending.refundUsd,
      toCredit,
      toBalance,
      ledgerId,
      creditEventId,
      pending.from,
      pending.to,
      note,
      opts.createdBy ?? null,
      now,
    );
    // Bind the covered rows; chunked to stay well under SQLite's bound-parameter limit.
    for (let i = 0; i < rows.length; i += 400) {
      const chunk = rows.slice(i, i + 400).map((r) => r.id);
      run(`UPDATE usage_logs SET cache_refund_id = ? WHERE cache_refund_id IS NULL AND id IN (${chunk.map(() => "?").join(",")})`, id, ...chunk);
    }
    return one<CacheRefundRow>("SELECT * FROM cache_refunds WHERE id = ?", id)!;
  });
}

export interface CacheRefundRunSummary {
  users: number;
  rows: number;
  excessUsd: number;
  refundUsd: number;
  toCreditUsd: number;
  toBalanceUsd: number;
}

/** One run over every user with pending rows; each user is its own transaction. */
export function runCacheRefundsForAll(opts: RunCacheRefundOpts = {}): CacheRefundRunSummary {
  const users = all<{ user_id: string }>(`SELECT DISTINCT user_id FROM usage_logs WHERE account_switched = 1 AND cache_refund_id IS NULL AND status_code < 300`);
  const s: CacheRefundRunSummary = { users: 0, rows: 0, excessUsd: 0, refundUsd: 0, toCreditUsd: 0, toBalanceUsd: 0 };
  for (const { user_id } of users) {
    const r = runCacheRefund(user_id, opts);
    if (!r) continue;
    s.users++;
    s.rows += r.rows;
    s.excessUsd = q8(s.excessUsd + r.excess_usd);
    s.refundUsd = q8(s.refundUsd + r.refund_usd);
    s.toCreditUsd = q8(s.toCreditUsd + r.to_credit_usd);
    s.toBalanceUsd = q8(s.toBalanceUsd + r.to_balance_usd);
  }
  return s;
}

// Scheduler bookkeeping lives in the settings table under a key that is not part of
// SETTING_DEFAULTS, so the admin settings form neither shows nor overwrites it.
const LAST_RUN_KEY = "cache_refund_last_run_at";

export function lastScheduledCacheRefundAt(): string | null {
  return one<{ value: string }>("SELECT value FROM settings WHERE key = ?", LAST_RUN_KEY)?.value ?? null;
}

export function markScheduledCacheRefundRun(at = nowIso()): void {
  run("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", LAST_RUN_KEY, at);
}

/** When the timer will next pay out: last run + interval, or "now" when it never ran. */
export function nextScheduledCacheRefundAt(): string {
  const last = lastScheduledCacheRefundAt();
  if (!last) return nowIso();
  const t = Date.parse(last);
  if (!Number.isFinite(t)) return nowIso();
  return new Date(t + cacheRefundIntervalSec() * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}
