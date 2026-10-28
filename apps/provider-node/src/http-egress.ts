import { anthropicFingerprintHeaders } from "./fingerprint.js";
import type {
  HttpEgressClose,
  HttpEgressData,
  HttpEgressOpen,
} from "./protocol.js";
import { bunFetch, type ProxyPool } from "./proxy-pool.js";
import { isHostAllowed } from "./whitelist.js";
import { IsolationGuard, sameIsolation, validIsolation } from "./isolation.js";
import type { IsolationContext } from "./protocol.js";

/** Spec-line arrival deadline (the open envelope's deadlineMs). */
const DEFAULT_SPEC_TIMEOUT_MS = 15_000;
const MAX_SPEC_TIMEOUT_MS = 60_000;
/** Upstream response-headers deadline; a non-stream Messages call can legitimately take minutes. */
const DEFAULT_HEADERS_TIMEOUT_MS = 300_000;
const MAX_HEADERS_TIMEOUT_MS = 600_000;
const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]);
/** Response headers that describe the wire body Bun already decoded (the body we forward is plain bytes). */
// content-length / transfer-encoding describe the tunnel-less wire and are dropped;
// content-encoding is forwarded whenever the body is relayed compressed (see `rawBody`).
const BODY_FRAMING_HEADERS = new Set(["content-length", "transfer-encoding"]);
// Anthropic accepts request bodies up to 32 MB; the spec carries the body base64-encoded (×4/3)
// plus headers. 8 MiB (until 2026-10-18) rejected real Claude Desktop sessions with images, and
// the gateway then walked every account for 17 s before answering 503.
const MAX_SPEC_BYTES = 48 * 1024 * 1024;
const MAX_PAYLOAD_BYTES = 4 * 1024 * 1024;
/** Log the time to upstream response headers when it is this slow (where big-body requests lose their 120 s). */
const SLOW_HEADERS_LOG_MS = 30_000;

interface EgressSpec {
  url: string;
  /** HTTP method; defaults to POST when a body is present, else GET. */
  method?: string;
  headers: Record<string, string>;
  bodyBase64?: string;
  /** Pinned pool proxy id; overrides sticky assignment (docs/onboarding.md §6.2). */
  proxyId?: string;
}

interface EgressSession {
  archiveSessionId?: string;
  isolation?: IsolationContext;
  teamId?: string;
  sessionId: string;
  accountId: string;
  /** Pinned proxy from the open envelope; spec.proxyId wins when both exist. */
  proxyId: string | null;
  outSeq: number;
  closed: boolean;
  createdAt: number;
  specChunks: Buffer[];
  specBytes: number;
  specDone: boolean;
  headersSent: boolean;
  /** Set when the spec is in and the upstream request starts (durations in the log lines). */
  execStartedAt: number | null;
  reqBytes: number;
  abort: AbortController;
  deadlineTimer: NodeJS.Timeout | null;
  headersTimeoutMs: number;
}

export interface HttpEgressManagerOptions {
  isolationGuard?: IsolationGuard;
  /** Sends a protocol message over the platform WS; false when not connected. */
  send: (message: unknown) => boolean;
  identity: () => { nodeId: string; providerId?: string };
  isDraining: () => boolean;
  pool: ProxyPool;
  hostAllowed?: (host: string) => boolean;
  log?: (msg: string) => void;
}

/**
 * Protocol v2 HTTP egress (docs/provider-protocol.md "协议 v2：http-egress").
 *
 * Unlike the v1 official_exit TCP relay, TLS terminates here on the node:
 * the gateway sends one JSON request spec line on the byte pipe, this
 * manager executes the request with Bun.fetch through a mandatory pool
 * proxy (TLS fingerprint = Bun/BoringSSL, matching Claude Code), answers
 * with one JSON header line, then streams the raw response body.
 *
 * Trust model: the node sees plaintext request headers/body. They are
 * NEVER logged or persisted — log lines carry only sessionId, status,
 * byte counts and durations.
 */
export class HttpEgressManager {
  private readonly isolation: IsolationGuard;
  private sessions = new Map<string, EgressSession>();
  private opts: HttpEgressManagerOptions;

  constructor(opts: HttpEgressManagerOptions) {
    this.isolation = opts.isolationGuard ?? new IsolationGuard();
    this.opts = opts;
  }

  get activeSessions(): number {
    return this.sessions.size;
  }

