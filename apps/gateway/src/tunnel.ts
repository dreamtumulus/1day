import { Duplex, Readable } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate, createZstdDecompress } from "node:zlib";
import { INTERNAL_HEADER, internalToken } from "@1dayapi/core";
import { config } from "./config.js";

// Provider-node tunnel transport, protocol v2 "http_egress"
// (docs/provider-protocol.md "协议 v2：http-egress").
// The tunnel data plane is HTTP long-polling against console's tunnel manager;
// this module wraps it as a Duplex and speaks the v2 application frames over
// it: one JSON request-spec line out, one JSON head line in, then the raw
// response body bytes until the session closes. TLS terminates on the node —
// no tls.connect here.

// Must exceed the console's NODE_WAIT_MS (20 s): a session open now waits there
// for a draining/restarting node to come back instead of failing at once.
const OPEN_TIMEOUT_MS = 25_000;
/** TUNNEL_TRACE=1: log every long-poll delivery per session (diagnostics only). */
const TUNNEL_TRACE = process.env.TUNNEL_TRACE === "1";
const READ_POLL_TIMEOUT_MS = 30_000;

const internalHeaders = { "content-type": "application/json", [INTERNAL_HEADER]: internalToken };

export interface IsolationContext { teamId: string; conversationId: string; generation: number }

