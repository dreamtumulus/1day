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
  /** Routing policy (admin-only edit): history handling on upstream switch + direct-only. */
  policy?: KeyPolicyFields;
  /** Two layers (spec §6.2): judge's `auto` + administrator `override`; `policy` is the effective merge. */
  policyLayers?: { auto: Partial<KeyPolicyFields> & { decidedAt?: string; basis?: string }; override: Partial<KeyPolicyFields> & { by?: string; reason?: string; at?: string } };
}

export interface KeyPolicyFields {
  historyPolicy: "reset" | "reject" | "passthrough";
  directOnly: boolean;
  probeIntercept?: boolean;
  teamAffinity?: "spread" | "pack" | null;
  workerMode?: "legacy" | "canonical";
  telemetryPolicy?: "native-required" | "passthrough-isolated";
  parameterPolicy?: "warn" | "strict";
  responseMode?: "keepalive" | "strict";
  allowedCustomEntrypoints?: string[];
}

export interface UsageRow {
  id: string;
  requestId: string;
  createdAt: string;
  keyName: string | null;
  model: string;
  upstreamModel: string | null;
  actualModel?: string | null;
  endpoint: string;
  stream: boolean;
  statusCode: number;
  errorCode: string | null;
  errorScope?: "request" | "account_model" | "account" | "node_proxy" | "transport" | null;
  retryable?: boolean | null;
  credentialVersion?: number | null;
  executionSequence?: number | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  /** Total cache creation; the 5m / 1h fields are its split by cache TTL (both 0 on rows from before the split). */
  cacheWriteTokens: number;
  cacheWrite5mTokens?: number;
  cacheWrite1hTokens?: number;
  /** Per-meter lines: tokens, list unit price (USD / 1M) and the billed amount after the group multiplier. null = not charged. */
  costBreakdown?: UsageCostBreakdown | null;
  usageEstimated: boolean;
  rateMultiplier: number;
  actualCost: number;
  durationMs: number | null;
  firstTokenMs: number | null;
  selectionMs?: number | null;
  streamTruncated?: boolean;
  toolCalls?: number;
  toolResults?: number;
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
  /** Provenance of the serving account (migration 30): organization / IP group / exit country. */
  teamId?: string | null;
  teamName?: string | null;
  orgName?: string | null;
  proxyId?: string | null;
  proxyGroup?: string | null;
  proxyCountry?: string | null;
  totalCost?: number;
  providerEarning?: number;
}

export type UsageCostMeter = "input" | "output" | "cache_read" | "cache_write_5m" | "cache_write_1h" | "cache_write";
export interface UsageCostBreakdown {
  /** settlement = the tariff the row was charged with; current = today's price (rows older than the snapshots). */
  priceSource: "settlement" | "current";
  lines: Array<{ meter: UsageCostMeter; tokens: number; pricePerM: number; costUsd: number }>;
}

