import crypto from "node:crypto";

function stripTrailingSlash(s: string): string {
  return s.replace(/\/+$/, "");
}

const proofSecretGenerated = !process.env.PROOF_SECRET;

export const config = {
  port: Number(process.env.PORT ?? 8400),
  host: process.env.HOST ?? "0.0.0.0",
  /** Console base for the provider tunnel manager (loopback). */
  consoleBase: stripTrailingSlash(process.env.CONSOLE_BASE ?? "http://127.0.0.1:8401"),
  /** Max accounts tried per request before giving up (docs/v3-design.md §7.3). */
  maxAttempts: Number(process.env.GATEWAY_MAX_ATTEMPTS ?? 3),
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
