import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import { all, boundProxyDown, decryptString, ensureDeviceId, isConversationGenerationActive, nowIso, one, run, sha256Hex, type AccountRow, freezeAccountsOnProxy, freezeAccountForProxy, recordProxyTeamEvent } from "@1dayapi/core";
import { nodeProxyConfig, recordNodeProxyExit } from "./proxies.js";
import { isTrustedExecutionNode } from "./trust.js";

export interface IsolationContext { teamId: string; conversationId: string; generation: number }
export function validIsolation(value: unknown): value is IsolationContext {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return typeof v.teamId === "string" && /^[A-Za-z0-9_.:-]{1,180}$/.test(v.teamId)
    && typeof v.conversationId === "string" && /^[A-Za-z0-9_.:-]{1,180}$/.test(v.conversationId)
    && Number.isSafeInteger(v.generation) && Number(v.generation) > 0;
}
const sameIsolation = (a: IsolationContext | undefined, b: IsolationContext) => !!a && a.teamId === b.teamId && a.conversationId === b.conversationId && a.generation === b.generation;
const activeIsolation = (c: IsolationContext) => validIsolation(c) && c.generation > (resetTombstones.get(c.conversationId)?.generation ?? 0)
  && isConversationGenerationActive(c.conversationId, c.teamId, c.generation);

export type WsSocket = WebSocket;

export function createWsServer(): WebSocketServer {
  return new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });
}

// ---------- types ----------

export interface NodeConn {
  nodeId: string;
  providerId: string;
  socket: WsSocket;
  acceptingSessions: boolean;
  capabilities?: string[];
  runtimeTeamId?: string;
  reportedAccepting?: boolean;
}

interface TunnelChunk {
  seq: number;
  payload: Buffer;
}

export interface TunnelSession {
  isolation?: IsolationContext;
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
const resetTombstones = new Map<string, IsolationContext>();
const isolationExecutors = new Map<string, Set<string>>();
const nodeResetDebt = new Map<string, Map<string, IsolationContext>>();
const pendingResets = new Map<string, { nodeId: string; resolve: () => void; timer: NodeJS.Timeout }>();
const isolationKey = (c: IsolationContext) => JSON.stringify([c.teamId, c.conversationId, c.generation]);
function rememberExecutor(nodeId: string, c: IsolationContext): void {
  const key = isolationKey(c), nodes = isolationExecutors.get(key) ?? new Set<string>();
  nodes.add(nodeId); isolationExecutors.set(key, nodes);
}

/** A dead old runtime cannot hold a healthy new team's request hostage. Its I/O is
 * fenced first; failure to acknowledge teardown withdraws the whole old connection. */
function forceNodeReset(conn: NodeConn, isolation: IsolationContext): Promise<void> {
  const key = isolationKey(isolation), debt = nodeResetDebt.get(conn.nodeId) ?? new Map<string, IsolationContext>();
  debt.set(key, isolation); nodeResetDebt.set(conn.nodeId, debt); conn.acceptingSessions = false;
  run("UPDATE nodes SET accepting_sessions=0 WHERE node_id=?", conn.nodeId);
  return new Promise((settle) => {
    const resetId = randomUUID();
    const timer = setTimeout(() => {
      pendingResets.delete(resetId);
      if (onlineNodes.get(conn.nodeId) === conn) {
        onlineNodes.delete(conn.nodeId);
        run("UPDATE nodes SET online=0,accepting_sessions=0 WHERE node_id=?", conn.nodeId);
        failNodeSessions(conn.nodeId, "isolation_reset_unacknowledged");
        conn.socket.terminate();
      }
      settle();
    }, OPEN_RESPONSE_TIMEOUT_MS);
    pendingResets.set(resetId, { nodeId: conn.nodeId, timer, resolve: () => {
      const pending = nodeResetDebt.get(conn.nodeId);
      pending?.delete(key);
      if (!pending?.size) {
        nodeResetDebt.delete(conn.nodeId);
        if (onlineNodes.get(conn.nodeId) === conn) {
          conn.acceptingSessions = conn.reportedAccepting !== false;
          run("UPDATE nodes SET accepting_sessions=? WHERE node_id=?", conn.acceptingSessions ? 1 : 0, conn.nodeId);
        }
      }
      settle();
    } });
    send(conn.socket, { type: "isolation.reset", isolation, resetId });
  });
}

/**
 * Link grace (2026-10-19): a node whose control socket drops keeps its open
 * sessions for this long. The node's processes are still running; if the same
 * node reconnects in time (Cloudflare recycled the WebSocket, 2 s blips cut 11
 * worker streams at once) the sessions simply continue on the new socket.
 * Frames the gateway writes meanwhile are queued per node and flushed after the
 * node's hello names the sessions it still has. 0 disables (old behaviour).
 */
const LINK_GRACE_MS = Math.max(0, Number(process.env.NODE_LINK_GRACE_MS ?? 30_000) || 0);
const LINK_GRACE_MAX_FRAMES = 5_000;
interface DetachedNode {
  since: number;
  timer: NodeJS.Timeout;
  /** Outbound session frames written during the gap, flushed on reconnect. */
  frames: Array<Record<string, unknown>>;
}
const detachedNodes = new Map<string, DetachedNode>();

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
  if (!row || row.status !== "active") return null;
  const a = Buffer.from(row.secret_hash);
  const b = Buffer.from(sha256Hex(secret));
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return { nodeId, providerId: row.provider_id };
}

/** Close a node's control connection (unbind / provider disabled). */
export function disconnectNode(nodeId: string, reason: string): void {
  const conn = onlineNodes.get(nodeId);
  if (conn) conn.socket.close(4003, reason);
}

// ---------- WS wiring ----------

function send(socket: WsSocket, msg: Record<string, unknown>): void {
  if (socket.bufferedAmount > 64 * 1024 * 1024) { socket.terminate(); return; }
  if (socket.readyState === 1) socket.send(JSON.stringify(msg));
}

const PING_INTERVAL_MS = 30_000;

