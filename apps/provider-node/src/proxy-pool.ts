import crypto from "node:crypto";
import { isIP } from "node:net";
import type { NodeConfigStore } from "./config.js";
import type { ProxyStatusReport } from "./protocol.js";
import { Socks5Bridge, isSocks5Url } from "./socks5-bridge.js";

export const PROXY_HEALTHCHECK_INTERVAL_MS = 5 * 60_000;
const HEALTHCHECK_TIMEOUT_MS = 10_000;
const HEALTHCHECK_URL = "https://api.anthropic.com/v1/models";
/** Probes in flight at once: proxy vendors throttle connection bursts, which would read as false "dead". */
const HEALTHCHECK_CONCURRENCY = 4;
/**
 * Consecutive proxy-layer failures (health probes and real requests alike)
 * before a proxy counts as dead. Vendor pools fluctuate — a refused CONNECT or
 * a handshake timeout is often a blip of that exit — so one failure only makes
 * the proxy "suspect" (still used, still pinned); it is withdrawn, and its
 * bound accounts taken out of scheduling, only after this many in a row
 * (default 3 = 15 min of failed 5-min probes). Env PROXY_DEAD_AFTER.
 */
export const DEFAULT_PROXY_DEAD_AFTER = Math.max(1, Number(process.env.PROXY_DEAD_AFTER ?? 3) || 3);

/**
 * Bun.fetch accepts a `proxy` init option (http/https/socks5/socks5h URLs)
 * that the standard fetch typing does not know about.
 */
export type BunFetchInit = RequestInit & { proxy?: string; /** Bun: automatic response decompression (default true). */ decompress?: boolean };
export const bunFetch = fetch as unknown as (
  url: string,
  init?: BunFetchInit,
) => Promise<Response>;

/** Stable proxy identifier: sha256(url) first 12 hex chars. */
export function proxyId(url: string): string {
  return crypto.createHash("sha256").update(url, "utf8").digest("hex").slice(0, 12);
}

/** Display-safe URL: userinfo (passwords) stripped. */
export function redactProxyUrl(url: string): string {
  try {
    const u = new URL(url);
    u.username = "";
    u.password = "";
    return u.toString();
  } catch {
    return "(invalid-proxy-url)";
  }
}

export function isValidProxyUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return (
      ["http:", "https:", "socks5:", "socks5h:"].includes(u.protocol) && Boolean(u.hostname)
    );
  } catch {
    return false;
  }
}

interface ProxyHealth {
  /** null = not checked yet (treated as usable until proven dead). */
  live: boolean | null;
  latencyMs: number | null;
  lastError: string | null;
  lastCheckAt: number | null;
  /** Consecutive proxy-layer failures; reset by any success. live=false only at >= deadAfter. */
  failStreak: number;
  exitIp?: string | null;
}

export interface ProxyPoolOptions {
  log?: (msg: string) => void;
  /** Overridable for tests. */
  checkUrl?: string;
  /** false disables the probe pass triggered by replaceAll (tests). */
  autoCheck?: boolean;
  /** Consecutive failures before "dead" (see DEFAULT_PROXY_DEAD_AFTER). */
  deadAfter?: number;
}

/**
 * Node-side proxy pool (protocol v2). Sources: platform `proxies.set` push
 * and the local config file; both land in NodeConfigStore (encrypted at
 * rest). Assignment stickiness: accountId -> proxyUrl, rehashed to another
 * live proxy when the assigned one dies. Direct egress never happens.
 */
export class ProxyPool {
  private store: NodeConfigStore;
  private opts: ProxyPoolOptions;
  private health = new Map<string, ProxyHealth>();
  private timer: NodeJS.Timeout | null = null;
  private checking = false;
  private inFlight: Promise<void> | null = null;
  private recheckQueued = false;
  private readonly bridge: Socks5Bridge;
  readonly deadAfter: number;

  constructor(store: NodeConfigStore, opts: ProxyPoolOptions = {}) {
    this.store = store;
    this.opts = opts;
    this.deadAfter = Math.max(1, opts.deadAfter ?? DEFAULT_PROXY_DEAD_AFTER);
    this.bridge = new Socks5Bridge((m) => this.opts.log?.(m));
    for (const url of store.data.proxies ?? []) {
      if (isValidProxyUrl(url)) this.health.set(url, freshHealth());
    }
  }

  /**
   * What to hand Bun.fetch as `proxy` for a pool URL: http(s) proxies as-is,
   * socks5(h) proxies through the loopback bridge (Bun has no SOCKS support).
   */
  transportProxy(url: string): Promise<string> {
    return isSocks5Url(url) ? this.bridge.localProxyFor(url) : Promise.resolve(url);
  }

