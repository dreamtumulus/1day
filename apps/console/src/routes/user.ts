import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  all,
  applyLedger,
  cacheRefundEnabled,
  cacheRefundIntervalSec,
  cacheRefundPercent,
  decryptString,
  encryptString,
  generateApiKey,
  getSetting,
  newId,
  nowIso,
  one,
  lastScheduledCacheRefundAt,
  nextScheduledCacheRefundAt,
  parseIsoInput,
  pendingCacheRefund,
  run,
  tx, HISTORY_POLICIES, type HistoryPolicy } from "@1dayapi/core";
import {
  Where,
  bad,
  body,
  dateRange,
  notFound,
  num,
  page,
  paged,
  query,
  str,
  type Body,
} from "../http.js";
import { requireConsumer } from "../session.js";
import {
  API_KEY_SELECT,
  apiKeyShape,
  availableGroups,
  cacheRefundShape,
  dailySeries,
  groupShape,
  creditEventShape,
  ledgerShape,
  monthStart,
  periodTotals,
  todayStart,
  usageShape,
  type ApiKeyRow,
  type UsageRowDb,
} from "../shapes.js";

// Consumer self-service (docs/v3-design.md §8.2). Admins may use these too.

function loadOwnKey(req: FastifyRequest, id: string): ApiKeyRow {
  const k = one<ApiKeyRow>(`${API_KEY_SELECT} WHERE k.id = ? AND k.user_id = ?`, id, req.user!.id);
  if (!k) notFound("key");
  return k;
}

/** Shared validation for key create/patch. `restrictGroups` = only groups the owner may use. */
export function applyKeyFields(
  b: Body,
  ownerId: string,
  restrictGroups: boolean,
): { name?: string; groupId?: string; quotaUsd?: number; expiresAt?: string | null; status?: string; policyJson?: string | null } {
  const out: { name?: string; groupId?: string; quotaUsd?: number; expiresAt?: string | null; status?: string; policyJson?: string | null } = {};
  const name = str(b, "name", { max: 64 });
  if (name !== undefined) out.name = name;
  const groupId = str(b, "groupId");
  if (groupId !== undefined) {
    const ok = restrictGroups
      ? availableGroups(ownerId).some((g) => g.id === groupId)
      : !!one("SELECT 1 FROM groups WHERE id = ?", groupId);
    if (!ok) bad("group_not_available", "This group does not exist or is not available to you");
    out.groupId = groupId;
  }
  const quota = num(b, "quotaUsd", { min: 0, max: 1e9 });
  if (quota !== undefined) out.quotaUsd = quota;
  if ("expiresAt" in b) {
    if (b.expiresAt === null || b.expiresAt === "") out.expiresAt = null;
    else {
      const iso = parseIsoInput(b.expiresAt);
      if (!iso) bad("invalid_request", "expiresAt must be an ISO date/datetime or null");
      out.expiresAt = iso;
    }
  }
  if (b.status !== undefined) {
    if (b.status !== "active" && b.status !== "disabled") bad("invalid_request", "status must be active | disabled");
    out.status = b.status;
  }
  // Routing policy (docs/gateway.md §2b): admin-only; null clears it back to the defaults.
  if (!restrictGroups && "policy" in b) {
    const p = b.policy;
    if (p === null) out.policyJson = null;
    else if (p && typeof p === "object") {
      const { historyPolicy, directOnly, probeIntercept } = p as Record<string, unknown>;
      if (historyPolicy !== undefined && !(HISTORY_POLICIES as readonly string[]).includes(String(historyPolicy))) bad("invalid_request", "policy.historyPolicy must be reset | reject | passthrough");
      if (directOnly !== undefined && typeof directOnly !== "boolean") bad("invalid_request", "policy.directOnly must be a boolean");
      if (probeIntercept !== undefined && typeof probeIntercept !== "boolean") bad("invalid_request", "policy.probeIntercept must be a boolean");
      out.policyJson = JSON.stringify({ historyPolicy: (historyPolicy as HistoryPolicy | undefined) ?? "passthrough", directOnly: directOnly === true, probeIntercept: probeIntercept !== false });
    } else bad("invalid_request", "policy must be an object or null");
  }
  return out;
}

