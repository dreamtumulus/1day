import WebSocket from "ws";
import { CcWorkerManager } from "./cc-worker.js";
import { HttpEgressManager } from "./http-egress.js";
import { IsolationGuard, validIsolation } from "./isolation.js";
import { OfficialExitManager } from "./official-exit.js";
import type { ProxyPool } from "./proxy-pool.js";
import {
  HEARTBEAT_INTERVAL_MS,
  PROTOCOL_CAPABILITIES,
  SUPPRESS_RECONNECT_REASONS,
  type CcWorkerClose,
  type CcWorkerOpen,
  type HttpEgressClose,
  type HttpEgressData,
  type HttpEgressOpen,
  type OfficialExitClose,
  type OfficialExitData,
  type OfficialExitOpen,
  type PlatformToNodeMessage,
  type ProxiesSet,
} from "./protocol.js";
import { NODE_VERSION } from "./version.js";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";

/** sha256 prefix of the running bundle (what the admin sees as the deployed build). */
const BUNDLE_HASH: string | null = (() => {
  try {
    const main = process.argv[1];
    return main ? crypto.createHash("sha256").update(fs.readFileSync(main)).digest("hex").slice(0, 12) : null;
  } catch {
    return null;
  }
})();
const PROCESS_STARTED = Date.now();
// eslint-disable-next-line no-var
declare const Bun: { version?: string } | undefined;

export type BridgeState =
  | "disabled" // not bound
  | "connecting"
  | "connected" // socket open, hello sent, awaiting platform.ready
  | "ready"
  | "backing_off"
  | "suppressed"; // close reason forbids reconnect (paused/revoked/...)

const BACKOFF_BASE_MS = 2_000;
const BACKOFF_MAX_MS = 30_000;
const BACKOFF_JITTER = 0.25;
const BACKOFF_CYCLE = 10; // after 10 attempts, wrap back to base
/** No frame (message / ping / pong) from the platform for this long = half-open socket: reconnect. */
const LIVENESS_TIMEOUT_MS = 90_000;
/**
 * Link grace (2026-10-19): when the platform socket drops, sessions stay alive
 * and their outbound frames are buffered for this long; after a reconnect the
 * platform's `retainedSessions` says which ones continue. Slightly longer than
 * the platform's own grace (30 s) so the platform decides first.
 */
const LINK_GRACE_MS = 35_000;
const LINK_GRACE_MAX_FRAMES = 5_000;
const LINK_GRACE_MAX_BYTES = 48 * 1024 * 1024;
const SESSION_FRAME_RE = /^(official_exit|http_egress|cc_worker)\./;

export interface BridgeStatus {
  state: BridgeState;
  wsUrl: string | null;
  acceptingSessions: boolean;
  inFlight: number;
  officialExitActiveSessions: number;
  httpEgressActiveSessions: number;
  reconnectAttempts: number;
  nextRetryAt: string | null;
  lastError: string | null;
  lastClose: { code: number; reason: string } | null;
  suppressedReason: string | null;
  readyAt: string | null;
}

export interface BridgeDeps {
  /** Returns null when unbound. */
  identity: () => { nodeId: string; providerId: string; secret: string; wsUrl: string } | null;
  pool: ProxyPool;
  /** Node data dir (cc_worker per-account CLAUDE_CONFIG_DIRs live under it). */
  dataDir: string;
  log?: (msg: string) => void;
}

export class PlatformBridge {
  private deps: BridgeDeps;
  private ws: WebSocket | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private lastFrameAt = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private stopped = true;
  private attempts = 0;
  private draining = false;
  private state: BridgeState = "disabled";
  private lastError: string | null = null;
  private lastClose: { code: number; reason: string } | null = null;
  private suppressedReason: string | null = null;
  private nextRetryAt: number | null = null;
  private readyAt: string | null = null;
  private graceTimer: NodeJS.Timeout | null = null;
  private pendingFrames: Array<{ sessionId: string; json: string }> = [];
  private pendingBytes = 0;
  private exitManager: OfficialExitManager;
  private egressManager: HttpEgressManager;
  private workerManager: CcWorkerManager;