  private log(msg: string): void {
    this.opts.log?.(`[http-egress] ${msg}`);
  }

  handleOpen(msg: HttpEgressOpen): void {
    const reject = (reasonCode: string): void => {
      this.opts.send({
        type: "http_egress.open_response",
        sessionId: msg.sessionId,
        accepted: false,
        reasonCode,
      });
      this.log(`rejected ${msg.sessionId}: ${reasonCode}`);
    };

    const identity = this.opts.identity();
    if (msg.nodeId !== identity.nodeId || (identity.providerId && msg.providerId !== identity.providerId)) {
      reject("node_identity_mismatch");
      return;
    }
    if (this.opts.isDraining()) {
      reject("node_draining");
      return;
    }
    if (typeof msg.accountId !== "string" || !msg.accountId) {
      reject("missing_account_id");
      return;
    }
    if (this.sessions.has(msg.sessionId)) {
      reject("duplicate_session");
      return;
    }
    if (msg.isolation !== undefined && !validIsolation(msg.isolation)) return reject("invalid_isolation");
    const teamId = msg.isolation?.teamId ?? msg.teamId;
    if (this.isolation.teamRequired && !teamId) return reject("isolation_required");
    if (msg.isolation && (!this.isolation.allows(msg.isolation) || (msg.teamId && msg.teamId !== teamId))) return reject("isolation_retired");
    if (this.opts.pool.isTeamAccount(msg.accountId) && !teamId) return reject("isolation_required");
    if (msg.archiveSessionId && (!/^[A-Za-z0-9_.:-]{1,180}$/.test(msg.archiveSessionId) || !teamId)) return reject("invalid_archive_scope");
    if (teamId && (!this.isolation.allowsTeam(teamId) || !msg.proxyId || !(msg.archiveSessionId
      ? this.opts.pool.getPinnedForArchive(msg.proxyId, teamId) : this.opts.pool.getPinned(msg.proxyId, msg.accountId, teamId)))) return reject("proxy_team_mismatch");

    const timeoutMs =
      Number.isFinite(msg.deadlineMs) && msg.deadlineMs > 0
        ? Math.min(msg.deadlineMs, MAX_SPEC_TIMEOUT_MS)
        : DEFAULT_SPEC_TIMEOUT_MS;
    const headersTimeoutMs =
      Number.isFinite(msg.headersTimeoutMs) && (msg.headersTimeoutMs as number) > 0
        ? Math.min(msg.headersTimeoutMs as number, MAX_HEADERS_TIMEOUT_MS)
        : DEFAULT_HEADERS_TIMEOUT_MS;

    const session: EgressSession = {
      isolation: msg.isolation,
      teamId,
      archiveSessionId: msg.archiveSessionId,
      sessionId: msg.sessionId,
      accountId: msg.accountId,
      proxyId: typeof msg.proxyId === "string" && msg.proxyId ? msg.proxyId : null,
      outSeq: 0,
      closed: false,
      createdAt: Date.now(),
      specChunks: [],
      specBytes: 0,
      specDone: false,
      headersSent: false,
      execStartedAt: null,
      reqBytes: 0,
      abort: new AbortController(),
      deadlineTimer: null,
      headersTimeoutMs,
    };
    // Until the response headers are on the wire the session must not hang
    // forever; once headers arrive the timer is cleared and the body may
    // stream as long as the upstream needs (SSE).
    session.deadlineTimer = setTimeout(() => {
      this.failSession(session, "request_timeout", "Timed out waiting for the request spec", true);
    }, timeoutMs);
    session.deadlineTimer.unref?.();
    this.sessions.set(msg.sessionId, session);
    if (!this.opts.send({
      type: "http_egress.open_response",
      sessionId: msg.sessionId,
      accepted: true,
    })) this.finishSession(session, "transport_backpressure");
    this.log(`opened ${msg.sessionId} (account ${msg.accountId})`);
  }

