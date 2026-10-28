// OAuth refresh (core/oauth.ts, 2026-10-22): a refresh never replays a refresh token that
// another process already rotated, and two refreshers of one account never race.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const dir = mkdtempSync(join(tmpdir(), "1dayapi-core-oauth-"));
process.env.DATA_DIR = dir;
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
const core = await import("../dist/index.js");
const { run, one, encryptJson, readCredential, refreshOAuthCredential, nowIso } = core;

let n = 0;
function account(cred) {
  const id = `acct-${++n}`;
  run(
    "INSERT INTO accounts (id, name, platform, type, protocol, base_url, credential_enc, status, review_status, created_at, updated_at) VALUES (?, ?, 'anthropic', 'oauth', 'anthropic', 'https://api.anthropic.com', ?, 'active', 'approved', ?, ?)",
    id, id, encryptJson(cred), nowIso(), nowIso(),
  );
  return { id, platform: "anthropic" };
}
const tokenResponse = (suffix) => new Response(JSON.stringify({ access_token: `at-${suffix}`, refresh_token: `rt-${suffix}`, expires_in: 28800 }), { status: 200 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("normal refresh: token endpoint called once, new pair persisted", async () => {
  const cred = { accessToken: "at-0", refreshToken: "rt-0", expiresAt: new Date(Date.now() + 60_000).toISOString() };
  const a = account(cred);
  let calls = 0;
  const next = await refreshOAuthCredential(a, cred, async () => { calls++; return tokenResponse("1"); });
  assert.equal(calls, 1);
  assert.equal(next?.accessToken, "at-1");
  assert.equal(readCredential(one("SELECT credential_enc FROM accounts WHERE id = ?", a.id)).refreshToken, "rt-1");
  assert.equal(one("SELECT COUNT(*) c FROM oauth_refresh_locks WHERE account_id = ?", a.id).c, 0, "lock released");
});

test("already rotated by another process: stored credential returned, endpoint never called", async () => {
  const stale = { accessToken: "at-old", refreshToken: "rt-old", expiresAt: new Date(Date.now() + 60_000).toISOString() };
  const a = account(stale);
  // the console keep-alive rotated it after this process loaded its account row
  run("UPDATE accounts SET credential_enc = ? WHERE id = ?", encryptJson({ accessToken: "at-new", refreshToken: "rt-new", expiresAt: new Date(Date.now() + 8 * 3600_000).toISOString() }), a.id);
  let calls = 0;
  const next = await refreshOAuthCredential(a, stale, async () => { calls++; return tokenResponse("x"); });
  assert.equal(calls, 0, "rt-old must never be replayed (Anthropic revokes the grant)");
  assert.equal(next?.accessToken, "at-new");
});

test("concurrent refreshers: the second waits for the first and reuses its result", async () => {
  const cred = { accessToken: "at-0", refreshToken: "rt-0", expiresAt: new Date(Date.now() + 60_000).toISOString() };
  const a = account(cred);
  let calls = 0;
  const slow = async () => { calls++; await sleep(600); return tokenResponse("1"); };
  // simulate another process holding the lock: insert it, then release while the second waits
  run("INSERT INTO oauth_refresh_locks (account_id, locked_until) VALUES (?, ?)", a.id, new Date(Date.now() + 30_000).toISOString());
  const waiter = refreshOAuthCredential(a, cred, slow);
  await sleep(300);
  // the "other process" finishes: writes the new pair and drops the lock
  run("UPDATE accounts SET credential_enc = ? WHERE id = ?", encryptJson({ accessToken: "at-1", refreshToken: "rt-1", expiresAt: new Date(Date.now() + 8 * 3600_000).toISOString() }), a.id);
  run("DELETE FROM oauth_refresh_locks WHERE account_id = ?", a.id);
  const next = await waiter;
  assert.equal(calls, 0, "waiter picked up the other process's result instead of refreshing again");
  assert.equal(next?.refreshToken, "rt-1");
});

test("failed refresh releases the lock and keeps the old credential", async () => {
  const cred = { accessToken: "at-0", refreshToken: "rt-0", expiresAt: new Date(Date.now() + 60_000).toISOString() };
  const a = account(cred);
  const next = await refreshOAuthCredential(a, cred, async () => new Response("nope", { status: 400 }));
  assert.equal(next, null);
  assert.equal(one("SELECT COUNT(*) c FROM oauth_refresh_locks WHERE account_id = ?", a.id).c, 0);
  assert.equal(readCredential(one("SELECT credential_enc FROM accounts WHERE id = ?", a.id)).refreshToken, "rt-0");
});

test("cancelled lock waiter stops promptly and cannot release another owner's lock", async () => {
  const cred = { accessToken: "at-old", refreshToken: "rt-old", expiresAt: new Date(Date.now() + 60_000).toISOString() };
  const a = account(cred), controller = new AbortController();
  run("INSERT INTO oauth_refresh_locks(account_id,locked_until) VALUES (?,?)", a.id, new Date(Date.now() + 30_000).toISOString());
  let calls = 0;
  const started = Date.now();
  const pending = refreshOAuthCredential(a, cred, async () => { calls++; return tokenResponse("unused"); }, controller.signal);
  const rejected = assert.rejects(pending, { name: "AbortError" });
  controller.abort();
  await rejected;
  assert.ok(Date.now() - started < 500);
  assert.equal(calls, 0);
  assert.equal(one("SELECT COUNT(*) c FROM oauth_refresh_locks WHERE account_id=?", a.id).c, 1);
  run("DELETE FROM oauth_refresh_locks WHERE account_id=?", a.id);
});

test("one coalesced caller cancelling does not strand another live caller", async () => {
  const cred = { accessToken: "at-old", refreshToken: "rt-old", expiresAt: new Date(Date.now() + 60_000).toISOString() };
  const a = account(cred), row = one("SELECT * FROM accounts WHERE id=?", a.id), controller = new AbortController();
  const first = core.freshCredential(row, true, (_url, init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true })), controller.signal);
  const rejected = assert.rejects(first, { name: "AbortError" });
  let liveCalls = 0;
  const second = core.freshCredential(row, true, async () => { liveCalls++; return tokenResponse("live"); });
  controller.abort();
  await rejected;
  assert.equal((await second).refreshToken, "rt-live");
  assert.equal(liveCalls, 1);
  assert.equal(one("SELECT COUNT(*) c FROM oauth_refresh_locks WHERE account_id=?", a.id).c, 0);
});

test("a received rotated credential is saved even when cancellation races JSON decoding", async () => {
  const cred = { accessToken: "at-old", refreshToken: "rt-old", expiresAt: new Date(Date.now() + 60_000).toISOString() };
  const a = account(cred), controller = new AbortController();
  await assert.rejects(refreshOAuthCredential(a, cred, async () => ({ ok: true, json: async () => {
    controller.abort();
    return { access_token: "at-new", refresh_token: "rt-new", expires_in: 3600 };
  } }), controller.signal), { name: "AbortError" });
  assert.equal(readCredential(one("SELECT credential_enc FROM accounts WHERE id=?", a.id)).refreshToken, "rt-new");
});
