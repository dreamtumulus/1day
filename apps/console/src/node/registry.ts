import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import { all, boundProxyDown, decryptString, ensureDeviceId, isConversationGenerationActive, nowIso, one, run, sha256Hex, type AccountRow, freezeAccountForProxy, recordProxyTeamEvent } from "@1dayapi/core";
import { nodeProxyConfig, recordNodeProxyExit, freezeNodeAccountsOnProxy, NODE_PROXIES_IN_POOL_SQL, PROXY_IN_POOL_SQL } from "./proxies.js";
import { isTrustedExecutionNode } from "./trust.js";
import { oncePer } from "../log-limit.js";

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
  /** Claude Code version of the node's worker, from its last heartbeat (X-54: part of the overhead calibration key). */
  claudeVersion?: string | null;
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

/**
 * What the gateway needs to know about the node that took a cc_worker open (X-54): interactive (TUI) node or not, and
 * its Claude Code version. Both change the prompt Claude Code prepends, i.e. the platform overhead of the turn.
 */
export function nodeWorkerInfo(nodeId: string): { tui: boolean; claudeVersion: string | null } | null {
  const conn = onlineNodes.get(nodeId);
  if (!conn) return null;
  const v = /\d+\.\d+\.\d+/.exec(conn.claudeVersion ?? "");
  return { tui: !!conn.capabilities?.includes("tui_v1"), claudeVersion: v ? v[0] : null };
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

/**
 * Boot only (review fix 2026-11-10): `nodes.online` / `in_flight` are written by the control socket, which died with
 * the previous process. Every node without a live socket in THIS process shows offline with nothing in flight until it
 * reconnects (seconds for a healthy node). Returns the number of rows corrected.
 */
export function resetNodePresence(): number {
  const live = [...onlineNodes.keys()];
  return run(
    `UPDATE nodes SET online = 0, in_flight = 0 WHERE (online <> 0 OR in_flight <> 0)${live.length ? ` AND node_id NOT IN (${live.map(() => "?").join(",")})` : ""}`,
    ...live,
  ).changes;
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
        conn.claudeVersion = typeof cw.claudeVersion === "string" ? cw.claudeVersion : null;
        meta.ccWorker = {
          enabled: cw.enabled === true,
          claudeVersion: typeof cw.claudeVersion === "string" ? cw.claudeVersion : null,
          maxConcurrency: typeof cw.maxConcurrency === "number" ? cw.maxConcurrency : 0,
          active: typeof cw.active === "number" ? cw.active : 0,
          queued: typeof cw.queued === "number" ? cw.queued : 0,
          selfTestError: typeof cw.selfTestError === "string" && cw.selfTestError ? cw.selfTestError : null,
          // device-identity guard on the node (X-49): healed / failed / detected counters since the node started
          identityDrift: cw.identityDrift && typeof cw.identityDrift === "object" && !Array.isArray(cw.identityDrift) ? cw.identityDrift : null,
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

const IGNORED_LOG_MS = 10 * 60_000;

/**
 * A sharing (non-home) node's last verdict on a shared proxy (2026-11-10). The one `node_proxies` row belongs to the home
 * node; `node_proxy_shares` has no health columns, so the sharer's view is kept in memory (lost on a console restart,
 * rebuilt by the next heartbeat) and shown next to the home row's status.
 */
export interface SharerProxyView { live: boolean | null; error: string | null; exitIp: string | null; at: string }
const sharerViews = new Map<string, Map<string, SharerProxyView>>();
export function sharerProxyView(nodeId: string, proxyId: string): SharerProxyView | null {
  return sharerViews.get(nodeId)?.get(proxyId) ?? null;
}

/**
 * Heartbeat write-back: proxies[{id,live,latencyMs,error?}] and assignments{accountId:proxyId}.
 *
 * Review fix 2026-11-10: a proxy row has ONE home node. Only the home node's verdict is written to the row (status,
 * exit IP); a node that merely holds a share reports its own view, which is remembered per node and only ever freezes
 * that node's own accounts. Accounts are frozen only when the report came from a trusted execution node and — for the
 * home node — the row update actually applied. Before this, every holder overwrote the same row and one node's blip
 * froze the accounts of another node; two nodes measuring different exits triggered "exit IP changed" freezes.
 */
function recordProxyHealth(nodeId: string, msg: Record<string, unknown>): void {
  if (Array.isArray(msg.proxies)) {
    const now = nowIso();
    const trusted = isTrustedExecutionNode(nodeId);
    let pushNeeded = false;
    const seenShared = new Set<string>();
    for (const p of msg.proxies) {
      if (!p || typeof p !== "object") continue;
      const rawId = (p as Record<string, unknown>).id;
      if (typeof rawId !== "string" || !rawId) continue;
      const id = rawId.slice(0, 40);
      const live = (p as Record<string, unknown>).live;
      const err = (p as Record<string, unknown>).error;
      const errText = typeof err === "string" && err ? err : null;
      const row = one<{ node_id: string; status: string; exit_ip: string | null; isolation_version: number }>(
        `SELECT node_id, status, exit_ip, isolation_version FROM node_proxies WHERE ${NODE_PROXIES_IN_POOL_SQL} AND id = ?`, nodeId, nodeId, id);
      if (!row) {
        if (oncePer(`px-nopool:${nodeId}:${id}`, IGNORED_LOG_MS)) console.warn(`[registry] proxy report ignored: ${id.slice(0, 12)} is not in node ${nodeId}'s pool`);
        continue;
      }
      if (row.isolation_version !== 1) continue; // legacy rows are history: heartbeats never maintain them
      const ip = (p as Record<string, unknown>).exitIp;
      const exitIp = typeof ip === "string" && ip ? ip : null;
      if (row.node_id !== nodeId) {
        // ---- sharing node: its view never flips the home row ----
        seenShared.add(id);
        const views = sharerViews.get(nodeId) ?? new Map<string, SharerProxyView>();
        views.set(id, { live: live === true ? true : live === false ? false : null, error: errText?.slice(0, 300) ?? null, exitIp, at: now });
        sharerViews.set(nodeId, views);
        if (live !== true && live !== false) continue;
        if (live === false) {
          if (!trusted) {
            if (oncePer(`px-untrusted:${nodeId}:${id}`, IGNORED_LOG_MS)) console.warn(`[registry] proxy report ignored: node ${nodeId} is not a trusted execution node; its dead verdict on shared proxy ${id.slice(0, 12)} freezes nothing`);
            continue;
          }
          const frozen = freezeNodeAccountsOnProxy(id, nodeId, false, `node ${nodeId} reported the shared proxy dead${errText ? `: ${errText.slice(0, 200)}` : ""}`);
          if (frozen.length) console.warn(`[registry] shared proxy ${id.slice(0, 12)} dead on ${nodeId} → ${frozen.length} account(s) of that node frozen (proxy_down): ${frozen.join(",")}`);
          if (row.status !== "dead" && oncePer(`px-share-dead:${nodeId}:${id}`, IGNORED_LOG_MS))
            console.warn(`[registry] proxy report ignored for the row: sharing node ${nodeId} says ${id.slice(0, 12)} is dead; home node ${row.node_id} keeps status ${row.status}`);
          continue;
        }
        // live === true. A row its home node cannot verify right now (home offline, never probed) may be initialised by
        // the sharer — never changed: an existing verdict or exit stays the home node's.
        const homeOffline = !onlineNodes.has(row.node_id);
        if (homeOffline && row.status === "unknown") {
          run("UPDATE node_proxies SET status = 'live', last_check_at = ?, last_error = NULL WHERE id = ? AND status = 'unknown' AND isolation_version = 1", now, id);
          console.info(`[registry] shared proxy ${id.slice(0, 12)}: first verdict taken from sharing node ${nodeId} (home node ${row.node_id} is offline)`);
        } else if (row.status !== "live" && oncePer(`px-share-live:${nodeId}:${id}`, IGNORED_LOG_MS)) {
          console.info(`[registry] proxy report ignored for the row: sharing node ${nodeId} says ${id.slice(0, 12)} is live; home node ${row.node_id} keeps status ${row.status}`);
        }
        if (exitIp && !row.exit_ip && homeOffline) {
          recordNodeProxyExit(nodeId, id, exitIp);
          pushNeeded = true;
        } else if (exitIp && row.exit_ip && row.exit_ip !== exitIp && oncePer(`px-share-exit:${nodeId}:${id}:${exitIp}`, IGNORED_LOG_MS)) {
          console.warn(`[registry] proxy report ignored: sharing node ${nodeId} measured exit ${exitIp} for ${id.slice(0, 12)}, home node ${row.node_id} recorded ${row.exit_ip}; the home row is unchanged`);
        }
        continue;
      }
      // ---- home node ----
      if (live !== true && live !== false) {
        // Not probed yet (node just (re)started or pool just replaced). Keep the
        // last known live/dead verdict until the node re-probes: flipping every
        // bound account to "proxy unknown" on each node restart would take them
        // all out of scheduling for the whole probe pass.
        run("UPDATE node_proxies SET status = 'unknown' WHERE node_id = ? AND id = ? AND isolation_version=1 AND status NOT IN ('live', 'dead')", nodeId, id);
        continue;
      }
      const applied = run(
        "UPDATE node_proxies SET status = ?, last_check_at = ?, last_error = ? WHERE node_id = ? AND id = ? AND isolation_version=1",
        live ? "live" : "dead",
        now,
        errText ? errText.slice(0, 300) : null,
        nodeId,
        id,
      ).changes > 0;
      if (live === false) {
        // Operator rule 2026-11-01: a dead proxy freezes its accounts (status proxy_down) until an operator
        // releases or rebinds them — the account never silently comes back or moves to another exit.
        if (!applied) {
          if (oncePer(`px-noapply:${nodeId}:${id}`, IGNORED_LOG_MS)) console.warn(`[registry] proxy report ignored: dead verdict for ${id.slice(0, 12)} from ${nodeId} did not apply to a row; nothing frozen`);
        } else if (!trusted) {
          if (oncePer(`px-untrusted:${nodeId}:${id}`, IGNORED_LOG_MS)) console.warn(`[registry] proxy ${id.slice(0, 12)} reported dead by ${nodeId}, which is not a trusted execution node: status recorded, no account frozen`);
        } else {
          const frozen = freezeNodeAccountsOnProxy(id, nodeId, true, `node ${nodeId} reported the bound proxy dead${errText ? `: ${errText.slice(0, 200)}` : ""}`);
          if (frozen.length) console.warn(`[registry] proxy ${id.slice(0, 12)} on ${nodeId} dead → ${frozen.length} account(s) frozen (proxy_down): ${frozen.join(",")}`);
        }
        continue;
      }
      if (!exitIp) {
        // The node reports the proxy alive without an exit measurement: its pool copy was
        // just replaced (fresh health, probe pass not finished) or a served request called
        // markAlive. A proxy whose exit was already verified keeps that identity until the
        // next measured heartbeat (a changed or conflicting IP is still handled below);
        // treating it as "identity unavailable" marked every bound proxy dead and pushed
        // the pool again, which reset the node's probe and restarted the loop (2026-10-28).
        // An exit that was never measured is still refused: it cannot carry a team.
        if (!row.exit_ip && !recordNodeProxyExit(nodeId, id, "")) pushNeeded = true;
        continue;
      }
      const accepted = recordNodeProxyExit(nodeId, id, exitIp);
      if (!accepted || row.exit_ip !== exitIp) pushNeeded = true;
      const country = (p as Record<string, unknown>).exitCountry;
      if (typeof country === "string" && /^[A-Z]{2}$/.test(country)) {
        run("UPDATE node_proxies SET exit_country = ? WHERE node_id = ? AND id = ? AND (exit_country IS NULL OR exit_country <> ?)", country, nodeId, id, country);
      }
    }
    // A share that left the report (removed from the pool) has no view any more.
    const views = sharerViews.get(nodeId);
    if (views) {
      for (const k of [...views.keys()]) if (!seenShared.has(k)) views.delete(k);
      if (!views.size) sharerViews.delete(nodeId);
    }
    // One pool push per heartbeat at most: pushing inside the loop (once per changed proxy)
    // replaced the node's pool a dozen times per heartbeat.
    if (pushNeeded) pushProxies(nodeId, []);
  }
  if (msg.assignments && typeof msg.assignments === "object" && !Array.isArray(msg.assignments)) {
    const now = nowIso();
    const reported = Object.entries(msg.assignments as Record<string, unknown>).filter(
      (e): e is [string, string] => typeof e[1] === "string" && !!e[0] && !!e[1],
    );
    // Review fix 2026-11-10: an untrusted node's report, or one with no entry matching the platform's own binding,
    // used to pass the filter as "empty" and the DELETE below then wiped every mapping of the node. Such a report is
    // now ignored (and said so); mappings only change on a trusted report with at least one valid entry.
    if (!isTrustedExecutionNode(nodeId)) {
      if (reported.length && oncePer(`asg-untrusted:${nodeId}`, IGNORED_LOG_MS)) console.warn(`[registry] assignments report ignored: node ${nodeId} is not a trusted execution node (${reported.length} entr${reported.length === 1 ? "y" : "ies"})`);
      return;
    }
    const entries = reported.filter(([accountId, proxyId]) => !!one(
      "SELECT 1 FROM accounts WHERE id=? AND node_id=? AND team_id IS NOT NULL AND bound_proxy_id=?", accountId, nodeId, proxyId,
    ));
    if (entries.length < reported.length) {
      const valid = new Set(entries.map(([a]) => a));
      const rejected = reported.filter(([a]) => !valid.has(a));
      if (oncePer(`asg-mismatch:${nodeId}:${rejected.map(([a, p]) => `${a}=${p}`).sort().join(",").slice(0, 400)}`, IGNORED_LOG_MS))
        console.warn(`[registry] assignments report from ${nodeId}: ${rejected.length} entr${rejected.length === 1 ? "y" : "ies"} ignored (not a managed account of this node, or bound to another proxy): ${rejected.slice(0, 10).map(([a, p]) => `${a.slice(0, 8)}→${p.slice(0, 12)}`).join(", ")}`);
    }
    if (!entries.length) return; // nothing valid: keep the existing mappings
    // Heartbeats maintain only the new managed namespace. Legacy mappings are history.
    run(
      `DELETE FROM node_proxy_assignments WHERE node_id = ? AND account_id IN (SELECT id FROM accounts WHERE team_id IS NOT NULL AND node_id=?)
         AND account_id NOT IN (${entries.map(() => "?").join(",")})`,
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

// ---------- device identity mismatch alerts (review fix 2026-11-10, X-49 follow-up) ----------
// A node reporting a deviceId / teamId / accountUuid that differs from the registered one (or a deviceId another
// account already uses) used to be dropped without a trace. Now: counted in memory (GET /api/admin/health/identity),
// logged as an ALERT line and written to proxy_team_events (event device_identity_mismatch) — log and event at most
// once per account per 10 minutes, the counters on every report.

const IDENTITY_ALERT_MS = 10 * 60_000;
export interface IdentityMismatch {
  at: string; nodeId: string; nodeName: string; accountId: string; teamId: string | null;
  kind: "team" | "device" | "account_uuid" | "device_in_use";
  /** First 8 characters only: enough to compare, not a usable identity. */
  reported: string; registered: string;
}
const identityStats = { total: 0, byKind: { team: 0, device: 0, account_uuid: 0, device_in_use: 0 } as Record<IdentityMismatch["kind"], number>, since: nowIso() };
const identityByAccount = new Map<string, { count: number; lastAt: string; kind: IdentityMismatch["kind"]; nodeId: string }>();
const identityRecent: IdentityMismatch[] = [];

function nodeLabel(nodeId: string): string {
  return one<{ name: string | null }>("SELECT json_extract(deploy_meta, '$.name') AS name FROM nodes WHERE node_id = ?", nodeId)?.name || nodeId;
}
const short8 = (v: string | null | undefined) => (v ? v.slice(0, 8) : "-");

function noteIdentityMismatch(m: { nodeId: string; accountId: string; teamId: string | null; kind: IdentityMismatch["kind"]; reported: string | null; registered: string | null }): void {
  const at = nowIso();
  identityStats.total++;
  identityStats.byKind[m.kind]++;
  const prev = identityByAccount.get(m.accountId);
  if (!prev && identityByAccount.size >= 2000) identityByAccount.delete(identityByAccount.keys().next().value!);
  identityByAccount.set(m.accountId, { count: (prev?.count ?? 0) + 1, lastAt: at, kind: m.kind, nodeId: m.nodeId });
  if (!oncePer(`ccid-alert:${m.accountId}`, IDENTITY_ALERT_MS)) return;
  const name = nodeLabel(m.nodeId);
  identityRecent.push({ at, nodeId: m.nodeId, nodeName: name, accountId: m.accountId, teamId: m.teamId, kind: m.kind, reported: short8(m.reported), registered: short8(m.registered) });
  if (identityRecent.length > 50) identityRecent.splice(0, identityRecent.length - 50);
  console.warn(`[registry] ALERT device identity mismatch node=${name} account=${m.accountId.slice(0, 8)} reported=${short8(m.reported)} registered=${short8(m.registered)} kind=${m.kind}`);
  try {
    recordProxyTeamEvent({ resourceKey: `account:${m.accountId}`, nodeId: m.nodeId, teamId: m.teamId, accountId: m.accountId, event: "device_identity_mismatch",
      reason: `${m.kind}: node reported ${short8(m.reported)}, registered ${short8(m.registered)}; the report was not applied` });
  } catch (err) {
    console.error(`[registry] device identity mismatch event not recorded: ${(err as Error)?.message ?? err}`);
  }
}

/** Counters since process start + the last 50 alerts (newest first) for GET /api/admin/health/identity. */
export function identityHealth() {
  return {
    since: identityStats.since,
    mismatches: identityStats.total,
    byKind: { ...identityStats.byKind },
    accounts: [...identityByAccount.entries()].map(([accountId, v]) => ({ accountId, ...v })).sort((a, b) => b.lastAt.localeCompare(a.lastAt)).slice(0, 200),
    recent: [...identityRecent].reverse(),
  };
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
    if (!acc || !acc.team_id || !isTrustedExecutionNode(nodeId)) {
      // Not an identity conflict, but no longer silent: the report cannot be used at all.
      if (oncePer(`ccid-skip:${nodeId}:${accountId}`, 3_600_000))
        console.warn(`[registry] device identity report ignored node=${nodeLabel(nodeId)} account=${accountId.slice(0, 8)}: ${!acc ? "account is not bound to this node" : !acc.team_id ? "legacy account without an organization" : "node is not a trusted execution node"}`);
      continue;
    }
    const reportedTeam = (v as Record<string, unknown>).teamId;
    const other = deviceId ? one<{ id: string }>("SELECT id FROM accounts WHERE device_id=? AND id<>?", deviceId, accountId) : undefined;
    const kind: IdentityMismatch["kind"] | null =
      reportedTeam !== acc.team_id ? "team"
      : acc.device_id && deviceId && deviceId !== acc.device_id ? "device"
      : acc.account_uuid && accountUuid && acc.account_uuid !== accountUuid ? "account_uuid"
      : other ? "device_in_use"
      : null;
    if (kind) {
      const [reported, registered] = kind === "team" ? [typeof reportedTeam === "string" ? reportedTeam : null, acc.team_id]
        : kind === "account_uuid" ? [accountUuid, acc.account_uuid]
        : kind === "device_in_use" ? [deviceId, other!.id]
        : [deviceId, acc.device_id];
      noteIdentityMismatch({ nodeId, accountId, teamId: acc.team_id, kind, reported, registered });
      continue;
    }
    // A report that omits the device while one is registered updates nothing (unchanged behaviour, not a conflict).
    if (acc.device_id && !deviceId) continue;
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
    if ((policy.proxyTeamBinding !== "accounts_only" && policy.proxyTeams[proxyId] !== teamId) || !policy.proxyAccounts[proxyId]?.includes(acc.id)) return null;
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
    if (!one(`SELECT 1 FROM node_proxies WHERE id=? AND ${NODE_PROXIES_IN_POOL_SQL} AND status='live' AND isolation_version=1`, proxyId, nodeId, nodeId)) return null;
    if (!conn.capabilities?.includes("team_isolation_v1") || (conn.runtimeTeamId && conn.runtimeTeamId !== teamId) ||
      (policy.proxyTeamBinding !== "accounts_only" && policy.proxyTeams[proxyId] !== teamId) || !policy.proxyAccounts[proxyId]?.includes(bindingId)) return null;
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
  // The account_bound event carries the node of the account (home or sharing node, 2026-11-08), so match it on `nodeId`.
  if (!one(`SELECT 1 FROM node_proxies p JOIN proxy_team_claims c ON c.resource_key=p.resource_key AND c.team_id=p.team_id
    JOIN proxy_team_events e ON e.proxy_id=p.id AND e.team_id=p.team_id AND e.node_id=?
    WHERE p.id=? AND ${PROXY_IN_POOL_SQL} AND p.team_id=? AND p.isolation_version=1 AND p.status='live' AND e.account_id=? AND e.event='account_bound'`, nodeId, proxyId, nodeId, nodeId, teamId, accountId)) return null;
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
