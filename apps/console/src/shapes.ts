import { poolBase, poolVerdict, type PoolRow } from "./pool-state.js";
import {
  all,
  coolingUntil,
  parseModelCooldowns,
  dayIso,
  nowIso,
  one,
  parseAllowlist,
  parseJsonArray,
  parseJsonMap,
  type AccountRow, parseKeyPolicy, parseKeyPolicyDoc, parseWindowModel, planLabel,
  CREDITS_REJECTION_KEY, creditsLive, creditsServing, parseUsageCredits,
  getModelEntry, usageCostLines, type BasicPrices, type UsageCostMeter } from "@1dayapi/core";

// Row -> API shapes (camelCase) shared by the user / provider / admin routes.

// ---------- API keys ----------

export interface ApiKeyRow {
  id: string;
  user_id: string;
  name: string;
  key_preview: string;
  key_enc: string | null;
  group_id: string;
  group_name?: string | null;
  status: string;
  quota_usd: number;
  used_usd: number;
  expires_at: string | null;
  last_used_at: string | null;
  created_at: string;
  user_name?: string | null;
  policy_json?: string | null;
}

export const API_KEY_SELECT = `SELECT k.*, g.name AS group_name, u.name AS user_name
  FROM api_keys k LEFT JOIN groups g ON g.id = k.group_id LEFT JOIN users u ON u.id = k.user_id`;

export function effectiveKeyStatus(k: ApiKeyRow, now = nowIso()): "active" | "disabled" | "expired" | "exhausted" {
  if (k.status !== "active") return "disabled";
  if (k.expires_at && k.expires_at <= now) return "expired";
  if (k.quota_usd > 0 && k.used_usd >= k.quota_usd) return "exhausted";
  return "active";
}

export function apiKeyShape(k: ApiKeyRow) {
  return {
    id: k.id,
    userId: k.user_id,
    userName: k.user_name ?? null,
    name: k.name,
    keyPreview: k.key_preview,
    groupId: k.group_id,
    groupName: k.group_name ?? null,
    status: k.status,
    effectiveStatus: effectiveKeyStatus(k),
    quotaUsd: k.quota_usd,
    usedUsd: k.used_usd,
    expiresAt: k.expires_at,
    lastUsedAt: k.last_used_at,
    createdAt: k.created_at,
    revealable: !!k.key_enc,
    policy: parseKeyPolicy(k.policy_json, k.group_id),
    policyLayers: parseKeyPolicyDoc(k.policy_json),
  };
}

// ---------- groups ----------

export interface GroupRow {
  id: string;
  name: string;
  description: string | null;
  rate_multiplier: number;
  model_allowlist: string | null;
  is_exclusive: number;
  status: string;
  sort_order: number;
  created_at: string;
}

export function groupShape(g: GroupRow) {
  const al = parseAllowlist(g.model_allowlist);
  return {
    id: g.id,
    name: g.name,
    description: g.description,
    rateMultiplier: g.rate_multiplier,
    modelAllowlist: g.model_allowlist ? al : null,
    isExclusive: g.is_exclusive === 1,
    status: g.status,
    sortOrder: g.sort_order,
    createdAt: g.created_at,
  };
}

/** Groups a user may bind API keys to: active non-exclusive + explicitly allowed. */
export function availableGroups(userId: string): GroupRow[] {
  return all<GroupRow>(
    `SELECT g.* FROM groups g
     WHERE g.status = 'active'
       AND (g.is_exclusive = 0 OR g.id IN (SELECT group_id FROM user_allowed_groups WHERE user_id = ?))
     ORDER BY g.sort_order, g.created_at`,
    userId,
  );
}

// ---------- accounts ----------

export function accountStats30d(): Map<string, { requests: number; cost: number; earning: number }> {
  const since = `${dayIso(-29)}T00:00:00Z`;
  const rows = all<{ account_id: string; requests: number; cost: number; earning: number }>(
    `SELECT account_id, COUNT(*) AS requests, COALESCE(SUM(actual_cost),0) AS cost,
            COALESCE(SUM(provider_earning),0) AS earning
     FROM usage_logs WHERE account_id IS NOT NULL AND created_at >= ? AND status_code < 300
     GROUP BY account_id`,
    since,
  );
  return new Map(rows.map((r) => [r.account_id, r]));
}

