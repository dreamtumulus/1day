import { createHash } from "node:crypto";
import { matchesAny } from "./allowlist.js";
import { decryptJson, encryptJson } from "./crypto.js";
import { all, one, run } from "./db.js";
import { getModelEntry } from "./models.js";
import { effectiveBaseUrl, type Executor, type Protocol } from "./platforms.js";
import { getSetting } from "./settings.js";
import { isoIn, nowIso } from "./time.js";
import { modelScope, parseRateLimitEvent, parseThresholdPercent, windowAllows, windowExhausted, windowReason, type WindowSnapshot } from "./window.js";
import { normalizeTeamId, quarantineActive, recordProxyTeamEvent } from "./teams.js";

export interface ModelCooldown {
  until?: string | null;
  reason?: string | null;
  used?: number | null;
  resetAt?: string | null;
}

export function parseModelCooldowns(raw: string | null | undefined): Record<string, ModelCooldown> {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, ModelCooldown>) : {};
  } catch {
    return {};
  }
}

/** True when the account's cooldown for the model's family scope is still running. */
export function modelScopeCooling(a: Pick<AccountRow, "model_cooldowns">, model: string, now: string): boolean {
  const all = parseModelCooldowns(a.model_cooldowns);
  // Exact-model suspension (403 "is suspended for this organization until …", key `model:<id>`).
  const exact = all[`model:${model}`]?.until;
  if (exact && exact > now) return true;
  const scope = modelScope(model);
  if (!scope) return false;
  const until = all[scope]?.until;
  return !!until && until > now;
}

/**
 * How many schedulable accounts of a group are sitting out `model` because of an
 * organization-level suspension (403 "suspended for this organization"), and when the
 * earliest of them comes back — so a 503 can say *why* instead of "no account".
 */
export function modelSuspensionSummary(groupId: string, model: string): { accounts: number; liftsAt: string | null } {
  const now = nowIso();
  const rows = all<{ model_cooldowns: string | null }>(
    `SELECT a.model_cooldowns FROM account_groups ag JOIN accounts a ON a.id = ag.account_id
     WHERE ag.group_id = ? AND a.status = 'active' AND a.review_status = 'approved' AND a.model_cooldowns LIKE ?`,
    groupId,
    `%"model:${model}"%`,
  );
  let accounts = 0;
  let liftsAt: string | null = null;
  for (const r of rows) {
    const until = parseModelCooldowns(r.model_cooldowns)[`model:${model}`]?.until;
    if (!until || until <= now) continue;
    accounts++;
    if (!liftsAt || until < liftsAt) liftsAt = until;
  }
  return { accounts, liftsAt };
}

function writeModelCooldown(id: string, scope: string, patch: ModelCooldown, now: string): void {
  const row = one<{ model_cooldowns: string | null }>("SELECT model_cooldowns FROM accounts WHERE id = ?", id);
  const all = parseModelCooldowns(row?.model_cooldowns);
  all[scope] = { ...(all[scope] ?? {}), ...patch };
  run("UPDATE accounts SET model_cooldowns = ?, updated_at = ? WHERE id = ?", JSON.stringify(all), now, id);
}

// Upstream accounts (docs/v3-design.md §5, §7.2, §7.3).