export function updateKey(id: string, f: ReturnType<typeof applyKeyFields>): void {
  const sets: string[] = [];
  const params: unknown[] = [];
  if (f.name !== undefined) (sets.push("name = ?"), params.push(f.name));
  if (f.groupId !== undefined) (sets.push("group_id = ?"), params.push(f.groupId));
  if (f.quotaUsd !== undefined) (sets.push("quota_usd = ?"), params.push(f.quotaUsd));
  if (f.expiresAt !== undefined) (sets.push("expires_at = ?"), params.push(f.expiresAt));
  if (f.status !== undefined) (sets.push("status = ?"), params.push(f.status));
  if (f.policyJson !== undefined) (sets.push("policy_json = ?"), params.push(f.policyJson));
  if (sets.length) run(`UPDATE api_keys SET ${sets.join(", ")} WHERE id = ?`, ...params, id);
}

export function usageQuery(
  req: FastifyRequest,
  scope: { userId?: string; providerId?: string },
): { where: Where } {
  const q = query(req);
  const { from, to } = dateRange(req);
  const w = new Where();
  if (scope.userId) w.add("l.user_id = ?", scope.userId);
  if (scope.providerId) w.add("l.provider_id = ?", scope.providerId);
  w.addIf(from, "l.created_at >= ?", from);
  w.addIf(to, "l.created_at < ?", to);
  w.addIf(q.keyId, "l.api_key_id = ?", q.keyId);
  w.addIf(q.userId, "l.user_id = ?", q.userId);
  w.addIf(q.accountId, "l.account_id = ?", q.accountId);
  w.addIf(q.model, "l.model = ?", q.model);
  if (q.status === "ok") w.add("l.status_code < 300");
  if (q.status === "error") w.add("l.status_code >= 300");
  // 错误日志页过滤（docs/console-api.md）
  w.addIf(q.code, "l.error_code = ?", q.code);
  w.addIf(q.mode, "l.mode = ?", q.mode);
  w.addIf(q.nodeId, "l.node_id = ?", q.nodeId);
  if (q.statusCode && /^\d{3}$/.test(q.statusCode)) w.add("l.status_code = ?", Number(q.statusCode));
  if (q.q) w.add("(l.error_message LIKE ? OR l.error_code LIKE ? OR l.request_id = ?)", `%${q.q}%`, `%${q.q}%`, q.q);
  return { where: w };
}

export const USAGE_SELECT = `SELECT l.*, k.name AS key_name, u.name AS user_name, a.name AS account_name, pu.name AS provider_name,
  COALESCE(l.team_id, a.team_id) AS eff_team_id, COALESCE(l.proxy_id, a.bound_proxy_id) AS eff_proxy_id,
  (SELECT ut.name FROM upstream_teams ut WHERE ut.id = COALESCE(l.team_id, a.team_id)) AS team_name,
  (SELECT oo.name FROM onboard_orgs oo WHERE lower(oo.org_uuid) = lower(COALESCE(l.team_id, a.team_id)) LIMIT 1) AS org_name,
  (SELECT np.group_name FROM node_proxies np WHERE np.id = COALESCE(l.proxy_id, a.bound_proxy_id)) AS proxy_group,
  (SELECT np.exit_country FROM node_proxies np WHERE np.id = COALESCE(l.proxy_id, a.bound_proxy_id)) AS proxy_country
  FROM usage_logs l LEFT JOIN api_keys k ON k.id = l.api_key_id
  LEFT JOIN users u ON u.id = l.user_id LEFT JOIN accounts a ON a.id = l.account_id
  LEFT JOIN users pu ON pu.id = l.provider_id`;