  handleData(msg: HttpEgressData): void {
    const session = this.sessions.get(msg.sessionId);
    if (!session || session.closed || session.specDone) return;
    const payload = Buffer.from(msg.payloadBase64, "base64");
    if (payload.length === 0 || payload.length > MAX_PAYLOAD_BYTES) return;
    session.specChunks.push(payload);
    session.specBytes += payload.length;
    if (session.specBytes > MAX_SPEC_BYTES) {
      this.sendErrorLine(session, "spec_too_large", `Request spec exceeds ${MAX_SPEC_BYTES} bytes`);
      this.finishSession(session, "spec_too_large");
      return;
    }
    // The spec is one JSON line (newlines inside it are escaped), so its terminator can only be in
    // the newest frame: concatenate once it shows up instead of re-joining every frame received so
    // far (quadratic on a 40 MB spec arriving in 512 KiB frames).
    if (payload.indexOf(0x0a) < 0) return;
    const buf = Buffer.concat(session.specChunks);
    const nl = buf.indexOf(0x0a);
    if (nl < 0) return;
    session.specDone = true;
    session.specChunks = [];
    // Spec is here: swap the spec deadline for the (much longer) headers deadline.
    if (session.deadlineTimer) clearTimeout(session.deadlineTimer);
    session.deadlineTimer = setTimeout(() => {
      this.failSession(session, "request_timeout", `Upstream sent no response headers within ${session.headersTimeoutMs} ms`, true);
    }, session.headersTimeoutMs);
    session.deadlineTimer.unref?.();
    const line = buf.subarray(0, nl).toString("utf8");
    void this.execute(session, line);
  }

  handleClose(msg: HttpEgressClose): void {
    const session = this.sessions.get(msg.sessionId);
    if (!session || session.closed) return;
    // The gateway gave up (client gone, failover) while the upstream was still silent: the one
    // place a slow upstream head shows up at all (2026-10-22: 120 s+ before headers on 8 MB+ bodies).
    if (!session.headersSent && session.execStartedAt !== null) {
      this.log(`${session.sessionId} closed by gateway (${msg.reasonCode ?? "gateway_closed"}) before upstream headers after ${Date.now() - session.execStartedAt}ms req=${session.reqBytes}`);
    }
    this.finishSession(session, msg.reasonCode ?? "gateway_closed");
  }

  resetConversation(context: IsolationContext): void {
    this.isolation.retire(context);
    for (const s of [...this.sessions.values()]) if (sameIsolation(s.isolation, context)) this.finishSession(s, "conversation_reset");
  }

  isolatedContexts(): IsolationContext[] {
    return [...new Map([...this.sessions.values()].map((s) => s.isolation).filter((c): c is IsolationContext => !!c).map((c) => [JSON.stringify(c), c])).values()];
  }