export function attachNode(nodeId: string, providerId: string, socket: WsSocket): void {
  const existing = onlineNodes.get(nodeId);
  if (existing) {
    // Half-open old socket (the node noticed the loss before our ping did): supersede it. Whether the
    // open sessions survive is decided by the node's hello (it lists the sessions it still runs).
    existing.socket.removeAllListeners("close");
    existing.socket.removeAllListeners("error");
    existing.socket.close(4000, "superseded");
  }
  const graced = detachedNodes.get(nodeId);
  if (graced) {
    clearTimeout(graced.timer);
    console.log(`[registry] node ${nodeId} back after ${Date.now() - graced.since}ms; ${openSessionCount(nodeId)} session(s) held, ${graced.frames.length} frame(s) queued`);
  }
  const conn: NodeConn = { nodeId, providerId, socket, acceptingSessions: true };
  onlineNodes.set(nodeId, conn);
  run("UPDATE nodes SET online = 1, last_heartbeat_at = ? WHERE node_id = ?", nowIso(), nodeId);

  // Liveness: a half-open TCP connection (NAT drop, node power loss) would
  // otherwise stay "online" for the kernel's retransmit timeout.
  let alive = true;
  socket.on("pong", () => {
    alive = true;
  });
  const pinger = setInterval(() => {
    if (socket.readyState !== 1) return;
    if (!alive) {
      console.warn(`[registry] node ${nodeId} missed a ping; terminating socket`);
      socket.terminate();
      return;
    }
    alive = false;
    socket.ping();
  }, PING_INTERVAL_MS);
  pinger.unref?.();
  socket.on("close", () => clearInterval(pinger));

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

function failNodeSessions(nodeId: string, reason: string): void {
  const graced = detachedNodes.get(nodeId);
  if (graced) {
    clearTimeout(graced.timer);
    detachedNodes.delete(nodeId);
  }
  for (const s of sessions.values()) {
    if (s.nodeId === nodeId && !s.closed) {
      s.closed = true;
      s.error = reason;
      notify(s);
    }
  }
  for (const [sessionId, p] of pendingOpens) {
    if (p.nodeId === nodeId) {
      clearTimeout(p.timer);
      pendingOpens.delete(sessionId);
      p.resolve({ accepted: false, reasonCode: reason });
    }
  }
}

function openSessionCount(nodeId: string): number {
  let n = 0;
  for (const s of sessions.values()) if (s.nodeId === nodeId && !s.closed) n++;
  return n;
}

function failPendingOpens(nodeId: string, reason: string): void {
  for (const [sessionId, p] of pendingOpens) {
    if (p.nodeId === nodeId) {
      clearTimeout(p.timer);
      pendingOpens.delete(sessionId);
      p.resolve({ accepted: false, reasonCode: reason });
    }
  }
}

function detachNode(conn: NodeConn): void {
  if (onlineNodes.get(conn.nodeId) !== conn) return; // already superseded
  onlineNodes.delete(conn.nodeId);
  run("UPDATE nodes SET online = 0, in_flight = 0 WHERE node_id = ?", conn.nodeId);
  // Opens in flight cannot complete on a dead socket; established sessions get the grace period.
  failPendingOpens(conn.nodeId, "node_disconnected");
  const held = openSessionCount(conn.nodeId);
  if (LINK_GRACE_MS <= 0 || held === 0) {
    failNodeSessions(conn.nodeId, "node_disconnected");
    return;
  }
  const prev = detachedNodes.get(conn.nodeId);
  if (prev) clearTimeout(prev.timer);
  const nodeId = conn.nodeId;
  const timer = setTimeout(() => {
    detachedNodes.delete(nodeId);
    console.warn(`[registry] node ${nodeId} did not return within ${LINK_GRACE_MS}ms; failing ${openSessionCount(nodeId)} held session(s)`);
    failNodeSessions(nodeId, "node_disconnected");
  }, LINK_GRACE_MS);
  timer.unref?.();
  detachedNodes.set(nodeId, { since: Date.now(), timer, frames: [] });
  console.warn(`[registry] node ${nodeId} link lost; holding ${held} session(s) for up to ${LINK_GRACE_MS}ms`);
}

/**
 * After a (re)connect the node's hello lists the sessions it still runs:
 * sessions it lost are failed here, queued frames for the survivors are
 * flushed, and the node is told which of its sessions we kept so it can drop
 * the rest. A hello without the list is an older bundle that already closed
 * everything on transport loss → fail all held sessions (previous behaviour).
 */
function reconcileSessions(conn: NodeConn, msg: Record<string, unknown>): string[] {
  const graced = detachedNodes.get(conn.nodeId);
  detachedNodes.delete(conn.nodeId);
  const announced = Array.isArray(msg.sessions) ? new Set((msg.sessions as unknown[]).map(String)) : null;
  const retained: string[] = [];
  let lost = 0;
  for (const s of sessions.values()) {
    if (s.nodeId !== conn.nodeId || s.closed) continue;
    if (s.isolation && !activeIsolation(s.isolation)) {
      s.queue = []; s.closed = true; s.error = "isolation_retired"; notify(s); lost++; continue;
    }
    if (announced && announced.has(s.sessionId)) {
      retained.push(s.sessionId);
    } else {
      s.closed = true;
      s.error = announced ? "node_lost_session" : "node_reconnected";
      notify(s);
      lost++;
    }
  }
  if (graced) {
    const keep = new Set(retained);
    let flushed = 0;
    for (const f of graced.frames) {
      if (keep.has(String(f.sessionId ?? ""))) {
        send(conn.socket, f);
        flushed++;
      }
    }
    console.log(`[registry] node ${conn.nodeId} reconciled: ${retained.length} session(s) continue, ${lost} lost, ${flushed}/${graced.frames.length} queued frame(s) flushed`);
  } else if (lost) {
    console.log(`[registry] node ${conn.nodeId} reconciled: ${lost} session(s) not on the node any more`);
  }
  return retained;
}

/** A session frame is only valid from the node that owns the session. */
function ownedSession(conn: NodeConn, sessionId: unknown): TunnelSession | null {
  const s = sessions.get(String(sessionId ?? ""));
  if (!s || s.closed || s.nodeId !== conn.nodeId || onlineNodes.get(conn.nodeId) !== conn) return null;
  if (s.isolation && !activeIsolation(s.isolation)) {
    s.queue = [];
    s.closed = true;
    s.error = "isolation_retired";
    send(conn.socket, { type: "isolation.reset", isolation: s.isolation, resetId: randomUUID() });
    notify(s);
    return null;
  }
  return s;
}

function handleNodeMessage(conn: NodeConn, msg: Record<string, unknown>): void {
  if (msg.type === "isolation.reset_ack" && typeof msg.resetId === "string") {
    const pending = pendingResets.get(msg.resetId);
    if (pending?.nodeId === conn.nodeId) { clearTimeout(pending.timer); pendingResets.delete(msg.resetId); pending.resolve(); }
    return;
  }
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
      conn.reportedAccepting = msg.acceptingSessions !== false;
      conn.acceptingSessions = conn.reportedAccepting && !nodeResetDebt.has(conn.nodeId);
      conn.capabilities = Array.isArray(msg.capabilities) ? msg.capabilities.filter((x): x is string => typeof x === "string") : [];
      conn.runtimeTeamId = typeof msg.runtimeTeamId === "string" && msg.runtimeTeamId ? msg.runtimeTeamId : undefined;
      run(
        "UPDATE nodes SET online = 1, node_version = ?, accepting_sessions = ?, last_heartbeat_at = ? WHERE node_id = ?",
        typeof msg.nodeVersion === "string" ? msg.nodeVersion : null,
        conn.acceptingSessions ? 1 : 0,
        nowIso(),
        conn.nodeId,
      );
      const retainedSessions = reconcileSessions(conn, msg);
      send(conn.socket, { type: "platform.ready", nodeId: conn.nodeId, retainedSessions });
      // The node boots from its own (possibly stale) copy of the pool: push
      // the platform's view on every (re)connect so the two never diverge
      // (docs/onboarding.md §6.4).
      pushProxies(conn.nodeId, []);
      // A console restart loses its in-memory reset queue; the node reports even idle/parked
      // worker contexts so durable generations can revoke them on reconnect.
      const owed = new Map(nodeResetDebt.get(conn.nodeId) ?? []);
      if (Array.isArray(msg.isolatedContexts)) for (const isolation of msg.isolatedContexts) {
        if (!validIsolation(isolation)) continue;
        rememberExecutor(conn.nodeId, isolation);
        if (!activeIsolation(isolation)) owed.set(isolationKey(isolation), isolation);
      }
      for (const isolation of owed.values()) void forceNodeReset(conn, isolation);
      return;
    }
    case "teams.retire_result": {
      // Node-side organization cleanup outcome (2026-11-01): one append-only event per team per node.
      const results = Array.isArray(msg.results) ? (msg.results as Array<{ teamId?: unknown; removed?: unknown; error?: unknown }>) : [];
      for (const r of results) {
        if (typeof r?.teamId !== "string") continue;
        const removed = r.removed === true;
        recordProxyTeamEvent({ resourceKey: `team:${r.teamId}`, nodeId: conn.nodeId, teamId: r.teamId, event: removed ? "team_node_cleanup" : "team_node_cleanup_skipped", reason: removed ? "node removed the organization's worker root and system user" : `node did not clean up: ${typeof r.error === "string" ? r.error.slice(0, 160) : "unknown"}` });
        console.info(`[registry] teams.retire ${r.teamId.slice(0, 8)} on ${conn.nodeId}: ${removed ? "removed" : `skipped (${String(r.error ?? "?")})`}`);
      }
      return;
    }
    case "provider.heartbeat": {
      conn.reportedAccepting = msg.acceptingSessions !== false;
      conn.acceptingSessions = conn.reportedAccepting && !nodeResetDebt.has(conn.nodeId);
      run(
        "UPDATE nodes SET online = 1, in_flight = ?, accepting_sessions = ?, last_heartbeat_at = ? WHERE node_id = ?",
        typeof msg.inFlight === "number" ? msg.inFlight : 0,
        conn.acceptingSessions ? 1 : 0,
        nowIso(),
        conn.nodeId,
      );
      recordProxyHealth(conn.nodeId, msg);
      recordCcIdentities(conn.nodeId, msg);
      recordNodeMetrics(conn.nodeId, msg);
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
          selfTestError: typeof cw.selfTestError === "string" && cw.selfTestError ? cw.selfTestError : null,
          reportedAt: nowIso(),
        };
        if (meta.ccWorker && (meta.ccWorker as { selfTestError: string | null }).selfTestError) {
          // Misconfigured worker isolation on that node (docs/operations.md §6 checklist); it rejects cc_worker sessions.
          console.warn(`[registry] node ${conn.nodeId} cc_worker ${(meta.ccWorker as { selfTestError: string }).selfTestError}`);
        }
        run("UPDATE nodes SET deploy_meta = ? WHERE node_id = ?", JSON.stringify(meta), conn.nodeId);
      }
      return;
    }
    case "official_exit.open_response": {
      const sessionId = String(msg.sessionId ?? "");
      const p = pendingOpens.get(sessionId);
      if (!p || p.nodeId !== conn.nodeId) return;
      clearTimeout(p.timer);
      pendingOpens.delete(sessionId);
      p.resolve({
        accepted: msg.accepted === true,
        reasonCode: typeof msg.reasonCode === "string" ? msg.reasonCode : undefined,
      });
      return;
    }
    case "official_exit.data": {
      const s = ownedSession(conn, msg.sessionId);
      if (!s) return;
      const encoded = String(msg.payloadBase64 ?? "");
      const buffered = s.queue.reduce((n, c) => n + c.payload.length, 0);
      const nodeBuffered = [...sessions.values()].filter((v) => v.nodeId === conn.nodeId)
        .reduce((n, v) => n + v.queue.reduce((sum, c) => sum + c.payload.length, 0), 0);
      if (encoded.length > 6 * 1024 * 1024 || buffered + encoded.length * 0.75 > 8 * 1024 * 1024 || nodeBuffered + encoded.length * 0.75 > 64 * 1024 * 1024) {
        s.queue = []; s.closed = true; s.error = "tunnel_buffer_limit"; notify(s);
        send(conn.socket, { type: `${s.kind ?? "official_exit"}.close`, sessionId: s.sessionId, reasonCode: "tunnel_buffer_limit" });
        return;
      }
      s.queue.push({
        seq: typeof msg.seq === "number" ? msg.seq : 0,
        payload: Buffer.from(encoded, "base64"),
      });
      s.lastActivity = Date.now();
      notify(s);
      return;
    }
    case "official_exit.close": {
      const s = ownedSession(conn, msg.sessionId);
      if (!s) return;
      s.closed = true;
      s.lastActivity = Date.now();
      notify(s);
      return;
    }
    case "official_exit.error": {
      const s = ownedSession(conn, msg.sessionId);
      if (!s) return;
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
  const policy = nodeProxyConfig(nodeId);
  if (!conn.capabilities?.includes("team_isolation_v1")) {
    // An old binary ignores ownership metadata. Never expose new team resources to
    // its legacy automatic proxy picker, even when it only serves legacy accounts.
    const legacy = new Set(all<{ id: string }>("SELECT id FROM node_proxies WHERE node_id=? AND isolation_version=0", nodeId).map((p) => p.id));
    send(conn.socket, { type: "proxies.set", proxies: policy.proxies.filter((url) => legacy.has(sha256Hex(url).slice(0, 12))) });
  } else send(conn.socket, { type: "proxies.set", ...policy });
  return true;
}

