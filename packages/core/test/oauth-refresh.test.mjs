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

test("one coalesced caller cancelling does not strand another live caller: both share ONE token-endpoint call", async () => {
  const cred = { accessToken: "at-old", refreshToken: "rt-old", expiresAt: new Date(Date.now() + 60_000).toISOString() };
  const a = account(cred), row = one("SELECT * FROM accounts WHERE id=?", a.id), controller = new AbortController();
  let calls = 0, sawAbort = false;
  const transport = async (_url, init) => { calls++; init.signal.addEventListener("abort", () => { sawAbort = true; }); await sleep(200); return tokenResponse("live"); };
  const first = core.freshCredential(row, true, transport, controller.signal);
  const rejected = assert.rejects(first, { name: "AbortError" });
  const second = core.freshCredential(row, true, async () => { calls += 100; return tokenResponse("second"); });
  await sleep(20);
  controller.abort();
  await rejected;
  assert.equal((await second).refreshToken, "rt-live", "the surviving caller gets the shared refresh's result");
  assert.equal(calls, 1, "the rotating refresh token is sent exactly once");
  assert.equal(sawAbort, false, "the caller's abort never reaches the token-endpoint call");
  assert.equal(one("SELECT COUNT(*) c FROM oauth_refresh_locks WHERE account_id=?", a.id).c, 0);
});

// Review 2026-11-09 B: the upstream rotates the refresh token on receipt. Whenever the caller leaves — before the
// answer, while it is decoded, as sole or coalesced caller — the call finishes and the new pair is stored.
for (const c of [
  { name: "refreshOAuthCredential, abort while the call is in flight", via: "refresh", abortAt: 30 },
  { name: "freshCredential (sole caller), abort while the call is in flight", via: "fresh", abortAt: 30 },
  { name: "freshCredential, abort right after the call started", via: "fresh", abortAt: 0 },
]) {
  test(`client abort cannot lose a rotated token: ${c.name}`, async () => {
    const cred = { accessToken: "at-old", refreshToken: "rt-old", expiresAt: new Date(Date.now() + 60_000).toISOString() };
    const a = account(cred), row = one("SELECT * FROM accounts WHERE id=?", a.id), controller = new AbortController();
    let calls = 0, aborted = false;
    const transport = async (_url, init) => { calls++; init.signal.addEventListener("abort", () => { aborted = true; }); await sleep(150); return tokenResponse(`kept-${a.id}`); };
    const p = c.via === "refresh" ? refreshOAuthCredential(a, cred, transport, controller.signal) : core.freshCredential(row, true, transport, controller.signal);
    const rejected = assert.rejects(p, { name: "AbortError" });
    await sleep(c.abortAt);
    const t0 = Date.now();
    controller.abort();
    await rejected;
    assert.ok(Date.now() - t0 < 100, "the caller's wait ends at once");
    assert.equal(readCredential(one("SELECT credential_enc FROM accounts WHERE id=?", a.id)).refreshToken, "rt-old", "answer not in yet");
    await sleep(300);
    assert.equal(calls, 1);
    assert.equal(aborted, false, "token-endpoint call was not aborted");
    assert.equal(readCredential(one("SELECT credential_enc FROM accounts WHERE id=?", a.id)).refreshToken, `rt-kept-${a.id}`, "rotated pair persisted after the caller left");
    assert.equal(one("SELECT COUNT(*) c FROM oauth_refresh_locks WHERE account_id=?", a.id).c, 0, "lock released by the refresh itself");
    // the next request uses the stored pair; the old refresh token is never replayed
    const again = await core.freshCredential(one("SELECT * FROM accounts WHERE id=?", a.id), false, async () => { calls++; return tokenResponse("replay"); });
    assert.equal(again.refreshToken, `rt-kept-${a.id}`);
    assert.equal(calls, 1);
  });
}

