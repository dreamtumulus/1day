import { assertNodeCapacity, nodeOccupancy } from "../node/capacity.js";
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  CC_SHAPE_POLICIES,
  SETTING_KEYS,
  CC_ANTHROPIC_VERSION,
  ccCanonicalBetas,
  ccBillingBlock,
  CC_IDENTITY_BLOCK,
  accountBaseUrl,
  all,
  anthropicFingerprintHeaders,
  applyLedger,
  pendingCacheRefundAll,
  runCacheRefund,
  runCacheRefundsForAll,
  teamUsageToday,
  resumeTeam,
  telemetryEvidenceLevel,
  listTelemetryEvidence,
  recordTelemetryEvidence,
  CC_VERSION,
  judgeAllKeys,
  judgeKey,
  listKeyPolicyEvents,
  setCreditLimit,
  settleCredit,
  ccMetadataUserId,
  clearAccountState,
  encryptJson,
  generateRedeemCode,
  getModelEntry,
  getPlatform,
  getSetting,
  getSettings,
  listRegistry,
  newId,
  nowIso,
  one,
  parseIsoInput,
  parseJsonArray,
  randomProbePrompt,
  readCredential,
  run,
  settingsRevision,
  updateSettings,
  SettingsRevisionConflict,
  tx,
  validateAllowlistInput,
  type AccountRow,
  type Role,
  type SettingKey,
  hasSubscriptionWindow,
  releaseProxyFreeze,
  proxyDownSummary,
  ProxyFreezeError,
  recordProxyTeamEvent,
} from "@1dayapi/core";
import { importOAuthCredential } from "../onboard/jobs.js";
import { parseAccountFields } from "../account-input.js";
import { gatewayInFlight } from "../gateway-stats.js";
import { probeWindow } from "../ccr/window-poll.js";
import { enrichAccountProfile, validateAccountControlPlane } from "../ccr/profile.js";
import {
  Where,
  bad,
  body,
  notFound,
  num,
  oneOf,
  page,
  paged,
  query,
  str,
  strArray,
} from "../http.js";
import { deployNodeLocal, deployNodeViaSsh } from "../node/deploy.js";
import { ProxyInputError, addNodeProxies, rebindAccountProxy, removeNodeProxies, listNodeProxies, listNodeProxyGroups, listProxiesForPicker, nodeExists, nodeProxyUrls, normalizeProxyGroup, releaseAccountProxies, releaseNodeResources, replaceNodeProxies, setNodeProxyGroup, unquarantineProxy, validateProxies, type AddProxiesResult, type ProxyInput, type ReplaceProxiesResult } from "../node/proxies.js";
import { requestViaNode } from "../node/egress-request.js";
import { disconnectNode, pushProxies, retireTeamOnNodes } from "../node/registry.js";
import { claimReleaseMinDays, releaseTeamClaims, teamClaims, teamOverview } from "../node/teams.js";
import { createUser, dropSessions, requireAdmin, requireOps, resetLoginKey } from "../session.js";
import {
  API_KEY_SELECT,
  accountGroupsMap,
  accountStats30d,
  accountUsageStats,
  adminAccountShape,
  apiKeyShape,
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
  type GroupRow,
  type UsageRowDb,
} from "../shapes.js";
import { nodeShape } from "./provider.js";
import { USAGE_SELECT, applyKeyFields, cacheRefundSummary, updateKey, usageBreakdown, usageBucket, usageQuery, usageStats } from "./user.js";

// Admin console API (docs/v3-design.md §8.4).

interface UserRow {
  id: string;
  role: Role;
  name: string;
  login_key_preview: string;
  status: string;
  balance_usd: number;
  credit_limit_usd: number;
  credit_used_usd: number;
  credit_settled_at: string | null;
  max_inflight?: number | null;
  max_inflight_usd?: number | null;
  note: string | null;
  last_login_at: string | null;
  created_at: string;
  key_count?: number;
  requests30d?: number;
  cost30d?: number;
  cc_suspect30d?: number;
  last_request_at?: string | null;
}

const USER_SELECT = `SELECT u.*,
    (SELECT COUNT(*) FROM api_keys k WHERE k.user_id = u.id) AS key_count,
    (SELECT MAX(l.created_at) FROM usage_logs l WHERE l.user_id = u.id) AS last_request_at,
    (SELECT COUNT(*) FROM usage_logs l WHERE l.user_id = u.id AND l.created_at >= ? AND l.status_code < 300) AS requests30d,
    (SELECT COALESCE(SUM(actual_cost),0) FROM usage_logs l WHERE l.user_id = u.id AND l.created_at >= ?) AS cost30d,
    (SELECT COUNT(*) FROM usage_logs l WHERE l.user_id = u.id AND l.cc_shape = 'suspect'
       AND l.created_at >= strftime('%Y-%m-%dT%H:%M:%SZ','now','-30 days')) AS cc_suspect30d
  FROM users u`;

function since30(): string {
  return new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 19) + "Z";
}

function allowedGroupIds(userId: string): string[] {
  return all<{ group_id: string }>("SELECT group_id FROM user_allowed_groups WHERE user_id = ?", userId).map((r) => r.group_id);
}

function userShape(u: UserRow) {
  return {
    id: u.id,
    role: u.role,
    name: u.name,
    loginKeyPreview: u.login_key_preview,
    status: u.status,
    balanceUsd: u.balance_usd,
    creditLimitUsd: u.credit_limit_usd,
    creditUsedUsd: u.credit_used_usd,
    availableUsd: Math.round((u.credit_limit_usd - u.credit_used_usd + u.balance_usd) * 1e8) / 1e8,
    creditSettledAt: u.credit_settled_at,
    // Admission overrides (migration 29): null = gateway defaults (USER_MAX_INFLIGHT / USER_MAX_INFLIGHT_USD).
    maxInflight: u.max_inflight ?? null,
    maxInflightUsd: u.max_inflight_usd ?? null,
    note: u.note,
    keyCount: u.key_count ?? 0,
    requests30d: u.requests30d ?? 0,
    cost30d: u.cost30d ?? 0,
    ccSuspect30d: u.cc_suspect30d ?? 0,
    lastRequestAt: u.last_request_at ?? null,
    lastLoginAt: u.last_login_at,
    createdAt: u.created_at,
    allowedGroupIds: allowedGroupIds(u.id),
    // Provider role: the group its self-onboarded accounts join at once (null = default group).
    onboardGroupId: (u as { onboard_group_id?: string | null }).onboard_group_id ?? null,
  };
}

function loadUser(id: string): UserRow {
  const s = since30();
  const u = one<UserRow>(`${USER_SELECT} WHERE u.id = ?`, s, s, id);
  if (!u) notFound("user");
  return u;
}

function setAllowedGroups(userId: string, ids: string[]): void {
  run("DELETE FROM user_allowed_groups WHERE user_id = ?", userId);
  for (const gid of ids) {
    if (one("SELECT 1 FROM groups WHERE id = ?", gid)) {
      run("INSERT OR IGNORE INTO user_allowed_groups (user_id, group_id) VALUES (?, ?)", userId, gid);
    }
  }
}

/**
 * Owner implied by pinning `nodeId`: a provider's node → that provider; an
 * admin-deployed (platform) node → platform-owned (null). An explicit owner
 * that disagrees with the node is rejected, as is a full node.
 */
function resolveNodeOwner(nodeId: string, ownerId: string | null, excludeAccountId: string | null): string | null {
  const node = one<{ provider_id: string; role: string | null; capacity: number }>(
    "SELECT n.provider_id, u.role, n.capacity FROM nodes n LEFT JOIN users u ON u.id = n.provider_id WHERE n.node_id = ?",
    nodeId,
  );
  if (!node) bad("node_not_found", `Node '${nodeId}' not found`);
  const platformNode = node.role !== "provider";
  if (platformNode && ownerId) bad("invalid_request", "a platform node cannot carry a provider-owned account");
  if (!platformNode && ownerId && ownerId !== node.provider_id) bad("invalid_request", "nodeId belongs to a different provider than ownerId");
  if (!platformNode && !ownerId && excludeAccountId) bad("invalid_request", "a platform-owned account cannot use a provider's node");
  assertNodeCapacity(nodeId,excludeAccountId??undefined);
  return platformNode ? null : (ownerId ?? node.provider_id);
}

function loadAccount(id: string) {
  const a = one<AccountRow & { owner_name: string | null }>(
    "SELECT a.*, u.name AS owner_name FROM accounts a LEFT JOIN users u ON u.id = a.owner_id WHERE a.id = ?",
    id,
  );
  if (!a) notFound("account");
  return a;
}

function accountOut(id: string, admin=false) {
  const a = loadAccount(id);
  return adminAccountShape(a, accountGroupsMap().get(id) ?? [], accountStats30d().get(id),{showTeam:admin});
}

function setAccountGroups(accountId: string, groupIds: string[], priority: number): void {
  run("DELETE FROM account_groups WHERE account_id = ?", accountId);
  for (const gid of groupIds) {
    if (!one("SELECT 1 FROM groups WHERE id = ?", gid)) bad("group_not_found", `Group '${gid}' not found`);
    run("INSERT INTO account_groups (account_id, group_id, priority) VALUES (?, ?, ?)", accountId, gid, priority);
  }
}

function loadGroup(id: string): GroupRow {
  const g = one<GroupRow>("SELECT * FROM groups WHERE id = ?", id);
  if (!g) notFound("group");
  return g;
}

function groupOut(g: GroupRow) {
  const counts = one<{ keys: number; accounts: number }>(
    `SELECT (SELECT COUNT(*) FROM api_keys WHERE group_id = ?) AS keys,
            (SELECT COUNT(*) FROM account_groups WHERE group_id = ?) AS accounts`,
    g.id,
    g.id,
  );
  return { ...groupShape(g), keyCount: counts?.keys ?? 0, accountCount: counts?.accounts ?? 0 };
}

/** Minimal live check of an account: direct accounts from this process, node accounts through their node. */
async function testAccount(a: AccountRow, model: string | undefined) {
  if (a.type === "oauth" && a.platform === "openai") return { ok: false, statusCode: 0, latencyMs: 0, message: "ChatGPT OAuth accounts cannot be tested here" };
  if (a.status !== "active" || a.review_status !== "approved") {
    if (a.route === "node") return { ok: false, statusCode: 0, latencyMs: 0, message: "Node accounts must be active and approved to be tested (the node only accepts sessions for schedulable accounts)" };
  }
  const base = accountBaseUrl(a);
  if (!base) return { ok: false, statusCode: 0, latencyMs: 0, message: "No base URL" };
  let cred;
  try {
    cred = readCredential(a);
  } catch {
    return { ok: false, statusCode: 0, latencyMs: 0, message: "Credential cannot be decrypted" };
  }
  const testModel =
    model ||
    parseJsonArray(a.models).find((m) => !m.includes("*")) ||
    listRegistry().find((m) => m.enabled && m.platform === a.platform)?.modelId;
  if (!testModel) return { ok: false, statusCode: 0, latencyMs: 0, message: "No model to test with; pass one" };
  const secret = cred.apiKey ?? cred.accessToken ?? "";
  const headers: Record<string, string> = { "content-type": "application/json" };
  let url: string;
  let payload: Record<string, unknown>;
  if (a.protocol === "anthropic") {
    if (a.type === "oauth") {
      // OAuth 订阅号：必须是真 CC 形态（docs/claude-code-compat.md §5）——裸 body
      // + CC UA 会被上游直接 429 并把账号打进冷却（2026-10-16 实测）。
      url = `${base}/v1/messages?beta=true`;
      Object.assign(headers, anthropicFingerprintHeaders({}));
      headers.authorization = `Bearer ${secret}`;
      headers["anthropic-version"] = CC_ANTHROPIC_VERSION;
      headers["anthropic-beta"] = ccCanonicalBetas(true).join(",");
      const messages = [{ role: "user", content: [{ type: "text", text: randomProbePrompt(), cache_control: { type: "ephemeral" } }] }];
      payload = {
        model: testModel,
        max_tokens: 8,
        stream: true,
        system: [
          { type: "text", text: ccBillingBlock(messages) },
          { type: "text", text: CC_IDENTITY_BLOCK, cache_control: { type: "ephemeral" } },
        ],
        messages,
        metadata: { user_id: ccMetadataUserId() },
      };
    } else {
      url = `${base}/v1/messages`;
      headers["anthropic-version"] = "2023-06-01";
      headers["x-api-key"] = secret;
      if (a.type === "upstream") headers.authorization = `Bearer ${secret}`;
      payload = { model: testModel, max_tokens: 8, messages: [{ role: "user", content: "ping" }] };
    }
  } else {
    url = `${base}/chat/completions`;
    headers.authorization = `Bearer ${secret}`;
    payload = { model: testModel, max_tokens: 8, messages: [{ role: "user", content: "ping" }] };
  }
  const started = Date.now();
  if (a.route === "node") {
    try {
      const r = await requestViaNode(a, url, headers, payload, undefined, undefined, 500); // a verdict needs no more
      const latencyMs = Date.now() - started;
      if ("nodeError" in r) return { ok: false, statusCode: 0, latencyMs, model: testModel, nodeId: r.nodeId, message: `node: ${r.nodeError}` };
      const ok = r.status >= 200 && r.status < 300;
      return { ok, statusCode: r.status, latencyMs, model: testModel, nodeId: r.nodeId, message: ok ? "OK" : r.text };
    } catch (err) {
      return { ok: false, statusCode: 0, latencyMs: Date.now() - started, model: testModel, message: `node: ${(err as Error).message}` };
    }
  }
  try {
    const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(30_000) });
    const text = (await res.text()).slice(0, 500);
    return { ok: res.ok, statusCode: res.status, latencyMs: Date.now() - started, model: testModel, message: res.ok ? "OK" : text };
  } catch (err) {
    return { ok: false, statusCode: 0, latencyMs: Date.now() - started, model: testModel, message: (err as Error).message };
  }
}

