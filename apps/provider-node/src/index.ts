import { PlatformBridge } from "./bridge.js";
import { NodeConfigStore, resolvePlatformWsUrl } from "./config.js";
import { ProxyPool } from "./proxy-pool.js";
import { CONSOLE_HOST, CONSOLE_PORT, buildApp } from "./server.js";
import { NODE_VERSION } from "./version.js";
import path from "node:path";

/**
 * Protocol v2 executes egress requests with Bun.fetch so the upstream sees
 * Bun/BoringSSL TLS fingerprints (matching Claude Code). Under Node the
 * fingerprint would silently degrade to OpenSSL, so refuse to serve — the
 * NODE_ALLOW_NODE_RUNTIME=1 escape hatch exists for local development only.
 */
function assertBunRuntime(): void {
  const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
  if (isBun) return;
  if (process.env.NODE_ALLOW_NODE_RUNTIME === "1") {
    console.warn(
      "╔══════════════════════════════════════════════════════════════════════╗\n" +
        "║  WARNING: running under Node.js, NOT Bun.                            ║\n" +
        "║  TLS fingerprint will NOT match Claude Code (OpenSSL vs BoringSSL).  ║\n" +
        "║  NODE_ALLOW_NODE_RUNTIME=1 is a development escape hatch only —      ║\n" +
        "║  NEVER set this on a production provider node.                       ║\n" +
        "╚══════════════════════════════════════════════════════════════════════╝",
    );
    return;
  }
  console.error(
    "[provider-node] fatal: this node must run under Bun (https://bun.sh) — " +
      "the v2 HTTP egress relies on Bun's TLS fingerprint. " +
      "Install: curl -fsSL https://bun.sh/install | bash -s \"bun-v1.4.4\". " +
      "For local development only, set NODE_ALLOW_NODE_RUNTIME=1 to bypass.",
  );
  process.exit(1);
}

let started = false;

export async function main(): Promise<void> {
  // In a `bun build` single-file bundle both cli.ts and index.ts share the
  // bundle URL, so the direct-run check below fires in addition to the CLI
  // dispatch — main() must be idempotent.
  if (started) return;
  started = true;
  assertBunRuntime();
  const store = new NodeConfigStore();
  const pool = new ProxyPool(store, { log: (m) => console.log(m) });
  pool.startHealthChecks();
  const bridge = new PlatformBridge({
    identity: () =>
      store.bound
        ? {
            nodeId: store.data.nodeId,
            providerId: store.data.providerId as string,
            secret: store.data.providerNodeSecret as string,
            wsUrl: resolvePlatformWsUrl(store),
          }
        : null,
    pool,
    dataDir: path.dirname(store.configPath),
    log: (m) => console.log(m),
  });

  const app = buildApp({ store, bridge, pool });
  await app.listen({ host: CONSOLE_HOST, port: CONSOLE_PORT });
  console.log(
    `[provider-node] v${NODE_VERSION} nodeId=${store.data.nodeId} ` +
      `console=http://${CONSOLE_HOST}:${CONSOLE_PORT} config=${store.configPath} ` +
      `proxies=${pool.size} ` +
      `${store.bound ? `bound provider=${store.data.providerId}` : "not bound"}`,
  );
  bridge.start();

  let shuttingDown = false;
  // Graceful stop (2026-10-17: a plain restart killed 12 in-flight customer
  // sessions → 502s): stop accepting, let running sessions finish for up to
  // NODE_DRAIN_MS (default 60 s; systemd TimeoutStopSec is 90 s), then close.
  const drainMs = Math.max(0, Number(process.env.NODE_DRAIN_MS ?? 60_000) || 0);
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[provider-node] ${signal} received, draining (max ${drainMs}ms)`);
    bridge.beginDrain();
    const deadline = Date.now() + drainMs;
    while (bridge.inFlight > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 250));
    console.log(`[provider-node] drain done: ${bridge.inFlight} session(s) still running, shutting down`);
    pool.stopHealthChecks();
    bridge.stop();
    app
      .close()
      .catch(() => undefined)
      .finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 3_000).unref();
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

const isDirectRun =
  process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (isDirectRun) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
