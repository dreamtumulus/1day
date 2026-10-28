import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";
import * as zlib from "node:zlib";
import { one, CCR, type AccountRow } from "@1dayapi/core";
import { isTrustedExecutionNode } from "./trust.js";
import { closeTunnel, openCleanupEgress, openEgressOnNode, openTunnel, readTunnel, writeTunnel, type OpenedTunnel } from "./registry.js";

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
  target: { nodeId: string; proxyId: string; bindingId: string; teamId?: string; signal?:AbortSignal },
  url: string,
  headers: Record<string, string>,
  payload: unknown | undefined,
  rawBody?: string,
): Promise<EgressResult> {
  target.signal?.throwIfAborted();
  const opened = await openEgressOnNode(target.nodeId, target.proxyId, target.bindingId, target.teamId, target.signal);
  if (!opened) return { nodeError: "node did not accept the session (offline, draining, or pinned proxy unknown)", nodeId: null };
  return egressRequest(opened, url, headers, payload, rawBody, DEFAULT_MAX_BYTES,target.signal);
}

/** This internal cleanup capability cannot run inference, change identity or select a URL. */
export type ArchiveSnapshot={accountId:string;nodeId:string;teamId:string;proxyId:string;baseUrl:string;sessionId:string;cred:{accessToken?:string}};
export function validateArchiveSnapshot(snapshot:ArchiveSnapshot):string|null {
  if (!snapshot || typeof snapshot!=="object")return "cleanup_identity_invalid";
  if (![snapshot.accountId, snapshot.nodeId, snapshot.teamId, snapshot.proxyId, snapshot.sessionId].every((v) => typeof v === "string" && /^[A-Za-z0-9_.:-]{1,180}$/.test(v)) ||
      !isTrustedExecutionNode(snapshot.nodeId) || typeof snapshot.cred?.accessToken !== "string") return "cleanup_identity_invalid";
  let base: URL;
  try { base = new URL(snapshot.baseUrl); } catch { return "cleanup_target_invalid"; }
  if (base.origin !== "https://api.anthropic.com" && !(process.env.ALLOW_UNTRUSTED_EXECUTION === "1" && ["127.0.0.1", "localhost"].includes(base.hostname))) return "cleanup_target_invalid";
  const binding = one(`SELECT 1 FROM proxy_team_events e JOIN node_proxies p ON p.id=e.proxy_id
    JOIN proxy_team_claims c ON c.resource_key=p.resource_key AND c.team_id=e.team_id
    WHERE e.event='account_bound' AND e.account_id=? AND e.node_id=? AND e.team_id=? AND e.proxy_id=?
      AND p.node_id=e.node_id AND p.team_id=e.team_id AND p.isolation_version=1 AND p.status='live'`,
      snapshot.accountId, snapshot.nodeId, snapshot.teamId, snapshot.proxyId);
  if (!binding) return "cleanup_binding_invalid";
  return null;
}

export async function archiveViaNodeSnapshot(snapshot:ArchiveSnapshot):Promise<EgressResult> {
  const invalid=validateArchiveSnapshot(snapshot);
  if(invalid)return {nodeError:invalid,nodeId:snapshot?.nodeId??null};
  const base=new URL(snapshot.baseUrl);
  // The immutable account_bound event survives account deletion; the node receives
  // only a temporary cleanup label on this same fixed organization proxy.
  const opened = await openCleanupEgress(snapshot.nodeId, snapshot.proxyId, snapshot.accountId, snapshot.teamId, snapshot.sessionId);
  if (!opened) return { nodeError: "cleanup_node_unavailable", nodeId: snapshot.nodeId };
  return egressRequest(opened, `${base.origin}${CCR.sessionsPath}/${encodeURIComponent(snapshot.sessionId)}/archive`, {
    authorization: `Bearer ${snapshot.cred.accessToken}`, "x-organization-uuid": snapshot.teamId,
    "anthropic-version": CCR.anthropicVersion, "anthropic-beta": CCR.beta, "content-type": "application/json",
  }, {}, undefined, 64 * 1024);
}

async function egressRequest(
  opened: OpenedTunnel,
  url: string,
  headers: Record<string, string>,
  payload: unknown | undefined,
  rawBody: string | undefined,
  maxBytes: number,
  signal?:AbortSignal,
): Promise<EgressResult> {
  const { sessionId, nodeId } = opened;
  const deadline = Date.now() + NODE_REQUEST_TIMEOUT_MS;
  const cancel=()=>closeTunnel(sessionId,"onboard_cancelled");
  signal?.addEventListener("abort",cancel,{once:true});
  try {
    signal?.throwIfAborted();
    const bodyText = rawBody !== undefined ? rawBody : payload === undefined ? undefined : JSON.stringify(payload);
    const spec = JSON.stringify({ url, headers, ...(bodyText === undefined ? {} : { bodyBase64: Buffer.from(bodyText, "utf8").toString("base64") }) }) + "\n";
    if (!writeTunnel(sessionId, Buffer.from(spec, "utf8"))) return { nodeError: "tunnel closed before the request was sent", nodeId };
    let buf = Buffer.alloc(0);
    let head: Record<string, unknown> | null = null;
    let closed = false;
    while (!closed && Date.now() < deadline) {
      signal?.throwIfAborted();
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
    signal?.removeEventListener("abort",cancel);
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
