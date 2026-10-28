import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  INTERNAL_HEADER,
  all,
  defaultProtocol,
  encryptJson,
  nowIso,
  one,
  parseIsoInput,
  run,
  verifyInternalToken,
} from "@1dayapi/core";
import { chatgptAccountId } from "../account-input.js";
import { sendError } from "../http.js";
import { ensureBundle } from "./bundle.js";
import {
  attachNode,
  closeTunnel,
  createWsServer,
  generateNodeSecret,
  openTunnel,
  readTunnel,
  sha256Hex,
  verifyNodeSecret,
  writeTunnel,
  type CcWorkerParams,
} from "./registry.js";

// Node <-> platform control plane and gateway tunnel endpoints
// (docs/provider-protocol.md; v3 changes in docs/v3-design.md §8.5).

interface NodeAuth {
  nodeId: string;
  providerId: string;
}

function requireNodeAuth(request: FastifyRequest, reply: FastifyReply): NodeAuth | null {
  const nodeId = request.headers["x-provider-node-id"];
  const secret = request.headers["x-provider-node-secret"];
  const auth =
    typeof nodeId === "string" && typeof secret === "string" && nodeId && secret ? verifyNodeSecret(nodeId, secret) : null;
  if (!auth) {
    sendError(reply, 401, "invalid_provider_secret", "Invalid provider node credentials");
    return null;
  }
  return auth;
}

function isLoopback(request: FastifyRequest): boolean {
  const ip = request.socket.remoteAddress ?? "";
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}

/** Gateway -> console calls: loopback socket AND the shared internal token. */
function requireInternal(request: FastifyRequest, reply: FastifyReply): boolean {
  if (!isLoopback(request) || !verifyInternalToken(request.headers[INTERNAL_HEADER])) {
    sendError(reply, 403, "forbidden", "Internal endpoint");
    return false;
  }
  return true;
}

/** Node-facing credential list (shape from provider-protocol.md). */
function listCredentials(providerId: string) {
  return all<{
    id: string;
    platform: string;
    account_email: string | null;
    subscription_type: string | null;
    status: string;
    review_status: string;
    created_at: string;
  }>(
    `SELECT id, platform, account_email, subscription_type, status, review_status, created_at
     FROM accounts WHERE owner_id = ? AND type = 'oauth' ORDER BY created_at DESC`,
    providerId,
  ).map((r) => ({
    credentialBindingId: r.id,
    vendor: r.platform,
    accountEmail: r.account_email,
    subscriptionType: r.subscription_type,
    status: r.review_status === "approved" ? r.status : r.review_status,
    createdAt: r.created_at,
  }));
}

