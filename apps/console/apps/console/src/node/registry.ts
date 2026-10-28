import { randomBytes, randomUUID } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import { nowIso, one, run, sha256Hex, type AccountRow } from "@1dayapi/core";

export type WsSocket = WebSocket;

export function createWsServer(): WebSocketServer {
  return new WebSocketServer({ noServer: true });
}

// ---------- types ----------

export interface NodeConn {
  nodeId: string;
  providerId: string;
  socket: WsSocket;
  acceptingSessions: boolean;
}

interface TunnelChunk {
  seq: number;
  payload: Buffer;
}

export interface TunnelSession {
  sessionId: string;
  nodeId: string;
  kind?: TunnelKind;
  credentialBindingId: string;
  queue: TunnelChunk[];
  waiters: Array<() => void>;
  closed: boolean;
  error: string | null;
  outSeq: number;
  lastActivity: number;
}

export interface OpenedTunnel {
  sessionId: string;
  nodeId: string;
}

// ---------- state ----------

const onlineNodes = new Map<string, NodeConn>();
const sessions = new Map<string, TunnelSession>();
const pendingOpens = new Map<
  string,
  {
    nodeId: string;
    resolve: (res: { accepted: boolean; reasonCode?: string }) => void;
    timer: NodeJS.Timeout;
  }
>();
let rrCounter = 0;

const OPEN_RESPONSE_TIMEOUT_MS = 4_000;
const READ_TIMEOUT_CAP_MS = 25_000;
const SESSION_IDLE_MS = 5 * 60_000;

// ---------- auth ----------

export { sha256Hex };

export function verifyNodeSecret(
  nodeId: string,
  secret: string,
): { nodeId: string; providerId: string } | null {
  const row = one<{ provider_id: string; secret_hash: string; status: string }>(
    `SELECT n.provider_id, n.secret_hash, u.status FROM nodes n JOIN users u ON u.id = n.provider_id
     WHERE n.node_id = ?`,
    nodeId,
  );
  if (!row || row.status !== "active" || row.secret_hash !== sha256Hex(secret)) return null;
  return { nodeId, providerId: row.provider_id };
}

/** Close a node's control connection (unbind / provider disabled). */
export function disconnectNode(nodeId: string, reason: string): void {
  const conn = onlineNodes.get(nodeId);
  if (conn) conn.socket.close(4003, reason);
}

// ---------- WS wiring ----------

function send(socket: WsSocket, msg: Record<string, unknown>): void {
  if (socket.readyState === 1) socket.send(JSON.stringify(msg));
}

export function attachNode(nodeId: string, providerId: string, socket: WsSocket): void {
  const existing = onlineNodes.get(nodeId);
  if (existing) existing.socket.close(4000, "superseded");
  const conn: NodeConn = { nodeId, providerId, socket, acceptingSessions: true };
  onlineNodes.set(nodeId, conn);
  run("UPDATE nodes SET online = 1, last_heartbeat_at = ? WHERE node_id = ?", nowIso(), nodeId);

  socket.on("message", (data) => {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(data.toString()) as Record<string, unknown>;
    } catch {
      return;
    }
    handleNodeMessage(conn, msg);
  });
  socket.on("close", () => detachNode(conn));
  socket.on("error", () => detachNode(conn));
}

function detachNode(conn: NodeConn): void {
  if (onlineNodes.get(conn.nodeId) !== conn) return; // already superseded
  onlineNodes.delete(conn.nodeId);
  run("UPDATE nodes SET online = 0, in_flight = 0 WHERE node_id = ?", conn.nodeId);
  for (const s of sessions.values()) {
    if (s.nodeId === conn.nodeId && !s.closed) {
      s.closed = true;
      s.error = "node_disconnected";
      notify(s);
    }
  }
  for (const [sessionId, p] of pendingOpens) {
    if (p.nodeId === conn.nodeId) {
      clearTimeout(p.timer);
      pendingOpens.delete(sessionId);
      p.resolve({ accepted: false, reasonCode: "node_disconnected" });
    }
  }
}

