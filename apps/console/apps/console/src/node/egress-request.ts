import type { AccountRow } from "@1dayapi/core";
import { closeTunnel, openTunnel, readTunnel, writeTunnel } from "./registry.js";

// One HTTP request through an account's node (protocol v2 http_egress: spec
// line out, JSON head line in, raw body until close) using the in-process
// tunnel manager — the same path the gateway takes, so the result reflects
// the node, its proxy and the upstream together. Used by the account test and
// the subscription-window probe for route=node accounts.

const NODE_REQUEST_TIMEOUT_MS = 30_000;

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
): Promise<{ status: number; text: string; nodeId: string } | { nodeError: string; nodeId: string | null }> {
  const opened = await openTunnel(a.id, "http_egress", undefined, 443, proxyId ?? a.bound_proxy_id ?? undefined);
  if (!opened) return { nodeError: "no online node accepted the session (node offline, draining, or not this account's node)", nodeId: null };
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
      if (head && buf.length >= 500) break; // enough for a verdict
    }
    if (!head) return { nodeError: "timeout waiting for the node's response head", nodeId };
    return { status: Number(head.status) || 0, text: buf.toString("utf8").slice(0, 500), nodeId };
  } finally {
    closeTunnel(sessionId, "test_done");
  }
}