/**
 * Ask every online isolation-capable node to remove an organization's worker root and system user
 * (teams.retire, 2026-11-01). Returns the node ids asked; results arrive as teams.retire_result events.
 */
export function retireTeamOnNodes(teamId: string): string[] {
  const asked: string[] = [];
  for (const conn of onlineNodes.values()) {
    if (!conn.capabilities?.includes("team_isolation_v1")) continue;
    if (conn.runtimeTeamId && conn.runtimeTeamId !== teamId) continue;
    send(conn.socket, { type: "teams.retire", teamIds: [teamId] });
    asked.push(conn.nodeId);
  }
  return asked;
}

/** Open tunnel sessions (requests in flight / worker turns) bound to this account; 0 when idle. */
export function liveSessionsForAccount(accountId: string): number {
  let n = 0;
  for (const s of sessions.values()) if (s.credentialBindingId === accountId && !s.closed) n++;
  return n;
}

export function isNodeOnline(nodeId: string): boolean {
  return onlineNodes.has(nodeId);
}

/** Heartbeat write-back: proxies[{id,live,latencyMs,error?}] and assignments{accountId:proxyId}. */
function recordProxyHealth(nodeId: string, msg: Record<string, unknown>): void {
  if (Array.isArray(msg.proxies)) {
    const now = nowIso();
    let pushNeeded = false;
    for (const p of msg.proxies) {
      if (!p || typeof p !== "object") continue;
      const id = (p as Record<string, unknown>).id;
      if (typeof id !== "string" || !id) continue;
      const live = (p as Record<string, unknown>).live;
      const err = (p as Record<string, unknown>).error;
      if (live !== true && live !== false) {
        // Not probed yet (node just (re)started or pool just replaced). Keep the
        // last known live/dead verdict until the node re-probes: flipping every
        // bound account to "proxy unknown" on each node restart would take them
        // all out of scheduling for the whole probe pass.
        run("UPDATE node_proxies SET status = 'unknown' WHERE node_id = ? AND id = ? AND isolation_version=1 AND status NOT IN ('live', 'dead')", nodeId, id.slice(0, 40));
        continue;
      }
      run(
        "UPDATE node_proxies SET status = ?, last_check_at = ?, last_error = ? WHERE node_id = ? AND id = ? AND isolation_version=1",
        live ? "live" : "dead",
        now,
        typeof err === "string" && err ? err.slice(0, 300) : null,
        nodeId,
        id.slice(0, 40),
      );
      if (live === false) {
        // Operator rule 2026-11-01: a dead proxy freezes its accounts (status proxy_down) until an operator
        // releases or rebinds them — the account never silently comes back or moves to another exit.
        const frozen = freezeAccountsOnProxy(id.slice(0, 40), `node ${nodeId} reported the bound proxy dead${typeof err === "string" && err ? `: ${err.slice(0, 200)}` : ""}`);
        if (frozen.length) console.warn(`[registry] proxy ${id.slice(0, 12)} on ${nodeId} dead → ${frozen.length} account(s) frozen (proxy_down): ${frozen.join(",")}`);
      }
      const isolated = one<{ exit_ip: string | null }>("SELECT exit_ip FROM node_proxies WHERE node_id=? AND id=? AND isolation_version=1", nodeId, id);
      if (isolated && live === true) {
        const ip = (p as Record<string, unknown>).exitIp;
        if (typeof ip !== "string" || !ip) {
          // The node reports the proxy alive without an exit measurement: its pool copy was
          // just replaced (fresh health, probe pass not finished) or a served request called
          // markAlive. A proxy whose exit was already verified keeps that identity until the
          // next measured heartbeat (a changed or conflicting IP is still handled below);
          // treating it as "identity unavailable" marked every bound proxy dead and pushed
          // the pool again, which reset the node's probe and restarted the loop (2026-10-28).
          // An exit that was never measured is still refused: it cannot carry a team.
          if (!isolated.exit_ip && !recordNodeProxyExit(nodeId, id, "")) pushNeeded = true;
          continue;
        }
        const accepted = recordNodeProxyExit(nodeId, id, ip);
        if (!accepted || isolated.exit_ip !== ip) pushNeeded = true;
        const country = (p as Record<string, unknown>).exitCountry;
        if (typeof country === "string" && /^[A-Z]{2}$/.test(country)) {
          run("UPDATE node_proxies SET exit_country = ? WHERE node_id = ? AND id = ? AND (exit_country IS NULL OR exit_country <> ?)", country, nodeId, id.slice(0, 40), country);
        }
      }
    }
    // One pool push per heartbeat at most: pushing inside the loop (once per changed proxy)
    // replaced the node's pool a dozen times per heartbeat.
    if (pushNeeded) pushProxies(nodeId, []);
  }
  if (msg.assignments && typeof msg.assignments === "object" && !Array.isArray(msg.assignments)) {
    const now = nowIso();
    const entries = Object.entries(msg.assignments as Record<string, unknown>).filter(
      (e): e is [string, string] => typeof e[1] === "string" && !!e[0] && !!e[1],
    ).filter(([accountId, proxyId]) => isTrustedExecutionNode(nodeId) && !!one(
      "SELECT 1 FROM accounts WHERE id=? AND node_id=? AND team_id IS NOT NULL AND bound_proxy_id=?", accountId, nodeId, proxyId,
    ));
    // Heartbeats maintain only the new managed namespace. Legacy mappings are history.
    run(
      `DELETE FROM node_proxy_assignments WHERE node_id = ? AND account_id IN (SELECT id FROM accounts WHERE team_id IS NOT NULL AND node_id=?)${
        entries.length ? ` AND account_id NOT IN (${entries.map(() => "?").join(",")})` : ""
      }`,
      nodeId,
      nodeId,
      ...entries.map(([a]) => a),
    );
    for (const [accountId, proxyId] of entries) {
      run(
        `INSERT INTO node_proxy_assignments (node_id, account_id, proxy_id, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(node_id, account_id) DO UPDATE SET proxy_id = excluded.proxy_id, updated_at = excluded.updated_at
         WHERE node_proxy_assignments.proxy_id <> excluded.proxy_id`,
        nodeId,
        accountId,
        proxyId,
        now,
      );
    }
  }
}

