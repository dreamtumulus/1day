import cors from "@fastify/cors";
import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import { HttpError, sendError } from "./http.js";
import { startWindowPoller } from "./ccr/window-poll.js";
import { startCacheRefundScheduler } from "./cache-refund-scheduler.js";
import { sweepStaleJobs } from "./onboard/jobs.js";
import { registerNodeRoutes } from "./node/routes.js";
import { registerAdminRoutes } from "./routes/admin.js";
import { registerOnboardingRoutes } from "./routes/onboarding.js";
import { registerOnboarderRoutes } from "./routes/onboarder.js";
import { registerProviderRoutes } from "./routes/provider.js";
import { registerPublicRoutes } from "./routes/public.js";
import { registerUserRoutes } from "./routes/user.js";
import { cleanupSessions, ensureInitialAdmin } from "./session.js";

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? "info" },
    bodyLimit: 32 * 1024 * 1024, // cc_worker open envelopes may carry base64 images (gateway bodyLimit is 32 MiB too)
    // Behind nginx set TRUST_PROXY=1 so req.ip is the real client (login
    // rate limiting). Internal endpoints check the socket address instead.
    trustProxy: process.env.TRUST_PROXY === "1",
  });

  const origins = (process.env.CONSOLE_CORS_ORIGINS ?? "http://localhost:8402,http://127.0.0.1:8402")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  await app.register(cors, { origin: origins, credentials: true });

  app.setErrorHandler((err: FastifyError | HttpError, req, reply) => {
    if (err instanceof HttpError) return sendError(reply, err.status, err.code, err.message);
    const status = err.statusCode && err.statusCode >= 400 && err.statusCode < 500 ? err.statusCode : 500;
    if (status >= 500) req.log.error(err);
    return sendError(
      reply,
      status,
      status >= 500 ? "internal_error" : (err.code?.toLowerCase() ?? "bad_request"),
      status >= 500 ? "Internal server error" : err.message,
    );
  });
  app.setNotFoundHandler((_req, reply) => sendError(reply, 404, "not_found", "Route not found"));

  ensureInitialAdmin((msg) => app.log.info(msg));
  cleanupSessions();
  setInterval(cleanupSessions, 3_600_000).unref();
  const swept = sweepStaleJobs();
  if (swept) app.log.warn(`onboarding: ${swept} stale job(s) marked failed at boot`);
  startWindowPoller(app.log);
  startCacheRefundScheduler(app.log);

  registerPublicRoutes(app);
  registerUserRoutes(app);
  registerProviderRoutes(app);
  registerAdminRoutes(app);
  registerOnboardingRoutes(app);
  registerOnboarderRoutes(app);
  registerNodeRoutes(app);
  return app;
}
