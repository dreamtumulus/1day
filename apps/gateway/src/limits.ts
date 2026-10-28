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
