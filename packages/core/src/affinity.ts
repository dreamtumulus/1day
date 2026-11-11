import { db } from "./db.js";

// Account affinity bindings (docs/gateway.md §3 粘性会话 / 设备亲和, migration 16, 2026-10-21).
//
// The gateway keeps two maps that decide which account a request goes to:
// sticky sessions (conversation → account) and device pools (client device →
// its recent accounts). Until 2026-10-21 both lived only in the gateway
// process, so every blue/green release (ops/bin/gateway-switch) started with
// empty maps: every live conversation and every device was re-dealt to a
// fresh account, Anthropic saw devices hop between accounts, prompt caches
// were rebuilt — and because the new process had no "previous" binding the
// hop was never flagged as account_switched, so it was billed in full and
// never refunded.
//
// This module is the write-through store for those maps. The gateway's maps
// stay the hot cache; every set is also written here, every miss is looked
// up here. Both gateway instances share the file during a handover, so a
// binding written by the draining instance is visible to the new one.
//
// The same treatment (table worker_turn_memory, migration 17) covers the
// gateway's per-conversation turn memory for persistent node worker processes
// (docs/worker-sessions.md §1): without it a release made every next turn
// `fresh` — the node forked a new claude process and the whole history was
// folded and fed again (cold start, cache rebuilt, billed in full).

export interface StickyBinding {
  accountId: string;
  /** Unix ms. */
  expiresAt: number;
}

export interface DeviceBinding {
  accounts: string[];
  /** Unix ms. */
  expiresAt: number;
}

interface BindingRow {
  account_id: string | null;
  accounts: string | null;
  expires_at: number;
}

let stmts: {
  get: ReturnType<typeof db.prepare>;
  putSession: ReturnType<typeof db.prepare>;
  putDevice: ReturnType<typeof db.prepare>;
  sweep: ReturnType<typeof db.prepare>;
  getTurn: ReturnType<typeof db.prepare>;
  putTurn: ReturnType<typeof db.prepare>;
  delTurn: ReturnType<typeof db.prepare>;
  sweepTurn: ReturnType<typeof db.prepare>;
  putThirdParty: ReturnType<typeof db.prepare>;
} | null = null;

function s() {
  if (!stmts) {
    stmts = {
      get: db.prepare("SELECT account_id, accounts, expires_at FROM affinity_bindings WHERE key = ? AND kind = ?"),
      putSession: db.prepare(
        `INSERT INTO affinity_bindings (key, kind, account_id, accounts, expires_at, updated_at)
         VALUES (?, 'session', ?, NULL, ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'))
         ON CONFLICT(key) DO UPDATE SET kind = 'session', account_id = excluded.account_id, accounts = NULL,
           expires_at = excluded.expires_at, updated_at = excluded.updated_at`,
      ),
      putDevice: db.prepare(
        `INSERT INTO affinity_bindings (key, kind, account_id, accounts, expires_at, updated_at)
         VALUES (?, 'device', NULL, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'))
         ON CONFLICT(key) DO UPDATE SET kind = 'device', account_id = NULL, accounts = excluded.accounts,
           expires_at = excluded.expires_at, updated_at = excluded.updated_at`,
      ),
      sweep: db.prepare("DELETE FROM affinity_bindings WHERE expires_at < ?"),
      getTurn: db.prepare("SELECT data, expires_at FROM worker_turn_memory WHERE key = ?"),
      putTurn: db.prepare(
        `INSERT INTO worker_turn_memory (key, data, expires_at, updated_at)
         VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'))
         ON CONFLICT(key) DO UPDATE SET data = excluded.data, expires_at = excluded.expires_at, updated_at = excluded.updated_at`,
      ),
      delTurn: db.prepare("DELETE FROM worker_turn_memory WHERE key = ?"),
      sweepTurn: db.prepare("DELETE FROM worker_turn_memory WHERE expires_at < ?"),
      putThirdParty: db.prepare(
        `INSERT INTO affinity_bindings (key, kind, account_id, accounts, expires_at, updated_at)
         VALUES (?, 'tui_third_party', NULL, NULL, ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'))
         ON CONFLICT(key) DO UPDATE SET kind = 'tui_third_party', account_id = NULL, accounts = NULL,
           expires_at = excluded.expires_at, updated_at = excluded.updated_at`,
      ),
    };
  }
  return stmts;
}

