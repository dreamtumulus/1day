// Keep-alive refresh pacing (ccr/window-poll.ts, 2026-10-29): one refresh per exit IP per tick,
// nothing while a token-endpoint back-off runs, urgent tokens refreshed regardless.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
const dir = mkdtempSync(join(tmpdir(), "console-keepalive-"));
process.env.DATA_DIR = dir;
process.env.CCR_WINDOW_POLL = "0";
const core = await import("@1dayapi/core");
const { run, one, encryptJson, nowIso } = core;
const { refreshExpiringTokens } = await import("../dist/ccr/window-poll.js");
after(() => { core.db.close(); rmSync(dir, { recursive: true, force: true }); });

run("INSERT INTO users (id, role, name, login_key_hash, login_key_preview, balance_usd) VALUES ('p', 'provider', 'p', 'h', 'p', 0)");
run("INSERT INTO upstream_teams (id, name) VALUES ('team-k', 'k')");
run("INSERT INTO nodes (node_id, provider_id, secret_hash, online, accepting_sessions, created_at) VALUES ('node-k', 'p', 'h', 1, 1, ?)", nowIso());
let n = 0;
function proxy(exitIp) {
  const id = `px-${++n}`;
  run("INSERT INTO node_proxies (id, node_id, url_enc, status, exit_ip, created_at) VALUES (?, 'node-k', 'enc', 'live', ?, ?)", id, exitIp, nowIso());
  return id;
}
function account(expiresInMs, proxyId, extra = {}) {
  const id = `ka-${++n}`;
  const cred = { accessToken: `at-${id}`, refreshToken: `rt-${id}`, expiresAt: new Date(Date.now() + expiresInMs).toISOString() };
  run(
    "INSERT INTO accounts (id, name, platform, type, protocol, base_url, credential_enc, status, review_status, team_id, route, bound_proxy_id, refresh_cooldown_until, created_at, updated_at) VALUES (?, ?, 'anthropic', 'oauth', 'anthropic', 'https://api.anthropic.com', ?, 'active', 'approved', 'team-k', 'direct', ?, ?, ?, ?)",
    id, id, encryptJson(cred), proxyId, extra.cooldownUntil ?? null, nowIso(), nowIso(),
  );
  return id;
}
const calls = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const body = JSON.parse(init.body);
  calls.push(body.refresh_token);
  return new Response(JSON.stringify({ access_token: `new-${body.refresh_token}`, refresh_token: `nrt-${body.refresh_token}`, expires_in: 28800 }), { status: 200 });
};
after(() => { globalThis.fetch = realFetch; });

await test("one refresh per exit IP per tick; urgent and distinct exits go; back-off skipped; next tick takes the deferred one", async () => {
  const ipA = proxy("1.1.1.1"), ipA2 = proxy("1.1.1.1"), ipA3 = proxy("1.1.1.1"), ipB = proxy("2.2.2.2");
  const a1 = account(10 * 60_000, ipA);           // due (15-min margin), exit A
  const a2 = account(10 * 60_000, ipA2);          // due, same exit A → deferred this tick
  const a3 = account(2 * 60_000, ipA3);           // urgent (inside 5-min busy margin), same exit → refreshed anyway
  const b1 = account(10 * 60_000, ipB);           // due, exit B → refreshed
  const c1 = account(10 * 60_000, null, { cooldownUntil: new Date(Date.now() + 5 * 60_000).toISOString() }); // back-off → skipped
  const d1 = account(60 * 60_000, null);          // not due
  const s1 = await refreshExpiringTokens(() => 0);
  assert.deepEqual(s1, { attempted: 3, refreshed: 3, coolingDown: 1, deferredSameExit: 1, deferredBusy: 0 }, JSON.stringify(s1));
  assert.deepEqual(calls.sort(), [`rt-${a1}`, `rt-${a3}`, `rt-${b1}`].sort());
  assert.equal(core.readCredential(one("SELECT credential_enc FROM accounts WHERE id = ?", a2.toString())).refreshToken, `rt-${a2}`, "deferred account untouched");
  assert.equal(core.readCredential(one("SELECT credential_enc FROM accounts WHERE id = ?", c1)).refreshToken, `rt-${c1}`, "parked account untouched");
  assert.equal(core.readCredential(one("SELECT credential_enc FROM accounts WHERE id = ?", d1)).refreshToken, `rt-${d1}`);
  calls.length = 0;
  const s2 = await refreshExpiringTokens(() => 0);
  assert.equal(s2.attempted, 1, JSON.stringify(s2));
  assert.deepEqual(calls, [`rt-${a2}`], "the deferred account is refreshed on the next tick");
});