/** Per-account usage over the scheduling-relevant horizons (admin list; docs/console-api.md). */
export interface AccountUsageStats {
  h5: { requests: number; costUsd: number; tokens: number };
  d7: { requests: number; costUsd: number; tokens: number };
  d30: { requests: number; costUsd: number; tokens: number };
  all: { requests: number; costUsd: number; tokens: number };
  /**
   * What the account served inside its latest known five-hour quota window, i.e. the five hours ending at
   * `accounts.window_5h_reset_at` (the current window while that reset is ahead, the last one once it has passed).
   * `h5` is a rolling "last five hours" and falls towards 0 while an exhausted account rests; this bucket is the yield
   * of one quota window. null when the upstream never reported a five-hour reset for the account.
   */
  w5: { requests: number; costUsd: number; tokens: number; startAt: string; endAt: string } | null;
  /** Successful requests in the last 60 s (what the gateway's RPM gate counts). */
  rpm: number;
  errors24h: number;
}

const EMPTY_BUCKET = { requests: 0, costUsd: 0, tokens: 0 };
export const EMPTY_USAGE: AccountUsageStats = { h5: EMPTY_BUCKET, d7: EMPTY_BUCKET, d30: EMPTY_BUCKET, all: EMPTY_BUCKET, w5: null, rpm: 0, errors24h: 0 };

/** One grouped scan of usage_logs for the given accounts (a page of the admin list). */
export function accountUsageStats(ids: string[]): Map<string, AccountUsageStats> {
  const m = new Map<string, AccountUsageStats>();
  if (!ids.length) return m;
  const now = Date.now();
  const iso = (ms: number) => new Date(now - ms).toISOString().slice(0, 19) + "Z";
  const h5 = iso(5 * 3_600_000);
  const d1 = iso(86_400_000);
  const d7 = iso(7 * 86_400_000);
  const d30 = iso(30 * 86_400_000);
  const m1 = iso(60_000);
  const tokens = "(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens)";
  const bucket = (since: string, alias: string) =>
    `SUM(CASE WHEN created_at >= '${since}' AND status_code < 300 THEN 1 ELSE 0 END) AS r_${alias},
     COALESCE(SUM(CASE WHEN created_at >= '${since}' THEN actual_cost ELSE 0 END),0) AS c_${alias},
     COALESCE(SUM(CASE WHEN created_at >= '${since}' THEN ${tokens} ELSE 0 END),0) AS t_${alias}`;
  const rows = all<Record<string, number> & { account_id: string }>(
    `SELECT account_id,
            ${bucket(h5, "h5")}, ${bucket(d7, "d7")}, ${bucket(d30, "d30")},
            SUM(CASE WHEN status_code < 300 THEN 1 ELSE 0 END) AS r_all,
            COALESCE(SUM(actual_cost),0) AS c_all, COALESCE(SUM(${tokens}),0) AS t_all,
            SUM(CASE WHEN created_at >= '${m1}' AND status_code < 300 THEN 1 ELSE 0 END) AS rpm,
            SUM(CASE WHEN created_at >= '${d1}' AND status_code >= 300 THEN 1 ELSE 0 END) AS errors24h
     FROM usage_logs WHERE account_id IN (${ids.map(() => "?").join(",")})
     GROUP BY account_id`,
    ...ids,
  );
  const b = (r: Record<string, number>, k: string) => ({ requests: r[`r_${k}`] ?? 0, costUsd: r[`c_${k}`] ?? 0, tokens: r[`t_${k}`] ?? 0 });
  // The five-hour quota window of each account: [reset − 5 h, reset). Bounds are computed in SQL from the stored reset
  // so both sides compare as the same `YYYY-MM-DDTHH:MM:SSZ` text as usage_logs.created_at.
  const windows = all<{ account_id: string; start_at: string; end_at: string; r_w5: number; c_w5: number; t_w5: number }>(
    `SELECT a.id AS account_id, w.start_at, w.end_at,
            COALESCE(SUM(CASE WHEN u.status_code < 300 THEN 1 ELSE 0 END),0) AS r_w5,
            COALESCE(SUM(u.actual_cost),0) AS c_w5, COALESCE(SUM(${tokens}),0) AS t_w5
     FROM accounts a
     JOIN (SELECT id, strftime('%Y-%m-%dT%H:%M:%SZ', window_5h_reset_at, '-5 hours') AS start_at,
                  strftime('%Y-%m-%dT%H:%M:%SZ', window_5h_reset_at) AS end_at
           FROM accounts WHERE window_5h_reset_at IS NOT NULL) w ON w.id = a.id
     LEFT JOIN usage_logs u ON u.account_id = a.id AND u.created_at >= w.start_at AND u.created_at < w.end_at
     WHERE a.id IN (${ids.map(() => "?").join(",")}) AND w.start_at IS NOT NULL
     GROUP BY a.id`,
    ...ids,
  );
  const w5 = new Map(windows.map((r) => [r.account_id, { requests: r.r_w5, costUsd: r.c_w5, tokens: r.t_w5, startAt: r.start_at, endAt: r.end_at }]));
  for (const r of rows) m.set(r.account_id, { h5: b(r, "h5"), d7: b(r, "d7"), d30: b(r, "d30"), all: b(r, "all"), w5: w5.get(r.account_id) ?? null, rpm: r.rpm ?? 0, errors24h: r.errors24h ?? 0 });
  // an account with a known window but no usage row at all still reports its (empty) window
  for (const [id, w] of w5) if (!m.has(id)) m.set(id, { ...EMPTY_USAGE, w5: w });
  return m;
}