export function usageStats(where: Where) {
  const totals = one<{ requests: number; cost: number; input: number; output: number; cache: number; cacheRead: number; cacheWrite: number }>(
    `SELECT SUM(CASE WHEN l.status_code < 300 THEN 1 ELSE 0 END) AS requests, COALESCE(SUM(l.actual_cost),0) AS cost,
            COALESCE(SUM(l.input_tokens),0) AS input, COALESCE(SUM(l.output_tokens),0) AS output,
            COALESCE(SUM(l.cache_read_tokens + l.cache_write_tokens),0) AS cache,
            COALESCE(SUM(l.cache_read_tokens),0) AS cacheRead, COALESCE(SUM(l.cache_write_tokens),0) AS cacheWrite
     FROM usage_logs l ${where.sql}`,
    ...where.params,
  );
  const daily = all<{ day: string; requests: number; cost: number; tokens: number; input: number; output: number; cacheRead: number; cacheWrite: number }>(
    `SELECT substr(l.created_at,1,10) AS day, SUM(CASE WHEN l.status_code < 300 THEN 1 ELSE 0 END) AS requests,
            COALESCE(SUM(l.actual_cost),0) AS cost,
            COALESCE(SUM(l.input_tokens + l.output_tokens + l.cache_read_tokens + l.cache_write_tokens),0) AS tokens,
            COALESCE(SUM(l.input_tokens),0) AS input, COALESCE(SUM(l.output_tokens),0) AS output,
            COALESCE(SUM(l.cache_read_tokens),0) AS cacheRead, COALESCE(SUM(l.cache_write_tokens),0) AS cacheWrite
     FROM usage_logs l ${where.sql} GROUP BY day ORDER BY day`,
    ...where.params,
  );
  const byModel = all<{ model: string; requests: number; cost: number; input: number; output: number }>(
    `SELECT l.model, COUNT(*) AS requests, COALESCE(SUM(l.actual_cost),0) AS cost,
            COALESCE(SUM(l.input_tokens),0) AS input, COALESCE(SUM(l.output_tokens),0) AS output
     FROM usage_logs l ${where.sql} GROUP BY l.model ORDER BY cost DESC, requests DESC LIMIT 50`,
    ...where.params,
  );
  return {
    totals: {
      requests: totals?.requests ?? 0,
      costUsd: totals?.cost ?? 0,
      inputTokens: totals?.input ?? 0,
      outputTokens: totals?.output ?? 0,
      cacheTokens: totals?.cache ?? 0,
      cacheReadTokens: totals?.cacheRead ?? 0,
      cacheWriteTokens: totals?.cacheWrite ?? 0,
    },
    daily: daily.map((d) => ({
      day: d.day,
      requests: d.requests,
      costUsd: d.cost,
      tokens: d.tokens,
      inputTokens: d.input,
      outputTokens: d.output,
      cacheReadTokens: d.cacheRead,
      cacheWriteTokens: d.cacheWrite,
    })),
    byModel: byModel.map((m) => ({
      model: m.model,
      requests: m.requests,
      costUsd: m.cost,
      inputTokens: m.input,
      outputTokens: m.output,
    })),
  };
}

export type UsageBucket = "hour" | "day";
export type UsageBreakdownBy = "user" | "key";

const HOUR_BUCKET_MAX_DAYS = 31;

/** `bucket` query param → hour | day (default day). */
export function usageBucket(req: FastifyRequest): UsageBucket {
  return query(req).bucket === "hour" ? "hour" : "day";
}

/**
 * Consumption over time, one cell per (bucket, series): what the finance and
 * user panels draw as hourly / daily spend per user (admin) or per key.
 * Buckets are UTC (`created_at` is UTC); `t` is the ISO start of the bucket so
 * the client can re-label hours in local time. The hour view is capped to the
 * last 31 days of the range so an open-ended "all time" request stays bounded.
 */
