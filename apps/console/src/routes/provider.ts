import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  all,
  encryptJson,
  isoIn,
  newId,
  nowIso,
  one,
  randomHex,
  run,
  tx,
  type AccountRow,
} from "@1dayapi/core";
import { parseAccountFields, touchesConnection } from "../account-input.js";
import { importOAuthCredential } from "../onboard/jobs.js";
import { bad, body, notFound, oneOf, page, paged, query, Where, dateRange, str } from "../http.js";
import { releaseAccountProxies, NODE_POOL_COUNT_SQL } from "../node/proxies.js";
import { forceRequested, removeNode } from "../node/removal.js";
import { disconnectNode } from "../node/registry.js";
import { requireProvider } from "../session.js";
import {
  accountStats30d,
  dailySeries,
  ledgerShape,
  monthStart,
  periodTotals,
  providerAccountShape,
  todayStart,
} from "../shapes.js";

// Provider (supply side) console API (docs/v3-design.md §8.3).

function ownAccount(req: FastifyRequest, id: string): AccountRow {
  const a = one<AccountRow>("SELECT * FROM accounts WHERE id = ? AND owner_id = ?", id, req.user!.id);
  if (!a) notFound("account");
  return a;
}

/**
 * Who disabled an account (review fix 2026-11-10). There is no column for it, so the provider's own switch-off leaves
 * this exact text in `error_message`; an administrator's switch-off (routes/admin.ts) overwrites it and the platform's
 * own (node removed, …) writes its reason there. Only an account carrying the mark is the provider's to switch on again.
 */
export const PROVIDER_DISABLED_MARK = "disabled by the provider";
export const ADMIN_DISABLED_MARK = "disabled by an administrator";

/**
 * Was this `disabled` account switched off by this provider? The mark decides. Accounts disabled before the mark
 * existed have no message: for those the audit trail (admin_audit, 180 days) is asked — the most recent successful
 * status change on the account must be this provider's own `{status:"disabled"}`. No evidence = not the provider's.
 */
function disabledByProvider(a: AccountRow, providerId: string): boolean {
  if (a.error_message === PROVIDER_DISABLED_MARK) return true;
  if (a.error_message) return false;
  const rows = all<{ user_id: string | null; path: string; summary: string | null }>(
    `SELECT user_id, path, summary FROM admin_audit WHERE method = 'PATCH' AND status < 300 AND path IN (?, ?)
      ORDER BY at DESC, rowid DESC LIMIT 50`, `/api/provider/accounts/${a.id}`, `/api/admin/accounts/${a.id}`);
  for (const r of rows) {
    let status: unknown;
    try { status = (JSON.parse(r.summary ?? "{}") as { body?: { status?: unknown } }).body?.status; } catch { continue; }
    if (status === undefined) continue; // that request did not touch the status
    return r.path.startsWith("/api/provider/") && r.user_id === providerId && status === "disabled";
  }
  return false;
}

export function nodeShape(n: Record<string, unknown>) {
  let deployMeta: Record<string, unknown> | null = null;
  if (typeof n.deploy_meta === "string" && n.deploy_meta) {
    try {
      deployMeta = JSON.parse(n.deploy_meta) as Record<string, unknown>;
    } catch {
      deployMeta = null;
    }
  }
  return {
    nodeId: n.node_id,
    providerId: n.provider_id,
    providerName: n.provider_name ?? null,
    /** Deployed by an admin (platform node): carries platform-owned accounts, no payout. */
    platformNode: n.provider_role === "admin",
    nodeVersion: n.node_version,
    osType: n.os_type,
    osArch: n.os_arch,
    online: n.online === 1,
    acceptingSessions: n.accepting_sessions === 1,
    inFlight: n.in_flight,
    capacity: typeof n.capacity === "number" ? n.capacity : 100,
    accountCount: typeof n.account_count === "number" ? n.account_count : 0,
    proxyCount: typeof n.proxy_count === "number" ? n.proxy_count : 0,
    deployMeta,
    lastHeartbeatAt: n.last_heartbeat_at,
    createdAt: n.created_at,
  };
}

