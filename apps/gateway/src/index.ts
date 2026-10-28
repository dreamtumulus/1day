import Fastify from "fastify";
import { dbPath } from "@1dayapi/core";
import { config } from "./config.js";
import { CORS_HEADERS, sendError } from "./http.js";
import { affinityBindingsSummary } from "./proxy.js";
import { registerRoutes } from "./routes.js";

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" }, bodyLimit: 32 * 1024 * 1024 });

app.addHook("onRequest", async (req, reply) => {
  if (req.method === "OPTIONS") reply.status(204).headers(CORS_HEADERS).send();
});
app.addHook("onSend", async (_req, reply) => {
  for (const [k, v] of Object.entries(CORS_HEADERS)) reply.header(k, v);
});

app.setNotFoundHandler((req, reply) => {
  sendError(reply, "openai-chat", 404, "not_found", `Unknown route: ${req.method} ${req.url}`, "not_found_error");
});

app.setErrorHandler((err: unknown, req, reply) => {
  const e = err as { statusCode?: number; message?: string };
  const status = e.statusCode && e.statusCode >= 400 && e.statusCode < 500 ? e.statusCode : 500;
  if (status >= 500) req.log.error(err);
  sendError(
    reply,
    "openai-chat",
    status,
    status >= 500 ? "internal_error" : "bad_request",
    status >= 500 ? "Internal gateway error." : (e.message ?? "Bad request"),
    status >= 500 ? "api_error" : "invalid_request_error",
  );
});

registerRoutes(app);

if (config.proofSecretGenerated) {
  app.log.warn("PROOF_SECRET not set; generated a random one. TEE proofs are a local HMAC stub.");
}

try {
  await app.listen({ port: config.port, host: config.host });
  app.log.info(`1dayAPI gateway v3 on ${config.host}:${config.port} (db: ${dbPath})`);
  app.log.info(`affinity: ${affinityBindingsSummary()}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

// Graceful stop (docs/operations.md §4): on SIGTERM stop accepting, let in-flight
// requests — including long worker streams — finish, then exit. systemd's
// TimeoutStopSec is 90 s; give up a little earlier so the unit never gets SIGKILLed.
const DRAIN_MS = Number(process.env.DRAIN_TIMEOUT_MS ?? 75_000);
let stopping = false;
function shutdown(signal: string): void {
  if (stopping) return;
  stopping = true;
  app.log.info(`${signal}: draining in-flight requests (up to ${DRAIN_MS} ms)`);
  const hard = setTimeout(() => {
    app.log.warn("drain timeout reached, exiting with requests still open");
    process.exit(0);
  }, DRAIN_MS);
  hard.unref();
  app.close().then(
    () => {
      app.log.info("drained, exiting");
      process.exit(0);
    },
    (err) => {
      app.log.error(err);
      process.exit(1);
    },
  );
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
