// A separate fsynced write-ahead journal survives transient SQLite failures and
// process restarts. Never retry model execution to repair an accounting write.
import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "./paths.js";
import { prepareSettlementPricing, settlePreparedRequest, type SettleInput, type SettleResult, type SettlementPricing } from "./billing.js";

const journalDir = join(dataDir, "settlement-journal");
interface Entry { version: 1; input: SettleInput; pricing: SettlementPricing }
let lastScan = 0;
let healthy = true;

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

export function settleRequestDurably(input: SettleInput): SettleResult {
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

/** Replay is safe across processes: usage_logs.request_id is the idempotency key. */
export function retryPendingSettlements(): number {
  ensureDir();
  let pending = 0;
  for (const name of readdirSync(journalDir)) {
    if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
    const path = join(journalDir, name);
    try {
      const entry = load(path);
      settlePreparedRequest(entry.input, entry.pricing);
      remove(path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      pending++;
      console.error("[settlement] retry remains pending", name, err);
    }
  }
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

setInterval(() => { try { retryPendingSettlements(); } catch (err) { healthy = false; console.error("[settlement] recovery failed", err); } }, 10_000).unref();