/**
 * Usage credits of a subscription account (docs/usage-credits.md): the normalised state from the last usage poll (no
 * raw body, no disclaimer text) and whether the scheduler is serving the account on credits right now.
 */
function usageCreditsFields(a: AccountRow) {
  const usageCredits = parseUsageCredits(a.usage_json);
  let serving = { window: false, fable: false };
  let live = false;
  let rejectedAt: string | null = null;
  try {
    serving = creditsServing(a);
    live = creditsLive(a);
    rejectedAt = parseModelCooldowns(a.model_cooldowns)[CREDITS_REJECTION_KEY]?.rejectedAt ?? null;
  } catch {
    /* settings unreadable: report the parsed state only */
  }
  return {
    usageCredits,
    /** Requests for an exhausted quota are currently scheduled onto this account and paid from its credits. */
    onCredits: serving.window || serving.fable,
    /** Which quota is bridged: "window" (5h / weekly, all models), "fable" (Fable weekly share). */
    onCreditsScopes: [serving.window ? "window" : null, serving.fable ? "fable" : null].filter((s): s is string => !!s),
    /** Credits look usable AND the upstream has not refused the account since the last usage poll. */
    creditsLive: live,
    /** Last upstream refusal at a plan limit, when it is newer than the usage poll (credits distrusted until the next poll). */
    creditsRejectedAt: rejectedAt && (!a.usage_checked_at || rejectedAt >= a.usage_checked_at) ? rejectedAt : null,
  };
}

/** Fields safe to show the account owner (no credential material). */
export function providerAccountShape(
  a: AccountRow,
  stats?: { requests: number; cost: number; earning: number },
) {
  return {
    id: a.id,
    name: a.name,
    platform: a.platform,
    type: a.type,
    executor: a.executor,
    protocol: a.protocol,
    baseUrl: a.base_url,
    models: parseJsonArray(a.models),
    route: a.route,
    nodeId: a.node_id,
    reviewStatus: a.review_status,
    reviewNote: a.review_note,
    status: a.status,
    errorMessage: a.error_message ? "upstream account unavailable" : null,
    payoutRate: a.payout_rate,
    accountEmail: a.account_email,
    subscriptionType: a.subscription_type,
    // 2026-11-02: full plan identity (tier separates Ultra / Max), org/billing/seat/status, and which windows apply
    rateLimitTier: a.rate_limit_tier,
    planLabel: a.plan_label ?? planLabel(a.rate_limit_tier, a.org_type, a.seat_tier, a.subscription_type),
    orgType: a.org_type,
    billingType: a.billing_type,
    seatTier: a.seat_tier,
    subscriptionStatus: a.subscription_status,
    windowModel: parseWindowModel(a.window_model),
    usageCheckedAt: a.usage_checked_at,
    ...usageCreditsFields(a),

    concurrency: a.concurrency,
    rpmLimit: a.rpm_limit,
    boundProxyId: a.bound_proxy_id,
    windowUsed: a.window_used,
    windowResetAt: a.window_reset_at,
    windowExhaustedUntil: a.window_exhausted_until,
    coolingUntil: coolingUntil(a),
    lastUsedAt: a.last_used_at,
    createdAt: a.created_at,
    requests30d: stats?.requests ?? 0,
    earning30d: stats?.earning ?? 0,
  };
}