export interface AccountRow {
  id: string;
  /** Verified upstream organization. NULL legacy accounts are never inferred. */
  team_id: string | null;
  name: string;
  platform: string;
  type: "apikey" | "upstream" | "oauth";
  protocol: Protocol;
  base_url: string | null;
  credential_enc: string;
  credential_version: number;
  models: string | null;
  model_mapping: string | null;
  owner_id: string | null;
  route: "direct" | "node";
  node_id: string | null;
  review_status: string;
  review_note: string | null;
  payout_rate: number;
  priority: number;
  concurrency: number;
  status: string;
  error_message: string | null;
  rate_limited_until: string | null;
  overload_until: string | null;
  temp_unschedulable_until: string | null;
  /** Token-endpoint 429 back-off (migration 31): no refresh attempt before this; a 401 meanwhile is not a death. */
  refresh_cooldown_until: string | null;
  account_email: string | null;
  subscription_type: string | null;
  last_used_at: string | null;
  last_profile_at: string | null;
  last_refresh_at: string | null;
  last_inference_at: string | null;
  /**
   * status 'proxy_down' (migration 33, operator rule 2026-11-01): the bound proxy failed (dead verdict, exit IP
   * changed / conflicted, node refused the pin) and the account is frozen until an operator releases or rebinds it.
   */
  proxy_down_since: string | null;
  proxy_down_reason: string | null;
  proxy_down_proxy_id: string | null;
  /** direct = platform/node sends Messages requests; ccr = cloud session orchestration (docs/ccr-supply.md). */
  executor: Executor;
  /** Subscription window state (CCR only, written by the console poller). 0..1, NULL = never probed. */
  window_used: number | null;
  window_reset_at: string | null;
  window_checked_at: string | null;
  /** Window-level cooldown (distinct from error cooldowns). */
  window_exhausted_until: string | null;
  window_5h_used: number | null;
  window_5h_reset_at: string | null;
  window_7d_used: number | null;
  window_7d_reset_at: string | null;
  /** Why the window cooldown was set, e.g. "five_hour 97% ≥ 95% until …". */
  window_reason: string | null;
  /**
   * Account attributes from `GET /api/oauth/profile` (migration 38, 2026-11-02): the tier string is the only field that
   * separates Ultra (ex Max 20x) from Max (ex Max 5x); the secret-free full body is kept for the console.
   */
  rate_limit_tier: string | null;
  plan_label: string | null;
  org_type: string | null;
  billing_type: string | null;
  seat_tier: string | null;
  subscription_status: string | null;
  profile_json: string | null;
  /** Last `GET /api/oauth/usage` body (secret-free) and when; the per-window numbers above are derived from it. */
  usage_json: string | null;
  usage_checked_at: string | null;
  /**
   * Which windows this account is actually subject to, as the sources reported them (JSON `WindowModel`): a verified
   * Ultra account has no five-hour window (2026-10-30), so it must not be paused or "rested" on a 5h schedule.
   */
  window_model: string | null;
  /** Per-account requests-per-minute cap, 0 = unlimited (docs/onboarding.md §6.3). */
  rpm_limit: number;
  /** 1 = raw passthrough (gateway.md §4a): no Claude Code normalisation, fingerprint or identity pinning; the client's request goes to the relay as-is. */
  raw_passthrough: number;
  /** Lifetime-bound node proxy; NULL = no binding (docs/onboarding.md §1). */
  bound_proxy_id: string | null;
  /** Per-model-family cooldowns, JSON {scope: {until, reason, used, resetAt}} (docs/gateway.md §3; migration 8). */
  model_cooldowns: string | null;
  /**
   * The account's one device identity (Claude Code `userID`, 64 hex): the worker
   * node's .claude.json is the source of truth (reported via heartbeat
   * ccIdentities); until it reports, a deterministic value is generated here and
   * seeded into the node config on first use (docs/claude-code-compat.md §8).
   */
  device_id: string | null;
  /** The upstream OAuth account uuid (.claude.json oauthAccount.accountUuid), when the node has seen it. */
  account_uuid: string | null;
  created_at: string;
  updated_at: string;
}

export function accountTeamId(a: { team_id?: string | null }): string | null {
  return normalizeTeamId(a.team_id);
}

export interface Credential {
  apiKey?: string;
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: string; // ISO
  accountId?: string; // ChatGPT account id (openai oauth)
  // CCR (docs/ccr-supply.md §2–§3): organization UUID + provisioned environment id.
  orgUuid?: string;
  environmentId?: string;
}

export function readCredential(a: Pick<AccountRow, "credential_enc">): Credential {
  return decryptJson<Credential>(a.credential_enc);
}

export function writeCredential(accountId: string, cred: Credential): void {
  run("UPDATE accounts SET credential_enc = ?, updated_at = ? WHERE id = ?", encryptJson(cred), nowIso(), accountId);
}

export function parseJsonArray(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function parseJsonMap(raw: string | null): Record<string, string> {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    if (!v || typeof v !== "object" || Array.isArray(v)) return {};
    const out: Record<string, string> = {};
    for (const [k, val] of Object.entries(v)) if (typeof val === "string") out[k] = val;
    return out;
  } catch {
    return {};
  }
}

/** §5.3: explicit model patterns win; otherwise the model's platform must match. */
export function supportsModel(a: Pick<AccountRow, "models" | "platform" | "raw_passthrough">, model: string): boolean {
  const patterns = parseJsonArray(a.models);
  if (patterns.length > 0) return matchesAny(patterns, model);
  // Raw passthrough relay (gateway.md §4a): no model list means "whatever the client asks for" —
  // the relay judges the model, not our catalog.
  if (a.raw_passthrough === 1) return true;
  return getModelEntry(model)?.platform === a.platform;
}

/**
 * A group whose every schedulable account is a raw-passthrough relay (gateway.md §4a, user rule
 * 2026-10-26): the gateway makes no judgement at all for its requests — no admission checks, no
 * Claude Code shape classification, no model mapping, no cooldown/failover on upstream errors.
 * A group mixing relay and normal accounts keeps the normal path.
 */