// ---------- tunnel manager ----------

/**
 * How long a session open waits for the account's node to (re)appear and
 * accept sessions before giving up (env NODE_WAIT_MS, default 20 s). A node
 * restart is a drain (~up to 60 s, no new sessions) + ~5 s offline + reconnect;
 * without this wait every request in that window became a 503 even though the
 * node was back seconds later (2026-10-17: 12 × 502/503 per restart).
 */
const NODE_WAIT_MS = Math.max(0, Number(process.env.NODE_WAIT_MS ?? 20_000) || 0);

async function waitForNodeConn(providerId: string, nodeId: string | null): Promise<NodeConn | null> {
  const first = pickNodeConn(providerId, nodeId);
  if (first || NODE_WAIT_MS === 0) return first;
  const deadline = Date.now() + NODE_WAIT_MS;
  console.warn(`[registry] no accepting node for ${nodeId ?? `provider ${providerId}`}; waiting up to ${NODE_WAIT_MS}ms`);
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250));
    const conn = pickNodeConn(providerId, nodeId);
    if (conn) {
      console.log(`[registry] node ${conn.nodeId} accepting again after ${NODE_WAIT_MS - (deadline - Date.now())}ms wait`);
      return conn;
    }
  }
  return null;
}

/**
 * Heartbeat `ccIdentities`: the node's Claude Code config dirs are the source of
 * truth for an account's device identity (docs/claude-code-compat.md §8). Only
 * accounts bound to this node are updated; the node value overwrites a
 * platform-generated seed so the direct path and the worker path present the
 * same device.
 */