/** Retire the old epoch on the nodes, including parked native tool calls. */
export async function resetConversationWorkers(isolation: IsolationContext): Promise<void> {
  const res = await fetch(`${config.consoleBase}/internal/tunnel/reset`, {
    method: "POST", headers: internalHeaders, body: JSON.stringify({ isolation }), signal: AbortSignal.timeout(OPEN_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`conversation worker reset HTTP ${res.status}`);
}

/**
 * A console 400/413/422 on /internal/tunnel/open is the request's fault, not
 * the account's: raise it as TunnelRequestError so the gateway answers the
 * client once. Before 2026-10-19 it came back as `null` ("no node"), was
 * retried across every account and surfaced as 503 no_available_account.
 * Other non-2xx (503 no_online_node, 5xx) stay `null` → next account.
 */
async function rejectRequestLevel(res: Response): Promise<void> {
  if (res.status !== 400 && res.status !== 413 && res.status !== 422) return;
  let code = `console_http_${res.status}`;
  let message = `the platform refused to open the session (HTTP ${res.status})`;
  try {
    const j = (await res.json()) as { error?: { code?: string; message?: string } };
    if (typeof j?.error?.code === "string" && j.error.code) code = `console_${j.error.code}`;
    if (typeof j?.error?.message === "string" && j.error.message) message = j.error.message;
  } catch {
    // body was not JSON; keep the generic text
  }
  throw new TunnelRequestError(code, message);
}

async function openTunnelSession(accountId: string, proxyId?: string, isolation?: IsolationContext, signal?: AbortSignal): Promise<string | null> {
  let res: Response;
  try {
    res = await fetch(`${config.consoleBase}/internal/tunnel/open`, {
      method: "POST",
      headers: internalHeaders,
      body: JSON.stringify({ accountId, kind: "http_egress", headersTimeoutMs: config.upstreamTimeoutMs, ...(proxyId ? { proxyId } : {}), ...(isolation ? { isolation } : {}) }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(OPEN_TIMEOUT_MS)]) : AbortSignal.timeout(OPEN_TIMEOUT_MS),
    });
  } catch (err) {
    if (signal?.aborted) throw signal.reason;
    return null;
  }
  if (!res.ok) {
    await rejectRequestLevel(res);
    return null;
  }
  const json = (await res.json()) as { sessionId?: string };
  return json.sessionId ?? null;
}

function tunnelPost(sessionId: string, suffix: string, body?: unknown, signal?: AbortSignal): Promise<Response> {
  return fetch(`${config.consoleBase}/internal/tunnel/${sessionId}${suffix}`, {
    method: "POST",
    headers: internalHeaders,
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(35_000)]) : AbortSignal.timeout(35_000),
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

const MAX_FRAME_BYTES = 512 * 1024;

class TunnelDuplex extends Duplex {
  private readonly openedAt = Date.now();
  private writeChain: Promise<void> = Promise.resolve();
  private polling = false;
  private remoteClosed = false;

  private readonly aborter = new AbortController();
  constructor(private sessionId: string, private signal?: AbortSignal) {
    super({ allowHalfOpen: false });
    if (signal?.aborted) this.onAbort();
    else signal?.addEventListener("abort", this.onAbort, { once: true });
  }
  private readonly onAbort = () => this.destroy(new DOMException("Request aborted", "AbortError"));

  _write(chunk: Buffer, _enc: string, cb: (err?: Error | null) => void): void {
    // Serialize writes: tunnel data frames must arrive in order. Frames are
    // capped so a large request (long CCR prompt) never exceeds the console's
    // JSON body limit (2 MiB; base64 inflates by 4/3).
    this.writeChain = this.writeChain
      .then(async () => {
        for (let off = 0; off < chunk.length; off += MAX_FRAME_BYTES) {
          const res = await tunnelPost(this.sessionId, "/data", {
            payloadBase64: chunk.subarray(off, off + MAX_FRAME_BYTES).toString("base64"),
          }, this.aborter.signal);
          if (!res.ok) throw new Error(`tunnel data HTTP ${res.status}`);
        }
      })
      .then(() => cb(), (err: Error) => cb(err));
  }

  _read(): void {
    if (this.polling) return;
    this.polling = true;
    void this.pollLoop();
  }

  private async pollLoop(): Promise<void> {
    try {
      while (!this.remoteClosed && !this.destroyed) {
        const res = await fetch(
          `${config.consoleBase}/internal/tunnel/${this.sessionId}/read?timeout=${READ_POLL_TIMEOUT_MS}`,
          { headers: internalHeaders, signal: AbortSignal.any([this.aborter.signal, AbortSignal.timeout(READ_POLL_TIMEOUT_MS + 5_000)]) },
        );
        if (!res.ok) throw new Error(`tunnel read HTTP ${res.status}`);
        const json = (await res.json()) as {
          chunks: Array<{ seq: number; payloadBase64: string }>;
          closed: boolean;
          error?: string;
        };
        if (TUNNEL_TRACE && json.chunks.length) {
          const bytes = json.chunks.reduce((n, c) => n + Math.floor((c.payloadBase64.length * 3) / 4), 0);
          console.log(`[tunnel-trace] ${this.sessionId} +${Date.now() - this.openedAt}ms chunks=${json.chunks.length} bytes=${bytes}${json.closed ? " closed" : ""}`);
        }
        let canRead = true;
        for (const c of json.chunks) canRead = this.push(Buffer.from(c.payloadBase64, "base64")) && canRead;
        if (!canRead && !json.closed) { this.polling = false; return; }
        if (json.closed) {
          this.remoteClosed = true;
          if (json.error) this.destroy(new Error(`tunnel closed by node: ${json.error}`));
          else this.push(null);
        }
      }
    } catch (err) {
      if (!this.destroyed) this.destroy(err as Error);
    }
  }

  _destroy(err: Error | null, cb: (err?: Error | null) => void): void {
    this.remoteClosed = true;
    this.aborter.abort();
    this.signal?.removeEventListener("abort", this.onAbort);
    // Always with a JSON body: internalHeaders set content-type json, and Fastify answers 400 to
    // an empty JSON body — which silently disabled every gateway-initiated close until 2026-10-17
    // (client disconnects and parked tool turns never reached the node).
    tunnelPost(this.sessionId, "/close", { reasonCode: err ? "gateway_error" : "gateway_closed" })
      .catch(() => {})
      .finally(() => cb(err));
  }
}

// ---------- v2 head-line parsing (exported for unit tests) ----------

export type EgressHead =
  | { kind: "ok"; status: number; headers: Headers }
  | { kind: "error"; error: string; message: string };

export interface ParsedEgressHead {
  head: EgressHead;
  /** Body bytes that arrived in the same chunk(s) after the head line. */
  rest: Buffer;
}

/**
 * Parse one buffered prefix of the node→gateway stream. Returns null while
 * the head line (terminated by "\n") is incomplete; throws on malformed JSON
 * or a line that is neither a success nor an error frame.
 */
export function parseEgressHead(buf: Buffer): ParsedEgressHead | null {
  const idx = buf.indexOf("\n");
  if (idx === -1) return null;
  const line = buf.subarray(0, idx).toString("utf8").trim();
  const rest = buf.subarray(idx + 1);
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(line) as Record<string, unknown>;
  } catch {
    throw new Error("tunnel head line is not valid JSON");
  }
  if (typeof json.error === "string") {
    return {
      head: { kind: "error", error: json.error, message: typeof json.message === "string" ? json.message : "" },
      rest,
    };
  }
  const status = Number(json.status);
  if (!Number.isInteger(status) || status < 100 || status > 599) {
    throw new Error("tunnel head line has neither status nor error");
  }
  const headers = new Headers();
  if (json.headers && typeof json.headers === "object") {
    for (const [k, v] of Object.entries(json.headers as Record<string, unknown>)) {
      headers.set(k.toLowerCase(), Array.isArray(v) ? v.map(String).join(", ") : String(v));
    }
  }
  return { head: { kind: "ok", status, headers }, rest };
}

/**
 * Decode a compressed body stream (node relays /v1 bodies exactly as upstream sent
 * them — see provider-node http-egress `rawBody`). Unknown or absent encodings pass
 * through. Streaming: zlib transforms emit as input arrives, so SSE keeps flowing.
 */
export function decompressBody(body: ReadableStream<Uint8Array>, encoding: string | null): ReadableStream<Uint8Array> {
  const enc = (encoding ?? "").trim().toLowerCase();
  const dec =
    enc === "gzip" || enc === "x-gzip" ? createGunzip() : enc === "br" ? createBrotliDecompress() : enc === "deflate" ? createInflate() : enc === "zstd" ? createZstdDecompress() : null;
  if (!dec) return body;
  const src = Readable.fromWeb(body as import("node:stream/web").ReadableStream<Uint8Array>);
  src.on("error", (e) => dec.destroy(e));
  return Readable.toWeb(src.pipe(dec)) as ReadableStream<Uint8Array>;
}

/**
 * Single-listener byte collector for an egress tunnel session. Attaching and
 * detaching `data` listeners mid-stream (the old readEgressHead →
 * egressBodyStream hand-off) drops chunks that arrive in the gap; this
 * collector owns the listener for the whole session lifecycle instead.
 */
class EgressReader {
  private chunks: Buffer[] = [];
  private queuedBytes = 0;
  private closed = false;
  private err: Error | null = null;
  private notify: (() => void) | null = null;

  constructor(private socket: Duplex) {
    socket.on("data", (c: Buffer) => {
      this.chunks.push(c);
      this.queuedBytes += c.length;
      if (this.queuedBytes >= 1_048_576) socket.pause();
      if (this.queuedBytes > 8_388_608) socket.destroy(new Error("tunnel buffered response exceeds 8 MiB"));
      this.ping();
    });
    const fin = () => {
      this.closed = true;
      this.ping();
    };
    socket.on("end", fin);
    socket.on("close", fin);
    socket.on("error", (e: Error) => {
      this.err = e;
      this.closed = true;
      this.ping();
    });
  }

  private take(): Buffer {
    const chunk = this.chunks.shift()!;
    this.queuedBytes -= chunk.length;
    if (this.queuedBytes < 524_288) this.socket.resume();
    return chunk;
  }
  private ping(): void {
    this.notify?.();
  }

  private async waitChunk(): Promise<void> {
    if (this.chunks.length || this.closed || this.err) return;
    await new Promise<void>((res) => {
      this.notify = res;
    });
    this.notify = null;
  }

  /** Accumulate until the head line parses (same semantics as readEgressHead). */
  async waitHead(timeoutMs: number): Promise<ParsedEgressHead> {
    let buf = Buffer.alloc(0);
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const parsed = parseEgressHead(buf);
      if (parsed) return parsed;
      if (buf.length > 65_536) throw new Error("node egress head exceeds 64 KiB");
      if (this.err) throw this.err;
      if (Date.now() > deadline) throw new Error("timeout waiting for node egress head line");
      if (this.closed && !this.chunks.length) throw new Error("tunnel closed before egress head line");
      const ms = Math.max(1, Math.min(5_000, deadline - Date.now()));
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([this.waitChunk(), new Promise((r) => { timer = setTimeout(r, ms); })]);
      clearTimeout(timer);
      while (this.chunks.length) buf = Buffer.concat([buf, this.take()]);
    }
  }

  /** Stream the body: `rest` first, then queued + future chunks until close. */
  toWebStream(rest: Buffer): ReadableStream<Uint8Array> {
    const self = this;
    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          if (rest.length > 0) {
            controller.enqueue(new Uint8Array(rest));
            rest = Buffer.alloc(0);
            return;
          }
          while (!self.chunks.length && !self.closed && !self.err) await self.waitChunk();
          if (self.err) {
            controller.error(self.err);
            self.socket.destroy();
            return;
          }
          if (self.chunks.length) controller.enqueue(new Uint8Array(self.take()));
          if (self.closed && !self.chunks.length) {
            controller.close();
            self.socket.destroy();
          }
        } catch (e) {
          controller.error(e);
          self.socket.destroy();
        }
      },
      cancel() {
        self.socket.destroy();
      },
    });
  }
}

