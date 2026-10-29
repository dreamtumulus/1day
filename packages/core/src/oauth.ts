// OAuth token refresh for subscription accounts (docs/v3-design.md §5.2).
// Shared by the gateway (lazy refresh before a request) and the console
// (background keep-alive, docs/ccr-supply.md M1). Refresh goes direct unless
// the caller passes a transport — the gateway pins CCR node accounts to their
// bound proxy through the tunnel (docs/onboarding.md §6.2).

import { setTimeout as wait } from "node:timers/promises";
import { readCredential, writeCredential, type AccountRow, type Credential } from "./accounts.js";
import { one, run } from "./db.js";
import { CC_AUX_ACCEPT, CC_AUX_UA } from "./fingerprint.js";
import { OAUTH_ENDPOINTS } from "./platforms.js";
import { isoIn, nowIso } from "./time.js";

export const OAUTH_REFRESH_MARGIN_MS = 5 * 60_000;

/**
 * Token-endpoint back-off (migration 31, 2026-10-29). platform.claude.com answered refreshes with 429 for hours;
 * with no back-off the keep-alive retried every tick and the gateway on every request, which kept the limit
 * tripped until the access tokens expired and nine accounts were declared dead. A 429 now parks the account:
 * Retry-After when given, else 10 minutes, clamped to 1 min – 2 h; a successful refresh clears it.
 */
export const REFRESH_429_DEFAULT_COOLDOWN_MS = 10 * 60_000;
const REFRESH_COOLDOWN_MIN_MS = 60_000;
const REFRESH_COOLDOWN_MAX_MS = 2 * 3_600_000;

/** Retry-After as milliseconds: delta-seconds or an HTTP date; null when absent or unparseable. */
export function parseRetryAfterMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const v = value.trim();
  if (/^\d+$/.test(v)) return Number(v) * 1000;
  const at = Date.parse(v);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null;
}

/** The active refresh cooldown's end, or null when the account may refresh now. */
export function refreshCooldownUntil(accountId: string): string | null {
  try {
    const r = one<{ refresh_cooldown_until: string | null }>("SELECT refresh_cooldown_until FROM accounts WHERE id = ?", accountId);
    const until = r?.refresh_cooldown_until ?? null;
    return until && until > nowIso() ? until : null;
  } catch {
    return null; // pre-migration dev DB
  }
}

/**
 * Upstream says the grant itself is gone — only a re-authorization helps. Any other
 * authentication failure while the refresh is cooling down is the expected expiry of a
 * token we were not allowed to renew, and must not retire the account.
 */
export function isRevokedAuthText(text: string): boolean {
  return /revoked|invalid_grant/i.test(text);
}

/** fetch-shaped override for the refresh HTTP call; may return null on infrastructure failure. */
export type OAuthTransport = (url: string, init: { headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<Response | null>;

export function credentialNeedsRefresh(cred: Credential, marginMs = OAUTH_REFRESH_MARGIN_MS): boolean {
  if (!cred.refreshToken || !cred.expiresAt) return false;
  return Date.parse(cred.expiresAt) - Date.now() < marginMs;
}

/** The credential as the database holds it right now (another process may have rotated it). */
function storedCredential(accountId: string): Credential | null {
  const row = one<Pick<AccountRow, "credential_enc">>("SELECT credential_enc FROM accounts WHERE id = ?", accountId);
  if (!row) return null;
  try {
    return readCredential(row);
  } catch {
    return null;
  }
}

const REFRESH_LOCK_MS = 30_000;
const REFRESH_WAIT_MS = 20_000;

/** Cross-process refresh lock (migration 18): true when this process may call the token endpoint now. */
function acquireRefreshLock(accountId: string): boolean {
  const now = Date.now();
  const until = new Date(now + REFRESH_LOCK_MS).toISOString();
  try {
    const r = run(
      `INSERT INTO oauth_refresh_locks (account_id, locked_until) VALUES (?, ?)
       ON CONFLICT(account_id) DO UPDATE SET locked_until = excluded.locked_until WHERE oauth_refresh_locks.locked_until < ?`,
      accountId,
      until,
      new Date(now).toISOString(),
    );
    return r.changes > 0;
  } catch {
    return true; // table missing (pre-migration dev DB): behave as before
  }
}

function releaseRefreshLock(accountId: string): void {
  try {
    run("DELETE FROM oauth_refresh_locks WHERE account_id = ?", accountId);
  } catch {
    /* ignore */
  }
}

async function cancellable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  signal.throwIfAborted();
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      abort = () => reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      signal.addEventListener("abort", abort, { once: true });
    })]);
  } finally { if (abort) signal.removeEventListener("abort", abort); }
}

