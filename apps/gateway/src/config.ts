import crypto from "node:crypto";

function stripTrailingSlash(s: string): string {
  return s.replace(/\/+$/, "");
}

/** A positive integer from the environment; anything else (unset, 0, negative, NaN) keeps the safe default. */
function posInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return raw !== undefined && raw !== "" && Number.isFinite(n) && n >= 1 ? Math.floor(n) : fallback;
}

const proofSecretGenerated = !process.env.PROOF_SECRET;

export const config = {
  port: Number(process.env.PORT ?? 8400),
  host: process.env.HOST ?? "0.0.0.0",
  /** Console base for the provider tunnel manager (loopback). */
  consoleBase: stripTrailingSlash(process.env.CONSOLE_BASE ?? "http://127.0.0.1:8401"),
  /** Max accounts tried per request before giving up (docs/v3-design.md §7.3). */
  maxAttempts: Number(process.env.GATEWAY_MAX_ATTEMPTS ?? 3),
  /**
   * Retry caps of one client request (review 2026-11-09 A). They hold on every path, including conversations bound to
   * an organisation, where GATEWAY_MAX_ATTEMPTS never applied and one request walked every account of every organisation.
   *  - maxTotalAttempts: upstream attempts per request across all accounts and organisations.
   *  - retryDeadlineMs: no further attempt is started this long after the request began (before the first byte).
   *  - sameFailureStreak: the same failure class on this many consecutive accounts is the request's / the upstream's
   *    problem, not the accounts': the client gets the upstream error, no further account is cooled, no organisation switch.
   */
  maxTotalAttempts: posInt(process.env.GATEWAY_MAX_TOTAL_ATTEMPTS, 6),
  retryDeadlineMs: posInt(process.env.GATEWAY_RETRY_DEADLINE_MS, 120_000),
  sameFailureStreak: posInt(process.env.GATEWAY_SAME_FAILURE_STREAK, 3),
  /**
   * Account-level authentication verdicts (review 2026-11-09 C/D): `status = 'error'` needs this many auth failures of
   * one account inside the window; below it the account only cools for directAuthCooldownMs. The same threshold gates
   * worker-lane signals that are only visible through a quote of process output (screen / stderr tail).
   */
  authFailureThreshold: posInt(process.env.AUTH_FAILURE_THRESHOLD, 3),
  authFailureWindowMs: posInt(process.env.AUTH_FAILURE_WINDOW_MS, 600_000),
  directAuthCooldownMs: posInt(process.env.DIRECT_AUTH_COOLDOWN_MS, 60_000),
  /** Lease / budget renewals (review 2026-11-09 G): tries before an in-flight request is aborted, and the first backoff (doubles). */
  leaseRenewTries: posInt(process.env.LEASE_RENEW_TRIES, 3),
  leaseRenewBackoffMs: posInt(process.env.LEASE_RENEW_BACKOFF_MS, 250),
  /** Upstream response-header timeout. */
  upstreamTimeoutMs: Number(process.env.UPSTREAM_TIMEOUT_MS ?? 300_000),
  /** Max silence between two upstream stream chunks before the stream is abandoned (slot released, request failed). */
  streamIdleTimeoutMs: Number(process.env.STREAM_IDLE_TIMEOUT_MS ?? 120_000),
  proofSecret: process.env.PROOF_SECRET ?? crypto.randomBytes(32).toString("hex"),
  /** CCR (docs/ccr-supply.md): event poll interval, whole-session deadline, per-call HTTP timeout. */
  ccrPollIntervalMs: Number(process.env.CCR_POLL_INTERVAL_MS ?? 1000),
  ccrSessionTimeoutMs: Number(process.env.CCR_SESSION_TIMEOUT_MS ?? 1_200_000), // 20 min since 2026-10-19 (node CC_WORKER_TIMEOUT_MS must match)
  ccrHttpTimeoutMs: Number(process.env.CCR_HTTP_TIMEOUT_MS ?? 60_000),
  /** CCR session pool (§5.3): turns cap, idle retirement, reaper interval. */
  ccrPoolMaxTurns: Number(process.env.CCR_POOL_MAX_TURNS ?? 50),
  ccrPoolIdleMs: Number(process.env.CCR_POOL_IDLE_MS ?? 1_800_000),
  ccrPoolSweepMs: Number(process.env.CCR_POOL_SWEEP_MS ?? 60_000),
  proofSecretGenerated,
  // v1 dev-mock leftovers: protocol v2 (http_egress) lets the node decide the
  // egress target, so the tunnel no longer reads these. Kept for env compat.
  tunnelTargetHostOverride: process.env.PROVIDER_TUNNEL_TARGET_HOST ?? "",
  tunnelTargetPortOverride: process.env.PROVIDER_TUNNEL_TARGET_PORT
    ? Number(process.env.PROVIDER_TUNNEL_TARGET_PORT)
    : 0,
};
