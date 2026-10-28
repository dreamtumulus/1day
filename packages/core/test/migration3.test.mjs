// Migration 3 (CCR executor + window columns) on a fresh DB and as an upgrade
// of an existing v3 database. Uses a temp DATA_DIR so nothing touches data/.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const dir = mkdtempSync(join(tmpdir(), "1dayapi-core-m3-"));
process.env.DATA_DIR = dir;
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));

const core = await import("../dist/index.js");
const { runMigrations } = await import("../dist/migrations.js");
const { db, run, one, all } = core;
const cols = () => new Set(db.prepare("PRAGMA table_info(accounts)").all().map((c) => c.name));
const NEW = ["executor", "window_used", "window_reset_at", "window_checked_at", "window_exhausted_until"];
const NEW4 = ["window_5h_used", "window_5h_reset_at", "window_7d_used", "window_7d_reset_at", "window_reason"];

test("fresh database has executor + window columns and migration 3 recorded", () => {
  const c = cols();
  for (const n of [...NEW, ...NEW4]) assert.ok(c.has(n), n);
  assert.ok(one("SELECT 1 FROM schema_migrations WHERE version = 3"));
  assert.ok(one("SELECT 1 FROM schema_migrations WHERE version = 4"));
});

test("upgrade: columns are re-added idempotently on a pre-3 accounts table", () => {
  for (const n of [...NEW, ...NEW4]) db.exec(`ALTER TABLE accounts DROP COLUMN ${n}`);
  run("DELETE FROM schema_migrations WHERE version IN (3, 4)");
  assert.ok(!cols().has("executor"));
  runMigrations(db, () => {});
  const c = cols();
  for (const n of [...NEW, ...NEW4]) assert.ok(c.has(n), n);
  runMigrations(db, () => {}); // no-op second run
  assert.equal(all("SELECT version FROM schema_migrations WHERE version = 3").length, 1);
});

test("defaults, scheduling filter and window write-back", () => {
  const now = core.nowIso();
  const team="11111111-1111-4111-8111-111111111111";
  core.ensureUpstreamTeam(team);
  run("INSERT INTO users(id,role,name,login_key_hash,login_key_preview) VALUES ('owner','admin','owner','h','h')");
  run("INSERT INTO nodes(node_id,provider_id,secret_hash) VALUES ('n','owner','h')");
  run("INSERT INTO node_proxies(id,node_id,url_enc,status,team_id,isolation_version,exit_ip,resource_key) VALUES ('p','n',?,'live',?,1,'192.0.2.1','ip:192.0.2.1')",core.encryptString("http://192.0.2.1:8080"),team);
  core.claimProxyResource("ip:192.0.2.1",team);
  const ins = (id, executor) =>
    run(
      `INSERT INTO accounts (id, name, platform, type, protocol, credential_enc, executor, created_at, updated_at,team_id,route,node_id,bound_proxy_id)
       VALUES (?, ?, 'anthropic', 'oauth', 'anthropic', ?, ?, ?, ?,?,'node','n','p')`,
      id, id, core.encryptJson({ accessToken: "t" }), executor, now, now,team,
    );
  run("INSERT INTO accounts (id, name, platform, type, protocol, credential_enc) VALUES ('d0','d0','anthropic','apikey','anthropic',?)", core.encryptJson({ apiKey: "k" }));
  assert.equal(one("SELECT executor FROM accounts WHERE id='d0'").executor, "direct");
  ins("c1", "ccr");
  ins("c2", "ccr");
  for (const id of ["d0", "c1", "c2"]) run("INSERT INTO account_groups (account_id, group_id, priority) VALUES (?, 'default', 50)", id);

  const ids = () => core.listCandidates("default", "claude-sonnet-5").map((a) => a.id).sort();
  assert.deepEqual(ids(), ["c1", "c2", "d0"], "never-probed ccr accounts are candidates");

  core.recordWindowUsage("c1", { used: 0.99, resetAt: core.isoIn(3_600_000), window: "five_hour", fiveHour: { used: 0.99, resetAt: core.isoIn(3_600_000) }, sevenDay: { used: 0.2, resetAt: null } });
  const c1 = one("SELECT * FROM accounts WHERE id='c1'");
  assert.equal(c1.window_used, 0.99);
  assert.equal(c1.window_5h_used, 0.99);
  assert.equal(c1.window_7d_used, 0.2);
  assert.match(c1.window_reason, /five_hour 99% ≥ 95% until/);
  assert.ok(c1.window_exhausted_until > now);
  assert.deepEqual(ids(), ["c2", "d0"], "exhausted window drops the account");

  core.recordWindowUsage("c1", { used: 0.5, resetAt: core.isoIn(3_600_000), window: "five_hour" });
  assert.equal(one("SELECT window_exhausted_until FROM accounts WHERE id='c1'").window_exhausted_until, null);
  assert.deepEqual(ids(), ["c1", "c2", "d0"], "room again lifts the window cooldown");

  core.markFailure("c2", { kind: "window_exhausted" });
  assert.ok(one("SELECT window_exhausted_until FROM accounts WHERE id='c2'").window_exhausted_until > now);
  assert.deepEqual(ids(), ["c1", "d0"]);
  core.markFailure("d0", { kind: "window_rejected", window: "five_hour", resetAt: core.isoIn(60_000) });
  assert.deepEqual(ids(), ["c1"], "429 with a rejected window rate-limits until reset");
  core.clearAccountState("d0");
  core.clearAccountState("c2");
  assert.equal(one("SELECT window_exhausted_until FROM accounts WHERE id='c2'").window_exhausted_until, null);
  assert.deepEqual(ids(), ["c1", "c2", "d0"]);
});
