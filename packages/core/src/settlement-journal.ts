// A separate fsynced write-ahead journal survives transient SQLite failures and
// process restarts. Never retry model execution to repair an accounting write.
import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "./paths.js";
import { prepareSettlementPricing, settlePreparedRequest, type SettleInput, type SettleResult, type SettlementPricing } from "./billing.js";

const journalDir = join(dataDir, "settlement-journal");
/** Entries that failed replay too often (review 2026-11-09 G): kept for the operator, no longer blocking admission. */
const deadLetterDir = join(journalDir, "dead-letter");
const ENTRY_NAME = /^[a-f0-9]{64}\.json$/;
interface Entry { version: 1; input: SettleInput; pricing: SettlementPricing }
let lastScan = 0;
let healthy = true;
let pendingCount = 0;
let bestEffortFailures = 0;
/** Counted replay failures per journal file (this process), and when the last one was counted. */
const replayFailures = new Map<string, { count: number; lastAt: number }>();

function envInt(name: string, fallback: number, min: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= min ? Math.floor(n) : fallback;
}
/** Counted replay failures after which an entry moves to dead-letter/ (env SETTLEMENT_REPLAY_MAX_ATTEMPTS, default 5). */
const replayMaxAttempts = (): number => envInt("SETTLEMENT_REPLAY_MAX_ATTEMPTS", 5, 1);
/**
 * Minimum spacing between two counted failures of one entry (env SETTLEMENT_REPLAY_MIN_INTERVAL_MS, default 10 s):
 * admission checks rescan every 2 s, and five failures inside one short database hiccup must not dead-letter a charge.
 */
const replayMinIntervalMs = (): number => envInt("SETTLEMENT_REPLAY_MIN_INTERVAL_MS", 10_000, 0);

/** A busy / locked database says nothing about the entry itself: it stays pending and is never counted. */
function isTransientDbError(err: unknown): boolean {
  const e = err as { code?: unknown; errcode?: unknown; message?: unknown };
  return e?.errcode === 5 || e?.errcode === 6 || /SQLITE_BUSY|SQLITE_LOCKED|database is locked|database table is locked/i.test(`${String(e?.code ?? "")} ${String(e?.message ?? "")}`);
}

const is2xx = (input: SettleInput): boolean => input.statusCode >= 200 && input.statusCode < 300;

/**
 * Rows that move no money — admission rejects (402 / 429 …) and failure logs — are log lines, not charges:
 * a non-2xx status prices to zero by construction (prepareSettlementPricing). A 2xx row keeps the durable path
 * even when it prices to zero (free group): it still carries usage.
 */
function isZeroCostRow(input: SettleInput, pricing: SettlementPricing): boolean {
  return !is2xx(input) && pricing.totalCost === 0 && pricing.actualCost === 0 && pricing.providerEarning === 0;
}

function syncDir(): void {
  const fd = openSync(journalDir, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function ensureDir(): void { mkdirSync(journalDir, { recursive: true, mode: 0o700 }); }
function load(path: string): Entry {
  const entry = JSON.parse(readFileSync(path, "utf8")) as Entry;
  if (entry.version !== 1 || typeof entry.input?.requestId !== "string" || !entry.pricing) throw new Error("invalid settlement journal entry");
  return entry;
}
function remove(path: string): void {
  try { unlinkSync(path); syncDir(); } catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err; }
}
function persist(input: SettleInput): { path: string; entry: Entry } {
  ensureDir();
  const path = join(journalDir, createHash("sha256").update(input.requestId).digest("hex") + ".json");
  if (existsSync(path)) {
    try { return { path, entry: load(path) }; }
    catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err; }
  }
  const entry: Entry = { version: 1, input, pricing: prepareSettlementPricing(input) };
  const temp = join(journalDir, `.${process.pid}-${randomUUID()}.tmp`);
  const fd = openSync(temp, "wx", 0o600);
  try {
    writeFileSync(fd, JSON.stringify(entry));
    fsyncSync(fd);
  } finally { closeSync(fd); }
  try {
    // Atomic publish without replacing another writer's original tariff.
    try { linkSync(temp, path); } catch (err) { if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err; }
    syncDir();
  } finally { unlinkSync(temp); }
  // A recovery worker may settle and unlink the file between publication and
  // our read. In that case replaying this local value is an idempotent no-op.
  try { return { path, entry: load(path) }; }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    return { path, entry };
  }
}

function bestEffortDropped(input: SettleInput, err: unknown): SettleResult {
  bestEffortFailures++;
  console.warn(`[settlement] zero-cost log row not written (best effort, admission unaffected) ${input.requestId} status=${input.statusCode} code=${input.errorCode ?? "-"}: ${(err as Error)?.message ?? String(err)}`);
  return { settled: false, totalCost: 0, actualCost: 0, providerEarning: 0 };
}

/**
 * Money rows: journal first, then the database; a failed write stays queued and closes admission until replayed
 * (idempotent by usage_logs.request_id). Zero-cost rows (rejects, failure logs): one plain best-effort write —
 * never journalled, never touching `healthy`, never throwing. Before 2026-11-09 a single reject row hitting
 * SQLITE_BUSY answered every inference request with 503 until the next rescan.
 */