function handleNodeMessage(conn: NodeConn, msg: Record<string, unknown>): void {
  // 协议 v2：http_egress.* / cc_worker.* 帧与 official_exit.* 同构，归一化复用同一组处理
  const t = typeof msg.type === "string" ? msg.type : "";
  const msgType =
    t.startsWith("http_egress.") || t.startsWith("cc_worker.")
      ? `official_exit.${t.slice(t.indexOf(".") + 1)}`
      : msg.type;
  switch (msgType) {
    case "provider.hello": {
      if (
        typeof msg.providerId === "string" &&
        msg.providerId &&
        msg.providerId !== conn.providerId
      ) {
        conn.socket.close(4001, "provider_identity_mismatch");
        return;
      }
      conn.acceptingSessions = msg.acceptingSessions !== false;
      run(
        "UPDATE nodes SET online = 1, node_version = ?, accepting_sessions = ?, last_heartbeat_at = ? WHERE node_id = ?",
        typeof msg.nodeVersion === "string" ? msg.nodeVersion : null,
        conn.acceptingSessions ? 1 : 0,
        nowIso(),
        conn.nodeId,
      );
      send(conn.socket, { type: "platform.ready", nodeId: conn.nodeId });
      return;
    }
    case "provider.heartbeat": {
      conn.acceptingSessions = msg.acceptingSessions !== false;
      run(
        "UPDATE nodes SET online = 1, in_flight = ?, accepting_sessions = ?, last_heartbeat_at = ? WHERE node_id = ?",
        typeof msg.inFlight === "number" ? msg.inFlight : 0,
        conn.acceptingSessions ? 1 : 0,
        nowIso(),
        conn.nodeId,
      );
      recordProxyHealth(conn.nodeId, msg);
      // Worker capability telemetry (docs/ccr-supply.md §8.1): surfaced via deploy_meta.ccWorker.
      if (msg.ccWorker && typeof msg.ccWorker === "object" && !Array.isArray(msg.ccWorker)) {
        const row = one<{ deploy_meta: string | null }>("SELECT deploy_meta FROM nodes WHERE node_id = ?", conn.nodeId);
        let meta: Record<string, unknown> = {};
        try {
          meta = row?.deploy_meta ? (JSON.parse(row.deploy_meta) as Record<string, unknown>) : {};
        } catch {
          meta = {};
        }
        const cw = msg.ccWorker as Record<string, unknown>;
        meta.ccWorker = {
          enabled: cw.enabled === true,
          claudeVersion: typeof cw.claudeVersion === "string" ? cw.claudeVersion : null,
          maxConcurrency: typeof cw.maxConcurrency === "number" ? cw.maxConcurrency : 0,
          active: typeof cw.active === "number" ? cw.active : 0,
          queued: typeof cw.queued === "number" ? cw.queued : 0,
          reportedAt: nowIso(),
        };
        run("UPDATE nodes SET deploy_meta = ? WHERE node_id = ?", JSON.stringify(meta), conn.nodeId);
      }
      return;
    }
    case "official_exit.open_response": {
      const sessionId = String(msg.sessionId ?? "");
      const p = pendingOpens.get(sessionId);
      if (!p) return;
      clearTimeout(p.timer);
      pendingOpens.delete(sessionId);
      p.resolve({
        accepted: msg.accepted === true,
        reasonCode: typeof msg.reasonCode === "string" ? msg.reasonCode : undefined,
      });
      return;
    }
    case "official_exit.data": {
      const s = sessions.get(String(msg.sessionId ?? ""));
      if (!s || s.closed) return;
      s.queue.push({
        seq: typeof msg.seq === "number" ? msg.seq : 0,
        payload: Buffer.from(String(msg.payloadBase64 ?? ""), "base64"),
      });
      s.lastActivity = Date.now();
      notify(s);
      return;
    }
    case "official_exit.close": {
      const s = sessions.get(String(msg.sessionId ?? ""));
      if (!s || s.closed) return;
      s.closed = true;
      s.lastActivity = Date.now();
      notify(s);
      return;
    }
    case "official_exit.error": {
      const s = sessions.get(String(msg.sessionId ?? ""));
      if (!s || s.closed) return;
      s.closed = true;
      s.error =
        typeof msg.errorMessage === "string" && msg.errorMessage
          ? msg.errorMessage
          : String(msg.errorCode ?? "node_error");
      s.lastActivity = Date.now();
      notify(s);
      return;
    }
  }
}

function notify(s: TunnelSession): void {
  const waiters = s.waiters.splice(0);
  for (const w of waiters) w();
}

// ---------- protocol v2: proxy pool ----------

/** Proxy id on both sides: sha256(proxyUrl) first 12 hex chars. */
export function proxyIdFromUrl(url: string): string {
  return sha256Hex(url).slice(0, 12);
}

/** Push the full proxy pool (plaintext URLs) to an online node. */
export function pushProxies(nodeId: string, urls: string[]): boolean {
  const conn = onlineNodes.get(nodeId);
  if (!conn) return false;
  send(conn.socket, { type: "proxies.set", proxies: urls });
  return true;
}

export function isNodeOnline(nodeId: string): boolean {
  return onlineNodes.has(nodeId);
}