function recordCcIdentities(nodeId: string, msg: Record<string, unknown>): void {
  const ids = msg.ccIdentities;
  if (!ids || typeof ids !== "object" || Array.isArray(ids)) return;
  let n = 0;
  for (const [accountId, v] of Object.entries(ids as Record<string, unknown>)) {
    if (!/^[0-9a-f-]{8,64}$/i.test(accountId) || !v || typeof v !== "object") continue;
    const dev = (v as Record<string, unknown>).deviceId;
    const uuid = (v as Record<string, unknown>).accountUuid;
    const deviceId = typeof dev === "string" && /^[0-9a-f]{64}$/i.test(dev) ? dev : null;
    const accountUuid = typeof uuid === "string" && /^[0-9a-f-]{32,36}$/i.test(uuid) ? uuid : null;
    if (!deviceId && !accountUuid) continue;
    const acc = one<{ team_id: string | null; device_id: string | null; account_uuid: string | null }>("SELECT team_id,device_id,account_uuid FROM accounts WHERE id=? AND node_id=?", accountId, nodeId);
    if (!acc || !acc.team_id || !isTrustedExecutionNode(nodeId)) continue;
    if (acc.team_id && ((v as Record<string, unknown>).teamId !== acc.team_id || (acc.device_id && deviceId !== acc.device_id) ||
      (acc.account_uuid && accountUuid && acc.account_uuid !== accountUuid) ||
      (deviceId && one("SELECT 1 FROM accounts WHERE device_id=? AND id<>?", deviceId, accountId)))) continue;
    const r = run(
      "UPDATE accounts SET device_id = COALESCE(?, device_id), account_uuid = COALESCE(?, account_uuid) WHERE id = ? AND node_id = ?",
      deviceId,
      accountUuid,
      accountId,
      nodeId,
    );
    if ((r as { changes?: number }).changes) n++;
  }
  if (n) console.log(`[registry] node ${nodeId} reported device identities for ${n} account(s)`);
}

