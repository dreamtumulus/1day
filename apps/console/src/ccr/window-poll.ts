import { createHash } from "node:crypto";
import { setTimeout as wait } from "node:timers/promises";
import {
  CC_AUX_ACCEPT,
  CC_AUX_UA,
  CCR,
  accountBaseUrl,
  all,
  canRefresh,
  credentialNeedsRefresh,
  getSetting,
  hasSubscriptionWindow,
  markFailure,
  nowIso,
  one,
  parseUsageSnapshot,
  readCredential,
  recordWindowUsage,
  refreshCooldownUntil,
  refreshOAuthCredential,
  type AccountRow,
  type OAuthTransport,
  type WindowSnapshot,
} from "@1dayapi/core";
import type { FastifyBaseLogger } from "fastify";
import { requestViaNode } from "../node/egress-request.js";
import { liveSessionsForAccount } from "../node/registry.js";
import { sweepStaleJobs } from "../onboard/jobs.js";

// Subscription-account upkeep (sub2api account_usage_service + token refresh):
//   - window probe: GET /api/oauth/usage (free, no quota) for Anthropic OAuth
//     accounts — direct accounts from this process, node accounts through
//     their node so the probe leaves from the same IP as traffic;
//   - token keep-alive: refresh OAuth tokens that expire within the margin.
// Passive sampling of every gateway response (docs/gateway.md §3) keeps busy
// accounts current; the probe covers idle ones.

const PROBE_TIMEOUT_MS = 15_000;
// Keep-alive margins (2026-10-29, user: 30 min was half a token's life and doubled the refresh rate):
// refresh inside the last 15 minutes; under load wait for the account to go idle until 5 minutes remain.
const KEEPALIVE_MARGIN_MS = 15 * 60_000;
/** Under load the keep-alive waits for the account to go idle until this close to expiry. */
const KEEPALIVE_BUSY_MARGIN_MS = 5 * 60_000;
/** Spacing between two refreshes in one tick (jittered), so a pool never hits the token endpoint as a burst. */
const KEEPALIVE_GAP_MIN_MS = 2_000;
const KEEPALIVE_GAP_MAX_MS = 5_000;
const keepaliveGap = () => KEEPALIVE_GAP_MIN_MS + Math.random() * (KEEPALIVE_GAP_MAX_MS - KEEPALIVE_GAP_MIN_MS);

/** Accounts sharing one exit IP are refreshed one per tick: the token endpoint limits by IP (2026-10-29). */
function exitKey(a: AccountRow): string {
  if (!a.bound_proxy_id) return `acct:${a.id}`;
  const p = one<{ exit_ip: string | null }>("SELECT exit_ip FROM node_proxies WHERE id = ?", a.bound_proxy_id);
  return p?.exit_ip ? `ip:${p.exit_ip}` : `proxy:${a.bound_proxy_id}`;
}

// 对齐真实 CC 的 usage 调用（bundle：axios 辅助函数，只有 Authorization + UA
// claude-code/<ver> + axios 默认 Accept；不发不锈钢遥测头/anthropic-beta ——
// docs/claude-code-compat.md §8）。多发的头反而是异常指纹。
function probeHeaders(accessToken: string): Record<string, string> {
  return {
    authorization: `Bearer ${accessToken}`,
    "user-agent": CC_AUX_UA,
    accept: CC_AUX_ACCEPT,
  };
}

/**
 * Probe one account's subscription window and write it back. Throws on any
 * failure (network, non-2xx, unparseable body). A 401 marks the account
 * error (token dead → needs re-auth); 403 may just be a scope gap.
 */