test("the token-endpoint call is bounded by its own timeout only (OAUTH_REFRESH_TIMEOUT_MS), even when the transport ignores its signal", async () => {
  const cred = { accessToken: "at-old", refreshToken: "rt-old", expiresAt: new Date(Date.now() + 60_000).toISOString() };
  const a = account(cred);
  process.env.OAUTH_REFRESH_TIMEOUT_MS = "80";
  const keepAlive = setTimeout(() => {}, 5_000); // AbortSignal.timeout is unref'd: keep the loop alive for the test
  try {
    const t0 = Date.now();
    const r = await refreshOAuthCredential(a, cred, () => new Promise(() => {}));
    assert.equal(r, null);
    assert.ok(Date.now() - t0 < 1000);
    assert.equal(one("SELECT COUNT(*) c FROM oauth_refresh_locks WHERE account_id=?", a.id).c, 0);
  } finally { clearTimeout(keepAlive); delete process.env.OAUTH_REFRESH_TIMEOUT_MS; }
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

test("429 from the token endpoint parks the account: back-off persisted, next refresh skipped without a call, success clears it", async () => {
  const { refreshCooldownUntil, parseRetryAfterMs, REFRESH_429_DEFAULT_COOLDOWN_MS } = core;
  const cred = { accessToken: "at-0", refreshToken: "rt-0", expiresAt: new Date(Date.now() + 60_000).toISOString() };
  const a = account(cred);
  let calls = 0;
  const r1 = await refreshOAuthCredential(a, cred, async () => { calls++; return new Response("rate limited", { status: 429 }); });
  assert.equal(r1, null);
  const until = refreshCooldownUntil(a.id);
  assert.ok(until, "back-off recorded");
  const ms = Date.parse(until) - Date.now();
  assert.ok(ms > REFRESH_429_DEFAULT_COOLDOWN_MS - 5_000 && ms <= REFRESH_429_DEFAULT_COOLDOWN_MS, `default back-off ≈ 10 min, got ${ms}ms`);
  assert.equal(one("SELECT COUNT(*) c FROM oauth_refresh_locks WHERE account_id = ?", a.id).c, 0, "lock released");
  // While parked: no call to the token endpoint from any party.
  const r2 = await refreshOAuthCredential(a, cred, async () => { calls++; return tokenResponse("never"); });
  assert.equal(r2, null);
  assert.equal(calls, 1, "no retry during the back-off");
  // Back-off over: refresh goes through and clears the column.
  run("UPDATE accounts SET refresh_cooldown_until = ? WHERE id = ?", new Date(Date.now() - 1000).toISOString(), a.id);
  const r3 = await refreshOAuthCredential(a, cred, async () => { calls++; return tokenResponse("3"); });
  assert.equal(r3?.accessToken, "at-3");
  assert.equal(one("SELECT refresh_cooldown_until u FROM accounts WHERE id = ?", a.id).u, null, "cleared on success");
  // Retry-After wins over the default and is clamped to [1 min, 2 h].
  const b = account(cred);
  await refreshOAuthCredential(b, cred, async () => new Response("", { status: 429, headers: { "retry-after": "1800" } }));
  const msB = Date.parse(refreshCooldownUntil(b.id)) - Date.now();
  assert.ok(msB > 1_795_000 && msB <= 1_800_000, `Retry-After honoured, got ${msB}ms`);
  const c = account(cred);
  await refreshOAuthCredential(c, cred, async () => new Response("", { status: 429, headers: { "retry-after": "5" } }));
  const msC = Date.parse(refreshCooldownUntil(c.id)) - Date.now();
  assert.ok(msC > 55_000 && msC <= 60_000, `clamped up to 1 min, got ${msC}ms`);
  assert.equal(parseRetryAfterMs("120"), 120_000);
  assert.equal(parseRetryAfterMs(null), null);
  assert.equal(parseRetryAfterMs("garbage"), null);
});

test("refresh token refused by the token endpoint: three spaced refusals of the same token put the account in error (2026-11-11)", async () => {
  const { noteRefreshRejectedForTests, resetRefreshRejectionsForTests, REFRESH_REJECT_SPACING_MS, REFRESH_REJECT_THRESHOLD } = core;
  resetRefreshRejectionsForTests();
  const cred = { accessToken: "at-0", refreshToken: "rt-dead", expiresAt: new Date(Date.now() - 60_000).toISOString() };
  const a = account(cred);
  const status = () => one("SELECT status, error_message FROM accounts WHERE id = ?", a.id);
  const refused = async () => new Response(JSON.stringify({ error: "invalid_grant", error_description: "Refresh token not found or invalid" }), { status: 400 });
  // A burst (every request on an expired account asks for a refresh): one upstream answer, counted once.
  for (let i = 0; i < 5; i++) assert.equal(await refreshOAuthCredential(a, cred, refused), null);
  assert.equal(status().status, "active", "a burst is one hit");
  // Spaced refusals reach the threshold.
  const t0 = Date.now();
  for (let i = 1; i < REFRESH_REJECT_THRESHOLD; i++) noteRefreshRejectedForTests(a.id, cred, 400, "invalid_grant", t0 + i * (REFRESH_REJECT_SPACING_MS + 1));
  const s = status();
  assert.equal(s.status, "error");
  assert.match(s.error_message, /token refresh rejected ×3: HTTP 400/);
  assert.match(s.error_message, /re-authorize/);
});

test("refused refresh: a rotated credential or a success in between never escalates; 5xx is not a refusal", async () => {
  const { noteRefreshRejectedForTests, resetRefreshRejectionsForTests, REFRESH_REJECT_SPACING_MS } = core;
  resetRefreshRejectionsForTests();
  const step = REFRESH_REJECT_SPACING_MS + 1;
  const cred = { accessToken: "at-0", refreshToken: "rt-0", expiresAt: new Date(Date.now() - 60_000).toISOString() };
  const status = (id) => one("SELECT status FROM accounts WHERE id = ?", id).status;
  // Another process rotated the stored credential: refusals of the old token are nobody's verdict.
  const a = account(cred);
  run("UPDATE accounts SET credential_enc = ? WHERE id = ?", encryptJson({ ...cred, accessToken: "at-1", refreshToken: "rt-1" }), a.id);
  for (let i = 0; i < 4; i++) noteRefreshRejectedForTests(a.id, cred, 400, "invalid_grant", Date.now() + i * step);
  assert.equal(status(a.id), "active");
  // Two refusals, then the refresh works: the count starts again.
  const b = account(cred);
  noteRefreshRejectedForTests(b.id, cred, 400, "invalid_grant", Date.now() - 2 * step);
  noteRefreshRejectedForTests(b.id, cred, 400, "invalid_grant", Date.now() - step);
  const next = await refreshOAuthCredential(b, cred, async () => tokenResponse("b1"));
  assert.equal(next?.refreshToken, "rt-b1");
  noteRefreshRejectedForTests(b.id, next, 400, "invalid_grant", Date.now() + step);
  noteRefreshRejectedForTests(b.id, next, 400, "invalid_grant", Date.now() + 2 * step);
  assert.equal(status(b.id), "active", "two hits after a success are below the threshold");
  // A server error says nothing about the grant.
  const c = account(cred);
  for (let i = 0; i < 4; i++) assert.equal(await refreshOAuthCredential(c, cred, async () => new Response("upstream", { status: 503 })), null);
  assert.equal(status(c.id), "active");
});