export function registerAdminRoutes(app: FastifyInstance): void {
  const pre = { preHandler: requireAdmin };
  // Account-pool monitoring endpoints shared with the ops role (docs/auth.md §2).
  const preOps = { preHandler: requireOps };

  app.get("/api/admin/teams",pre,async()=>({data:all<{id:string;name:string|null;status:string;created_at:string;daily_token_budget:number|null;daily_cost_budget:number|null;max_concurrency:number|null;suspended_reason:string|null;suspended_until:string|null;last_error_code:string|null}>(
    "SELECT * FROM upstream_teams ORDER BY created_at DESC").map((r)=>({id:r.id,name:r.name,status:r.status,createdAt:r.created_at,
      // spec WP7: budgets (null = unlimited) and the circuit breaker's reason
      dailyTokenBudget:r.daily_token_budget,dailyCostBudget:r.daily_cost_budget,maxConcurrency:r.max_concurrency,suspendedReason:r.suspended_reason,suspendedUntil:r.suspended_until,lastErrorCode:r.last_error_code,usageToday:teamUsageToday(r.id)}))}));
  // ---------- organizations as an operations object (2026-11-01, docs/team-isolation.md "多小组织") ----------
  app.get("/api/admin/teams/overview", pre, async () => ({ data: teamOverview(await gatewayInFlight()), minReleaseDays: claimReleaseMinDays() }));
  app.get("/api/admin/teams/:id/claims", pre, async (req) => {
    const { id } = req.params as { id: string };
    if (!one("SELECT 1 FROM upstream_teams WHERE id=?", id)) notFound("team");
    return { data: teamClaims(id), minReleaseDays: claimReleaseMinDays() };
  });
  app.post("/api/admin/teams/:id/release-claims", pre, async (req) => {
    const { id } = req.params as { id: string };
    if (!one("SELECT 1 FROM upstream_teams WHERE id=?", id)) notFound("team");
    const b = body(req);
    const keys = strArray(b, "resourceKeys");
    const r = releaseTeamClaims(id, { resourceKeys: keys, actorId: req.user!.id, reason: typeof b.reason === "string" ? b.reason : null, force: b.force === true });
    for (const nodeId of r.nodeIds) pushProxies(nodeId, nodeProxyUrls(nodeId));
    return { data: r };
  });
  app.patch("/api/admin/teams/:id", pre, async (req) => {
    const { id } = req.params as { id: string };
    const t = one<{ id: string; status: string }>("SELECT id, status FROM upstream_teams WHERE id=?", id);
    if (!t) notFound("team");
    const b = body(req);
    const status = oneOf(b, "status", ["active", "disabled"] as const);
    const name = typeof b.name === "string" ? b.name.trim().slice(0, 200) : undefined;
    // spec WP7.1 budgets: null / 0 = unlimited; checked before a new conversation is bound, never kills in-flight work.
    const budget = (k: "dailyTokenBudget" | "dailyCostBudget" | "maxConcurrency"): number | null | undefined => {
      if (!(k in b)) return undefined;
      if (b[k] === null || b[k] === 0 || b[k] === "") return null;
      const n = Number(b[k]);
      if (!Number.isFinite(n) || n < 0 || n > 1e12) bad("invalid_request", `${k} must be a non-negative number or null`);
      return k === "dailyCostBudget" ? n : Math.floor(n);
    };
    const tok = budget("dailyTokenBudget"), cost = budget("dailyCostBudget"), conc = budget("maxConcurrency");
    tx(() => {
      // Lifting a suspension (circuit breaker, spec WP7.2) is an explicit operator act: clears the reason fields too.
      if (status === "active" && t.status === "suspended") resumeTeam(id, req.user!.id, typeof b.reason === "string" ? b.reason.slice(0, 300) : "operator resumed after organization-level error");
      else if (status) run("UPDATE upstream_teams SET status=? WHERE id=?", status, id);
      if (name !== undefined) run("UPDATE upstream_teams SET name=? WHERE id=?", name || null, id);
      if (tok !== undefined) run("UPDATE upstream_teams SET daily_token_budget=? WHERE id=?", tok, id);
      if (cost !== undefined) run("UPDATE upstream_teams SET daily_cost_budget=? WHERE id=?", cost, id);
      if (conc !== undefined) run("UPDATE upstream_teams SET max_concurrency=? WHERE id=?", conc, id);
      if (status && status !== t.status && !(status === "active" && t.status === "suspended")) recordProxyTeamEvent({ resourceKey: `team:${id}`, teamId: id, actorId: req.user!.id, event: status === "active" ? "team_enabled" : "team_disabled", reason: "operator" });
    });
    const r = one<{ id: string; name: string | null; status: string; created_at: string; daily_token_budget: number | null; daily_cost_budget: number | null; max_concurrency: number | null; suspended_reason: string | null; suspended_until: string | null; last_error_code: string | null }>("SELECT * FROM upstream_teams WHERE id=?", id)!;
    return { data: { id: r.id, name: r.name, status: r.status, createdAt: r.created_at, dailyTokenBudget: r.daily_token_budget, dailyCostBudget: r.daily_cost_budget, maxConcurrency: r.max_concurrency, suspendedReason: r.suspended_reason, suspendedUntil: r.suspended_until, lastErrorCode: r.last_error_code, usageToday: teamUsageToday(id) } };
  });
  app.post("/api/admin/teams/:id/cleanup-nodes", pre, async (req) => {
    const { id } = req.params as { id: string };
    const t = one<{ status: string }>("SELECT status FROM upstream_teams WHERE id=?", id);
    if (!t) notFound("team");
    // Only an organization that is switched off and owns no account may be wiped from the nodes.
    if (t.status === "active") bad("team_active", "Disable the organization first (PATCH status=disabled); node cleanup removes its worker roots and system users");
    const n = one<{ n: number }>("SELECT COUNT(*) n FROM accounts WHERE team_id=?", id)?.n ?? 0;
    if (n > 0) bad("team_has_accounts", `${n} account(s) still belong to this organization; delete or move them first`);
    const asked = retireTeamOnNodes(id);
    recordProxyTeamEvent({ resourceKey: `team:${id}`, teamId: id, actorId: req.user!.id, event: "team_node_cleanup_requested", reason: asked.length ? `asked ${asked.length} node(s): ${asked.join(",")}` : "no isolation-capable node online" });
    return { data: { nodes: asked } };
  });

  app.get("/api/admin/teams/events",pre,async(req)=>{
    const q=query(req);const w=new Where();
    w.addIf(q.proxyId,"e.proxy_id=?",q.proxyId);w.addIf(q.teamId,"e.team_id=?",q.teamId);
    return {data:all<Record<string,unknown>>(`SELECT e.*,t.name team_name FROM proxy_team_events e LEFT JOIN upstream_teams t ON t.id=e.team_id
      ${w.sql} ORDER BY e.created_at DESC,e.rowid DESC LIMIT 200`,...w.params).map((r)=>({id:r.id,resourceKey:r.resource_key,
      proxyId:r.proxy_id,nodeId:r.node_id,teamId:r.team_id,teamName:r.team_name,accountId:r.account_id,jobId:r.job_id,
      event:r.event,actorId:r.actor_id,reason:r.reason,createdAt:r.created_at}))};
  });

  // ---------- dashboard ----------

  app.get("/api/admin/dashboard", pre, async () => {
    const users = one<Record<string, number>>(
      `SELECT SUM(CASE WHEN role='consumer' THEN 1 ELSE 0 END) AS consumer,
              SUM(CASE WHEN role='provider' THEN 1 ELSE 0 END) AS provider,
              SUM(CASE WHEN role='admin' THEN 1 ELSE 0 END) AS admin,
              SUM(CASE WHEN role='ops' THEN 1 ELSE 0 END) AS ops,
              SUM(CASE WHEN status='disabled' THEN 1 ELSE 0 END) AS disabled
       FROM users`,
    );
    const now = nowIso();
    const acc = one<Record<string, number>>(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN status='active' AND review_status='approved' THEN 1 ELSE 0 END) AS active,
              SUM(CASE WHEN review_status='pending' THEN 1 ELSE 0 END) AS pending,
              SUM(CASE WHEN status='error' THEN 1 ELSE 0 END) AS error,
              SUM(CASE WHEN status='proxy_down' THEN 1 ELSE 0 END) AS proxyDown,
              MIN(CASE WHEN status='proxy_down' THEN proxy_down_since END) AS proxyDownOldestSince,
              SUM(CASE WHEN rate_limited_until > ? OR overload_until > ? OR temp_unschedulable_until > ? OR window_exhausted_until > ? THEN 1 ELSE 0 END) AS cooling
       FROM accounts`,
      now,
      now,
      now,
      now,
    );
    const nodes = one<{ total: number; online: number }>("SELECT COUNT(*) AS total, COALESCE(SUM(online),0) AS online FROM nodes");
    const balances = one<{ c: number; p: number; cl: number; cu: number }>(
      `SELECT COALESCE(SUM(CASE WHEN role<>'provider' THEN balance_usd END),0) AS c,
              COALESCE(SUM(CASE WHEN role='provider' THEN balance_usd END),0) AS p,
              COALESCE(SUM(CASE WHEN role<>'provider' THEN credit_limit_usd END),0) AS cl,
              COALESCE(SUM(CASE WHEN role<>'provider' THEN credit_used_usd END),0) AS cu FROM users`,
    );
    const ms = monthStart();
    const refundMonth = one<{ v: number; n: number }>("SELECT COALESCE(SUM(refund_usd),0) AS v, COALESCE(SUM(rows),0) AS n FROM cache_refunds WHERE created_at >= ?", ms);
    const refundPending = pendingCacheRefundAll();
    const topModels = all<{ model: string; requests: number; cost: number }>(
      `SELECT model, COUNT(*) AS requests, COALESCE(SUM(actual_cost),0) AS cost FROM usage_logs
       WHERE created_at >= ? AND status_code < 300 GROUP BY model ORDER BY cost DESC LIMIT 8`,
      ms,
    );
    const topUsers = all<{ user_id: string; name: string; requests: number; cost: number }>(
      `SELECT l.user_id, u.name, COUNT(*) AS requests, COALESCE(SUM(l.actual_cost),0) AS cost
       FROM usage_logs l LEFT JOIN users u ON u.id = l.user_id
       WHERE l.created_at >= ? AND l.status_code < 300 GROUP BY l.user_id ORDER BY cost DESC LIMIT 8`,
      ms,
    );
    return {
      data: {
        users: {
          consumer: users?.consumer ?? 0,
          provider: users?.provider ?? 0,
          admin: users?.admin ?? 0,
          disabled: users?.disabled ?? 0,
        },
        today: periodTotals(todayStart(), "", []),
        month: periodTotals(ms, "", []),
        daily: dailySeries(30, "", []),
        topModels: topModels.map((m) => ({ model: m.model, requests: m.requests, costUsd: m.cost })),
        topUsers: topUsers.map((u) => ({ userId: u.user_id, name: u.name, requests: u.requests, costUsd: u.cost })),
        accounts: {
          total: acc?.total ?? 0,
          active: acc?.active ?? 0,
          pending: acc?.pending ?? 0,
          error: acc?.error ?? 0,
          cooling: acc?.cooling ?? 0,
          /** Operator rule 2026-11-01: accounts frozen because their proxy failed, and since when the oldest. */
          proxyDown: acc?.proxyDown ?? 0,
          proxyDownOldestSince: (acc as Record<string, unknown> | undefined)?.proxyDownOldestSince ?? null,
        },
        nodes: { total: nodes?.total ?? 0, online: nodes?.online ?? 0 },
        balances: { consumerTotalUsd: balances?.c ?? 0, providerUnsettledUsd: balances?.p ?? 0, creditLimitTotalUsd: balances?.cl ?? 0, creditOutstandingUsd: balances?.cu ?? 0 },
        // Cache-rebuild refunds (docs/data-model.md §3 cache_refunds): paid this month, still owed.
        cacheRefunds: {
          monthUsd: refundMonth?.v ?? 0,
          monthRows: refundMonth?.n ?? 0,
          pendingUsd: refundPending.refundUsd,
          pendingExcessUsd: refundPending.excessUsd,
          pendingRows: refundPending.rows,
          pendingUsers: refundPending.users,
          percent: refundPending.percent,
        },
      },
    };
  });

  // ---------- users ----------

  app.get("/api/admin/users", pre, async (req) => {
    const p = page(req);
    const q = query(req);
    const w = new Where();
    w.addIf(q.role, "u.role = ?", q.role);
    w.addIf(q.status, "u.status = ?", q.status);
    if (q.q) w.add("(u.name LIKE ? OR u.id = ? OR u.login_key_preview LIKE ? OR u.note LIKE ?)", `%${q.q}%`, q.q, `${q.q}%`, `%${q.q}%`);
    const total = one<{ n: number }>(`SELECT COUNT(*) AS n FROM users u ${w.sql}`, ...w.params)!.n;
    const s = since30();
    const rows = all<UserRow>(
      `${USER_SELECT} ${w.sql} ORDER BY u.created_at DESC, u.rowid DESC LIMIT ? OFFSET ?`,
      s,
      s,
      ...w.params,
      p.pageSize,
      p.offset,
    );
    return { data: paged(rows.map(userShape), total, p) };
  });

  app.post("/api/admin/users", pre, async (req, reply) => {
    const b = body(req);
    const role = oneOf(b, "role", ["admin", "consumer", "provider", "ops"] as const, true)!;
    const name = str(b, "name", { required: true, max: 64 })!;
    const note = str(b, "note", { max: 500 }) ?? null;
    const initial = num(b, "initialBalanceUsd", { min: 0, max: 1e9 }) ?? 0;
    const groups = strArray(b, "allowedGroupIds") ?? [];
    const created = tx(() => {
      const c = createUser(role, name, note);
      if (initial > 0) applyLedger(c.id, "admin_adjust", initial, { note: "initial balance", createdBy: req.user!.id });
      setAllowedGroups(c.id, groups);
      return c;
    });
    return reply.status(201).send({ data: { ...userShape(loadUser(created.id)), loginKey: created.loginKey } });
  });

  app.get("/api/admin/users/:id", pre, async (req) => {
    const { id } = req.params as { id: string };
    const u = loadUser(id);
    const keys = all<ApiKeyRow>(`${API_KEY_SELECT} WHERE k.user_id = ? ORDER BY k.created_at DESC`, id).map(apiKeyShape);
    const ledger = all<Parameters<typeof ledgerShape>[0]>(
      "SELECT * FROM ledger WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 20",
      id,
    ).map(ledgerShape);
    const creditEvents = all<Parameters<typeof creditEventShape>[0]>(
      "SELECT * FROM credit_events WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 20",
      id,
    ).map(creditEventShape);
    const cacheRefunds = all<Parameters<typeof cacheRefundShape>[0]>(
      "SELECT * FROM cache_refunds WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 20",
      id,
    ).map(cacheRefundShape);
    return { data: { ...userShape(u), keys, recentLedger: ledger, recentCreditEvents: creditEvents, recentCacheRefunds: cacheRefunds, cacheRefund: cacheRefundSummary(id) } };
  });

  // ---- cache-rebuild refund (docs/data-model.md §3 cache_refunds): the timer pays daily; an admin can pay now ----
  app.get("/api/admin/users/:id/cache-refund", pre, async (req) => {
    const { id } = req.params as { id: string };
    loadUser(id);
    return { data: cacheRefundSummary(id) };
  });

  app.post("/api/admin/users/:id/cache-refund", pre, async (req) => {
    const { id } = req.params as { id: string };
    const u = loadUser(id);
    if (u.role === "provider") bad("invalid_request", "Cache refunds apply to consumer accounts only");
    const b = body(req);
    const r = runCacheRefund(id, { createdBy: req.user!.id, note: str(b, "note", { max: 500 }) ?? undefined });
    if (!r) bad("nothing_pending", "This user has no switched requests waiting for a refund");
    return { data: { refund: cacheRefundShape(r), summary: cacheRefundSummary(id) } };
  });

  app.get("/api/admin/users/:id/cache-refunds", pre, async (req) => {
    const { id } = req.params as { id: string };
    loadUser(id);
    const p = page(req);
    const total = one<{ n: number }>("SELECT COUNT(*) AS n FROM cache_refunds WHERE user_id = ?", id)!.n;
    const rows = all<Parameters<typeof cacheRefundShape>[0]>(
      "SELECT * FROM cache_refunds WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?",
      id,
      p.pageSize,
      p.offset,
    );
    return { data: paged(rows.map(cacheRefundShape), total, p) };
  });

  app.get("/api/admin/cache-refunds", pre, async (req) => {
    const p = page(req);
    const total = one<{ n: number }>("SELECT COUNT(*) AS n FROM cache_refunds")!.n;
    const rows = all<Parameters<typeof cacheRefundShape>[0]>(
      `SELECT r.*, u.name AS user_name FROM cache_refunds r LEFT JOIN users u ON u.id = r.user_id
       ORDER BY r.created_at DESC, r.rowid DESC LIMIT ? OFFSET ?`,
      p.pageSize,
      p.offset,
    );
    return { data: { ...paged(rows.map(cacheRefundShape), total, p), pending: pendingCacheRefundAll() } };
  });

  /** Pay everyone now (does not move the scheduler's clock). */
  // Key-policy judge (spec §6.2 / WP8): manual run (does not move the daily schedule) and per-key flip history.
  app.post("/api/admin/key-policy/judge/run", pre, async () => ({ data: judgeAllKeys() }));
  app.post("/api/admin/keys/:id/policy-judge", pre, async (req) => {
    const { id } = req.params as { id: string };
    if (!one("SELECT 1 FROM api_keys WHERE id = ?", id)) notFound("key");
    return { data: judgeKey(id) };
  });
  app.get("/api/admin/keys/:id/policy-events", pre, async (req) => {
    const { id } = req.params as { id: string };
    return { data: listKeyPolicyEvents(id) };
  });

  app.post("/api/admin/cache-refund/run", pre, async (req) => {
    const b = body(req);
    const s = runCacheRefundsForAll({ createdBy: req.user!.id, note: str(b, "note", { max: 500 }) ?? undefined });
    return { data: s };
  });

  // ---- credit line (docs/data-model.md §4): admin grants a limit, usage accrues, admin settles ----
  app.post("/api/admin/users/:id/credit-limit", pre, async (req) => {
    const { id } = req.params as { id: string };
    const u = loadUser(id);
    if (u.role === "provider") bad("invalid_request", "Credit lines apply to consumer accounts only");
    const b = body(req);
    const limit = num(b, "limitUsd", { required: true, min: 0, max: 1e9 })!;
    const r = tx(() => setCreditLimit(id, limit, { note: str(b, "note", { max: 500 }) ?? null, createdBy: req.user!.id }));
    return { data: r };
  });

  app.post("/api/admin/users/:id/settle", pre, async (req) => {
    const { id } = req.params as { id: string };
    const u = loadUser(id);
    if (u.role === "provider") bad("invalid_request", "Use payout for provider accounts");
    const b = body(req);
    const amount = num(b, "amountUsd", { min: 0.00000001, max: 1e9 }); // absent = settle everything outstanding
    const outstanding = one<{ v: number }>("SELECT credit_used_usd AS v FROM users WHERE id = ?", id)!.v;
    if (outstanding <= 0) bad("nothing_to_settle", "This user has no outstanding usage");
    if (amount !== undefined && amount > outstanding + 1e-9) bad("amount_exceeds_outstanding", `Outstanding usage is only ${outstanding.toFixed(4)}`);
    const r = tx(() => settleCredit(id, amount ?? null, { note: str(b, "note", { max: 500 }) ?? null, createdBy: req.user!.id }));
    return { data: r };
  });

  app.get("/api/admin/users/:id/credit-events", pre, async (req) => {
    const { id } = req.params as { id: string };
    loadUser(id);
    const p = page(req);
    const total = one<{ n: number }>("SELECT COUNT(*) AS n FROM credit_events WHERE user_id = ?", id)!.n;
    const rows = all<Parameters<typeof creditEventShape>[0]>(
      "SELECT * FROM credit_events WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?",
      id,
      p.pageSize,
      p.offset,
    );
    return { data: paged(rows.map(creditEventShape), total, p) };
  });

  app.patch("/api/admin/users/:id", pre, async (req) => {
    const { id } = req.params as { id: string };
    const u = loadUser(id);
    const b = body(req);
    const name = str(b, "name", { max: 64 });
    const status = oneOf(b, "status", ["active", "disabled"] as const);
    if (status === "disabled" && id === req.user!.id) bad("invalid_request", "You cannot disable yourself");
    const groups = strArray(b, "allowedGroupIds");
    // Provider role: where its self-onboarded accounts land (docs/onboarding.md §1 原则 5). null = default group.
    const onboardGroup = "onboardGroupId" in b ? (str(b, "onboardGroupId", { max: 64 }) ?? null) : undefined;
    if (onboardGroup !== undefined && u.role !== "provider") bad("invalid_request", "onboardGroupId applies to provider users only");
    if (onboardGroup) loadGroup(onboardGroup);
    // Per-user admission limits (docs/gateway.md §2b): null / 0 = back to the gateway defaults.
    const clearish = (v: unknown) => v === null || v === "" || v === 0;
    const maxInflight = "maxInflight" in b ? (clearish(b.maxInflight) ? null : num(b, "maxInflight", { int: true, min: 1, max: 10000 }) ?? null) : undefined;
    const maxInflightUsd = "maxInflightUsd" in b ? (clearish(b.maxInflightUsd) ? null : num(b, "maxInflightUsd", { min: 0.01, max: 1e6 }) ?? null) : undefined;
    tx(() => {
      if (name) run("UPDATE users SET name = ? WHERE id = ?", name, id);
      if (maxInflight !== undefined) run("UPDATE users SET max_inflight = ? WHERE id = ?", maxInflight, id);
      if (maxInflightUsd !== undefined) run("UPDATE users SET max_inflight_usd = ? WHERE id = ?", maxInflightUsd, id);
      if ("note" in b) run("UPDATE users SET note = ? WHERE id = ?", str(b, "note", { max: 500 }) ?? null, id);
      if (onboardGroup !== undefined) run("UPDATE users SET onboard_group_id = ? WHERE id = ?", onboardGroup, id);
      if (status) {
        run("UPDATE users SET status = ? WHERE id = ?", status, id);
        if (status === "disabled") dropSessions(id);
      }
      if (groups) setAllowedGroups(id, groups);
    });
    if (status === "disabled" && u.role === "provider") {
      for (const n of all<{ node_id: string }>("SELECT node_id FROM nodes WHERE provider_id = ?", id)) {
        disconnectNode(n.node_id, "provider_disabled");
      }
    }
    return { data: userShape(loadUser(id)) };
  });

  app.post("/api/admin/users/:id/reset-login-key", pre, async (req) => {
    const { id } = req.params as { id: string };
    const u = loadUser(id);
    return { data: { loginKey: resetLoginKey(id, u.role) } };
  });

  app.post("/api/admin/users/:id/adjust-balance", pre, async (req) => {
    const { id } = req.params as { id: string };
    loadUser(id);
    const b = body(req);
    const amount = num(b, "amountUsd", { required: true, min: -1e9, max: 1e9 })!;
    if (amount === 0) bad("invalid_amount", "amountUsd must be non-zero");
    const r = tx(() =>
      applyLedger(id, "admin_adjust", amount, { note: str(b, "note", { max: 500 }) ?? null, createdBy: req.user!.id }),
    );
    return { data: { balanceUsd: r.balanceAfter } };
  });

  app.post("/api/admin/users/:id/payout", pre, async (req) => {
    const { id } = req.params as { id: string };
    const u = loadUser(id);
    if (u.role !== "provider") bad("invalid_request", "Payouts apply to provider accounts only");
    const b = body(req);
    const amount = num(b, "amountUsd", { required: true, min: 0.00000001, max: 1e9 })!;
    const r = tx(() => {
      const cur = one<{ balance_usd: number }>("SELECT balance_usd FROM users WHERE id = ?", id)!.balance_usd;
      if (amount > cur + 1e-9) bad("insufficient_balance", `Unsettled balance is only ${cur.toFixed(4)}`);
      return applyLedger(id, "payout", -amount, {
        ref: str(b, "ref", { max: 200 }) ?? null,
        note: str(b, "note", { max: 500 }) ?? null,
        createdBy: req.user!.id,
      });
    });
    return { data: { balanceUsd: r.balanceAfter } };
  });

  app.delete("/api/admin/users/:id", pre, async (req) => {
    const { id } = req.params as { id: string };
    loadUser(id);
    if (id === req.user!.id) bad("invalid_request", "You cannot delete yourself");
    if (one("SELECT 1 FROM usage_logs WHERE user_id = ? OR provider_id = ? LIMIT 1", id, id)) {
      bad("user_has_usage", "This user has usage history; disable instead of deleting");
    }
    const nodeIds = all<{ node_id: string }>("SELECT node_id FROM nodes WHERE provider_id = ?", id).map((n) => n.node_id);
    tx(() => {
      // Release what the cascade cannot: proxies bound to this user's accounts
      // and the ledgers of nodes this user registered.
      for (const acc of all<{ id: string; status: string; error_message: string | null }>("SELECT id, status, error_message FROM accounts WHERE owner_id = ?", id)) {
        releaseAccountProxies(acc.id, acc);
      }
      for (const nodeId of nodeIds) releaseNodeResources(nodeId, "node owner deleted");
      run("DELETE FROM users WHERE id = ?", id);
    });
    for (const nodeId of nodeIds) disconnectNode(nodeId, "owner_deleted");
    return { data: { ok: true } };
  });

  // ---------- API keys (all users) ----------

  app.get("/api/admin/keys", pre, async (req) => {
    const p = page(req);
    const q = query(req);
    const w = new Where();
    w.addIf(q.userId, "k.user_id = ?", q.userId);
    w.addIf(q.groupId, "k.group_id = ?", q.groupId);
    if (q.q) w.add("(k.name LIKE ? OR k.key_preview LIKE ? OR u.name LIKE ?)", `%${q.q}%`, `${q.q}%`, `%${q.q}%`);
    const total = one<{ n: number }>(
      `SELECT COUNT(*) AS n FROM api_keys k LEFT JOIN users u ON u.id = k.user_id ${w.sql}`,
      ...w.params,
    )!.n;
    const rows = all<ApiKeyRow>(`${API_KEY_SELECT} ${w.sql} ORDER BY k.created_at DESC LIMIT ? OFFSET ?`, ...w.params, p.pageSize, p.offset);
    return { data: paged(rows.map(apiKeyShape), total, p) };
  });

  app.patch("/api/admin/keys/:id", pre, async (req) => {
    const { id } = req.params as { id: string };
    const k = one<ApiKeyRow>(`${API_KEY_SELECT} WHERE k.id = ?`, id);
    if (!k) notFound("key");
    updateKey(id, applyKeyFields(body(req), k.user_id, false, req.user!.id));
    return { data: apiKeyShape(one<ApiKeyRow>(`${API_KEY_SELECT} WHERE k.id = ?`, id)!) };
  });

  // ---------- groups ----------

  app.get("/api/admin/groups", preOps, async () => ({
    data: all<GroupRow>("SELECT * FROM groups ORDER BY sort_order, created_at").map(groupOut),
  }));

  const writeGroup = (b: Record<string, unknown>, existing: GroupRow | null): GroupRow => {
    const name = str(b, "name", { required: !existing, max: 64 });
    if (name && one("SELECT 1 FROM groups WHERE name = ? AND id <> ?", name, existing?.id ?? "")) {
      bad("group_exists", "A group with this name already exists");
    }
    const al = validateAllowlistInput(b.modelAllowlist);
    if (al.error) bad("invalid_allowlist", al.error);
    const rate = num(b, "rateMultiplier", { min: 0, max: 1000 });
    const status = oneOf(b, "status", ["active", "disabled"] as const);
    if (existing?.id === "default" && status === "disabled") bad("group_protected", "The default group cannot be disabled");
    const g: GroupRow = existing
      ? { ...existing }
      : {
          id: newId(),
          name: name!,
          description: null,
          rate_multiplier: 1,
          model_allowlist: null,
          is_exclusive: 0,
          status: "active",
          sort_order: 0,
          created_at: nowIso(),
        };
    if (name) g.name = name;
    if ("description" in b) g.description = str(b, "description", { max: 500 }) ?? null;
    if (rate !== undefined) g.rate_multiplier = rate;
    if ("modelAllowlist" in b) g.model_allowlist = al.value ? JSON.stringify(al.value) : null;
    if (typeof b.isExclusive === "boolean") g.is_exclusive = b.isExclusive ? 1 : 0;
    if (status) g.status = status;
    const so = num(b, "sortOrder", { int: true, min: -100000, max: 100000 });
    if (so !== undefined) g.sort_order = so;
    run(
      `INSERT INTO groups (id, name, description, rate_multiplier, model_allowlist, is_exclusive, status, sort_order, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name=excluded.name, description=excluded.description,
         rate_multiplier=excluded.rate_multiplier, model_allowlist=excluded.model_allowlist,
         is_exclusive=excluded.is_exclusive, status=excluded.status, sort_order=excluded.sort_order`,
      g.id,
      g.name,
      g.description,
      g.rate_multiplier,
      g.model_allowlist,
      g.is_exclusive,
      g.status,
      g.sort_order,
      g.created_at,
    );
    return loadGroup(g.id);
  };

  app.post("/api/admin/groups", pre, async (req, reply) => reply.status(201).send({ data: groupOut(writeGroup(body(req), null)) }));

  app.patch("/api/admin/groups/:id", pre, async (req) => {
    const { id } = req.params as { id: string };
    return { data: groupOut(writeGroup(body(req), loadGroup(id))) };
  });

  app.delete("/api/admin/groups/:id", pre, async (req) => {
    const { id } = req.params as { id: string };
    loadGroup(id);
    if (id === "default" || id === getSetting("default_group_id")) bad("group_protected", "The default group cannot be deleted");
    const n = one<{ n: number }>("SELECT COUNT(*) AS n FROM api_keys WHERE group_id = ?", id)!.n;
    if (n > 0) bad("group_in_use", `${n} API key(s) still use this group`);
    run("DELETE FROM groups WHERE id = ?", id);
    return { data: { ok: true } };
  });

  // ---------- accounts ----------

  // Paged list, split by kind: subscription (OAuth) vs api (apikey / upstream relay).
  app.get("/api/admin/accounts", preOps, async (req) => {
    const q = query(req);
    const p = page(req);
    const w = new Where();
    if (q.kind === "subscription") w.add("a.type = 'oauth'");
    else if (q.kind === "api") w.add("a.type IN ('apikey','upstream')");
    else if (q.kind) bad("invalid_request", "kind must be api or subscription");
    w.addIf(q.platform, "a.platform = ?", q.platform);
    w.addIf(q.status, "a.status = ?", q.status);
    w.addIf(q.reviewStatus, "a.review_status = ?", q.reviewStatus);
    w.addIf(q.nodeId, "a.node_id = ?", q.nodeId);
    if (q.teamId && req.user!.role === "admin") w.add("a.team_id = ?", q.teamId);
    if (q.ownerId === "platform") w.add("a.owner_id IS NULL");
    else w.addIf(q.ownerId, "a.owner_id = ?", q.ownerId);
    if (q.q) w.add("(a.name LIKE ? OR a.account_email LIKE ? OR a.base_url LIKE ?)", `%${q.q}%`, `%${q.q}%`, `%${q.q}%`);
    const sortCol = ({ createdAt: "a.created_at", lastUsedAt: "a.last_used_at", name: "a.name", priority: "a.priority" } as Record<string, string>)[q.sort ?? ""];
    const dir = q.order === "asc" ? "ASC" : "DESC";
    // Default order keeps pending reviews on top; an explicit sort replaces it.
    const orderBy = sortCol
      ? `${sortCol} ${dir} NULLS LAST, a.rowid ${dir}`
      : "CASE a.review_status WHEN 'pending' THEN 0 ELSE 1 END, a.created_at DESC, a.rowid DESC";
    const total = one<{ n: number }>(`SELECT COUNT(*) AS n FROM accounts a ${w.sql}`, ...w.params)!.n;
    const rows = all<AccountRow & { owner_name: string | null }>(
      `SELECT a.*, u.name AS owner_name FROM accounts a LEFT JOIN users u ON u.id = a.owner_id ${w.sql}
       ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
      ...w.params,
      p.pageSize,
      p.offset,
    );
    const groups = accountGroupsMap();
    const usage = accountUsageStats(rows.map((a) => a.id));
    const inFlight = await gatewayInFlight();
    const counts = one<{ api: number; subscription: number; pending: number }>(
      `SELECT SUM(CASE WHEN type IN ('apikey','upstream') THEN 1 ELSE 0 END) AS api,
              SUM(CASE WHEN type = 'oauth' THEN 1 ELSE 0 END) AS subscription,
              SUM(CASE WHEN review_status = 'pending' THEN 1 ELSE 0 END) AS pending
       FROM accounts`,
    );
    return {
      data: {
        ...paged(
          rows.map((a) =>
            adminAccountShape(a, groups.get(a.id) ?? [], undefined, {
              showTeam:req.user!.role==='admin',
              usage: usage.get(a.id),
              inFlight: inFlight ? (inFlight[a.id] ?? 0) : null,
            }),
          ),
          total,
          p,
        ),
        counts: { api: counts?.api ?? 0, subscription: counts?.subscription ?? 0, pending: counts?.pending ?? 0, ...proxyDownSummary() },
      },
    };
  });

  app.post("/api/admin/accounts", pre, async (req, reply) => {
    const b = body(req);
    const f = parseAccountFields(b, null, true);
    const nodeId = str(b, "nodeId") ?? null;
    // Pinning a node implies route=node; the owner follows the node's provider unless given.
    const route = oneOf(b, "route", ["direct", "node"] as const) ?? (nodeId ? "node" : "direct");
    let ownerId = str(b, "ownerId") ?? null;
    if (nodeId) {
      if (route !== "node") bad("invalid_request", "nodeId only applies to route=node accounts");
      ownerId = resolveNodeOwner(nodeId, ownerId, null);
    }
    if (ownerId) {
      const o = one<{ role: string }>("SELECT role FROM users WHERE id = ?", ownerId);
      if (!o || o.role !== "provider") bad("invalid_request", "ownerId must be a provider user");
    }
    if (route === "node" && !ownerId && !nodeId) {
      bad("invalid_request", "route=node requires ownerId (a provider) or a nodeId (a platform node)");
    }
    const priority = num(b, "priority", { int: true, min: 0, max: 100000 }) ?? 50;
    const payout = num(b, "payoutRate", { min: 0, max: 1 }) ?? (ownerId ? Number(getSetting("provider_default_payout_rate")) : 0);
    if(f.platform==='anthropic' && f.type==='oauth'){
      if(!nodeId || route!=='node')bad("invalid_request","New subscription accounts require a pinned node and verified proxy");
      const id=await importOAuthCredential("admin",req.user!.id,nodeId,f.credential!,{
        ownerId,name:f.name,expectedTeamId:f.credential?.orgUuid,
        teamName:str(b,"teamName",{max:200}),groupId:(strArray(b,"groupIds")??[])[0],
        concurrencyLimit:num(b,"concurrency",{int:true,min:0,max:100000})??0,
        rpmLimit:num(b,"rpmLimit",{int:true,min:0,max:100000})??0,
      });
      tx(()=>{
        setAccountGroups(id,strArray(b,"groupIds")??[getSetting("default_group_id")],priority);
        run("UPDATE accounts SET priority=?,payout_rate=?,executor=?,models=?,model_mapping=?,base_url=? WHERE id=?",
          priority,payout,f.executor??"direct",f.models?.length?JSON.stringify(f.models):null,
          f.modelMapping?JSON.stringify(f.modelMapping):null,f.baseUrl??'https://api.anthropic.com',id);
      });
      return reply.status(201).send({data:accountOut(id,true)});
    }
    const id = newId();
    const now = nowIso();
    tx(() => {
      if(route==="node" && nodeId)assertNodeCapacity(nodeId);
      run(
        `INSERT INTO accounts (id, name, platform, type, executor, protocol, base_url, credential_enc, models, model_mapping,
                               owner_id, route, node_id, review_status, payout_rate, priority, concurrency, rpm_limit,
                               raw_passthrough, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'approved', ?, ?, ?, ?, ?, ?, ?)`,
        id,
        f.name,
        f.platform,
        f.type,
        f.executor ?? "direct",
        f.protocol,
        f.baseUrl ?? null,
        encryptJson(f.credential),
        f.models?.length ? JSON.stringify(f.models) : null,
        f.modelMapping ? JSON.stringify(f.modelMapping) : null,
        ownerId,
        route,
        route === "node" ? nodeId : null,
        payout,
        priority,
        num(b, "concurrency", { int: true, min: 0, max: 100000 }) ?? 0,
        num(b, "rpmLimit", { int: true, min: 0, max: 100000 }) ?? 0,
        b.rawPassthrough === true ? 1 : 0,
        now,
        now,
      );
      setAccountGroups(id, strArray(b, "groupIds") ?? [getSetting("default_group_id")], priority);
    });
    return reply.status(201).send({ data: accountOut(id,req.user!.role==='admin') });
  });

  app.patch("/api/admin/accounts/:id", preOps, async (req) => {
    const { id } = req.params as { id: string };
    const a = loadAccount(id);
    const b = body(req);
    // ops may only enable / disable; everything else (credential, groups, payout, routing) stays admin-only.
    if (req.user!.role === "ops" && Object.keys(b).some((k) => k !== "status")) {
      bad("role_not_permitted", "Account ops may only change status", 403);
    }
    const f = parseAccountFields(b, a, true);
    if(a.platform==='anthropic' && a.type==='oauth'){
      if(f.credential!==undefined || (f.platform!==undefined && f.platform!==a.platform) || (f.type!==undefined && f.type!==a.type) ||
        (b.route!==undefined && b.route!==a.route) || ('nodeId' in b && b.nodeId!==a.node_id))
        bad("fixed_binding_required","Use re-authorization to update a subscription credential; its organization and proxy are fixed");
    }
    if('teamName' in b){
      if(req.user!.role!=='admin')bad("role_not_permitted","Only administrators may name an organization",403);
      if(!a.team_id)bad("legacy_account_unmanaged","Legacy organizations are not inferred");
      run("UPDATE upstream_teams SET name=? WHERE id=?",str(b,"teamName",{max:200})??null,a.team_id);
    }

    const sets: string[] = ["updated_at = ?"];
    const params: unknown[] = [nowIso()];
    const set = (col: string, v: unknown) => (sets.push(`${col} = ?`), params.push(v));
    if (f.name !== undefined) set("name", f.name);
    if (f.platform !== undefined) set("platform", f.platform);
    if (f.type !== undefined) set("type", f.type);
    if (f.executor !== undefined) set("executor", f.executor);
    if (f.protocol !== undefined) set("protocol", f.protocol);
    if (f.baseUrl !== undefined) set("base_url", f.baseUrl);
    if (f.credential !== undefined) set("credential_enc", encryptJson(f.credential));
    if (f.models !== undefined) set("models", f.models.length ? JSON.stringify(f.models) : null);
    if (f.modelMapping !== undefined) set("model_mapping", f.modelMapping ? JSON.stringify(f.modelMapping) : null);
    const route = oneOf(b, "route", ["direct", "node"] as const);
    const nodeIdInput = "nodeId" in b ? (str(b, "nodeId") ?? null) : undefined;
    const nextRoute = route ?? a.route;
    const nextNodeId = nodeIdInput !== undefined ? nodeIdInput : route === "direct" ? null : a.node_id;
    if (nodeIdInput && nextRoute !== "node") bad("invalid_request", "nodeId only applies to route=node accounts (send route:\"node\" as well)");
    if (route) {
      // Platform-owned accounts can only leave through a pinned platform node.
      if (route === "node" && !a.owner_id && !nextNodeId) bad("invalid_request", "route=node requires a provider owner or a pinned platform node");
      set("route", route);
    }
    if (route === "direct") set("node_id", null); // unbind
    else if (nodeIdInput !== undefined) set("node_id", nodeIdInput);
    // Binding an account to a (new) node: node must exist, belong to the
    // account's owner (or be a platform node for platform-owned accounts), be
    // online, and have spare capacity (protocol v2; default capacity 100).
    if (nextRoute === "node" && nextNodeId && (a.route !== "node" || a.node_id !== nextNodeId)) {
      resolveNodeOwner(nextNodeId, a.owner_id, id);
      const node = one<{ online: number; capacity: number }>(
        "SELECT online, capacity FROM nodes WHERE node_id = ?",
        nextNodeId,
      );
      if (!node) bad("node_not_found", `Node '${nextNodeId}' not found`);
      if (node.online !== 1) bad("node_offline", "Target node is not online");

    }
    const priority = num(b, "priority", { int: true, min: 0, max: 100000 });
    if (priority !== undefined) set("priority", priority);
    const conc = num(b, "concurrency", { int: true, min: 0, max: 100000 });
    if (conc !== undefined) set("concurrency", conc);
    const rpm = num(b, "rpmLimit", { int: true, min: 0, max: 100000 });
    if (rpm !== undefined) set("rpm_limit", rpm);
    if (typeof b.rawPassthrough === "boolean") set("raw_passthrough", b.rawPassthrough ? 1 : 0);
    const payout = num(b, "payoutRate", { min: 0, max: 1 });
    if (payout !== undefined) set("payout_rate", payout);
    const status = oneOf(b, "status", ["active", "disabled"] as const);
    // Operator rule 2026-11-01: a proxy-frozen account is not re-enabled by the generic status switch; the
    // dedicated release (checks the proxy is live again) or rebind routes are the only ways back.
    if (status === "active" && a.status === "proxy_down") bad("proxy_down_use_release", "This account is frozen because its proxy failed; use proxy-release (after the proxy is live again) or proxy-rebind instead of enabling it");
    tx(() => {
      if(nextRoute==="node" && nextNodeId && (a.route!=="node" || a.node_id!==nextNodeId))assertNodeCapacity(nextNodeId,id);
      run(`UPDATE accounts SET ${sets.join(", ")} WHERE id = ?`, ...params, id);
      if (status === "active") clearAccountState(id);
      else if (status === "disabled") run("UPDATE accounts SET status = 'disabled' WHERE id = ?", id);
      const groupIds = strArray(b, "groupIds");
      if (groupIds) setAccountGroups(id, groupIds, priority ?? a.priority);
    });
    return { data: accountOut(id,req.user!.role==='admin') };
  });

  // ---------- proxy freeze (operator rule 2026-11-01): the only two ways out of status 'proxy_down' ----------
  // ---- telemetry evidence (spec §6.4 / WP6): what proves this account's native Claude Code telemetry is accepted ----
  app.get("/api/admin/accounts/:id/telemetry-evidence", pre, async (req) => {
    const { id } = req.params as { id: string };
    if (!one("SELECT 1 FROM accounts WHERE id = ?", id)) notFound("account");
    const q = req.query as { profileId?: string };
    const profileId = typeof q.profileId === "string" && q.profileId ? q.profileId.slice(0, 64) : `cc-${CC_VERSION}-restricted`;
    return { data: { verdict: telemetryEvidenceLevel(id, profileId), rows: listTelemetryEvidence(id), structural: listTelemetryEvidence(null, profileId) } };
  });
  app.post("/api/admin/accounts/:id/telemetry-evidence", pre, async (req) => {
    const { id } = req.params as { id: string };
    if (!one("SELECT 1 FROM accounts WHERE id = ?", id)) notFound("account");
    const evidenceId = recordTelemetryEvidence(parseEvidenceBody(body(req), id));
    return { data: { id: evidenceId } };
  });
  // Structural (controlled, G10-A) evidence describes a profile — the binary — not an account.
  app.post("/api/admin/telemetry-evidence", pre, async (req) => {
    const b = body(req);
    if (b.source !== "controlled") bad("invalid_request", "account-less evidence must be source=controlled (structural); real evidence belongs to an account");
    return { data: { id: recordTelemetryEvidence(parseEvidenceBody(b, null)) } };
  });

  app.post("/api/admin/accounts/:id/proxy-release", pre, async (req) => {
    const { id } = req.params as { id: string };
    loadAccount(id);
    const b = body(req);
    try {
      releaseProxyFreeze(id, req.user!.id, typeof b.note === "string" ? b.note : null);
    } catch (err) {
      if (err instanceof ProxyFreezeError) bad(err.code, err.message);
      throw err;
    }
    return { data: accountOut(id, true) };
  });
  app.post("/api/admin/accounts/:id/proxy-rebind", pre, async (req) => {
    const { id } = req.params as { id: string };
    const a = loadAccount(id);
    const b = body(req);
    const proxyId = typeof b.proxyId === "string" && b.proxyId ? b.proxyId : undefined;
    let moved: { oldProxyId: string | null; newProxyId: string; exitIp: string | null };
    try {
      moved = tx(() => {
        const r = rebindAccountProxy(id, req.user!.id, { proxyId });
        if (a.status === "proxy_down") {
          run(`UPDATE accounts SET status = 'active', error_message = NULL, proxy_down_since = NULL, proxy_down_reason = NULL, proxy_down_proxy_id = NULL,
                 temp_unschedulable_until = NULL, updated_at = ? WHERE id = ? AND status = 'proxy_down'`, nowIso(), id);
          recordProxyTeamEvent({ resourceKey: `proxy:${r.newProxyId}`, proxyId: r.newProxyId, nodeId: a.node_id, teamId: a.team_id, accountId: id, actorId: req.user!.id,
            event: "account_proxy_released", reason: `operator rebound the frozen account from ${r.oldProxyId ?? "-"} to ${r.newProxyId} (frozen since ${a.proxy_down_since ?? "?"}: ${a.proxy_down_reason ?? "?"})` });
        }
        return r;
      });
    } catch (err) {
      if (err instanceof ProxyInputError) bad("proxy_rebind_failed", err.message);
      throw err;
    }
    const nodeId = a.node_id ?? one<{ node_id: string }>("SELECT node_id FROM node_proxies WHERE id = ?", moved.newProxyId)?.node_id;
    if (nodeId) pushProxies(nodeId, nodeProxyUrls(nodeId));
    return { data: { ...moved, account: accountOut(id, true) } };
  });

  app.post("/api/admin/accounts/:id/review", pre, async (req) => {
    const { id } = req.params as { id: string };
    const a = loadAccount(id);
    const b = body(req);
    const action = oneOf(b, "action", ["approve", "reject"] as const, true);
    const note = str(b, "note", { max: 500 }) ?? null;
    tx(() => {
      if (action === "reject") {
        run("UPDATE accounts SET review_status = 'rejected', review_note = ?, updated_at = ? WHERE id = ?", note, nowIso(), id);
        return;
      }
      const priority = num(b, "priority", { int: true, min: 0, max: 100000 }) ?? a.priority;
      const payout =
        num(b, "payoutRate", { min: 0, max: 1 }) ??
        (a.payout_rate > 0 ? a.payout_rate : Number(getSetting("provider_default_payout_rate")));
      run(
        `UPDATE accounts SET review_status = 'approved', review_note = ?, priority = ?, payout_rate = ?,
           status = 'active', error_message = NULL, updated_at = ? WHERE id = ?`,
        note,
        priority,
        payout,
        nowIso(),
        id,
      );
      const groupIds = strArray(b, "groupIds");
      const existing = one<{ n: number }>("SELECT COUNT(*) AS n FROM account_groups WHERE account_id = ?", id)!.n;
      if (groupIds) setAccountGroups(id, groupIds, priority);
      else if (existing === 0) setAccountGroups(id, [getSetting("default_group_id")], priority);
    });
    return { data: accountOut(id,req.user!.role==='admin') };
  });

  // Probe the CCR subscription window now (docs/ccr-supply.md §7) and return
  // the refreshed account. Probe failures do not touch the account status.
  app.post("/api/admin/accounts/:id/window", preOps, async (req) => {
    const { id } = req.params as { id: string };
    const a = loadAccount(id);
    if (!hasSubscriptionWindow(a)) bad("invalid_request", "Window probes apply to Anthropic subscription (OAuth) accounts");
    try {
      await probeWindow(a);
    } catch (err) {
      bad("window_probe_failed", req.user!.role==='admin'?(err as Error).message:"Account window probe failed");
    }
    return { data: accountOut(id,req.user!.role==='admin') };
  });

  /** Refresh email + plan from the OAuth profile (through the account's node / bound proxy). */
  app.post("/api/admin/accounts/:id/profile", preOps, async (req) => {
    const { id } = req.params as { id: string };
    const a = loadAccount(id);
    if (!hasSubscriptionWindow(a)) bad("invalid_request", "Profile applies to Anthropic subscription (OAuth) accounts");
    try {
      await enrichAccountProfile(a);
    } catch (err) {
      bad("profile_failed", req.user!.role==='admin'?(err as Error).message:"Account profile probe failed");
    }
    return { data: accountOut(id,req.user!.role==='admin') };
  });

  app.post("/api/admin/accounts/:id/test", preOps, async (req) => {
    const { id } = req.params as { id: string };
    const a = loadAccount(id);
    const b = body(req);
    const mode = oneOf(b, "mode", ["profile", "inference"] as const) ?? (hasSubscriptionWindow(a) ? "profile" : "inference");
    if (mode === "profile") {
      if (!hasSubscriptionWindow(a)) bad("invalid_request", "Profile validation applies to Anthropic subscription accounts");
      try {
        const checked = await validateAccountControlPlane(a);
        const result = { ok: true, statusCode: 200, latencyMs: 0, message: "Profile and roles validated without inference", validation: "profile" as const, profile: { email: checked.profile.email, subscriptionType: checked.profile.subscriptionType }, roles: checked.roles };
        return { data: req.user!.role === "admin" ? result : { ...result, profile: undefined, roles: undefined } };
      } catch (err) {
        const result = { ok: false, statusCode: 0, latencyMs: 0, message: (err as Error).message, validation: "profile" as const };
        return { data: req.user!.role === "admin" ? result : { ...result, message: "Account profile validation failed" } };
      }
    }
    const result = await testAccount(a, str(b, "model"));
    if (result.ok) run("UPDATE accounts SET last_inference_at = ? WHERE id = ?", nowIso(), id);
    return { data: req.user!.role === "admin" ? { ...result, validation: "inference" as const } : { ...result, validation: "inference" as const, message: result.ok ? "OK" : "Account probe failed" } };
  });

  app.delete("/api/admin/accounts/:id", pre, async (req) => {
    const { id } = req.params as { id: string };
    const a = loadAccount(id);
    tx(() => {
      // Deleting an account releases its bound proxy back to the pool (docs/onboarding.md §6.4);
      // a proxy from a rejected account (status error) enters the release cooldown.
      releaseAccountProxies(id, a);
      run("DELETE FROM accounts WHERE id = ?", id);
    });
    return { data: { ok: true } };
  });

  // ---------- models & pricing ----------

  app.get("/api/admin/models", pre, async () => ({
    data: listRegistry().map((m) => ({
      modelId: m.modelId,
      displayName: m.displayName,
      platform: m.platform,
      source: m.source,
      enabled: m.enabled,
      overridden: m.overridden,
      prices: m.prices,
      catalogPrices: m.catalogPrices,
    })),
  }));

  app.put("/api/admin/models/:modelId", pre, async (req) => {
    const { modelId } = req.params as { modelId: string };
    if (!/^[\w.:/@+-]{1,120}$/.test(modelId)) bad("invalid_request", "Invalid model id");
    const b = body(req);
    const existing = getModelEntry(modelId);
    const platform = str(b, "platform") ?? existing?.platform;
    if (!platform || !getPlatform(platform)) bad("invalid_request", "platform is required and must be a known platform");
    const price = (k: string, fallback: number) => num(b, k, { min: 0, max: 100000 }) ?? fallback;
    run(
      `INSERT INTO model_prices (model_id, display_name, platform, input_per_m, output_per_m, cache_read_per_m,
                                 cache_write_per_m, enabled, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(model_id) DO UPDATE SET display_name=excluded.display_name, platform=excluded.platform,
         input_per_m=excluded.input_per_m, output_per_m=excluded.output_per_m,
         cache_read_per_m=excluded.cache_read_per_m, cache_write_per_m=excluded.cache_write_per_m,
         enabled=excluded.enabled, updated_at=excluded.updated_at`,
      modelId,
      str(b, "displayName", { max: 120 }) ?? existing?.displayName ?? modelId,
      platform,
      price("inputPerM", existing?.prices.inputPerM ?? 0),
      price("outputPerM", existing?.prices.outputPerM ?? 0),
      price("cacheReadPerM", existing?.prices.cacheReadPerM ?? 0),
      price("cacheWritePerM", existing?.prices.cacheWritePerM ?? 0),
      typeof b.enabled === "boolean" ? (b.enabled ? 1 : 0) : existing ? (existing.enabled ? 1 : 0) : 1,
      nowIso(),
    );
    return { data: getModelEntry(modelId) };
  });

  app.delete("/api/admin/models/:modelId", pre, async (req) => {
    const { modelId } = req.params as { modelId: string };
    const r = run("DELETE FROM model_prices WHERE model_id = ?", modelId);
    if (r.changes === 0) notFound("model_override");
    return { data: { ok: true } };
  });

  // ---------- redeem codes ----------

  app.post("/api/admin/redeem-codes", pre, async (req, reply) => {
    const b = body(req);
    const value = num(b, "valueUsd", { required: true, min: 0.01, max: 1e7 })!;
    const count = num(b, "count", { int: true, min: 1, max: 500 }) ?? 1;
    let expiresAt: string | null = null;
    if (b.expiresAt) {
      expiresAt = parseIsoInput(b.expiresAt);
      if (!expiresAt) bad("invalid_request", "expiresAt must be an ISO date/datetime");
    }
    const batch = str(b, "batch", { max: 64 }) ?? null;
    const codes = tx(() => {
      const out: string[] = [];
      while (out.length < count) {
        const code = generateRedeemCode();
        const r = run(
          `INSERT OR IGNORE INTO redeem_codes (code, value_usd, batch, expires_at, created_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          code,
          value,
          batch,
          expiresAt,
          req.user!.id,
          nowIso(),
        );
        if (r.changes) out.push(code);
      }
      return out;
    });
    return reply.status(201).send({ data: { codes, valueUsd: value, count, batch, expiresAt } });
  });

  app.get("/api/admin/redeem-codes", pre, async (req) => {
    const p = page(req);
    const q = query(req);
    const w = new Where();
    w.addIf(q.status, "r.status = ?", q.status);
    w.addIf(q.batch, "r.batch = ?", q.batch);
    if (q.q) w.add("(r.code LIKE ? OR r.batch LIKE ?)", `%${q.q.toUpperCase()}%`, `%${q.q}%`);
    const total = one<{ n: number }>(`SELECT COUNT(*) AS n FROM redeem_codes r ${w.sql}`, ...w.params)!.n;
    const rows = all<Record<string, any>>(
      `SELECT r.*, u.name AS used_by_name FROM redeem_codes r LEFT JOIN users u ON u.id = r.used_by ${w.sql}
       ORDER BY r.created_at DESC, r.rowid DESC LIMIT ? OFFSET ?`,
      ...w.params,
      p.pageSize,
      p.offset,
    );
    const batches = all<{ batch: string }>("SELECT DISTINCT batch FROM redeem_codes WHERE batch IS NOT NULL ORDER BY batch").map((r) => r.batch);
    return {
      data: {
        ...paged(
          rows.map((r) => ({
            code: r.code,
            valueUsd: r.value_usd,
            status: r.status,
            batch: r.batch,
            usedBy: r.used_by,
            usedByName: r.used_by_name,
            usedAt: r.used_at,
            expiresAt: r.expires_at,
            createdAt: r.created_at,
          })),
          total,
          p,
        ),
        batches,
      },
    };
  });

  app.patch("/api/admin/redeem-codes/:code", pre, async (req) => {
    const { code } = req.params as { code: string };
    const status = oneOf(body(req), "status", ["disabled", "unused"] as const, true)!;
    const from = status === "disabled" ? "unused" : "disabled";
    const r = run("UPDATE redeem_codes SET status = ? WHERE code = ? AND status = ?", status, code, from);
    if (r.changes === 0) bad("invalid_request", `Only ${from} codes can be set to ${status}`);
    return { data: { ok: true } };
  });

  app.delete("/api/admin/redeem-codes/:code", pre, async (req) => {
    const { code } = req.params as { code: string };
    const r = run("DELETE FROM redeem_codes WHERE code = ? AND status <> 'used'", code);
    if (r.changes === 0) bad("invalid_request", "Code not found or already used");
    return { data: { ok: true } };
  });

  // ---------- usage ----------

  app.get("/api/admin/usage", pre, async (req) => {
    const p = page(req);
    const { where } = usageQuery(req, {});
    const total = one<{ n: number }>(`SELECT COUNT(*) AS n FROM usage_logs l ${where.sql}`, ...where.params)!.n;
    const rows = all<UsageRowDb & { user_id: string; account_id: string | null; provider_id: string | null; provider_name: string | null }>(
      `${USAGE_SELECT} ${where.sql} ORDER BY l.created_at DESC, l.rowid DESC LIMIT ? OFFSET ?`,
      ...where.params,
      p.pageSize,
      p.offset,
    );
    return {
      data: paged(
        rows.map((r) => ({
          ...usageShape(r),
          userId: r.user_id,
          userName: r.user_name ?? null,
          accountId: r.account_id,
          accountName: r.account_name ?? null,
          providerId: r.provider_id ?? null,
          providerName: r.provider_name ?? null,
          totalCost: r.total_cost,
          providerEarning: r.provider_earning,
          // Provenance: organization / IP group of the serving account (migration 30; older rows fall back to the current binding).
          teamId: r.eff_team_id ?? null,
          teamName: r.team_name ?? null,
          orgName: r.org_name ?? null,
          proxyId: r.eff_proxy_id ?? null,
          proxyGroup: r.proxy_group ?? null,
          proxyCountry: r.proxy_country ?? null,
        })),
        total,
        p,
      ),
    };
  });

  /** 错误日志汇总：时间范围内失败请求的分布（按错误码 / 状态码 / 路径 / 账号 / 小时）。 */
  app.get("/api/admin/errors/summary", pre, async (req) => {
    const { where } = usageQuery(req, {});
    const wErr = new Where();
    wErr.parts = [...where.parts];
    wErr.params = [...where.params];
    wErr.add("l.status_code >= 400");
    const total = one<{ n: number }>(`SELECT COUNT(*) AS n FROM usage_logs l ${wErr.sql}`, ...wErr.params)!.n;
    const allReq = one<{ n: number }>(`SELECT COUNT(*) AS n FROM usage_logs l ${where.sql}`, ...where.params)!.n;
    const byCode = all<{ error_code: string | null; status_code: number; n: number }>(
      `SELECT l.error_code, MIN(l.status_code) AS status_code, COUNT(*) AS n FROM usage_logs l ${wErr.sql} GROUP BY l.error_code ORDER BY n DESC LIMIT 12`,
      ...wErr.params,
    );
    const byStatus = all<{ status_code: number; n: number }>(`SELECT l.status_code, COUNT(*) AS n FROM usage_logs l ${wErr.sql} GROUP BY l.status_code ORDER BY n DESC`, ...wErr.params);
    const byMode = all<{ mode: string | null; n: number }>(`SELECT l.mode, COUNT(*) AS n FROM usage_logs l ${wErr.sql} GROUP BY l.mode ORDER BY n DESC`, ...wErr.params);
    const byAccount = all<{ account_id: string | null; name: string | null; n: number }>(
      `SELECT l.account_id, a.name, COUNT(*) AS n FROM usage_logs l LEFT JOIN accounts a ON a.id = l.account_id ${wErr.sql} GROUP BY l.account_id ORDER BY n DESC LIMIT 10`,
      ...wErr.params,
    );
    const hourly = all<{ hour: string; n: number }>(
      `SELECT substr(l.created_at, 1, 13) AS hour, COUNT(*) AS n FROM usage_logs l ${wErr.sql} GROUP BY hour ORDER BY hour DESC LIMIT 168`,
      ...wErr.params,
    );
    return {
      data: {
        totalErrors: total,
        totalRequests: allReq,
        byCode: byCode.map((r) => ({ code: r.error_code ?? "(none)", statusCode: r.status_code, count: r.n })),
        byStatus: byStatus.map((r) => ({ statusCode: r.status_code, count: r.n })),
        byMode: byMode.map((r) => ({ mode: r.mode ?? "(none)", count: r.n })),
        byAccount: byAccount.map((r) => ({ accountId: r.account_id, name: r.name, count: r.n })),
        hourly: hourly.reverse().map((r) => ({ hour: r.hour + ":00Z", count: r.n })),
      },
    };
  });

  app.get("/api/admin/usage/stats", pre, async (req) => {
    const { where } = usageQuery(req, {});
    const byAccount = all<{ account_id: string; name: string | null; requests: number; cost: number }>(
      `SELECT l.account_id, a.name, COUNT(*) AS requests, COALESCE(SUM(l.actual_cost),0) AS cost
       FROM usage_logs l LEFT JOIN accounts a ON a.id = l.account_id ${where.sql}
       ${where.sql ? "AND" : "WHERE"} l.account_id IS NOT NULL GROUP BY l.account_id ORDER BY cost DESC LIMIT 50`,
      ...where.params,
    );
    return {
      data: {
        ...usageStats(where),
        byAccount: byAccount.map((r) => ({ accountId: r.account_id, name: r.name, requests: r.requests, costUsd: r.cost })),
      },
    };
  });

  // Hourly / daily spend per user (default) or per key (`by=key`, e.g. with
  // `userId=` for one customer's keys) — finance panel and user detail.
  app.get("/api/admin/usage/breakdown", pre, async (req) => {
    const { where } = usageQuery(req, {});
    const by = query(req).by === "key" ? "key" : "user";
    return { data: usageBreakdown(where, usageBucket(req), by) };
  });

  // ---------- nodes ----------

  app.get("/api/admin/nodes", preOps, async () => ({
    data: all(
      `SELECT n.*, u.name AS provider_name, u.role AS provider_role,
              (SELECT COUNT(*) FROM accounts a WHERE a.node_id = n.node_id AND a.route = 'node') AS account_count,
              (SELECT COUNT(*) FROM node_proxies p WHERE p.node_id = n.node_id) AS proxy_count
       FROM nodes n LEFT JOIN users u ON u.id = n.provider_id ORDER BY n.online DESC, n.created_at DESC`,
    ).map(nodeShape),
  }));

  // Node monitor (docs/operations.md §7.2): one row per node with the latest heartbeat
  // snapshot (host / pool / proxies), account state and recent traffic through it.
  app.get("/api/admin/nodes/monitor", pre, async () => {
    const now = Date.now();
    const rows = all<Record<string, unknown>>(
      `SELECT n.*, u.name AS provider_name, u.role AS provider_role,
              (SELECT COUNT(*) FROM accounts a WHERE a.node_id = n.node_id) AS acc_total,
              (SELECT COUNT(*) FROM accounts a WHERE a.node_id = n.node_id AND a.status = 'active') AS acc_active,
              (SELECT COUNT(*) FROM accounts a JOIN node_proxies p ON p.id = a.bound_proxy_id WHERE a.node_id = n.node_id AND a.status = 'active' AND p.status = 'live') AS acc_live_proxy,
              (SELECT COUNT(*) FROM accounts a WHERE a.node_id = n.node_id AND a.status = 'active' AND (
                 (a.window_exhausted_until IS NOT NULL AND a.window_exhausted_until > strftime('%Y-%m-%dT%H:%M:%SZ','now')) OR
                 (a.rate_limited_until IS NOT NULL AND a.rate_limited_until > strftime('%Y-%m-%dT%H:%M:%SZ','now')))) AS acc_cooling,
              (SELECT COUNT(*) FROM node_proxies p WHERE p.node_id = n.node_id) AS proxy_total,
              (SELECT COUNT(*) FROM node_proxies p WHERE p.node_id = n.node_id AND p.status = 'live') AS proxy_live,
              (SELECT COUNT(*) FROM usage_logs l WHERE l.node_id = n.node_id AND l.created_at > strftime('%Y-%m-%dT%H:%M:%SZ','now','-60 minutes')) AS req_1h,
              (SELECT COUNT(*) FROM usage_logs l WHERE l.node_id = n.node_id AND l.status_code >= 400 AND l.created_at > strftime('%Y-%m-%dT%H:%M:%SZ','now','-60 minutes')) AS err_1h,
              (SELECT ROUND(AVG(l.duration_ms)) FROM usage_logs l WHERE l.node_id = n.node_id AND l.status_code = 200 AND l.created_at > strftime('%Y-%m-%dT%H:%M:%SZ','now','-60 minutes')) AS avg_ms_1h,
              (SELECT COUNT(*) FROM usage_logs l WHERE l.node_id = n.node_id AND l.created_at > strftime('%Y-%m-%dT%H:%M:%SZ','now','-24 hours')) AS req_24h,
              (SELECT COUNT(*) FROM usage_logs l WHERE l.node_id = n.node_id AND l.status_code >= 400 AND l.created_at > strftime('%Y-%m-%dT%H:%M:%SZ','now','-24 hours')) AS err_24h,
              (SELECT ROUND(COALESCE(SUM(l.total_cost),0),4) FROM usage_logs l WHERE l.node_id = n.node_id AND l.status_code = 200 AND l.created_at > strftime('%Y-%m-%dT%H:%M:%SZ','now','-24 hours')) AS cost_24h
       FROM nodes n LEFT JOIN users u ON u.id = n.provider_id ORDER BY n.online DESC, n.created_at`,
    );
    const data = rows.map((n) => {
      let metrics: Record<string, unknown> | null = null;
      if (typeof n.metrics === "string" && n.metrics) {
        try {
          metrics = JSON.parse(n.metrics) as Record<string, unknown>;
        } catch {
          metrics = null;
        }
      }
      const hb = typeof n.last_heartbeat_at === "string" ? Date.parse(n.last_heartbeat_at) : NaN;
      let name: string | null = null;
      if (typeof n.deploy_meta === "string" && n.deploy_meta) {
        try {
          const dm = JSON.parse(n.deploy_meta) as { name?: unknown };
          if (typeof dm.name === "string" && dm.name) name = dm.name;
        } catch {
          name = null;
        }
      }
      return {
        nodeId: n.node_id,
        name,
        providerName: n.provider_name ?? null,
        platformNode: n.provider_role === "admin",
        nodeVersion: n.node_version ?? null,
        online: n.online === 1,
        acceptingSessions: n.accepting_sessions === 1,
        inFlight: typeof n.in_flight === "number" ? n.in_flight : 0,
        capacity: typeof n.capacity === "number" ? n.capacity : 100,
        lastHeartbeatAt: n.last_heartbeat_at ?? null,
        heartbeatAgeSec: Number.isFinite(hb) ? Math.max(0, Math.round((now - hb) / 1000)) : null,
        metrics,
        accounts: { total: n.acc_total, active: n.acc_active, onLiveProxy: n.acc_live_proxy, cooling: n.acc_cooling },
        proxies: { total: n.proxy_total, live: n.proxy_live },
        traffic: { req1h: n.req_1h, err1h: n.err_1h, avgMs1h: n.avg_ms_1h, req24h: n.req_24h, err24h: n.err_24h, cost24h: n.cost_24h },
      };
    });
    return { data: { nodes: data, generatedAt: nowIso() } };
  });

  // Adjust how many accounts a node may carry. Cannot drop below the number
  // of active node-routed accounts already on it (same counting rule as the
  // bind-time capacity checks in admin.ts / onboarding.ts / onboarder.ts).
  app.put("/api/admin/nodes/:id/capacity", pre, async (req) => {
    const { id } = req.params as { id: string };
    if (!nodeExists(id)) notFound("node");
    const capacity = Number(body(req).capacity);
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 10000) {
      bad("invalid_request", "capacity must be an integer between 1 and 10000");
    }
    const used=tx(()=>{
      const occupancy=nodeOccupancy(id);
      if(capacity<occupancy)bad("capacity_below_usage", `Node carries ${occupancy} accounts and reservations; capacity cannot be set below that`);
      run("UPDATE nodes SET capacity=? WHERE node_id=?",capacity,id);
      return occupancy;
    });
    return { data: { nodeId: id, capacity, used } };
  });

  // Replace a node's whole proxy pool (protocol v2). Plaintext URLs are
  // encrypted into node_proxies.url_enc; if the node is online the pool is
  // pushed over WS (the only place plaintext ever travels).
  app.put("/api/admin/nodes/:id/proxies", pre, async (req) => {
    const { id } = req.params as { id: string };
    if (!nodeExists(id)) notFound("node");
    let proxies: ProxyInput[];
    try {
      proxies = validateProxies(body(req).proxies, body(req).group);
    } catch (err) {
      bad("invalid_request", (err as Error).message);
    }
    let res: ReplaceProxiesResult;
    try {
      res = tx(() => replaceNodeProxies(id, proxies));
    } catch (err) {
      if (err instanceof ProxyInputError) bad("proxy_bound", err.message);
      throw err;
    }
    const pushed = pushProxies(id, res.urls);
    return { data: { pushed, total: res.urls.length, skipped: res.skipped, skippedUrls: res.skippedUrls, proxies: listNodeProxies(id) } };
  });

  // Append proxies to a node's pool (bound rows untouched). After the insert
  // the whole pool is re-pushed over WS (proxies.set is full-state).
  app.post("/api/admin/nodes/:id/proxies", pre, async (req) => {
    const { id } = req.params as { id: string };
    if (!nodeExists(id)) notFound("node");
    let proxies: ProxyInput[];
    try {
      proxies = validateProxies(body(req).proxies, body(req).group);
    } catch (err) {
      bad("invalid_request", (err as Error).message);
    }
    let res: AddProxiesResult;
    try {
      res = tx(() => addNodeProxies(id, proxies));
    } catch (err) {
      if (err instanceof ProxyInputError) bad("invalid_request", err.message);
      throw err;
    }
    const pushed = pushProxies(id, nodeProxyUrls(id));
    return { data: { pushed, added: res.added, regrouped: res.regrouped, skipped: res.skipped, skippedUrls: res.skippedUrls, proxies: listNodeProxies(id) } };
  });

  // Proxy groups (2026-10-29): per-group tallies, and moving rows between groups (null = ungroup).
  app.get("/api/admin/nodes/:id/proxy-groups", pre, async (req) => {
    const { id } = req.params as { id: string };
    if (!nodeExists(id)) notFound("node");
    return { data: listNodeProxyGroups(id) };
  });
  app.post("/api/admin/nodes/:id/proxies/group", pre, async (req) => {
    const { id } = req.params as { id: string };
    if (!nodeExists(id)) notFound("node");
    const b = body(req);
    const ids = strArray(b, "proxyIds");
    if (!ids || ids.length === 0) bad("invalid_request", "proxyIds is required");
    if (ids.length > 1000) bad("invalid_request", "at most 1000 proxyIds per call");
    let group: string | null;
    try { group = normalizeProxyGroup(b.group); } catch (err) { bad("invalid_request", (err as Error).message); }
    const changed = tx(() => setNodeProxyGroup(id, ids!, group));
    return { data: { changed, group, groups: listNodeProxyGroups(id) } };
  });

  // Rename an IP group on a node (user 2026-10-29): every member moves to the new name and the organization
  // profiles' recommended routes that named the old group on this node follow, so the onboard site keeps working.
  app.post("/api/admin/nodes/:id/proxy-groups/rename", pre, async (req) => {
    const { id } = req.params as { id: string };
    if (!nodeExists(id)) notFound("node");
    const b = body(req);
    let from: string | null; let to: string | null;
    try { from = normalizeProxyGroup(b.from); to = normalizeProxyGroup(b.to); } catch (err) { bad("invalid_request", (err as Error).message); }
    if (!from || !to) bad("invalid_request", "from and to are required");
    if (from === to) return { data: { changed: 0, routesUpdated: 0, groups: listNodeProxyGroups(id) } };
    if (!listNodeProxyGroups(id).some((g) => g.group === from)) bad("group_not_found", `Node has no IP group '${from}'`);
    const result = tx(() => {
      const changed = run("UPDATE node_proxies SET group_name = ? WHERE node_id = ? AND group_name = ?", to, id, from).changes;
      let routesUpdated = 0;
      for (const o of all<{ id: string; routes_json: string | null }>("SELECT id, routes_json FROM onboard_orgs WHERE routes_json IS NOT NULL")) {
        let routes: Array<{ nodeId?: unknown; group?: unknown }>;
        try { routes = JSON.parse(o.routes_json ?? "[]"); } catch { continue; }
        if (!Array.isArray(routes)) continue;
        let hit = false;
        for (const r of routes) if (r && r.nodeId === id && r.group === from) { r.group = to; hit = true; }
        if (hit) { run("UPDATE onboard_orgs SET routes_json = ? WHERE id = ?", JSON.stringify(routes), o.id); routesUpdated += 1; }
      }
      return { changed: Number(changed), routesUpdated };
    });
    return { data: { ...result, from, to, groups: listNodeProxyGroups(id) } };
  });

  // Remove proxies by id (bound / reserved ones are reported, not removed); the pool is re-pushed.
  app.post("/api/admin/nodes/:id/proxies/remove", pre, async (req) => {
    const { id } = req.params as { id: string };
    if (!nodeExists(id)) notFound("node");
    const ids = strArray(body(req), "proxyIds");
    if (!ids || ids.length === 0) bad("invalid_request", "proxyIds is required");
    if (ids.length > 1000) bad("invalid_request", "at most 1000 proxyIds per call");
    const res = tx(() => removeNodeProxies(id, ids, req.user!.id));
    const pushed = res.removed.length ? pushProxies(id, nodeProxyUrls(id)) : false;
    return { data: { ...res, pushed, remaining: one<{ n: number }>("SELECT COUNT(*) AS n FROM node_proxies WHERE node_id = ?", id)!.n } };
  });

  // Lift a quarantine (docs/onboarding.md §12.1): operator decision, kept in the history.
  // The node gets the pool pushed again because its policy changes with the quarantine.
  app.post("/api/admin/nodes/:id/proxies/:proxyId/unquarantine", pre, async (req) => {
    const { id, proxyId } = req.params as { id: string; proxyId: string };
    if (!nodeExists(id)) notFound("node");
    let cleared: boolean;
    try {
      cleared = unquarantineProxy(id, proxyId, req.user!.id);
    } catch (e) {
      if (e instanceof ProxyInputError && e.message === "proxy_not_found") notFound("proxy");
      throw e;
    }
    if (!cleared) bad("proxy_not_quarantined", "This proxy is not quarantined");
    const pushed = pushProxies(id, nodeProxyUrls(id));
    return { data: { ok: true, pushed } };
  });

  app.get("/api/admin/nodes/:id/proxies", preOps, async (req) => {
    const { id } = req.params as { id: string };
    if (!nodeExists(id)) notFound("node");
    // ?free=1: credential-free picker view (live + unbound), docs/onboarding.md §4.
    // The ops role only ever gets the picker shape (no proxy URLs / errors).
    if (query(req).free === "1" || req.user!.role === "ops") return { data: listProxiesForPicker(id, query(req).free === "1") };
    return { data: listNodeProxies(id) };
  });

  const deployBase = (req: FastifyRequest): string => {
    // 节点要连的是 console（/internal/...），不是推理网关：用 console_base_url。
    const configured = getSetting("console_base_url").trim();
    if (configured) return configured.replace(/\/+$/, "");
    const proto = req.headers["x-forwarded-proto"] === "https" ? "https" : "http";
    return `${proto}://${req.headers.host ?? `127.0.0.1:${process.env.PORT ?? 8401}`}`;
  };

  const deployCommon = (req: FastifyRequest) => {
    const b = body(req);
    const providerId = str(b, "providerId") ?? req.user!.id;
    if (!one("SELECT 1 FROM users WHERE id = ?", providerId)) bad("invalid_request", "providerId not found");
    let proxies: ProxyInput[] | undefined;
    if (b.proxies !== undefined) {
      try {
        proxies = validateProxies(b.proxies);
      } catch (err) {
        bad("invalid_request", (err as Error).message);
      }
    }
    // docs/tui-worker-2026-11-08.md: a second node instance on a host, optionally the TUI worker on a chosen Claude Code version
    const instance = str(b, "instance", { max: 24 });
    if (instance && !/^[a-z][a-z0-9-]{0,23}$/.test(instance)) bad("invalid_request", "instance must be a short lowercase name");
    const consolePort = num(b, "consolePort", { int: true, min: 1024, max: 65535 });
    const claudeVersion = str(b, "claudeVersion", { max: 20 });
    if (claudeVersion && !/^\d+\.\d+\.\d+$/.test(claudeVersion)) bad("invalid_request", "claudeVersion must look like 2.1.312");
    return {
      providerId,
      adminId: req.user!.id,
      name: str(b, "name", { max: 120 }),
      proxies,
      platformHttpBase: deployBase(req),
      ...(instance ? { instance } : {}),
      ...(consolePort ? { consolePort } : {}),
      ...(b.tui === true ? { tui: true } : {}),
      ...(claudeVersion ? { claudeVersion } : {}),
    };
  };

  // SSH remote deploy (Ubuntu target): install bun 1.4.4, download the node
  // bundle with a one-time bind code, write config + systemd unit, start,
  // then wait up to 30s for the node to come online.
  app.post("/api/admin/nodes/deploy", pre, async (req) => {
    const b = body(req);
    const host = str(b, "host", { required: true, max: 253 })!;
    // ssh parses a leading '-' as an option (e.g. -oProxyCommand=…): only hostnames / IP literals.
    if (!/^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$|^\[?[0-9A-Fa-f:.]+\]?$/.test(host)) {
      bad("invalid_request", "host must be a hostname or IP address");
    }
    const port = num(b, "port", { int: true, min: 1, max: 65535 }) ?? 22;
    const username = str(b, "username", { required: true, max: 64 })!;
    if (!/^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/.test(username)) bad("invalid_request", "username must be a plain unix user name");
    const password = str(b, "password", { max: 500 });
    const privateKey = str(b, "privateKey", { max: 20000 });
    if (!password && !privateKey) bad("invalid_request", "password or privateKey is required");
    try {
      const outcome = await deployNodeViaSsh(
        { host, port, username, ...(password ? { password } : {}), ...(privateKey ? { privateKey } : {}) },
        deployCommon(req),
      );
      return { data: outcome };
    } catch (err) {
      bad("deploy_failed", (err as Error).message, 502);
    }
  });

  // Deploy a node on this very server (no SSH; local bun + config).
  app.post("/api/admin/nodes/local", pre, async (req) => {
    try {
      const outcome = await deployNodeLocal(deployCommon(req));
      return { data: outcome };
    } catch (err) {
      bad("deploy_failed", (err as Error).message, 502);
    }
  });

  app.delete("/api/admin/nodes/:id", pre, async (req) => {
    const { id } = req.params as { id: string };
    if (!nodeExists(id)) notFound("node");
    tx(() => {
      // Bound accounts lose their proxy for good: unbind + disable; proxies,
      // assignments and in-flight onboarding jobs go with the node (one transaction).
      releaseNodeResources(id, "node removed by admin");
      run("DELETE FROM nodes WHERE node_id = ?", id);
    });
    disconnectNode(id, "removed_by_admin");
    return { data: { ok: true } };
  });

  // ---------- settings ----------

  app.get("/api/admin/settings", pre, async (_req, reply) => {
    const revision = settingsRevision();
    return reply.header("etag", `"settings-${revision}"`).send({ data: { ...getSettings(), _revision: revision } });
  });

  app.put("/api/admin/settings", pre, async (req, reply) => {
    const b = body(req);
    const ifMatch = req.headers["if-match"];
    const rawRevision = b._revision ?? (Array.isArray(ifMatch) ? ifMatch[0] : ifMatch)?.replace(/^W\//, "").replace(/^"?settings-(\d+)"?$/, "$1");
    const expectedRevision = typeof rawRevision === "number" ? rawRevision : typeof rawRevision === "string" && /^\d+$/.test(rawRevision) ? Number(rawRevision) : NaN;
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) bad("settings_revision_required", "Reload settings and send _revision or If-Match with the current settings revision", 428);
    if ("onboard_cooldown_min_sec" in b || "onboard_cooldown_max_sec" in b) {
      const lo = Number(b.onboard_cooldown_min_sec ?? getSetting("onboard_cooldown_min_sec"));
      const hi = Number(b.onboard_cooldown_max_sec ?? getSetting("onboard_cooldown_max_sec"));
      if (Number.isFinite(lo) && Number.isFinite(hi) && lo > hi) bad("invalid_request", "onboard_cooldown_min_sec must not exceed onboard_cooldown_max_sec");
    }
    const values: Partial<Record<SettingKey, string>> = {};
    for (const key of SETTING_KEYS) {
      if (!(key in b)) continue;
      const v = b[key];
      const s = typeof v === "number" ? String(v) : typeof v === "string" ? v.trim() : null;
      if (s === null) bad("invalid_request", `${key} must be a string or number`);
      validateSetting(key, s);
      values[key] = s;
    }
    let revision: number;
    try {
      revision = updateSettings(values, expectedRevision);
    } catch (err) {
      if (err instanceof SettingsRevisionConflict) bad("settings_revision_conflict", `Settings changed concurrently; reload revision ${err.actual} and review before saving`, 409);
      throw err;
    }
    return reply.header("etag", `"settings-${revision}"`).send({ data: { ...getSettings(), _revision: revision } });
  });
}

function validateSetting(key: SettingKey, v: string): void {
  switch (key) {
    case "default_group_id":
      if (!one("SELECT 1 FROM groups WHERE id = ? AND status = 'active'", v)) bad("invalid_request", "default_group_id must be an active group");
      return;
    case "provider_default_payout_rate": {
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0 || n > 1) bad("invalid_request", "provider_default_payout_rate must be within 0..1");
      return;
    }
    case "max_keys_per_user": {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1 || n > 10000) bad("invalid_request", "max_keys_per_user must be an integer 1..10000");
      return;
    }
    case "api_base_url":
      if (v && !/^https?:\/\//.test(v)) bad("invalid_request", "api_base_url must be an http(s) URL");
      return;
    case "announcement":
      if (v.length > 4000) bad("invalid_request", "announcement is too long");
      return;
    case "window_rest_min_sec":
    case "window_rest_max_sec": {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 0 || n > 86400) bad("invalid_request", `${key} must be an integer 0..86400 (seconds)`);
      return;
    }
    case "window_passive_max_age_sec": {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 600 || n > 7 * 86400) bad("invalid_request", "window_passive_max_age_sec must be an integer 600..604800 (seconds)");
      return;
    }
    case "ccr_cache_write_as_input":
    case "ccr_worker_persistent":
    case "ccr_worker_native_tools":
      if (v !== "0" && v !== "1") bad("invalid_request", `${key} must be 0 or 1`);
      return;
    case "ccr_cache_baseline_worker":
    case "ccr_cache_baseline_cloud": {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 0 || n > 1_000_000) bad("invalid_request", `${key} must be an integer 0..1000000 (tokens)`);
      return;
    }
    case "onboard_default_concurrency":
    case "onboard_default_rpm_limit": {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 0 || n > 100000) bad("invalid_request", `${key} must be an integer 0..100000`);
      return;
    }
    case "onboard_default_executor":
      if (v !== "ccr" && v !== "ccr_worker") bad("invalid_request", "onboard_default_executor must be ccr or ccr_worker");
      return;
    case "direct_cc_entrypoint_normalize":
      if (v !== "0" && v !== "1") bad("invalid_request", "direct_cc_entrypoint_normalize must be 0 or 1");
      return;
    case "direct_cc_version_pin":
      if (v !== "" && !/^\d+\.\d+\.\d+$/.test(v)) bad("invalid_request", "direct_cc_version_pin must be empty or x.y.z");
      return;
    case "proxy_release_cooldown_sec": {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 0 || n > 30 * 86400) bad("invalid_request", "proxy_release_cooldown_sec must be an integer 0..2592000 (seconds)");
      return;
    }
    case "cache_refund_enabled":
      if (v !== "0" && v !== "1") bad("invalid_request", `${key} must be 0 or 1`);
      return;
    case "cache_refund_percent": {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 0 || n > 100) bad("invalid_request", "cache_refund_percent must be an integer 0..100");
      return;
    }
    case "cache_refund_interval_sec": {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 3600 || n > 30 * 86400) bad("invalid_request", "cache_refund_interval_sec must be an integer 3600..2592000 (seconds)");
      return;
    }
    case "onboard_cooldown_min_sec":
    case "onboard_cooldown_max_sec": {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 0 || n > 86400) bad("invalid_request", `${key} must be an integer 0..86400 (seconds)`);
      return;
    }
    case "direct_cc_entrypoint_normalize": case "direct_strip_user_email": case "direct_cc_canonical_fields": case "worker_prompt_hide_platform_path":
    case "direct_profile_strict": case "cc_client_response_profile": case "key_policy_auto": case "worker_canonical": case "telemetry_evidence_required": case "canonical_history_import": case "raw_preserve_headers":
      // 铁律 2 three-state switches
      if (v !== "0" && v !== "canary" && v !== "1") bad("invalid_request", `${key} must be 0 | canary | 1`);
      return;
    case "telemetry_health_days": {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1 || n > 60) bad("invalid_request", "telemetry_health_days must be an integer 1..60");
      return;
    }
    case "cc_shape_policy":
      if (!(CC_SHAPE_POLICIES as readonly string[]).includes(v)) bad("invalid_request", `cc_shape_policy must be one of ${CC_SHAPE_POLICIES.join(", ")}`);
      return;
  }
}