/**
 * The node sends the raw response body bytes after the head line, ending the
 * session when the body is done — no HTTP framing to parse here. Everything
 * after the head line (including bytes that already arrived) is streamed out
 * as-is until the tunnel closes. (Legacy helper; new code uses EgressReader.)
 */
export function egressBodyStream(socket: Duplex, rest: Buffer): ReadableStream<Uint8Array> {
  return new EgressReader(socket).toWebStream(rest);
}

/**
 * Send one HTTP request through a provider-node tunnel bound to the given
 * account (protocol v2: the node executes the request and terminates TLS).
 * Returns null on infrastructure conditions — no tunnel could be opened, or
 * the head line reports a node/proxy failure — meaning "try the next
 * account", not an upstream error. Throws if the tunnel breaks mid-flight.
 */
/**
 * The node refused the request itself, not the account: no other account can
 * take it either, so the candidate loop must stop and answer the client
 * (spec_too_large → 413). Until 2026-10-18 this was folded into "node not
 * available": a 6 MB Claude Desktop request walked 30 accounts for 17 s and
 * ended as 503 no_available_account, which the client retried every 20 s.
 */
export class TunnelRequestError extends Error {
  constructor(
    public readonly nodeCode: string,
    message: string,
  ) {
    super(message);
    this.name = "TunnelRequestError";
  }
}

