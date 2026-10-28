// Keeping a slow request alive end to end (docs/gateway.md): api.1dayapi.com sits behind
// Cloudflare, which cuts a silent origin at 125 s (524), nginx at 300 s (504), and customers'
// clients at ~120 s. Until the first upstream byte the gateway therefore has to produce bytes
// of its own — in the client's dialect, so nothing downstream has to change (2026-10-22: 816
// requests of one customer and ~140/day of another died this way).
//
// Streaming: 200 + SSE headers go out when the first upstream attempt starts, then Anthropic
// `ping` events (the dialect's own heartbeat; every SDK skips them) or SSE comments.
// Non-stream: the real HTTP status must stay available for quick failures, so a 200 + JSON
// headers is committed only after NON_STREAM_HEARTBEAT_AFTER_MS without an answer, padded with
// newlines (insignificant whitespace before a JSON value, RFC 8259 §2) until the body is in.
// After that commit a failure can only be a JSON error body with status 200 — still better
// than the Cloudflare 524 HTML page the client would otherwise parse.
import type { FastifyReply } from "fastify";
import { CORS_HEADERS, conversationResponseHeaders, errorBody, type ErrorType } from "./http.js";
import type { ClientFormat } from "./upstream.js";

/** SSE heartbeat cadence before the first upstream byte (Cloudflare 125 s, Claude Code clients 120 s). */
export const EARLY_STREAM_KEEPALIVE_MS = 15_000;
/** Non-stream: how long a request may wait for upstream with no bytes sent before the 200 is committed. */
export const NON_STREAM_HEARTBEAT_AFTER_MS = 75_000;
/** Non-stream: whitespace cadence after the commit (nginx proxy_read_timeout is 300 s, Cloudflare 125 s). */
export const NON_STREAM_HEARTBEAT_MS = 20_000;

export interface HeartbeatCtx {
  reply: FastifyReply;
  format: ClientFormat;
  stream: boolean;
  requestId: string;
  /** The client's socket closed (set by the request's close listener). */
  clientGone: boolean;
  /** Streaming: headers + heartbeat already went out (errors are SSE events from here on). */
  early: { keepalive: NodeJS.Timeout | null } | null;
  /** Non-stream: the delay before the 200 is committed (armed at the first upstream attempt). */
  jsonArm: NodeJS.Timeout | null;
  /** Non-stream: 200 + JSON headers already went out (errors are a JSON body with status 200 from here on). */
  jsonEarly: { keepalive: NodeJS.Timeout | null } | null;
}

/** One heartbeat in the client's dialect: a real `ping` event for Anthropic clients, a comment otherwise. */
export function earlyStreamHeartbeat(format: ClientFormat): string {
  return format === "anthropic" ? `event: ping\ndata: {"type": "ping"}\n\n` : ": keepalive\n\n";
}

/** Streaming request: send 200 + SSE headers now and keep the connection warm until the first upstream byte. */
export function beginEarlyStream(ctx: HeartbeatCtx): void {
  if (ctx.early || !ctx.stream || ctx.clientGone) return;
  const { reply } = ctx;
  reply.hijack();
  reply.raw.writeHead(200, {
    ...CORS_HEADERS,
    ...conversationResponseHeaders(reply),
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  reply.raw.flushHeaders();
  const beat = earlyStreamHeartbeat(ctx.format);
  reply.raw.write(beat);
  const keepalive = setInterval(() => {
    if (ctx.clientGone || reply.raw.writableEnded) return;
    reply.raw.write(beat);
  }, EARLY_STREAM_KEEPALIVE_MS);
  keepalive.unref?.();
  ctx.early = { keepalive };
}

export function stopEarlyKeepalive(ctx: HeartbeatCtx): void {
  if (ctx.early?.keepalive) {
    clearInterval(ctx.early.keepalive);
    ctx.early.keepalive = null;
  }
}

/** After beginEarlyStream the status line is gone: a terminal failure is an SSE error event in the client's dialect. */
export function endEarlyStreamWithError(ctx: HeartbeatCtx, code: string, message: string, type: ErrorType): void {
  stopEarlyKeepalive(ctx);
  const raw = ctx.reply.raw;
  if (ctx.clientGone || raw.writableEnded) return;
  const payload =
    ctx.format === "anthropic"
      ? `event: error\ndata: ${JSON.stringify({ type: "error", error: { type, message, code } })}\n\n`
      : `data: ${JSON.stringify({ error: { message, type, code, param: null } })}\n\n`;
  raw.write(payload);
  raw.end();
}

/**
 * Non-stream request: start the clock at the first upstream attempt. Idempotent; a request that
 * finishes before `afterMs` never notices (the timer sees `reply.sent` and does nothing).
 */
export function armNonStreamHeartbeat(ctx: HeartbeatCtx, afterMs = NON_STREAM_HEARTBEAT_AFTER_MS, everyMs = NON_STREAM_HEARTBEAT_MS): void {
  if (ctx.stream || ctx.jsonArm || ctx.jsonEarly || ctx.clientGone) return;
  const timer = setTimeout(() => beginEarlyJson(ctx, everyMs), afterMs);
  timer.unref?.();
  ctx.jsonArm = timer;
}

/** Commit 200 + JSON headers and pad with whitespace until the body arrives. */
export function beginEarlyJson(ctx: HeartbeatCtx, everyMs = NON_STREAM_HEARTBEAT_MS): void {
  ctx.jsonArm = null;
  if (ctx.jsonEarly || ctx.stream || ctx.clientGone || ctx.reply.sent) return;
  const { reply } = ctx;
  reply.hijack();
  reply.raw.writeHead(200, {
    ...CORS_HEADERS,
    ...conversationResponseHeaders(reply),
    "content-type": "application/json",
    "cache-control": "no-cache",
    "x-accel-buffering": "no",
  });
  reply.raw.flushHeaders();
  reply.raw.write("\n");
  const keepalive = setInterval(() => {
    if (ctx.clientGone || reply.raw.writableEnded) return;
    reply.raw.write("\n");
  }, everyMs);
  keepalive.unref?.();
  ctx.jsonEarly = { keepalive };
  console.log(`[proxy] ${ctx.requestId} non-stream request still waiting for upstream: 200 committed, padding with whitespace`);
}

/** Clear the arm timer and the padding interval (any terminal path; safe to call twice). */
export function stopNonStreamHeartbeat(ctx: HeartbeatCtx): void {
  if (ctx.jsonArm) {
    clearTimeout(ctx.jsonArm);
    ctx.jsonArm = null;
  }
  if (ctx.jsonEarly?.keepalive) {
    clearInterval(ctx.jsonEarly.keepalive);
    ctx.jsonEarly.keepalive = null;
  }
}

/** The JSON body of a request whose 200 + headers already went out: write it and end the response. */
export function endEarlyJson(ctx: HeartbeatCtx, body: Buffer | string): void {
  stopNonStreamHeartbeat(ctx);
  const raw = ctx.reply.raw;
  if (ctx.clientGone || raw.writableEnded) return;
  raw.end(body);
}

/** A failure after the 200 was committed: the error document as the body (logged, since the status lies). */
export function endEarlyJsonWithError(ctx: HeartbeatCtx, status: number, code: string, message: string, type: ErrorType, rawBody?: string): void {
  console.warn(`[proxy] ${ctx.requestId} ${status} ${code} after the non-stream 200 was committed: delivered as a JSON error body`);
  endEarlyJson(ctx, rawBody ?? JSON.stringify(errorBody(ctx.format, code, message, type)));
}