/** Admin view: the scheduler's verdict for a subscription account and the first failing gate. */
function poolReasonFields(a: AccountRow) {
  try {
    const { now, nodeOnline } = poolBase();
    const v = poolVerdict(a as unknown as PoolRow, now, nodeOnline);
    return { poolState: v.state, poolReason: v.reason };
  } catch {
    return {};
  }
}

export function accountReadiness(a: AccountRow, now = nowIso()): "logged_in" | "refreshed" | "profile_valid" | "inference_valid" | "rate_limited" | "reauth_required" {
  if (a.status === "error") return "reauth_required";
  if ((a.rate_limited_until && a.rate_limited_until > now) || (a.window_exhausted_until && a.window_exhausted_until > now)) return "rate_limited";
  if (a.last_inference_at) return "inference_valid";
  if (a.last_profile_at) return "profile_valid";
  if (a.last_refresh_at) return "refreshed";
  return "logged_in";
}

function safeJson(v: string): unknown {
  try {
    return JSON.parse(v);
  } catch {
    return null;
  }
}

export function adminAccountShape(
  a: AccountRow & { owner_name?: string | null },
  groups: Array<{ groupId: string; name: string; priority: number }>,
  stats?: { requests: number; cost: number; earning: number },
  extra?: { usage?: AccountUsageStats; inFlight?: number | null; showTeam?:boolean },
) {
  const usage = extra?.usage ?? EMPTY_USAGE;
  // Bound proxy facts shown on the account lists (user 2026-10-29: 所属组织 / IP 组 / IP 区域 on every account row).
  const bp = a.bound_proxy_id ? one<{ c: string | null; g: string | null; ip: string | null }>("SELECT exit_country AS c, group_name AS g, exit_ip AS ip FROM node_proxies WHERE id = ?", a.bound_proxy_id) : null;
  return {
    ...providerAccountShape(a, stats ?? { requests: usage.d30.requests, cost: usage.d30.costUsd, earning: 0 }),
    ...(extra?.showTeam && a.type==="oauth" && a.platform==="anthropic" ? poolReasonFields(a) : {}),
    ...(extra?.showTeam?{teamId:a.team_id,teamName:a.team_id?one<{name:string|null}>("SELECT name FROM upstream_teams WHERE id=?",a.team_id)?.name??null:null,
      /** Saved organization profile (onboard_orgs) matching the account's team, when one exists. */
      orgName:a.team_id?one<{name:string}>("SELECT name FROM onboard_orgs WHERE lower(org_uuid)=lower(?) LIMIT 1",a.team_id)?.name??null:null,
      errorMessage:a.error_message,
      /** Secret-free raw /api/oauth/profile and /api/oauth/usage bodies (2026-11-02, admin only). */
      profile:a.profile_json?safeJson(a.profile_json):null,
      usageSnapshot:a.usage_json?safeJson(a.usage_json):null}:{}),
    ownerId: a.owner_id,
    ownerName: a.owner_name ?? null,
    priority: a.priority,
    concurrency: a.concurrency,
    rpmLimit: a.rpm_limit,
    rawPassthrough: a.raw_passthrough === 1,
    boundProxyId: a.bound_proxy_id,
    boundProxyCountry: bp?.c ?? null,
    boundProxyGroup: bp?.g ?? null,
    boundProxyExitIp: bp?.ip ?? null,
    modelMapping: parseJsonMap(a.model_mapping),
    groups,
    credentialVersion: a.credential_version,
    readiness: accountReadiness(a),
    lastProfileAt: a.last_profile_at,
    lastRefreshAt: a.last_refresh_at,
    lastInferenceAt: a.last_inference_at,
    rateLimitedUntil: a.rate_limited_until,
    overloadUntil: a.overload_until,
    tempUnschedulableUntil: a.temp_unschedulable_until,
    /** status 'proxy_down' (operator rule 2026-11-01): frozen since / why / which proxy; null otherwise. */
    proxyDownSince: a.proxy_down_since ?? null,
    proxyDownReason: a.status === "proxy_down" ? (a.proxy_down_reason ?? null) : null,
    proxyDownProxyId: a.status === "proxy_down" ? (a.proxy_down_proxy_id ?? null) : null,
    windowUsed: a.window_used,
    windowResetAt: a.window_reset_at,
    windowCheckedAt: a.window_checked_at,
    windowExhaustedUntil: a.window_exhausted_until,
    window5hUsed: a.window_5h_used,
    window5hResetAt: a.window_5h_reset_at,
    window7dUsed: a.window_7d_used,
    window7dResetAt: a.window_7d_reset_at,
    windowReason:extra?.showTeam?a.window_reason:a.window_reason?"Account window temporarily unavailable":null,
    /** Per-model-family cooldowns, e.g. {fable: {until, reason, used, resetAt}} (docs/gateway.md §3). */
    modelCooldowns: Object.fromEntries(Object.entries(parseModelCooldowns(a.model_cooldowns)).filter(([k])=>k!==CREDITS_REJECTION_KEY).map(([k,v])=>[k,extra?.showTeam?v:{...v,reason:v.reason?"Model temporarily unavailable":v.reason}])),
    cost30d: stats?.cost ?? usage.d30.costUsd,
    usage,
    /** Live in-flight requests on the gateway (null when the gateway could not be reached). */
    inFlight: extra?.inFlight ?? null,
  };
}