/** Heartbeat write-back: proxies[{id,live,latencyMs,error?}] and assignments{accountId:proxyId}. */
function recordProxyHealth(nodeId: string, msg: Record<string, unknown>): void {
  if (Array.isArray(msg.proxies)) {
    const now = nowIso();
    for (const p of msg.proxies) {
      if (!p || typeof p !== "object") continue;
      const id = (p as Record<string, unknown>).id;
      if (typeof id !== "string" || !id) continue;
      const live = (p as Record<string, unknown>).live;
      const err = (p as Record<string, unknown>).error;
      if (live !== true && live !== false) {
        // Not probed yet (node just (re)started or pool just replaced): keep it `unknown`, not `dead`.
        run("UPDATE node_proxies SET status = 'unknown' WHERE node_id = ? AND id = ?", nodeId, id.slice(0, 40));
        continue;
      }
      run(
        "UPDATE node_proxies SET status = ?, last_check_at = ?, last_error = ? WHERE node_id = ? AND id = ?",
        live ? "live" : "dead",
        now,
        typeof err === "string" && err ? err.slice(0, 300) : null,
        nodeId,
        id.slice(0, 40),
      );
    }
  }
  if (msg.assignments && typeof msg.assignments === "object" && !Array.isArray(msg.assignments)) {
    const now = nowIso();
    const entries = Object.entries(msg.assignments as Record<string, unknown>).filter(
      (e): e is [string, string] => typeof e[1] === "string" && !!e[0] && !!e[1],
    );
    // The node reports its full assignment map; rows it no longer reports are stale.
    run(
      `DELETE FROM node_proxy_assignments WHERE node_id = ?${
        entries.length ? ` AND account_id NOT IN (${entries.map(() => "?").join(",")})` : ""
      }`,
      nodeId,
      ...entries.map(([a]) => a),
    );
    for (const [accountId, proxyId] of entries) {
      run(
        `INSERT INTO node_proxy_assignments (node_id, account_id, proxy_id, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(node_id, account_id) DO UPDATE SET proxy_id = excluded.proxy_id, updated_at = excluded.updated_at`,
        nodeId,
        accountId,
        proxyId,
        now,
      );
    }
  }
}

// ---------- tunnel manager ----------

function pickNodeConn(providerId: string, nodeId: string | null): NodeConn | null {
  if (nodeId) {
    const conn = onlineNodes.get(nodeId);
    return conn && conn.providerId === providerId && conn.acceptingSessions ? conn : null;
  }
  const available = [...onlineNodes.values()].filter((c) => c.providerId === providerId && c.acceptingSessions);
  if (available.length === 0) return null;
  return available[rrCounter++ % available.length];
}

export type TunnelKind = "official_exit" | "http_egress" | "cc_worker";

/** Worker-mode payload (docs/ccr-supply.md §8.1): everything the node needs to spawn claude. */
export interface CcWorkerParams {
  model: string;
  prompt: string;
  stream: boolean;
  cred: {
    accessToken: string;
    refreshToken?: string;
    /** ms epoch or ISO; written verbatim into .credentials.json. */
    expiresAt?: number | string;
    subscriptionType?: string;
  };
}

/**
 * Open a tunnel session on a node of the account's provider.
 * kind "official_exit" (v1): node relays bytes to targetHost:targetPort and
 * the gateway terminates TLS. kind "http_egress" (protocol v2): the node
 * executes the HTTP request itself (TLS on the node, forced proxy); the
 * gateway then speaks the spec-line framing over the same byte pipe
 * (docs/provider-protocol.md, "协议 v2").
 */
