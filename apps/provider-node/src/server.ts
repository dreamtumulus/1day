import crypto from "node:crypto";
import os from "node:os";
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import {
  NodeConfigStore,
  resolvePlatformHttpUrl,
  resolvePlatformWsUrl,
} from "./config.js";
import { CONSOLE_HTML } from "./console-html.js";
import {
  detectLocalCredentials,
  redactCredential,
  type DetectedCredential,
  type Vendor,
} from "./credentials.js";
import type { PlatformBridge } from "./bridge.js";
import type { ProxyPool } from "./proxy-pool.js";
import { NODE_VERSION } from "./version.js";
import { managementToken, validManagementToken } from "./management-auth.js";

// Defaults to loopback-only; set 0.0.0.0 inside a container behind a
// 127.0.0.1-published port (the Host-header whitelist still applies).
export const CONSOLE_HOST = process.env.PROVIDER_CONSOLE_HOST ?? "127.0.0.1";
export const CONSOLE_PORT = Number(process.env.PROVIDER_CONSOLE_PORT ?? 16889);

const ALLOWED_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

function sendError(
  reply: FastifyReply,
  status: number,
  code: string,
  message: string,
  type = "invalid_request_error",
): FastifyReply {
  return reply.status(status).send({ error: { code, message, type } });
}

function runtimeIdentity(): { osType: string; osVersion: string; osArch: string } {
  return { osType: process.platform, osVersion: os.release(), osArch: process.arch };
}

interface PlatformCredentialsCache {
  fetchedAt: number;
  data: unknown[];
}

export interface ServerDeps {
  store: NodeConfigStore;
  bridge: PlatformBridge;
  pool: ProxyPool;
}

