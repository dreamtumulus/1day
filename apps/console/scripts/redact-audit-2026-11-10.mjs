#!/usr/bin/env node
// ONE-OFF maintenance (review fix 2026-11-10): re-redact the rows already stored in `admin_audit`.
//
// Until this release the audit trail redacted by key name only, so proxy URLs with their passwords (`proxy`,
// `proxies[].url`, pasted `user:pass@host:port` / `host:port:user:pass` lines) and OAuth callback URLs (`code=`,
// `state=`) were stored in clear. New rows are scrubbed by apps/console/src/audit-redact.ts; this script applies the
// same function to the existing rows (180 days of history).
//
// Usage (console built: `pnpm --filter @1dayapi/console build`):
//   node apps/console/scripts/redact-audit-2026-11-10.mjs <backup.db> [--db <path>] [--apply] [--samples N]
//
//   <backup.db>   REQUIRED first argument: where `VACUUM INTO` writes a full copy of the database before anything is
//                 changed. Must not exist yet. Taken only with --apply (a dry run writes nothing at all).
//   --db <path>   database to work on (default: $DB_PATH, else $DATA_DIR/1dayapi.db). There is no built-in default
//                 beyond the environment: the script refuses to guess.
//   --apply       write the changes (one transaction). Without it: dry run — counts and a few samples of the
//                 already-redacted result (the old values are never printed).
//
// The backup contains the unredacted rows: store it like a secret and delete it once the result is verified.
// Safe to run twice: the redaction is idempotent, a second run reports 0 rows to change.
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const fail = (msg) => { console.error(`redact-audit: ${msg}`); process.exit(2); };

const backup = args[0] && !args[0].startsWith("--") ? resolve(args[0]) : null;
if (!backup) fail("the first argument must be the VACUUM INTO backup path (see the header of this file)");
const opt = (name) => { const i = args.indexOf(name); return i > 0 ? args[i + 1] : undefined; };
const apply = args.includes("--apply");
const samples = Math.max(0, Number(opt("--samples") ?? 5) || 0);
const dbPath = opt("--db") ?? process.env.DB_PATH ?? (process.env.DATA_DIR ? join(process.env.DATA_DIR, "1dayapi.db") : null);
if (!dbPath) fail("no database given: pass --db <path> or set DB_PATH / DATA_DIR");
if (!existsSync(dbPath)) fail(`database not found: ${dbPath}`);
if (existsSync(backup)) fail(`backup path already exists, refusing to overwrite: ${backup}`);
if (!existsSync(dirname(backup))) fail(`backup directory does not exist: ${dirname(backup)}`);
if (resolve(dbPath) === backup) fail("the backup path is the database itself");

const redactModule = join(here, "..", "dist", "audit-redact.js");
if (!existsSync(redactModule)) fail(`${redactModule} is missing: build the console first (pnpm --filter @1dayapi/console build)`);
const { reRedactSummary } = await import(redactModule);

const db = new DatabaseSync(dbPath, { readOnly: !apply });
db.exec("PRAGMA busy_timeout = 10000");
if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='admin_audit'").get()) fail("this database has no admin_audit table");

const rows = db.prepare("SELECT id, method, path, summary FROM admin_audit WHERE summary IS NOT NULL").all();
const changes = [];
for (const r of rows) {
  const next = reRedactSummary(r.summary);
  if (next !== null) changes.push({ id: r.id, method: r.method, path: r.path, next });
}
console.log(`redact-audit: ${dbPath}: ${rows.length} audit row(s) with a summary, ${changes.length} to re-redact (${apply ? "APPLY" : "dry run"})`);
const byPath = new Map();
for (const c of changes) {
  const key = `${c.method} ${c.path.replace(/[0-9a-f]{8}-[0-9a-f-]{27}|node_[0-9a-f-]{36}|[0-9a-f]{12,}/gi, ":id")}`;
  byPath.set(key, (byPath.get(key) ?? 0) + 1);
}
for (const [k, n] of [...byPath.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30)) console.log(`  ${String(n).padStart(6)}  ${k}`);
for (const c of changes.slice(0, samples)) console.log(`  sample ${c.id} ${c.method} ${c.path}\n    → ${c.next.slice(0, 300)}${c.next.length > 300 ? "…" : ""}`);

if (!apply) {
  console.log("redact-audit: dry run, nothing written. Re-run with --apply to back up (VACUUM INTO) and write.");
  db.close();
  process.exit(0);
}
if (changes.length === 0) {
  console.log("redact-audit: nothing to change; no backup taken.");
  db.close();
  process.exit(0);
}
db.prepare("VACUUM INTO ?").run(backup);
console.log(`redact-audit: backup written to ${backup} (contains the unredacted rows — protect it, delete it after verifying)`);
const update = db.prepare("UPDATE admin_audit SET summary = ? WHERE id = ?");
db.exec("BEGIN IMMEDIATE");
try {
  for (const c of changes) update.run(c.next, c.id);
  db.exec("COMMIT");
} catch (err) {
  db.exec("ROLLBACK");
  db.close();
  fail(`update failed, rolled back (the backup stays at ${backup}): ${err?.message ?? err}`);
}
const left = db.prepare("SELECT id, summary FROM admin_audit WHERE summary IS NOT NULL").all().filter((r) => reRedactSummary(r.summary) !== null).length;
console.log(`redact-audit: ${changes.length} row(s) rewritten; ${left} still differ on a second pass (expected 0).`);
console.log("redact-audit: the old values may still sit in free pages / the WAL of the live database until it is vacuumed or checkpointed.");
db.close();
process.exit(left === 0 ? 0 : 1);
