import { newId } from "./crypto.js";
import { db, one, run, tx } from "./db.js";
import { canonicalModelId, computeCost, getModelEntry, validateTokenUsage, type BasicPrices, type TokenUsage } from "./models.js";
import { q8 } from "./money.js";
import { nowIso } from "./time.js";
import type { UpstreamErrorScope } from "./upstream-error.js";

// Settlement (docs/v3-design.md §7.4): one IMMEDIATE transaction; the unique
// usage_logs.request_id makes replays no-ops.

export interface SettleInput {
  requestId: string;
  userId: string;
  apiKeyId: string;
  groupId: string | null;
  rateMultiplier: number;
  accountId: string | null;
  providerId: string | null; // account owner when it is a provider
  payoutRate: number;
  model: string;
  upstreamModel: string | null;
  actualModel?: string | null;
  endpoint: string;
  stream: boolean;
  statusCode: number;
  errorCode?: string | null;
  errorScope?: UpstreamErrorScope | null;
  retryable?: boolean | null;
  credentialVersion?: number | null;
  executionSequence?: number | null;
  usage: TokenUsage;
  usageEstimated: boolean;
  durationMs?: number | null;
  firstTokenMs?: number | null;
  selectionMs?: number | null;
  streamTruncated?: boolean;
  toolCalls?: number;
  toolResults?: number;
  clientIp?: string | null;
  /** Claude Code shape verdict for CC-UA requests (docs/gateway.md §2a); null = not a CC-UA request. */
  ccShape?: "genuine" | "suspect" | null;
  /** Worker/cloud lane (migration 39): upstream retries Claude Code performed inside the turn; null = not a CCR turn. */
  upstreamRetries?: number | null;
  /** Observability (migration 10): why it failed, which path served it, which node. */
  errorMessage?: string | null;
  mode?: string | null;
  upstreamStatus?: number | null;
  nodeId?: string | null;
  /**
   * The request had a live sticky session but ran on another account (gateway
   * ForceCacheBilling): its prompt cache was rebuilt through no fault of the
   * client. Marked for the periodic cache refund (cache-refund.ts).
   */
  accountSwitched?: boolean;
  /** Provenance (migration 30): the serving account's organization and bound proxy at request time. */
  teamId?: string | null;
  proxyId?: string | null;
}

export interface SettleResult {
  settled: boolean; // false = duplicate request_id or a durably queued retry
  pending?: boolean;
  totalCost: number;
  actualCost: number;
  providerEarning: number;
}

export interface SettlementPricing {
  modelId: string;
  prices: BasicPrices | null;
  totalCost: number;
  actualCost: number;
  providerEarning: number;
  cacheExcessUsd: number;
}

/** Capture the tariff once; journal retries must never consult a later price. */
export function prepareSettlementPricing(p: SettleInput): SettlementPricing {
  validateTokenUsage(p.usage);
  for (const n of [p.rateMultiplier, p.payoutRate]) {
    if (!Number.isFinite(n) || n < 0) throw new RangeError("invalid settlement rate");
  }
  if (p.payoutRate > 1) throw new RangeError("provider payout rate must not exceed one");
  const ok = p.statusCode >= 200 && p.statusCode < 300;
  const totalCost = ok ? q8(computeCost(p.model, p.usage)) : 0;
  const actualCost = q8(totalCost * p.rateMultiplier);
  // A free group (rate_multiplier 0) is a self-use pool — the provider consuming its own supply —
  // so nothing was collected and nothing is shared (docs/data-model.md §3, 2026-10-29).
  const providerEarning = p.providerId && p.rateMultiplier > 0 ? q8(totalCost * p.payoutRate) : 0;
  const prompt = p.usage.input_tokens + (p.usage.cache_read_tokens ?? 0) + (p.usage.cache_write_tokens ?? 0)
    + (p.usage.cache_write_5m_tokens ?? 0) + (p.usage.cache_write_1h_tokens ?? 0);
  const ideal = ok && p.accountSwitched ? computeCost(p.model, {
    input_tokens: 0, output_tokens: p.usage.output_tokens, cache_read_tokens: prompt,
  }) : totalCost;
  return {
    modelId: canonicalModelId(p.model), prices: getModelEntry(p.model)?.prices ?? null,
    totalCost, actualCost, providerEarning,
    cacheExcessUsd: Math.min(actualCost, q8(Math.max(0, totalCost - ideal) * p.rateMultiplier)),
  };
}