export function accountGroupsMap(): Map<string, Array<{ groupId: string; name: string; priority: number }>> {
  const rows = all<{ account_id: string; group_id: string; name: string; priority: number }>(
    `SELECT ag.account_id, ag.group_id, g.name, ag.priority
     FROM account_groups ag JOIN groups g ON g.id = ag.group_id ORDER BY g.sort_order, g.name`,
  );
  const m = new Map<string, Array<{ groupId: string; name: string; priority: number }>>();
  for (const r of rows) {
    const list = m.get(r.account_id) ?? [];
    list.push({ groupId: r.group_id, name: r.name, priority: r.priority });
    m.set(r.account_id, list);
  }
  return m;
}

// ---------- usage aggregates ----------

export interface DailyPoint {
  day: string;
  requests: number;
  costUsd: number;
  tokens: number;
  earningUsd: number;
  errors: number;
}

/** Zero-filled daily series for the last `days` days (UTC). */
export function dailySeries(days: number, whereSql: string, params: unknown[]): DailyPoint[] {
  const since = `${dayIso(-(days - 1))}T00:00:00Z`;
  const rows = all<{ day: string; requests: number; cost: number; tokens: number; earning: number; errors: number }>(
    `SELECT substr(created_at,1,10) AS day,
            SUM(CASE WHEN status_code < 300 THEN 1 ELSE 0 END) AS requests,
            COALESCE(SUM(actual_cost),0) AS cost,
            COALESCE(SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens),0) AS tokens,
            COALESCE(SUM(provider_earning),0) AS earning,
            SUM(CASE WHEN status_code >= 300 THEN 1 ELSE 0 END) AS errors
     FROM usage_logs WHERE created_at >= ? ${whereSql ? `AND ${whereSql}` : ""}
     GROUP BY day`,
    since,
    ...params,
  );
  const byDay = new Map(rows.map((r) => [r.day, r]));
  const out: DailyPoint[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const day = dayIso(-i);
    const r = byDay.get(day);
    out.push({
      day,
      requests: r?.requests ?? 0,
      costUsd: r?.cost ?? 0,
      tokens: r?.tokens ?? 0,
      earningUsd: r?.earning ?? 0,
      errors: r?.errors ?? 0,
    });
  }
  return out;
}