export function groupIsRawPassthrough(groupId: string): boolean {
  const r = one<{ n: number; raw: number | null }>(
    `SELECT COUNT(*) AS n, SUM(a.raw_passthrough = 1) AS raw
     FROM account_groups ag JOIN accounts a ON a.id = ag.account_id
     WHERE ag.group_id = ? AND a.status = 'active' AND a.review_status = 'approved'`,
    groupId,
  );
  return !!r && r.n > 0 && (r.raw ?? 0) === r.n;
}

export function upstreamModelFor(a: Pick<AccountRow, "model_mapping">, model: string): string {
  return parseJsonMap(a.model_mapping)[model] ?? model;
}

export function accountBaseUrl(a: Pick<AccountRow, "platform" | "type" | "base_url">): string | null {
  return effectiveBaseUrl(a);
}

/** Latest of the cooldown windows still in the future, or null. */
export function coolingUntil(
  a: Pick<AccountRow, "rate_limited_until" | "overload_until" | "temp_unschedulable_until">,
  now = nowIso(),
): string | null {
  let best: string | null = null;
  for (const v of [a.rate_limited_until, a.overload_until, a.temp_unschedulable_until]) {
    if (v && v > now && (!best || v > best)) best = v;
  }
  return best;
}

export interface Candidate extends AccountRow {
  group_priority: number;
  /**
   * Inside a plain (Retry-After style) 429 cooldown. Such an account is still a
   * candidate, ordered last: a 429 is often specific to one request shape (e.g.
   * the Claude Code UA direct path) while the same account keeps serving other
   * shapes, so treating it as unschedulable would turn one probe's 429 into
   * 503s for every other caller of a single-account group (docs/gateway.md §3).
   */
  cooling: boolean;
}

/**
 * `rate_limited_until` written by a rejected-window 429 (markFailure
 * window_rejected): hours long and account-wide, so it stays a hard exclusion.
 * A later plain 429 overwrites `rate_limited_until` alone, which breaks the
 * match and makes the cooldown soft again.
 */
function windowRejectedUntil(a: Pick<AccountRow, "rate_limited_until" | "window_reason">): boolean {
  return !!a.rate_limited_until && !!a.window_reason && a.window_reason.endsWith(`rejected (429) until ${a.rate_limited_until}`);
}

/**
 * Accounts in the group that are active, approved, not hard-cooling and support
 * the model. CCR accounts are additionally filtered by subscription window
 * headroom (docs/ccr-supply.md §7). Accounts in a plain 429 cooldown are
 * returned last with `cooling = true` (soft cooldown, see Candidate).
 */
export function listCandidates(groupId: string, model: string, teamId?: string): Candidate[] {
  const now = nowIso();
  const rows = all<Candidate>(
    `SELECT a.*, ag.priority AS group_priority
     FROM account_groups ag JOIN accounts a ON a.id = ag.account_id
     WHERE ag.group_id = ? AND a.status = 'active' AND a.review_status = 'approved'
       AND (a.overload_until IS NULL OR a.overload_until <= ?)
       AND (a.temp_unschedulable_until IS NULL OR a.temp_unschedulable_until <= ?)
       AND (a.window_exhausted_until IS NULL OR a.window_exhausted_until <= ?)`,
    groupId,
    now,
    now,
    now,
  );
  for (const a of rows) a.cooling = !!a.rate_limited_until && a.rate_limited_until > now;
  const threshold = rows.some((a) => a.window_used !== null) ? parseThresholdPercent(getSetting("anthropic_window_threshold_percent")) : 100;
  const filtered = rows.filter((a) => {
    if (a.platform === "anthropic" && a.type === "oauth") {
      const actualTeam = accountTeamId(a);
      if (!actualTeam || (teamId !== undefined && actualTeam !== teamId)) return false;
      if (!one("SELECT 1 FROM upstream_teams WHERE id=? AND status='active'",actualTeam))return false;
      if (a.route !== "node" || !a.bound_proxy_id || boundProxyDown(a)) return false;
    }
    if (!supportsModel(a, model)) return false;
    if (a.cooling && windowRejectedUntil(a)) return false;
    // Model-family cooldown (Fable 7d window / credits): hard, but only for that family.
    if (modelScopeCooling(a, model, now)) return false;
    if (windowAllows(a, now, threshold)) return true;
    // Over the threshold but not yet paused (threshold lowered since the last sample):
    // record the pause once so the console shows why the account is being skipped
    // (sub2api ApplyAccountSchedulingThreshold at selection time).
    if (!a.window_exhausted_until || a.window_exhausted_until <= now) pauseForWindow(a, threshold, now);
    return false;
  });
  // not cooling first (cooling: soonest free first) -> priority ASC -> account priority ASC
  // -> least recently used -> random within tier
  const shuffled = filtered.map((a) => ({ a, r: Math.random() }));
  shuffled.sort(
    (x, y) =>
      Number(x.a.cooling) - Number(y.a.cooling) ||
      (x.a.cooling ? (x.a.rate_limited_until ?? "").localeCompare(y.a.rate_limited_until ?? "") : 0) ||
      x.a.group_priority - y.a.group_priority ||
      x.a.priority - y.a.priority ||
      (x.a.last_used_at ?? "").localeCompare(y.a.last_used_at ?? "") ||
      x.r - y.r,
  );
  return shuffled.map((s) => s.a);
}