export interface UsageStats {
  totals: { requests: number; costUsd: number; inputTokens: number; outputTokens: number; cacheTokens: number; cacheReadTokens: number; cacheWriteTokens: number; cacheWrite5mTokens?: number; cacheWrite1hTokens?: number };
  daily: Array<{
    day: string;
    requests: number;
    costUsd: number;
    tokens: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    cacheWrite5mTokens?: number;
    cacheWrite1hTokens?: number;
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
  accounts: { total: number; active: number; onLiveProxy: number; cooling: number; proxyDown?: number; proxyDownOldestSince?: string | null };
  proxies: { total: number; live: number };
  traffic: { req1h: number; err1h: number; avgMs1h: number | null; req24h: number; err24h: number; cost24h: number };
}

/** An account bound to a proxy, on any node (reminder annotation; organization fields for administrators only). */
export interface ProxyCarrier {
  accountId: string;
  accountName: string | null;
  status: string;
  nodeId: string | null;
  nodeName: string | null;
  teamId?: string | null;
  teamName?: string | null;
}
/** Cross-node sharing annotation (2026-11-08): where the row lives and which other nodes also hold it. */
export interface ProxyShareInfo {
  homeNodeId?: string;
  homeNodeName?: string | null;
  /** true: this row lives in another node's pool and is shared into the node being viewed. */
  shared?: boolean;
  sharedWith?: Array<{ nodeId: string; name: string | null }>;
  carriers?: ProxyCarrier[];
}

/** Masked proxy ledger entry (password shown as ***, url null if undecryptable). */
export interface NodeProxy extends ProxyShareInfo {
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
  /** proxy_down (2026-11-01): frozen because the bound proxy failed; only an operator release / rebind re-enables it. */
  status: "active" | "disabled" | "error" | "proxy_down";
  errorMessage: string | null;
  payoutRate: number;
  accountEmail: string | null;
  subscriptionType: string | null;
  /** 2026-11-02: full plan identity from /api/oauth/profile; tier separates Ultra (ex Max 20x) from Max (ex Max 5x). */
  rateLimitTier?: string | null;
  planLabel?: string | null;
  orgType?: string | null;
  billingType?: string | null;
  seatTier?: string | null;
  subscriptionStatus?: string | null;
  /** Which usage windows apply (verified Ultra: five_hour=false); null = not observed yet. */
  windowModel?: { five_hour: boolean | null; seven_day: boolean | null; fable: boolean | null; source: string | null; observed_at: string | null; streak: number } | null;
  usageCheckedAt?: string | null;
  /** Usage credits as of the last usage poll (docs/usage-credits.md); the enabled shape is inferred, see the doc. */
  usageCredits?: UsageCreditsInfo | null;
  /** Requests beyond the plan quota are currently scheduled onto this account and paid from its credits. */
  onCredits?: boolean;
  /** "window" (5h / weekly, all models) and / or "fable" (Fable weekly share). */
  onCreditsScopes?: string[];
  creditsLive?: boolean;
  /** The upstream refused the account at a plan limit after the last usage poll: credits distrusted until the next poll. */
  creditsRejectedAt?: string | null;
  /** Secret-free raw profile / usage bodies (admin only). */
  profile?: unknown;
  usageSnapshot?: unknown;
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

export interface CreditAmount {
  amountMinor: number;
  currency: string;
  exponent: number;
}

export interface UsageCreditsInfo {
  known: boolean;
  enabled: boolean;
  everEnabled: boolean;
  canToggle: boolean;
  canPurchase: boolean;
  balance: CreditAmount | null;
  monthlyCap: CreditAmount | null;
  used: CreditAmount | null;
  spendLimitReached: boolean;
  autoReload: boolean | null;
  disabledReason: string | null;
  promo: CreditAmount | null;
  /** Fable weekly share: used percent of the allowance itself, and the allowance as a percent of the weekly limit. */
  fableShare: { usedPercent: number | null; allowancePercentOfWeekly: number | null; resetsAt: string | null; active: boolean } | null;
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
  credentialVersion?: number;
  readiness?: "logged_in" | "refreshed" | "profile_valid" | "inference_valid" | "rate_limited" | "reauth_required";
  lastProfileAt?: string | null;
  lastRefreshAt?: string | null;
  lastInferenceAt?: string | null;
  rateLimitedUntil: string | null;
  overloadUntil: string | null;
  /** status proxy_down: frozen since / why / which proxy (null otherwise). */
  proxyDownSince?: string | null;
  proxyDownReason?: string | null;
  proxyDownProxyId?: string | null;
  /** Admin view: scheduler verdict + first failing gate (apps/console/src/pool-state.ts). */
  poolState?: "online" | "cooling" | "error" | "offline" | "unmanaged" | "unavailable" | "busy";
  poolReason?: string | null;
  /** Country of the bound proxy's measured exit (alpha-2). */
  boundProxyCountry?: string | null;
  /** IP group and measured exit of the bound proxy; saved organization profile name for the team (admin lists). */
  boundProxyGroup?: string | null;
  boundProxyExitIp?: string | null;
  orgName?: string | null;
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
  counts: { api: number; subscription: number; pending: number; count?: number; oldestSince?: string | null };
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
  /** admin only: organization (upstream team) filter */
  teamId?: string;
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
export interface ProxyPickerItem extends ProxyShareInfo {
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
export const nodeProxyGroupRename = (nodeId: string, from: string, to: string) =>
  api.post<{ changed: number; routesUpdated: number; groups: ProxyGroupSummary[] }>(`/api/admin/nodes/${encodeURIComponent(nodeId)}/proxy-groups/rename`, { from, to });
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
export interface OnboardSuppliedProxy extends ProxyShareInfo {
  proxyId: string | null;
  /** The requested node (since 2026-11-08 a proxy known elsewhere is shared into it instead of switching nodes). */
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
  /** Admission overrides; null = gateway defaults (USER_MAX_INFLIGHT / USER_MAX_INFLIGHT_USD). */
  maxInflight?: number | null;
  maxInflightUsd?: number | null;
}

export interface ModelPrices {
  inputPerM: number;
  outputPerM: number;
  cacheReadPerM: number;
  /** 1-hour cache write price. */
  cacheWritePerM: number;
  /** 5-minute cache write price (effective: an override without its own value = cacheWritePerM x 0.625). */
  cacheWrite5mPerM: number;
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
  /** false: the override has no 5-minute price of its own (derived from the 1-hour price). */
  cacheWrite5mExplicit?: boolean;
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
  _revision?: number;
  proxy_exit_max_accounts?: string;
  team_claim_release_min_days?: string;
  /** 铁律 2 (docs/iron-rules.md): canary group + three-state switches ("0" | "canary" | "1") for upstream-visible behaviour. */
  canary_group_id?: string;
  direct_strip_user_email?: string;
  direct_cc_canonical_fields?: string;
  worker_prompt_hide_platform_path?: string;
  direct_profile_strict?: string;
  cc_client_response_profile?: string;
  key_policy_auto?: string;
  worker_canonical?: string;
  telemetry_evidence_required?: string;
  canonical_history_import?: string;
  raw_preserve_headers?: string;
  telemetry_health_days?: string;
  history_policy_default?: string;
  history_policy_canary?: string;
  /** off | fable_only | all — may the scheduler rely on the owners' usage credits (docs/usage-credits.md). */
  usage_credits_policy?: string;
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
  ccr_overhead_calibration: "on" | "off";
  ccr_overhead_pins: string;
  cache_refund_enabled: string;
  cache_refund_percent: string;
  cache_refund_interval_sec: string;
}

/** GET /api/admin/ccr-overhead (X-54): platform prompt overhead per lane / tools / model / Claude Code version. */
export interface CcrOverheadKey {
  key: string;
  lane: string | null;
  tools: string | null;
  model: string | null;
  version: string | null;
  /** p10 of the window; null while it holds fewer than minSamples. */
  learned: number | null;
  samples: number;
  n: number;
  min: number | null;
  max: number | null;
  updatedAt: string | null;
  /** The value in force for this key and where it comes from. */
  value: number | null;
  source: "pinned" | "learned" | "learned_version" | "learned_lane" | "inherited" | "default" | "baseline" | null;
  matched: string | null;
}
export interface CcrOverhead {
  calibration: "on" | "off";
  window: number;
  minSamples: number;
  baseline: { worker: number; cloud: number };
  pins: Array<{ spec: string; lane: string; tools: string | null; model: string | null; value: number }>;
  pinErrors: string[];
  defaults: Array<{ lane: string; tools: string; model: string | null; value: number }>;
  keys: CcrOverheadKey[];
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

// ---------- organizations (upstream teams) as an operations object (2026-11-01, docs/team-isolation.md) ----------

export interface TeamOverviewRow {
  id: string; name: string | null; status: string; createdAt: string;
  accounts: { total: number; active: number; proxyDown: number; error: number; disabled: number; cooling: number; concurrency: number };
  inFlight: number | null;
  windowUsedAvg: number | null;
  exits: { claimed: number; bound: number; releasable: number };
  usage24h: { requests: number; failed: number; costUsd: number };
  lastUsedAt: string | null;
}
export interface TeamClaim {
  resourceKey: string; exitIp: string | null; claimedAt: string;
  proxies: Array<{ id: string; nodeId: string; status: string }>;
  boundAccounts: number; reserved: number; lastActivityAt: string | null;
  releasable: boolean; blocker: "bound_accounts" | "live_reservation" | "too_recent" | null;
}
// The two reads carry `minReleaseDays` next to `data`, so they must not go through `call()` (which unwraps
// the envelope and would drop the sibling field — this was the /console/admin/teams white screen, 2026-11-02).
export const adminTeamsOverview = () => apiFetch<{ data: TeamOverviewRow[]; minReleaseDays: number }>("/api/admin/teams/overview");
export const adminTeamClaims = (id: string) => apiFetch<{ data: TeamClaim[]; minReleaseDays: number }>(`/api/admin/teams/${id}/claims`);
// Mutations go through `call()`, i.e. the `{ data }` envelope is already unwrapped here.
export const adminTeamReleaseClaims = (id: string, body: { resourceKeys?: string[]; reason?: string; force?: boolean }) =>
  api.post<{ released: string[]; skipped: Array<{ resourceKey: string; blocker: string }>; nodeIds: string[] }>(`/api/admin/teams/${id}/release-claims`, body);
export const adminTeamPatch = (id: string, body: { status?: "active" | "disabled"; name?: string }) => api.patch<{ id: string; name: string | null; status: string }>(`/api/admin/teams/${id}`, body);
export const adminTeamCleanupNodes = (id: string) => api.post<{ nodes: string[] }>(`/api/admin/teams/${id}/cleanup-nodes`, {});