  constructor(deps: BridgeDeps) {
    this.deps = deps;
    const managerOpts = {
      isolationGuard: new IsolationGuard(),
      send: (msg: unknown) => this.send(msg),
      identity: () => {
        const id = this.deps.identity();
        return { nodeId: id?.nodeId ?? "", providerId: id?.providerId };
      },
      isDraining: () => this.draining,
      log: (m: string) => this.log(m),
    };
    this.exitManager = new OfficialExitManager(managerOpts);
    this.egressManager = new HttpEgressManager({ ...managerOpts, pool: deps.pool });
    this.workerManager = new CcWorkerManager({ ...managerOpts, pool: deps.pool, dataDir: deps.dataDir });
  }

  /** cc_worker telemetry for the local console (server.ts). */
  ccWorkerStats(): ReturnType<CcWorkerManager["stats"]> {
    return this.workerManager.stats();
  }

  private log(msg: string): void {
    this.deps.log?.(`[bridge] ${msg}`);
  }

  status(): BridgeStatus {
    return {
      state: this.state,
      wsUrl: this.deps.identity()?.wsUrl ?? null,
      acceptingSessions: !this.draining && this.state === "ready",
      inFlight: this.exitManager.activeSessions + this.egressManager.activeSessions + this.workerManager.activeSessions,
      officialExitActiveSessions: this.exitManager.activeSessions,
      httpEgressActiveSessions: this.egressManager.activeSessions,
      reconnectAttempts: this.attempts,
      nextRetryAt: this.nextRetryAt ? new Date(this.nextRetryAt).toISOString() : null,
      lastError: this.lastError,
      lastClose: this.lastClose,
      suppressedReason: this.suppressedReason,
      readyAt: this.readyAt,
    };
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  /** Call after bind/unbind so the new identity takes effect immediately. */
  reconnectNow(): void {
    this.clearTimers();
    this.attempts = 0;
    this.suppressedReason = null;
    this.nextRetryAt = null;
    if (this.ws) {
      const ws = this.ws;
      this.ws = null;
      ws.removeAllListeners();
      ws.on("error", () => {}); // close() while CONNECTING emits an error; without a listener it would crash the process
      try {
        if (ws.readyState === WebSocket.OPEN) ws.close(1000, "identity_changed");
        else ws.terminate();
      } catch {
        /* ignore */
      }
    }
    this.exitManager.closeAll("identity_changed");
    this.egressManager.closeAll("identity_changed");
    this.workerManager.closeAll("identity_changed");
    if (!this.stopped) this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    this.exitManager.closeAll("node_shutdown");
    this.egressManager.closeAll("node_shutdown");
    this.workerManager.closeAll("node_shutdown");
    if (this.ws) {
      const ws = this.ws;
      this.ws = null;
      try {
        ws.close(1000, "node_shutdown");
      } catch {
        /* ignore */
      }
    }
    this.state = "disabled";
  }

  private clearTimers(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.graceTimer) clearTimeout(this.graceTimer);
    this.heartbeatTimer = null;
    this.reconnectTimer = null;
    this.graceTimer = null;
    this.pendingFrames = [];
    this.pendingBytes = 0;
  }

  /** Every session this node still runs (hello after a reconnect). */
  private sessionIds(): string[] {
    return [...this.exitManager.sessionIds(), ...this.egressManager.sessionIds(), ...this.workerManager.sessionIds()];
  }

  private closeAllSessions(reasonCode: string): void {
    this.exitManager.closeAll(reasonCode);
    this.egressManager.closeAll(reasonCode);
    this.workerManager.closeAll(reasonCode);
    this.pendingFrames = [];
    this.pendingBytes = 0;
  }