export function settleRequest(p: SettleInput): SettleResult {
  return settlePreparedRequest(p, prepareSettlementPricing(p));
}

/** Internal journal entry point: the persisted tariff, counts and amounts are revalidated. */
export function settlePreparedRequest(p: SettleInput, price: SettlementPricing): SettleResult {
  validateTokenUsage(p.usage);
  for (const n of [price.totalCost, price.actualCost, price.providerEarning, price.cacheExcessUsd, p.rateMultiplier]) {
    if (!Number.isFinite(n) || n < 0) throw new RangeError("invalid persisted settlement");
    q8(n);
  }
  const { totalCost, actualCost, providerEarning } = price;
  const ok = p.statusCode >= 200 && p.statusCode < 300;
  const now = nowIso();

  return tx(() => {
    const columns = [
      "id", "request_id", "user_id", "api_key_id", "group_id", "account_id", "provider_id", "model", "upstream_model",
      "endpoint", "stream", "status_code", "error_code", "input_tokens", "output_tokens", "cache_read_tokens",
      "cache_write_tokens", "usage_estimated", "total_cost", "rate_multiplier", "actual_cost", "provider_earning",
      "duration_ms", "first_token_ms", "client_ip", "cc_shape", "error_message", "mode", "upstream_status", "node_id",
      "account_switched", "team_id", "proxy_id", "actual_model", "selection_ms", "stream_truncated", "tool_calls",
      "tool_results", "error_scope", "retryable", "credential_version", "execution_sequence", "upstream_retries", "created_at",
    ];
    const ins = db
      .prepare(
        `INSERT INTO usage_logs (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})
         ON CONFLICT(request_id) DO NOTHING`,
      )
      .run(
        newId(),
        p.requestId,
        p.userId,
        p.apiKeyId,
        p.groupId,
        p.accountId,
        p.providerId,
        p.model,
        p.upstreamModel,
        p.endpoint,
        p.stream ? 1 : 0,
        p.statusCode,
        p.errorCode ?? null,
        p.usage.input_tokens,
        p.usage.output_tokens,
        p.usage.cache_read_tokens ?? 0,
        (p.usage.cache_write_tokens ?? 0) + (p.usage.cache_write_5m_tokens ?? 0) + (p.usage.cache_write_1h_tokens ?? 0),
        p.usageEstimated ? 1 : 0,
        totalCost,
        p.rateMultiplier,
        actualCost,
        providerEarning,
        p.durationMs ?? null,
        p.firstTokenMs ?? null,
        p.clientIp ?? null,
        p.ccShape ?? null,
        p.errorMessage ? p.errorMessage.slice(0, 1000) : null,
        p.mode ?? null,
        p.upstreamStatus ?? null,
        p.nodeId ?? null,
        p.accountSwitched && ok ? 1 : 0,
        p.teamId ?? null,
        p.proxyId ?? null,
        p.actualModel ?? null,
        p.selectionMs ?? null,
        p.streamTruncated ? 1 : 0,
        p.toolCalls ?? 0,
        p.toolResults ?? 0,
        p.errorScope ?? null,
        p.retryable === undefined || p.retryable === null ? null : p.retryable ? 1 : 0,
        p.credentialVersion ?? null,
        p.executionSequence ?? null,
        p.upstreamRetries ?? null,
        now,
      );
    if (Number(ins.changes) === 0) {
      return { settled: false, totalCost: 0, actualCost: 0, providerEarning: 0 };
    }
    run(`INSERT INTO usage_pricing_snapshots
      (request_id,model_id,pricing_json,total_cost,cache_excess_usd,created_at) VALUES (?,?,?,?,?,?)`,
      p.requestId, price.modelId, JSON.stringify(price), totalCost, price.cacheExcessUsd, now);
    if (actualCost > 0) {
      // Charge order (docs/data-model.md §4): any positive prepaid balance first, the rest accrues to the
      // credit line (credit_used_usd). Overdraft allowed: the request already happened, never drop the
      // charge; admission (gateway auth) is what stops the next request once the line is exhausted.
      // All right-hand sides read the pre-update row, so both columns are derived from the same balance.
      // A user without a credit line (limit 0) keeps the old prepaid behaviour: the whole charge hits the
      // balance, overdraft included, so nothing changes for them.
      run(
        `UPDATE users SET
           credit_used_usd = round(credit_used_usd + CASE WHEN credit_limit_usd > 0 THEN max(0, ? - max(balance_usd, 0)) ELSE 0 END, 8),
           balance_usd = round(balance_usd - CASE WHEN credit_limit_usd > 0 THEN min(?, max(balance_usd, 0)) ELSE ? END, 8)
         WHERE id = ?`,
        actualCost,
        actualCost,
        actualCost,
        p.userId,
      );
    }
    run(
      "UPDATE api_keys SET used_usd = round(used_usd + ?, 8), last_used_at = ? WHERE id = ?",
      actualCost,
      now,
      p.apiKeyId,
    );
    if (providerEarning > 0 && p.providerId) {
      run("UPDATE users SET balance_usd = round(balance_usd + ?, 8) WHERE id = ?", providerEarning, p.providerId);
    }
    return { settled: true, totalCost, actualCost, providerEarning };
  });
}

