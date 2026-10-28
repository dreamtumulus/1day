import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  all,
  applyLedger,
  decryptString,
  encryptString,
  generateApiKey,
  getSetting,
  newId,
  nowIso,
  one,
  parseIsoInput,
  run,
  tx,
} from "@1dayapi/core";
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
  dailySeries,
  groupShape,
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
): { name?: string; groupId?: string; quotaUsd?: number; expiresAt?: string | null; status?: string } {
  const out: { name?: string; groupId?: string; quotaUsd?: number; expiresAt?: string | null; status?: string } = {};
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
  return { where: w };
}

export const USAGE_SELECT = `SELECT l.*, k.name AS key_name, u.name AS user_name, a.name AS account_name
  FROM usage_logs l LEFT JOIN api_keys k ON k.id = l.api_key_id
  LEFT JOIN users u ON u.id = l.user_id LEFT JOIN accounts a ON a.id = l.account_id`;

export function usageStats(where: Where) {
  const totals = one<{ requests: number; cost: number; input: number; output: number; cache: number }>(
    `SELECT SUM(CASE WHEN l.status_code < 300 THEN 1 ELSE 0 END) AS requests, COALESCE(SUM(l.actual_cost),0) AS cost,
            COALESCE(SUM(l.input_tokens),0) AS input, COALESCE(SUM(l.output_tokens),0) AS output,
            COALESCE(SUM(l.cache_read_tokens + l.cache_write_tokens),0) AS cache
     FROM usage_logs l ${where.sql}`,
    ...where.params,
  );
  const daily = all<{ day: string; requests: number; cost: number; tokens: number }>(
    `SELECT substr(l.created_at,1,10) AS day, SUM(CASE WHEN l.status_code < 300 THEN 1 ELSE 0 END) AS requests,
            COALESCE(SUM(l.actual_cost),0) AS cost,
            COALESCE(SUM(l.input_tokens + l.output_tokens + l.cache_read_tokens + l.cache_write_tokens),0) AS tokens
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
    },
    daily: daily.map((d) => ({ day: d.day, requests: d.requests, costUsd: d.cost, tokens: d.tokens })),
    byModel: byModel.map((m) => ({
      model: m.model,
      requests: m.requests,
      costUsd: m.cost,
      inputTokens: m.input,
      outputTokens: m.output,
    })),
  };
}

export function registerUserRoutes(app: FastifyInstance): void {
  const pre = { preHandler: requireConsumer };

  app.get("/api/user/overview", pre, async (req) => {
    const uid = req.user!.id;
    const balance = one<{ balance_usd: number }>("SELECT balance_usd FROM users WHERE id = ?", uid);
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