  /** Error text for a failed request through `url`, preferring the SOCKS-level reason when there is one. */
  failureMessage(url: string, err: unknown): string {
    return this.classifyFailure(url, err).message;
  }

  /**
   * Was the failure the proxy's fault (connect/auth/CONNECT to the proxy) or
   * the upstream's (reset / TLS / timeout once tunnelled)? Only the former
   * justifies marking the proxy dead on a single request.
   */
  classifyFailure(url: string, err: unknown): { message: string; proxyLayer: boolean } {
    const socks = isSocks5Url(url) ? this.bridge.consumeError(url) : null;
    const base = (err as Error)?.message ?? String(err);
    const message = socks ? `${socks} (${base})` : base;
    const proxyLayer =
      socks !== null ||
      /proxy|ECONNREFUSED|ConnectionRefused|ENOTFOUND|EAI_AGAIN|FailedToOpenSocket|407|tunnel/i.test(base);
    return { message, proxyLayer };
  }

  private reprobing = new Set<string>();

  /** One immediate liveness probe of a single proxy (after an upstream-side failure); coalesced per URL. */
  async reprobe(url: string): Promise<void> {
    const h = this.health.get(url);
    if (!h || this.reprobing.has(url)) return;
    this.reprobing.add(url);
    try {
      await this.probe(this.opts.checkUrl ?? HEALTHCHECK_URL, url, h);
      this.log(`re-probed proxy ${proxyId(url)}: ${h.failStreak === 0 ? "live" : `failed ${h.failStreak}/${this.deadAfter} (${h.lastError})`}`);
      if (h.live === false) this.withdraw(url);
    } finally {
      this.reprobing.delete(url);
    }
  }

  private log(msg: string): void {
    this.opts.log?.(`[proxy-pool] ${msg}`);
  }

  get size(): number {
    return this.health.size;
  }

  /** Platform push / config reload: full replacement, persisted. */
  replaceAll(urls: string[], metadata?: { proxyTeams?: Record<string, string>; proxyAccounts?: Record<string, string[]> }): { accepted: number; rejected: number } {
    const valid = [...new Set(urls.filter(isValidProxyUrl))];
    const rejected = urls.length - valid.length;
    this.health.clear();
    for (const url of valid) this.health.set(url, freshHealth());
    this.store.data.proxies = valid.length > 0 ? valid : undefined;
    if (metadata) {
      const ids = new Set(valid.map(proxyId));
      this.store.data.proxyTeams = Object.fromEntries(Object.entries(metadata.proxyTeams ?? {}).filter(([id, team]) => ids.has(id) && typeof team === "string" && !!team));
      this.store.data.proxyAccounts = Object.fromEntries(Object.entries(metadata.proxyAccounts ?? {}).filter(([id, accounts]) => ids.has(id) && Array.isArray(accounts) && accounts.every((a) => typeof a === "string")));
    }
    const assignments = this.store.data.proxyAssignments;
    if (assignments) {
      for (const [accountId, url] of Object.entries(assignments)) {
        if (!this.health.has(url)) delete assignments[accountId];
      }
      if (Object.keys(assignments).length === 0) this.store.data.proxyAssignments = undefined;
    }
    this.store.save();
    this.bridge.retain(new Set(valid.filter(isSocks5Url)));
    this.log(`pool replaced: ${valid.length} proxies (${rejected} rejected)`);
    if (this.opts.autoCheck !== false) void this.checkAll();
    return { accepted: valid.length, rejected };
  }

  /**
   * Pinned proxy by id (docs/onboarding.md §6.2): the exact pool member the
   * account is bound to. Returns null when the id is not in the pool or the
   * proxy is known-dead — the caller must hard-fail with no_proxy_available
   * (never fall back to sticky, never direct). Unprobed (live=null) counts as
   * usable, matching pickForAccount.
   */
  getPinnedForArchive(id: string, teamId: string): string | null {
    if (!teamId || this.store.data.proxyTeams?.[id] !== teamId) return null;
    for (const [url, health] of this.health) if (proxyId(url) === id) return health.live !== false ? url : null;
    return null;
  }

  getPinned(id: string, accountId?: string, teamId?: string): string | null {
    const team = this.store.data.proxyTeams?.[id];
    if (team || teamId) {
      if (!team || team !== teamId || !accountId || !this.store.data.proxyAccounts?.[id]?.includes(accountId)) return null;
    }
    for (const [url, h] of this.health) {
      if (proxyId(url) === id) return h.live !== false ? url : null;
    }
    return null;
  }