  private async execute(session: EgressSession, line: string): Promise<void> {
    const t0 = Date.now();
    let spec: EgressSpec;
    try {
      spec = JSON.parse(line) as EgressSpec;
      if (typeof spec.url !== "string" || !spec.url) throw new Error("spec.url missing");
      if (typeof spec.headers !== "object" || spec.headers === null || Array.isArray(spec.headers)) {
        throw new Error("spec.headers must be an object");
      }
      if (spec.bodyBase64 !== undefined && typeof spec.bodyBase64 !== "string") {
        throw new Error("spec.bodyBase64 must be a string");
      }
      if (spec.proxyId !== undefined && typeof spec.proxyId !== "string") {
        throw new Error("spec.proxyId must be a string");
      }
      if (spec.method !== undefined && (typeof spec.method !== "string" || !METHODS.has(spec.method.toUpperCase()))) {
        throw new Error("spec.method must be one of GET, POST, PUT, PATCH, DELETE, HEAD");
      }
    } catch (err) {
      this.sendErrorLine(session, "bad_spec", `Invalid request spec: ${(err as Error).message}`);
      this.finishSession(session, "bad_spec");
      return;
    }

    let url: URL;
    try {
      url = new URL(spec.url);
      if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("unsupported scheme");
    } catch {
      this.sendErrorLine(session, "bad_url", "spec.url is not a valid http(s) URL");
      this.finishSession(session, "bad_url");
      return;
    }

    const allowed = (this.opts.hostAllowed ?? isHostAllowed)(url.hostname);
    if (!allowed) {
      this.sendErrorLine(session, "target_not_allowed", `Host not in egress whitelist: ${url.hostname}`);
      this.finishSession(session, "target_not_allowed");
      return;
    }

    if (session.archiveSessionId && (url.origin !== "https://api.anthropic.com" || url.pathname !== `/v1/code/sessions/${encodeURIComponent(session.archiveSessionId)}/archive` || url.search ||
        (spec.method ?? (spec.bodyBase64 === undefined ? "GET" : "POST")).toUpperCase() !== "POST")) {
      this.sendErrorLine(session, "archive_scope_invalid", "Cleanup accepts only the fixed archive endpoint");
      this.finishSession(session, "archive_scope_invalid");
      return;
    }

    // Mandatory proxy. Pinned (spec.proxyId or the open envelope) means exactly
    // that pool member, alive; otherwise the sticky per-account assignment.
    // Empty pool / dead or missing pin => hard fail, never direct.
    if (session.isolation && !this.isolation.allows(session.isolation)) {
      this.sendErrorLine(session, "isolation_retired", "Conversation generation was retired");
      this.finishSession(session, "isolation_retired");
      return;
    }
    if (session.teamId && spec.proxyId && spec.proxyId !== session.proxyId) {
      this.sendErrorLine(session, "proxy_team_mismatch", "Pinned team proxy cannot be overridden by the request spec");
      this.finishSession(session, "proxy_team_mismatch");
      return;
    }
    const pinnedId = spec.proxyId ?? session.proxyId;
    const pinnedProxy = () => pinnedId ? (session.archiveSessionId ? this.opts.pool.getPinnedForArchive(pinnedId, session.teamId!) : this.opts.pool.getPinned(pinnedId, session.accountId, session.teamId)) : null;
    const proxyUrl = pinnedId ? pinnedProxy() : this.opts.pool.pickForAccount(session.accountId);
    if (!proxyUrl) {
      const why = pinnedId ? `Pinned proxy ${pinnedId} missing or dead` : "Proxy pool empty or no live proxy";
      this.sendErrorLine(session, "no_proxy_available", `${why}; direct egress is forbidden`);
      this.finishSession(session, "no_proxy_available");
      return;
    }
    let proxy: string;
    try {
      proxy = await this.opts.pool.transportProxy(proxyUrl); // socks5 -> loopback bridge
      if (session.closed || session.abort.signal.aborted || (session.isolation && !this.isolation.allows(session.isolation))) return;
      if (session.teamId && pinnedProxy() !== proxyUrl) {
        this.sendErrorLine(session, "proxy_team_mismatch", "Proxy authorization was revoked before execution");
        this.finishSession(session, "proxy_team_mismatch");
        return;
      }
    } catch (err) {
      this.opts.pool.markDead(proxyUrl, (err as Error).message);
      this.sendErrorLine(session, "no_proxy_available", (err as Error).message);
      this.finishSession(session, "no_proxy_available");
      return;
    }

    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(spec.headers)) {
      if (typeof v === "string") headers[k.toLowerCase()] = v;
    }
    // 指纹补齐只用于 CC SDK 线端点（/v1/*）；/api/oauth/* 等辅助端点上真实 CC
    // 只发 Authorization+UA（docs/claude-code-compat.md §8），调用方已带齐，不补。
    // Anthropic SDK-wire endpoints: relay the body exactly as the upstream sent it
    // (still compressed) and let the gateway decompress. Bun's fetch decoder withholds
    // brotli output until more input arrives (oven-sh/bun#41439), which turned every
    // direct SSE stream into "first byte = last byte" (measured 2026-10-16); the raw
    // relay keeps the request fingerprint identical to Claude Code's and streams.
    const rawBody = isAnthropicHost(url.hostname) && url.pathname.startsWith("/v1/");
    if (rawBody) {
      const fp = anthropicFingerprintHeaders(headers);
      for (const [k, v] of Object.entries(fp)) headers[k] = v;
    }

    const method = (spec.method ?? (spec.bodyBase64 ? "POST" : "GET")).toUpperCase();
    const body = spec.bodyBase64 && method !== "GET" && method !== "HEAD" ? Buffer.from(spec.bodyBase64, "base64") : undefined;
    session.execStartedAt = t0;
    session.reqBytes = body?.length ?? 0;
    let res: Response;
    try {
      res = await bunFetch(spec.url, {
        method,
        headers,
        body,
        proxy,
        redirect: "manual",
        signal: session.abort.signal,
        ...(rawBody ? { decompress: false } : {}),
      });
    } catch (err) {
      if (session.closed) return;
      // Only a failure at the proxy layer condemns the proxy (one account = one
      // proxy: a false "dead" takes the account offline). Upstream-side resets
      // trigger an immediate re-probe instead, which decides live/dead properly.
      const { message: reason, proxyLayer } = this.opts.pool.classifyFailure(proxyUrl, err);
      if (proxyLayer) this.opts.pool.markDead(proxyUrl, reason);
      else void this.opts.pool.reprobe(proxyUrl);
      this.sendErrorLine(session, "upstream_connect_failed", reason);
      this.finishSession(session, "upstream_connect_failed");
      this.log(`${session.sessionId} failed before headers after ${Date.now() - t0}ms (${proxyLayer ? "proxy" : "upstream"} layer)`);
      return;
    }
    if (session.closed) return;
    const hdrMs = Date.now() - t0;
    if (hdrMs >= SLOW_HEADERS_LOG_MS) this.log(`${session.sessionId} upstream headers after ${hdrMs}ms req=${session.reqBytes} status=${res.status}`);

