import { assertNodeCapacity } from "./capacity.js";
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
  tx,
  verifyInternalToken,
} from "@1dayapi/core";
import { chatgptAccountId } from "../account-input.js";
import { sendError } from "../http.js";
import { enqueueArchive } from "./archive-cleanup.js";
import { importOAuthCredential } from "../onboard/jobs.js";
import { forceRequested, removeNode } from "./removal.js";
import { ensureBundle } from "./bundle.js";
import { SHIM_SOURCE, codePurpose, shimPath } from "./deploy.js";
import {
  attachNode,
  closeTunnel,
  disconnectNode,
  createWsServer,
  generateNodeSecret,
  openTunnel,
  readTunnel,
  resetIsolationSessions,
  sha256Hex,
  verifyNodeSecret,
  validIsolation,
  writeTunnel,
  type CcWorkerParams,
  type IsolationContext,
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

/** Headers a reverse proxy / CDN adds. The gateway's own loopback calls (apps/gateway/src/tunnel.ts) send none of them. */
const FORWARDED_HEADERS = ["x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "x-real-ip", "cf-connecting-ip", "cf-ray", "true-client-ip", "forwarded", "via"] as const;

/**
 * A call made on this machine, not one relayed to us (review fix 2026-11-10). The socket address alone proves nothing:
 * behind nginx every public request arrives from 127.0.0.1, so `/internal/tunnel/*` was reachable from the internet
 * with only the internal token in the way. A request that carries any forwarding header came through the reverse
 * proxy and is refused as non-local. (A client cannot strip these: nginx sets them. Operators should also block the
 * paths in nginx — see docs/provider-protocol.md / the release note.)
 */
function isLoopback(request: FastifyRequest): boolean {
  const ip = request.socket.remoteAddress ?? "";
  if (!(ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1")) return false;
  for (const h of FORWARDED_HEADERS) if (request.headers[h] !== undefined) return false;
  return true;
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
function listCredentials(providerId: string,nodeId:string) {
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
     FROM accounts WHERE type='oauth' AND (node_id=? OR (owner_id=? AND node_id IS NULL)) ORDER BY created_at DESC`,
    nodeId,providerId,
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
    // Review fix 2026-11-10. Bundle / shim download codes live in the same table as bind codes and used to be
    // accepted here: whoever saw a deploy's download URL could register a node under the deploying admin, or — through
    // the ON CONFLICT below — replace an existing node's secret and take the node over. Now:
    //  (1) only a code issued for binding (prefix bind_) binds; download codes (dl_…) are refused without being spent;
    //  (2) a node id that already exists is never re-keyed by a code alone: the caller must also prove it holds the
    //      node's current secret (x-provider-node-secret, or currentSecret in the body). Otherwise remove the node in
    //      the console first and bind again.
    if (codePurpose(code) !== "bind") return sendError(reply, 401, "invalid_binding_code", "Binding code is invalid or expired");
    const row = one<{ provider_id: string }>("SELECT provider_id FROM node_bind_codes WHERE code = ? AND used_at IS NULL AND expires_at > ?", code, now);
    if (!row) return sendError(reply, 401, "invalid_binding_code", "Binding code is invalid or expired");
    const providerId = row.provider_id;
    const existing = one<{ provider_id: string }>("SELECT provider_id FROM nodes WHERE node_id = ?", nodeId);
    if (existing && existing.provider_id !== providerId) {
      return sendError(reply, 409, "node_bound_elsewhere", "This node id is bound to another provider; unbind it first");
    }
    if (existing) {
      const headerSecret = request.headers["x-provider-node-secret"];
      const current = typeof headerSecret === "string" && headerSecret ? headerSecret
        : typeof (body as { currentSecret?: unknown }).currentSecret === "string" ? String((body as { currentSecret?: unknown }).currentSecret) : "";
      if (!current || !verifyNodeSecret(nodeId, current)) {
        return sendError(reply, 409, "node_already_bound", "This node id is already bound; a binding code alone cannot replace its secret. Remove the node in the console first (or send the node's current secret) and bind again");
      }
    }
    const claim = run("UPDATE node_bind_codes SET used_at = ? WHERE code = ? AND used_at IS NULL AND expires_at > ?", now, code, now);
    if (claim.changes === 0) {
      return sendError(reply, 401, "invalid_binding_code", "Binding code is invalid or expired");
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
    // Review fix 2026-11-10: a node that still carries accounts answers 409 node_has_dependents unless it sends
    // {force:true}; it can never remove proxies other nodes share (409 node_shared_with_other_nodes, administrator only).
    removeNode(auth.nodeId, "node unbound", { force: forceRequested(request) ? "own" : "none" });
    disconnectNode(auth.nodeId,"node_unbound");
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
      credentials: listCredentials(auth.providerId,auth.nodeId),
    };
  });

  app.get("/internal/provider/credentials", async (request, reply) => {
    const auth = requireNodeAuth(request, reply);
    if (!auth) return reply;
    return { data: listCredentials(auth.providerId,auth.nodeId) };
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
    // A platform (admin-deployed) node carries platform-owned accounts pinned to
    // it: owner NULL, no payout — never an "account owned by the admin user".
    const owner = one<{ role: string }>("SELECT role FROM users WHERE id = ?", auth.providerId);
    const platformNode = owner?.role !== "provider";
    if(vendor==='anthropic'){
      const expected=typeof b.orgUuid==='string'?b.orgUuid:undefined;
      const verifiedId=await importOAuthCredential(platformNode?'admin':'provider',auth.providerId,auth.nodeId,
        {accessToken,refreshToken,expiresAt,accountId},
        {ownerId:platformNode?null:auth.providerId,expectedTeamId:expected,name:email??undefined});
      return {credentialBindingId:verifiedId};
    }
    tx(()=>{
    assertNodeCapacity(auth.nodeId);
    run(
      `INSERT INTO accounts (id, name, platform, type, protocol, credential_enc, owner_id, route, node_id,
                             review_status, account_email, subscription_type, created_at, updated_at)
       VALUES (?, ?, ?, 'oauth', ?, ?, ?, 'node', ?, 'pending', ?, ?, ?, ?)`,
      id,
      email ?? `${vendor}-${id.slice(5, 13)}`,
      vendor,
      defaultProtocol(vendor),
      encryptJson({ accessToken, refreshToken, expiresAt, accountId }),
      platformNode ? null : auth.providerId,
      auth.nodeId,
      email,
      typeof b.subscriptionType === "string" ? b.subscriptionType.slice(0, 60) : null,
      now,
      now,
    );
    });
    return { credentialBindingId: id };
  });

  // ---------- gateway -> console tunnel (loopback + internal token) ----------

  app.post("/internal/tunnel/open", async (request, reply) => {
    if (!requireInternal(request, reply)) return reply;
    const b = (request.body ?? {}) as {
      accountId?: string;
      isolation?: IsolationContext;
      targetHost?: string;
      targetPort?: number;
      kind?: string;
      /** Protocol v2 (docs/onboarding.md §6.2): pin the egress session to this pool proxy. */
      proxyId?: string;
      /** http_egress: upstream response-headers deadline the node should apply (ms). */
      headersTimeoutMs?: number;
      /** kind="cc_worker" (docs/ccr-supply.md §8.1): worker spawn parameters. */
      model?: string;
      prompt?: string;
      systemPrompt?: string;
      /** Canonical worker (spec WP2). */
      mode?: string;
      profileId?: string;
      appendSystemPrompt?: string;
      nativeSessionId?: string;
      builtInToolProfile?: string;
      jsonSchema?: unknown;
      nativeSession?: unknown;
      historyImport?: unknown;
      thinkingBudget?: number;
      effort?: string;
      maxTokens?: number;
      persist?: boolean;
      reuseKey?: string;
      turnMode?: string;
      expectedTurn?: number;
      tools?: unknown;
      results?: unknown;
      /** Optional Messages-style content blocks (text + images) for stream-json input (docs/ccr-supply.md §8.1). */
      content?: unknown;
      /** turnMode "continue": full conversation for the node's fresh fallback (worker-sessions.md §1). */
      history?: unknown;
      stream?: boolean;
      cred?: { accessToken?: unknown; refreshToken?: unknown; expiresAt?: unknown; subscriptionType?: unknown };
    };
    if (typeof b.accountId !== "string" || !b.accountId) {
      return sendError(reply, 400, "invalid_request", "accountId is required");
    }
    if (b.isolation !== undefined && !validIsolation(b.isolation)) return sendError(reply, 400, "invalid_isolation", "A valid team, conversation and generation are required");
    // Protocol v2 only: kind "http_egress" runs the HTTP request on the node (through its pinned
    // proxy); kind "cc_worker" spawns a real Claude Code process. The v1 byte relay (official_exit,
    // node-address egress without a proxy) is retired on both sides (2026-10-29).
    const kind = b.kind === "http_egress" || b.kind === "cc_worker" ? b.kind : null;
    if (!kind) return sendError(reply, 400, "invalid_request", "kind must be http_egress or cc_worker (official_exit is retired)");
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
        ...(typeof b.systemPrompt === "string" && b.systemPrompt ? { systemPrompt: b.systemPrompt } : {}),
        ...(b.mode === "canonical"
          ? {
              mode: "canonical" as const,
              ...(typeof b.profileId === "string" && b.profileId ? { profileId: b.profileId.slice(0, 64) } : {}),
              ...(typeof b.appendSystemPrompt === "string" && b.appendSystemPrompt ? { appendSystemPrompt: b.appendSystemPrompt } : {}),
              ...(typeof b.nativeSessionId === "string" && /^[0-9a-f-]{36}$/i.test(b.nativeSessionId) ? { nativeSessionId: b.nativeSessionId } : {}),
              ...(b.builtInToolProfile === "tools-disabled-canonical" ? { builtInToolProfile: "tools-disabled-canonical" as const } : { builtInToolProfile: "restricted-default" as const }),
              ...(b.jsonSchema && typeof b.jsonSchema === "object" ? { jsonSchema: b.jsonSchema as Record<string, unknown> } : {}),
              ...(validNativeSession(b.nativeSession) ? { nativeSession: b.nativeSession as { id: string; action: "start" | "resume" | "fork"; revision?: number } } : {}),
              ...(Array.isArray(b.historyImport) && b.historyImport.length > 0 && b.historyImport.length <= 5000 ? { historyImport: b.historyImport as Array<Record<string, unknown>> } : {}),
            }
          : {}),
        ...(typeof b.thinkingBudget === "number" && b.thinkingBudget > 0 ? { thinkingBudget: Math.floor(b.thinkingBudget) } : {}),
        ...(typeof b.effort === "string" && ["low", "medium", "high", "xhigh", "max"].includes(b.effort) ? { effort: b.effort } : {}),
        ...(typeof b.maxTokens === "number" && b.maxTokens > 0 ? { maxTokens: Math.floor(b.maxTokens) } : {}),
        ...(b.persist === true && typeof b.reuseKey === "string" && b.reuseKey
          ? {
              persist: true,
              reuseKey: b.reuseKey.slice(0, 128),
              turnMode: b.turnMode === "continue" ? ("continue" as const) : b.turnMode === "tool_result" ? ("tool_result" as const) : ("fresh" as const),
              expectedTurn: typeof b.expectedTurn === "number" ? b.expectedTurn : undefined,
              ...(Array.isArray(b.tools) && b.tools.length > 0 ? { tools: b.tools as CcWorkerParams["tools"] } : {}),
              ...(Array.isArray(b.results) && b.results.length > 0 ? { results: b.results as CcWorkerParams["results"] } : {}),
            }
          : {}),
        ...(Array.isArray(b.content) && b.content.length > 0 ? { content: b.content as Array<Record<string, unknown>> } : {}),
        ...(b.persist === true && b.turnMode === "continue" && Array.isArray(b.history) && b.history.length > 0 ? { history: b.history as Array<Record<string, unknown>> } : {}),
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
    const abort=new AbortController();
    const disconnected=()=>{if(!reply.raw.writableFinished)abort.abort();};
    request.raw.once("aborted",disconnected);
    reply.raw.once("close",disconnected);
    try {
      const opened = await openTunnel(
        b.accountId, kind, b.targetHost,
        typeof b.targetPort === "number" ? b.targetPort : 443,
        typeof b.proxyId === "string" && b.proxyId ? b.proxyId : undefined,
        worker,
        typeof b.headersTimeoutMs === "number" && b.headersTimeoutMs > 0 ? b.headersTimeoutMs : undefined,
        b.isolation, undefined, abort.signal,
      );
      if(opened && (abort.signal.aborted || reply.raw.destroyed)){
        closeTunnel(opened.sessionId,"caller_cancelled");
        return reply;
      }
      if(!opened)return sendError(reply,503,"no_online_node","No online node accepted the session");
      return {sessionId:opened.sessionId,nodeId:opened.nodeId};
    } finally {
      request.raw.removeListener("aborted",disconnected);
      reply.raw.removeListener("close",disconnected);
    }

  });

  // Restricted cloud-session archive after an account was retired. URL/method are
  // constructed by the helper and historical immutable binding is re-validated.
  app.post("/internal/tunnel/archive", async (request, reply) => {
    if(!requireInternal(request,reply))return reply;
    const b=request.body as Parameters<typeof enqueueArchive>[0];
    if(!b || typeof b!=="object")return sendError(reply,400,"invalid_request","Archive identity is required");
    return enqueueArchive(b);
  });

  app.post("/internal/tunnel/reset", async (request, reply) => {
    if (!requireInternal(request, reply)) return reply;
    const isolation = (request.body as { isolation?: unknown } | null)?.isolation;
    if (!validIsolation(isolation)) return sendError(reply, 400, "invalid_isolation", "Invalid retired conversation generation");
    try { await resetIsolationSessions(isolation); }
    catch { return sendError(reply, 503, "reset_unacknowledged", "An online node has not acknowledged the forced reset"); }
    return { ok: true };
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
    const b = (request.body ?? {}) as { reasonCode?: unknown };
    closeTunnel(sessionId, typeof b.reasonCode === "string" && b.reasonCode ? b.reasonCode.slice(0, 40) : "gateway_closed");
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
      // A bundle download code (dl_bundle_…) or, for the manual install (packaging/install.sh), a provider's own
      // bind code; a shim code does not download the bundle.
      if (!["bundle", "bind"].includes(codePurpose(code) ?? "")) return sendError(reply, 401, "invalid_binding_code", "Binding code is invalid, expired or already used");
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

  // TUI shim download (docs/tui-worker-2026-11-08.md): the static cc-tui-shim binary built by
  // third_party/magpie-claudetui/sync.sh, handed out under the same auth as the bundle (a one-time code of its own).
  app.get("/internal/provider/cc-tui-shim", async (request, reply) => {
    const { code } = request.query as { code?: string };
    const internalOk = isLoopback(request) && verifyInternalToken(request.headers[INTERNAL_HEADER]);
    if (!internalOk) {
      if (!code) return sendError(reply, 401, "invalid_binding_code", "A valid binding code is required");
      if (!["shim", "bind"].includes(codePurpose(code) ?? "")) return sendError(reply, 401, "invalid_binding_code", "Binding code is invalid, expired or already used");
      const now = nowIso();
      const claim = run("UPDATE node_bind_codes SET used_at = ? WHERE code = ? AND used_at IS NULL AND expires_at > ?", now, code, now);
      if (claim.changes === 0) return sendError(reply, 401, "invalid_binding_code", "Binding code is invalid, expired or already used");
    }
    const shim = shimPath();
    if (!shim) return sendError(reply, 503, "shim_unavailable", `${SHIM_SOURCE} is not built on this server`);
    reply.header("content-type", "application/octet-stream");
    reply.header("content-disposition", 'attachment; filename="cc-tui-shim"');
    return reply.send(createReadStream(shim));
  });
}

/** spec §6.3: {id: UUID, action: start|resume|fork, revision?: int} */
function validNativeSession(v: unknown): boolean {
  if (!v || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  return typeof r.id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(r.id) && (r.action === "start" || r.action === "resume" || r.action === "fork") && (r.revision === undefined || Number.isInteger(r.revision));
}
