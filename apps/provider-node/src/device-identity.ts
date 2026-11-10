import fs from "node:fs";
import path from "node:path";
import { readRegularFile, writeFileAtomic, type Owner } from "./account-files.js";

// Device identity of an account = `userID` in its `.claude.json` (docs/claude-code-compat.md §8). It is seeded from
// the platform's deviceId and must never change: Claude Code presents it upstream on every request and in telemetry.
// X-49 (2026-11-10): a root-owned replacement made Claude Code mint a new one on 40 accounts. This module holds the
// checks around it: what the file looks like, the pre-spawn gate, and the repair when it drifted.

export const DEVICE_ID_RE = /^[0-9a-f]{64}$/i;
const CLAUDE_JSON = ".claude.json";
const DRIFT_PREFIX = `${CLAUDE_JSON}.drift-`;
const BACKUP_PREFIX = `${CLAUDE_JSON}.backup.`;
export const DRIFT_COPIES_KEPT = 3;

export type ClaudeJsonState =
  | { kind: "missing" }
  /** A symlink, directory, fifo …: never read, never written through. */
  | { kind: "symlink" }
  | { kind: "not_regular" }
  /** A regular file the node could not read or that is not a JSON object. */
  | { kind: "unreadable"; stat: fs.Stats; bytes: null }
  | { kind: "corrupt"; stat: fs.Stats; bytes: Buffer }
  | { kind: "ok"; stat: fs.Stats; bytes: Buffer; json: Record<string, unknown>; userID: string | null };

/** Look at `<configDir>/.claude.json` without following a symlink. */
export function inspectClaudeJson(configDir: string): ClaudeJsonState {
  const file = path.join(configDir, CLAUDE_JSON);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
    throw err;
  }
  if (stat.isSymbolicLink()) return { kind: "symlink" };
  if (!stat.isFile()) return { kind: "not_regular" };
  let bytes: Buffer;
  try {
    bytes = readRegularFile(file);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { kind: "missing" };
    if (code === "ELOOP") return { kind: "symlink" };
    if (code === "ENOTREG") return { kind: "not_regular" };
    return { kind: "unreadable", stat, bytes: null };
  }
  let json: unknown;
  try {
    json = JSON.parse(bytes.toString("utf8"));
  } catch {
    return { kind: "corrupt", stat, bytes };
  }
  if (!json || typeof json !== "object" || Array.isArray(json)) return { kind: "corrupt", stat, bytes };
  const userID = (json as { userID?: unknown }).userID;
  return { kind: "ok", stat, bytes, json: json as Record<string, unknown>, userID: typeof userID === "string" && userID ? userID : null };
}

/** Why the state is not "the platform's device id, readable": null when it is. */
export function driftReason(state: ClaudeJsonState, want: string): string | null {
  switch (state.kind) {
    case "ok":
      return state.userID === want ? null : state.userID ? "mismatch" : "no_user_id";
    case "missing":
      return "missing";
    default:
      return state.kind;
  }
}

const short = (id: string | null | undefined): string => (id ? id.slice(0, 8) : "none");

/** The one greppable line for every identity problem: `[cc-worker] ALERT device identity drift account=… had=… want=… reason=…`. */
export function driftAlertLine(accountId: string, had: string | null, want: string | null, reason: string, extra = ""): string {
  return `ALERT device identity drift account=${accountId} had=${short(had)} want=${short(want)} reason=${reason}${extra ? ` ${extra}` : ""}`;
}

/**
 * Pre-spawn gate: the file Claude Code is about to read must be a regular file owned by the uid it will run as, mode
 * 0600, a JSON object, and carry the platform's device id. Returns the reason it is not (null = fine).
 * `deviceId` null (the platform sent none): a missing file is accepted — Claude Code creates its own, as it always
 * did for such opens — and the userID is not compared.
 */
export function verifyClaudeJson(configDir: string, expect: { uid: number | null; deviceId: string | null }): string | null {
  const state = inspectClaudeJson(configDir);
  if (state.kind === "missing") return expect.deviceId ? "missing" : null;
  if (state.kind === "symlink" || state.kind === "not_regular") return state.kind;
  if (expect.uid !== null && state.stat.uid !== expect.uid) return `owner uid ${state.stat.uid}, process runs as uid ${expect.uid}`;
  const mode = state.stat.mode & 0o7777;
  if (mode !== 0o600) return `mode ${mode.toString(8).padStart(4, "0")}, expected 0600`;
  if (state.kind !== "ok") return state.kind;
  if (expect.deviceId && state.userID !== expect.deviceId) return state.userID ? `userID ${short(state.userID)} is not the platform device id ${short(expect.deviceId)}` : "no_user_id";
  return null;
}