/** spec §6.4: validated evidence row from an admin body; `accountId` null = structural (controlled) evidence for a profile. */
function parseEvidenceBody(b: Record<string, unknown>, accountId: string | null): Parameters<typeof recordTelemetryEvidence>[0] {
  const source = b.source === "real" || b.source === "controlled" ? b.source : null;
  if (!source) bad("invalid_request", "source must be real | controlled");
  const profileId = typeof b.profileId === "string" && /^cc-\d+\.\d+\.\d+-(cli|sdk-cli|restricted)$/.test(b.profileId) ? b.profileId : null;
  if (!profileId) bad("invalid_request", "profileId must look like cc-<version>-<cli|sdk-cli|restricted>");
  const status = b.status === undefined || b.status === null ? null : Number(b.status);
  if (status !== null && (!Number.isInteger(status) || status < 100 || status > 599)) bad("invalid_request", "status must be an HTTP status");
  if (source === "real" && (status === null || status < 200 || status >= 300)) bad("invalid_request", "real evidence requires a 2xx status");
  const days = b.expiresInDays === undefined ? (source === "real" ? 30 : 90) : Number(b.expiresInDays);
  if (!Number.isFinite(days) || days < 1 || days > 365) bad("invalid_request", "expiresInDays must be 1..365");
  const str = (k: string, max: number): string | null => (typeof b[k] === "string" && (b[k] as string).trim() ? (b[k] as string).trim().slice(0, max) : null);
  return {
    accountId, profileId: profileId!, source: source!, status,
    nodeId: str("nodeId", 64), proxyId: str("proxyId", 64), nativeSessionId: str("nativeSessionId", 64), ccVersion: str("ccVersion", 32),
    endpoint: str("endpoint", 200), digest: str("digest", 64), note: str("note", 1000),
    expiresAt: new Date(Date.now() + days * 86_400_000).toISOString(),
  };
}