  /** Socket gone: keep sessions and buffer their frames until the platform is back or the grace expires. */
  private onLinkLost(): void {
    if (this.graceTimer) return;
    const held = this.inFlight;
    if (held === 0) return;
    this.log(`link lost; holding ${held} session(s) for up to ${LINK_GRACE_MS}ms`);
    this.graceTimer = setTimeout(() => {
      this.graceTimer = null;
      this.log(`platform not back within ${LINK_GRACE_MS}ms; closing ${this.inFlight} session(s)`);
      this.closeAllSessions("transport_lost");
    }, LINK_GRACE_MS);
    this.graceTimer.unref?.();
  }

  /** platform.ready after a reconnect: drop sessions the platform did not keep, flush the rest's buffered frames. */
  private reconcileAfterReconnect(retained: string[] | null): void {
    const hadGrace = this.graceTimer !== null;
    if (this.graceTimer) clearTimeout(this.graceTimer);
    this.graceTimer = null;
    const live = this.sessionIds();
    if (live.length === 0 && this.pendingFrames.length === 0) return;
    if (!retained) {
      // Older platform: it failed everything when the socket dropped.
      this.log(`platform kept no session list; closing ${live.length} session(s)`);
      this.closeAllSessions("transport_lost");
      return;
    }
    const keep = new Set(retained);
    let dropped = 0;
    for (const id of live) {
      if (keep.has(id)) continue;
      dropped++;
      this.exitManager.handleClose({ type: "official_exit.close", sessionId: id, reasonCode: "platform_lost_session" } as OfficialExitClose);
      this.egressManager.handleClose({ type: "http_egress.close", sessionId: id, reasonCode: "platform_lost_session" } as HttpEgressClose);
      this.workerManager.handleClose({ type: "cc_worker.close", sessionId: id, reasonCode: "platform_lost_session" } as CcWorkerClose);
    }
    const frames = this.pendingFrames;
    this.pendingFrames = [];
    this.pendingBytes = 0;
    let flushed = 0;
    for (const f of frames) {
      if (keep.has(f.sessionId) && this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(f.json);
        flushed++;
      }
    }
    if (hadGrace || dropped || flushed) this.log(`reconciled after reconnect: ${live.length - dropped} session(s) continue, ${dropped} dropped by platform, ${flushed}/${frames.length} buffered frame(s) flushed`);
  }