/** The live sticky binding for a session key, or undefined (missing or expired). */
export function loadStickyBinding(key: string, now = Date.now()): StickyBinding | undefined {
  const row = s().get.get(key, "session") as BindingRow | undefined;
  if (!row || !row.account_id || Number(row.expires_at) < now) return undefined;
  return { accountId: row.account_id, expiresAt: Number(row.expires_at) };
}

export function saveStickyBinding(key: string, accountId: string, expiresAt: number): void {
  s().putSession.run(key, accountId, Math.floor(expiresAt));
}

/** The live device pool for a device key, or undefined (missing, expired or unreadable). */
export function loadDeviceBinding(key: string, now = Date.now()): DeviceBinding | undefined {
  const row = s().get.get(key, "device") as BindingRow | undefined;
  if (!row || !row.accounts || Number(row.expires_at) < now) return undefined;
  try {
    const accounts = JSON.parse(row.accounts) as unknown;
    if (!Array.isArray(accounts)) return undefined;
    return { accounts: accounts.filter((a): a is string => typeof a === "string"), expiresAt: Number(row.expires_at) };
  } catch {
    return undefined;
  }
}

export function saveDeviceBinding(key: string, accounts: string[], expiresAt: number): void {
  s().putDevice.run(key, JSON.stringify(accounts), Math.floor(expiresAt));
}

// ---------- worker turn memory (docs/worker-sessions.md §1) ----------

/**
 * The gateway's TurnMemory for a persistent worker session, stored as opaque
 * JSON: the shape belongs to apps/gateway/src/ccr/session-memory.ts; this side
 * only guarantees it comes back exactly as saved while unexpired.
 */
export function loadTurnMemory<T = unknown>(key: string, now = Date.now()): T | undefined {
  const row = s().getTurn.get(key) as { data: string; expires_at: number } | undefined;
  if (!row || Number(row.expires_at) < now) return undefined;
  try {
    return JSON.parse(row.data) as T;
  } catch {
    return undefined;
  }
}

export function saveTurnMemory(key: string, data: unknown, expiresAt: number): void {
  s().putTurn.run(key, JSON.stringify(data), Math.floor(expiresAt));
}

export function deleteTurnMemory(key: string): void {
  s().delTurn.run(key);
}

/** TUI third-party refusals are shared by both gateway instances and survive releases. */
export function loadTuiThirdPartyRefusal(key: string, now: number = Date.now()): number | undefined {
  const row = s().get.get(`tui-third-party:${key}`, "tui_third_party") as BindingRow | undefined;
  return row && Number(row.expires_at) >= now ? Number(row.expires_at) : undefined;
}

export function saveTuiThirdPartyRefusal(key: string, expiresAt: number): void {
  s().putThirdParty.run(`tui-third-party:${key}`, Math.floor(expiresAt));
}

/** Drop expired bindings and turn memories; returns how many rows went. The gateway runs this every 10 min. */
export function sweepAffinityBindings(now = Date.now()): number {
  return Number(s().sweep.run(now).changes) + Number(s().sweepTurn.run(now).changes);
}

/** Live rows by kind (startup log / diagnostics). */
export function countAffinityBindings(now = Date.now()): { session: number; device: number; turn: number } {
  const rows = db
    .prepare("SELECT kind, COUNT(*) AS n FROM affinity_bindings WHERE expires_at >= ? GROUP BY kind")
    .all(now) as Array<{ kind: string; n: number }>;
  const out = { session: 0, device: 0, turn: 0 };
  for (const r of rows) if (r.kind === "session" || r.kind === "device") out[r.kind] = Number(r.n);
  const t = db.prepare("SELECT COUNT(*) AS n FROM worker_turn_memory WHERE expires_at >= ?").get(now) as { n: number };
  out.turn = Number(t.n);
  return out;
}

/** Tests only. */
export function clearAffinityBindings(): void {
  db.exec("DELETE FROM affinity_bindings");
  db.exec("DELETE FROM worker_turn_memory");
}