/**
 * Refresh and persist; null on failure (caller keeps the old token).
 *
 * Anthropic rotates the refresh token on every refresh and invalidates the previous
 * access token; using a rotated refresh token again revokes the whole grant
 * ("OAuth access token has been revoked", 2026-10-22: 9 accounts in one day). Three
 * parties used to refresh independently — console keep-alive, the gateway's forced
 * refresh after a 401 (with the account row it loaded before the console rotated) and
 * Claude Code on the node — so this now (1) re-reads the stored credential and returns
 * it when someone else already rotated, and (2) serialises refreshes across processes
 * with a row lock, waiting for the other refresher's result instead of racing it.
 */
export async function refreshOAuthCredential(
  account: Pick<AccountRow, "id" | "platform">,
  cred: Credential,
  transport?: OAuthTransport,
  signal?: AbortSignal,
): Promise<Credential | null> {
  signal?.throwIfAborted();
  if (!cred.refreshToken) return null;
  const rotated = (): Credential | null => {
    const stored = storedCredential(account.id);
    if (stored?.accessToken && stored.refreshToken && (stored.refreshToken !== cred.refreshToken || stored.accessToken !== cred.accessToken)) return stored;
    return null;
  };
  const already = rotated();
  if (already) {
    console.log(`[oauth] account ${account.id}: credential already rotated by another process, using the stored one`);
    return already;
  }
  const cooling = refreshCooldownUntil(account.id);
  if (cooling) {
    console.log(`[oauth] account ${account.id}: token endpoint back-off until ${cooling}, not refreshing`);
    return null;
  }
  if (!acquireRefreshLock(account.id)) {
    // Another process is refreshing this account right now: wait for its result.
    const deadline = Date.now() + REFRESH_WAIT_MS;
    while (Date.now() < deadline) {
      await wait(250, undefined, { signal });
      const r = rotated();
      if (r) {
        console.log(`[oauth] account ${account.id}: picked up the refresh done by another process`);
        return r;
      }
      if (acquireRefreshLock(account.id)) break; // the other refresher gave up / died
    }
    if (Date.now() >= deadline) {
      console.warn(`[oauth] refresh for account ${account.id}: waited ${REFRESH_WAIT_MS}ms for another refresher, giving up`);
      return null;
    }
  }
  try {
    signal?.throwIfAborted();
    return await refreshOAuthCredentialLocked(account, cred, transport, signal);
  } finally {
    releaseRefreshLock(account.id);
  }
}

