import type { FastifyInstance } from "fastify";
import { all, getSettings, one, publicModels, publicPricing } from "@1dayapi/core";
import { body, sendError, str } from "../http.js";
import {
  SESSION_COOKIE,
  clearSessionCookie,
  login,
  logout,
  meShape,
  parseCookies,
  requireAny,
  sessionCookie,
} from "../session.js";

// Brute-force guard for POST /auth/login: 20 failures / 10 min / IP.
const loginFailures = new Map<string, { count: number; resetAt: number }>();

export function registerPublicRoutes(app: FastifyInstance): void {
  app.get("/health", async () => ({ ok: true, service: "console", version: "v3" }));

  app.post("/auth/login", async (req, reply) => {
    const now = Date.now();
    // Keep the map bounded: drop expired buckets (a scanner rotating IPs would otherwise grow it forever).
    if (loginFailures.size > 1000) for (const [ip, b] of loginFailures) if (b.resetAt <= now) loginFailures.delete(ip);
    const bucket = loginFailures.get(req.ip);
    if (bucket && bucket.resetAt > now && bucket.count >= 20) {
      return sendError(reply, 429, "too_many_attempts", "Too many failed logins; try again later");
    }
    const key = str(body(req), "key", { required: true, max: 200 })!;
    const res = login(key);
    if (!res.ok) {
      const b = bucket && bucket.resetAt > now ? bucket : { count: 0, resetAt: now + 600_000 };
      b.count++;
      loginFailures.set(req.ip, b);
      return res.code === "user_disabled"
        ? sendError(reply, 401, "user_disabled", "This account is disabled")
        : sendError(reply, 401, "invalid_login_key", "Invalid login key");
    }
    reply.header("set-cookie", sessionCookie(res.token));
    return { data: meShape(res.user) };
  });

  app.get("/auth/me", { preHandler: requireAny }, async (req) => ({ data: meShape(req.user!) }));

  app.post("/auth/logout", async (req, reply) => {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (token) logout(token);
    reply.header("set-cookie", clearSessionCookie());
    return { data: { ok: true } };
  });

  app.get("/api/models", async () => ({ data: publicModels() }));
  app.get("/api/models/pricing", async () => ({ data: publicPricing() }));

  // 首页实时账号池汇总（脱敏）；明细分页在 /api/pool/accounts。
  app.get("/api/pool", async () => ({ data: poolSnapshot() }));

  // 账号池明细（脱敏、分页）：?side=platform|provider&page=1&pageSize=50（上限 200）。
  app.get("/api/pool/accounts", async (req) => {
    const q = req.query as Record<string, string | undefined>;
    const side = q.side === "platform" || q.side === "provider" ? q.side : undefined;
    const pageN = Math.max(1, Number(q.page) || 1);
    const pageSize = Math.min(200, Math.max(1, Number(q.pageSize) || 50));
    return { data: poolAccounts(side, pageN, pageSize) };
  });

  app.get("/api/site", async () => {
    const s = getSettings();
    return { data: { announcement: s.announcement, apiBaseUrl: s.api_base_url } };
  });
}

// ---------- 公开账号池快照（首页实时面板，脱敏） ----------

interface PoolRow {
  id: string;
  name: string;
  account_email: string | null;
  owner_id: string | null;
  status: string;
  node_id: string | null;
  window_5h_used: number | null;
  window_7d_used: number | null;
  rate_limited_until: string | null;
  window_exhausted_until: string | null;
  last_used_at: string | null;
}

/** pr***@***.us —— 前缀与域名主体都掩码，只保留首字母与 TLD。 */
function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  if (!domain) return "***";
  const tld = domain.includes(".") ? domain.slice(domain.lastIndexOf(".")) : "";
  return `${local.slice(0, 2)}***@***${tld}`;
}

function maskName(name: string): string {
  // claude-09481c0d → claude-09···
  const m = /^(.*?)(\w{2})\w+$/.exec(name);
  return m ? `${m[1]}${m[2]}···` : "***";
}

