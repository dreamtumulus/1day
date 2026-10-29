import { apiFetch, unwrap } from "../lib/api";

// Typed client for the v3 console API (docs/v3-design.md §8).

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await apiFetch<unknown>(path, {
    method,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return unwrap<T>(res);
}

export const api = {
  get: <T>(path: string, params?: Record<string, string | number | undefined | null>) => {
    const qs = params
      ? Object.entries(params)
          .filter(([, v]) => v !== undefined && v !== null && v !== "")
          .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
          .join("&")
      : "";
    return call<T>("GET", qs ? `${path}?${qs}` : path);
  },
  post: <T>(path: string, body: unknown = {}) => call<T>("POST", path, body),
  patch: <T>(path: string, body: unknown) => call<T>("PATCH", path, body),
  put: <T>(path: string, body: unknown) => call<T>("PUT", path, body),
  del: <T = { ok: boolean }>(path: string) => call<T>("DELETE", path),
};

// ---------- shared shapes ----------

export interface Paged<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface DailyPoint {
  day: string;
  requests: number;
  costUsd: number;
  tokens: number;
  earningUsd?: number;
  errors?: number;
}

export interface Totals {
  requests: number;
  costUsd: number;
  totalCostUsd?: number;
  tokens: number;
  earningUsd?: number;
  errors?: number;
}

export interface ModelAllowlist {
  enabled: boolean;
  models: string[];
}

export interface Group {
  id: string;
  name: string;
  description: string | null;
  rateMultiplier: number;
  modelAllowlist: ModelAllowlist | null;
  isExclusive: boolean;
  status: "active" | "disabled";
  sortOrder: number;
  createdAt: string;
  isDefault?: boolean;
  keyCount?: number;
  accountCount?: number;
}

export type KeyStatus = "active" | "disabled" | "expired" | "exhausted";

export interface ApiKey {
  id: string;
  userId: string;
  userName: string | null;
  name: string;
  keyPreview: string;
  groupId: string;
  groupName: string | null;
  status: "active" | "disabled";
  effectiveStatus: KeyStatus;
  quotaUsd: number;
  usedUsd: number;
  expiresAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
  revealable: boolean;
}

export interface UsageRow {
  id: string;
  requestId: string;
  createdAt: string;
  keyName: string | null;
  model: string;
  upstreamModel: string | null;
  endpoint: string;
  stream: boolean;
  statusCode: number;
  errorCode: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  usageEstimated: boolean;
  rateMultiplier: number;
  actualCost: number;
  durationMs: number | null;
  firstTokenMs: number | null;
  /** Caller's IP as seen by the gateway (behind nginx: X-Forwarded-For). */
  clientIp: string | null;
  ccShape: "genuine" | "suspect" | null;
  errorMessage: string | null;
  mode: string | null;
  upstreamStatus: number | null;
  nodeId: string | null;
  // admin only
  userId?: string;
  userName?: string | null;
  accountId?: string | null;
  accountName?: string | null;
  providerId?: string | null;
  providerName?: string | null;
  totalCost?: number;
  providerEarning?: number;
}

export interface UsageStats {
  totals: { requests: number; costUsd: number; inputTokens: number; outputTokens: number; cacheTokens: number; cacheReadTokens: number; cacheWriteTokens: number };
  daily: Array<{
    day: string;
    requests: number;
    costUsd: number;
    tokens: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
  }>;
  byModel: Array<{ model: string; requests: number; costUsd: number; inputTokens: number; outputTokens: number }>;
  byAccount?: Array<{ accountId: string; name: string | null; requests: number; costUsd: number }>;
}

/** `GET /api/admin/usage/breakdown` · `GET /api/user/usage/breakdown`: spend per hour / day per user or key. */
export type BreakdownBucket = "hour" | "day";
export interface UsageBreakdownCell {
  /** ISO start of the UTC bucket (hour: `…T05:00:00Z`, day: `…T00:00:00Z`). */
  t: string;
  key: string;
  requests: number;
  errors: number;
  costUsd: number;
  tokens: number;
  lastAt: string;
}
export interface UsageBreakdownSeries {
  key: string;
  name: string | null;
  requests: number;
  errors: number;
  costUsd: number;
  tokens: number;
  lastAt: string | null;
}
export interface UsageBreakdown {
  bucket: BreakdownBucket;
  by: "user" | "key";
  cells: UsageBreakdownCell[];
  series: UsageBreakdownSeries[];
}

export interface ErrorSummary {
  totalErrors: number;
  totalRequests: number;
  byCode: Array<{ code: string; statusCode: number; count: number }>;
  byStatus: Array<{ statusCode: number; count: number }>;
  byMode: Array<{ mode: string; count: number }>;
  byAccount: Array<{ accountId: string | null; name: string | null; count: number }>;
  hourly: Array<{ hour: string; count: number }>;
}

/** credit_events row: credit-line changes and settlements (docs/data-model.md §4). */
export interface CreditEvent {
  id: string;
  kind: "limit_set" | "settlement" | "cache_refund" | string;
  amountUsd: number;
  limitBefore: number;
  limitAfter: number;
  usedBefore: number;
  usedAfter: number;
  note: string | null;
  createdBy: string | null;
  createdAt: string;
}

export interface CreditSummary {
  creditLimitUsd: number;
  creditUsedUsd: number;
  balanceUsd: number;
  availableUsd: number;
  creditSettledAt: string | null;
}

export interface LedgerRow {
  id: string;
  kind: "redeem" | "admin_adjust" | "payout" | "legacy_topup" | "cache_refund" | string;
  amountUsd: number;
  balanceAfter: number;
  ref: string | null;
  note: string | null;
  createdAt: string;
}

/** Cache-rebuild refund (docs/data-model.md §3 cache_refunds): switched requests not refunded yet. */
export interface CacheRefundPending {
  rows: number;
  excessUsd: number;
  refundUsd: number;
  percent: number;
  from: string | null;
  to: string | null;
}

export interface CacheRefundSummary {
  enabled: boolean;
  percent: number;
  intervalSec: number;
  pending: CacheRefundPending;
  lastScheduledRunAt: string | null;
  nextScheduledRunAt: string;
  totals: { runs: number; refundUsd: number; toCreditUsd: number; toBalanceUsd: number; lastRefundAt: string | null };
}

/** One refund run for one user (cache_refunds row). */
export interface CacheRefundRow {
  id: string;
  userId: string;
  userName: string | null;
  rows: number;
  excessUsd: number;
  percent: number;
  refundUsd: number;
  toCreditUsd: number;
  toBalanceUsd: number;
  ledgerId: string | null;
  creditEventId: string | null;
  periodFrom: string | null;
  periodTo: string | null;
  note: string | null;
  /** "scheduler" or the admin user id. */
  createdBy: string | null;
  createdAt: string;
}

/** deploy_meta JSON written by the server-side deployer (protocol v2). */
export interface NodeDeployMeta {
  method?: "ssh" | "local";
  host?: string;
  port?: number;
  username?: string;
  name?: string | null;
  status?: "deploying" | "ok" | "failed";
  online?: boolean;
  error?: string;
  deployedAt?: string;
  finishedAt?: string;
  consolePort?: number;
}

export interface NodeRow {
  nodeId: string;
  providerId: string;
  providerName: string | null;
  /** Deployed by an admin: carries platform-owned accounts (no payout). */
  platformNode: boolean;
  nodeVersion: string | null;
  osType: string | null;
  osArch: string | null;
  online: boolean;
  acceptingSessions: boolean;
  inFlight: number;
  capacity: number;
  accountCount: number;
  proxyCount: number;
  deployMeta: NodeDeployMeta | null;
  lastHeartbeatAt: string | null;
  createdAt: string;
}

/** Node monitor row (`GET /api/admin/nodes/monitor`, docs/operations.md §7.2). */
export interface NodeMonitorRow {
  nodeId: string;
  /** Deploy name (deployMeta.name); missing on console builds before 2026-10-23. */
  name?: string | null;
  providerName: string | null;
  platformNode: boolean;
  nodeVersion: string | null;
  online: boolean;
  acceptingSessions: boolean;
  inFlight: number;
  capacity: number;
  lastHeartbeatAt: string | null;
  heartbeatAgeSec: number | null;
  metrics: {
    reportedAt: string;
    inFlight: number;
    acceptingSessions: boolean;
    healthy: boolean;
    host: {
      totalMemMb: number;
      freeMemMb: number;
      load1: number;
      load5: number;
      cpus: number;
      uptimeSec: number;
      processRssMb: number;
      processUptimeSec: number;
      bunVersion: string | null;
      nodeVersion: string;
      bundleHash: string | null;
      draining: boolean;
    } | null;
    egress: { activeSessions: number } | null;
    ccWorker: {
      enabled: boolean;
      claudeVersion: string | null;
      selfTestError?: string | null;
      maxConcurrency: number;
      active: number;
      queued: number;
      pool?: { live: number; idle: number; busy: number; awaitingTools?: number; maxLive: number; rssMb: number; evictions: Record<string, number> };
    } | null;
    proxies: { total: number; live: number; dead: number; unknown: number };
  } | null;
  accounts: { total: number; active: number; onLiveProxy: number; cooling: number };
  proxies: { total: number; live: number };
  traffic: { req1h: number; err1h: number; avgMs1h: number | null; req24h: number; err24h: number; cost24h: number };
}

/** Masked proxy ledger entry (password shown as ***, url null if undecryptable). */
export interface NodeProxy {
  id: string;
  url: string | null;
  label: string | null;
  /** Operator group (provider / batch / purpose); null = ungrouped. */
  group?: string | null;
  /** ISO 3166-1 alpha-2 of the measured exit (node heartbeat), null until measured. */
  country?: string | null;
  status: "live" | "dead" | "unknown" | string;
  lastCheckAt: string | null;
  lastError: string | null;
  assignedAccounts: number;
  boundAccounts?: number;
  reservedAccounts?: number;
  normalSlots?: number;
  overflowSlots?: number;
  /** Organization fields are returned to administrators only. */
  teamId?: string | null;
  teamName?: string | null;
  /** Release cooldown (proxy freed by deleting a rejected account): not assignable to new accounts until then. */
  cooldownUntil: string | null;
  cooldownReason: string | null;
  /** Quarantined proxy/exit (docs/onboarding.md §12.1): not assignable until an admin lifts it. */
  quarantined?: boolean;
  quarantineReason?: string | null;
  createdAt: string;
}

export interface TeamEvent {
  id: string;
  resourceKey: string;
  proxyId: string | null;
  nodeId: string | null;
  teamId: string | null;
  teamName: string | null;
  accountId: string | null;
  jobId: string | null;
  event: string;
  actorId?: string | null;
  reason?: string | null;
  createdAt: string;
}

export interface DeployOutcome {
  nodeId: string;
  online: boolean;
  ok: boolean;
  log: string;
  error?: string;
}

export type AccountType = "apikey" | "upstream" | "oauth";
/** How the gateway serves the account: direct upstream call, cloud session (CCR), or CCR worker (anthropic OAuth only). */
export type AccountExecutor = "direct" | "ccr" | "ccr_worker";

export interface ProviderAccount {
  id: string;
  name: string;
  platform: string;
  type: AccountType;
  executor: AccountExecutor;
  protocol: "anthropic" | "openai";
  baseUrl: string | null;
  models: string[];
  route: "direct" | "node";
  nodeId: string | null;
  reviewStatus: "pending" | "approved" | "rejected";
  reviewNote: string | null;
  status: "active" | "disabled" | "error";
  errorMessage: string | null;
  payoutRate: number;
  accountEmail: string | null;
  subscriptionType: string | null;
  coolingUntil: string | null;
  lastUsedAt: string | null;
  createdAt: string;
  requests30d: number;
  earning30d: number;
  /** New onboarding fields (docs/onboarding.md §5); the provider shape may omit them. */
  concurrency?: number;
  rpmLimit?: number;
  boundProxyId?: string | null;
  windowUsed?: number | null;
  windowResetAt?: string | null;
  windowExhaustedUntil?: string | null;
}

export interface AdminAccount extends ProviderAccount {
  /** Omitted entirely for non-administrator roles, including ops. */
  teamId?: string | null;
  teamName?: string | null;
  ownerId: string | null;
  ownerName: string | null;
  priority: number;
  concurrency: number;
  rpmLimit: number;
  /** Relay accounts: the client's request is forwarded verbatim (no Claude Code normalisation / fingerprint / identity pinning). */
  rawPassthrough?: boolean;
  boundProxyId: string | null;
  modelMapping: Record<string, string>;
  groups: Array<{ groupId: string; name: string; priority: number }>;
  rateLimitedUntil: string | null;
  overloadUntil: string | null;
  /** Admin view: scheduler verdict + first failing gate (apps/console/src/pool-state.ts). */
  poolState?: "online" | "cooling" | "error" | "offline" | "unmanaged" | "unavailable" | "busy";
  poolReason?: string | null;
  /** Country of the bound proxy's measured exit (alpha-2). */
  boundProxyCountry?: string | null;
  tempUnschedulableUntil: string | null;
  /** CCR subscription window (null until the first probe). 0..1. */
  windowUsed: number | null;
  windowResetAt: string | null;
  windowCheckedAt: string | null;
  /** Window-level cooldown (distinct from coolingUntil, which only covers error cooldowns). */
  windowExhaustedUntil: string | null;
  window5hUsed: number | null;
  window5hResetAt: string | null;
  window7dUsed: number | null;
  window7dResetAt: string | null;
  /** Why the window cooldown / rate limit was set (passive sampling or probe). */
  windowReason: string | null;
  /** Per-model-family cooldowns, e.g. { fable: { until, reason, used, resetAt } }. */
  modelCooldowns: Record<string, { until?: string | null; reason?: string | null; used?: number | null; resetAt?: string | null }>;
  cost30d: number;
  /** Usage over 5h / 7d / 30d / lifetime (successful requests, consumer-paid cost, total tokens). */
  usage: AccountUsage;
  /** Live in-flight requests on the gateway; null when the gateway could not be asked. */
  inFlight: number | null;
}

export interface UsageBucket {
  requests: number;
  costUsd: number;
  tokens: number;
}
export interface AccountUsage {
  h5: UsageBucket;
  d7: UsageBucket;
  d30: UsageBucket;
  all: UsageBucket;
  rpm: number;
  errors24h: number;
}

export type AccountKind = "api" | "subscription";
export interface AdminAccountList extends Paged<AdminAccount> {
  counts: { api: number; subscription: number; pending: number };
}
export interface AdminAccountQuery {
  kind?: AccountKind;
  page?: number;
  pageSize?: number;
  q?: string;
  platform?: string;
  status?: string;
  reviewStatus?: string;
  ownerId?: string;
  nodeId?: string;
  sort?: "createdAt" | "lastUsedAt" | "name" | "priority";
  order?: "asc" | "desc";
}
export const adminAccounts = (q: AdminAccountQuery) =>
  api.get<AdminAccountList>("/api/admin/accounts", Object.fromEntries(Object.entries(q).filter(([, v]) => v !== undefined && v !== "")));

/** Probe a CCR account's subscription window now; returns the refreshed account. */
export const adminAccountWindow = (id: string) => api.post<AdminAccount>(`/api/admin/accounts/${id}/window`);

// ---------- onboarding (docs/onboarding.md §4) ----------

/** Scope of the onboard endpoints: /api/admin/... or /api/provider/... (same shapes). */
export type OnboardScope = "admin" | "provider";

/** Credential-free proxy picker view: GET .../nodes/:id/proxies (?free=1 for live+unbound only). */
export interface ProxyPickerItem {
  id: string;
  label: string | null;
  group?: string | null;
  country?: string | null;
  host: string | null;
  port: number | null;
  status: "live" | "dead" | "unknown" | string;
  bound: boolean;
  boundAccounts?: number;
  reservedAccounts?: number;
  normalSlots?: number;
  overflowSlots?: number;
  quarantined?: boolean;
  quarantineReason?: string | null;
}

export type OnboardJobStatus = "pending_callback" | "working" | "done" | "failed";

export interface OnboardJob {
  method?: "auth_url" | "session_key";
  nodeId?: string;
  expiresAt?: string;
  jobId: string;
  status: OnboardJobStatus;
  accountId?: string;
  accountName?: string;
  accountEmail?: string;
  /** The job re-authorized an account that already existed: credentials updated, nothing new added. */
  reused?: boolean;
  /** New-account cooldown (settings onboard_cooldown_*): the account joins scheduling only after this time. */
  cooldownUntil?: string;
  error?: string;
  authorizeUrl?: string;
}

export interface OnboardParams {
  nodeId: string;
  proxyId?: string; // "auto" or omitted = platform picks a free live proxy
  concurrencyLimit?: number;
  rpmLimit?: number;
  name?: string;
  note?: string;
  groupId?: string; // admin only
}

export const onboardStart = (scope: OnboardScope, body: Record<string, unknown>) =>
  api.post<OnboardJob>(`/api/${scope}/accounts/onboard`, body);

/** Re-authorize an existing subscription account in place (docs/onboarding.md §11); same job shape as onboarding. */
export const adminAccountReauth = (accountId: string, body: Record<string, unknown>) =>
  api.post<OnboardJob>(`/api/admin/accounts/${accountId}/reauth`, body);

export const onboardJob = (scope: OnboardScope, jobId: string) =>
  api.get<OnboardJob>(`/api/${scope}/accounts/onboard/${jobId}`);

export const onboardCancel = (scope: OnboardScope, jobId: string) =>
  api.post<OnboardJob>(`/api/${scope}/accounts/onboard/${jobId}/cancel`, {});

/** Saved organizations for the onboarding form (admin only, docs/onboarding.md §3 常用组织). */
/** A route an organization may be onboarded through: a node and (optionally) one of its proxy groups. */
export interface OrgRouteView {
  nodeId: string;
  group: string | null;
  nodeName: string | null;
  nodeOnline: boolean;
  nodeExists: boolean;
  capacity: number;
  used: number;
  assignable: number;
  groupExists: boolean;
}
/** Organization profile (docs/onboarding.md §10.1): saved UUID + allowed email domains + node / group routes. */
export interface OnboardOrg {
  id: string;
  orgUuid: string;
  name: string;
  note: string | null;
  status: "active" | "disabled" | string;
  domains: string[];
  routes: OrgRouteView[];
  accounts: number;
  createdAt: string;
  updatedAt: string;
}
export interface OnboardOrgInput {
  name?: string;
  orgUuid?: string;
  note?: string | null;
  domains?: string[];
  routes?: Array<{ nodeId: string; group?: string | null }>;
  status?: "active" | "disabled";
}
export const onboardOrgs = () => api.get<OnboardOrg[]>("/api/admin/onboard/orgs");
export const onboardOrgCreate = (body: OnboardOrgInput & { name: string; orgUuid: string }) =>
  api.post<OnboardOrg>("/api/admin/onboard/orgs", body);
export const onboardOrgUpdate = (id: string, body: OnboardOrgInput) =>
  api.patch<OnboardOrg>(`/api/admin/onboard/orgs/${id}`, body);
export const onboardOrgDelete = (id: string) => api.del(`/api/admin/onboard/orgs/${id}`);

/** Proxy groups (docs/onboarding.md §4.2): per-group tallies of a node's pool; null group = ungrouped rows. */
export interface ProxyGroupSummary {
  group: string | null;
  total: number;
  live: number;
  dead: number;
  bound: number;
  assignable: number;
}
export const nodeProxyGroups = (scope: OnboardScope, nodeId: string) =>
  api.get<ProxyGroupSummary[]>(`/api/${scope}/nodes/${encodeURIComponent(nodeId)}/proxy-groups`);
export const nodeProxiesRegroup = (nodeId: string, proxyIds: string[], group: string | null) =>
  api.post<{ changed: number; group: string | null; groups: ProxyGroupSummary[] }>(`/api/admin/nodes/${encodeURIComponent(nodeId)}/proxies/group`, { proxyIds, group });
export const nodeProxiesRemove = (nodeId: string, proxyIds: string[]) =>
  api.post<{ removed: string[]; bound: string[]; reserved: string[]; notFound: string[]; pushed: boolean; remaining: number }>(`/api/admin/nodes/${encodeURIComponent(nodeId)}/proxies/remove`, { proxyIds });

/** Lift a proxy quarantine (admin): the node re-verifies the exit on its next heartbeat. */
export const nodeProxyUnquarantine = (nodeId: string, proxyId: string) =>
  api.post<{ ok: boolean; pushed: boolean }>(`/api/admin/nodes/${encodeURIComponent(nodeId)}/proxies/${encodeURIComponent(proxyId)}/unquarantine`, {});

/** Pre-flight for pasted sessionKeys: shape + duplicate detection, no upstream call (docs/onboarding.md §4). */
export interface OnboardPrecheckItem {
  index: number;
  formatOk: boolean;
  accountUuid: string | null;
  existing: { id: string; email: string | null; status: string; teamId: string | null } | null;
}
export const onboardPrecheck = (scope: OnboardScope, sessionKeys: string[]) =>
  api.post<OnboardPrecheckItem[]>(`/api/${scope}/accounts/onboard/precheck`, { sessionKeys });

/**
 * Operator-supplied proxy for one onboarding (docs/onboarding.md §4.1): any common shape is
 * parsed into a socks5 URL; a proxy already in a pool is reused (that pool's node comes back in
 * `nodeId`), otherwise it is appended to the node's pool and probed. Call again to poll `blocked`.
 */
export interface OnboardSuppliedProxy {
  proxyId: string | null;
  nodeId: string | null;
  parsed: { scheme: string; host: string; port: number; username: string | null; display: string };
  existed: boolean;
  added: boolean;
  pushed: boolean;
  status: string | null;
  lastError: string | null;
  exitIp: string | null;
  country: string | null;
  quarantined: boolean;
  quarantineReason: string | null;
  boundAccounts: number;
  reservedAccounts: number;
  /** Existing but unused and stuck: treated as new (dry run: on submit; real call: done, re-verifying). */
  reset: boolean;
  blocked: "legacy" | "dead" | "unprobed" | "exit_unverified" | "cooldown" | "quarantined" | "other_organization" | "needs_virgin_exit" | "reserved_by_other" | "full" | "not_in_pool" | null;
}
export const onboardSupplyProxy = (scope: OnboardScope, body: { nodeId: string; proxy: string; orgUuid?: string; dryRun?: boolean }) =>
  api.post<OnboardSuppliedProxy>(`/api/${scope}/accounts/onboard/proxy`, body);

export const nodeProxies = (scope: OnboardScope, nodeId: string, freeOnly = false) =>
  api.get<ProxyPickerItem[]>(`/api/${scope}/nodes/${nodeId}/proxies`, freeOnly ? { free: 1 } : undefined);

export interface AdminUser {
  id: string;
  role: "admin" | "consumer" | "provider" | "ops";
  name: string;
  loginKeyPreview: string;
  status: "active" | "disabled";
  /** Prepaid balance (consumers) / unsettled earnings (providers). */
  balanceUsd: number;
  /** Credit line (consumers): limit, outstanding usage, available = limit − used + balance. */
  creditLimitUsd: number;
  creditUsedUsd: number;
  availableUsd: number;
  creditSettledAt: string | null;
  note: string | null;
  keyCount: number;
  requests30d: number;
  ccSuspect30d: number;
  cost30d: number;
  /** Time of the user's latest request (any status); null = never called the API. */
  lastRequestAt?: string | null;
  lastLoginAt: string | null;
  createdAt: string;
  allowedGroupIds: string[];
  /** Provider role: the group its self-onboarded accounts join at once; null = default group. */
  onboardGroupId?: string | null;
}

export interface ModelPrices {
  inputPerM: number;
  outputPerM: number;
  cacheReadPerM: number;
  cacheWritePerM: number;
}

export interface AdminModel {
  modelId: string;
  displayName: string;
  platform: string;
  source: "catalog" | "custom";
  enabled: boolean;
  overridden: boolean;
  prices: ModelPrices;
  catalogPrices: ModelPrices | null;
}

export interface RedeemCode {
  code: string;
  valueUsd: number;
  status: "unused" | "used" | "disabled";
  batch: string | null;
  usedBy: string | null;
  usedByName: string | null;
  usedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
}

export interface Settings {
  default_group_id: string;
  provider_default_payout_rate: string;
  announcement: string;
  api_base_url: string;
  max_keys_per_user: string;
  anthropic_window_threshold_percent: string;
  window_poll_interval_sec: string;
  sticky_session_ttl_sec: string;
  device_affinity_pool_size: string;
  device_affinity_ttl_sec: string;
  cc_shape_policy: "observe" | "downgrade" | "reject";
  onboard_default_executor: "ccr" | "ccr_worker";
  onboard_default_concurrency: string;
  onboard_default_rpm_limit: string;
  onboard_cooldown_min_sec: string;
  onboard_cooldown_max_sec: string;
  proxy_release_cooldown_sec: string;
  direct_cc_entrypoint_normalize: string;
  direct_cc_version_pin: string;
  ccr_cache_baseline_worker: string;
  ccr_cache_write_as_input: string;
  window_passive_max_age_sec: string;
  ccr_cache_baseline_cloud: string;
  cache_refund_enabled: string;
  cache_refund_percent: string;
  cache_refund_interval_sec: string;
}

/** Platforms (mirror of packages/core/src/platforms.ts). */
export const PLATFORMS: Array<{ id: string; label: string; protocol: "anthropic" | "openai"; baseUrl: string | null }> = [
  { id: "anthropic", label: "Anthropic", protocol: "anthropic", baseUrl: "https://api.anthropic.com" },
  { id: "openai", label: "OpenAI", protocol: "openai", baseUrl: "https://api.openai.com/v1" },
  { id: "google", label: "Google Gemini", protocol: "openai", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai" },
  { id: "moonshot", label: "Moonshot (Kimi)", protocol: "openai", baseUrl: "https://api.moonshot.cn/v1" },
  { id: "zhipu", label: "Zhipu GLM", protocol: "openai", baseUrl: "https://open.bigmodel.cn/api/paas/v4" },
  { id: "xai", label: "xAI Grok", protocol: "openai", baseUrl: "https://api.x.ai/v1" },
  { id: "volcengine", label: "Volcengine Ark", protocol: "openai", baseUrl: "https://ark.cn-beijing.volces.com/api/v3" },
  { id: "minimax", label: "MiniMax", protocol: "openai", baseUrl: "https://api.minimax.chat/v1" },
  { id: "qwen", label: "Qwen (DashScope)", protocol: "openai", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1" },
  { id: "deepseek", label: "DeepSeek", protocol: "openai", baseUrl: "https://api.deepseek.com/v1" },
  { id: "xiaomi", label: "Xiaomi MiMo", protocol: "openai", baseUrl: null },
  { id: "opencode", label: "OpenCode", protocol: "openai", baseUrl: null },
  { id: "custom", label: "Custom", protocol: "openai", baseUrl: null },
];

export function platformLabel(id: string): string {
  return PLATFORMS.find((p) => p.id === id)?.label ?? id;
}
