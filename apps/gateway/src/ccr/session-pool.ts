// CCR session pool (docs/ccr-supply.md §5.3, X-12): reuse cloud sessions
// across requests instead of paying the 6-12s cold start every time.
//
// Key = accountId + model + client sticky key (metadata.user_id session id /
// conversation fingerprint, computed by proxy.ts). Requests WITHOUT a sticky
// key never reuse a session — the folded prompt re-sends the whole client
// history, so reusing an unrelated session leaks context across customers
// (实测串味). Reuse caps: turns < maxTurns, idle < idleMs, no error history,
// not currently busy. Retired sessions are archived upstream (409-tolerant).
//
// The pool is pure bookkeeping: account liveness and archiving are injected
// callbacks so unit tests need no DB/HTTP.

import type { Credential } from "@1dayapi/core";

export interface PoolEntry {
  accountId: string;
  model: string;
  stickyKey: string;
  sessionId: string;
  turns: number;
  busy: boolean;
  hadError: boolean;
  createdAt: number;
  lastUsedAt: number;
  /** Snapshot for archiving after the account row is gone (delete/disable); opaque to the pool. */
  archiveCtx?: { baseUrl: string; cred: Credential; route: string; boundProxyId: string | null };
}

export interface PoolCallbacks {
  /** Account still schedulable (exists, active, approved)? Dead account => archive all its sessions. */
  isAccountAlive(accountId: string): boolean;
  /** Fire-and-forget upstream archive of the session. */
  archive(entry: PoolEntry): void;
}

export interface PoolOptions {
  maxTurns?: number; // default 50
  idleMs?: number; // default 30 min
  now?: () => number;
}

const keyOf = (accountId: string, model: string, stickyKey: string) => `${accountId}${model}${stickyKey}`;

export class CcrSessionPool {
  private readonly byKey = new Map<string, PoolEntry>();
  private readonly cb: PoolCallbacks;
  private readonly maxTurns: number;
  private readonly idleMs: number;
  private readonly now: () => number;
  readonly stats = { hit: 0, miss: 0, created: 0, archived: 0 };

  constructor(cb: PoolCallbacks, opts: PoolOptions = {}) {
    this.cb = cb;
    this.maxTurns = opts.maxTurns ?? 50;
    this.idleMs = opts.idleMs ?? 30 * 60_000;
    this.now = opts.now ?? (() => Date.now());
  }

  get size(): number {
    return this.byKey.size;
  }

  /** Reusable warm session for this exact key, or null (stickyKey null => never reuse). */
  acquire(accountId: string, model: string, stickyKey: string | null): PoolEntry | null {
    if (!stickyKey) {
      this.stats.miss++;
      return null;
    }
    const e = this.byKey.get(keyOf(accountId, model, stickyKey));
    if (!e || e.busy || e.hadError || e.turns >= this.maxTurns || this.now() - e.lastUsedAt > this.idleMs) {
      this.stats.miss++;
      return null;
    }
    e.busy = true;
    this.stats.hit++;
    return e;
  }

  /** Register a freshly created session; enforces the per-account warm cap by archiving the LRU idle entry. */
  register(
    accountId: string,
    model: string,
    stickyKey: string | null,
    sessionId: string,
    warmCap: number,
    archiveCtx?: PoolEntry["archiveCtx"],
  ): PoolEntry | null {
    this.stats.created++;
    if (!stickyKey) return null; // stateless requests stay unpooled
    const e: PoolEntry = {
      accountId,
      model,
      stickyKey,
      sessionId,
      turns: 0,
      busy: true,
      hadError: false,
      createdAt: this.now(),
      lastUsedAt: this.now(),
      archiveCtx,
    };
    this.byKey.set(keyOf(accountId, model, stickyKey), e);
    const idle = [...this.byKey.values()]
      .filter((x) => x.accountId === accountId && !x.busy)
      .sort((a, b) => a.lastUsedAt - b.lastUsedAt);
    while (this.countAccount(accountId) > warmCap && idle.length > 0) {
      this.retire(idle.shift()!);
    }
    return e;
  }

  /** Request finished. error=true retires + archives the session. */
  release(e: PoolEntry | null, error: boolean): void {
    if (!e) return;
    e.busy = false;
    e.lastUsedAt = this.now();
    if (error) {
      e.hadError = true;
      this.retire(e);
      return;
    }
    e.turns++;
    if (e.turns >= this.maxTurns) this.retire(e);
  }

  /** Session proved gone/broken upstream (e.g. push 404): drop + archive. */
  invalidate(e: PoolEntry | null): void {
    if (!e) return;
    e.hadError = true;
    this.retire(e);
  }

  /** Drop every local handle of an explicitly retired conversation generation. */
  invalidateStickyNamespace(namespace: string): void {
    for (const entry of [...this.byKey.values()]) if (entry.stickyKey.includes(namespace)) this.invalidate(entry);
  }

  private countAccount(accountId: string): number {
    let n = 0;
    for (const x of this.byKey.values()) if (x.accountId === accountId) n++;
    return n;
  }

  private retire(e: PoolEntry): void {
    if (this.byKey.delete(keyOf(e.accountId, e.model, e.stickyKey))) {
      this.stats.archived++;
      this.cb.archive(e);
    }
  }

  /** Reaper: idle-timeout retirements + sessions of deleted/disabled accounts. */
  sweep(): void {
    const now = this.now();
    for (const e of [...this.byKey.values()]) {
      if (now - e.lastUsedAt > this.idleMs || !this.cb.isAccountAlive(e.accountId)) this.retire(e);
    }
  }

  logLine(): string {
    const s = this.stats;
    return `[ccr-pool] hit=${s.hit} miss=${s.miss} created=${s.created} archived=${s.archived} warm=${this.byKey.size}`;
  }
}