    const responseHeaders: Record<string, string> = {};
    res.headers.forEach((value, key) => {
      if (BODY_FRAMING_HEADERS.has(key)) return;
      // Decompressed by Bun (non-raw relay): the header no longer describes the bytes we forward.
      if (key === "content-encoding" && !rawBody) return;
      responseHeaders[key] = value;
    });
    this.sendLine(session, JSON.stringify({ status: res.status, headers: responseHeaders }));
    session.headersSent = true;
    if (session.deadlineTimer) {
      clearTimeout(session.deadlineTimer);
      session.deadlineTimer = null;
    }

    let bytes = 0;
    try {
      if (res.body && method !== "HEAD") {
        const reader = res.body.getReader();
        for (;;) {
          if (session.closed) {
            await reader.cancel().catch(() => undefined);
            return;
          }
          const { done, value } = await reader.read();
          if (done) break;
          if (value && value.length > 0) {
            bytes += value.length;
            this.sendData(session, Buffer.from(value));
          }
        }
      }
      this.finishSession(session, "complete");
      this.opts.pool.markAlive(proxyUrl); // a served request clears any strike streak on this proxy
      this.log(`${session.sessionId} status=${res.status} bytes=${bytes} ms=${Date.now() - t0} hdr=${hdrMs} req=${session.reqBytes}`);
    } catch (err) {
      if (session.closed) return;
      this.log(`${session.sessionId} stream error after ${bytes} bytes: ${(err as Error).message}`);
      this.finishSession(session, "stream_error");
    }
  }

  private sendLine(session: EgressSession, line: string): void {
    this.sendData(session, Buffer.from(line + "\n", "utf8"));
  }

  private sendErrorLine(session: EgressSession, code: string, message: string): void {
    this.sendLine(session, JSON.stringify({ error: code, message }));
  }

  private sendData(session: EgressSession, payload: Buffer): void {
    session.outSeq += 1;
    const accepted = this.opts.send({
      type: "http_egress.data",
      sessionId: session.sessionId,
      seq: session.outSeq,
      payloadBase64: payload.toString("base64"),
    });
    if (!accepted) this.finishSession(session, "transport_backpressure");
  }

  private failSession(session: EgressSession, errorCode: string, errorMessage: string, retryable: boolean): void {
    if (session.closed) return;
    session.closed = true;
    this.sessions.delete(session.sessionId);
    if (session.deadlineTimer) clearTimeout(session.deadlineTimer);
    session.abort.abort();
    this.opts.send({
      type: "http_egress.error",
      sessionId: session.sessionId,
      errorCode,
      errorMessage,
      retryable,
    });
    this.log(`error ${session.sessionId}: ${errorCode}`);
  }

  private finishSession(session: EgressSession, reasonCode: string): void {
    if (session.closed) return;
    session.closed = true;
    this.sessions.delete(session.sessionId);
    if (session.deadlineTimer) clearTimeout(session.deadlineTimer);
    if (reasonCode !== "complete") session.abort.abort();
    this.opts.send({
      type: "http_egress.close",
      sessionId: session.sessionId,
      reasonCode,
    });
  }

  /** Open session ids (link-grace hello / reconciliation). */
  sessionIds(): string[] {
    return [...this.sessions.values()].filter((s) => !s.closed).map((s) => s.sessionId);
  }

  closeAll(reasonCode = "node_shutdown"): void {
    for (const session of [...this.sessions.values()]) {
      if (!session.closed) this.finishSession(session, reasonCode);
    }
    this.sessions.clear();
  }
}

/**
 * Fingerprint fallback applies only to Anthropic API hosts
 * (docs/claude-code-compat.md); other whitelisted vendors pass through.
 */
function isAnthropicHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  return h === "anthropic.com" || h.endsWith(".anthropic.com");
}
