import type { FastifyReply, FastifyRequest } from "fastify";

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export function sendError(
  reply: FastifyReply,
  status: number,
  code: string,
  message: string,
  type = status === 401 ? "authentication_error" : status === 403 ? "permission_error" : status >= 500 ? "api_error" : "invalid_request_error",
): FastifyReply {
  return reply.status(status).send({ error: { code, message, type } });
}

/** Throw to abort a handler with a 4xx; app error handler renders it. */
export function bad(code: string, message: string, status = 400): never {
  throw new HttpError(status, code, message);
}

export function notFound(what: string): never {
  throw new HttpError(404, `${what}_not_found`, `${what.replace(/_/g, " ")} not found`);
}

// ---------- body / query readers ----------

export type Body = Record<string, unknown>;

export function body(req: FastifyRequest): Body {
  return (req.body && typeof req.body === "object" ? req.body : {}) as Body;
}

export function query(req: FastifyRequest): Record<string, string | undefined> {
  return (req.query ?? {}) as Record<string, string | undefined>;
}

export function str(b: Body, k: string, opts: { required?: boolean; max?: number } = {}): string | undefined {
  const v = b[k];
  if (v === undefined || v === null || v === "") {
    if (opts.required) bad("invalid_request", `${k} is required`);
    return undefined;
  }
  if (typeof v !== "string") bad("invalid_request", `${k} must be a string`);
  const t = v.trim();
  if (opts.required && !t) bad("invalid_request", `${k} is required`);
  if (opts.max && t.length > opts.max) bad("invalid_request", `${k} is too long (max ${opts.max})`);
  return t;
}

export function num(
  b: Body,
  k: string,
  opts: { min?: number; max?: number; int?: boolean; required?: boolean } = {},
): number | undefined {
  const v = b[k];
  if (v === undefined || v === null || v === "") {
    if (opts.required) bad("invalid_request", `${k} is required`);
    return undefined;
  }
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  if (!Number.isFinite(n)) bad("invalid_request", `${k} must be a number`);
  if (opts.int && !Number.isInteger(n)) bad("invalid_request", `${k} must be an integer`);
  if (opts.min !== undefined && n < opts.min) bad("invalid_request", `${k} must be >= ${opts.min}`);
  if (opts.max !== undefined && n > opts.max) bad("invalid_request", `${k} must be <= ${opts.max}`);
  return n;
}

export function oneOf<T extends string>(b: Body, k: string, values: readonly T[], required = false): T | undefined {
  const v = b[k];
  if (v === undefined || v === null || v === "") {
    if (required) bad("invalid_request", `${k} is required`);
    return undefined;
  }
  if (typeof v !== "string" || !values.includes(v as T)) {
    bad("invalid_request", `${k} must be one of ${values.join(" | ")}`);
  }
  return v as T;
}

export function strArray(b: Body, k: string): string[] | undefined {
  const v = b[k];
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v)) bad("invalid_request", `${k} must be an array of strings`);
  return v.filter((x): x is string => typeof x === "string").map((x) => x.trim()).filter(Boolean);
}

export function strMap(b: Body, k: string): Record<string, string> | null | undefined {
  const v = b[k];
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v !== "object" || Array.isArray(v)) bad("invalid_request", `${k} must be an object`);
  const out: Record<string, string> = {};
  for (const [kk, vv] of Object.entries(v as Record<string, unknown>)) {
    if (typeof vv === "string" && kk.trim() && vv.trim()) out[kk.trim()] = vv.trim();
  }
  return out;
}

// ---------- pagination / date range ----------

export interface Page {
  page: number;
  pageSize: number;
  offset: number;
}

export function page(req: FastifyRequest): Page {
  const q = query(req);
  const p = Math.max(1, Math.floor(Number(q.page ?? 1)) || 1);
  const ps = Math.min(100, Math.max(1, Math.floor(Number(q.pageSize ?? 20)) || 20));
  return { page: p, pageSize: ps, offset: (p - 1) * ps };
}

export function paged<T>(items: T[], total: number, p: Page) {
  return { items, total, page: p.page, pageSize: p.pageSize };
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** from/to (YYYY-MM-DD, inclusive, UTC) -> [fromIso, toIsoExclusive] or nulls. */
export function dateRange(req: FastifyRequest): { from: string | null; to: string | null } {
  const q = query(req);
  const from = q.from && DAY_RE.test(q.from) ? `${q.from}T00:00:00Z` : null;
  let to: string | null = null;
  if (q.to && DAY_RE.test(q.to)) {
    const d = new Date(`${q.to}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 1);
    to = d.toISOString().slice(0, 19) + "Z";
  }
  return { from, to };
}

/** Small WHERE builder. */
export class Where {
  parts: string[] = [];
  params: unknown[] = [];
  add(sql: string, ...p: unknown[]): this {
    this.parts.push(sql);
    this.params.push(...p);
    return this;
  }
  addIf(cond: unknown, sql: string, ...p: unknown[]): this {
    if (cond !== undefined && cond !== null && cond !== "") this.add(sql, ...p);
    return this;
  }
  get sql(): string {
    return this.parts.length ? `WHERE ${this.parts.join(" AND ")}` : "";
  }
}
