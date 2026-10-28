// Migration 5 (onboarding: rpm_limit + bound_proxy_id + node_proxies.bound_account_id
// + onboarding_jobs) on a fresh DB and as an upgrade of a pre-5 database.
// Uses a temp DATA_DIR so nothing touches data/.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const dir = mkdtempSync(join(tmpdir(), "1dayapi-core-m5-"));
process.env.DATA_DIR = dir;
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));

const core = await import("../dist/index.js");
const { runMigrations } = await import("../dist/migrations.js");
const { db, run, one, all } = core;
const cols = (t) => new Set(db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name));

test("fresh database has onboarding columns, table and migration 5 recorded", () => {
  const a = cols("accounts");
  assert.ok(a.has("rpm_limit") && a.has("bound_proxy_id"));
  assert.ok(cols("node_proxies").has("bound_account_id"));
  assert.ok(one("SELECT 1 FROM sqlite_master WHERE type='table' AND name='onboarding_jobs'"));
  assert.ok(one("SELECT 1 FROM schema_migrations WHERE version = 5"));
});

test("upgrade: migration 5 re-applies idempotently", () => {
  db.exec("DROP INDEX IF EXISTS idx_accounts_bound_proxy"); // migration 6's indexes block the column drops
  db.exec("DROP INDEX IF EXISTS idx_node_proxies_bound");
  db.exec("ALTER TABLE accounts DROP COLUMN rpm_limit");
  db.exec("ALTER TABLE accounts DROP COLUMN bound_proxy_id");
  db.exec("ALTER TABLE node_proxies DROP COLUMN bound_account_id");
  db.exec("DROP TABLE onboarding_jobs");
  run("DELETE FROM schema_migrations WHERE version IN (5, 6)");
  runMigrations(db, () => {});
  assert.ok(cols("accounts").has("rpm_limit") && cols("accounts").has("bound_proxy_id"));
  assert.ok(cols("node_proxies").has("bound_account_id"));
  assert.ok(one("SELECT 1 FROM sqlite_master WHERE type='table' AND name='onboarding_jobs'"));
  assert.ok(one("SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_accounts_bound_proxy'"), "migration 6 index restored");
  runMigrations(db, () => {}); // no-op second run
  assert.equal(all("SELECT version FROM schema_migrations WHERE version = 5").length, 1);
  assert.equal(all("SELECT version FROM schema_migrations WHERE version = 6").length, 1);
});

test("defaults, proxy binding and boundProxyDown scheduling gate", () => {
  const now = core.nowIso();
  run(
    `INSERT INTO accounts (id, name, platform, type, protocol, credential_enc, created_at, updated_at)
     VALUES ('a1', 'a1', 'anthropic', 'oauth', 'anthropic', ?, ?, ?)`,
    core.encryptJson({ accessToken: "t" }),
    now,
    now,
  );
  const a1 = one("SELECT * FROM accounts WHERE id='a1'");
  assert.equal(a1.rpm_limit, 0);
  assert.equal(a1.bound_proxy_id, null);
  assert.equal(core.boundProxyDown(a1), false, "no binding -> never gated");

  run("INSERT INTO users (id, role, name, login_key_hash, login_key_preview) VALUES ('u1', 'provider', 'p', 'h', 'prev')");
  run("INSERT INTO nodes (node_id, provider_id, secret_hash) VALUES ('n1', 'u1', 'x')");
  run("INSERT INTO node_proxies (id, node_id, url_enc, status) VALUES ('p1', 'n1', ?, 'unknown')", core.encryptString("http://p1:8080"));
  run("UPDATE accounts SET bound_proxy_id = 'p1' WHERE id = 'a1'");
  assert.equal(core.boundProxyDown(one("SELECT * FROM accounts WHERE id='a1'")), true, "unknown proxy gates the account");
  run("UPDATE node_proxies SET status = 'live' WHERE id = 'p1'");
  assert.equal(core.boundProxyDown(one("SELECT * FROM accounts WHERE id='a1'")), false, "live proxy ungates");
  run("UPDATE node_proxies SET status = 'dead' WHERE id = 'p1'");
  assert.equal(core.boundProxyDown(one("SELECT * FROM accounts WHERE id='a1'")), true, "dead proxy gates");
  db.exec("PRAGMA foreign_keys = OFF");
  run("DELETE FROM node_proxies WHERE id = 'p1'");
  db.exec("PRAGMA foreign_keys = ON");
  assert.equal(core.boundProxyDown(one("SELECT * FROM accounts WHERE id='a1'")), true, "missing proxy row gates");
});

test("onboarding_jobs round trip + payload clearing", () => {
  const now = core.nowIso();
  run(
    `INSERT INTO onboarding_jobs (id, requester_id, scope, method, node_id, proxy_id, params_json, payload_enc, status, created_at, updated_at)
     VALUES ('j1', 'u1', 'admin', 'session_key', 'n1', 'p1', '{}', ?, 'working', ?, ?)`,
    core.encryptJson({ sessionKey: "sk-ant-sid-secret" }),
    now,
    now,
  );
  const j = one("SELECT * FROM onboarding_jobs WHERE id='j1'");
  assert.equal(j.status, "working");
  assert.equal(core.decryptJson(j.payload_enc).sessionKey, "sk-ant-sid-secret");
  run("UPDATE onboarding_jobs SET status='done', account_id='a1', payload_enc=NULL WHERE id='j1'");
  assert.equal(one("SELECT payload_enc FROM onboarding_jobs WHERE id='j1'").payload_enc, null);
});