  isTeamAccount(accountId: string): boolean {
    return Object.entries(this.store.data.proxyAccounts ?? {}).some(([id, accounts]) => !!this.store.data.proxyTeams?.[id] && accounts.includes(accountId));
  }

  /**
   * Sticky proxy for an account. Returns null when the pool is empty or
   * every proxy is known-dead — the caller must fail with no_proxy_available.
   */
  pickForAccount(accountId: string): string | null {
    // Team-bound accounts never silently rehash to another proxy, including a legacy caller.
    if (this.isTeamAccount(accountId)) return null;
    const assigned = this.store.data.proxyAssignments?.[accountId];
    if (assigned && this.health.has(assigned) && this.health.get(assigned)?.live !== false && !this.store.data.proxyTeams?.[proxyId(assigned)]) {
      return assigned;
    }
    const candidates = [...this.health.keys()].filter((u) => this.health.get(u)?.live !== false && !this.store.data.proxyTeams?.[proxyId(u)]);
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => proxyId(a).localeCompare(proxyId(b)));
    const hash = crypto.createHash("sha256").update(accountId, "utf8").digest();
    const url = candidates[hash.readUInt32BE(0) % candidates.length];
    const assignments = (this.store.data.proxyAssignments ??= {});
    assignments[accountId] = url;
    this.store.save();
    this.log(`assigned account ${accountId} -> proxy ${proxyId(url)}`);
    return url;
  }

  /**
   * A proxy-layer request failure: one strike. The proxy stays usable
   * ("suspect") until `deadAfter` consecutive strikes/probe failures; only then
   * is it withdrawn and its sticky assignments rehashed. A real success in
   * between (probe or request) clears the streak.
   */
  markDead(url: string, reason: string): void {
    const h = this.health.get(url);
    if (!h) return;
    h.failStreak += 1;
    h.lastError = reason;
    h.lastCheckAt = Date.now();
    if (h.failStreak < this.deadAfter) {
      this.log(`proxy ${proxyId(url)} strike ${h.failStreak}/${this.deadAfter}: ${reason}`);
      void this.reprobe(url); // confirm quickly instead of waiting for the next 5-min pass
      return;
    }
    h.live = false;
    this.withdraw(url);
  }

  /** A request through `url` succeeded: clears a pending strike streak. */
  markAlive(url: string): void {
    const h = this.health.get(url);
    if (!h) return;
    if (h.failStreak > 0) this.log(`proxy ${proxyId(url)} recovered (request ok after ${h.failStreak} failure(s))`);
    h.failStreak = 0;
    h.live = true;
    h.lastError = null;
  }

  /** Drop sticky assignments of a now-dead proxy (accounts rehash on next pick). */
  private withdraw(url: string): void {
    const h = this.health.get(url);
    if (!h) return;
    const assignments = this.store.data.proxyAssignments;
    if (assignments) {
      let changed = false;
      for (const [accountId, assigned] of Object.entries(assignments)) {
        if (assigned === url) {
          delete assignments[accountId];
          changed = true;
        }
      }
      if (changed) this.store.save();
    }
    this.log(`proxy ${proxyId(url)} marked dead after ${h.failStreak} consecutive failures: ${h.lastError}`);
  }

  /** Heartbeat payload: redacted status (null = not probed yet) + accountId -> proxyId assignments. */
  heartbeatReport(): { proxies: ProxyStatusReport[]; assignments: Record<string, string> } {
    const proxies: ProxyStatusReport[] = [...this.health.entries()].map(([url, h]) => ({
      id: proxyId(url),
      url: redactProxyUrl(url),
      live: h.live,
      latencyMs: h.latencyMs,
      exitIp: h.exitIp ?? null,
      error: h.lastError,
    }));
    const assignments: Record<string, string> = {};
    for (const [accountId, url] of Object.entries(this.store.data.proxyAssignments ?? {})) {
      if (this.health.has(url)) assignments[accountId] = proxyId(url);
    }
    return { proxies, assignments };
  }

  /** Redacted view for the local console. */
  summary(): Array<{ id: string; url: string; live: boolean | null; latencyMs: number | null; lastError: string | null; lastCheckAt: string | null }> {
    return [...this.health.entries()].map(([url, h]) => ({
      id: proxyId(url),
      url: redactProxyUrl(url),
      live: h.live,
      latencyMs: h.latencyMs,
      lastError: h.lastError,
      lastCheckAt: h.lastCheckAt ? new Date(h.lastCheckAt).toISOString() : null,
    }));
  }

  startHealthChecks(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.checkAll(), PROXY_HEALTHCHECK_INTERVAL_MS);
    this.timer.unref?.();
    void this.checkAll();
  }

  stopHealthChecks(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.bridge.close();
  }

  /**
   * Liveness probe: a lightweight request through the proxy to
   * api.anthropic.com. Any HTTP response (even 401) counts as alive; only
   * transport/proxy failures count as dead. Runs at most one pass at a
   * time; a pass requested while one is in flight (pool replaced) is
   * queued so the new URLs get probed right after.
   */
  async checkAll(): Promise<void> {
    if (this.checking) {
      this.recheckQueued = true;
      await this.inFlight;
      return;
    }
    this.checking = true;
    const run = (async () => {
      const target = this.opts.checkUrl ?? HEALTHCHECK_URL;
      const entries = [...this.health.entries()];
      let next = 0;
      const worker = async () => {
        while (next < entries.length) {
          const [url, h] = entries[next++];
          if (!this.health.has(url)) continue; // pool replaced mid-pass
          await this.probe(target, url, h);
        }
      };
      await Promise.all(Array.from({ length: Math.min(HEALTHCHECK_CONCURRENCY, entries.length) }, worker));
      const live = [...this.health.values()].filter((h) => h.live !== false).length;
      const suspect = [...this.health.values()].filter((h) => h.live !== false && h.failStreak > 0).length;
      const dead = [...this.health.entries()].filter(([, h]) => h.live === false);
      this.log(`health check: ${live}/${this.health.size} proxies live${suspect ? ` (${suspect} suspect, ${this.deadAfter - 1} more failure(s) to dead)` : ""}`);
      if (dead.length) {
        const reasons = new Map<string, number>();
        for (const [, h] of dead) reasons.set(h.lastError ?? "?", (reasons.get(h.lastError ?? "?") ?? 0) + 1);
        for (const [reason, n] of [...reasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)) {
          this.log(`  dead x${n}: ${reason}`);
        }
      }
    })();
    this.inFlight = run;
    try {
      await run;
    } finally {
      this.checking = false;
      this.inFlight = null;
    }
    if (this.recheckQueued) {
      this.recheckQueued = false;
      await this.checkAll();
    }
  }

  private async probe(target: string, url: string, h: ProxyHealth): Promise<void> {
    const t0 = Date.now();
    try {
      const proxy = await this.transportProxy(url);
      const res = await bunFetch(target, {
        method: "GET",
        proxy,
        signal: AbortSignal.timeout(HEALTHCHECK_TIMEOUT_MS),
      });
      await res.body?.cancel().catch(() => undefined); // never leave 400 probe bodies dangling
      // Exit identity is capacity metadata, independent of the Anthropic liveness verdict.
      // Never infer an IP from the proxy host (residential/sticky providers can differ).
      if (!this.opts.checkUrl) {
        try {
          const ipRes = await bunFetch("https://api.ipify.org?format=json", { proxy, signal: AbortSignal.timeout(HEALTHCHECK_TIMEOUT_MS) });
          const ip = (await ipRes.json() as { ip?: unknown }).ip;
          h.exitIp = typeof ip === "string" && isIP(ip) ? ip : null;
        } catch { h.exitIp = null; }
      }
      if (h.live === false || h.failStreak > 0) this.log(`proxy ${proxyId(url)} back: probe ok after ${h.failStreak} failure(s)`);
      h.live = true;
      h.failStreak = 0;
      h.latencyMs = Date.now() - t0;
      h.lastError = null;
    } catch (err) {
      // Strikes need 60 s between them: three probe passes within seconds of a restart must not
      // condemn a proxy that a single 5-min pass would have given three chances.
      if (!h.lastCheckAt || Date.now() - h.lastCheckAt >= 60_000 || h.failStreak === 0) h.failStreak += 1;
      h.latencyMs = null;
      h.lastError = this.failureMessage(url, err);
      // Below the threshold the proxy stays as it was (live or unprobed): a blip, not a verdict.
      if (h.failStreak >= this.deadAfter) {
        if (h.live !== false) this.withdraw(url);
        h.live = false;
      }
    }
    h.lastCheckAt = Date.now();
  }
}

function freshHealth(): ProxyHealth {
  return { live: null, latencyMs: null, lastError: null, lastCheckAt: null, failStreak: 0 };
}