const REQUEST_LEVEL_NODE_ERRORS = new Set(["spec_too_large", "bad_spec", "bad_url", "target_not_allowed"]);

export async function fetchViaTunnel(
  accountId: string,
  url: URL,
  headers: Record<string, string>,
  body: string,
  /** Pin the node-side egress to this pool proxy (docs/onboarding.md §6.2). */
  proxyId?: string,
  /** HTTP method (default: POST with a body, GET without). */
  method?: string,
  isolation?: IsolationContext,
  signal?: AbortSignal,
  /** spec WP5.4 raw-v1: the node forwards these headers untouched (no Claude Code fingerprint fill-in); raw passthrough accounts only. */
  preserveHeaders = false,
): Promise<Response | null> {
  const sessionId = await openTunnelSession(accountId, proxyId, isolation, signal);
  if (!sessionId) return null;

  const duplex = new TunnelDuplex(sessionId, signal);
  const reader = new EgressReader(duplex);
  const spec = `${JSON.stringify({
    url: url.href,
    ...(method ? { method: method.toUpperCase() } : {}),
    headers,
    bodyBase64: Buffer.from(body, "utf8").toString("base64"),
    ...(proxyId ? { proxyId } : {}),
    ...(preserveHeaders ? { preserveHeaders: true } : {}),
  })}\n`;
  duplex.write(Buffer.from(spec, "utf8"));

  let parsed: ParsedEgressHead;
  try {
    parsed = await reader.waitHead(config.upstreamTimeoutMs);
  } catch (err) {
    duplex.destroy();
    throw err;
  }

  if (parsed.head.kind === "error") {
    console.warn(`[tunnel] node egress error for account ${accountId}: ${parsed.head.error} ${parsed.head.message}`);
    duplex.destroy();
    if (REQUEST_LEVEL_NODE_ERRORS.has(parsed.head.error)) throw new TunnelRequestError(parsed.head.error, parsed.head.message ?? parsed.head.error);
    // Node/proxy infrastructure failure (e.g. no_proxy_available): skip this account.
    return null;
  }

  const hopByHop = ["transfer-encoding", "connection", "keep-alive"];
  const headersOut = new Headers();
  parsed.head.headers.forEach((v, k) => {
    if (!hopByHop.includes(k)) headersOut.set(k, v);
  });
  // The node relays /v1 bodies compressed (content-encoding kept in the head line);
  // decode here so callers see plain bytes, streaming.
  const encoding = headersOut.get("content-encoding");
  let bodyOut = reader.toWebStream(parsed.rest);
  if (encoding) {
    bodyOut = decompressBody(bodyOut, encoding);
    headersOut.delete("content-encoding");
    headersOut.delete("content-length");
  }
  return new Response(bodyOut, { status: parsed.head.status, headers: headersOut });
}