export function openTunnel(
  accountId: string,
  kind: TunnelKind,
  targetHost?: string,
  targetPort?: number,
  /** Protocol v2 (docs/onboarding.md §6.2): pin this session to the account's bound proxy. */
  proxyId?: string,
  /** kind="cc_worker" only (docs/ccr-supply.md §8.1). */
  worker?: CcWorkerParams,
): Promise<OpenedTunnel | null> {
  const acc = one<Pick<AccountRow, "id" | "owner_id" | "node_id" | "route" | "status" | "review_status">>(
    "SELECT id, owner_id, node_id, route, status, review_status FROM accounts WHERE id = ?",
    accountId,
  );
  if (!acc || acc.route !== "node" || acc.status !== "active" || acc.review_status !== "approved") {
    return Promise.resolve(null);
  }
  // Provider-owned: any node of that provider (or the pinned one). Platform-owned
  // (owner NULL): must be pinned to a platform node, i.e. one deployed by an admin.
  let providerId = acc.owner_id;
  if (!providerId) {
    if (!acc.node_id) return Promise.resolve(null);
    const n = one<{ provider_id: string }>("SELECT provider_id FROM nodes WHERE node_id = ?", acc.node_id);
    if (!n) return Promise.resolve(null);
    providerId = n.provider_id;
  }
  const conn = pickNodeConn(providerId, acc.node_id);
  if (!conn) return Promise.resolve(null);

  const sessionId = `tun_${randomUUID()}`;
  const response = new Promise<{ accepted: boolean; reasonCode?: string }>((resolve) => {
    const timer = setTimeout(() => {
      pendingOpens.delete(sessionId);
      resolve({ accepted: false, reasonCode: "open_response_timeout" });
    }, OPEN_RESPONSE_TIMEOUT_MS);
    pendingOpens.set(sessionId, { nodeId: conn.nodeId, resolve, timer });
  });
  send(
    conn.socket,
    kind === "cc_worker"
      ? {
          type: "cc_worker.open",
          sessionId,
          routeMode: "cc_worker",
          providerId: conn.providerId,
          nodeId: conn.nodeId,
          credentialBindingId: acc.id,
          accountId: acc.id,
          ...(proxyId ? { proxyId } : {}),
          model: worker!.model,
          prompt: worker!.prompt,
          stream: worker!.stream,
          cred: worker!.cred,
          deadlineMs: 15_000,
        }
      : kind === "http_egress"
      ? {
          type: "http_egress.open",
          sessionId,
          routeMode: "http_egress",
          providerId: conn.providerId,
          nodeId: conn.nodeId,
          credentialBindingId: acc.id,
          accountId: acc.id,
          ...(proxyId ? { proxyId } : {}),
          deadlineMs: 15_000,
        }
      : {
          type: "official_exit.open",
          sessionId,
          routeMode: "official_exit",
          kind,
          providerId: conn.providerId,
          nodeId: conn.nodeId,
          credentialBindingId: acc.id,
          targetHost,
          targetPort: targetPort ?? 443,
          deadlineMs: 15_000, // relative connect timeout (node caps at 60s)
        },
  );

  return response.then((res) => {
    if (!res.accepted) return null;
    sessions.set(sessionId, {
      sessionId,
      nodeId: conn.nodeId,
      kind,
      credentialBindingId: acc.id,
      queue: [],
      waiters: [],
      closed: false,
      error: null,
      outSeq: 0,
      lastActivity: Date.now(),
    });
    return { sessionId, nodeId: conn.nodeId };
  });
}

export function writeTunnel(sessionId: string, payload: Buffer): boolean {
  const s = sessions.get(sessionId);
  if (!s || s.closed) return false;
  const conn = onlineNodes.get(s.nodeId);
  if (!conn) return false;
  s.lastActivity = Date.now();
  const prefix = s.kind === "official_exit" ? "official_exit" : (s.kind ?? "official_exit");
  send(conn.socket, {
    type: `${prefix}.data`,
    sessionId,
    seq: s.outSeq++,
    payloadBase64: payload.toString("base64"),
  });
  return true;
}

export interface ReadResult {
  chunks: Array<{ seq: number; payloadBase64: string }>;
  closed: boolean;
  error?: string;
}

function readResult(s: TunnelSession): ReadResult {
  const chunks = s.queue
    .splice(0)
    .map((c) => ({ seq: c.seq, payloadBase64: c.payload.toString("base64") }));
  return { chunks, closed: s.closed, ...(s.error ? { error: s.error } : {}) };
}

export async function readTunnel(
  sessionId: string,
  timeoutMs: number,
): Promise<ReadResult | null> {
  const s = sessions.get(sessionId);
  if (!s) return null;
  const cap = Math.min(Math.max(timeoutMs, 0), READ_TIMEOUT_CAP_MS);
  const deadline = Date.now() + cap;
  for (;;) {
    s.lastActivity = Date.now();
    if (s.queue.length > 0 || s.closed) return readResult(s);
    const remaining = deadline - Date.now();
    if (remaining <= 0) return readResult(s);
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, remaining);
      s.waiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

export function closeTunnel(sessionId: string, reasonCode = "closed"): void {
  const s = sessions.get(sessionId);
  if (!s) return;
  sessions.delete(sessionId);
  if (!s.closed) {
    s.closed = true;
    const conn = onlineNodes.get(s.nodeId);
    if (conn) {
      const prefix = s.kind === "official_exit" ? "official_exit" : (s.kind ?? "official_exit");
      send(conn.socket, { type: `${prefix}.close`, sessionId, reasonCode });
    }
    notify(s);
  }
}

export function generateNodeSecret(): string {
  return randomBytes(32).toString("hex");
}

// Idle-session reaper: close tunnels with no traffic/read for 5 minutes.
setInterval(() => {
  const now = Date.now();
  for (const s of sessions.values()) {
    if (now - s.lastActivity > SESSION_IDLE_MS) closeTunnel(s.sessionId, "idle_timeout");
  }
}, 30_000).unref();