export function registerProviderRoutes(app: FastifyInstance): void {
  const pre = { preHandler: requireProvider };

  app.get("/api/provider/overview", pre, async (req) => {
    const pid = req.user!.id;
    const u = one<{ balance_usd: number }>("SELECT balance_usd FROM users WHERE id = ?", pid);
    const lifetime = one<{ e: number }>("SELECT COALESCE(SUM(provider_earning),0) AS e FROM usage_logs WHERE provider_id = ?", pid);
    const paid = one<{ p: number }>("SELECT COALESCE(-SUM(amount_usd),0) AS p FROM ledger WHERE user_id = ? AND kind = 'payout'", pid);
    const acc = one<{ total: number; active: number; pending: number; error: number }>(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN status='active' AND review_status='approved' THEN 1 ELSE 0 END) AS active,
              SUM(CASE WHEN review_status='pending' THEN 1 ELSE 0 END) AS pending,
              SUM(CASE WHEN status='error' THEN 1 ELSE 0 END) AS error
       FROM accounts WHERE owner_id = ?`,
      pid,
    );
    const nodes = one<{ total: number; online: number }>(
      "SELECT COUNT(*) AS total, COALESCE(SUM(online),0) AS online FROM nodes WHERE provider_id = ?",
      pid,
    );
    const t = periodTotals(todayStart(), "provider_id = ?", [pid]);
    const m = periodTotals(monthStart(), "provider_id = ?", [pid]);
    return {
      data: {
        balanceUsd: u?.balance_usd ?? 0,
        lifetimeEarningUsd: lifetime?.e ?? 0,
        paidOutUsd: paid?.p ?? 0,
        today: { requests: t.requests, earningUsd: t.earningUsd },
        month: { requests: m.requests, earningUsd: m.earningUsd },
        daily: dailySeries(14, "provider_id = ?", [pid]).map((d) => ({
          day: d.day,
          requests: d.requests,
          earningUsd: d.earningUsd,
        })),
        accounts: {
          total: acc?.total ?? 0,
          active: acc?.active ?? 0,
          pending: acc?.pending ?? 0,
          error: acc?.error ?? 0,
        },
        nodes: { total: nodes?.total ?? 0, online: nodes?.online ?? 0 },
      },
    };
  });

  // ---------- nodes ----------

  app.get("/api/provider/nodes", pre, async (req) => ({
    data: all(
      `SELECT n.*,
              (SELECT COUNT(*) FROM accounts a WHERE a.node_id = n.node_id AND a.route = 'node') AS account_count,
              ${NODE_POOL_COUNT_SQL} AS proxy_count
       FROM nodes n WHERE n.provider_id = ? ORDER BY n.created_at DESC`,
      req.user!.id,
    ).map(nodeShape),
  }));

  app.post("/api/provider/bind-codes", pre, async (req, reply) => {
    const code = `bind_${randomHex(16)}`;
    const expiresAt = isoIn(10 * 60_000);
    run(
      "INSERT INTO node_bind_codes (code, provider_id, expires_at, created_at) VALUES (?, ?, ?, ?)",
      code,
      req.user!.id,
      expiresAt,
      nowIso(),
    );
    return reply.status(201).send({ data: { code, expiresAt } });
  });

  app.delete("/api/provider/nodes/:id", pre, async (req) => {
    const { id } = req.params as { id: string };
    if (!one("SELECT 1 FROM nodes WHERE node_id = ? AND provider_id = ?", id, req.user!.id)) notFound("node");
    // Review fix 2026-11-10: 409 node_has_dependents while the node carries accounts, unless ?force=1 / {force:true}
    // (unbinds + disables the node's own accounts, one event each). A provider can never take a proxy away from
    // another node: node_shared_with_other_nodes stays a 409 whatever is sent (administrator only).
    removeNode(id, "node removed by its provider", { force: forceRequested(req) ? "own" : "none", actorId: req.user!.id });
    disconnectNode(id, "unbound_by_provider");
    return { data: { ok: true } };
  });

  // ---------- accounts ----------

  app.get("/api/provider/accounts", pre, async (req) => {
    const stats = accountStats30d();
    return {
      data: all<AccountRow>("SELECT * FROM accounts WHERE owner_id = ? ORDER BY created_at DESC", req.user!.id).map((a) =>
        providerAccountShape(a, stats.get(a.id)),
      ),
    };
  });

  app.post("/api/provider/accounts", pre, async (req, reply) => {
    const b = body(req);
    const f = parseAccountFields(b, null, b.type==='oauth' && b.platform==='anthropic');
    const route = oneOf(b, "route", ["direct", "node"] as const) ?? "direct";
    if(f.platform==='anthropic' && f.type==='oauth'){
      const nodeId=str(b,"nodeId");
      if(!nodeId || !one("SELECT 1 FROM nodes WHERE node_id=? AND provider_id=? AND online=1",nodeId,req.user!.id))
        bad("invalid_request","A pinned online node owned by this provider is required");
      const id=await importOAuthCredential("provider",req.user!.id,nodeId,f.credential!,{
        ownerId:req.user!.id,name:f.name,expectedTeamId:f.credential?.orgUuid});
      return reply.status(201).send({data:providerAccountShape(ownAccount(req,id))});
    }
    const id = newId();
    const now = nowIso();
    run(
      `INSERT INTO accounts (id, name, platform, type, protocol, base_url, credential_enc, models, model_mapping,
                             owner_id, route, review_status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      id,
      f.name,
      f.platform,
      f.type,
      f.protocol,
      f.baseUrl ?? null,
      encryptJson(f.credential),
      f.models?.length ? JSON.stringify(f.models) : null,
      f.modelMapping ? JSON.stringify(f.modelMapping) : null,
      req.user!.id,
      route,
      now,
      now,
    );
    return reply.status(201).send({ data: providerAccountShape(ownAccount(req, id)) });
  });

  app.patch("/api/provider/accounts/:id", pre, async (req) => {
    const { id } = req.params as { id: string };
    const a = ownAccount(req, id);
    const b = body(req);
    if (a.type === "oauth") {
      // Managed by the node / onboarding: only name and status may change here.
      const illegal = Object.keys(b).filter((k) => k !== "name" && k !== "status");
      if (illegal.length) bad("invalid_request", `OAuth accounts are managed by the node; only name/status can change (got ${illegal.join(", ")})`);
    }
    const f = parseAccountFields(b, a, false);
    const sets: string[] = ["updated_at = ?"];
    const params: unknown[] = [nowIso()];
    if (f.name !== undefined) (sets.push("name = ?"), params.push(f.name));
    if (f.platform !== undefined) (sets.push("platform = ?"), params.push(f.platform));
    if (f.type !== undefined && a.type !== "oauth") (sets.push("type = ?"), params.push(f.type));
    if (f.protocol !== undefined) (sets.push("protocol = ?"), params.push(f.protocol));
    if (f.baseUrl !== undefined) (sets.push("base_url = ?"), params.push(f.baseUrl));
    if (f.credential !== undefined) (sets.push("credential_enc = ?"), params.push(encryptJson(f.credential)));
    if (f.models !== undefined) (sets.push("models = ?"), params.push(f.models.length ? JSON.stringify(f.models) : null));
    if (f.modelMapping !== undefined) (sets.push("model_mapping = ?"), params.push(f.modelMapping ? JSON.stringify(f.modelMapping) : null));
    const status = oneOf(b, "status", ["active", "disabled"] as const);
    if (status && a.status === "error" && status === "active" && !touchesConnection(f)) {
      bad("invalid_request", "This account is in error state; update its credential to re-submit it");
    }
    // Review fix 2026-11-10: the provider's switch is active ↔ disabled for an account the provider disabled itself.
    //  - proxy_down (frozen: its proxy failed) only ends through an operator's proxy-release / proxy-rebind;
    //  - `disabled` set by an administrator or by the platform (node removed, …) is not the provider's to undo.
    // Before, only `error` was refused, so both came back to `active` with one PATCH.
    const frozen = a.status === "proxy_down" || !!a.proxy_down_since;
    if (status && frozen) bad("proxy_down_use_release", "This account is frozen because its proxy failed; only a platform operator can release or rebind it", 409);
    const ownDisable = a.status === "disabled" && disabledByProvider(a, req.user!.id);
    if (status === "active" && a.status === "disabled" && !ownDisable) {
      bad("disabled_by_platform", "This account was disabled by the platform; ask an administrator to enable it", 403);
    }
    if (touchesConnection(f)) {
      // Re-submitted for review; an explicit status in the same request still wins. A status the provider may not
      // leave (frozen, disabled by the platform) is kept: the re-submitted credential waits for review as it is.
      sets.push("review_status = 'pending'");
      if (!frozen && (a.status !== "disabled" || ownDisable)) {
        sets.push("error_message = ?", "status = ?");
        params.push(status === "disabled" ? PROVIDER_DISABLED_MARK : null, status ?? "active");
      }
    } else if (status === "disabled" && a.status !== "disabled") {
      // Only an account that is running is the provider's to switch off; `error` keeps its state and message.
      if (a.status !== "active") bad("invalid_request", `This account is in ${a.status} state and cannot be disabled here`);
      sets.push("status = 'disabled'", "error_message = ?");
      params.push(PROVIDER_DISABLED_MARK);
    } else if (status === "active" && a.status === "disabled") {
      sets.push("status = 'active'", "error_message = NULL");
    }
    run(`UPDATE accounts SET ${sets.join(", ")} WHERE id = ?`, ...params, id);
    return { data: providerAccountShape(ownAccount(req, id)) };
  });

  app.delete("/api/provider/accounts/:id", pre, async (req) => {
    const { id } = req.params as { id: string };
    const a = ownAccount(req, id);
    tx(() => {
      // Deleting an account releases its bound proxy back to the pool (docs/onboarding.md §6.4);
      // a proxy from a rejected account (status error) enters the release cooldown.
      releaseAccountProxies(id, a);
      run("DELETE FROM accounts WHERE id = ?", id); // usage_logs keep the id (no FK)
    });
    return { data: { ok: true } };
  });

  // ---------- earnings / settlements ----------

  app.get("/api/provider/earnings", pre, async (req) => {
    const p = page(req);
    const q = query(req);
    const { from, to } = dateRange(req);
    const w = new Where().add("l.provider_id = ?", req.user!.id).add("l.status_code < 300");
    w.addIf(from, "l.created_at >= ?", from);
    w.addIf(to, "l.created_at < ?", to);
    w.addIf(q.accountId, "l.account_id = ?", q.accountId);
    const total = one<{ n: number; e: number }>(
      `SELECT COUNT(*) AS n, COALESCE(SUM(l.provider_earning),0) AS e FROM usage_logs l ${w.sql}`,
      ...w.params,
    )!;
    const rows = all<Record<string, any>>(
      `SELECT l.id, l.created_at, l.account_id, a.name AS account_name, l.model, l.input_tokens, l.output_tokens,
              l.cache_read_tokens, l.cache_write_tokens, l.cache_write_5m_tokens, l.cache_write_1h_tokens, l.total_cost, l.provider_earning, l.status_code
       FROM usage_logs l LEFT JOIN accounts a ON a.id = l.account_id ${w.sql}
       ORDER BY l.created_at DESC, l.rowid DESC LIMIT ? OFFSET ?`,
      ...w.params,
      p.pageSize,
      p.offset,
    );
    return {
      data: {
        ...paged(
          rows.map((r) => ({
            id: r.id,
            createdAt: r.created_at,
            accountId: r.account_id,
            accountName: r.account_name,
            model: r.model,
            inputTokens: r.input_tokens,
            outputTokens: r.output_tokens,
            cacheTokens: r.cache_read_tokens + r.cache_write_tokens,
            cacheReadTokens: r.cache_read_tokens,
            cacheWriteTokens: r.cache_write_tokens,
            cacheWrite5mTokens: r.cache_write_5m_tokens ?? 0,
            cacheWrite1hTokens: r.cache_write_1h_tokens ?? 0,
            totalCost: r.total_cost,
            providerEarning: r.provider_earning,
            statusCode: r.status_code,
          })),
          total.n,
          p,
        ),
        sumEarningUsd: total.e,
      },
    };
  });

  app.get("/api/provider/ledger", pre, async (req) => {
    const p = page(req);
    const pid = req.user!.id;
    const total = one<{ n: number }>("SELECT COUNT(*) AS n FROM ledger WHERE user_id = ?", pid)!.n;
    const rows = all<Parameters<typeof ledgerShape>[0]>(
      "SELECT * FROM ledger WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?",
      pid,
      p.pageSize,
      p.offset,
    );
    return { data: paged(rows.map(ledgerShape), total, p) };
  });
}
