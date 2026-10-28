import net from "node:net";
import type {
  OfficialExitClose,
  OfficialExitData,
  OfficialExitOpen,
} from "./protocol.js";
import { isHostAllowed } from "./whitelist.js";

const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
const MAX_PAYLOAD_BYTES = 4 * 1024 * 1024;

interface ExitSession {
  sessionId: string;
  socket: net.Socket;
  outSeq: number;
  closed: boolean;
  targetHost: string;
  targetPort: number;
  createdAt: number;
}

export interface ExitIdentity {
  nodeId: string;
  providerId?: string;
}

export interface OfficialExitManagerOptions {
  /** Sends a protocol message over the platform WS; false when not connected. */
  send: (message: unknown) => boolean;
  identity: () => ExitIdentity;
  isDraining: () => boolean;
  hostAllowed?: (host: string) => boolean;
  log?: (msg: string) => void;
}

/**
 * Raw-TCP relay for official_exit sessions. The node only ever moves
 * encrypted bytes; TLS terminates on the gateway side.
 */
export class OfficialExitManager {
  private sessions = new Map<string, ExitSession>();
  private opts: OfficialExitManagerOptions;

  constructor(opts: OfficialExitManagerOptions) {
    this.opts = opts;
  }

  get activeSessions(): number {
    return this.sessions.size;
  }

  private log(msg: string): void {
    this.opts.log?.(`[official-exit] ${msg}`);
  }

  handleOpen(msg: OfficialExitOpen): void {
    const reject = (reasonCode: string): void => {
      this.opts.send({
        type: "official_exit.open_response",
        sessionId: msg.sessionId,
        accepted: false,
        reasonCode,
      });
      this.log(`rejected ${msg.sessionId}: ${reasonCode} (${msg.targetHost}:${msg.targetPort})`);
    };

    const identity = this.opts.identity();
    if (process.env.PROVIDER_TEAM_ID) { reject("team_runtime_requires_pinned_egress"); return; }
    if (msg.nodeId !== identity.nodeId || (identity.providerId && msg.providerId !== identity.providerId)) {
      reject("node_identity_mismatch");
      return;
    }
    if (this.opts.isDraining()) {
      reject("node_draining");
      return;
    }
    const allowed = (this.opts.hostAllowed ?? isHostAllowed)(msg.targetHost);
    if (!allowed) {
      reject("target_not_allowed");
      return;
    }
    if (!Number.isInteger(msg.targetPort) || msg.targetPort < 1 || msg.targetPort > 65535) {
      reject("invalid_target_port");
      return;
    }
    if (this.sessions.has(msg.sessionId)) {
      reject("duplicate_session");
      return;
    }

    const timeoutMs =
      Number.isFinite(msg.deadlineMs) && msg.deadlineMs > 0
        ? Math.min(msg.deadlineMs, 60_000)
        : DEFAULT_CONNECT_TIMEOUT_MS;

    const socket = net.connect({ host: msg.targetHost, port: msg.targetPort });
    const session: ExitSession = {
      sessionId: msg.sessionId,
      socket,
      outSeq: 0,
      closed: false,
      targetHost: msg.targetHost,
      targetPort: msg.targetPort,
      createdAt: Date.now(),
    };
    this.sessions.set(msg.sessionId, session);

    socket.setTimeout(timeoutMs);
    socket.once("connect", () => {
      socket.setTimeout(0);
      this.opts.send({
        type: "official_exit.open_response",
        sessionId: msg.sessionId,
        accepted: true,
      });
      this.log(`opened ${msg.sessionId} -> ${msg.targetHost}:${msg.targetPort}`);
    });
    socket.on("data", (chunk: Buffer) => {
      session.outSeq += 1;
      this.opts.send({
        type: "official_exit.data",
        sessionId: msg.sessionId,
        seq: session.outSeq,
        payloadBase64: chunk.toString("base64"),
      });
    });
    socket.on("timeout", () => {
      this.failSession(session, "connect_timeout", `Timed out connecting to ${msg.targetHost}:${msg.targetPort}`, true);
    });
    socket.on("error", (err: NodeJS.ErrnoException) => {
      this.failSession(session, err.code ?? "socket_error", err.message, true);
    });
    socket.on("close", (hadError: boolean) => {
      if (session.closed) return;
      session.closed = true;
      this.sessions.delete(msg.sessionId);
      if (!hadError) {
        this.opts.send({
          type: "official_exit.close",
          sessionId: msg.sessionId,
          reasonCode: "target_closed",
        });
      }
      this.log(`closed ${msg.sessionId}`);
    });
  }

  handleData(msg: OfficialExitData): void {
    const session = this.sessions.get(msg.sessionId);
    if (!session || session.closed) return;
    const payload = Buffer.from(msg.payloadBase64, "base64");
    if (payload.length === 0 || payload.length > MAX_PAYLOAD_BYTES) return;
    session.socket.write(payload);
  }

  handleClose(msg: OfficialExitClose): void {
    const session = this.sessions.get(msg.sessionId);
    if (!session || session.closed) return;
    this.finishSession(session);
  }

  private failSession(session: ExitSession, errorCode: string, errorMessage: string, retryable: boolean): void {
    if (session.closed) return;
    session.closed = true;
    this.sessions.delete(session.sessionId);
    session.socket.destroy();
    this.opts.send({
      type: "official_exit.error",
      sessionId: session.sessionId,
      errorCode,
      errorMessage,
      retryable,
    });
    this.log(`error ${session.sessionId}: ${errorCode} ${errorMessage}`);
  }

  private finishSession(session: ExitSession): void {
    session.closed = true;
    this.sessions.delete(session.sessionId);
    session.socket.end();
    session.socket.destroySoon();
  }

  /** Open session ids (link-grace hello / reconciliation). */
  sessionIds(): string[] {
    return [...this.sessions.values()].filter((s) => !s.closed).map((s) => s.sessionId);
  }

  closeAll(reasonCode = "node_shutdown"): void {
    for (const session of [...this.sessions.values()]) {
      if (session.closed) continue;
      session.closed = true;
      this.opts.send({
        type: "official_exit.close",
        sessionId: session.sessionId,
        reasonCode,
      });
      session.socket.destroy();
    }
    this.sessions.clear();
  }
}
