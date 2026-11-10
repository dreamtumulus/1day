// Worker-path authentication failures (docs/gateway.md §3).
//
// On the worker path no HTTP status reaches us: Claude Code reports a dead
// OAuth session as text ("Failed to authenticate: OAuth token revoked …",
// "OAuth session expired and could not be refreshed"). One such line is not
// proof the account is gone — 2026-10-17 two concurrent refreshes of the same
// account produced exactly these two texts and the account kept working a
// minute later — so a single hit only cools the account for a few minutes;
// repeated hits inside the window escalate to `status = 'error'` like a direct
// 401/403 does, instead of a 30 s cooldown that re-picks the account forever.

const AUTH_FAILURE_RE =
  /Failed to authenticate|OAuth token revoked|OAuth session expired|could not be refreshed|invalid_grant|Please log in again|authentication_error/i;

/** Anthropic's time-boxed per-model org suspension rides inside "Failed to authenticate. API Error: 403 …" — not an auth failure. */
const MODEL_SUSPENDED_RE = /is suspended for this organization/i;

export function isCcAuthFailure(message: string): boolean {
  return AUTH_FAILURE_RE.test(message) && !MODEL_SUSPENDED_RE.test(message);
}

/**
 * Anthropic put the account on hold ("Your account is on hold and can't use
 * Claude Code. View details or appeal: https://claude.ai/restricted"). That is
 * a verdict on the account, not a refresh race: 2026-10-20 73 accounts hit it
 * in one day and, classified as transient, each was re-picked 20–30 more times
 * (559 client 502s) before anything else stopped it. User rule 2026-10-20:
 * one hit → the account is unusable (`status = 'error'`), no threshold.
 */
const ACCOUNT_ON_HOLD_RE = /account is on hold|claude\.ai\/restricted/i;

export function isCcAccountOnHold(message: string): boolean {
  return ACCOUNT_ON_HOLD_RE.test(message);
}

export const AUTH_FAILURE_COOLDOWN_MS = 5 * 60_000;

export class AuthFailureTracker {
  private readonly hits = new Map<string, number[]>();
  constructor(
    private readonly threshold = 3,
    private readonly windowMs = 30 * 60_000,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Record one failure; `escalate` is true when this hit reaches the threshold inside the window. */
  record(accountId: string): { count: number; escalate: boolean } {
    const t = this.now();
    const arr = (this.hits.get(accountId) ?? []).filter((x) => t - x < this.windowMs);
    arr.push(t);
    this.hits.set(accountId, arr);
    return { count: arr.length, escalate: arr.length >= this.threshold };
  }

  /** A served request proves the credentials work: forget earlier hits. */
  clear(accountId: string): void {
    this.hits.delete(accountId);
  }

  /** Tests only. */
  reset(): void {
    this.hits.clear();
  }

  count(accountId: string): number {
    const t = this.now();
    return (this.hits.get(accountId) ?? []).filter((x) => t - x < this.windowMs).length;
  }
}