/** Latest heartbeat snapshot for the node monitor (docs/operations.md §7.2): nodes.metrics JSON. */
function recordNodeMetrics(nodeId: string, msg: Record<string, unknown>): void {
  const proxies = Array.isArray(msg.proxies) ? (msg.proxies as Array<{ live?: unknown }>) : [];
  const counts = { total: proxies.length, live: 0, dead: 0, unknown: 0 };
  for (const p of proxies) {
    if (p?.live === true) counts.live++;
    else if (p?.live === false) counts.dead++;
    else counts.unknown++;
  }
  const snapshot = {
    reportedAt: nowIso(),
    inFlight: typeof msg.inFlight === "number" ? msg.inFlight : 0,
    acceptingSessions: msg.acceptingSessions !== false,
    healthy: msg.healthy !== false,
    host: msg.host && typeof msg.host === "object" ? msg.host : null,
    egress: msg.egress && typeof msg.egress === "object" ? msg.egress : null,
    ccWorker: msg.ccWorker && typeof msg.ccWorker === "object" ? msg.ccWorker : null,
    proxies: counts,
  };
  try {
    run("UPDATE nodes SET metrics = ? WHERE node_id = ?", JSON.stringify(snapshot), nodeId);
  } catch {
    /* pre-migration-12 schema: ignore */
  }
}

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
  /** Worker system prompt (replaces Claude Code's default; node passes it via --system-prompt-file). Legacy only. */
  systemPrompt?: string;
  /** Canonical worker (spec WP2): node runs its native Claude Code (requires node capability canonical_v1). */
  mode?: "legacy" | "canonical";
  profileId?: string;
  appendSystemPrompt?: string;
  nativeSessionId?: string;
  builtInToolProfile?: "restricted-default" | "tools-disabled-canonical";
  jsonSchema?: Record<string, unknown>;
  nativeSession?: { id: string; action: "start" | "resume" | "fork"; revision?: number };
  historyImport?: Array<Record<string, unknown>>;
  /** Extended thinking budget → node `--max-thinking-tokens`. */
  thinkingBudget?: number;
  /** Reasoning effort → node `--effort`. */
  effort?: string;
  /** Client max_tokens → node env CLAUDE_CODE_MAX_OUTPUT_TOKENS. */
  maxTokens?: number;
  /** Persistent session fields (docs/worker-sessions.md), relayed verbatim to the node. */
  persist?: boolean;
  reuseKey?: string;
  turnMode?: "fresh" | "continue" | "tool_result";
  expectedTurn?: number;
  tools?: Array<{ name: string; description?: string; input_schema?: Record<string, unknown> }>;
  results?: Array<{ callId: string; content: string; isError?: boolean }>;
  /** turnMode "continue": the whole conversation, for the node's fresh fallback when the continue misses (worker-sessions.md §1). */
  history?: Array<Record<string, unknown>>;
  /** Messages-style content blocks (text + images); the node switches to `--input-format stream-json` when present. */
  content?: Array<Record<string, unknown>>;
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
export async function openTunnel(
  accountId: string,
  kind: TunnelKind,
  targetHost?: string,
  targetPort?: number,
  /** Protocol v2 (docs/onboarding.md §6.2): pin this session to the account's bound proxy. */
  proxyId?: string,
  /** kind="cc_worker" only (docs/ccr-supply.md §8.1). */
  worker?: CcWorkerParams,
  /** kind="http_egress": how long the node may wait for upstream response headers (ms). */
  headersTimeoutMs?: number,
  isolation?: IsolationContext,
  backgroundTeamId?: string,
  signal?: AbortSignal,
): Promise<OpenedTunnel | null> {
  if (signal?.aborted) return null;
  const acc = one<Pick<AccountRow, "id" | "owner_id" | "node_id" | "route" | "status" | "review_status" | "device_id" | "team_id" | "bound_proxy_id">>(
    "SELECT id, owner_id, node_id, route, status, review_status, device_id, team_id, bound_proxy_id FROM accounts WHERE id = ?",
    accountId,
  );
  if (!acc || acc.route !== "node" || acc.status !== "active" || acc.review_status !== "approved") {
    return null;
  }
  const teamId = isolation?.teamId ?? backgroundTeamId;
  if (isolation && (!activeIsolation(isolation) || isolation.teamId !== acc.team_id)) return null;
  if (acc.team_id) {
    if (!acc.node_id || !isTrustedExecutionNode(acc.node_id)) return null;
    if (teamId !== acc.team_id || !acc.node_id || !acc.bound_proxy_id || (proxyId && proxyId !== acc.bound_proxy_id) || kind === "official_exit") return null;
    if (boundProxyDown(acc)) return null;
    proxyId = acc.bound_proxy_id;
    const policy = nodeProxyConfig(acc.node_id);
    if (policy.proxyTeams[proxyId] !== teamId || !policy.proxyAccounts[proxyId]?.includes(acc.id)) return null;
  } else if (teamId) return null;
  // Provider-owned: any node of that provider (or the pinned one). Platform-owned
  // (owner NULL): must be pinned to a platform node, i.e. one deployed by an admin.
  let providerId = acc.owner_id;
  if (!providerId) {
    if (!acc.node_id) return null;
    const n = one<{ provider_id: string }>("SELECT provider_id FROM nodes WHERE node_id = ?", acc.node_id);
    if (!n) return null;
    providerId = n.provider_id;
  }
  const conn = await waitForNodeConn(providerId, acc.node_id);
  if (!conn || signal?.aborted) return null;
  if (teamId && (!conn.capabilities?.includes("team_isolation_v1") || (conn.runtimeTeamId && conn.runtimeTeamId !== teamId))) return null;
  if (teamId && kind === "cc_worker" && process.env.REQUIRE_TEAM_UID_ISOLATION === "1" && !conn.capabilities?.includes("team_uid_isolation_v1")) return null;
  // Canonical worker (spec WP2 §6.5): only a node that declared canonical_v1 (env CC_WORKER_CANONICAL=1) may take it;
  // an older bundle must never run a canonical open as a legacy process (I9: no mixed modes).
  if (kind === "cc_worker" && worker?.mode === "canonical" && !conn.capabilities?.includes("canonical_v1")) return null;
  if (!teamId && conn.runtimeTeamId) return null;
  if (isolation && !activeIsolation(isolation)) return null;

  const sessionId = `tun_${randomUUID()}`;
  if (isolation) rememberExecutor(conn.nodeId, isolation);
  const response = awaitOpen(conn, sessionId);
  // ws can emit open_response, stdout and close synchronously from one TCP
  // packet. Register before dispatch; a Promise continuation is already too late.
  const opened = registerOpened(conn, sessionId, kind, acc.id, isolation);
  const cancel = () => {
    const pending = pendingOpens.get(sessionId);
    if (pending) { clearTimeout(pending.timer); pendingOpens.delete(sessionId); pending.resolve({ accepted: false, reasonCode: "client_cancelled" }); }
    closeTunnel(sessionId, "client_cancelled");
  };
  signal?.addEventListener("abort", cancel, { once: true });
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
          ...(isolation ? { isolation } : {}),
          ...(proxyId ? { proxyId } : {}),
          model: worker!.model,
          prompt: worker!.prompt,
          ...(worker!.systemPrompt ? { systemPrompt: worker!.systemPrompt } : {}),
          ...(worker!.mode === "canonical"
            ? {
                mode: "canonical",
                ...(worker!.profileId ? { profileId: worker!.profileId } : {}),
                ...(worker!.appendSystemPrompt ? { appendSystemPrompt: worker!.appendSystemPrompt } : {}),
                ...(worker!.nativeSessionId ? { nativeSessionId: worker!.nativeSessionId } : {}),
                ...(worker!.builtInToolProfile ? { builtInToolProfile: worker!.builtInToolProfile } : {}),
                ...(worker!.jsonSchema ? { jsonSchema: worker!.jsonSchema } : {}),
                ...(worker!.nativeSession ? { nativeSession: worker!.nativeSession } : {}),
                ...(worker!.historyImport ? { historyImport: worker!.historyImport } : {}),
              }
            : {}),
          ...(worker!.thinkingBudget ? { thinkingBudget: worker!.thinkingBudget } : {}),
          ...(worker!.effort ? { effort: worker!.effort } : {}),
          ...(worker!.maxTokens ? { maxTokens: worker!.maxTokens } : {}),
          ...(worker!.persist
            ? {
                persist: true,
                reuseKey: worker!.reuseKey,
                turnMode: worker!.turnMode ?? "fresh",
                expectedTurn: worker!.expectedTurn,
                ...(worker!.tools ? { tools: worker!.tools } : {}),
                ...(worker!.results ? { results: worker!.results } : {}),
              }
            : {}),
          deviceId: acc.device_id ?? ensureDeviceId(acc.id),
          ...(worker!.content ? { content: worker!.content } : {}),
          ...(worker!.history ? { history: worker!.history } : {}),
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
          ...(isolation ? { isolation } : {}),
          ...(teamId ? { teamId } : {}),
          ...(proxyId ? { proxyId } : {}),
          deadlineMs: 15_000, // spec-line arrival deadline (node caps at 60 s)
          ...(headersTimeoutMs ? { headersTimeoutMs } : {}),
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
    if (!res.accepted) {
      closeTunnel(sessionId, res.reasonCode ?? "open_rejected");
      // The node refused the account's pinned proxy (missing / dead in its pool): same rule as a dead heartbeat.
      if (res.reasonCode === "no_proxy_available" && freezeAccountForProxy(acc.id, { proxyId: proxyId ?? acc.bound_proxy_id ?? null, reason: `node ${conn.nodeId} refused the session: no_proxy_available (pinned proxy ${proxyId ?? acc.bound_proxy_id ?? "?"} missing or dead)` }))
        console.warn(`[registry] account ${acc.id} frozen (proxy_down): node ${conn.nodeId} answered no_proxy_available`);
      return null;
    }
    if (isolation && !activeIsolation(isolation)) {
      send(conn.socket, { type: "isolation.reset", isolation, resetId: randomUUID() });
      closeTunnel(sessionId, "isolation_retired");
      return null;
    }
    if (signal?.aborted) { cancel(); return null; }
    return opened;
  }).finally(() => signal?.removeEventListener("abort", cancel));
}

