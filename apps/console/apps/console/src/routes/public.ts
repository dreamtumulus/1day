import type { FastifyInstance } from "fastify";
import { getSettings, publicModels, publicPricing } from "@1dayapi/core";
import { body, sendError, str } from "../http.js";
import {
  SESSION_COOKIE,
  clearSessionCookie,
  login,
  logout,
  meShape,
  parseCookies,
  requireAny,
  sessionCookie,
} from "../session.js";

// Brute-force guard for POST /auth/login: 20 failures / 10 min / IP.
const loginFailures = new Map<string, { count: number; resetAt: number }>();

export function registerPublicRoutes(app: FastifyInstance): void {
  app.get("/health", async () => ({ ok: true, service: "console", version: "v3" }));

  app.post("/auth/login", async (req, reply) => {
    const now = Date.now();
    const bucket = loginFailures.get(req.ip);
    if (bucket && bucket.resetAt > now && bucket.count >= 20) {
      return sendError(reply, 429, "too_many_attempts", "Too many failed logins; try again later");
    }
    const key = str(body(req), "key", { required: true, max: 200 })!;
    const res = login(key);
    if (!res.ok) {
      const b = bucket && bucket.resetAt > now ? bucket : { count: 0, resetAt: now + 600_000 };
      b.count++;
      loginFailures.set(req.ip, b);
      return res.code === "user_disabled"
        ? sendError(reply, 401, "user_disabled", "This account is disabled")
        : sendError(reply, 401, "invalid_login_key", "Invalid login key");
    }
    reply.header("set-cookie", sessionCookie(res.token));
    return { data: meShape(res.user) };
  });

  app.get("/auth/me", { preHandler: requireAny }, async (req) => ({ data: meShape(req.user!) }));

  app.post("/auth/logout", async (req, reply) => {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (token) logout(token);
    reply.header("set-cookie", clearSessionCookie());
    return { data: { ok: true } };
  });

  app.get("/api/models", async () => ({ data: publicModels() }));
  app.get("/api/models/pricing", async () => ({ data: publicPricing() }));

  app.get("/api/site", async () => {
    const s = getSettings();
    return { data: { announcement: s.announcement, apiBaseUrl: s.api_base_url } };
  });
}