  private connect(): void {
    const id = this.deps.identity();
    if (!id) {
      this.state = "disabled";
      return;
    }
    this.state = "connecting";
    this.readyAt = null;
    this.log(`connecting to ${id.wsUrl}`);
    const ws = new WebSocket(id.wsUrl, {
      headers: {
        "x-provider-node-id": id.nodeId,
        "x-provider-node-secret": id.secret,
      },
    });
    this.ws = ws;

    ws.on("open", () => {
      this.state = "connected";
      this.workerManager.scanIdentities(); // first heartbeat after (re)connect carries every account's device identity
      this.attempts = 0;
      this.lastError = null;
      this.lastFrameAt = Date.now();
      this.send({
        type: "provider.hello",
        nodeId: id.nodeId,
        providerId: id.providerId,
        nodeVersion: NODE_VERSION,
        capabilities: [...PROTOCOL_CAPABILITIES],
        ...(process.env.PROVIDER_TEAM_ID ? { runtimeTeamId: process.env.PROVIDER_TEAM_ID } : {}),
        isolatedContexts: [...this.workerManager.isolatedContexts(), ...this.egressManager.isolatedContexts()],
        acceptingSessions: !this.draining,
        sessions: this.sessionIds(),
      });
    });

    ws.on("ping", () => {
      this.lastFrameAt = Date.now(); // ws answers the pong itself
    });
    ws.on("pong", () => {
      this.lastFrameAt = Date.now();
    });
    ws.on("message", (raw: WebSocket.RawData) => {
      this.lastFrameAt = Date.now();
      let msg: PlatformToNodeMessage;
      try {
        msg = JSON.parse(raw.toString()) as PlatformToNodeMessage;
      } catch {
        return;
      }
      switch (msg.type) {
        case "platform.ready": {
          if (msg.nodeId && msg.nodeId !== id.nodeId) {
            this.log(`platform.ready for foreign nodeId ${msg.nodeId}; ignoring`);
            return;
          }
          this.state = "ready";
          this.readyAt = new Date().toISOString();
          this.log("platform.ready received");
          this.reconcileAfterReconnect(Array.isArray(msg.retainedSessions) ? msg.retainedSessions.map(String) : null);
          this.startHeartbeat();
          break;
        }
        case "official_exit.open":
          this.exitManager.handleOpen(msg as OfficialExitOpen);
          break;
        case "official_exit.data":
          this.exitManager.handleData(msg as OfficialExitData);
          break;
        case "official_exit.close":
          this.exitManager.handleClose(msg as OfficialExitClose);
          break;
        case "http_egress.open":
          this.egressManager.handleOpen(msg as HttpEgressOpen);
          break;
        case "http_egress.data":
          this.egressManager.handleData(msg as HttpEgressData);
          break;
        case "http_egress.close":
          this.egressManager.handleClose(msg as HttpEgressClose);
          break;
        case "cc_worker.open":
          this.workerManager.handleOpen(msg as CcWorkerOpen);
          break;
        case "cc_worker.close":
          this.workerManager.handleClose(msg as CcWorkerClose);
          break;
        case "isolation.reset":
          if (validIsolation(msg.isolation)) {
            this.workerManager.resetConversation(msg.isolation);
            this.egressManager.resetConversation(msg.isolation);
            this.send({ type: "isolation.reset_ack", resetId: msg.resetId });
          }
          break;
        case "proxies.set": {
          const set = msg as ProxiesSet;
          const urls = Array.isArray(set.proxies)
            ? set.proxies.filter((p): p is string => typeof p === "string")
            : [];
          const { accepted, rejected } = this.deps.pool.replaceAll(urls, { proxyTeams: set.proxyTeams, proxyAccounts: set.proxyAccounts });
          this.log(`proxies.set applied: ${accepted} accepted, ${rejected} rejected`);
          break;
        }
        default:
          break;
      }
    });

    ws.on("error", (err: Error) => {
      this.lastError = err.message;
      this.log(`socket error: ${err.message}`);
    });

    ws.on("close", (code: number, reasonBuf: Buffer) => {
      if (this.ws !== ws) return; // stale socket (identity changed)
      this.ws = null;
      if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
      const reason = reasonBuf.toString();
      this.lastClose = { code, reason };
      this.log(`socket closed (code ${code}${reason ? `, ${reason}` : ""})`);
      if (this.stopped) return; // stop() already closed the sessions
      if (SUPPRESS_RECONNECT_REASONS.has(reason)) {
        this.state = "suppressed";
        this.suppressedReason = reason;
        this.closeAllSessions("transport_lost");
        this.log(`reconnect suppressed by platform: ${reason}`);
        return;
      }
      this.onLinkLost();
      this.scheduleReconnect();
    });
  }

  /** Sessions currently running on this node (all three managers). */
  get inFlight(): number {
    return this.exitManager.activeSessions + this.egressManager.activeSessions + this.workerManager.activeSessions;
  }

  /**
   * Graceful shutdown, phase 1: stop taking new sessions (platform routes
   * elsewhere / waits, see console registry waitForNodeConn) while in-flight
   * ones finish. The heartbeat goes out immediately so the platform learns
   * within one RTT instead of up to HEARTBEAT_INTERVAL_MS later.
   */
  beginDrain(): void {
    if (this.draining) return;
    this.draining = true;
    this.workerManager.retireIdle("drain");
    this.log(`draining: ${this.inFlight} session(s) in flight, no new sessions accepted`);
    this.sendHeartbeat();
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    const beat = (): void => this.sendHeartbeat();
    this.heartbeatTimer = setInterval(beat, HEARTBEAT_INTERVAL_MS);
    this.heartbeatTimer.unref?.();
    beat();
  }