export function settleRequestDurably(input: SettleInput): SettleResult {
  if (!is2xx(input)) {
    try {
      const pricing = prepareSettlementPricing(input);
      if (isZeroCostRow(input, pricing)) return settlePreparedRequest(input, pricing);
    } catch (err) {
      return bestEffortDropped(input, err);
    }
  }
  let item: ReturnType<typeof persist>;
  try { item = persist(input); } catch (err) {
    healthy = false;
    console.error("[settlement] journal unavailable; inference admission closed", err);
    throw err;
  }
  try {
    const result = settlePreparedRequest(item.entry.input, item.entry.pricing);
    remove(item.path);
    return result;
  } catch (err) {
    healthy = false;
    pendingCount++;
    console.error("[settlement] durable entry queued; inference admission closed", input.requestId, err);
    const p = item.entry.pricing;
    return { settled: false, pending: true, totalCost: p.totalCost, actualCost: p.actualCost, providerEarning: p.providerEarning };
  }
}

function verifyStorage(): void {
  const path = join(journalDir, `.${process.pid}-${randomUUID()}.probe`);
  const fd = openSync(path, "wx", 0o600);
  try { writeFileSync(fd, "ready"); fsyncSync(fd); } finally { closeSync(fd); }
  remove(path);
}

/** Move a poisoned entry out of the replay set. The file is kept byte for byte; moving it back replays it. */
function deadLetter(name: string, path: string, count: number, err: unknown): boolean {
  try {
    mkdirSync(deadLetterDir, { recursive: true, mode: 0o700 });
    const target = join(deadLetterDir, name);
    renameSync(path, target);
    syncDir();
    replayFailures.delete(name);
    let requestId = "?";
    try { requestId = load(target).input.requestId; } catch { /* unreadable entry */ }
    console.error(`[ALERT][settlement] journal entry ${name} (request ${requestId}) failed replay ${count} times and was moved to ${deadLetterDir}; it no longer blocks admission and is NOT billed yet — operator action required: fix the cause, then move the file back into ${journalDir} to replay it. Last error:`, err);
    return true;
  } catch (moveErr) {
    if ((moveErr as NodeJS.ErrnoException).code === "ENOENT") return true; // another process moved or settled it
    console.error("[settlement] could not move entry to dead-letter; it stays pending", name, moveErr);
    return false;
  }
}

/**
 * Replay is safe across processes: usage_logs.request_id is the idempotency key. Returns the number of entries
 * still pending (dead-lettered ones are not pending).
 */
export function retryPendingSettlements(): number {
  ensureDir();
  let pending = 0;
  const now = Date.now();
  const seen = new Set<string>();
  for (const name of readdirSync(journalDir)) {
    if (!ENTRY_NAME.test(name)) continue;
    seen.add(name);
    const path = join(journalDir, name);
    try {
      const entry = load(path);
      settlePreparedRequest(entry.input, entry.pricing);
      remove(path);
      replayFailures.delete(name);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      if (!isTransientDbError(err)) {
        const f = replayFailures.get(name) ?? { count: 0, lastAt: 0 };
        if (f.count === 0 || now - f.lastAt >= replayMinIntervalMs()) { f.count++; f.lastAt = now; replayFailures.set(name, f); }
        if (f.count >= replayMaxAttempts() && deadLetter(name, path, f.count, err)) continue;
      }
      pending++;
      console.error("[settlement] retry remains pending", name, err);
    }
  }
  for (const name of [...replayFailures.keys()]) if (!seen.has(name)) replayFailures.delete(name);
  pendingCount = pending;
  // An empty directory says nothing about a full/unwritable filesystem. A
  // recovery timer must not reopen admission merely because there is no file.
  healthy = false;
  if (pending === 0) { verifyStorage(); healthy = true; }
  lastScan = Date.now();
  return pending;
}

/** Fail closed while unposted settlements exist; verify the journal is writable. */
export function settlementHealthy(): boolean {
  if (Date.now() - lastScan < 2_000) return healthy;
  try {
    if (retryPendingSettlements() > 0) return false;
    return healthy = true;
  } catch (err) {
    lastScan = Date.now();
    console.error("[settlement] storage health check failed", err);
    return healthy = false;
  }
}

/** Gauges for the gateway's counters: entries awaiting replay, entries in dead-letter/, zero-cost rows that were dropped. */
export function settlementJournalStats(): { healthy: boolean; pending: number; deadLetter: number; bestEffortFailures: number } {
  let dead = 0;
  try { dead = existsSync(deadLetterDir) ? readdirSync(deadLetterDir).filter((n) => ENTRY_NAME.test(n)).length : 0; } catch { /* unreadable: report 0 */ }
  return { healthy, pending: pendingCount, deadLetter: dead, bestEffortFailures };
}

setInterval(() => { try { retryPendingSettlements(); } catch (err) { healthy = false; console.error("[settlement] recovery failed", err); } }, 10_000).unref();
