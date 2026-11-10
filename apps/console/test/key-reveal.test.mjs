// API key reveal hardening (docs/auth.md §3b): a session cookie alone no longer shows a stored key. Reveal needs a
// fresh login (young session) or the login key again, is capped per user per hour, and every reveal / refused
// attempt lands in admin_audit. Runs against a real console app on a temp DATA_DIR.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const dir = mkdtempSync(join(tmpdir(), "1dayapi-key-reveal-"));
process.env.DATA_DIR = dir;
process.env.CCR_WINDOW_POLL = "0";
process.env.KEY_REVEAL_MAX_PER_HOUR = "3";
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));

const { all, one, run, sha256Hex, isoIn } = await import("@1dayapi/core");
const { buildApp } = await import("../dist/app.js");
const { createUser } = await import("../dist/session.js");

const app = await buildApp();
await app.listen({ port: 0, host: "127.0.0.1" });
const BASE = `http://127.0.0.1:${app.server.address().port}`;
test.after(() => app.close());

async function login(key) {
  const r = await fetch(`${BASE}/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key }) });
  assert.equal(r.status, 200);
  const cookie = (r.headers.get("set-cookie") ?? "").split(";")[0];
  const call = async (method, path, body) => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { cookie, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const j = await res.json().catch(() => ({}));
    return { status: res.status, retryAfter: res.headers.get("retry-after"), ...j };
  };
  call.token = cookie.split("=")[1];
  return call;
}

/** Make the caller's session look `minutes` old. */
function ageSession(call, minutes) {
  const changed = run("UPDATE user_sessions SET created_at = ? WHERE token_hash = ?", isoIn(-minutes * 60_000), sha256Hex(call.token)).changes;
  assert.equal(changed, 1);
}

function auditRows(userId) {
  return all("SELECT status, summary, path, ip FROM admin_audit WHERE user_id = ? AND path LIKE '/api/user/keys/%/reveal' ORDER BY rowid", userId).map((r) => ({
    ...r,
    summary: JSON.parse(r.summary),
  }));
}

async function userWithKey(name) {
  const u = createUser("consumer", name);
  const call = await login(u.loginKey);
  const created = await call("POST", "/api/user/keys", { name: `${name}-key` });
  assert.equal(created.status, 201, JSON.stringify(created));
  return { ...u, call, keyId: created.data.id, key: created.data.key };
}

test("fresh session reveals; an old session needs the login key again; every outcome is audited", async () => {
  const u = await userWithKey("reveal-a");

  const fresh = await u.call("POST", `/api/user/keys/${u.keyId}/reveal`);
  assert.equal(fresh.status, 200, JSON.stringify(fresh));
  assert.equal(fresh.data.key, u.key);

  ageSession(u.call, 11);
  const stale = await u.call("POST", `/api/user/keys/${u.keyId}/reveal`);
  assert.equal(stale.status, 403);
  assert.equal(stale.error.code, "reauth_required");
  assert.ok(!JSON.stringify(stale).includes(u.key), "a refused reveal never carries the key");
  // The session itself is still valid for everything else.
  assert.equal((await u.call("GET", "/api/user/keys")).status, 200);

  const wrong = await u.call("POST", `/api/user/keys/${u.keyId}/reveal`, { loginKey: "1dk_consumer_" + "0".repeat(48) });
  assert.equal(wrong.status, 403);
  assert.equal(wrong.error.code, "reauth_failed");

  const again = await u.call("POST", `/api/user/keys/${u.keyId}/reveal`, { loginKey: u.loginKey });
  assert.equal(again.status, 200, JSON.stringify(again));
  assert.equal(again.data.key, u.key);

  const rows = auditRows(u.id);
  assert.deepEqual(rows.map((r) => r.status), [200, 403, 403, 200]);
  assert.deepEqual(rows.map((r) => r.summary.reauth ?? r.summary.error), ["fresh_session", "reauth_required", "reauth_failed", "login_key"]);
  for (const r of rows) {
    assert.equal(r.summary.action, "api_key_reveal");
    assert.equal(r.summary.keyId, u.keyId);
    assert.equal(r.path, `/api/user/keys/${u.keyId}/reveal`);
    assert.ok(r.ip);
    const text = JSON.stringify(r);
    assert.ok(!text.includes(u.key), "the revealed key is not in the audit trail");
    assert.ok(!text.includes(u.loginKey), "the login key is not in the audit trail");
  }
});

test("another user's login key or key id does not work", async () => {
  const a = await userWithKey("reveal-b1");
  const b = await userWithKey("reveal-b2");
  ageSession(a.call, 30);
  const borrowed = await a.call("POST", `/api/user/keys/${a.keyId}/reveal`, { loginKey: b.loginKey });
  assert.equal(borrowed.status, 403);
  assert.equal(borrowed.error.code, "reauth_failed");
  const foreign = await a.call("POST", `/api/user/keys/${b.keyId}/reveal`, { loginKey: a.loginKey });
  assert.equal(foreign.status, 404);
  assert.equal(auditRows(b.id).length, 0);
});

test("per-user hourly cap: reveals are limited, the cap is per user and rolls off after an hour", async () => {
  const u = await userWithKey("reveal-c");
  const other = await userWithKey("reveal-c-other");
  for (let i = 0; i < 3; i++) assert.equal((await u.call("POST", `/api/user/keys/${u.keyId}/reveal`)).status, 200);
  const limited = await u.call("POST", `/api/user/keys/${u.keyId}/reveal`, { loginKey: u.loginKey });
  assert.equal(limited.status, 429);
  assert.equal(limited.error.code, "reveal_rate_limited");
  assert.ok(Number(limited.retryAfter) > 0 && Number(limited.retryAfter) <= 3600, `retry-after: ${limited.retryAfter}`);
  assert.equal(auditRows(u.id).length, 3, "rate-limited calls add no rows");
  assert.equal((await other.call("POST", `/api/user/keys/${other.keyId}/reveal`)).status, 200, "another user is not affected");

  run("UPDATE admin_audit SET at = ? WHERE user_id = ?", isoIn(-3_700_000), u.id);
  assert.equal((await u.call("POST", `/api/user/keys/${u.keyId}/reveal`)).status, 200, "the window rolls");
});

test("refused attempts have their own cap", async () => {
  const u = await userWithKey("reveal-d");
  ageSession(u.call, 60);
  for (let i = 0; i < 3; i++) assert.equal((await u.call("POST", `/api/user/keys/${u.keyId}/reveal`, { loginKey: "nope" })).status, 403);
  const limited = await u.call("POST", `/api/user/keys/${u.keyId}/reveal`, { loginKey: u.loginKey });
  assert.equal(limited.status, 429);
  assert.equal(one("SELECT COUNT(*) AS n FROM admin_audit WHERE user_id = ?", u.id).n, 3);
});

test("a key without key_enc is still not revealable and costs no attempt", async () => {
  const u = await userWithKey("reveal-e");
  run("UPDATE api_keys SET key_enc = NULL WHERE id = ?", u.keyId);
  const r = await u.call("POST", `/api/user/keys/${u.keyId}/reveal`);
  assert.equal(r.status, 400);
  assert.equal(r.error.code, "key_not_revealable");
  assert.equal(auditRows(u.id).length, 0);
});