  private sendHeartbeat(): void {
    {
      const id = this.deps.identity();
      if (!id) return;
      if (this.ws && this.lastFrameAt && Date.now() - this.lastFrameAt > LIVENESS_TIMEOUT_MS) {
        // Half-open TCP (NAT drop, suspend): the platform pings every 30 s, so
        // silence this long means the socket is dead. terminate() fires "close" → reconnect.
        this.log(`no frame from platform for ${Math.round((Date.now() - this.lastFrameAt) / 1000)}s; reconnecting`);
        this.ws.terminate();
        return;
      }
      const { proxies, assignments } = this.deps.pool.heartbeatReport();
      this.send({
        type: "provider.heartbeat",
        nodeId: id.nodeId,
        inFlight: this.exitManager.activeSessions + this.egressManager.activeSessions + this.workerManager.activeSessions,
        healthy: true,
        officialExit: { activeSessions: this.exitManager.activeSessions },
        acceptingSessions: !this.draining,
        proxies,
        assignments,
        ccWorker: this.workerManager.stats(),
        egress: { activeSessions: this.egressManager.activeSessions },
        host: {
          totalMemMb: Math.round(os.totalmem() / 1048576),
          freeMemMb: Math.round(os.freemem() / 1048576),
          load1: Math.round(os.loadavg()[0] * 100) / 100,
          load5: Math.round(os.loadavg()[1] * 100) / 100,
          cpus: os.cpus().length,
          uptimeSec: Math.round(os.uptime()),
          processRssMb: Math.round(process.memoryUsage().rss / 1048576),
          processUptimeSec: Math.round((Date.now() - PROCESS_STARTED) / 1000),
          bunVersion: typeof Bun !== "undefined" ? (Bun as { version?: string }).version ?? null : null,
          nodeVersion: NODE_VERSION,
          bundleHash: BUNDLE_HASH,
          draining: this.draining,
        },
        ...(() => {
          const d = this.workerManager.identityDelta();
          return Object.keys(d).length ? { ccIdentities: d } : {};
        })(),
      });
    }
  }

  private scheduleReconnect(): void {
    const exp = Math.min(this.attempts, BACKOFF_CYCLE - 1);
    const base = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** exp);
    const jitter = base * BACKOFF_JITTER * (Math.random() * 2 - 1);
    const delay = Math.round(base + jitter);
    this.attempts = (this.attempts + 1) % BACKOFF_CYCLE;
    this.state = "backing_off";
    this.nextRetryAt = Date.now() + delay;
    this.log(`reconnect in ${delay}ms (attempt ${this.attempts})`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.nextRetryAt = null;
      if (!this.stopped) this.connect();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private send(message: unknown): boolean {
    const json = JSON.stringify(message);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(json);
      return true;
    }
    // Link grace: session frames produced while the platform is away are kept for the reconnect.
    const m = message as { type?: unknown; sessionId?: unknown };
    if (this.graceTimer && typeof m?.type === "string" && SESSION_FRAME_RE.test(m.type) && typeof m.sessionId === "string") {
      if (this.pendingFrames.length >= LINK_GRACE_MAX_FRAMES || this.pendingBytes + json.length > LINK_GRACE_MAX_BYTES) {
        this.log(`link-grace buffer full (${this.pendingFrames.length} frames, ${Math.round(this.pendingBytes / 1048576)} MiB); closing sessions`);
        if (this.graceTimer) clearTimeout(this.graceTimer);
        this.graceTimer = null;
        this.closeAllSessions("transport_lost");
        return false;
      }
      this.pendingFrames.push({ sessionId: m.sessionId, json });
      this.pendingBytes += json.length;
      return true;
    }
    return false;
  }
}
