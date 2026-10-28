import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FastifyReply, FastifyRequest } from "fastify";
import {
  dataDir,
  generateLoginKey,
  isoIn,
  newId,
  nowIso,
  one,
  randomHex,
  run,
  sha256Hex,
  type Role,
} from "@1dayapi/core";
import { sendError } from "./http.js";

// Key login + cookie sessions (docs/v3-design.md §2). Login keys are the
// only credential; there is no self-registration.

export const SESSION_COOKIE = "oneday_session";
const SESSION_TTL_DAYS = 7;
const secureCookie = process.env.COOKIE_SECURE === "1";

export interface SessionUser {
  id: string;
  role: Role;
  name: string;
  status: string;
  loginKeyPreview: string;
  balanceUsd: number;
  creditLimitUsd: number;
  creditUsedUsd: number;
  availableUsd: number;
}

declare module "fastify" {
  interface FastifyRequest {
    user?: SessionUser;
  }
}

interface UserRow {
  id: string;
  role: Role;
  name: string;
  status: string;
  login_key_preview: string;
  balance_usd: number;
  credit_limit_usd: number;
  credit_used_usd: number;
}

function shape(r: UserRow): SessionUser {
  return {
    id: r.id,
    role: r.role,
    name: r.name,
    status: r.status,
    loginKeyPreview: r.login_key_preview,
    balanceUsd: r.balance_usd,
    creditLimitUsd: r.credit_limit_usd,
    creditUsedUsd: r.credit_used_usd,
    availableUsd: Math.round((r.credit_limit_usd - r.credit_used_usd + r.balance_usd) * 1e8) / 1e8,
  };
}

export function meShape(u: SessionUser) {
  return {
    id: u.id,
    role: u.role,
    name: u.name,
    status: u.status,
    keyPreview: u.loginKeyPreview,
    balanceUsd: u.balanceUsd,
    creditLimitUsd: u.creditLimitUsd,
    creditUsedUsd: u.creditUsedUsd,
    availableUsd: u.availableUsd,
  };
}

export type LoginResult = { ok: true; user: SessionUser; token: string } | { ok: false; code: string };

export function login(plaintext: string): LoginResult {
  if (!plaintext.startsWith("1dk_")) return { ok: false, code: "invalid_login_key" };
  const r = one<UserRow>("SELECT * FROM users WHERE login_key_hash = ?", sha256Hex(plaintext));
  if (!r) return { ok: false, code: "invalid_login_key" };
  if (r.status !== "active") return { ok: false, code: "user_disabled" };
  const token = randomHex(32);
  // Only the hash is stored (migration 24, docs/auth.md §3): a copy of the DB cannot be
  // replayed as a login; the cookie carries the random token and is hashed on every lookup.
  run(
    "INSERT INTO user_sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)",
    sessionTokenHash(token),
    r.id,
    isoIn(SESSION_TTL_DAYS * 86_400_000),
    nowIso(),
  );
  run("UPDATE users SET last_login_at = ? WHERE id = ?", nowIso(), r.id);
  return { ok: true, user: shape(r), token };
}

/** The at-rest form of a session token (what user_sessions.token_hash holds). */
export function sessionTokenHash(token: string): string {
  return sha256Hex(token);
}

export function logout(token: string): void {
  run("DELETE FROM user_sessions WHERE token_hash = ?", sessionTokenHash(token));
}

export function sessionUser(token: string): SessionUser | null {
  if (!token || token.length > 256) return null;
  const r = one<UserRow>(
    `SELECT u.* FROM user_sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > ? AND u.status = 'active'`,
    sessionTokenHash(token),
    nowIso(),
  );
  return r ? shape(r) : null;
}

export function dropSessions(userId: string): void {
  run("DELETE FROM user_sessions WHERE user_id = ?", userId);
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i === -1) continue;
    try {
      out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      /* ignore malformed cookie */
    }
  }
  return out;
}

export function sessionCookie(token: string): string {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_DAYS * 86400}${secureCookie ? "; Secure" : ""}`;
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secureCookie ? "; Secure" : ""}`;
}

/** Fastify preHandler: require a session whose role is in `roles`. */
export function requireRole(...roles: Role[]) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    const user = token ? sessionUser(token) : null;
    if (!user) {
      sendError(reply, 401, "unauthorized", "Login required");
      return;
    }
    if (!roles.includes(user.role)) {
      sendError(reply, 403, "role_not_permitted", `Role '${user.role}' cannot access this endpoint`);
      return;
    }
    req.user = user;
  };
}

export const requireAny = requireRole("admin", "consumer", "provider", "ops");
export const requireConsumer = requireRole("consumer", "admin");
export const requireProvider = requireRole("provider");
export const requireAdmin = requireRole("admin");
/** Account-pool operations (docs/auth.md §2): the ops role shares the admin account endpoints it is allowed on. */
export const requireOps = requireRole("admin", "ops");

// ---------- users ----------

/** Create a user with a fresh login key; returns the plaintext once. */
export function createUser(role: Role, name: string, note: string | null = null): { id: string; loginKey: string } {
  const k = generateLoginKey(role);
  const id = newId();
  run(
    `INSERT INTO users (id, role, name, login_key_hash, login_key_preview, note, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    id,
    role,
    name,
    k.hash,
    k.preview,
    note,
    nowIso(),
  );
  return { id, loginKey: k.plaintext };
}

export function resetLoginKey(userId: string, role: Role): string {
  const k = generateLoginKey(role);
  run("UPDATE users SET login_key_hash = ?, login_key_preview = ? WHERE id = ?", k.hash, k.preview, userId);
  dropSessions(userId);
  return k.plaintext;
}

/** First start with no active admin: generate one and write data/admin-key.txt (0600). */
export function ensureInitialAdmin(log: (msg: string) => void): void {
  if (one("SELECT 1 FROM users WHERE role = 'admin' AND status = 'active' LIMIT 1")) return;
  const { loginKey } = createUser("admin", "initial-admin");
  const keyFile = join(dataDir, "admin-key.txt");
  writeFileSync(keyFile, loginKey + "\n", { mode: 0o600 });
  chmodSync(keyFile, 0o600);
  // The plaintext key goes to the 0600 file only; logs (journald, CI output) get the preview.
  log(`[auth] no admin found; generated initial admin login key ${loginKey.slice(0, 16)}… -> ${keyFile} (0600)`);
}

export function cleanupSessions(): void {
  run("DELETE FROM user_sessions WHERE expires_at <= ?", nowIso());
}