export function usageBreakdown(where: Where, bucket: UsageBucket, by: UsageBreakdownBy) {
  const w = new Where();
  w.parts = [...where.parts];
  w.params = [...where.params];
  if (bucket === "hour") {
    const floor = new Date(Date.now() - HOUR_BUCKET_MAX_DAYS * 86_400_000).toISOString().slice(0, 19) + "Z";
    w.add("l.created_at >= ?", floor);
  }
  const tExpr = bucket === "hour" ? "substr(l.created_at,1,13)" : "substr(l.created_at,1,10)";
  const kCol = by === "user" ? "l.user_id" : "l.api_key_id";
  const rows = all<{ t: string; k: string; requests: number; errors: number; cost: number; tokens: number; last: string }>(
    `SELECT ${tExpr} AS t, ${kCol} AS k,
            SUM(CASE WHEN l.status_code < 300 THEN 1 ELSE 0 END) AS requests,
            SUM(CASE WHEN l.status_code >= 300 THEN 1 ELSE 0 END) AS errors,
            COALESCE(SUM(l.actual_cost),0) AS cost,
            COALESCE(SUM(l.input_tokens + l.output_tokens + l.cache_read_tokens + l.cache_write_tokens),0) AS tokens,
            MAX(l.created_at) AS last
     FROM usage_logs l ${w.sql} GROUP BY t, k ORDER BY t, k LIMIT 50000`,
    ...w.params,
  );
  const ids = [...new Set(rows.map((r) => r.k))];
  const names = new Map<string, string>();
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    const table = by === "user" ? "users" : "api_keys";
    for (const r of all<{ id: string; name: string }>(`SELECT id, name FROM ${table} WHERE id IN (${chunk.map(() => "?").join(",")})`, ...chunk)) {
      names.set(r.id, r.name);
    }
  }
  const iso = (t: string) => (bucket === "hour" ? `${t}:00:00Z` : `${t}T00:00:00Z`);
  const series = new Map<string, { key: string; name: string | null; requests: number; errors: number; costUsd: number; tokens: number; lastAt: string | null }>();
  const cells = rows.map((r) => {
    const s = series.get(r.k) ?? { key: r.k, name: names.get(r.k) ?? null, requests: 0, errors: 0, costUsd: 0, tokens: 0, lastAt: null };
    s.requests += r.requests;
    s.errors += r.errors;
    s.costUsd += r.cost;
    s.tokens += r.tokens;
    if (!s.lastAt || r.last > s.lastAt) s.lastAt = r.last;
    series.set(r.k, s);
    return { t: iso(r.t), key: r.k, requests: r.requests, errors: r.errors, costUsd: r.cost, tokens: r.tokens, lastAt: r.last };
  });
  return {
    bucket,
    by,
    cells,
    series: [...series.values()].sort((a, b) => b.costUsd - a.costUsd || b.requests - a.requests),
  };
}

/** Shared by the user wallet and the admin user detail (docs/console-api.md §2/§4). */
export function cacheRefundSummary(userId: string) {
  const totals = one<{ n: number; refund: number; credit: number; balance: number; last: string | null }>(
    `SELECT COUNT(*) AS n, COALESCE(SUM(refund_usd),0) AS refund, COALESCE(SUM(to_credit_usd),0) AS credit,
            COALESCE(SUM(to_balance_usd),0) AS balance, MAX(created_at) AS last
     FROM cache_refunds WHERE user_id = ?`,
    userId,
  );
  return {
    enabled: cacheRefundEnabled(),
    percent: cacheRefundPercent(),
    intervalSec: cacheRefundIntervalSec(),
    pending: pendingCacheRefund(userId),
    lastScheduledRunAt: lastScheduledCacheRefundAt(),
    nextScheduledRunAt: nextScheduledCacheRefundAt(),
    totals: {
      runs: totals?.n ?? 0,
      refundUsd: totals?.refund ?? 0,
      toCreditUsd: totals?.credit ?? 0,
      toBalanceUsd: totals?.balance ?? 0,
      lastRefundAt: totals?.last ?? null,
    },
  };
}

