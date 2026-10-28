import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const dir = mkdtempSync(join(tmpdir(), "1dayapi-team-upgrade-"));
process.env.DATA_DIR = dir;
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
const { runMigrations } = await import("../dist/migrations.js");

test("team upgrade preserves existing accounts, proxy bindings, jobs and customer data without backfill", () => {
  const d = new DatabaseSync(":memory:");
  try {
    // The new migration must only require the old columns it actually extends.
    d.exec(`
      CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      CREATE TABLE accounts(id TEXT PRIMARY KEY, name TEXT, credential_enc TEXT, bound_proxy_id TEXT, status TEXT);
      CREATE TABLE node_proxies(id TEXT PRIMARY KEY, node_id TEXT, url_enc TEXT, bound_account_id TEXT, status TEXT);
      CREATE TABLE onboarding_jobs(id TEXT PRIMARY KEY, node_id TEXT, proxy_id TEXT, status TEXT, payload_enc TEXT);
      CREATE TABLE users(id TEXT PRIMARY KEY, login_key_hash TEXT, balance_usd REAL, credit_used_usd REAL);
      CREATE TABLE api_keys(id TEXT PRIMARY KEY, user_id TEXT, key_hash TEXT, used_usd REAL);
      CREATE TABLE ledger(id TEXT PRIMARY KEY, user_id TEXT, amount_usd REAL);
      CREATE TABLE usage_logs(id TEXT PRIMARY KEY, account_id TEXT, actual_cost REAL);
      CREATE TABLE affinity_bindings(key TEXT PRIMARY KEY, account_id TEXT, expires_at INTEGER);
      CREATE TABLE worker_turn_memory(key TEXT PRIMARY KEY, data TEXT);
      INSERT INTO accounts VALUES ('old-account','keep-account','opaque-existing-credential','old-proxy','error');
      INSERT INTO node_proxies VALUES ('old-proxy','old-node','opaque-existing-proxy','old-account','live');
      INSERT INTO onboarding_jobs VALUES ('old-job','old-node','old-proxy','failed','opaque-job-payload');
      INSERT INTO users VALUES ('customer','unchanged-login-hash',17.25,3.5);
      INSERT INTO api_keys VALUES ('old-key','customer','unchanged-key-hash',12.75);
      INSERT INTO ledger VALUES ('payment','customer',42.5);
      INSERT INTO usage_logs VALUES ('request','old-account',0.25);
      INSERT INTO affinity_bindings VALUES ('old-conversation','old-account',9999999999999);
      INSERT INTO worker_turn_memory VALUES ('old-memory','{"turn":7}');
    `);
    const insert = d.prepare("INSERT INTO schema_migrations VALUES (?, '2026-10-26T00:00:00Z')");
    for (let v = 1; v <= 20; v++) insert.run(v);
    const tables = ["accounts", "node_proxies", "onboarding_jobs", "users", "api_keys", "ledger", "usage_logs", "affinity_bindings", "worker_turn_memory"];
    const snapshots = tables.map((table) => {
      const columns = d.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);
      return { table, columns, rows: d.prepare(`SELECT ${columns.join(",")} FROM ${table} ORDER BY rowid`).all() };
    });
    runMigrations(d, () => {});
    for (const { table, columns, rows } of snapshots) {
      assert.deepEqual(d.prepare(`SELECT ${columns.join(",")} FROM ${table} ORDER BY rowid`).all(), rows, table);
    }
    assert.equal(d.prepare("SELECT team_id FROM accounts WHERE id='old-account'").get().team_id, null);
    assert.equal(d.prepare("SELECT team_id FROM node_proxies WHERE id='old-proxy'").get().team_id, null);
    for (const table of ["upstream_teams", "proxy_team_claims", "proxy_team_events", "proxy_quarantine", "conversations", "conversation_generations", "conversation_boundaries"]) {
      assert.equal(d.prepare(`SELECT count(*) AS n FROM ${table}`).get().n, 0, `${table} must not infer legacy ownership`);
    }
    runMigrations(d, () => {});
    assert.equal(d.prepare("SELECT count(*) AS n FROM schema_migrations WHERE version=21").get().n, 1);
  } finally {
    d.close();
  }
});