/**
 * The account's pinned device id (one account = one device): the stored value,
 * or a deterministic one generated now and persisted. Node-reported identities
 * overwrite it later (registry heartbeat), so the two paths converge.
 */
export function ensureDeviceId(id: string): string {
  const row = one<{ device_id: string | null }>("SELECT device_id FROM accounts WHERE id = ?", id);
  if (row?.device_id) return row.device_id;
  const dev = createHash("sha256").update(`1dayapi-device:${id}`).digest("hex");
  run("UPDATE accounts SET device_id = ? WHERE id = ? AND device_id IS NULL", dev, id);
  return dev;
}

export function touchAccount(id: string): void {
  run("UPDATE accounts SET last_used_at = ? WHERE id = ?", nowIso(), id);
}

export type FailureKind =
  | { kind: "rate_limited"; retryAfterSec?: number }
  | { kind: "overloaded" }
  | { kind: "payment" }
  | { kind: "auth"; message: string }
  | { kind: "transient"; message?: string; cooldownMs?: number }
  /** Subscription window used up (probe / translation layer): cool until the window resets (fallback 1h). */
  | { kind: "window_exhausted"; resetAt?: string | null; window?: string | null }
  /** 429 whose unified headers name the rejected window: rate-limit until that window resets (sub2api handle429). */
  | { kind: "window_rejected"; window: string; resetAt: string }
  /** 429 scoped to one model family (Fable 7d_oi window or credits_required): cool only that scope (sub2api SetModelRateLimit). */
  | { kind: "model_window_rejected"; scope: string; resetAt: string; reason: string }
  /** A model-scoped 429 without a rejected global window: other models on this account remain schedulable. */
  | { kind: "model_rate_limited"; model: string; retryAfterSec?: number; reason: string }
  /** 403 "model X is suspended for this organization until T": only that model, only until T. */
  | { kind: "model_suspended"; model: string; until: string };

const WINDOW_FALLBACK_COOLDOWN_MS = 3_600_000;

/**
 * Rest period after a 5h window reset (docs/gateway.md §3): the account is not
 * scheduled the moment the window rolls over but a random 1h45m–2h05m later
 * (settings `window_rest_min_sec` / `window_rest_max_sec`), so a pool of
 * accounts does not all slam the upstream at their reset instants. Applied to
 * the five-hour window only; 7-day resets and model-scope cooldowns are untouched.
 */