export function registerUserRoutes(app: FastifyInstance): void {
  const pre = { preHandler: requireConsumer };

  app.get("/api/user/overview", pre, async (req) => {
    const uid = req.user!.id;
    const balance = one<{ balance_usd: number; credit_limit_usd: number; credit_used_usd: number; credit_settled_at: string | null }>(
      "SELECT balance_usd, credit_limit_usd, credit_used_usd, credit_settled_at FROM users WHERE id = ?",
      uid,
    );
    const keyCount = one<{ n: number }>("SELECT COUNT(*) AS n FROM api_keys WHERE user_id = ?", uid);
    const top = all<{ model: string; requests: number; cost: number }>(
      `SELECT model, COUNT(*) AS requests, COALESCE(SUM(actual_cost),0) AS cost FROM usage_logs
       WHERE user_id = ? AND created_at >= ? AND status_code < 300 GROUP BY model ORDER BY cost DESC LIMIT 5`,
      uid,
      monthStart(),
    );
    return {
      data: {
        balanceUsd: balance?.balance_usd ?? 0,
        creditLimitUsd: balance?.credit_limit_usd ?? 0,
        creditUsedUsd: balance?.credit_used_usd ?? 0,
        availableUsd: Math.round(((balance?.credit_limit_usd ?? 0) - (balance?.credit_used_usd ?? 0) + (balance?.balance_usd ?? 0)) * 1e8) / 1e8,
        creditSettledAt: balance?.credit_settled_at ?? null,
        keyCount: keyCount?.n ?? 0,
        today: periodTotals(todayStart(), "user_id = ?", [uid]),
        month: periodTotals(monthStart(), "user_id = ?", [uid]),
        daily: dailySeries(14, "user_id = ?", [uid]),
        topModels: top.map((t) => ({ model: t.model, requests: t.requests, costUsd: t.cost })),
      },
    };
  });

  app.get("/api/user/groups", pre, async (req) => {
    const def = getSetting("default_group_id");
    return { data: availableGroups(req.user!.id).map((g) => ({ ...groupShape(g), isDefault: g.id === def })) };
  });

  app.get("/api/user/keys", pre, async (req) => ({
    data: all<ApiKeyRow>(`${API_KEY_SELECT} WHERE k.user_id = ? ORDER BY k.created_at DESC`, req.user!.id).map(apiKeyShape),
  }));

  app.post("/api/user/keys", pre, async (req, reply) => {
    const uid = req.user!.id;
    const b = body(req);
    const f = applyKeyFields(b, uid, req.user!.role !== "admin");
    const max = Number(getSetting("max_keys_per_user")) || 50;
    const count = one<{ n: number }>("SELECT COUNT(*) AS n FROM api_keys WHERE user_id = ?", uid)!.n;
    if (count >= max) bad("key_limit_reached", `You can have at most ${max} API keys`);
    let groupId = f.groupId;
    if (!groupId) {
      const def = getSetting("default_group_id");
      const avail = availableGroups(uid);
      groupId = avail.find((g) => g.id === def)?.id ?? avail[0]?.id;
      if (!groupId) bad("group_not_available", "No group is available to you; contact the administrator");
    }
    const k = generateApiKey();
    const id = newId();
    run(
      `INSERT INTO api_keys (id, user_id, name, key_hash, key_enc, key_preview, group_id, quota_usd, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      uid,
      f.name || "default",
      k.hash,
      encryptString(k.plaintext),
      k.preview,
      groupId,
      f.quotaUsd ?? 0,
      f.expiresAt ?? null,
      nowIso(),
    );
    const row = one<ApiKeyRow>(`${API_KEY_SELECT} WHERE k.id = ?`, id)!;
    return reply.status(201).send({ data: { ...apiKeyShape(row), key: k.plaintext } });
  });

  app.patch("/api/user/keys/:id", pre, async (req) => {
    const { id } = req.params as { id: string };
    loadOwnKey(req, id);
    updateKey(id, applyKeyFields(body(req), req.user!.id, req.user!.role !== "admin"));
    return { data: apiKeyShape(loadOwnKey(req, id)) };
  });

  app.post("/api/user/keys/:id/reveal", pre, async (req) => {
    const { id } = req.params as { id: string };
    const k = loadOwnKey(req, id);
    if (!k.key_enc) bad("key_not_revealable", "This key was migrated from a login key and cannot be shown again");
    return { data: { key: decryptString(k.key_enc) } };
  });

  app.delete("/api/user/keys/:id", pre, async (req) => {
    const { id } = req.params as { id: string };
    loadOwnKey(req, id);
    run("DELETE FROM api_keys WHERE id = ?", id);
    return { data: { ok: true } };
  });

  app.get("/api/user/usage", pre, async (req) => {
    const p = page(req);
    const { where } = usageQuery(req, { userId: req.user!.id });
    const total = one<{ n: number }>(`SELECT COUNT(*) AS n FROM usage_logs l ${where.sql}`, ...where.params)!.n;
    const rows = all<UsageRowDb>(
      `${USAGE_SELECT} ${where.sql} ORDER BY l.created_at DESC, l.rowid DESC LIMIT ? OFFSET ?`,
      ...where.params,
      p.pageSize,
      p.offset,
    );
    return { data: paged(rows.map(usageShape), total, p) };
  });

  app.get("/api/user/usage/stats", pre, async (req) => {
    const { where } = usageQuery(req, { userId: req.user!.id });
    return { data: usageStats(where) };
  });

  // Hourly / daily spend per key (docs/console-api.md §2).
  app.get("/api/user/usage/breakdown", pre, async (req) => {
    const { where } = usageQuery(req, { userId: req.user!.id });
    return { data: usageBreakdown(where, usageBucket(req), "key") };
  });

  app.get("/api/user/ledger", pre, async (req) => {
    const p = page(req);
    const uid = req.user!.id;
    const total = one<{ n: number }>("SELECT COUNT(*) AS n FROM ledger WHERE user_id = ?", uid)!.n;
    const rows = all<Parameters<typeof ledgerShape>[0]>(
      "SELECT * FROM ledger WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?",
      uid,
      p.pageSize,
      p.offset,
    );
    return { data: paged(rows.map(ledgerShape), total, p) };
  });

  app.get("/api/user/credit-events", pre, async (req) => {
    const p = page(req);
    const uid = req.user!.id;
    const total = one<{ n: number }>("SELECT COUNT(*) AS n FROM credit_events WHERE user_id = ?", uid)!.n;
    const rows = all<Parameters<typeof creditEventShape>[0]>(
      "SELECT * FROM credit_events WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?",
      uid,
      p.pageSize,
      p.offset,
    );
    return { data: paged(rows.map(creditEventShape), total, p) };
  });

  // Cache-rebuild refund (docs/data-model.md §3 cache_refunds): what the user is owed
  // for switched requests not refunded yet, the schedule, and the refunds so far.
  app.get("/api/user/cache-refund", pre, async (req) => ({ data: cacheRefundSummary(req.user!.id) }));

  app.get("/api/user/cache-refunds", pre, async (req) => {
    const p = page(req);
    const uid = req.user!.id;
    const total = one<{ n: number }>("SELECT COUNT(*) AS n FROM cache_refunds WHERE user_id = ?", uid)!.n;
    const rows = all<Parameters<typeof cacheRefundShape>[0]>(
      "SELECT * FROM cache_refunds WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?",
      uid,
      p.pageSize,
      p.offset,
    );
    return { data: paged(rows.map(cacheRefundShape), total, p) };
  });

  app.post("/api/user/redeem", pre, async (req) => {
    const code = (str(body(req), "code", { required: true, max: 64 }) ?? "").toUpperCase().replace(/[\s-]/g, "");
    const uid = req.user!.id;
    const now = nowIso();
    const result = tx(() => {
      const claim = run(
        `UPDATE redeem_codes SET status = 'used', used_by = ?, used_at = ?
         WHERE code = ? AND status = 'unused' AND (expires_at IS NULL OR expires_at > ?)`,
        uid,
        now,
        code,
        now,
      );
      if (claim.changes === 0) return null;
      const value = one<{ value_usd: number }>("SELECT value_usd FROM redeem_codes WHERE code = ?", code)!.value_usd;
      const { balanceAfter } = applyLedger(uid, "redeem", value, { ref: code });
      return { valueUsd: value, balanceUsd: balanceAfter };
    });
    if (!result) bad("code_invalid_or_used", "This code is invalid, already used, disabled or expired");
    return { data: result };
  });
}
