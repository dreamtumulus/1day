import { all, decryptString, encryptString, one, run } from "@1dayapi/core";
import { proxyIdFromUrl } from "./registry.js";

// Node proxy pool ledger (protocol v2). Plaintext proxy URLs only exist in
// the PUT request body and the one-time WS proxies.set push; the DB stores
// AES-256-GCM ciphertext (url_enc).

export interface ProxyInput {
  url: string;
  label?: string;
}

const PROXY_URL_RE = /^(https?|socks5h?):\/\/\S+$/;

export function validateProxies(input: unknown): ProxyInput[] {
  if (!Array.isArray(input)) throw new ProxyInputError("proxies must be an array");
  if (input.length > 500) throw new ProxyInputError("at most 500 proxies per node");
  const out: ProxyInput[] = [];
  for (const p of input) {
    if (!p || typeof p !== "object") throw new ProxyInputError("each proxy must be an object {url, label?}");
    const url = (p as Record<string, unknown>).url;
    const label = (p as Record<string, unknown>).label;
    if (typeof url !== "string" || !PROXY_URL_RE.test(url.trim()) || url.length > 500) {
      throw new ProxyInputError("proxy url must be http(s):// or socks5(h):// URL");
    }
    if (label !== undefined && (typeof label !== "string" || label.length > 120)) {
      throw new ProxyInputError("proxy label must be a string of at most 120 chars");
    }
    out.push({ url: url.trim(), label: typeof label === "string" && label.trim() ? label.trim() : undefined });
  }
  return out;
}

export class ProxyInputError extends Error {}

/** Replace a node's whole proxy pool (encrypted at rest). Returns plaintext URLs for the WS push. */
export function replaceNodeProxies(nodeId: string, proxies: ProxyInput[]): string[] {
  run("DELETE FROM node_proxies WHERE node_id = ?", nodeId);
  for (const p of proxies) {
    run(
      "INSERT OR REPLACE INTO node_proxies (id, node_id, url_enc, label, status) VALUES (?, ?, ?, ?, 'unknown')",
      proxyIdFromUrl(p.url),
      nodeId,
      encryptString(p.url),
      p.label ?? null,
    );
  }
  return proxies.map((p) => p.url);
}

/** Mask the userinfo password: http://user:secret@h:1 -> http://user:***@h:1 */
export function maskProxyUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.password) u.password = "***";
    return u.toString();
  } catch {
    return url.replace(/\/\/([^@/]*)@/, "//***@");
  }
}

export function listNodeProxies(nodeId: string) {
  const rows = all<{
    id: string;
    url_enc: string;
    label: string | null;
    status: string;
    last_check_at: string | null;
    last_error: string | null;
    created_at: string;
    assigned: number;
  }>(
    `SELECT p.id, p.url_enc, p.label, p.status, p.last_check_at, p.last_error, p.created_at,
            (SELECT COUNT(*) FROM node_proxy_assignments a WHERE a.node_id = p.node_id AND a.proxy_id = p.id) AS assigned
     FROM node_proxies p WHERE p.node_id = ? ORDER BY p.created_at, p.id`,
    nodeId,
  );
  return rows.map((r) => {
    let masked: string | null = null;
    try {
      masked = maskProxyUrl(decryptString(r.url_enc));
    } catch {
      masked = null; // ciphertext not readable with the current master key
    }
    return {
      id: r.id,
      url: masked,
      label: r.label,
      status: r.status,
      lastCheckAt: r.last_check_at,
      lastError: r.last_error,
      assignedAccounts: r.assigned,
      createdAt: r.created_at,
    };
  });
}

/** Plaintext URLs of a node's pool (for the WS push after deploy). */
export function nodeProxyUrls(nodeId: string): string[] {
  const rows = all<{ url_enc: string }>("SELECT url_enc FROM node_proxies WHERE node_id = ?", nodeId);
  const out: string[] = [];
  for (const r of rows) {
    try {
      out.push(decryptString(r.url_enc));
    } catch {
      // skip unreadable rows
    }
  }
  return out;
}

/**
 * Credential-free proxy picker view (docs/onboarding.md §4): id/label/host/port/
 * status only — userinfo never leaves this layer. freeOnly keeps live unbound
 * proxies, oldest successful probe first (the auto-assignment order, §6.1).
 */
export function listProxiesForPicker(nodeId: string, freeOnly: boolean) {
  const rows = all<{
    id: string;
    url_enc: string;
    label: string | null;
    status: string;
    last_check_at: string | null;
    bound_account_id: string | null;
  }>(
    `SELECT id, url_enc, label, status, last_check_at, bound_account_id FROM node_proxies
     WHERE node_id = ?${freeOnly ? " AND status = 'live' AND bound_account_id IS NULL" : ""}
     ORDER BY last_check_at ASC, id`,
    nodeId,
  );
  const out: Array<{ id: string; label: string | null; host: string | null; port: number | null; status: string; bound: boolean }> = [];
  for (const r of rows) {
    let host: string | null = null;
    let port: number | null = null;
    try {
      const u = new URL(decryptString(r.url_enc));
      host = u.hostname;
      port = u.port ? Number(u.port) : null;
    } catch {
      // ciphertext unreadable with the current master key: mask everything
    }
    out.push({ id: r.id, label: r.label, host, port, status: r.status, bound: r.bound_account_id !== null });
  }
  return out;
}

/** Auto assignment (docs/onboarding.md §6.1): live + unbound, longest-unchecked first. */
export function pickFreeProxy(nodeId: string): { id: string } | undefined {
  return one<{ id: string }>(
    `SELECT id FROM node_proxies WHERE node_id = ? AND status = 'live' AND bound_account_id IS NULL
     ORDER BY last_check_at ASC, id LIMIT 1`,
    nodeId,
  );
}

export function nodeExists(nodeId: string): boolean {
  return !!one("SELECT 1 FROM nodes WHERE node_id = ?", nodeId);
}
