// Security hardening (docs/auth.md §3 / §3a, issues A-3 and A-5): session tokens are stored
// only as sha256 hashes (migration 24 rebuilds the legacy plaintext table), admin / provider
// mutations and failed logins land in admin_audit with secrets redacted, and the audit
// endpoint is admin-only. Runs against a real console app on a temp DATA_DIR.
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const dir = mkdtempSync(join(tmpdir(), "1dayapi-security-"));
process.env.DATA_DIR = dir;
process.env.CCR_WINDOW_POLL = "0";
process.env.ALLOW_UNTRUSTED_EXECUTION = "1";
process.env.ONBOARD_MOCK = "1";
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));

const core = await import("@1dayapi/core");
const { all, one, run, sha256Hex } = core;

const { buildApp } = await import("../dist/app.js");
const { createUser, sessionTokenHash } = await import("../dist/session.js");

// ---------- migration 24 backfill: a legacy plaintext session row must survive as a hash ----------
// Core already ran migrations 1..24 on this fresh DB at import. Recreate the v1 table shape
// (plaintext token PRIMARY KEY) with a live row, forget migration 24, and run the migrations
// again on a second connection: the rebuild must carry the row over as its sha256.
const { runMigrations } = await import("../../../packages/core/dist/migrations.js");

const legacyUser = createUser("ops", "legacy-session-owner");
if (runMigrations) {
  const { DatabaseSync } = await import("node:sqlite");
  const raw = new DatabaseSync(join(dir, "1dayapi.db"));
  raw.exec("PRAGMA foreign_keys = OFF");
  raw.exec("DROP TABLE IF EXISTS user_sessions");
  raw.exec(`CREATE TABLE user_sessions (
    token TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`);
  raw.prepare("INSERT INTO user_sessions (token, user_id, expires_at) VALUES (?, ?, ?)").run(
    "legacy-plaintext-token",
    legacyUser.id,
    "2099-01-01T00:00:00Z",
  );
  raw.exec("DELETE FROM schema_migrations WHERE version = 24");
  runMigrations(raw, () => {});
  raw.close();
}

const app = await buildApp();
await app.listen({ port: 0, host: "127.0.0.1" });
const BASE = `http://127.0.0.1:${app.server.address().port}`;