async function refreshOAuthCredentialLocked(
  account: Pick<AccountRow, "id" | "platform">,
  cred: Credential,
  transport?: OAuthTransport,
  signal?: AbortSignal,
): Promise<Credential | null> {
  signal?.throwIfAborted();
  if (!cred.refreshToken) return null;
  const platform = account.platform === "openai" ? "openai" : "anthropic";
  const ep = OAUTH_ENDPOINTS[platform];
  try {
    // 对齐 CC 真实刷新（bundle：axios POST，body 带 scope 回放，默认 Accept；docs/claude-code-compat.md §8）
    const headers: Record<string, string> =
      platform === "anthropic"
        // UA explicitly: the node only fills Claude Code headers on *.anthropic.com /v1/* — the refresh host
        // (platform.claude.com) got Bun's default `Bun/x` UA otherwise (audit 2026-10-29).
        ? { "content-type": "application/json", accept: CC_AUX_ACCEPT, "user-agent": CC_AUX_UA }
        : { "content-type": "application/x-www-form-urlencoded" };
    const body =
      platform === "anthropic"
        ? JSON.stringify({ grant_type: "refresh_token", refresh_token: cred.refreshToken, client_id: ep.clientId, scope: OAUTH_ENDPOINTS.anthropic.refreshScopes })
        : new URLSearchParams({
            grant_type: "refresh_token",
            refresh_token: cred.refreshToken,
            client_id: ep.clientId,
            scope: "openid profile email",
          }).toString();
    signal?.throwIfAborted();
    const timeout = AbortSignal.timeout(20_000);
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const res = transport
      ? await transport(ep.tokenUrl, { headers, body, signal: requestSignal })
      : await fetch(ep.tokenUrl, { method: "POST", headers, body, signal: requestSignal });
    if (!res) {
      console.warn(`[oauth] refresh for account ${account.id} failed: transport unavailable`);
      return null;
    }
    if (res.status === 429) {
      const ra = parseRetryAfterMs(res.headers.get("retry-after"));
      const ms = Math.min(Math.max(ra ?? REFRESH_429_DEFAULT_COOLDOWN_MS, REFRESH_COOLDOWN_MIN_MS), REFRESH_COOLDOWN_MAX_MS);
      const until = isoIn(ms);
      try { run("UPDATE accounts SET refresh_cooldown_until = ? WHERE id = ?", until, account.id); } catch { /* pre-migration dev DB */ }
      console.warn(`[oauth] refresh for account ${account.id} failed: HTTP 429 → back-off until ${until}${ra !== null ? " (Retry-After)" : ""}`);
      return null;
    }
    if (!res.ok) {
      console.warn(`[oauth] refresh for account ${account.id} failed: HTTP ${res.status}`);
      return null;
    }
    const json = (await res.json()) as Record<string, unknown>;
    if (typeof json.access_token !== "string") return null;
    const next: Credential = {
      ...cred,
      accessToken: json.access_token,
      refreshToken: typeof json.refresh_token === "string" ? json.refresh_token : cred.refreshToken,
      expiresAt: isoIn(Number(json.expires_in ?? 3600) * 1000),
    };
    // Once the provider has rotated the grant, persist the returned credential
    // even if the client disconnected while the response was being decoded.
    writeCredential(account.id, next);
    try { run("UPDATE accounts SET refresh_cooldown_until = NULL WHERE id = ? AND refresh_cooldown_until IS NOT NULL", account.id); } catch { /* pre-migration dev DB */ }
    signal?.throwIfAborted();
    console.log(`[oauth] refreshed access token for account ${account.id}`);
    return next;
  } catch (err) {
    signal?.throwIfAborted();
    console.warn(`[oauth] refresh for account ${account.id} errored: ${(err as Error).message}`);
    return null;
  }
}

const refreshing = new Map<string, { promise: Promise<Credential | null>; signal?: AbortSignal }>();

/** Credential ready for use; refreshes coalesce, while each caller can cancel its wait. */
export async function freshCredential(account: AccountRow, force = false, transport?: OAuthTransport, signal?: AbortSignal): Promise<Credential> {
  signal?.throwIfAborted();
  const cred = readCredential(account);
  if (account.type !== "oauth" || (!force && !credentialNeedsRefresh(cred))) return cred;
  let entry = refreshing.get(account.id);
  if (!entry) {
    const promise = refreshOAuthCredential(account, cred, transport, signal).finally(() => refreshing.delete(account.id));
    entry = { promise, signal };
    refreshing.set(account.id, entry);
  }
  try { return (await cancellable(entry.promise, signal)) ?? cred; }
  catch (err) {
    signal?.throwIfAborted();
    // The first coalesced caller can disappear while another still needs the
    // account. That surviving caller retries under the normal cross-process lock.
    if (entry.signal?.aborted) {
      try { await entry.promise; } catch { /* original owner's cancellation */ }
      return freshCredential(account, force, transport, signal);
    }
    throw err;
  }
}

export function canRefresh(account: AccountRow): boolean {
  if (account.type !== "oauth") return false;
  try {
    return !!readCredential(account).refreshToken;
  } catch {
    return false;
  }
}