export function periodTotals(sinceIso: string, whereSql: string, params: unknown[]) {
  const r = one<{ requests: number; cost: number; total: number; tokens: number; earning: number; errors: number }>(
    `SELECT SUM(CASE WHEN status_code < 300 THEN 1 ELSE 0 END) AS requests,
            COALESCE(SUM(actual_cost),0) AS cost, COALESCE(SUM(total_cost),0) AS total,
            COALESCE(SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens),0) AS tokens,
            COALESCE(SUM(provider_earning),0) AS earning,
            SUM(CASE WHEN status_code >= 300 THEN 1 ELSE 0 END) AS errors
     FROM usage_logs WHERE created_at >= ? ${whereSql ? `AND ${whereSql}` : ""}`,
    sinceIso,
    ...params,
  );
  return {
    requests: r?.requests ?? 0,
    costUsd: r?.cost ?? 0,
    totalCostUsd: r?.total ?? 0,
    tokens: r?.tokens ?? 0,
    earningUsd: r?.earning ?? 0,
    errors: r?.errors ?? 0,
  };
}

export const todayStart = (): string => `${dayIso(0)}T00:00:00Z`;
export const monthStart = (): string => `${dayIso(0).slice(0, 8)}01T00:00:00Z`;

export interface UsageRowDb {
  id: string;
  request_id: string;
  created_at: string;
  user_id: string;
  user_name?: string | null;
  api_key_id: string;
  key_name?: string | null;
  account_id: string | null;
  account_name?: string | null;
  model: string;
  upstream_model: string | null;
  actual_model?: string | null;
  endpoint: string;
  stream: number;
  status_code: number;
  error_code: string | null;
  error_scope?: string | null;
  retryable?: number | null;
  credential_version?: number | null;
  execution_sequence?: number | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  /** migration 41; undefined / 0 on rows from before the split (cache_write_tokens is then the unsplit total). */
  cache_write_5m_tokens?: number | null;
  cache_write_1h_tokens?: number | null;
  /** usage_pricing_snapshots.pricing_json of the row (USAGE_SELECT), the tariff it was settled with. */
  pricing_json?: string | null;
  usage_estimated: number;
  total_cost: number;
  rate_multiplier: number;
  actual_cost: number;
  provider_earning: number;
  duration_ms: number | null;
  first_token_ms: number | null;
  selection_ms?: number | null;
  stream_truncated?: number | null;
  tool_calls?: number | null;
  tool_results?: number | null;
  client_ip?: string | null;
  cc_shape?: string | null;
  error_message?: string | null;
  mode?: string | null;
  upstream_status?: number | null;
  node_id?: string | null;
  account_switched?: number | null;
  cache_refund_id?: string | null;
  /** Provenance (migration 30 + fallbacks to the account's current binding), admin lists only. */
  eff_team_id?: string | null;
  eff_proxy_id?: string | null;
  team_name?: string | null;
  org_name?: string | null;
  proxy_group?: string | null;
  proxy_country?: string | null;
}

/**
 * Per-meter cost lines of a settled row (X-51): tokens, list unit price (USD / 1M) and the billed amount (after the
 * group multiplier). Unit prices are the ones the row was settled with (pricing snapshot); rows older than the
 * snapshots fall back to today's price and say so. null for rows that were not charged.
 */
export function usageCostBreakdown(u: UsageRowDb): { priceSource: "settlement" | "current"; lines: Array<{ meter: UsageCostMeter; tokens: number; pricePerM: number; costUsd: number }> } | null {
  if (u.status_code >= 300) return null;
  let prices: BasicPrices | null = null;
  let priceSource: "settlement" | "current" = "settlement";
  if (u.pricing_json) {
    try {
      const snap = JSON.parse(u.pricing_json) as { prices?: BasicPrices | null };
      if (snap?.prices && typeof snap.prices.inputPerM === "number") prices = snap.prices;
    } catch {
      /* unreadable snapshot: fall back to the current price */
    }
  }
  if (!prices) {
    prices = getModelEntry(u.model)?.prices ?? null;
    priceSource = "current";
  }
  if (!prices) return null;
  const lines = usageCostLines(
    { input_tokens: u.input_tokens, output_tokens: u.output_tokens, cache_read_tokens: u.cache_read_tokens, cache_write_tokens: u.cache_write_tokens,
      cache_write_5m_tokens: u.cache_write_5m_tokens ?? 0, cache_write_1h_tokens: u.cache_write_1h_tokens ?? 0 },
    prices,
  ).map((l) => ({ ...l, costUsd: l.costUsd * u.rate_multiplier }));
  return { priceSource, lines };
}