export function buildApp(deps: ServerDeps): FastifyInstance {
  const { store, bridge, pool } = deps;
  const app = Fastify({ logger: false });
  const csrfToken = crypto.randomBytes(32).toString("base64url");
  const adminToken = managementToken(store.configPath);
  let credentialsCache: PlatformCredentialsCache | null = null;

  // DNS-rebinding guard: only loopback Host headers.
  app.addHook("onRequest", async (req, reply) => {
    if (req.url === "/") return;
    if (!validManagementToken(req.headers.authorization, adminToken)) {
      return sendError(reply, 401, "management_auth_required", "Local administrator credential required", "authentication_error");
    }
  });

  app.addHook("onRequest", async (req, reply) => {
    const hostHeader = req.headers.host;
    const host = (hostHeader ?? "").split("]").length > 1
      ? (hostHeader ?? "").split("]")[0] + "]"
      : (hostHeader ?? "").split(":")[0];
    if (!ALLOWED_HOSTS.has(host.toLowerCase())) {
      sendError(reply, 403, "forbidden_host", "Host header not allowed", "forbidden_error");
    }
  });

  // CSRF guard on all writes; writes are also loopback-only even when the
  // console is bound to a LAN address (bind/unbind/authorize-local hand out
  // identities and OAuth tokens).
  app.addHook("onRequest", async (req, reply) => {
    if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return;
    const ip = req.socket.remoteAddress ?? "";
    if (!(ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1")) {
      sendError(reply, 403, "loopback_only", "Write operations are only accepted from the local machine", "forbidden_error");
      return;
    }
    if (req.headers["x-1dayapi-csrf"] !== csrfToken) {
      sendError(
        reply,
        403,
        "csrf_token_invalid",
        "Missing or invalid x-1dayapi-csrf header (GET /api/status first and read x-csrf-token)",
        "forbidden_error",
      );
    }
  });

  function nodeAuthHeaders(): Record<string, string> {
    return {
      "x-provider-node-id": store.data.nodeId,
      "x-provider-node-secret": store.data.providerNodeSecret ?? "",
    };
  }

  async function platformFetch(
    path: string,
    init: { method?: string; body?: unknown; auth?: boolean; timeoutMs?: number } = {},
  ): Promise<Response> {
    const base = resolvePlatformHttpUrl(store);
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (init.auth !== false) Object.assign(headers, nodeAuthHeaders());
    return fetch(base + path, {
      method: init.method ?? "GET",
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(init.timeoutMs ?? 10_000),
    });
  }

  app.get("/", async (_req, reply) => {
    reply.type("text/html; charset=utf-8").send(CONSOLE_HTML);
  });

  app.get("/api/status", async (_req, reply) => {
    reply.header("x-csrf-token", csrfToken);
    let credentials: unknown[] = credentialsCache?.data ?? [];
    let credentialsSource: "platform" | "cache" | "none" = credentialsCache ? "cache" : "none";
    if (store.bound) {
      try {
        const res = await platformFetch("/internal/provider/credentials", { timeoutMs: 3_000 });
        if (res.ok) {
          const json = (await res.json()) as { data?: unknown[] };
          credentials = Array.isArray(json.data) ? json.data : [];
          credentialsCache = { fetchedAt: Date.now(), data: credentials };
          credentialsSource = "platform";
        }
      } catch {
        /* platform unreachable: serve cache */
      }
    }
    reply.send({
      nodeId: store.data.nodeId,
      nodeVersion: NODE_VERSION,
      bound: store.bound,
      providerId: store.data.providerId ?? null,
      boundAt: store.data.boundAt ?? null,
      bridge: bridge.status(),
      officialExit: { activeSessions: bridge.status().officialExitActiveSessions },
      httpEgress: { activeSessions: bridge.status().httpEgressActiveSessions },
      proxies: pool.summary(),
      credentials,
      credentialsSource,
      runtime: runtimeIdentity(),
      time: new Date().toISOString(),
    });
  });

  app.post<{ Body: { bindingCode?: string; platformBindUrl?: string } }>(
    "/api/platform/bind",
    async (req, reply) => {
      const bindingCode = req.body?.bindingCode?.trim();
      if (!bindingCode || !bindingCode.startsWith("bind_")) {
        return sendError(reply, 400, "invalid_binding_code", "bindingCode must start with bind_");
      }
      const platformBindUrl = req.body?.platformBindUrl?.trim();
      const base =
        platformBindUrl && platformBindUrl.length > 0
          ? platformBindUrl.replace(/\/+$/, "")
          : resolvePlatformHttpUrl(store);
      if (base !== resolvePlatformHttpUrl(store)) return sendError(reply, 403, "platform_address_pinned", "Configure the platform address in the protected node service configuration");
      let res: Response;
      try {
        res = await fetch(base + "/internal/provider/bind", {
          method: "POST",
          // A node id the platform already knows is only re-bound with proof of its current secret (409 node_already_bound otherwise).
          headers: { "content-type": "application/json", ...(store.data.providerNodeSecret ? { "x-provider-node-secret": store.data.providerNodeSecret } : {}) },
          body: JSON.stringify({
            bindingCode,
            nodeId: store.data.nodeId,
            nodeVersion: NODE_VERSION,
            runtimeIdentity: runtimeIdentity(),
          }),
          signal: AbortSignal.timeout(10_000),
        });
      } catch (err) {
        return sendError(
          reply,
          502,
          "platform_unreachable",
          `Cannot reach platform at ${base}: ${(err as Error).message}`,
          "api_error",
        );
      }
      if (!res.ok) {
        const json = (await res.json().catch(() => null)) as {
          error?: { code?: string; message?: string };
        } | null;
        return sendError(
          reply,
          res.status,
          json?.error?.code ?? "bind_failed",
          json?.error?.message ?? `Platform bind failed with HTTP ${res.status}`,
          res.status === 401 ? "authentication_error" : "api_error",
        );
      }
      const json = (await res.json()) as {
        providerId: string;
        nodeId?: string;
        providerNodeSecret: string;
        platformWsUrl?: string;
      };
      if (!json.providerId || !json.providerNodeSecret) {
        return sendError(reply, 502, "bad_platform_response", "Platform bind response missing fields", "api_error");
      }
      store.setBinding({
        providerId: json.providerId,
        providerNodeSecret: json.providerNodeSecret,
        platformWsUrl: json.platformWsUrl,
        platformHttpUrl: base,
      });
      credentialsCache = null;
      bridge.reconnectNow();
      reply.send({
        ok: true,
        providerId: json.providerId,
        nodeId: store.data.nodeId,
        platformWsUrl: resolvePlatformWsUrl(store),
      });
    },
  );

  app.post("/api/platform/unbind", async (_req, reply) => {
    if (!store.bound) {
      store.resetBinding();
      bridge.reconnectNow();
      return reply.send({ ok: true, note: "not_bound" });
    }
    let platformOk = false;
    let platformError: string | null = null;
    try {
      const res = await platformFetch("/internal/provider/unbind", { method: "POST" });
      platformOk = res.ok;
      if (!res.ok) platformError = `HTTP ${res.status}`;
      if (res.status === 409) {
        // The platform refuses to drop a node that still carries accounts or shares its proxies: keep the local binding,
        // or the node goes offline while the platform still schedules onto it. Remove it in the console (which can force).
        const detail = await res.text().catch(() => "");
        return sendError(reply, 409, "platform_refused_unbind", `The platform refused to unbind this node: ${detail.slice(0, 400) || "HTTP 409"}`);
      }
    } catch (err) {
      platformError = (err as Error).message;
    }
    store.resetBinding();
    credentialsCache = null;
    bridge.reconnectNow();
    reply.send({ ok: true, platformAcknowledged: platformOk, platformError });
  });

  app.get("/api/oauth/local/detect", async (_req, reply) => {
    const found = detectLocalCredentials();
    reply.send({ data: found.map(redactCredential) });
  });

  async function uploadCredential(
    cred: Omit<DetectedCredential, "source">,
  ): Promise<{ credentialBindingId: string }> {
    const res = await platformFetch("/internal/provider/credentials", {
      method: "POST",
      body: {
        vendor: cred.vendor,
        accessToken: cred.accessToken,
        refreshToken: cred.refreshToken,
        expiresAt: cred.expiresAt,
        tokenType: cred.tokenType,
        scope: cred.scope,
        accountEmail: cred.accountEmail,
        subscriptionType: cred.subscriptionType,
        accountId: cred.accountId,
      },
    });
    const json = (await res.json().catch(() => null)) as {
      credentialBindingId?: string;
      error?: { code?: string; message?: string };
    } | null;
    if (!res.ok || !json?.credentialBindingId) {
      throw new Error(
        json?.error?.message ?? json?.error?.code ?? `Platform rejected credential (HTTP ${res.status})`,
      );
    }
    return { credentialBindingId: json.credentialBindingId };
  }

  function requireBound(reply: FastifyReply): boolean {
    if (!store.bound) {
      sendError(reply, 409, "not_bound", "Node is not bound to a provider account yet");
      return false;
    }
    return true;
  }

  app.post<{ Body: { vendor?: string; vendors?: string[] } }>(
    "/api/platform/credentials/authorize-local",
    async (req, reply) => {
      if (!requireBound(reply)) return;
      const wanted = new Set<string>(
        req.body?.vendors ?? (req.body?.vendor ? [req.body.vendor] : ["anthropic", "openai"]),
      );
      const found = detectLocalCredentials().filter((c) => wanted.has(c.vendor));
      if (found.length === 0) {
        return sendError(reply, 404, "no_local_credentials", "No matching local credentials detected");
      }
      const uploaded: Array<{ vendor: Vendor; credentialBindingId: string }> = [];
      const errors: Array<{ vendor: Vendor; message: string }> = [];
      for (const cred of found) {
        try {
          const { source: _source, ...payload } = cred;
          const r = await uploadCredential(payload);
          uploaded.push({ vendor: cred.vendor, credentialBindingId: r.credentialBindingId });
        } catch (err) {
          errors.push({ vendor: cred.vendor, message: (err as Error).message });
        }
      }
      credentialsCache = null;
      reply.send({ data: uploaded, errors });
    },
  );

  app.post<{ Body: { vendor?: string; tokenJson?: unknown } }>(
    "/api/platform/credentials/authorize-token",
    async (req, reply) => {
      if (!requireBound(reply)) return;
      const vendor = req.body?.vendor;
      if (vendor !== "anthropic" && vendor !== "openai") {
        return sendError(reply, 400, "invalid_vendor", "vendor must be anthropic or openai");
      }
      let parsed: Record<string, unknown>;
      try {
        parsed =
          typeof req.body?.tokenJson === "string"
            ? (JSON.parse(req.body.tokenJson) as Record<string, unknown>)
            : ((req.body?.tokenJson ?? {}) as Record<string, unknown>);
      } catch {
        return sendError(reply, 400, "invalid_token_json", "tokenJson is not valid JSON");
      }
      const accessToken =
        (typeof parsed.accessToken === "string" && parsed.accessToken) ||
        (typeof parsed.access_token === "string" && parsed.access_token) ||
        "";
      if (!accessToken) {
        return sendError(reply, 400, "invalid_token_json", "tokenJson must contain accessToken (or access_token)");
      }
      const refreshToken =
        (typeof parsed.refreshToken === "string" && parsed.refreshToken) ||
        (typeof parsed.refresh_token === "string" && parsed.refresh_token) ||
        undefined;
      const expiresAt =
        (typeof parsed.expiresAt === "string" && parsed.expiresAt) ||
        (typeof parsed.expires_at === "string" && parsed.expires_at) ||
        (typeof parsed.expiresAt === "number" ? new Date(parsed.expiresAt).toISOString() : undefined) ||
        (typeof parsed.expires_in === "number"
          ? new Date(Date.now() + parsed.expires_in * 1000).toISOString()
          : undefined);
      try {
        const r = await uploadCredential({
          vendor,
          accessToken,
          refreshToken,
          expiresAt,
          tokenType: typeof parsed.tokenType === "string" ? parsed.tokenType : "Bearer",
          scope: typeof parsed.scope === "string" ? parsed.scope : undefined,
          accountEmail: typeof parsed.accountEmail === "string" ? parsed.accountEmail : undefined,
          subscriptionType:
            typeof parsed.subscriptionType === "string" ? parsed.subscriptionType : undefined,
        });
        credentialsCache = null;
        reply.send({ ok: true, credentialBindingId: r.credentialBindingId });
      } catch (err) {
        sendError(reply, 502, "credential_upload_failed", (err as Error).message, "api_error");
      }
    },
  );

  app.setNotFoundHandler((req, reply) => {
    sendError(reply, 404, "not_found", `Unknown route: ${req.method} ${req.url}`);
  });

  return app;
}
