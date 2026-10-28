import {
  CCR,
  accountBaseUrl,
  all,
  anthropicFingerprintHeaders,
  canRefresh,
  credentialNeedsRefresh,
  getSetting,
  hasSubscriptionWindow,
  markFailure,
  parseUsageSnapshot,
  readCredential,
  recordWindowUsage,
  refreshOAuthCredential,
  type AccountRow,
  type OAuthTransport,
  type WindowSnapshot,
} from "@1dayapi/core";
import type { FastifyBaseLogger } from "fastify";
import { requestViaNode } from "../node/egress-request.js";

// Subscription-account upkeep (sub2api account_usage_service + token refresh):
//   - window probe: GET /api/oauth/usage (free, no quota) for Anthropic OAuth
//     accounts — direct accounts from this process, node accounts through
//     their node so the probe leaves from the same IP as traffic;
//   - token keep-alive: refresh OAuth tokens that expire within the margin.
// Passive sampling of every gateway response (docs/gateway.md §3) keeps busy
// accounts current; the probe covers idle ones.

const PROBE_TIMEOUT_MS = 15_000;
const KEEPALIVE_MARGIN_MS = 30 * 60_000;

function probeHeaders(accessToken: string): Record<string, string> {
  return {
    ...anthropicFingerprintHeaders({}),
    accept: "application/json, text/plain, */*",
    "content-type": "application/json",
    authorization: `Bearer ${accessToken}`,
    "anthropic-beta": "oauth-2025-04-20",
    "anthropic-version": CCR.anthropicVersion,
  };
}

/**
 * Probe one account's subscription window and write it back. Throws on any
 * failure (network, non-2xx, unparseable body). A 401 marks the account
 * error (token dead → needs re-auth); 403 may just be a scope gap.
 */
export async function probeWindow(account: AccountRow): Promise<WindowSnapshot> {
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

/** Probe every schedulable subscription account. Failures are logged, never thrown. */
export async function pollAllWindows(): Promise<void> {
  const rows = all<AccountRow>(
    "SELECT * FROM accounts WHERE type = 'oauth' AND platform = 'anthropic' AND status = 'active' AND review_status = 'approved'",
  );
  for (const a of rows) {
    try {
      await probeWindow(a);
    } catch (err) {
      console.warn(`[window] probe failed for account ${a.id}: ${(err as Error).message}`);
    }
  }
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

/** Refresh OAuth tokens that expire within the keep-alive margin (docs/ccr-supply.md M1). */
export async function refreshExpiringTokens(): Promise<void> {
  const rows = all<AccountRow>("SELECT * FROM accounts WHERE type = 'oauth' AND status <> 'disabled'");
  for (const a of rows) {
    if (!canRefresh(a)) continue;
    let cred;
    try {
      cred = readCredential(a);
    } catch {
      continue;
    }
    if (!credentialNeedsRefresh(cred, KEEPALIVE_MARGIN_MS)) continue;
    const next = await refreshOAuthCredential(a, cred, a.route === "node" ? nodeTransport(a) : undefined);
    if (!next) console.warn(`[oauth] keep-alive refresh failed for account ${a.id}`);
  }
}

/** Periodic upkeep. Disabled with CCR_WINDOW_POLL=0 (e2e / dev). */
export function startWindowPoller(log: FastifyBaseLogger): void {
  if (process.env.CCR_WINDOW_POLL === "0") return;
  const sec = Math.max(30, Number(getSetting("window_poll_interval_sec")) || 300);
  log.info(`subscription upkeep: window probe + token keep-alive every ${sec}s`);
  const tick = () => {
    void refreshExpiringTokens().then(() => pollAllWindows());
  };
  setInterval(tick, sec * 1000).unref();
  setTimeout(tick, 5_000).unref();
}