export function registerNodeRoutes(app: FastifyInstance): void {
  // ---------- WS control plane ----------
  const wss = createWsServer();
  app.server.on("upgrade", (req, socket, head) => {
    let pathname = "";
    try {
      pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    } catch {
      socket.destroy();
      return;
    }
    if (pathname !== "/internal/provider/connect") {
      socket.destroy();
      return;
    }
    const nodeId = req.headers["x-provider-node-id"];
    const secret = req.headers["x-provider-node-secret"];
    const auth = typeof nodeId === "string" && typeof secret === "string" ? verifyNodeSecret(nodeId, secret) : null;
    if (!auth) {
      wss.handleUpgrade(req, socket, head, (ws) => ws.close(4001, "invalid_provider_secret"));
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => attachNode(auth.nodeId, auth.providerId, ws));
  });

  // ---------- node -> platform ----------

  app.post("/internal/provider/bind", async (request, reply) => {
    const body = (request.body ?? {}) as {
      bindingCode?: string;
      nodeId?: string;
      nodeVersion?: string;
      runtimeIdentity?: { osType?: string; osArch?: string };
    };
    const code = typeof body.bindingCode === "string" ? body.bindingCode : "";
    const nodeId = typeof body.nodeId === "string" ? body.nodeId.slice(0, 120) : "";
    if (!code || !nodeId) return sendError(reply, 400, "invalid_request", "bindingCode and nodeId are required");
    const now = nowIso();
    const claim = run("UPDATE node_bind_codes SET used_at = ? WHERE code = ? AND used_at IS NULL AND expires_at > ?", now, code, now);
    if (claim.changes === 0) {
      return sendError(reply, 401, "invalid_binding_code", "Binding code is invalid or expired");
    }
    const providerId = one<{ provider_id: string }>("SELECT provider_id FROM node_bind_codes WHERE code = ?", code)!.provider_id;
    const existing = one<{ provider_id: string }>("SELECT provider_id FROM nodes WHERE node_id = ?", nodeId);
    if (existing && existing.provider_id !== providerId) {
      return sendError(reply, 409, "node_bound_elsewhere", "This node id is bound to another provider; unbind it first");
    }
    const secret = generateNodeSecret();
    run(
      `INSERT INTO nodes (node_id, provider_id, secret_hash, node_version, os_type, os_arch, online, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?)
       ON CONFLICT(node_id) DO UPDATE SET secret_hash = excluded.secret_hash, node_version = excluded.node_version,
         os_type = excluded.os_type, os_arch = excluded.os_arch, online = 0`,
      nodeId,
      providerId,
      sha256Hex(secret),
      typeof body.nodeVersion === "string" ? body.nodeVersion.slice(0, 40) : null,
      typeof body.runtimeIdentity?.osType === "string" ? body.runtimeIdentity.osType.slice(0, 40) : null,
      typeof body.runtimeIdentity?.osArch === "string" ? body.runtimeIdentity.osArch.slice(0, 40) : null,
      now,
    );
    const proto = request.headers["x-forwarded-proto"] === "https" ? "wss" : "ws";
    const host = request.headers.host ?? `127.0.0.1:${process.env.PORT ?? 8401}`;
    const platformWsUrl = process.env.PLATFORM_WS_URL ?? `${proto}://${host}/internal/provider/connect`;
    return { providerId, nodeId, providerNodeSecret: secret, platformWsUrl };
  });

  app.post("/internal/provider/unbind", async (request, reply) => {
    const auth = requireNodeAuth(request, reply);
    if (!auth) return reply;
    run("DELETE FROM nodes WHERE node_id = ?", auth.nodeId);
    run("UPDATE accounts SET node_id = NULL WHERE node_id = ?", auth.nodeId);
    return { ok: true };
  });

  app.get("/internal/provider/status", async (request, reply) => {
    const auth = requireNodeAuth(request, reply);
    if (!auth) return reply;
    const row = one<{ online: number }>("SELECT online FROM nodes WHERE node_id = ?", auth.nodeId);
    return {
      providerId: auth.providerId,
      nodeId: auth.nodeId,
      online: row?.online === 1,
      credentials: listCredentials(auth.providerId),
    };
  });

  app.get("/internal/provider/credentials", async (request, reply) => {
    const auth = requireNodeAuth(request, reply);
    if (!auth) return reply;
    return { data: listCredentials(auth.providerId) };
  });

  app.post("/internal/provider/credentials", async (request, reply) => {
    const auth = requireNodeAuth(request, reply);
    if (!auth) return reply;
    const b = (request.body ?? {}) as Record<string, unknown>;
    const vendor = typeof b.vendor === "string" ? b.vendor.trim() : "";
    const accessToken = typeof b.accessToken === "string" ? b.accessToken : "";
    if ((vendor !== "anthropic" && vendor !== "openai") || !accessToken) {
      return sendError(reply, 400, "invalid_request", "vendor (anthropic|openai) and accessToken are required");
    }
    const refreshToken = typeof b.refreshToken === "string" && b.refreshToken ? b.refreshToken : undefined;
    const expiresAt = parseIsoInput(b.expiresAt) ?? undefined;
    const accountId =
      (typeof b.accountId === "string" && b.accountId) || (vendor === "openai" ? chatgptAccountId(accessToken) : undefined);
    const email = typeof b.accountEmail === "string" ? b.accountEmail.slice(0, 200) : null;
    const id = `cred_${randomUUID()}`;
    const now = nowIso();
    // Uploaded subscription accounts wait for admin review (docs/v3-design.md §5.2).
    run(
      `INSERT INTO accounts (id, name, platform, type, protocol, credential_enc, owner_id, route, node_id,
                             review_status, account_email, subscription_type, created_at, updated_at)
       VALUES (?, ?, ?, 'oauth', ?, ?, ?, 'node', NULL, 'pending', ?, ?, ?, ?)`,
      id,
      email ?? `${vendor}-${id.slice(5, 13)}`,
      vendor,
      defaultProtocol(vendor),
      encryptJson({ accessToken, refreshToken, expiresAt, accountId }),
      auth.providerId,
      email,
      typeof b.subscriptionType === "string" ? b.subscriptionType.slice(0, 60) : null,
      now,
      now,
    );
    return { credentialBindingId: id };
  });

  // ---------- gateway -> console tunnel (loopback + internal token) ----------

  app.post("/internal/tunnel/open", async (request, reply) => {
    if (!requireInternal(request, reply)) return reply;
    const b = (request.body ?? {}) as {
      accountId?: string;
      targetHost?: string;
      targetPort?: number;
      kind?: string;
      /** Protocol v2 (docs/onboarding.md §6.2): pin the egress session to this pool proxy. */
      proxyId?: string;
      /** kind="cc_worker" (docs/ccr-supply.md §8.1): worker spawn parameters. */
      model?: string;
      prompt?: string;
      stream?: boolean;
      cred?: { accessToken?: unknown; refreshToken?: unknown; expiresAt?: unknown; subscriptionType?: unknown };
    };
    if (typeof b.accountId !== "string" || !b.accountId) {
      return sendError(reply, 400, "invalid_request", "accountId is required");
    }
    // Protocol v2: kind "http_egress" runs the HTTP request on the node
    // (no targetHost/targetPort); kind "cc_worker" spawns a real Claude Code
    // process; anything else is the v1 byte relay.
    const kind = b.kind === "http_egress" || b.kind === "cc_worker" ? b.kind : "official_exit";
    if (kind === "official_exit" && (typeof b.targetHost !== "string" || !b.targetHost)) {
      return sendError(reply, 400, "invalid_request", "targetHost is required for official_exit tunnels");
    }
    let worker: CcWorkerParams | undefined;
    if (kind === "cc_worker") {
      const acc = one<{ executor: string }>("SELECT executor FROM accounts WHERE id = ?", b.accountId);
      if (acc && acc.executor !== "ccr_worker") {
        return sendError(reply, 400, "invalid_request", "cc_worker tunnels require an executor=ccr_worker account");
      }
      const cred = b.cred ?? {};
      if (
        typeof b.model !== "string" || !b.model ||
        typeof b.prompt !== "string" || !b.prompt ||
        typeof cred.accessToken !== "string" || !cred.accessToken
      ) {
        return sendError(reply, 400, "invalid_request", "cc_worker requires model, prompt and cred.accessToken");
      }
      worker = {
        model: b.model,
        prompt: b.prompt,
        stream: b.stream === true,
        cred: {
          accessToken: cred.accessToken,
          refreshToken: typeof cred.refreshToken === "string" ? cred.refreshToken : undefined,
          expiresAt:
            typeof cred.expiresAt === "number" || typeof cred.expiresAt === "string" ? cred.expiresAt : undefined,
          subscriptionType: typeof cred.subscriptionType === "string" ? cred.subscriptionType : undefined,
        },
      };
    }
    const opened = await openTunnel(
      b.accountId,
      kind,
      b.targetHost,
      typeof b.targetPort === "number" ? b.targetPort : 443,
      typeof b.proxyId === "string" && b.proxyId ? b.proxyId : undefined,
      worker,
    );
    if (!opened) return sendError(reply, 503, "no_online_node", "No online node accepted the session");
    return { sessionId: opened.sessionId, nodeId: opened.nodeId };
  });

  app.post("/internal/tunnel/:sessionId/data", async (request, reply) => {
    if (!requireInternal(request, reply)) return reply;
    const { sessionId } = request.params as { sessionId: string };
    const b = (request.body ?? {}) as { payloadBase64?: string };
    if (typeof b.payloadBase64 !== "string") return sendError(reply, 400, "invalid_request", "payloadBase64 is required");
    if (!writeTunnel(sessionId, Buffer.from(b.payloadBase64, "base64"))) {
      return sendError(reply, 404, "session_not_found", "Tunnel session not found or closed");
    }
    return { ok: true };
  });

  app.get("/internal/tunnel/:sessionId/read", async (request, reply) => {
    if (!requireInternal(request, reply)) return reply;
    const { sessionId } = request.params as { sessionId: string };
    const { timeout } = request.query as { timeout?: string };
    const ms = Number(timeout ?? 25_000);
    const result = await readTunnel(sessionId, Number.isFinite(ms) ? ms : 25_000);
    if (!result) return sendError(reply, 404, "session_not_found", "Tunnel session not found");
    return result;
  });

  app.post("/internal/tunnel/:sessionId/close", async (request, reply) => {
    if (!requireInternal(request, reply)) return reply;
    const { sessionId } = request.params as { sessionId: string };
    closeTunnel(sessionId);
    return { ok: true };
  });

  // ---------- node bundle download (protocol v2 deploy) ----------
  // Auth: internal token from loopback, OR a one-time bind code (?code=).
  // A bind code is consumed by the download; the matching node was already
  // registered platform-side by the deploy endpoint, so the node itself
  // never needs to redeem it.
  app.get("/internal/provider/bundle", async (request, reply) => {
    const { code } = request.query as { code?: string };
    const internalOk = isLoopback(request) && verifyInternalToken(request.headers[INTERNAL_HEADER]);
    if (!internalOk) {
      if (!code) return sendError(reply, 401, "invalid_binding_code", "A valid binding code is required");
      const now = nowIso();
      const claim = run(
        "UPDATE node_bind_codes SET used_at = ? WHERE code = ? AND used_at IS NULL AND expires_at > ?",
        now,
        code,
        now,
      );
      if (claim.changes === 0) {
        return sendError(reply, 401, "invalid_binding_code", "Binding code is invalid, expired or already used");
      }
    }
    let bundle;
    try {
      bundle = await ensureBundle();
    } catch (err) {
      request.log.error(err);
      return sendError(reply, 503, "bundle_unavailable", (err as Error).message);
    }
    reply.header("content-type", "application/octet-stream");
    reply.header("content-disposition", 'attachment; filename="node-bundle.js"');
    reply.header("x-bundle-sha256", bundle.sha256);
    return reply.send(createReadStream(bundle.path));
  });
}
