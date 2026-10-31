import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  SETTING_KEYS,
  accountBaseUrl,
  all,
  applyLedger,
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
  readCredential,
  run,
  setSetting,
  tx,
  validateAllowlistInput,
  type AccountRow,
  type Role,
  type SettingKey,
  hasSubscriptionWindow,
} from "@1dayapi/core";
import { parseAccountFields } from "../account-input.js";
import { probeWindow } from "../ccr/window-poll.js";
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
import { listNodeProxies, listProxiesForPicker, nodeExists, replaceNodeProxies, validateProxies, type ProxyInput } from "../node/proxies.js";
import { requestViaNode } from "../node/egress-request.js";
import { disconnectNode, pushProxies } from "../node/registry.js";
import { createUser, dropSessions, requireAdmin, resetLoginKey } from "../session.js";
import {
  API_KEY_SELECT,
  accountGroupsMap,
  accountStats30d,
  adminAccountShape,
  apiKeyShape,
  dailySeries,
  groupShape,
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
import { USAGE_SELECT, applyKeyFields, updateKey, usageQuery, usageStats } from "./user.js";

// Admin console API (docs/v3-design.md §8.4).

interface UserRow {
  id: string;
  role: Role;
  name: string;
  login_key_preview: string;
  status: string;
  balance_usd: number;
  note: string | null;
  last_login_at: string | null;
  created_at: string;
  key_count?: number;
  requests30d?: number;
  cost30d?: number;
}

const USER_SELECT = `SELECT u.*,
    (SELECT COUNT(*) FROM api_keys k WHERE k.user_id = u.id) AS key_count,
    (SELECT COUNT(*) FROM usage_logs l WHERE l.user_id = u.id AND l.created_at >= ? AND l.status_code < 300) AS requests30d,
    (SELECT COALESCE(SUM(actual_cost),0) FROM usage_logs l WHERE l.user_id = u.id AND l.created_at >= ?) AS cost30d
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
    note: u.note,
    keyCount: u.key_count ?? 0,
    requests30d: u.requests30d ?? 0,
    cost30d: u.cost30d ?? 0,
    lastLoginAt: u.last_login_at,
    createdAt: u.created_at,
    allowedGroupIds: allowedGroupIds(u.id),
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
  const used = one<{ n: number }>(
    `SELECT COUNT(*) AS n FROM accounts WHERE route = 'node' AND node_id = ? AND status = 'active'${excludeAccountId ? " AND id <> ?" : ""}`,
    nodeId,
    ...(excludeAccountId ? [excludeAccountId] : []),
  )!.n;
  if (used >= node.capacity) bad("node_at_capacity", `Node capacity reached (${used}/${node.capacity})`);
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

function accountOut(id: string) {
  const a = loadAccount(id);
  return adminAccountShape(a, accountGroupsMap().get(id) ?? [], accountStats30d().get(id));
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
    url = `${base}/v1/messages`;
    headers["anthropic-version"] = "2023-06-01";
    if (a.type === "oauth") {
      headers.authorization = `Bearer ${secret}`;
      headers["anthropic-beta"] = "oauth-2025-04-20";
    } else {
      headers["x-api-key"] = secret;
      if (a.type === "upstream") headers.authorization = `Bearer ${secret}`;
    }
    payload = { model: testModel, max_tokens: 8, messages: [{ role: "user", content: "ping" }] };
  } else {
    url = `${base}/chat/completions`;
    headers.authorization = `Bearer ${secret}`;
    payload = { model: testModel, max_tokens: 8, messages: [{ role: "user", content: "ping" }] };
  }
  const started = Date.now();
  if (a.route === "node") {
    try {
      const r = await requestViaNode(a, url, headers, payload);
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

  // ---------- dashboard ----------

  app.get("/api/admin/dashboard", pre, async () => {
    const users = one<Record<string, number>>(
      `SELECT SUM(CASE WHEN role='consumer' THEN 1 ELSE 0 END) AS consumer,
              SUM(CASE WHEN role='provider' THEN 1 ELSE 0 END) AS provider,
              SUM(CASE WHEN role='admin' THEN 1 ELSE 0 END) AS admin,
              SUM(CASE WHEN status='disabled' THEN 1 ELSE 0 END) AS disabled
       FROM users`,
    );
    const now = nowIso();
    const acc = one<Record<string, number>>(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN status='active' AND review_status='approved' THEN 1 ELSE 0 END) AS active,
              SUM(CASE WHEN review_status='pending' THEN 1 ELSE 0 END) AS pending,
              SUM(CASE WHEN status='error' THEN 1 ELSE 0 END) AS error,
              SUM(CASE WHEN rate_limited_until > ? OR overload_until > ? OR temp_unschedulable_until > ? OR window_exhausted_until > ? THEN 1 ELSE 0 END) AS cooling
       FROM accounts`,
      now,
      now,
      now,
      now,
    );
    const nodes = one<{ total: number; online: number }>("SELECT COUNT(*) AS total, COALESCE(SUM(online),0) AS online FROM nodes");
    const balances = one<{ c: number; p: number }>(
      `SELECT COALESCE(SUM(CASE WHEN role<>'provider' THEN balance_usd END),0) AS c,
              COALESCE(SUM(CASE WHEN role='provider' THEN balance_usd END),0) AS p FROM users`,
    );
    const ms = monthStart();
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
        },
        nodes: { total: nodes?.total ?? 0, online: nodes?.online ?? 0 },
        balances: { consumerTotalUsd: balances?.c ?? 0, providerUnsettledUsd: balances?.p ?? 0 },
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
    const role = oneOf(b, "role", ["admin", "consumer", "provider"] as const, true)!;
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
    return { data: { ...userShape(u), keys, recentLedger: ledger } };
  });

  app.patch("/api/admin/users/:id", pre, async (req) => {
    const { id } = req.params as { id: string };
    const u = loadUser(id);
    const b = body(req);
    const name = str(b, "name", { max: 64 });
    const status = oneOf(b, "status", ["active", "disabled"] as const);
    if (status === "disabled" && id === req.user!.id) bad("invalid_request", "You cannot disable yourself");
    const groups = strArray(b, "allowedGroupIds");
    tx(() => {
      if (name) run("UPDATE users SET name = ? WHERE id = ?", name, id);
      if ("note" in b) run("UPDATE users SET note = ? WHERE id = ?", str(b, "note", { max: 500 }) ?? null, id);
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
    run("DELETE FROM users WHERE id = ?", id);
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
    updateKey(id, applyKeyFields(body(req), k.user_id, false));
    return { data: apiKeyShape(one<ApiKeyRow>(`${API_KEY_SELECT} WHERE k.id = ?`, id)!) };
  });

  // ---------- groups ----------

  app.get("/api/admin/groups", pre, async () => ({
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

  app.get("/api/admin/accounts", pre, async (req) => {
    const q = query(req);
    const w = new Where();
    w.addIf(q.platform, "a.platform = ?", q.platform);
    w.addIf(q.status, "a.status = ?", q.status);
    w.addIf(q.reviewStatus, "a.review_status = ?", q.reviewStatus);
    if (q.ownerId === "platform") w.add("a.owner_id IS NULL");
    else w.addIf(q.ownerId, "a.owner_id = ?", q.ownerId);
    if (q.q) w.add("(a.name LIKE ? OR a.account_email LIKE ? OR a.base_url LIKE ?)", `%${q.q}%`, `%${q.q}%`, `%${q.q}%`);
    const rows = all<AccountRow & { owner_name: string | null }>(
      `SELECT a.*, u.name AS owner_name FROM accounts a LEFT JOIN users u ON u.id = a.owner_id ${w.sql}
       ORDER BY CASE a.review_status WHEN 'pending' THEN 0 ELSE 1 END, a.created_at DESC`,
      ...w.params,
    );
    const groups = accountGroupsMap();
    const stats = accountStats30d();
    return { data: rows.map((a) => adminAccountShape(a, groups.get(a.id) ?? [], stats.get(a.id))) };
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
    const id = newId();
    const now = nowIso();
    tx(() => {
      run(
        `INSERT INTO accounts (id, name, platform, type, executor, protocol, base_url, credential_enc, models, model_mapping,
                               owner_id, route, node_id, review_status, payout_rate, priority, concurrency, rpm_limit,
                               created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'approved', ?, ?, ?, ?, ?, ?)`,
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
        now,
        now,
      );
      setAccountGroups(id, strArray(b, "groupIds") ?? [getSetting("default_group_id")], priority);
    });
    return reply.status(201).send({ data: accountOut(id) });
  });

  app.patch("/api/admin/accounts/:id", pre, async (req) => {
    const { id } = req.params as { id: string };
    const a = loadAccount(id);
    const b = body(req);
    const f = parseAccountFields(b, a, true);
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
      const used = one<{ n: number }>(
        "SELECT COUNT(*) AS n FROM accounts WHERE route = 'node' AND node_id = ? AND status = 'active' AND id <> ?",
        nextNodeId,
        id,
      )!.n;
      if (used >= node.capacity) bad("node_at_capacity", `Node capacity reached (${used}/${node.capacity})`);
    }
    const priority = num(b, "priority", { int: true, min: 0, max: 100000 });
    if (priority !== undefined) set("priority", priority);
    const conc = num(b, "concurrency", { int: true, min: 0, max: 100000 });
    if (conc !== undefined) set("concurrency", conc);
    const rpm = num(b, "rpmLimit", { int: true, min: 0, max: 100000 });
    if (rpm !== undefined) set("rpm_limit", rpm);
    const payout = num(b, "payoutRate", { min: 0, max: 1 });
    if (payout !== undefined) set("payout_rate", payout);
    const status = oneOf(b, "status", ["active", "disabled"] as const);
    tx(() => {
      run(`UPDATE accounts SET ${sets.join(", ")} WHERE id = ?`, ...params, id);
      if (status === "active") clearAccountState(id);
      else if (status === "disabled") run("UPDATE accounts SET status = 'disabled' WHERE id = ?", id);
      const groupIds = strArray(b, "groupIds");
      if (groupIds) setAccountGroups(id, groupIds, priority ?? a.priority);
    });
    return { data: accountOut(id) };
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
    return { data: accountOut(id) };
  });

  // Probe the CCR subscription window now (docs/ccr-supply.md §7) and return
  // the refreshed account. Probe failures do not touch the account status.
  app.post("/api/admin/accounts/:id/window", pre, async (req) => {
    const { id } = req.params as { id: string };
    const a = loadAccount(id);
    if (!hasSubscriptionWindow(a)) bad("invalid_request", "Window probes apply to Anthropic subscription (OAuth) accounts");
    try {
      await probeWindow(a);
    } catch (err) {
      bad("window_probe_failed", (err as Error).message);
    }
    return { data: accountOut(id) };
  });

  app.post("/api/admin/accounts/:id/test", pre, async (req) => {
    const { id } = req.params as { id: string };
    const a = loadAccount(id);
    return { data: await testAccount(a, str(body(req), "model")) };
  });

  app.delete("/api/admin/accounts/:id", pre, async (req) => {
    const { id } = req.params as { id: string };
    loadAccount(id);
    tx(() => {
      // Deleting an account releases its bound proxy back to the pool (docs/onboarding.md §6.4).
      run("UPDATE node_proxies SET bound_account_id = NULL WHERE bound_account_id = ?", id);
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
    const rows = all<UsageRowDb & { user_id: string; account_id: string | null }>(
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
          totalCost: r.total_cost,
          providerEarning: r.provider_earning,
        })),
        total,
        p,
      ),
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

  // ---------- nodes ----------

  app.get("/api/admin/nodes", pre, async () => ({
    data: all(
      `SELECT n.*, u.name AS provider_name, u.role AS provider_role,
              (SELECT COUNT(*) FROM accounts a WHERE a.node_id = n.node_id AND a.route = 'node') AS account_count,
              (SELECT COUNT(*) FROM node_proxies p WHERE p.node_id = n.node_id) AS proxy_count
       FROM nodes n LEFT JOIN users u ON u.id = n.provider_id ORDER BY n.online DESC, n.created_at DESC`,
    ).map(nodeShape),
  }));

  // Replace a node's whole proxy pool (protocol v2). Plaintext URLs are
  // encrypted into node_proxies.url_enc; if the node is online the pool is
  // pushed over WS (the only place plaintext ever travels).
  app.put("/api/admin/nodes/:id/proxies", pre, async (req) => {
    const { id } = req.params as { id: string };
    if (!nodeExists(id)) notFound("node");
    let proxies: ProxyInput[];
    try {
      proxies = validateProxies(body(req).proxies);
    } catch (err) {
      bad("invalid_request", (err as Error).message);
    }
    const urls = tx(() => replaceNodeProxies(id, proxies));
    const pushed = pushProxies(id, urls);
    return { data: { pushed, proxies: listNodeProxies(id) } };
  });

  app.get("/api/admin/nodes/:id/proxies", pre, async (req) => {
    const { id } = req.params as { id: string };
    if (!nodeExists(id)) notFound("node");
    // ?free=1: credential-free picker view (live + unbound), docs/onboarding.md §4.
    if (query(req).free === "1") return { data: listProxiesForPicker(id, true) };
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
    return {
      providerId,
      adminId: req.user!.id,
      name: str(b, "name", { max: 120 }),
      proxies,
      platformHttpBase: deployBase(req),
    };
  };

  // SSH remote deploy (Ubuntu target): install bun 1.4.4, download the node
  // bundle with a one-time bind code, write config + systemd unit, start,
  // then wait up to 30s for the node to come online.
  app.post("/api/admin/nodes/deploy", pre, async (req) => {
    const b = body(req);
    const host = str(b, "host", { required: true, max: 253 })!;
    const port = num(b, "port", { int: true, min: 1, max: 65535 }) ?? 22;
    const username = str(b, "username", { required: true, max: 64 })!;
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
    if (run("DELETE FROM nodes WHERE node_id = ?", id).changes === 0) notFound("node");
    disconnectNode(id, "removed_by_admin");
    run("UPDATE accounts SET node_id = NULL WHERE node_id = ?", id);
    run("DELETE FROM node_proxies WHERE node_id = ?", id);
    run("DELETE FROM node_proxy_assignments WHERE node_id = ?", id);
    return { data: { ok: true } };
  });

  // ---------- settings ----------

  app.get("/api/admin/settings", pre, async () => ({ data: getSettings() }));

  app.put("/api/admin/settings", pre, async (req) => {
    const b = body(req);
    for (const key of SETTING_KEYS) {
      if (!(key in b)) continue;
      const v = b[key];
      const s = typeof v === "number" ? String(v) : typeof v === "string" ? v.trim() : null;
      if (s === null) bad("invalid_request", `${key} must be a string or number`);
      validateSetting(key, s);
      setSetting(key, s);
    }
    return { data: getSettings() };
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
  }
}