async function rawLogin(key) {
  const r = await fetch(`${BASE}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key }),
  });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, cookie: (r.headers.get("set-cookie") ?? "").split(";")[0], ...j };
}

async function login(key) {
  const r = await rawLogin(key);
  assert.equal(r.status, 200, JSON.stringify(r));
  const cookie = r.cookie;
  const call = async (method, path, body) => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { cookie, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const j = await res.json().catch(() => ({}));
    return { status: res.status, ...j };
  };
  call.cookie = cookie;
  return call;
}

const adminKey = readFileSync(join(dir, "admin-key.txt"), "utf8").trim();
const admin = await login(adminKey);
const adminId = (await admin("GET", "/auth/me")).data.id;
const ops = createUser("ops", "sec-ops");
const opsCall = await login(ops.loginKey);
const provider = createUser("provider", "sec-provider");
const prov = await login(provider.loginKey);

test("sessions: only the token hash is stored; the cookie still works; logout invalidates", async () => {
  const cols = all("SELECT name FROM pragma_table_info('user_sessions')").map((r) => r.name);
  assert.ok(cols.includes("token_hash"), `columns: ${cols}`);
  assert.ok(!cols.includes("token"), "plaintext token column is gone");

  const token = admin.cookie.split("=")[1];
  assert.equal(token.length, 64, "cookie carries the 32-byte random token");
  const row = one("SELECT * FROM user_sessions WHERE user_id = ? ORDER BY created_at DESC LIMIT 1", adminId);
  assert.ok(row, "session row exists");
  assert.equal(row.token_hash, sha256Hex(token), "stored value is the sha256 of the cookie token");
  assert.equal(row.token_hash, sessionTokenHash(token));
  assert.ok(!Object.values(row).includes(token), "the plaintext token appears nowhere in the row");

  const me = await admin("GET", "/auth/me");
  assert.equal(me.status, 200);
  assert.equal(me.data.role, "admin");

  // A forged cookie holding the HASH itself must not log in (hash of hash ≠ stored hash).
  const forged = await fetch(`${BASE}/auth/me`, { headers: { cookie: `oneday_session=${row.token_hash}` } });
  assert.equal(forged.status, 401);

  const temp = await login(ops.loginKey);
  assert.equal((await temp("GET", "/auth/me")).status, 200);
  const out = await fetch(`${BASE}/auth/logout`, { method: "POST", headers: { cookie: temp.cookie } });
  assert.equal(out.status, 200);
  assert.equal((await temp("GET", "/auth/me")).status, 401, "logged-out cookie is rejected");
  assert.equal(one("SELECT 1 FROM user_sessions WHERE token_hash = ?", sha256Hex(temp.cookie.split("=")[1])), undefined);
});

test("migration 24: a legacy plaintext session row is carried over as its hash", { skip: !runMigrations }, async () => {
  assert.equal(one("SELECT 1 FROM user_sessions WHERE token_hash = ?", "legacy-plaintext-token"), undefined);
  const carried = one("SELECT user_id, expires_at FROM user_sessions WHERE token_hash = ?", sha256Hex("legacy-plaintext-token"));
  assert.ok(carried, "hashed row exists");
  assert.equal(carried.user_id, legacyUser.id);
  const legacy = await fetch(`${BASE}/auth/me`, { headers: { cookie: "oneday_session=legacy-plaintext-token" } });
  assert.equal(legacy.status, 200, "the old cookie keeps working after the rebuild");
  assert.equal(one("SELECT name FROM sqlite_master WHERE name = 'user_sessions_plain_v1'"), undefined, "plaintext table dropped");
});

test("audit: admin mutations are recorded with secrets redacted; reads and anonymous calls are not", async () => {
  const before = one("SELECT COUNT(*) n FROM admin_audit").n;
  // A mutation that fails validation still counts as an attempted action.
  const r = await admin("POST", "/api/admin/accounts/onboard", {
    method: "session_key",
    sessionKey: "sk-ant-sid01-" + "x".repeat(90),
    nodeId: "node_missing",
    name: "audit-probe",
    nested: { refreshToken: "rt-secret", note: "n".repeat(400) },
  });
  assert.ok(r.status >= 400, JSON.stringify(r));
  await admin("GET", "/api/admin/accounts");
  const rows = all("SELECT * FROM admin_audit ORDER BY rowid DESC LIMIT 5");
  assert.equal(one("SELECT COUNT(*) n FROM admin_audit").n, before + 1, "exactly one row for the POST, none for the GET");
  const row = rows[0];
  assert.equal(row.user_id, adminId);
  assert.equal(row.role, "admin");
  assert.equal(row.method, "POST");
  assert.equal(row.path, "/api/admin/accounts/onboard");
  assert.equal(row.status, r.status);
  const summary = JSON.parse(row.summary);
  assert.equal(summary.body.sessionKey, "[redacted]");
  assert.equal(summary.body.nested.refreshToken, "[redacted]");
  assert.equal(summary.body.name, "audit-probe");
  assert.equal(summary.body.nodeId, "node_missing");
  assert.ok(summary.body.nested.note.length < 250, "long strings are truncated");
  assert.ok(!row.summary.includes("x".repeat(20)), "no fragment of the session key is stored");
  assert.equal(typeof summary.error, "string");

  // Anonymous mutation attempt: 401 and no audit row (it is not an action by anyone).
  const anon = await fetch(`${BASE}/api/admin/groups`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(anon.status, 401);
  assert.equal(one("SELECT COUNT(*) n FROM admin_audit").n, before + 1);

  // Provider-scope mutation by a provider is recorded too.
  const p = await prov("POST", "/api/provider/accounts/onboard", { method: "session_key", sessionKey: "s", nodeId: "node_missing" });
  assert.ok(p.status >= 400);
  const prow = one("SELECT * FROM admin_audit ORDER BY rowid DESC LIMIT 1");
  assert.equal(prow.user_id, provider.id);
  assert.equal(prow.role, "provider");
  assert.equal(prow.path, "/api/provider/accounts/onboard");
});

test("audit: failed logins are recorded without the key", async () => {
  const bad = await rawLogin("1dk_admin_definitely-not-a-real-key");
  assert.equal(bad.status, 401);
  const row = one("SELECT * FROM admin_audit WHERE path = '/auth/login' ORDER BY rowid DESC LIMIT 1");
  assert.ok(row, "failed login row exists");
  assert.equal(row.user_id, null);
  assert.equal(row.status, 401);
  assert.equal(JSON.parse(row.summary).reason, "invalid_login_key");
  assert.ok(!row.summary.includes("definitely-not"), "the attempted key is not stored");
  assert.equal(one("SELECT COUNT(*) n FROM admin_audit WHERE path = '/auth/login' AND status = 200").n, 0, "successful logins are not audit rows");
});

test("GET /api/admin/audit: paging, filters, newest first, admin only", async () => {
  const list = await admin("GET", "/api/admin/audit?page=1&pageSize=2");
  assert.equal(list.status, 200, JSON.stringify(list));
  assert.equal(list.data.pageSize, 2);
  assert.ok(list.data.total >= 3);
  assert.equal(list.data.items.length, 2);
  assert.ok(list.data.items[0].at >= list.data.items[1].at, "newest first");
  assert.ok(typeof list.data.items[0].summary === "object");

  const mine = await admin("GET", `/api/admin/audit?userId=${adminId}&method=post`);
  assert.ok(mine.data.items.every((i) => i.userId === adminId && i.method === "POST"));
  assert.ok(mine.data.items.some((i) => i.userName === "initial-admin"));
  const byPath = await admin("GET", "/api/admin/audit?path=/auth/login");
  assert.ok(byPath.data.total >= 1 && byPath.data.items.every((i) => i.path === "/auth/login"));
  const none = await admin("GET", "/api/admin/audit?from=2000-01-01&to=2000-01-02");
  assert.equal(none.data.total, 0);

  for (const call of [opsCall, prov]) {
    const r = await call("GET", "/api/admin/audit");
    assert.equal(r.status, 403, JSON.stringify(r));
  }
});

test.after(async () => {
  await app.close();
});
