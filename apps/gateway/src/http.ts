import crypto from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { config } from "./config.js";
import type { ClientFormat } from "./upstream.js";

export type ErrorType =
  | "invalid_request_error"
  | "authentication_error"
  | "permission_error"
  | "not_found_error"
  | "billing_error"
  | "rate_limit_error"
  | "upstream_error"
  | "api_error";

/** Error body in the client's dialect: Anthropic clients get {type:"error", error:{…}}. */
export function errorBody(format: ClientFormat, code: string, message: string, type: ErrorType): unknown {
  if (format === "anthropic") return { type: "error", error: { type, message, code } };
  return { error: { code, message, type } };
}

export function sendError(
  reply: FastifyReply,
  format: ClientFormat,
  status: number,
  code: string,
  message: string,
  type: ErrorType,
): FastifyReply {
  const r = reply.status(status).header("content-type", "application/json");
  // Every platform 429 / 503 carries a Retry-After (audit 2026-11-01 B3): clients that honour it stop hammering a
  // busy pool. Branches that know better (team_capacity_exhausted: 30 s, relayed upstream values) set it first.
  if ((status === 429 || status === 503) && !reply.getHeader("retry-after")) r.header("retry-after", status === 429 ? "10" : "15");
  return r.send(errorBody(format, code, message, type));
}

export const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers":
    "authorization, x-api-key, content-type, anthropic-version, anthropic-beta, x-1dayapi-tee-proof-mode, x-claude-code-session-id, x-claude-session-id, x-session-id, session_id, x-conversation-id, x-1day-conversation-id",
  "access-control-expose-headers": "request-id, retry-after, x-1day-mode, x-1day-ignored-params, x-1day-conversation-id, x-1day-conversation-generation, x-1day-context-reset",
};

/** Raw SSE/heartbeat responses bypass Fastify's normal response header flush. */
export function conversationResponseHeaders(reply: FastifyReply): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of ["request-id", "x-1day-mode", "x-1day-ignored-params", "x-1day-conversation-id", "x-1day-conversation-generation", "x-1day-context-reset"]) {
    const value = reply.getHeader(key);
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

export function clientIp(req: FastifyRequest): string {
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff) return xff.split(",")[0].trim();
  return req.ip;
}

// ---------- TEE proof stub (HMAC; not a hardware attestation) ----------

export interface TeeProof {
  upstream_host: string;
  body_sha256: string;
  signature: string;
  algo: "hmac-sha256";
  note: string;
}

export function makeTeeProof(upstreamHost: string, body: Buffer): TeeProof {
  const bodyHash = crypto.createHash("sha256").update(body).digest("hex");
  const signature = crypto.createHmac("sha256", config.proofSecret).update(`${upstreamHost}:${bodyHash}`).digest("hex");
  return { upstream_host: upstreamHost, body_sha256: bodyHash, signature, algo: "hmac-sha256", note: "local stub, not a Nitro attestation" };
}

export function teeProofRequested(req: FastifyRequest): string | null {
  const v = req.headers["x-1dayapi-tee-proof-mode"];
  return typeof v === "string" && v ? v : null;
}
