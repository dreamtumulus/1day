import type { FastifyInstance } from "fastify";
import { all, boundProxyDown, getSettings, getSetting, one, publicModels, publicPricing, parseThresholdPercent, windowAllows, type AccountRow } from "@1dayapi/core";
import { isTrustedExecutionNode } from "../node/trust.js";
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

  const poolHits=new Map<string,{count:number;resetAt:number}>();
  const poolLimit=async(req:Parameters<typeof body>[0],reply:Parameters<typeof sendError>[0])=>{
    const now=Date.now();
    if(poolHits.size>1000)for(const [ip,b] of poolHits)if(b.resetAt<=now)poolHits.delete(ip);
    if(poolHits.size>=5000 && !poolHits.has(req.ip))return sendError(reply,429,"too_many_requests","Pool statistics are busy; retry later");
    let bucket=poolHits.get(req.ip);
    if(!bucket || bucket.resetAt<=now){bucket={count:0,resetAt:now+60_000};poolHits.set(req.ip,bucket);}
    if(++bucket.count>60)return sendError(reply,429,"too_many_requests","Too many pool statistics requests; retry later");
  };
  // 首页实时账号池汇总（脱敏）；明细分页在 /api/pool/accounts。
  app.get("/api/pool", {preHandler:poolLimit}, async () => ({ data: poolSnapshot() }));

  // 账号池明细（脱敏、分页）：?side=platform|provider&page=1&pageSize=50（上限 200）。
  app.get("/api/pool/accounts", {preHandler:poolLimit}, async (req) => {
    const q = req.query as Record<string, string | undefined>;
    const side = q.side === "platform" || q.side === "provider" ? q.side : undefined;
    const pageInput=Number(q.page);
    const pageN = Number.isFinite(pageInput)?Math.min(1_000_000,Math.max(1,Math.floor(pageInput)||1)):1;
    const sizeInput=Number(q.pageSize);
    const pageSize = Number.isFinite(sizeInput)?Math.min(200,Math.max(1,Math.floor(sizeInput)||50)):50;
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
  team_id:string|null;
  bound_proxy_id:string|null;
  route:"direct"|"node";
  overload_until:string|null;
  temp_unschedulable_until:string|null;
  window_used:number|null;
  window_reset_at:string|null;
  window_5h_reset_at:string|null;
  window_7d_reset_at:string|null;
  concurrency:number;
  executor:AccountRow["executor"];
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

function poolState(r: PoolRow, now: string, nodeOnline: Map<string, boolean>): "online" | "cooling" | "error" | "offline" | "unmanaged" | "unavailable" | "busy" {
  if(!r.team_id)return "unmanaged";
  if(r.status!=="active")return "error";
  if(!r.node_id || !nodeOnline.get(r.node_id) || !isTrustedExecutionNode(r.node_id))return "offline";
  if(r.route!=="node" || !r.bound_proxy_id || boundProxyDown(r) ||
    !one("SELECT 1 FROM upstream_teams WHERE id=? AND status='active'",r.team_id) ||
    !one("SELECT 1 FROM account_groups ag JOIN groups g ON g.id=ag.group_id WHERE ag.account_id=? AND g.status='active'",r.id))return "unavailable";
  if((r.rate_limited_until && r.rate_limited_until>now) || (r.window_exhausted_until && r.window_exhausted_until>now) ||
    (r.overload_until && r.overload_until>now) || (r.temp_unschedulable_until && r.temp_unschedulable_until>now) ||
    !windowAllows(r,now,parseThresholdPercent(getSetting("anthropic_window_threshold_percent"))))return "cooling";
  if(r.concurrency>0 && (one<{n:number}>("SELECT COUNT(*) n FROM gateway_account_leases WHERE account_id=? AND expires_at>?",r.id,Date.now())?.n??0)>=r.concurrency)return "busy";
  return "online";
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
    all<{ node_id: string; online: number;accepting_sessions:number }>("SELECT node_id, online,accepting_sessions FROM nodes").map((n) => [n.node_id, n.online === 1 && n.accepting_sessions===1]),
  );
  return { now, nodeOnline };
}

/** 汇总（首页方块）：总数 + 各状态计数 + 24h 请求。 */
let snapshotCache:{expires:number;value:unknown}|undefined;
function poolSnapshot() {
  if(snapshotCache && snapshotCache.expires>Date.now())return snapshotCache.value;
  const { now, nodeOnline } = poolBase();
  const rows = all<PoolRow>(
    `SELECT id, team_id, bound_proxy_id, route, overload_until, temp_unschedulable_until, window_used, window_reset_at, window_5h_reset_at, window_7d_reset_at, concurrency, executor, name, account_email, owner_id, status, node_id, window_5h_used, window_7d_used,
            rate_limited_until, window_exhausted_until, last_used_at
     FROM accounts WHERE ${POOL_WHERE}`,
  );
  const states = { online: 0, cooling: 0, error: 0, offline: 0, unmanaged:0,unavailable:0,busy:0 };
  for (const r of rows) states[poolState(r, now, nodeOnline)]++;
  const req24h = one<{ n: number }>(
    "SELECT COUNT(*) AS n FROM usage_logs WHERE created_at >= strftime('%Y-%m-%dT%H:%M:%SZ','now','-24 hours')",
  );
  const value={ts:now,totals:{accounts:rows.length,...states,requests24h:req24h?.n??0}};
  snapshotCache={expires:Date.now()+5_000,value};
  return value;
}

const usageCache=new Map<string,{expires:number;value:{account_id:string;n:number;cost:number}}>();

/** 明细（账号池页，分页）：每行含 5h/7d 窗口水位、30d 请求/费用、状态、最近使用。 */
function poolAccounts(side: "platform" | "provider" | undefined, page: number, pageSize: number) {
  const { now, nodeOnline } = poolBase();
  const sideSql = side === "platform" ? "AND owner_id IS NULL" : side === "provider" ? "AND owner_id IS NOT NULL" : "";
  const total = one<{ c: number }>(`SELECT COUNT(*) AS c FROM accounts WHERE ${POOL_WHERE} ${sideSql}`)?.c ?? 0;
  const rows = all<PoolRow>(
    `SELECT id, team_id, bound_proxy_id, route, overload_until, temp_unschedulable_until, window_used, window_reset_at, window_5h_reset_at, window_7d_reset_at, concurrency, executor, name, account_email, owner_id, status, node_id, window_5h_used, window_7d_used,
            rate_limited_until, window_exhausted_until, last_used_at
     FROM accounts WHERE ${POOL_WHERE} ${sideSql}
     ORDER BY created_at LIMIT ? OFFSET ?`,
    pageSize,
    (page - 1) * pageSize,
  );
  // The account/time index bounds work to this page, never a 30-day all-site GROUP BY.
  const usage30d=new Map<string,{account_id:string;n:number;cost:number}>();
  const missing=rows.filter(r=>!usageCache.has(r.id) || usageCache.get(r.id)!.expires<=Date.now()).map(r=>r.id);
  if(missing.length){
    const totals=all<{account_id:string;n:number;cost:number}>(`SELECT account_id,COUNT(*) n,COALESCE(SUM(actual_cost),0) cost FROM usage_logs WHERE account_id IN (${missing.map(()=>"?").join(",")}) AND created_at>=strftime('%Y-%m-%dT%H:%M:%SZ','now','-30 days') GROUP BY account_id`,...missing);
    const byId=new Map(totals.map(u=>[u.account_id,u]));
    if(usageCache.size>2000)usageCache.clear();
    for(const id of missing)usageCache.set(id,{expires:Date.now()+60_000,value:byId.get(id)??{account_id:id,n:0,cost:0}});
  }
  for(const row of rows)usage30d.set(row.id,usageCache.get(row.id)!.value);

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