// ---------- credit line (docs/data-model.md §4, 2026-10-19) ----------

export interface CreditSummary {
  creditLimitUsd: number;
  creditUsedUsd: number;
  balanceUsd: number;
  /** What admission compares against 0: limit − used + prepaid balance. */
  availableUsd: number;
  creditSettledAt: string | null;
}

export function availableUsd(u: { credit_limit_usd: number; credit_used_usd: number; balance_usd: number }): number {
  return q8(u.credit_limit_usd - u.credit_used_usd + u.balance_usd);
}

export function creditSummary(userId: string): CreditSummary | null {
  const u = one<{ credit_limit_usd: number; credit_used_usd: number; balance_usd: number; credit_settled_at: string | null }>(
    "SELECT credit_limit_usd, credit_used_usd, balance_usd, credit_settled_at FROM users WHERE id = ?",
    userId,
  );
  if (!u) return null;
  return {
    creditLimitUsd: u.credit_limit_usd,
    creditUsedUsd: u.credit_used_usd,
    balanceUsd: u.balance_usd,
    availableUsd: availableUsd(u),
    creditSettledAt: u.credit_settled_at,
  };
}

export type CreditEventKind = "limit_set" | "settlement" | "cache_refund";

function recordCreditEvent(
  userId: string,
  kind: CreditEventKind,
  amount: number,
  before: { credit_limit_usd: number; credit_used_usd: number },
  after: { credit_limit_usd: number; credit_used_usd: number },
  opts: { note?: string | null; createdBy?: string | null },
): string {
  const id = newId();
  run(
    `INSERT INTO credit_events (id, user_id, kind, amount_usd, limit_before, limit_after, used_before, used_after, note, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    userId,
    kind,
    q8(amount),
    before.credit_limit_usd,
    after.credit_limit_usd,
    before.credit_used_usd,
    after.credit_used_usd,
    opts.note ?? null,
    opts.createdBy ?? null,
    nowIso(),
  );
  return id;
}

function creditRow(userId: string): { credit_limit_usd: number; credit_used_usd: number; balance_usd: number } {
  const u = one<{ credit_limit_usd: number; credit_used_usd: number; balance_usd: number }>(
    "SELECT credit_limit_usd, credit_used_usd, balance_usd FROM users WHERE id = ?",
    userId,
  );
  if (!u) throw new Error(`user ${userId} not found`);
  return u;
}

/** Admin sets (or changes) the credit line. Must run inside tx(). */
export function setCreditLimit(userId: string, limitUsd: number, opts: { note?: string | null; createdBy?: string | null } = {}): CreditSummary {
  const limit = q8(Math.max(0, limitUsd));
  const before = creditRow(userId);
  run("UPDATE users SET credit_limit_usd = ? WHERE id = ?", limit, userId);
  const after = creditRow(userId);
  recordCreditEvent(userId, "limit_set", limit - before.credit_limit_usd, before, after, opts);
  return creditSummary(userId)!;
}

/**
 * Admin settles what the user owes: `amountUsd` (null = everything outstanding)
 * is taken off credit_used_usd, which restores that much of the line. Paying more
 * than is outstanding is rejected (use adjust-balance for prepaid top-ups).
 * Must run inside tx().
 */
export function settleCredit(userId: string, amountUsd: number | null, opts: { note?: string | null; createdBy?: string | null } = {}): CreditSummary & { settledUsd: number } {
  const before = creditRow(userId);
  const outstanding = q8(before.credit_used_usd);
  const amount = amountUsd === null ? outstanding : q8(amountUsd);
  if (amount <= 0) throw new Error("nothing to settle");
  if (amount > outstanding + 1e-9) throw new Error(`amount exceeds outstanding (${outstanding.toFixed(4)})`);
  run("UPDATE users SET credit_used_usd = round(credit_used_usd - ?, 8), credit_settled_at = ? WHERE id = ?", amount, nowIso(), userId);
  const after = creditRow(userId);
  recordCreditEvent(userId, "settlement", amount, before, after, opts);
  return { ...creditSummary(userId)!, settledUsd: amount };
}

/**
 * Give back part of what accrued to the credit line without touching
 * credit_settled_at (this is not a settlement by the user): `amountUsd` is taken
 * off credit_used_usd, capped at what is outstanding. Returns the credit_events
 * id, or null when nothing was outstanding. Must run inside tx().
 */
export function refundCredit(userId: string, amountUsd: number, opts: { note?: string | null; createdBy?: string | null } = {}): { eventId: string | null; refundedUsd: number } {
  const before = creditRow(userId);
  const amount = q8(Math.min(Math.max(0, amountUsd), Math.max(0, before.credit_used_usd)));
  if (amount <= 0) return { eventId: null, refundedUsd: 0 };
  run("UPDATE users SET credit_used_usd = round(credit_used_usd - ?, 8) WHERE id = ?", amount, userId);
  const after = creditRow(userId);
  return { eventId: recordCreditEvent(userId, "cache_refund", amount, before, after, opts), refundedUsd: amount };
}

// ---------- ledger helpers (redeem / admin adjust / payout / cache refund) ----------

export type LedgerKind = "redeem" | "admin_adjust" | "payout" | "legacy_topup" | "cache_refund";

/** Apply a balance change and write the ledger row. Must run inside tx(). */
export function applyLedger(
  userId: string,
  kind: LedgerKind,
  amountUsd: number,
  opts: { ref?: string | null; note?: string | null; createdBy?: string | null } = {},
): { balanceAfter: number; ledgerId: string } {
  const amount = q8(amountUsd);
  run("UPDATE users SET balance_usd = round(balance_usd + ?, 8) WHERE id = ?", amount, userId);
  const u = one<{ balance_usd: number }>("SELECT balance_usd FROM users WHERE id = ?", userId);
  if (!u) throw new Error(`user ${userId} not found`);
  const ledgerId = newId();
  run(
    `INSERT INTO ledger (id, user_id, kind, amount_usd, balance_after, ref, note, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ledgerId,
    userId,
    kind,
    amount,
    u.balance_usd,
    opts.ref ?? null,
    opts.note ?? null,
    opts.createdBy ?? null,
    nowIso(),
  );
  return { balanceAfter: u.balance_usd, ledgerId };
}
