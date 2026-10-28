import { DatabaseSync } from "node:sqlite";
import { dbPath } from "./paths.js";
import { runMigrations } from "./migrations.js";

export type Row = Record<string, unknown>;

function open(): DatabaseSync {
  const d = new DatabaseSync(dbPath);
  // gateway and console write the same file from two processes.
  d.exec("PRAGMA busy_timeout = 5000;");
  d.exec("PRAGMA journal_mode = WAL;");
  d.exec("PRAGMA foreign_keys = ON;");
  runMigrations(d, (msg) => console.log(`[core/db] ${msg}`));
  return d;
}

export const db: DatabaseSync = open();

/** Run fn inside BEGIN IMMEDIATE … COMMIT (rolls back and rethrows on error). */
export function tx<T>(fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export function one<T = Row>(sql: string, ...params: unknown[]): T | undefined {
  return db.prepare(sql).get(...(params as never[])) as T | undefined;
}

export function all<T = Row>(sql: string, ...params: unknown[]): T[] {
  return db.prepare(sql).all(...(params as never[])) as T[];
}

export function run(sql: string, ...params: unknown[]): { changes: number } {
  const r = db.prepare(sql).run(...(params as never[]));
  return { changes: Number(r.changes) };
}