function stamp(now: number): string {
  return new Date(now).toISOString().replace(/[-:.]/g, "");
}

/** Newest of Claude Code's own `backups/.claude.json.backup.<ms>` whose userID is `want` (bytes), or null. */
export function findIdentityBackup(configDir: string, want: string): { name: string; bytes: Buffer } | null {
  const dir = path.join(configDir, "backups");
  let names: string[];
  try {
    if (!fs.lstatSync(dir).isDirectory()) return null;
    names = fs.readdirSync(dir).filter((n) => n.startsWith(BACKUP_PREFIX));
  } catch {
    return null;
  }
  const candidates = names.map((name) => {
    const suffix = Number(name.slice(BACKUP_PREFIX.length));
    let mtime = 0;
    try {
      mtime = fs.lstatSync(path.join(dir, name)).mtimeMs;
    } catch {
      /* vanished */
    }
    return { name, order: Number.isFinite(suffix) && suffix > 0 ? suffix : mtime };
  });
  candidates.sort((a, b) => b.order - a.order);
  for (const c of candidates) {
    try {
      const bytes = readRegularFile(path.join(dir, c.name), 32 * 1024 * 1024);
      const j = JSON.parse(bytes.toString("utf8")) as { userID?: unknown } | null;
      if (j && typeof j === "object" && !Array.isArray(j) && j.userID === want) return { name: c.name, bytes };
    } catch {
      /* symlink, unreadable, torn: not a candidate */
    }
  }
  return null;
}

export interface HealResult {
  reason: string;
  had: string | null;
  action: "restored_backup" | "patched" | "reseeded";
  /** Name of the evidence copy kept next to the file (null when there was nothing readable to keep). */
  kept: string | null;
  backup: string | null;
}

/**
 * Put the platform's device id back (X-49 recovery, done by hand on 40 accounts that day):
 *  1. keep the offending file as `.claude.json.drift-<ts>` (same owner, 0600; at most 3 are kept);
 *  2. restore the newest of Claude Code's own backups that still carries the platform id — whole file — else change
 *     only `userID` in the current file, else (nothing parseable) write the same seed a fresh account dir gets;
 *  3. atomically, owned by `owner` (the uid Claude Code runs as; null = keep the file's owner).
 * `state` must be a regular-file state (`ok` with another userID, `corrupt`, `unreadable`): a symlink is never healed
 * through, the caller refuses the open instead.
 */
export function healDeviceIdentity(configDir: string, want: string, state: ClaudeJsonState, owner: Owner | null, now = Date.now()): HealResult {
  if (state.kind === "symlink" || state.kind === "not_regular" || state.kind === "missing") throw new Error(`cannot heal a ${state.kind} .claude.json`);
  const file = path.join(configDir, CLAUDE_JSON);
  const reason = driftReason(state, want) ?? "mismatch";
  const had = state.kind === "ok" ? state.userID : null;

  let kept: string | null = null;
  if (state.bytes) {
    kept = `${DRIFT_PREFIX}${stamp(now)}`;
    writeFileAtomic(path.join(configDir, kept), state.bytes, { mode: 0o600, owner: { uid: state.stat.uid, gid: state.stat.gid } });
    pruneDriftCopies(configDir);
  }

  const backup = findIdentityBackup(configDir, want);
  let action: HealResult["action"];
  let content: string | Buffer;
  if (backup) {
    action = "restored_backup";
    content = backup.bytes;
  } else if (state.kind === "ok") {
    action = "patched";
    content = JSON.stringify({ ...state.json, userID: want });
  } else {
    action = "reseeded";
    content = JSON.stringify({ userID: want, firstStartTime: new Date(now).toISOString() });
  }
  writeFileAtomic(file, content, { mode: 0o600, owner });
  return { reason, had, action, kept, backup: backup?.name ?? null };
}

/** Keep the newest `DRIFT_COPIES_KEPT` evidence copies (names sort by time). */
export function pruneDriftCopies(configDir: string): void {
  let names: string[];
  try {
    names = fs.readdirSync(configDir).filter((n) => n.startsWith(DRIFT_PREFIX) && !n.includes(".tmp-"));
  } catch {
    return;
  }
  names.sort();
  for (const n of names.slice(0, Math.max(0, names.length - DRIFT_COPIES_KEPT))) {
    try {
      fs.unlinkSync(path.join(configDir, n)); // unlink never follows a symlink
    } catch {
      /* already gone */
    }
  }
}