/**
 * http_egress session on a specific node, pinned to one of its pool proxies,
 * for a request that has no account row yet — onboarding (docs/onboarding.md
 * §2.1): the OAuth exchange must leave through the proxy the account is about
 * to be bound to. `bindingId` is only a label on the node side (the pin picks
 * the proxy, so the node's sticky per-account assignment is never consulted).
 */
export async function openEgressOnNode(nodeId: string, proxyId: string, bindingId: string, teamId?: string, signal?: AbortSignal): Promise<OpenedTunnel | null> {
  if (signal?.aborted || !isTrustedExecutionNode(nodeId)) return null;
  const n = one<{ provider_id: string }>("SELECT provider_id FROM nodes WHERE node_id = ?", nodeId);
  if (!n) return null;
  const conn = await waitForNodeConn(n.provider_id, nodeId);
  if (!conn || signal?.aborted) return null;
  if (teamId) {
    const policy = nodeProxyConfig(nodeId);
    if (!one("SELECT 1 FROM node_proxies WHERE id=? AND node_id=? AND status='live' AND isolation_version=1", proxyId, nodeId)) return null;
    if (!conn.capabilities?.includes("team_isolation_v1") || (conn.runtimeTeamId && conn.runtimeTeamId !== teamId) ||
      policy.proxyTeams[proxyId] !== teamId || !policy.proxyAccounts[proxyId]?.includes(bindingId)) return null;
  } else if (conn.runtimeTeamId || nodeProxyConfig(nodeId).proxyTeams[proxyId]) return null;
  const sessionId = `tun_${randomUUID()}`;
  const response = awaitOpen(conn, sessionId);
  const opened = registerOpened(conn, sessionId, "http_egress", bindingId);
  const cancel = () => {
    const pending = pendingOpens.get(sessionId);
    if (pending) { clearTimeout(pending.timer); pendingOpens.delete(sessionId); pending.resolve({ accepted: false, reasonCode: "client_cancelled" }); }
    closeTunnel(sessionId, "client_cancelled");
  };
  signal?.addEventListener("abort", cancel, { once: true });
  send(conn.socket, {
    type: "http_egress.open",
    sessionId,
    routeMode: "http_egress",
    providerId: conn.providerId,
    nodeId: conn.nodeId,
    credentialBindingId: bindingId,
    accountId: bindingId,
    proxyId,
    ...(teamId ? { teamId } : {}),
    deadlineMs: 15_000,
  });
  return response.then((res) => {
    if (!res.accepted) { closeTunnel(sessionId, res.reasonCode ?? "open_rejected"); return null; }
    if (signal?.aborted) { cancel(); return null; }
    return opened;
  }).finally(() => signal?.removeEventListener("abort", cancel));
}