/**
 * fetch-shaped transport over the tunnel, pinned to the account's bound proxy
 * (docs/onboarding.md §6.2: CCR session API calls and OAuth refreshes of
 * executor=ccr route=node accounts). Throws on infrastructure failure (no
 * online node, no_proxy_available) — callers treat that as transient.
 */
export function pinnedTunnelTransport(
  accountId: string,
  proxyId: string | null,
  isolation?: IsolationContext,
  signal?: AbortSignal,
): (url: string, init: { method?: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<Response> {
  return async (url, init) => {
    const res = await fetchViaTunnel(accountId, new URL(url), init.headers, init.body ?? "", proxyId ?? undefined, init.method, isolation, init.signal ?? signal);
    if (!res) throw new Error("node tunnel unavailable or egress refused (no_proxy_available)");
    return res;
  };
}

// ---------- cc_worker tunnels (docs/ccr-supply.md §8.1) ----------

export interface CcWorkerOpenRequest {
  isolation?: IsolationContext;
  model: string;
  prompt: string;
  /** Worker system prompt (node: `--system-prompt-file`), replacing Claude Code's default identity. Legacy only. */
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
  /** Extended thinking budget (node: `--max-thinking-tokens`); 0/absent = Claude Code default. */
  thinkingBudget?: number;
  /** Reasoning effort (node: `--effort`), from the client's `effort` field when present. */
  effort?: string;
  /** Client max_tokens (node: env CLAUDE_CODE_MAX_OUTPUT_TOKENS of the process); 0/absent = Claude Code default. */
  maxTokens?: number;
  /** Persistent session (docs/worker-sessions.md): keep the process under reuseKey; continue feeds only `content`. */
  persist?: boolean;
  reuseKey?: string;
  turnMode?: "fresh" | "continue" | "tool_result";
  expectedTurn?: number;
  /** Native caller tools (node MCP server) and, for turnMode "tool_result", the client's results by callId. */
  tools?: Array<{ name: string; description?: string; input_schema?: Record<string, unknown> }>;
  results?: Array<{ callId: string; content: string; isError?: boolean }>;
  /** Messages-style content blocks (text + images) for `--input-format stream-json`; omitted → plain prompt. */
  content?: Array<Record<string, unknown>>;
  stream: boolean;
  cred: {
    accessToken: string;
    refreshToken?: string;
    expiresAt?: string;
    subscriptionType?: string;
  };
  /** Pin the worker's egress proxy (onboarding §1 一号一代理). */
  proxyId?: string;
  /** turnMode "continue": the whole conversation, so a node whose live process cannot take the turn restarts from it (never from the tail). */
  history?: Array<Record<string, unknown>>;
}

/**
 * Open a cc_worker tunnel: the node spawns the real Claude Code binary and its
 * stream-json stdout flows back as data frames (no head line, no spec line —
 * all parameters travel in the open envelope). Returns null when no node
 * accepted (offline / no_proxy_available / worker_overloaded → try the next
 * account). Cancelling the returned stream kills the remote process.
 */
export async function openCcWorker(
  accountId: string,
  req: CcWorkerOpenRequest,
  signal?: AbortSignal,
): Promise<{ stream: ReadableStream<Uint8Array>; sessionId: string } | null> {
  let res: Response;
  try {
    res = await fetch(`${config.consoleBase}/internal/tunnel/open`, {
      method: "POST",
      headers: internalHeaders,
      body: JSON.stringify({
        accountId,
        ...(req.isolation ? { isolation: req.isolation } : {}),
        kind: "cc_worker",
        ...(req.proxyId ? { proxyId: req.proxyId } : {}),
        model: req.model,
        prompt: req.prompt,
        ...(req.systemPrompt ? { systemPrompt: req.systemPrompt } : {}),
        ...(req.mode === "canonical"
          ? {
              mode: "canonical",
              ...(req.profileId ? { profileId: req.profileId } : {}),
              ...(req.appendSystemPrompt ? { appendSystemPrompt: req.appendSystemPrompt } : {}),
              ...(req.nativeSessionId ? { nativeSessionId: req.nativeSessionId } : {}),
              ...(req.builtInToolProfile ? { builtInToolProfile: req.builtInToolProfile } : {}),
              ...(req.jsonSchema ? { jsonSchema: req.jsonSchema } : {}),
              ...(req.nativeSession ? { nativeSession: req.nativeSession } : {}),
              ...(req.historyImport ? { historyImport: req.historyImport } : {}),
            }
          : {}),
        ...(req.thinkingBudget ? { thinkingBudget: req.thinkingBudget } : {}),
        ...(req.effort ? { effort: req.effort } : {}),
        ...(req.maxTokens ? { maxTokens: req.maxTokens } : {}),
        ...(req.persist
          ? {
              persist: true,
              reuseKey: req.reuseKey,
              turnMode: req.turnMode ?? "fresh",
              expectedTurn: req.expectedTurn,
              ...(req.tools ? { tools: req.tools } : {}),
              ...(req.results ? { results: req.results } : {}),
            }
          : {}),
        ...(req.content ? { content: req.content } : {}),
        ...(req.history ? { history: req.history } : {}),
        stream: req.stream,
        cred: req.cred,
      }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(OPEN_TIMEOUT_MS)]) : AbortSignal.timeout(OPEN_TIMEOUT_MS),
    });
  } catch (err) {
    if (signal?.aborted) throw signal.reason;
    return null;
  }
  if (!res.ok) {
    await rejectRequestLevel(res);
    return null;
  }
  const json = (await res.json()) as { sessionId?: string };
  if (!json.sessionId) return null;
  const duplex = new TunnelDuplex(json.sessionId, signal);
  // No head line in cc_worker: every byte is worker stdout.
  return { stream: new EgressReader(duplex).toWebStream(Buffer.alloc(0)), sessionId: json.sessionId };
}
