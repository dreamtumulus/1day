import cors from "@fastify/cors";
import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import { HttpError, sendError } from "./http.js";
import { startWindowPoller } from "./ccr/window-poll.js";
import { startCacheRefundScheduler } from "./cache-refund-scheduler.js";
import { startKeyPolicyJudge } from "./key-policy-judge.js";
import { failInterruptedJobs, sweepStaleJobs, startOnboardingMaintenance } from "./onboard/jobs.js";
import { registerNodeRoutes } from "./node/routes.js";
import { resetNodePresence } from "./node/registry.js";
import { registerAdminRoutes } from "./routes/admin.js";
import { registerOnboardingRoutes } from "./routes/onboarding.js";
import { registerOnboarderRoutes } from "./routes/onboarder.js";
import { registerProviderRoutes } from "./routes/provider.js";
import { registerPublicRoutes } from "./routes/public.js";
import { registerUserRoutes } from "./routes/user.js";
import { cleanupSessions, ensureInitialAdmin } from "./session.js";
import { verifyMasterKey } from "@1dayapi/core";
import { cleanupAudit, registerAuditHook, registerAuditRoutes } from "./audit.js";
import { startArchiveCleanup } from "./node/archive-cleanup.js";
import { registerWorker0Routes } from "./worker0.js";

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? "info" },
    bodyLimit: 32 * 1024 * 1024, // cc_worker open envelopes may carry base64 images (gateway bodyLimit is 32 MiB too)
    // Nginx overwrites XFF using the client address from its trusted CDN chain.
    trustProxy: (process.env.TRUST_PROXY ?? "").split(",").map((v) => v.trim()).filter(Boolean),
  });

  const origins = (process.env.CONSOLE_CORS_ORIGINS ?? "http://localhost:8402,http://127.0.0.1:8402")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  await app.register(cors, { origin: origins, credentials: true });

  app.setErrorHandler((err: FastifyError | HttpError, req, reply) => {
    if (err instanceof HttpError) {
      if (err.details === undefined) return sendError(reply, err.status, err.code, err.message);
      return reply.status(err.status).send({ error: { code: err.code, message: err.message, type: err.status === 403 ? "permission_error" : "invalid_request_error", details: err.details } });
    }
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

  // Refuse to start on a missing / wrong master key (code-review-2026-11-10 §1.1). Never catch MasterKeyError here.
  verifyMasterKey();
  ensureInitialAdmin((msg) => app.log.info(msg));
  cleanupSessions();
  cleanupAudit();
  setInterval(() => {
    cleanupSessions();
    cleanupAudit();
  }, 3_600_000).unref();
  // Audit trail for admin / provider mutations and failed logins (docs/auth.md §3a).
  registerAuditHook(app);
  // Restart hygiene (review fix 2026-11-10): nothing that lived in the previous process is still true. Jobs it was
  // running are failed without tainting their exits; nodes show offline until their control socket is back.
  const interrupted = failInterruptedJobs();
  if (interrupted) app.log.warn(`onboarding: ${interrupted} job(s) interrupted by the restart marked failed (console_restarted; reservations released, exits not quarantined)`);
  const stale = resetNodePresence();
  if (stale) app.log.warn(`registry: ${stale} node(s) were still marked online from the previous process; reset to offline until they reconnect`);
  const swept = sweepStaleJobs();
  const stopOnboardingMaintenance = startOnboardingMaintenance();
  const stopArchiveCleanup = startArchiveCleanup();
  app.addHook("onClose", async () => { stopOnboardingMaintenance(); await stopArchiveCleanup(); });
  if (swept) app.log.warn(`onboarding: ${swept} stale job(s) marked failed at boot`);
  startWindowPoller(app.log);
  startCacheRefundScheduler(app.log);
  startKeyPolicyJudge(app.log);

  registerPublicRoutes(app);
  registerUserRoutes(app);
  registerProviderRoutes(app);
  registerAdminRoutes(app);
  registerAuditRoutes(app);
  registerOnboardingRoutes(app);
  registerOnboarderRoutes(app);
  registerNodeRoutes(app);
  registerWorker0Routes(app);
  return app;
}