export async function openCleanupEgress(nodeId: string, proxyId: string, accountId: string, teamId: string, archiveSessionId: string): Promise<OpenedTunnel | null> {
  if (!isTrustedExecutionNode(nodeId)) return null;
  const node = one<{ provider_id: string }>("SELECT provider_id FROM nodes WHERE node_id=?", nodeId);
  if (!node) return null;
  const conn = await waitForNodeConn(node.provider_id, nodeId);
  if (!conn || !conn.capabilities?.includes("team_isolation_v1") || (conn.runtimeTeamId && conn.runtimeTeamId !== teamId)) return null;
  if (!one(`SELECT 1 FROM node_proxies p JOIN proxy_team_claims c ON c.resource_key=p.resource_key AND c.team_id=p.team_id
    JOIN proxy_team_events e ON e.proxy_id=p.id AND e.team_id=p.team_id AND e.node_id=p.node_id
    WHERE p.id=? AND p.node_id=? AND p.team_id=? AND p.isolation_version=1 AND p.status='live' AND e.account_id=? AND e.event='account_bound'`, proxyId, nodeId, teamId, accountId)) return null;
  const sessionId = `tun_${randomUUID()}`;
  const pending = awaitOpen(conn, sessionId);
  const opened = registerOpened(conn, sessionId, "http_egress", accountId);
  send(conn.socket, { type: "http_egress.open", sessionId, providerId: conn.providerId, nodeId, credentialBindingId: accountId,
    accountId, teamId, proxyId, archiveSessionId, routeMode: "http_egress", deadlineMs: 15_000 });
  const accepted = await pending;
  if (!accepted.accepted) { closeTunnel(sessionId, accepted.reasonCode); return null; }
  return opened;
}

function awaitOpen(conn: NodeConn, sessionId: string): Promise<{ accepted: boolean; reasonCode?: string }> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingOpens.delete(sessionId);
      resolve({ accepted: false, reasonCode: "open_response_timeout" });
    }, OPEN_RESPONSE_TIMEOUT_MS);
    pendingOpens.set(sessionId, { nodeId: conn.nodeId, resolve, timer });
  });
}

function registerOpened(conn: NodeConn, sessionId: string, kind: TunnelKind, credentialBindingId: string, isolation?: IsolationContext): OpenedTunnel {
  sessions.set(sessionId, {
    isolation,
    sessionId,
    nodeId: conn.nodeId,
    kind,
    credentialBindingId,
    queue: [],
    waiters: [],
    closed: false,
    error: null,
    outSeq: 0,
    lastActivity: Date.now(),
  });
  return { sessionId, nodeId: conn.nodeId };
}

export function writeTunnel(sessionId: string, payload: Buffer): boolean {
  const s = sessions.get(sessionId);
  if (!s || s.closed) return false;
  if (s.isolation && !activeIsolation(s.isolation)) { s.queue = []; s.closed = true; s.error = "isolation_retired"; notify(s); return false; }
  const conn = onlineNodes.get(s.nodeId);
  const graced = conn ? null : detachedNodes.get(s.nodeId);
  if (!conn && !graced) return false;
  s.lastActivity = Date.now();
  const prefix = s.kind === "official_exit" ? "official_exit" : (s.kind ?? "official_exit");
  const frame = {
    type: `${prefix}.data`,
    sessionId,
    seq: s.outSeq++,
    payloadBase64: payload.toString("base64"),
  };
  if (conn) {
    send(conn.socket, frame);
    return true;
  }
  if (graced!.frames.length >= LINK_GRACE_MAX_FRAMES) return false;
  graced!.frames.push(frame);
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
    if (s.isolation && !activeIsolation(s.isolation)) { s.queue = []; s.closed = true; s.error = "isolation_retired"; }
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

/** Fence old frames immediately. Only runtimes that executed this epoch must
 * acknowledge teardown; an unresponsive old node is withdrawn, without blocking B. */
export async function resetIsolationSessions(isolation: IsolationContext): Promise<void> {
  if (!validIsolation(isolation)) throw new Error("invalid_isolation");
  const previous = resetTombstones.get(isolation.conversationId);
  if (!previous || previous.generation < isolation.generation) resetTombstones.set(isolation.conversationId, isolation);
  const executors = new Set(isolationExecutors.get(isolationKey(isolation)) ?? []);
  for (const s of sessions.values()) if (sameIsolation(s.isolation, isolation)) {
    executors.add(s.nodeId);
    s.queue = []; s.closed = true; s.error = "isolation_retired"; notify(s);
  }
  isolationExecutors.delete(isolationKey(isolation));
  for (const nodeId of executors) {
    const debt = nodeResetDebt.get(nodeId) ?? new Map<string, IsolationContext>();
    debt.set(isolationKey(isolation), isolation); nodeResetDebt.set(nodeId, debt);
  }
  await Promise.all([...executors].map((id) => onlineNodes.get(id)).filter((c): c is NodeConn => !!c && !!c.capabilities?.includes("team_isolation_v1"))
    .map((conn) => forceNodeReset(conn, isolation)));
}

export function closeTunnel(sessionId: string, reasonCode = "closed"): void {
  const s = sessions.get(sessionId);
  if (!s) {
    console.log(`[registry] close ${sessionId}: no such session`);
    return;
  }
  if (s.kind === "cc_worker") console.log(`[registry] close ${sessionId} (${reasonCode}): ${s.closed ? "already closed by node" : `sending cc_worker.close to ${s.nodeId}`}`);
  sessions.delete(sessionId);
  if (!s.closed) {
    s.closed = true;
    const conn = onlineNodes.get(s.nodeId);
    const prefix = s.kind === "official_exit" ? "official_exit" : (s.kind ?? "official_exit");
    const frame = { type: `${prefix}.close`, sessionId, reasonCode };
    if (conn) send(conn.socket, frame);
    else {
      const graced = detachedNodes.get(s.nodeId);
      if (graced && graced.frames.length < LINK_GRACE_MAX_FRAMES) graced.frames.push(frame);
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