export function usageShape(u: UsageRowDb) {
  return {
    id: u.id,
    requestId: u.request_id,
    createdAt: u.created_at,
    keyName: u.key_name ?? null,
    model: u.model,
    upstreamModel: u.upstream_model,
    actualModel: u.actual_model ?? null,
    endpoint: u.endpoint,
    stream: u.stream === 1,
    statusCode: u.status_code,
    errorCode: u.error_code,
    errorScope: u.error_scope ?? null,
    retryable: u.retryable === undefined || u.retryable === null ? null : u.retryable === 1,
    credentialVersion: u.credential_version ?? null,
    executionSequence: u.execution_sequence ?? null,
    inputTokens: u.input_tokens,
    outputTokens: u.output_tokens,
    cacheReadTokens: u.cache_read_tokens,
    /** Total cache creation; the two below are its split by TTL (both 0 on rows from before the split). */
    cacheWriteTokens: u.cache_write_tokens,
    cacheWrite5mTokens: u.cache_write_5m_tokens ?? 0,
    cacheWrite1hTokens: u.cache_write_1h_tokens ?? 0,
    costBreakdown: usageCostBreakdown(u),
    usageEstimated: u.usage_estimated === 1,
    rateMultiplier: u.rate_multiplier,
    actualCost: u.actual_cost,
    durationMs: u.duration_ms,
    firstTokenMs: u.first_token_ms,
    selectionMs: u.selection_ms ?? null,
    streamTruncated: (u.stream_truncated ?? 0) === 1,
    toolCalls: u.tool_calls ?? 0,
    toolResults: u.tool_results ?? 0,
    clientIp: u.client_ip ?? null,
    ccShape: u.cc_shape ?? null,
    errorMessage: u.error_message ?? null,
    mode: u.mode ?? null,
    upstreamStatus: u.upstream_status ?? null,
    nodeId: u.node_id ?? null,
    /** Sticky session was forced onto another account (gateway ForceCacheBilling); eligible for the cache refund. */
    accountSwitched: (u.account_switched ?? 0) === 1,
    cacheRefundId: u.cache_refund_id ?? null,
  };
}

/** cache_refunds row (docs/data-model.md §3): one refund run for one user. */
export function cacheRefundShape(r: {
  id: string;
  user_id: string;
  user_name?: string | null;
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
}) {
  return {
    id: r.id,
    userId: r.user_id,
    userName: r.user_name ?? null,
    rows: r.rows,
    excessUsd: r.excess_usd,
    percent: r.percent,
    refundUsd: r.refund_usd,
    toCreditUsd: r.to_credit_usd,
    toBalanceUsd: r.to_balance_usd,
    ledgerId: r.ledger_id,
    creditEventId: r.credit_event_id,
    periodFrom: r.period_from,
    periodTo: r.period_to,
    note: r.note,
    createdBy: r.created_by,
    createdAt: r.created_at,
  };
}

export function ledgerShape(l: {
  id: string;
  kind: string;
  amount_usd: number;
  balance_after: number;
  ref: string | null;
  note: string | null;
  created_at: string;
}) {
  return {
    id: l.id,
    kind: l.kind,
    amountUsd: l.amount_usd,
    balanceAfter: l.balance_after,
    ref: l.ref,
    note: l.note,
    createdAt: l.created_at,
  };
}

/** credit_events row (docs/data-model.md §4): limit changes and settlements. */
export function creditEventShape(e: {
  id: string;
  kind: string;
  amount_usd: number;
  limit_before: number;
  limit_after: number;
  used_before: number;
  used_after: number;
  note: string | null;
  created_by: string | null;
  created_at: string;
}) {
  return {
    id: e.id,
    kind: e.kind,
    amountUsd: e.amount_usd,
    limitBefore: e.limit_before,
    limitAfter: e.limit_after,
    usedBefore: e.used_before,
    usedAfter: e.used_after,
    note: e.note,
    createdBy: e.created_by,
    createdAt: e.created_at,
  };
}