export async function probeWindow(account: AccountRow): Promise<WindowSnapshot> {
  if (!account.team_id) throw new Error("Legacy accounts are excluded from automatic maintenance");
  if (!hasSubscriptionWindow(account)) throw new Error("window probes apply to Anthropic subscription (OAuth) accounts");
  const base = accountBaseUrl(account);
  if (!base) throw new Error("account has no resolvable base URL");
  const cred = readCredential(account);
  if (!cred.accessToken) throw new Error("account has no access token");
  const url = `${base}${CCR.usagePath}`;
  const headers = probeHeaders(cred.accessToken);
  let status: number;
  let text: string;
  if (account.route === "node") {
    const r = await requestViaNode(account, url, headers, undefined);
    if ("nodeError" in r) throw new Error(`node: ${r.nodeError}`);
    status = r.status;
    text = r.text;
  } else {
    let res: Response;
    try {
      res = await fetch(url, { headers, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    } catch (err) {
      throw new Error(`usage probe request failed: ${(err as Error).message}`);
    }
    status = res.status;
    text = await res.text().catch(() => "");
  }
  if (status === 401) {
    markFailure(account.id, { kind: "auth", message: "usage probe: 401 — token rejected, re-authorize this account" });
    throw new Error("usage probe returned HTTP 401 (token rejected; account marked error)");
  }
  if (status < 200 || status >= 300) {
    const scopeHint = status === 403 ? "; the token scope may not cover the usage endpoint (account status left unchanged)" : "";
    throw new Error(`usage probe returned HTTP ${status}${scopeHint}`);
  }
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* handled below */
  }
  const snap = parseUsageSnapshot(json);
  if (!snap) { console.warn(`[window] probe body (status ${status}): ${text.slice(0, 300)}`); throw new Error("usage probe response did not contain a window snapshot"); }
  recordWindowUsage(account.id, snap);
  return snap;
}

/**
 * Probe only subscription accounts whose window data is stale. Passive sampling
 * of every gateway response (docs/gateway.md §5.1) is the primary source and
 * refreshes `window_checked_at`; the active `GET /api/oauth/usage` probe is a
 * fallback for idle accounts — a real Claude Code client does not hit the usage
 * endpoint on a metronome, and neither should we:
 *   - at most once per `window_passive_max_age_sec` per account;
 *   - the staleness threshold is jittered per account (0.7x–1.3x, stable hash of
 *     the account id), so the fleet never probes in one synchronized burst —
 *     org-level correlation across seats would otherwise see a bot pattern.
 */
export async function pollAllWindows(): Promise<number> {
  const maxAge = Math.max(600, Number(getSetting("window_passive_max_age_sec")) || 21_600);
  const now = Date.now();
  const rows = all<AccountRow>(
    "SELECT * FROM accounts WHERE type = 'oauth' AND platform = 'anthropic' AND status = 'active' AND review_status = 'approved' AND team_id IS NOT NULL",
  );
  const due = rows.filter((a) => {
    // 冷却中的账号不探：窗口数据要等冷却结束才有意义，冷却期探测是纯风控暴露。
    if (a.rate_limited_until && a.rate_limited_until > nowIso()) return false;
    if (a.window_exhausted_until && a.window_exhausted_until > nowIso()) return false;
    if (!a.window_checked_at) return true; // 新账号：立即取基线（授权后首次查询符合真实行为）
    const h = Number.parseInt(createHash("sha256").update(a.id).digest("hex").slice(0, 8), 16);
    const thresholdMs = maxAge * 1000 * (0.7 + (h % 600) / 1000); // 0.7x–1.299x，每账号固定
    return Date.parse(a.window_checked_at) + thresholdMs <= now;
  });
  for (const a of due) {
    try {
      await probeWindow(a);
    } catch (err) {
      console.warn(`[window] probe failed for account ${a.id}: ${(err as Error).message}`);
    }
  }
  return due.length;
}

/**
 * Refresh transport for node-routed accounts: the token endpoint is called
 * from the account's node (its bound/sticky proxy), never from this host —
 * docs/onboarding.md §1 (一号一代理，全生命周期绑定).
 */
function nodeTransport(a: AccountRow): OAuthTransport {
  return async (url, init) => {
    const r = await requestViaNode(a, url, init.headers, undefined, init.body);
    if ("nodeError" in r) {
      console.warn(`[oauth] node transport unavailable for account ${a.id}: ${r.nodeError}`);
      return null;
    }
    return new Response(r.text, { status: r.status, headers: { "content-type": "application/json" } });
  };
}

export interface KeepaliveSummary {
  /** Refresh calls made this tick (successful or not). */
  attempted: number;
  refreshed: number;
  /** Skipped: token endpoint back-off running (set by an earlier 429). */
  coolingDown: number;
  /** Skipped: another account on the same exit IP was refreshed this tick. */
  deferredSameExit: number;
  /** Skipped: live sessions and not yet urgent. */
  deferredBusy: number;
}

/**
 * Refresh OAuth tokens that expire within the keep-alive margin (docs/ccr-supply.md M1).
 * One refresh per exit IP per tick, 2–5 s apart, none while a token-endpoint back-off runs;
 * a token inside the busy margin (about to expire) is refreshed regardless of the exit rule.
 */
export async function refreshExpiringTokens(gapMs: () => number = keepaliveGap): Promise<KeepaliveSummary> {
  const sum: KeepaliveSummary = { attempted: 0, refreshed: 0, coolingDown: 0, deferredSameExit: 0, deferredBusy: 0 };
  // Only accounts that can still be scheduled: a rejected or errored token is
  // not kept alive (and a dead refresh token is not retried every tick).
  const rows = all<AccountRow>("SELECT * FROM accounts WHERE type = 'oauth' AND status = 'active' AND review_status = 'approved' AND team_id IS NOT NULL");
  const refreshedExits = new Set<string>();
  for (const a of rows) {
    if (!canRefresh(a)) continue;
    let cred;
    try {
      cred = readCredential(a);
    } catch {
      continue;
    }
    if (!credentialNeedsRefresh(cred, KEEPALIVE_MARGIN_MS)) continue;
    if (refreshCooldownUntil(a.id)) { sum.coolingDown++; continue; }
    const urgent = credentialNeedsRefresh(cred, KEEPALIVE_BUSY_MARGIN_MS);
    // A refresh invalidates the access token in use: requests in flight on this account 401
    // and a live Claude Code process on the node then retries with a refresh token that is
    // already rotated (2026-10-22, "Failed to authenticate: OAuth session expired and could
    // not be refreshed"). Wait for the account to go idle; only refresh under load when the
    // token is about to expire anyway.
    const live = liveSessionsForAccount(a.id);
    if (live > 0 && !urgent) {
      console.log(`[oauth] keep-alive: account ${a.id} has ${live} live session(s), deferring refresh (expires ${cred.expiresAt})`);
      sum.deferredBusy++;
      continue;
    }
    const exit = exitKey(a);
    if (!urgent && refreshedExits.has(exit)) {
      console.log(`[oauth] keep-alive: account ${a.id} shares ${exit} with an account refreshed this tick, deferring to the next tick (expires ${cred.expiresAt})`);
      sum.deferredSameExit++;
      continue;
    }
    if (sum.attempted > 0) await wait(gapMs());
    refreshedExits.add(exit);
    sum.attempted++;
    const next = await refreshOAuthCredential(a, cred, a.route === "node" ? nodeTransport(a) : undefined);
    if (next) sum.refreshed++;
    else console.warn(`[oauth] keep-alive refresh failed for account ${a.id}`);
  }
  if (sum.attempted || sum.coolingDown || sum.deferredSameExit) console.log(`[oauth] keep-alive tick: ${sum.refreshed}/${sum.attempted} refreshed, ${sum.coolingDown} in back-off, ${sum.deferredSameExit} deferred (same exit), ${sum.deferredBusy} deferred (busy)`);
  return sum;
}

/** Periodic upkeep. Disabled with CCR_WINDOW_POLL=0 (e2e / dev). */
export function startWindowPoller(log: FastifyBaseLogger): void {
  if (process.env.CCR_WINDOW_POLL === "0") return;
  const sec = Math.max(30, Number(getSetting("window_poll_interval_sec")) || 300);
  log.info(`subscription upkeep tick every ${sec}s: token keep-alive + usage probe only for accounts not sampled in ${getSetting("window_passive_max_age_sec")}s`);
  // A tick walks every node account sequentially (up to 30 s each): never let
  // two overlap, or one account gets two concurrent refreshes (token rotation
  // would invalidate the family).
  let running = false;
  const tick = () => {
    if (running) return;
    running = true;
    void refreshExpiringTokens()
      .then(() => pollAllWindows())
      .then((n) => {
        if (n) log.info(`[window] probed ${n} stale account(s)`);
      })
      .catch((err) => log.warn(`subscription upkeep tick failed: ${(err as Error).message}`))
      .finally(() => {
        running = false;
        const swept = sweepStaleJobs();
        if (swept) log.warn(`onboarding: ${swept} stale job(s) expired`);
      });
  };
  setInterval(tick, sec * 1000).unref();
  setTimeout(tick, 5_000).unref();
}