const POOL_WHERE = "type = 'oauth' AND platform = 'anthropic' AND review_status = 'approved' AND status <> 'disabled'";

function poolState(r: PoolRow, now: string, nodeOnline: Map<string, boolean>): "online" | "cooling" | "error" | "offline" {
  const cooling =
    (r.rate_limited_until && r.rate_limited_until > now) || (r.window_exhausted_until && r.window_exhausted_until > now);
  const nodeOff = r.node_id ? nodeOnline.get(r.node_id) === false : false;
  return r.status !== "active" ? "error" : nodeOff ? "offline" : cooling ? "cooling" : "online";
}

function poolItem(r: PoolRow, state: ReturnType<typeof poolState>) {
  return {
    label: r.account_email ? maskEmail(r.account_email) : maskName(r.name),
    side: r.owner_id === null ? ("platform" as const) : ("provider" as const),
    state,
    window5h: r.window_5h_used,
    window7d: r.window_7d_used,
    lastUsedAt: r.last_used_at,
  };
}

function poolBase() {
  const now = new Date().toISOString().slice(0, 19) + "Z";
  const nodeOnline = new Map(
    all<{ node_id: string; online: number }>("SELECT node_id, online FROM nodes").map((n) => [n.node_id, n.online === 1]),
  );
  return { now, nodeOnline };
}

/** 汇总（首页方块）：总数 + 各状态计数 + 24h 请求。 */
function poolSnapshot() {
  const { now, nodeOnline } = poolBase();
  const rows = all<PoolRow>(
    `SELECT id, name, account_email, owner_id, status, node_id, window_5h_used, window_7d_used,
            rate_limited_until, window_exhausted_until, last_used_at
     FROM accounts WHERE ${POOL_WHERE}`,
  );
  const states = { online: 0, cooling: 0, error: 0, offline: 0 };
  for (const r of rows) states[poolState(r, now, nodeOnline)]++;
  const req24h = one<{ n: number }>(
    "SELECT COUNT(*) AS n FROM usage_logs WHERE created_at >= strftime('%Y-%m-%dT%H:%M:%SZ','now','-24 hours')",
  );
  return {
    ts: now,
    totals: { accounts: rows.length, ...states, requests24h: req24h?.n ?? 0 },
  };
}

/** 明细（账号池页，分页）：每行含 5h/7d 窗口水位、30d 请求/费用、状态、最近使用。 */
function poolAccounts(side: "platform" | "provider" | undefined, page: number, pageSize: number) {
  const { now, nodeOnline } = poolBase();
  const sideSql = side === "platform" ? "AND owner_id IS NULL" : side === "provider" ? "AND owner_id IS NOT NULL" : "";
  const total = one<{ c: number }>(`SELECT COUNT(*) AS c FROM accounts WHERE ${POOL_WHERE} ${sideSql}`)?.c ?? 0;
  const rows = all<PoolRow>(
    `SELECT id, name, account_email, owner_id, status, node_id, window_5h_used, window_7d_used,
            rate_limited_until, window_exhausted_until, last_used_at
     FROM accounts WHERE ${POOL_WHERE} ${sideSql}
     ORDER BY created_at LIMIT ? OFFSET ?`,
    pageSize,
    (page - 1) * pageSize,
  );
  const usage30d = new Map(
    all<{ account_id: string; n: number; cost: number }>(
      `SELECT account_id, COUNT(*) AS n, COALESCE(SUM(actual_cost), 0) AS cost
       FROM usage_logs WHERE created_at >= strftime('%Y-%m-%dT%H:%M:%SZ','now','-30 days') GROUP BY account_id`,
    ).map((u) => [u.account_id, u]),
  );
  return {
    ts: now,
    total,
    page,
    pageSize,
    items: rows.map((r) => {
      const u = usage30d.get(r.id);
      return {
        ...poolItem(r, poolState(r, now, nodeOnline)),
        requests30d: u?.n ?? 0,
        cost30d: u ? Math.round(u.cost * 10000) / 10000 : 0,
      };
    }),
  };
}
