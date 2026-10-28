import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";
import * as zlib from "node:zlib";
import type { AccountRow } from "@1dayapi/core";
import { closeTunnel, openEgressOnNode, openTunnel, readTunnel, writeTunnel, type OpenedTunnel } from "./registry.js";

// One HTTP request through an account's node (protocol v2 http_egress: spec
// line out, JSON head line in, raw body until close) using the in-process
// tunnel manager — the same path the gateway takes, so the result reflects
// the node, its proxy and the upstream together. Used by the account test and
// the subscription-window probe for route=node accounts.

const NODE_REQUEST_TIMEOUT_MS = 30_000;
/** Whole bodies by default (usage probe JSON, OAuth refresh JSON); the account test only needs a verdict. */
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;

export type EgressResult = { status: number; text: string; nodeId: string } | { nodeError: string; nodeId: string | null };

/**
 * Send one request through the account's node (protocol v2 http_egress: spec
 * line out, JSON head line in, raw body until close) using the in-process
 * tunnel manager — the same path the gateway takes, so the result reflects
 * the node, its proxy and the upstream together.
 */
export async function requestViaNode(
  a: AccountRow,
  url: string,
  headers: Record<string, string>,
  payload: unknown | undefined,
  /** Pre-encoded body (e.g. form-urlencoded); takes precedence over `payload`. */
  rawBody?: string,
  /** Pin egress to the account's bound proxy (docs/onboarding.md §1 一号一代理). */
  proxyId?: string | null,
  /** Stop reading after this many body bytes (the text is cut there); default = the whole body. */
  maxBytes = DEFAULT_MAX_BYTES,
): Promise<EgressResult> {
  const opened = await openTunnel(a.id, "http_egress", undefined, 443, proxyId ?? a.bound_proxy_id ?? undefined, undefined, undefined, undefined, a.team_id ?? undefined);
  if (!opened) return { nodeError: "no online node accepted the session (node offline, draining, or not this account's node)", nodeId: null };
  return egressRequest(opened, url, headers, payload, rawBody, maxBytes);
}

/**
 * Same request, for a node + pinned proxy without an account row (onboarding,
 * docs/onboarding.md §2.1). `method` only matters for GET-with-no-body vs POST:
 * the node infers POST whenever a body is present.
 */
export async function requestViaNodeProxy(
  target: { nodeId: string; proxyId: string; bindingId: string; teamId?: string },
  url: string,
  headers: Record<string, string>,
  payload: unknown | undefined,
  rawBody?: string,
): Promise<EgressResult> {
  const opened = await openEgressOnNode(target.nodeId, target.proxyId, target.bindingId, target.teamId);
  if (!opened) return { nodeError: "node did not accept the session (offline, draining, or pinned proxy unknown)", nodeId: null };
  return egressRequest(opened, url, headers, payload, rawBody, DEFAULT_MAX_BYTES);
}

async function egressRequest(
  opened: OpenedTunnel,
  url: string,
  headers: Record<string, string>,
  payload: unknown | undefined,
  rawBody: string | undefined,
  maxBytes: number,
): Promise<EgressResult> {
  const { sessionId, nodeId } = opened;
  const deadline = Date.now() + NODE_REQUEST_TIMEOUT_MS;
  try {
    const bodyText = rawBody !== undefined ? rawBody : payload === undefined ? undefined : JSON.stringify(payload);
    const spec = JSON.stringify({ url, headers, ...(bodyText === undefined ? {} : { bodyBase64: Buffer.from(bodyText, "utf8").toString("base64") }) }) + "\n";
    if (!writeTunnel(sessionId, Buffer.from(spec, "utf8"))) return { nodeError: "tunnel closed before the request was sent", nodeId };
    let buf = Buffer.alloc(0);
    let head: Record<string, unknown> | null = null;
    let closed = false;
    while (!closed && Date.now() < deadline) {
      const r = await readTunnel(sessionId, Math.min(5_000, Math.max(deadline - Date.now(), 1)));
      if (!r) return { nodeError: "tunnel session vanished", nodeId };
      for (const c of r.chunks) buf = Buffer.concat([buf, Buffer.from(c.payloadBase64, "base64")]);
      if (r.closed) {
        closed = true;
        if (r.error && !head) return { nodeError: `tunnel closed by node: ${r.error}`, nodeId };
      }
      if (!head) {
        const nl = buf.indexOf("\n");
        if (nl === -1) continue;
        try {
          head = JSON.parse(buf.subarray(0, nl).toString("utf8")) as Record<string, unknown>;
        } catch {
          return { nodeError: "malformed head line from node", nodeId };
        }
        buf = buf.subarray(nl + 1);
        if (typeof head.error === "string") {
          return { nodeError: `${head.error}${typeof head.message === "string" && head.message ? `: ${head.message}` : ""}`, nodeId };
        }
      }
      if (head && buf.length >= maxBytes) break;
    }
    if (!head) return { nodeError: "timeout waiting for the node's response head", nodeId };
    if (!closed && buf.length < maxBytes) return { nodeError: "timeout waiting for the node's response body", nodeId };
    // The node relays Anthropic /v1/* bodies still compressed (content-encoding
    // kept in the head line, see provider-node http-egress); only a complete
    // body can be decoded, a cut one is returned as-is for the verdict callers.
    const encoding = closed ? contentEncoding(head) : null;
    const body = encoding ? decompress(buf, encoding) : buf.subarray(0, maxBytes);
    return { status: Number(head.status) || 0, text: body.toString("utf8"), nodeId };
  } finally {
    closeTunnel(sessionId, "test_done");
  }
}

function contentEncoding(head: Record<string, unknown>): string | null {
  const h = head.headers;
  if (!h || typeof h !== "object") return null;
  for (const [k, v] of Object.entries(h as Record<string, unknown>)) {
    if (k.toLowerCase() === "content-encoding" && typeof v === "string") return v.trim().toLowerCase();
  }
  return null;
}

function decompress(buf: Buffer, encoding: string): Buffer {
  try {
    if (encoding === "gzip" || encoding === "x-gzip") return gunzipSync(buf);
    if (encoding === "br") return brotliDecompressSync(buf);
    if (encoding === "deflate") return inflateSync(buf);
    // zstd needs Node ≥ 22.15 (gateway/tunnel.ts has the same dependency).
    const zstd = (zlib as unknown as { zstdDecompressSync?: (b: Buffer) => Buffer }).zstdDecompressSync;
    if (encoding === "zstd" && zstd) return zstd(buf);
  } catch {
    /* fall through: hand back the raw bytes rather than nothing */
  }
  return buf;
}
