// Per-request retry caps (review 2026-11-09 A). Pure: proxy.ts owns the state on its request context, so the
// counts survive an organisation switch (which re-enters proxyRequest with the same context).
//
// Before this, `GATEWAY_MAX_ATTEMPTS` only applied to requests without a conversation scope. A request on a group
// with organisation-bound OAuth accounts had no cap at all: it tried every account of the organisation, marked each
// failed, switched to the next organisation and started over, with no deadline — one bad request could cool a whole
// pool (2026-11-01: one forged request, 21 accounts, 651 retries).

export type CapReason = "attempt_cap" | "deadline" | "same_failure";

export interface RetryLimits {
  /** Upstream attempts per client request, across all accounts and organisations. */
  maxTotalAttempts: number;
  /** After this long since the request began, no further attempt is started. */
  retryDeadlineMs: number;
  /** The same failure class on this many consecutive accounts stops the request. */
  sameFailureStreak: number;
}

export interface RetryState {
  attempts: number;
  streakClass: string | null;
  streakCount: number;
  tripped: CapReason | null;
}

export function newRetryState(): RetryState {
  return { attempts: 0, streakClass: null, streakCount: 0, tripped: null };
}

/** Checked before an attempt starts. The first attempt is never refused by the deadline: it is not a retry. */
export function capBeforeAttempt(state: RetryState, startedAt: number, now: number, limits: RetryLimits): CapReason | null {
  if (state.tripped) return state.tripped;
  if (state.attempts >= limits.maxTotalAttempts) return "attempt_cap";
  if (state.attempts > 0 && now - startedAt >= limits.retryDeadlineMs) return "deadline";
  return null;
}

/**
 * Record how one account's attempt failed. `cls` is null when the failure is proven to be that account's own
 * (dead credential, payment, a rejected usage window, an organisation / model suspension): that ends any streak.
 * Returns true when `cls` has now been seen on `sameFailureStreak` consecutive accounts — the failure follows the
 * request (or the upstream as a whole), not the account, and trying a further account only spreads the damage.
 */
export function noteFailureClass(state: RetryState, cls: string | null, limits: RetryLimits): boolean {
  if (cls === null) {
    state.streakClass = null;
    state.streakCount = 0;
    return false;
  }
  if (state.streakClass === cls) state.streakCount++;
  else { state.streakClass = cls; state.streakCount = 1; }
  return state.streakCount >= limits.sameFailureStreak;
}

/** The upstream's own error type, when the body is an error-shaped JSON document. */
export function upstreamErrorType(body: string): string | null {
  try {
    const j = JSON.parse(body) as { error?: { type?: unknown; code?: unknown } | string; type?: unknown };
    if (!j || typeof j !== "object") return null;
    const e = j.error;
    const t = e && typeof e === "object" ? (e.type ?? e.code) : null;
    if (typeof t === "string" && t) return t.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 48);
    return e !== undefined || j.type === "error" ? "error" : null;
  } catch {
    return null;
  }
}

/**
 * Failure class of an upstream HTTP answer. Direct lane: status + the upstream's error type ("non_json" for an
 * HTML / plain body — a proxy or WAF page). Worker lane: the status alone; its bodies are our own wrapper around
 * free text, which must not be compared.
 */
export function httpFailureClass(status: number, body: string, lane: "direct" | "worker"): string {
  if (lane === "worker") return `worker:http_${status}`;
  return `direct:http_${status}:${upstreamErrorType(body) ?? "non_json"}`;
}

export const NETWORK_FAILURE_CLASS = "network";