export function restAfterReset(baseIso: string, window: string | null | undefined = "five_hour"): string {
  if (window === "seven_day") return baseIso;
  const min = Math.max(0, Number(getSetting("window_rest_min_sec")) || 0);
  const max = Math.max(min, Number(getSetting("window_rest_max_sec")) || min);
  const rest = min + Math.random() * (max - min);
  const base = Date.parse(baseIso);
  if (!Number.isFinite(base) || rest <= 0) return baseIso;
  return new Date(base + Math.round(rest * 1000)).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Process-local overload streak per account (gateway instance): drives the escalating cooldown. */
const overloadStreak = new Map<string, { n: number; at: number }>();

/** §7.3 cooldown bookkeeping. */
export function markFailure(id: string, f: FailureKind): void {
  const now = nowIso();
  switch (f.kind) {
    // Cooldowns only ever extend (audit 2026-11-01): concurrent failures of one account used to overwrite a
    // longer cooldown with a shorter one, re-admitting the account early. ISO timestamps compare as strings.
    case "rate_limited": {
      const sec = Math.min(Math.max(f.retryAfterSec ?? 60, 1), 7200);
      run("UPDATE accounts SET rate_limited_until = MAX(COALESCE(rate_limited_until, ''), ?), updated_at = ? WHERE id = ?", isoIn(sec * 1000), now, id);
      return;
    }
    case "overloaded": {
      // Escalate while the overloads keep coming (60 s, 2 min, 4 min … 10 min); a quiet 15 minutes resets the streak.
      const prev = overloadStreak.get(id);
      const streak = prev && Date.now() - prev.at < 15 * 60_000 ? prev.n + 1 : 1;
      overloadStreak.set(id, { n: streak, at: Date.now() });
      const ms = Math.min(60_000 * 2 ** (streak - 1), 10 * 60_000);
      run("UPDATE accounts SET overload_until = MAX(COALESCE(overload_until, ''), ?), updated_at = ? WHERE id = ?", isoIn(ms), now, id);
      return;
    }
    case "payment":
      run(
        "UPDATE accounts SET temp_unschedulable_until = ?, error_message = 'upstream 402 payment required', updated_at = ? WHERE id = ?",
        isoIn(3_600_000),
        now,
        id,
      );
      return;
    case "model_suspended":
      writeModelCooldown(id, `model:${f.model}`, { until: f.until, reason: `suspended for this organization until ${f.until}` }, now);
      return;
    case "auth":
      run(
        "UPDATE accounts SET status = 'error', error_message = ?, updated_at = ? WHERE id = ?",
        f.message.slice(0, 500),
        now,
        id,
      );
      return;
    case "transient":
      run(
        "UPDATE accounts SET temp_unschedulable_until = MAX(COALESCE(temp_unschedulable_until, ''), ?), error_message = COALESCE(?, error_message), updated_at = ? WHERE id = ?",
        isoIn(f.cooldownMs ?? 30_000),
        f.message ? f.message.slice(0, 500) : null,
        now,
        id,
      );
      return;
    case "window_exhausted": {
      const row = one<{ window_reset_at: string | null }>("SELECT window_reset_at FROM accounts WHERE id = ?", id);
      const candidate = f.resetAt ?? row?.window_reset_at ?? null;
      const resetAt = candidate && candidate > now ? candidate : isoIn(WINDOW_FALLBACK_COOLDOWN_MS);
      // seven_day gets no post-reset rest (restAfterReset): the rest exists to let the 5-hour window actually
      // reopen, a 7-day limit does not need it (audit 2026-11-01: the Claude Code limit text named the window
      // but it was not passed through, so 7d accounts sat out the extra rest as well).
      const until = restFor(id, resetAt, f.window ?? undefined);
      run(
        "UPDATE accounts SET window_exhausted_until = ?, window_reason = ?, updated_at = ? WHERE id = ?",
        until,
        `window exhausted until ${until}${until !== resetAt ? ` (reset ${resetAt} + rest)` : ""}`,
        now,
        id,
      );
      return;
    }
    case "window_rejected": {
      const until = restAfterReset(f.resetAt, f.window);
      // The reason must end with "rejected (429) until <rate_limited_until>": windowRejectedUntil() keys the hard exclusion on it.
      run(
        "UPDATE accounts SET rate_limited_until = ?, window_reason = ?, updated_at = ? WHERE id = ?",
        until,
        `${f.window}${until !== f.resetAt ? ` (reset ${f.resetAt} + rest)` : ""} rejected (429) until ${until}`,
        now,
        id,
      );
      return;
    }
    case "model_window_rejected":
      writeModelCooldown(id, f.scope, { until: f.resetAt, reason: `${f.reason} until ${f.resetAt}` }, now);
      return;
    case "model_rate_limited": {
      const sec = Math.min(Math.max(f.retryAfterSec ?? 60, 1), 7200);
      const until = isoIn(sec * 1000);
      writeModelCooldown(id, `model:${f.model}`, { until, reason: `${f.reason} until ${until}` }, now);
      return;
    }
  }
}

/** Clear error + cooldowns (admin re-enable). Window measurements are kept. */
export function clearAccountState(id: string): void {
  run(
    `UPDATE accounts SET status = 'active', error_message = NULL, rate_limited_until = NULL,
       overload_until = NULL, temp_unschedulable_until = NULL, window_exhausted_until = NULL, window_reason = NULL,
       model_cooldowns = NULL, proxy_down_since = NULL, proxy_down_reason = NULL, proxy_down_proxy_id = NULL, updated_at = ? WHERE id = ?`,
    nowIso(),
    id,
  );
}

// ---------- proxy failure → frozen account (operator rule 2026-11-01, docs/onboarding.md §1.2) ----------
//
// "订阅账号代理批不通，暂停任何请求，不能私下换 IP 与直连，直接变为不可用状态，除非手动解除或手动更换 IP。"
// Before this the account was merely skipped while node_proxies.status != 'live' and came back by itself.
// Now: status 'proxy_down' (excluded by listCandidates, window poller and keepalive, which all select
// status='active'); only releaseProxyFreeze / an operator rebind put it back. Idempotent, active → proxy_down only.

export interface ProxyFreeze {
  proxyId: string | null;
  reason: string;
  actorId?: string | null;
}

/** Freeze one account. Returns true when the row changed (was active). */
export function freezeAccountForProxy(accountId: string, f: ProxyFreeze): boolean {
  const now = nowIso();
  const reason = f.reason.slice(0, 300);
  const changed = run(
    `UPDATE accounts SET status = 'proxy_down', proxy_down_since = ?, proxy_down_reason = ?, proxy_down_proxy_id = ?,
       error_message = ?, updated_at = ? WHERE id = ? AND status = 'active'`,
    now, reason, f.proxyId, `proxy_down: ${reason}`, now, accountId,
  ).changes > 0;
  if (!changed) return false;
  const a = one<{ team_id: string | null; node_id: string | null; bound_proxy_id: string | null }>("SELECT team_id, node_id, bound_proxy_id FROM accounts WHERE id = ?", accountId);
  const pid = f.proxyId ?? a?.bound_proxy_id ?? null;
  const p = pid ? one<{ resource_key: string | null; node_id: string }>("SELECT resource_key, node_id FROM node_proxies WHERE id = ?", pid) : null;
  recordProxyTeamEvent({ resourceKey: p?.resource_key ?? (pid ? `proxy:${pid}` : `account:${accountId}`), proxyId: pid, nodeId: p?.node_id ?? a?.node_id ?? null,
    teamId: a?.team_id ?? null, accountId, actorId: f.actorId ?? null, event: "account_frozen_proxy_down", reason });
  return true;
}

/** Freeze every active account bound to (or stickily assigned on) this proxy. Returns the frozen account ids. */
export function freezeAccountsOnProxy(proxyId: string, reason: string): string[] {
  const ids = all<{ id: string }>(
    `SELECT id FROM accounts WHERE status = 'active' AND (bound_proxy_id = ?
        OR id IN (SELECT account_id FROM node_proxy_assignments WHERE proxy_id = ?))`, proxyId, proxyId).map((r) => r.id);
  return ids.filter((id) => freezeAccountForProxy(id, { proxyId, reason }));
}

export class ProxyFreezeError extends Error {
  constructor(public code: string, message: string) { super(message); }
}

/**
 * Operator release: the account goes back to 'active' only when its bound proxy is live again, not quarantined,
 * and (team accounts) still claimed by the account's organization — i.e. exactly what the scheduler checks. Any
 * other situation is refused with the reason, so the operator rebinds instead.
 */
export function releaseProxyFreeze(accountId: string, actorId: string | null, note?: string | null): void {
  const a = one<AccountRow>("SELECT * FROM accounts WHERE id = ?", accountId);
  if (!a) throw new ProxyFreezeError("account_not_found", "account not found");
  if (a.status !== "proxy_down") throw new ProxyFreezeError("not_proxy_down", `account status is ${a.status}, nothing to release`);
  if (a.bound_proxy_id) {
    const p = one<{ status: string; last_error: string | null; exit_ip: string | null }>("SELECT status, last_error, exit_ip FROM node_proxies WHERE id = ?", a.bound_proxy_id);
    if (!p) throw new ProxyFreezeError("proxy_missing", "the bound proxy no longer exists in the node pool; rebind the account to another proxy");
    if (p.status !== "live") throw new ProxyFreezeError("proxy_not_live", `the bound proxy is ${p.status}${p.last_error ? ` (${p.last_error})` : ""}; wait for a live heartbeat or rebind`);
    if (boundProxyDown(a)) throw new ProxyFreezeError("proxy_not_schedulable", "the bound proxy is live but not schedulable for this account (quarantine, organization claim or node mismatch); rebind the account");
  }
  const now = nowIso();
  run(`UPDATE accounts SET status = 'active', error_message = NULL, proxy_down_since = NULL, proxy_down_reason = NULL, proxy_down_proxy_id = NULL,
         temp_unschedulable_until = NULL, updated_at = ? WHERE id = ? AND status = 'proxy_down'`, now, accountId);
  const p = a.bound_proxy_id ? one<{ resource_key: string | null; node_id: string }>("SELECT resource_key, node_id FROM node_proxies WHERE id = ?", a.bound_proxy_id) : null;
  recordProxyTeamEvent({ resourceKey: p?.resource_key ?? (a.bound_proxy_id ? `proxy:${a.bound_proxy_id}` : `account:${accountId}`), proxyId: a.bound_proxy_id, nodeId: p?.node_id ?? a.node_id,
    teamId: accountTeamId(a), accountId, actorId, event: "account_proxy_released", reason: `operator released the proxy freeze (frozen since ${a.proxy_down_since ?? "?"}: ${a.proxy_down_reason ?? "?"})${note ? `; ${note.slice(0, 200)}` : ""}` });
}

/** Admin list / dashboard: how many accounts are frozen and since when the oldest. */
export function proxyDownSummary(): { count: number; oldestSince: string | null } {
  const r = one<{ n: number; oldest: string | null }>("SELECT COUNT(*) AS n, MIN(proxy_down_since) AS oldest FROM accounts WHERE status = 'proxy_down'");
  return { count: r?.n ?? 0, oldestSince: r?.oldest ?? null };
}

/**
 * Write back a window snapshot — from the usage probe or passively sampled from
 * response headers (docs/gateway.md §3, ccr-supply.md §7). At/above the
 * threshold → window cooldown until the reset time (fallback 1h) with a
 * reason; room again → lift the cooldown.
 */
/** accounts.window_model: which windows the account is subject to, per source; null = not known yet. */
export interface WindowModel {
  five_hour: boolean | null;
  seven_day: boolean | null;
  fable: boolean | null;
  /** usage_probe | headers | rate_limit_event */
  source: string | null;
  observed_at: string | null;
  /** How many consecutive observations agreed on five_hour (a single header sample is weak evidence). */
  streak: number;
}

export function parseWindowModel(json: string | null | undefined): WindowModel {
  const base: WindowModel = { five_hour: null, seven_day: null, fable: null, source: null, observed_at: null, streak: 0 };
  if (!json) return base;
  try {
    const j = JSON.parse(json) as Partial<WindowModel>;
    return { ...base, ...j, streak: Number(j.streak) || 0 };
  } catch {
    return base;
  }
}

/** Does this account have a five-hour window? false only when the sources have said so (verified Ultra); null = unknown. */
export function accountHasFiveHour(id: string): boolean | null {
  const row = one<{ window_model: string | null }>("SELECT window_model FROM accounts WHERE id = ?", id);
  return parseWindowModel(row?.window_model).five_hour;
}

/**
 * Fold a source's window presence into accounts.window_model. The usage probe and a rate_limit_event are authoritative
 * for what they name; unified headers need 3 agreeing samples before a missing 5h is believed (one response may just
 * omit a header). A `rate_limit_event` of type five_hour is positive proof the window exists.
 */
export function recordWindowPresence(id: string, presence: NonNullable<WindowSnapshot["presence"]>, source: "usage_probe" | "headers" | "rate_limit_event", now = nowIso()): WindowModel {
  const cur = parseWindowModel(one<{ window_model: string | null }>("SELECT window_model FROM accounts WHERE id = ?", id)?.window_model);
  const next: WindowModel = { ...cur, source, observed_at: now };
  if (source === "rate_limit_event") {
    // the event names one window at a time: it can only confirm presence, never absence
    if (presence.five_hour) next.five_hour = true;
    if (presence.seven_day) next.seven_day = true;
    if (presence.fable) next.fable = true;
  } else if (source === "usage_probe") {
    next.five_hour = presence.five_hour;
    next.seven_day = presence.seven_day;
    next.fable = presence.fable;
    next.streak = cur.five_hour === presence.five_hour ? cur.streak + 1 : 1;
  } else {
    if (presence.seven_day) next.seven_day = true;
    if (presence.fable) next.fable = true;
    if (presence.five_hour) { next.five_hour = true; next.streak = cur.five_hour === true ? cur.streak + 1 : 1; }
    else if (presence.seven_day) {
      // 7d reported without 5h: believe "no five-hour window" after 3 consecutive such samples
      const streak = cur.five_hour === false || cur.five_hour === null ? cur.streak + 1 : 1;
      next.streak = streak;
      if (streak >= 3) next.five_hour = false;
      else if (cur.five_hour === true) next.five_hour = true;
    }
  }
  if (JSON.stringify(next) !== JSON.stringify(cur)) run("UPDATE accounts SET window_model = ? WHERE id = ?", JSON.stringify(next), id);
  return next;
}

/** Post-reset rest only applies to a five-hour window; an account known to have none (verified Ultra) reopens at reset. */
function restFor(id: string, resetAt: string, window: string | null | undefined): string {
  if (accountHasFiveHour(id) === false) return resetAt;
  return restAfterReset(resetAt, window);
}

/** Worker path: Claude Code's per-turn `rate_limit_event` → the same window bookkeeping as unified headers. */
export function recordRateLimitEvent(id: string, info: unknown): WindowSnapshot | null {
  const snap = parseRateLimitEvent(info);
  if (!snap) return null;
  if (snap.window === "five_hour" || snap.window === "seven_day" || snap.fable) recordWindowUsage(id, snap, undefined, "rate_limit_event");
  else if (snap.presence) recordWindowPresence(id, snap.presence, "rate_limit_event");
  return snap;
}

export type WindowSource = "headers" | "usage_probe" | "rate_limit_event";

export function recordWindowUsage(
  id: string,
  snap: WindowSnapshot,
  thresholdPercent = parseThresholdPercent(getSetting("anthropic_window_threshold_percent")),
  source: WindowSource = "headers",
): void {
  const now = nowIso();
  if (snap.presence) recordWindowPresence(id, snap.presence, source, now);
  if (!snap.window && !snap.fiveHour && !snap.sevenDay) {
    // family-only snapshot (fable / overage): never touch the account-wide window columns
    if (snap.fable) {
      const fab = snap.fable;
      const fabExhausted = windowExhausted(fab.used, thresholdPercent) || fab.status === "rejected";
      const until = fabExhausted ? (fab.resetAt && fab.resetAt > now ? fab.resetAt : isoIn(WINDOW_FALLBACK_COOLDOWN_MS)) : null;
      writeModelCooldown(id, "fable", { used: fab.used, resetAt: fab.resetAt, until, reason: until ? `7d_oi ${Math.round(fab.used * 100)}% ≥ ${thresholdPercent}% until ${until}` : null }, now);
    }
    return;
  }
  const exhausted = windowExhausted(snap.used, thresholdPercent);
  const until = exhausted ? restFor(id, snap.resetAt && snap.resetAt > now ? snap.resetAt : isoIn(WINDOW_FALLBACK_COOLDOWN_MS), snap.window) : null;
  run(
    `UPDATE accounts SET window_used = ?, window_reset_at = ?, window_checked_at = ?, window_exhausted_until = ?, window_reason = ?,
       window_5h_used = COALESCE(?, window_5h_used), window_5h_reset_at = COALESCE(?, window_5h_reset_at),
       window_7d_used = COALESCE(?, window_7d_used), window_7d_reset_at = COALESCE(?, window_7d_reset_at),
       updated_at = ? WHERE id = ?`,
    snap.used,
    snap.resetAt,
    now,
    until,
    until ? windowReason(snap, thresholdPercent, until) : null,
    snap.fiveHour?.used ?? null,
    snap.fiveHour?.resetAt ?? null,
    snap.sevenDay?.used ?? null,
    snap.sevenDay?.resetAt ?? null,
    now,
    id,
  );
  // Fable-only window: scoped cooldown at/above the threshold, lifted when room returns.
  if (snap.fable) {
    const fab = snap.fable;
    const fabExhausted = windowExhausted(fab.used, thresholdPercent) || fab.status === "rejected";
    const until = fabExhausted ? (fab.resetAt && fab.resetAt > now ? fab.resetAt : isoIn(WINDOW_FALLBACK_COOLDOWN_MS)) : null;
    writeModelCooldown(id, "fable", { used: fab.used, resetAt: fab.resetAt, until, reason: until ? `7d_oi ${Math.round(fab.used * 100)}% ≥ ${thresholdPercent}% until ${until}` : null }, now);
  }
}

function pauseForWindow(a: Pick<AccountRow, "id" | "window_used" | "window_reset_at">, thresholdPercent: number, now: string): void {
  const until = restAfterReset(a.window_reset_at && a.window_reset_at > now ? a.window_reset_at : isoIn(WINDOW_FALLBACK_COOLDOWN_MS));
  const snap: WindowSnapshot = { used: a.window_used ?? 1, resetAt: a.window_reset_at, window: "window" };
  run(
    "UPDATE accounts SET window_exhausted_until = ?, window_reason = ?, updated_at = ? WHERE id = ?",
    until,
    windowReason(snap, thresholdPercent, until),
    now,
    a.id,
  );
}

/** Accounts whose window state is probed / sampled: Anthropic subscription (OAuth) accounts. */
export function hasSubscriptionWindow(a: Pick<AccountRow, "type" | "platform">): boolean {
  return a.type === "oauth" && a.platform === "anthropic";
}

/**
 * Scheduling gate (docs/onboarding.md §6.1): an account with a bound proxy is
 * skipped while that proxy is missing or not `live` in the node heartbeat
 * ledger. Not a failure — no cooldown; the account rejoins scheduling as soon
 * as the proxy recovers.
 */
export function boundProxyDown(a: Pick<AccountRow, "bound_proxy_id"> & { team_id?: string | null;node_id?:string|null }): boolean {
  if (!a.bound_proxy_id) return false;
  const row = one<{ status: string; team_id: string | null; node_id:string;isolation_version: number; resource_key: string | null }>(
    "SELECT status,team_id,node_id,isolation_version,resource_key FROM node_proxies WHERE id = ?", a.bound_proxy_id);
  if (!row || row.status !== "live") return true;
  const team = accountTeamId(a);
  if (!team) return false; // Legacy gate remains unchanged; candidate selection isolates OAuth separately.
  if (row.team_id !== team || row.isolation_version !== 1 || !row.resource_key) return true;
  if(a.node_id!==undefined && a.node_id!==row.node_id)return true;
  if (quarantineActive(row.resource_key, `proxy:${a.bound_proxy_id}`)) return true;
  return !one("SELECT 1 FROM proxy_team_claims WHERE resource_key=? AND team_id=?", row.resource_key, team);
}
