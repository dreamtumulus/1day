// Per-account in-process scheduling gates (docs/onboarding.md §6.3):
// an in-flight request counter (concurrency cap) and a 60s sliding-window
// timestamp list (RPM cap). Both default 0 = unlimited. A rejected acquire is
// NOT a failure: the candidate loop just skips the account, no cooldown.

const RPM_WINDOW_MS = 60_000;

export class AccountGates {
  private readonly inFlight = new Map<string, number>();
  private readonly hits = new Map<string, number[]>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  inFlightCount(accountId: string): number {
    return this.inFlight.get(accountId) ?? 0;
  }

  /** Live in-flight counts (admin console "connections" column, via /internal/inflight). */
  snapshot(): Record<string, number> {
    return Object.fromEntries(this.inFlight);
  }

  rpmCount(accountId: string): number {
    return this.prune(accountId).length;
  }

  private prune(accountId: string): number[] {
    const cutoff = this.now() - RPM_WINDOW_MS;
    const arr = (this.hits.get(accountId) ?? []).filter((t) => t > cutoff);
    if (arr.length === 0) this.hits.delete(accountId);
    else this.hits.set(accountId, arr);
    return arr;
  }

  /** Atomically check both caps and take a slot; false = skip this account. */
  tryAcquire(accountId: string, concurrency: number, rpmLimit: number): boolean {
    if (concurrency > 0 && this.inFlightCount(accountId) >= concurrency) return false;
    if (rpmLimit > 0) {
      const arr = this.prune(accountId);
      if (arr.length >= rpmLimit) return false;
      arr.push(this.now());
      this.hits.set(accountId, arr);
    }
    this.inFlight.set(accountId, this.inFlightCount(accountId) + 1);
    return true;
  }

  release(accountId: string): void {
    const n = this.inFlightCount(accountId) - 1;
    if (n <= 0) this.inFlight.delete(accountId);
    else this.inFlight.set(accountId, n);
  }
}


/** Cross-process leases and RPM history shared by both blue/green instances. */
import { all, one, run, tx } from "@1dayapi/core";
import { randomUUID } from "node:crypto";
export interface AccountLease { id: string; isValid(): boolean; release(): void }
export class SharedAccountGates {
  private readonly owner = randomUUID();
  private readonly held = new Map<string, { accountId: string; lost: boolean; onLost?: () => void }>();
  private readonly compat = new Map<string, AccountLease[]>();
  constructor(private readonly now: () => number = Date.now) {
    const renew = setInterval(() => this.renewLeases(), 30_000);
    renew.unref();
  }
  private lose(id: string): void {
    const item = this.held.get(id);
    if (!item || item.lost) return;
    item.lost = true;
    try { item.onLost?.(); } catch (err) { console.error("[gates] cancellation callback failed", err); }
  }
  renewLeases(): void {
    for (const [id, item] of this.held) {
      if (item.lost) continue;
      try {
        const changed = run("UPDATE gateway_account_leases SET expires_at = ? WHERE id = ? AND owner = ? AND expires_at > ?", this.now() + 90_000, id, this.owner, this.now()).changes;
        if (!changed) this.lose(id);
      } catch (err) { console.error("[gates] lease renewal failed", err); this.lose(id); }
    }
  }
  inFlightCount(accountId: string): number {
    return one<{ n: number }>("SELECT COUNT(*) n FROM gateway_account_leases WHERE account_id = ? AND expires_at > ?", accountId, this.now())?.n ?? 0;
  }
  snapshot(): Record<string, number> {
    return Object.fromEntries(all<{account_id: string; n: number}>("SELECT account_id, COUNT(*) n FROM gateway_account_leases WHERE expires_at > ? GROUP BY account_id", this.now()).map(r => [r.account_id, r.n]));
  }
  rpmCount(accountId: string): number {
    return one<{n: number}>("SELECT COUNT(*) n FROM gateway_account_hits WHERE account_id = ? AND hit_at > ?", accountId, this.now() - RPM_WINDOW_MS)?.n ?? 0;
  }
  acquireLease(accountId: string, concurrency: number, rpmLimit: number, onLost?: () => void): AccountLease | null {
    const id = randomUUID();
    const acquired = tx(() => {
      run("DELETE FROM gateway_account_leases WHERE expires_at <= ?", this.now());
      run("DELETE FROM gateway_account_hits WHERE hit_at <= ?", this.now() - RPM_WINDOW_MS);
      if (concurrency > 0 && this.inFlightCount(accountId) >= concurrency) return false;
      if (rpmLimit > 0 && this.rpmCount(accountId) >= rpmLimit) return false;
      run("INSERT INTO gateway_account_leases(id, account_id, owner, expires_at) VALUES (?, ?, ?, ?)", id, accountId, this.owner, this.now() + 90_000);
      if (rpmLimit > 0) run("INSERT INTO gateway_account_hits(account_id, hit_at) VALUES (?, ?)", accountId, this.now());
      return true;
    });
    if (!acquired) return null;
    this.held.set(id, { accountId, lost: false, onLost });
    return {
      id,
      isValid: () => {
        const item = this.held.get(id);
        if (!item || item.lost) return false;
        try { if (one("SELECT 1 FROM gateway_account_leases WHERE id = ? AND owner = ? AND expires_at > ?", id, this.owner, this.now())) return true; }
        catch { /* database failure fences this request */ }
        this.lose(id); return false;
      },
      release: () => {
        if (!this.held.delete(id)) return;
        try { run("DELETE FROM gateway_account_leases WHERE id = ? AND owner = ?", id, this.owner); }
        catch (err) { console.error("[gates] release failed; lease expires automatically", err); }
      },
    };
  }
  tryAcquire(accountId: string, concurrency: number, rpmLimit: number): boolean {
    const lease = this.acquireLease(accountId, concurrency, rpmLimit);
    if (lease) this.compat.set(accountId, [...(this.compat.get(accountId) ?? []), lease]);
    return !!lease;
  }
  release(accountId: string): void {
    const leases = this.compat.get(accountId);
    leases?.shift()?.release();
    if (!leases?.length) this.compat.delete(accountId);
  }
}
