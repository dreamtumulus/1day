import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { all, isoIn, newId, nowIso, one, run } from "@1dayapi/core";
import { Where, dateRange, page, paged, query } from "./http.js";
import { requireAdmin } from "./session.js";

// Admin action audit trail (docs/auth.md §3a, issue A-5): every mutating request under
// /api/admin/* and /api/provider/* by an authenticated user, plus failed /auth/login
// attempts, lands in admin_audit (migration 24). The record is one INSERT inside
// try/catch — auditing never fails or slows a request noticeably — and the stored body
// is redacted: any key that looks like a secret is dropped, strings are truncated.

const SECRET_KEY_RE = /key|token|secret|password|sessionkey|credential|cookie|authorization/i;
const MAX_STRING = 200;
const MAX_DEPTH = 4;
const MAX_KEYS = 60;
const RETENTION_DAYS = 180;

export interface AuditRow {
  id: string;
  at: string;
  user_id: string | null;
  role: string | null;
  method: string;
  path: string;
  status: number;
  ip: string | null;
  summary: string | null;
}

/** Drop secret-looking keys, truncate strings, bound depth/size. Safe on any JSON-ish value. */
export function redactForAudit(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…(${value.length})` : value;
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (depth >= MAX_DEPTH) return "[…]";
  if (Array.isArray(value)) return value.slice(0, MAX_KEYS).map((v) => redactForAudit(v, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    let n = 0;
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY_RE.test(k)) {
        out[k] = "[redacted]";
        continue;
      }
      if (++n > MAX_KEYS) {
        out["…"] = "[truncated]";
        break;
      }
      out[k] = redactForAudit(v, depth + 1);
    }
    return out;
  }
  return String(value);
}

export function recordAudit(e: {
  userId: string | null;
  role: string | null;
  method: string;
  path: string;
  status: number;
  ip: string | null;
  summary: unknown;
}): void {
  try {
    run(
      "INSERT INTO admin_audit (id, at, user_id, role, method, path, status, ip, summary) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      newId(),
      nowIso(),
      e.userId,
      e.role,
      e.method,
      e.path.slice(0, 512),
      e.status,
      e.ip ? e.ip.slice(0, 64) : null,
      e.summary === undefined ? null : JSON.stringify(e.summary).slice(0, 8000),
    );
  } catch {
    // Auditing is best-effort: a locked DB or a schema mismatch must not fail the request.
  }
}

function errorCodeFromPayload(payload: unknown): string | null {
  if (typeof payload !== "string") return null;
  try {
    const j = JSON.parse(payload) as { error?: { code?: unknown } };
    return typeof j.error?.code === "string" ? j.error.code : null;
  } catch {
    return null;
  }
}

/** onSend hook: status and payload are final here; the request body is still on req. */
export function registerAuditHook(app: FastifyInstance): void {
  app.addHook("onSend", async (req: FastifyRequest, reply: FastifyReply, payload: unknown) => {
    const method = req.method;
    if (method === "GET" || method === "HEAD" || method === "OPTIONS") return payload;
    const path = req.url.split("?")[0];
    if (path === "/auth/login") {
      if (reply.statusCode >= 400) {
        recordAudit({
          userId: null,
          role: null,
          method,
          path,
          status: reply.statusCode,
          ip: req.ip ?? null,
          summary: { reason: errorCodeFromPayload(payload) ?? `http_${reply.statusCode}` },
        });
      }
      return payload;
    }
    if (!(path.startsWith("/api/admin/") || path.startsWith("/api/provider/"))) return payload;
    if (!req.user) return payload; // unauthenticated attempts are not actions
    const summary: Record<string, unknown> = {};
    if (req.params && Object.keys(req.params as object).length) summary.params = redactForAudit(req.params);
    if (req.body !== undefined && req.body !== null) summary.body = redactForAudit(req.body);
    if (reply.statusCode >= 400) summary.error = errorCodeFromPayload(payload);
    recordAudit({
      userId: req.user.id,
      role: req.user.role,
      method,
      path,
      status: reply.statusCode,
      ip: req.ip ?? null,
      summary,
    });
    return payload;
  });
}

function auditOut(r: AuditRow) {
  let summary: unknown = null;
  if (r.summary) {
    try {
      summary = JSON.parse(r.summary);
    } catch {
      summary = r.summary;
    }
  }
  return { id: r.id, at: r.at, userId: r.user_id, role: r.role, method: r.method, path: r.path, status: r.status, ip: r.ip, summary };
}

/** GET /api/admin/audit?page&pageSize&userId&path&method&from&to — newest first, admin only. */
export function registerAuditRoutes(app: FastifyInstance): void {
  app.get("/api/admin/audit", { preHandler: requireAdmin }, async (req) => {
    const q = query(req);
    const p = page(req);
    const { from, to } = dateRange(req);
    const w = new Where();
    w.addIf(q.userId, "a.user_id = ?", q.userId);
    w.addIf(q.method, "a.method = ?", (q.method ?? "").toUpperCase());
    if (q.path) w.add("a.path LIKE ?", `%${q.path}%`);
    w.addIf(from, "a.at >= ?", from);
    w.addIf(to, "a.at < ?", to);
    const total = one<{ n: number }>(`SELECT COUNT(*) AS n FROM admin_audit a ${w.sql}`, ...w.params)!.n;
    const rows = all<AuditRow & { user_name: string | null }>(
      `SELECT a.*, u.name AS user_name FROM admin_audit a LEFT JOIN users u ON u.id = a.user_id ${w.sql}
       ORDER BY a.at DESC, a.rowid DESC LIMIT ? OFFSET ?`,
      ...w.params,
      p.pageSize,
      p.offset,
    );
    return { data: paged(rows.map((r) => ({ ...auditOut(r), userName: r.user_name })), total, p) };
  });
}

/** Hourly with session cleanup: keep RETENTION_DAYS of history. */
export function cleanupAudit(): void {
  try {
    run("DELETE FROM admin_audit WHERE at < ?", isoIn(-RETENTION_DAYS * 86_400_000));
  } catch {
    /* table may not exist yet on a very old DB mid-migration; next hour retries */
  }
}
