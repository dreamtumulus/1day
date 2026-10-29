// Onboarding (docs/onboarding.md §4/§5) end-to-end against a real console app
// on a temp DATA_DIR with ONBOARD_MOCK=1: both methods, auto/manual proxy
// selection, error paths, provider scoping, persistent organization claims and fixed exits.
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const dir = mkdtempSync(join(tmpdir(), "1dayapi-onboard-"));
process.env.DATA_DIR = dir;
process.env.CCR_WINDOW_POLL = "0";
process.env.ALLOW_UNTRUSTED_EXECUTION="1";
process.env.ONBOARD_MOCK = "1";
const TEAM = "11111111-1111-4111-8111-111111111111";
process.env.ONBOARD_MOCK_ORG_UUID = TEAM;
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));

const core = await import("@1dayapi/core");
const { buildApp } = await import("../dist/app.js");
const { createUser } = await import("../dist/session.js");
const { run, one, all } = core;

const app = await buildApp();
await app.listen({ port: 0, host: "127.0.0.1" });
const BASE = `http://127.0.0.1:${app.server.address().port}`;

async function login(key) {
  const r = await fetch(`${BASE}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key }),
  });
  assert.equal(r.status, 200);
  const cookie = (r.headers.get("set-cookie") ?? "").split(";")[0];
  return async (method, path, body) => {
    // These fixtures belong to one known upstream organization. Reusing its measured
    // exit must declare that identity; unknown-organization discovery has its own tests.
    if (method === "POST" && path.endsWith("/accounts/onboard") && body && !body.jobId && body.orgUuid === undefined) body = { ...body, orgUuid: TEAM };
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { cookie, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const j = await res.json().catch(() => ({}));
    return { status: res.status, ...j };
  };
}

async function waitJob(call, prefix, jobId) {
  for (let i = 0; i < 100; i++) {
    const r = await call("GET", `${prefix}/accounts/onboard/${jobId}`);
    if (r.data.status === "done" || r.data.status === "failed") return r.data;
    await new Promise((r2) => setTimeout(r2, 50));
  }
  throw new Error(`job ${jobId} did not finish`);
}

// ---------- fixture ----------

const adminKey = readFileSync(join(dir, "admin-key.txt"), "utf8").trim();
const admin = await login(adminKey);
const provider = createUser("provider", "onboard-provider");
const prov = await login(provider.loginKey);
const other = createUser("provider", "other-provider");

const now = core.nowIso();
const mkNode = (id, providerId, online) =>
  run(
    "INSERT INTO nodes (node_id, provider_id, secret_hash, online, accepting_sessions, created_at) VALUES (?, ?, 'h', ?, 1, ?)",
    id,
    providerId,
    online,
    now,
  );
mkNode("node-prov", provider.id, 1); // provider's online node
const adminUser = one("SELECT id FROM users WHERE role='admin' LIMIT 1");
mkNode("node-plat", adminUser.id, 1); // platform node (owned by an admin)
mkNode("node-off", adminUser.id, 0); // offline node
mkNode("node-other", other.id, 1); // another provider's node

const { replaceNodeProxies, recordNodeProxyExit, proxyOccupancy, proxyCoolingUntil } = await import("../dist/node/proxies.js");
replaceNodeProxies("node-prov", [
  { url: "http://u:p@10.1.0.1:8001", label: "old" },
  { url: "http://u:p@10.1.0.2:8002", label: "new" },
  { url: "http://u:p@10.1.0.3:8003", label: "dead" },
]);
replaceNodeProxies("node-plat", [{ url: "http://u:p@10.2.0.1:8001", label: "plat" }]);
const pid = (url) => core.sha256Hex(url).slice(0, 12);
const [pOld, pNew, pDead] = [pid("http://u:p@10.1.0.1:8001"), pid("http://u:p@10.1.0.2:8002"), pid("http://u:p@10.1.0.3:8003")];
run("UPDATE node_proxies SET status='live', last_check_at=? WHERE id=?", "2026-10-14T00:00:00Z", pOld);
run("UPDATE node_proxies SET status='live', last_check_at=? WHERE id=?", "2026-10-15T00:00:00Z", pNew);
run("UPDATE node_proxies SET status='dead', last_check_at=? WHERE id=?", "2026-10-15T01:00:00Z", pDead);
run("UPDATE node_proxies SET status='live', last_check_at=? WHERE node_id='node-plat'", "2026-10-15T00:00:00Z");
for (const [id, ip] of [[pOld, "198.51.100.1"], [pNew, "198.51.100.2"], [pDead, "198.51.100.3"]]) assert.equal(recordNodeProxyExit("node-prov", id, ip), true);
const platId = one("SELECT id FROM node_proxies WHERE node_id='node-plat'").id;
assert.equal(recordNodeProxyExit("node-plat", platId, "198.51.100.10"), true);


// ---------- admin: session_key with auto proxy ----------

let accId;
await test("session_key + auto proxy: job completes, account bound to oldest-checked live proxy", async () => {
  const r = await admin("POST", "/api/admin/accounts/onboard", {
    method: "session_key",
    sessionKey: "sk-ant-sid-test",
    nodeId: "node-plat",
    concurrencyLimit: 2,
    rpmLimit: 30,
    name: "onboarded-1",
  });
  assert.equal(r.status, 200, JSON.stringify(r));
  assert.equal(r.data.status, "working");
  const done = await waitJob(admin, "/api/admin", r.data.jobId);
  assert.equal(done.status, "done", JSON.stringify(done));
  accId = done.accountId;
  const a = one("SELECT * FROM accounts WHERE id = ?", accId);
  assert.equal(a.platform, "anthropic");
  assert.equal(a.type, "oauth");
  assert.equal(a.executor, "ccr_worker");
  assert.equal(a.route, "node");
  assert.equal(a.node_id, "node-plat");
  assert.equal(a.review_status, "approved");
  assert.equal(a.owner_id, null);
  assert.equal(a.base_url, "https://api.anthropic.com");
  assert.equal(a.concurrency, 2);
  assert.equal(a.rpm_limit, 30);
  const platProxy = one("SELECT id FROM node_proxies WHERE node_id='node-plat'");
  assert.equal(a.bound_proxy_id, platProxy.id);
  assert.equal(one("SELECT COUNT(*) AS n FROM accounts WHERE bound_proxy_id=?", platProxy.id).n, 1);
  assert.equal(one("SELECT team_id FROM node_proxies WHERE id=?", platProxy.id).team_id, TEAM);
  const cred = core.readCredential(a);
  assert.match(cred.accessToken, /^sk-ant-oat-mock-/);
  assert.equal(cred.orgUuid, TEAM);
  assert.equal(a.team_id, TEAM);
  assert.match(cred.accountId, /^acct_mock_/);
  assert.ok(one("SELECT 1 FROM account_groups WHERE account_id = ? AND group_id = 'default'", accId), "admin account lands in default group");
  // 新号冷静期 (docs/onboarding.md §1 原则 7): 62–70 min out of scheduling, shown as onboard_cooldown.
  const cdMs = Date.parse(a.temp_unschedulable_until) - Date.parse(a.created_at);
  assert.ok(cdMs >= 62 * 60_000 - 2000 && cdMs <= 70 * 60_000 + 2000, `cooldown ${cdMs}ms should be 62–70 min`);
  assert.match(a.error_message, /^onboard_cooldown: /);
  assert.equal(done.cooldownUntil, a.temp_unschedulable_until, "job result carries cooldownUntil");
  assert.ok(!core.listCandidates("default", "claude-opus-5-5").some((c) => c.id === accId), "not schedulable during the cooldown");
  run("UPDATE accounts SET temp_unschedulable_until = NULL WHERE id = ?", accId);
  assert.ok(core.listCandidates("default", "claude-opus-5-5").some((c) => c.id === accId), "schedulable once the cooldown passed");
  assert.equal(one("SELECT payload_enc FROM onboarding_jobs WHERE id = ?", r.data.jobId).payload_enc, null, "sessionKey cleared");
});

await test("auto picks the live proxy whose last_check_at is oldest", async () => {
  const r = await admin("POST", "/api/admin/accounts/onboard", { method: "session_key", sessionKey: "s", nodeId: "node-prov" });
  assert.equal(r.status, 200, JSON.stringify(r));
  const done = await waitJob(admin, "/api/admin", r.data.jobId);
  assert.equal(done.status, "done", JSON.stringify(done));
  const a = one("SELECT * FROM accounts WHERE id = ?", done.accountId);
  assert.equal(a.bound_proxy_id, pOld, "oldest-probed free proxy wins over the fresher one");
  assert.equal(a.owner_id, provider.id, "a provider's node carries provider-owned accounts, whoever onboarded them (same rule as POST /api/admin/accounts)");
  assert.equal(a.review_status, "approved", "admin-onboarded accounts need no review");
  assert.ok(one("SELECT 1 FROM account_groups WHERE account_id = ? AND group_id = 'default'", a.id), "no onboard group set on the provider → requested/default group");
  run("UPDATE node_proxies SET bound_account_id = NULL WHERE id = ?", pOld);
  run("DELETE FROM accounts WHERE id = ?", a.id);
});

await test("admin onboarding onto a provider's node lands in that provider's onboard group (docs/onboarding.md §1 原则 5, 2026-10-29)", async () => {
  run("INSERT INTO groups (id, name, rate_multiplier, is_exclusive) VALUES ('selfuse', 'selfuse', 0, 1)");
  run("UPDATE users SET onboard_group_id = 'selfuse' WHERE id = ?", provider.id);
  try {
    const r = await admin("POST", "/api/admin/accounts/onboard", { method: "session_key", sessionKey: "s", nodeId: "node-prov", groupId: "default" });
    assert.equal(r.status, 200, JSON.stringify(r));
    const done = await waitJob(admin, "/api/admin", r.data.jobId);
    assert.equal(done.status, "done", JSON.stringify(done));
    const a = one("SELECT * FROM accounts WHERE id = ?", done.accountId);
    assert.equal(a.owner_id, provider.id);
    assert.deepEqual(all("SELECT group_id FROM account_groups WHERE account_id = ?", a.id).map((g) => g.group_id), ["selfuse"], "the owner's onboard group wins over the requested group");
    run("UPDATE node_proxies SET bound_account_id = NULL WHERE id = ?", a.bound_proxy_id);
    run("DELETE FROM account_groups WHERE account_id = ?", a.id);
    run("DELETE FROM accounts WHERE id = ?", a.id);
  } finally {
    run("UPDATE users SET onboard_group_id = NULL WHERE id = ?", provider.id);
    run("DELETE FROM groups WHERE id = 'selfuse'");
  }
});

await test("error paths: empty capacity / maximum-three slots / node_offline", async () => {
  mkNode("node-empty", adminUser.id, 1);
  let r = await admin("POST", "/api/admin/accounts/onboard", { method: "session_key", sessionKey: "s", nodeId: "node-empty" });
  assert.equal(r.error?.code, "proxy_pool_empty", JSON.stringify(r));

  const boundProxy = one("SELECT id FROM node_proxies WHERE node_id='node-plat'");
  // A shared organization exit normally serves two accounts, with a third only
  // when this node has no remaining normal-capacity exit. It is not single-bound.
  const extraAccounts = [];
  for (let slot = 2; slot <= 3; slot++) {
    r = await admin("POST", "/api/admin/accounts/onboard", { method: "session_key", sessionKey: `slot-${slot}`, nodeId: "node-plat", proxyId: boundProxy.id });
    assert.equal(r.status, 200, JSON.stringify(r));
    const done = await waitJob(admin, "/api/admin", r.data.jobId);
    assert.equal(done.status, "done", JSON.stringify(done));
    extraAccounts.push(done.accountId);
  }
  r = await admin("POST", "/api/admin/accounts/onboard", { method: "session_key", sessionKey: "fourth", nodeId: "node-plat", proxyId: boundProxy.id });
  assert.equal(r.error?.code, "proxy_pool_empty", JSON.stringify(r));
  for (const id of extraAccounts) assert.equal((await admin("DELETE", `/api/admin/accounts/${id}`)).data.ok, true);

  r = await admin("POST", "/api/admin/accounts/onboard", { method: "session_key", sessionKey: "s", nodeId: "node-off" });
  assert.equal(r.error?.code, "node_offline", JSON.stringify(r));

  // orgUuid is validated before any proxy is reserved.
  r = await admin("POST", "/api/admin/accounts/onboard", { method: "session_key", sessionKey: "s", nodeId: "node-prov", orgUuid: "not-a-uuid" });
  assert.equal(r.status, 400);
  assert.equal(r.error?.code, "invalid_request", JSON.stringify(r));
  assert.equal(one("SELECT COUNT(*) AS n FROM onboarding_jobs WHERE status IN ('working','pending_callback')").n, 0, "rejected orgUuid reserves nothing");

  r = await admin("POST", "/api/admin/accounts/onboard", { method: "session_key", sessionKey: "s", nodeId: "node-prov", proxyId: pDead });
  assert.equal(r.error?.code, "proxy_pool_empty", "manual pick of a dead proxy");

});

// ---------- admin: auth_url two-step ----------

await test("auth_url: pending_callback, state validation, callback completes the account", async () => {
  const r1 = await admin("POST", "/api/admin/accounts/onboard", { method: "auth_url", nodeId: "node-prov", proxyId: pNew });
  assert.equal(r1.status, 200, JSON.stringify(r1));
  assert.equal(r1.data.status, "pending_callback");
  const url = new URL(r1.data.authorizeUrl);
  assert.equal(url.searchParams.get("client_id"), "9d1c250a-e61b-44d9-88ed-5944d1962f5e");
  assert.equal(url.searchParams.get("redirect_uri"), "https://platform.claude.com/oauth/code/callback");
  assert.equal(url.searchParams.get("scope"), core.CCR.authorize.scopes);
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  const state = url.searchParams.get("state");
  assert.ok(state && url.searchParams.get("code_challenge"));

  const badCb = await admin("POST", "/api/admin/accounts/onboard", {
    method: "auth_url",
    jobId: r1.data.jobId,
    callbackUrl: `https://platform.claude.com/oauth/code/callback?code=x&state=wrong`,
  });
  assert.equal(badCb.error?.code, "callback_invalid", JSON.stringify(badCb));
  const garbage = await admin("POST", "/api/admin/accounts/onboard", { method: "auth_url", jobId: r1.data.jobId, callbackUrl: "not a url" });
  assert.equal(garbage.error?.code, "callback_invalid");

  const ok = await admin("POST", "/api/admin/accounts/onboard", {
    method: "auth_url",
    jobId: r1.data.jobId,
    callbackUrl: `https://platform.claude.com/oauth/code/callback?code=fake_code&state=${state}`,
  });
  assert.equal(ok.data?.status, "working", JSON.stringify(ok));
  const done = await waitJob(admin, "/api/admin", r1.data.jobId);
  assert.equal(done.status, "done", JSON.stringify(done));
  const a = one("SELECT * FROM accounts WHERE id = ?", done.accountId);
  assert.equal(a.bound_proxy_id, pNew);
  assert.equal(one("SELECT payload_enc FROM onboarding_jobs WHERE id = ?", r1.data.jobId).payload_enc, null, "PKCE material cleared");
});

// ---------- proxy picker lists ----------

await test("proxy picker: masked shape, live measured exits with remaining capacity, oldest first", async () => {
  const r = await admin("GET", "/api/admin/nodes/node-prov/proxies?free=1");
  assert.equal(r.status, 200);
  assert.equal(r.data.length, 2, "pOld empty, pNew has one of up to three slots, pDead dead");
  assert.equal(r.data[0].id, pOld);
  assert.equal(r.data[0].host, "10.1.0.1");
  assert.equal(r.data[0].port, 8001);
  assert.equal(r.data[0].label, "old");
  assert.ok(!("url" in r.data[0]), "no URL (credentials) in the picker shape");
});

// ---------- provider scope ----------

await test("provider scope: own node only; approved on the spot into the provider's onboarding group, no cooldown (2026-10-26)", async () => {
  // PATCH /users/:id {onboardGroupId}: provider only, group must exist.
  run("INSERT INTO groups (id, name) VALUES ('g-prov', 'g-prov')");
  const consumer = createUser("consumer", "onboard-consumer");
  assert.equal((await admin("PATCH", `/api/admin/users/${consumer.id}`, { onboardGroupId: "g-prov" })).status, 400, "consumers have no onboarding group");
  assert.equal((await admin("PATCH", `/api/admin/users/${provider.id}`, { onboardGroupId: "no-such-group" })).status, 404);
  const set = await admin("PATCH", `/api/admin/users/${provider.id}`, { onboardGroupId: "g-prov" });
  assert.equal(set.status, 200, JSON.stringify(set));
  assert.equal(set.data.onboardGroupId, "g-prov");
  const denied = await prov("POST", "/api/provider/accounts/onboard", { method: "session_key", sessionKey: "s", nodeId: "node-other" });
  assert.equal(denied.status, 404, "other provider's node is invisible");
  const deniedList = await prov("GET", "/api/provider/nodes/node-other/proxies?free=1");
  assert.equal(deniedList.status, 404);
  const list = await prov("GET", "/api/provider/nodes/node-prov/proxies?free=1");
  assert.equal(list.status, 200);
  assert.equal(list.data.length, 2);

  const r = await prov("POST", "/api/provider/accounts/onboard", { method: "session_key", sessionKey: "s", nodeId: "node-prov" });
  assert.equal(r.status, 200, JSON.stringify(r));
  const done = await waitJob(prov, "/api/provider", r.data.jobId);
  assert.equal(done.status, "done", JSON.stringify(done));
  const a = one("SELECT * FROM accounts WHERE id = ?", done.accountId);
  assert.equal(a.owner_id, provider.id);
  assert.equal(a.review_status, "approved", "no admin review for provider onboarding (user rule 2026-10-26)");
  assert.equal(a.status, "active");
  assert.equal(a.bound_proxy_id, pOld, "spread first (2026-10-29): the empty exit before doubling up on the one-account exit");
  assert.equal(a.temp_unschedulable_until, null, "no onboarding cooldown for provider onboarding");
  assert.equal(a.error_message, null);
  assert.equal(done.cooldownUntil, undefined);
  assert.equal(a.payout_rate, Number(core.getSetting("provider_default_payout_rate")), "default payout, as admin review used to set");
  assert.deepEqual(core.all("SELECT group_id FROM account_groups WHERE account_id = ?", a.id).map((g) => g.group_id), ["g-prov"], "joins the provider's onboarding group");

  // No onboarding group set → the default group.
  run("UPDATE node_proxies SET bound_account_id = NULL WHERE id = ?", a.bound_proxy_id);
  run("DELETE FROM accounts WHERE id = ?", a.id);
  const unset = await admin("PATCH", `/api/admin/users/${provider.id}`, { onboardGroupId: null });
  assert.equal(unset.data.onboardGroupId, null);
  const r2 = await prov("POST", "/api/provider/accounts/onboard", { method: "session_key", sessionKey: "s", nodeId: "node-prov" });
  const done2 = await waitJob(prov, "/api/provider", r2.data.jobId);
  assert.equal(done2.status, "done", JSON.stringify(done2));
  assert.deepEqual(core.all("SELECT group_id FROM account_groups WHERE account_id = ?", done2.accountId).map((g) => g.group_id), [core.getSetting("default_group_id")]);

  const foreign = await prov("GET", "/api/admin/accounts/onboard/x");
  assert.equal(foreign.status, 403, "provider cannot use admin prefix");
});

// ---------- delete releases the proxy ----------

await test("deleting isolated accounts frees capacity but permanently retains organization ownership; cooldown gates still apply", async () => {
  const provAcc = one("SELECT id, bound_proxy_id FROM accounts WHERE owner_id = ?", provider.id);
  const beforeCount = one("SELECT COUNT(*) AS n FROM accounts WHERE bound_proxy_id=?", provAcc.bound_proxy_id).n;
  const d = await prov("DELETE", `/api/provider/accounts/${provAcc.id}`);
  assert.equal(d.data?.ok, true);
  assert.equal(one("SELECT COUNT(*) AS n FROM accounts WHERE bound_proxy_id=?", provAcc.bound_proxy_id).n, beforeCount - 1);
  const owned = one("SELECT team_id,resource_key,cooldown_until FROM node_proxies WHERE id=?", provAcc.bound_proxy_id);
  assert.equal(owned.team_id, TEAM);
  assert.equal(one("SELECT team_id FROM proxy_team_claims WHERE resource_key=?", owned.resource_key).team_id, TEAM);
  assert.equal(owned.cooldown_until, null);

  run("UPDATE accounts SET status = 'error', error_message = 'upstream 401: OAuth access token has been revoked.' WHERE id = ?", accId);
  const adminAcc = one("SELECT id,bound_proxy_id FROM accounts WHERE id=?", accId);
  assert.equal((await admin("DELETE", `/api/admin/accounts/${accId}`)).data?.ok, true);
  const fixed = one("SELECT * FROM node_proxies WHERE id=?", adminAcc.bound_proxy_id);
  assert.equal(fixed.team_id, TEAM, "an error/deletion cannot make a team's IP virgin");
  assert.equal(fixed.cooldown_until, null, "new isolated account deletion releases a slot, not IP ownership");
  assert.ok(one("SELECT 1 FROM proxy_team_events WHERE proxy_id=? AND account_id=? AND event='account_released'", fixed.id, accId));

  // Preserve the existing legacy 24-hour error-release behavior as well. Legacy
  // rows remain unmanaged; testing their old release policy must not backfill team.
  const legacyId = core.newId();
  const legacyProxy = `legacy-${legacyId}`;
  run("INSERT INTO node_proxies(id,node_id,url_enc,status,isolation_version) VALUES (?,'node-plat',?,'live',0)", legacyProxy, core.encryptString("http://legacy:test@10.9.0.1:8099"));
  run("INSERT INTO accounts(id,name,platform,type,protocol,credential_enc,route,node_id,bound_proxy_id,status,error_message) VALUES (?,'legacy-delete','anthropic','oauth','anthropic',?,'node','node-plat',?,'error','upstream 401: revoked')", legacyId, core.encryptJson({ accessToken: "legacy-token" }), legacyProxy);
  run("UPDATE node_proxies SET bound_account_id=? WHERE id=?", legacyId, legacyProxy);
  assert.equal((await admin("DELETE", `/api/admin/accounts/${legacyId}`)).data?.ok, true);
  const legacyReleased = one("SELECT * FROM node_proxies WHERE id=?", legacyProxy);
  assert.equal(legacyReleased.bound_account_id, null);
  assert.equal(legacyReleased.team_id, null);
  const releaseMs = Date.parse(legacyReleased.cooldown_until) - Date.now();
  assert.ok(releaseMs > 23.9 * 3_600_000 && releaseMs <= 24 * 3_600_000);
  assert.match(legacyReleased.cooldown_reason, /401/);

  // Existing cooldown state still blocks auto selection, explicit selection and
  // the picker; modern ownership and cooldown are independent properties.
  const cooldown = core.isoIn(24 * 3_600_000);
  run("UPDATE node_proxies SET cooldown_until=?,cooldown_reason='legacy release cooldown' WHERE id=?", cooldown, fixed.id);
  assert.equal(proxyCoolingUntil(fixed.id), cooldown);
  const auto = await admin("POST", "/api/admin/accounts/onboard", { method: "session_key", sessionKey: "s", nodeId: "node-plat" });
  assert.equal(auto.status, 400, JSON.stringify(auto));
  assert.equal(auto.error?.code, "proxy_pool_empty");
  const explicit = await admin("POST", "/api/admin/accounts/onboard", { method: "session_key", sessionKey: "s", nodeId: "node-plat", proxyId: fixed.id });
  assert.equal(explicit.status, 400, JSON.stringify(explicit));
  assert.equal(explicit.error?.code, "proxy_pool_empty");
  assert.equal((await admin("GET", "/api/admin/nodes/node-plat/proxies?free=1")).data.length, 0);
  assert.equal((await admin("GET", "/api/admin/nodes/node-plat/proxies")).data.find((p) => p.id === fixed.id).cooldownUntil, cooldown);
  run("UPDATE node_proxies SET cooldown_until=? WHERE id=?", "2020-01-01T00:00:00Z", fixed.id);
  const again = await admin("POST", "/api/admin/accounts/onboard", { method: "session_key", sessionKey: "s", nodeId: "node-plat" });
  assert.equal(again.status, 200, JSON.stringify(again));
  assert.equal((await waitJob(admin, "/api/admin", again.data.jobId)).status, "done");
  assert.equal(one("SELECT team_id FROM node_proxies WHERE id=?", fixed.id).team_id, TEAM);
});

// ---------- duplicate onboarding (2026-10-20) + in-place re-authorization (2026-10-22, docs/onboarding.md §11) ----------

await test("same underlying Claude account again: healthy row refused untouched; revoked row re-authorized in place", async () => {
  process.env.ONBOARD_MOCK_ACCOUNT_UUID = "acct_mock_dup";
  // Two free live proxies on node-prov: one for the first job, one reserved by the later ones.
  run("UPDATE node_proxies SET bound_account_id = NULL WHERE node_id = 'node-prov'");
  try {
    const first = await admin("POST", "/api/admin/accounts/onboard", { method: "session_key", sessionKey: "s", nodeId: "node-prov", proxyId: pOld, name: "dup-1" });
    assert.equal(first.status, 200, JSON.stringify(first));
    const d1 = await waitJob(admin, "/api/admin", first.data.jobId);
    assert.equal(d1.status, "done", JSON.stringify(d1));
    run("UPDATE accounts SET temp_unschedulable_until = NULL, error_message = NULL WHERE id = ?", d1.accountId); // past the onboarding cooldown
    const before = one("SELECT * FROM accounts WHERE id = ?", d1.accountId);
    assert.ok(before.bound_proxy_id, "first onboarding bound a proxy");
    const occupiedAfterFirst = core.all("SELECT id FROM accounts WHERE node_id='node-prov' AND bound_proxy_id IS NOT NULL").length;

    // Healthy (active) row: refused, nothing touched.
    const second = await admin("POST", "/api/admin/accounts/onboard", { method: "session_key", sessionKey: "s2", nodeId: "node-prov", name: "dup-2" });
    assert.equal(second.status, 200, JSON.stringify(second));
    const d2 = await waitJob(admin, "/api/admin", second.data.jobId);
    assert.equal(d2.status, "failed", JSON.stringify(d2));
    assert.match(d2.error, /^account_exists: /);
    assert.match(d2.error, /mock@example\.com/);
    assert.equal(d2.accountId, undefined, "failed job points at no account");
    assert.deepEqual({ ...one("SELECT * FROM accounts WHERE id = ?", d1.accountId) }, { ...before }, "active row not replaced");
    assert.equal(one("SELECT COUNT(*) AS n FROM accounts WHERE name IN ('dup-1','dup-2')").n, 1, "no second row inserted");
    assert.equal(core.all("SELECT id FROM accounts WHERE node_id='node-prov' AND bound_proxy_id IS NOT NULL").length, occupiedAfterFirst, "the refused job did not consume its reserved proxy");

    // Revoked row (upstream 401) with cooldowns and a custom priority: the same
    // account onboarded again is re-authorized in place.
    run(
      "UPDATE accounts SET status = 'error', error_message = 'upstream 401: OAuth access token has been revoked.', rate_limited_until = '2099-01-01T00:00:00.000Z', temp_unschedulable_until = '2099-01-01T00:00:00.000Z', priority = 7 WHERE id = ?",
      d1.accountId,
    );
    const third = await admin("POST", "/api/admin/accounts/onboard", { method: "session_key", sessionKey: "s3", nodeId: "node-prov", proxyId: before.bound_proxy_id, name: "dup-3" });
    assert.equal(third.status, 200, JSON.stringify(third));
    const d3 = await waitJob(admin, "/api/admin", third.data.jobId);
    assert.equal(d3.status, "done", JSON.stringify(d3));
    assert.equal(d3.accountId, d1.accountId, "job ends in the existing row");
    assert.equal(d3.reused, true, "flagged as re-authorization, nothing new added");
    assert.equal(d3.cooldownUntil, undefined, "no onboarding cooldown on a re-login");
    const after = one("SELECT * FROM accounts WHERE id = ?", d1.accountId);
    assert.equal(after.status, "active");
    assert.equal(after.error_message, null);
    assert.equal(after.rate_limited_until, null);
    assert.equal(after.temp_unschedulable_until, null);
    assert.equal(after.priority, 7, "priority kept");
    assert.equal(after.name, "dup-1", "name kept");
    assert.equal(after.owner_id, before.owner_id, "owner kept");
    assert.equal(after.bound_proxy_id, before.bound_proxy_id, "live proxy binding kept");
    assert.notEqual(core.readCredential(after).accessToken, core.readCredential(before).accessToken, "credential replaced");
    assert.equal(one("SELECT COUNT(*) AS n FROM accounts WHERE name LIKE 'dup-%'").n, 1, "still one row");
    assert.equal(one("SELECT COUNT(*) AS n FROM account_groups WHERE account_id = ?", d1.accountId).n, 1, "groups kept");
    assert.equal(core.all("SELECT id FROM accounts WHERE node_id='node-prov' AND bound_proxy_id IS NOT NULL").length, occupiedAfterFirst, "the reserved proxy was not consumed either");

    // Revoked row owned by someone else: still refused (never re-key another party's account).
    run("UPDATE accounts SET status = 'error', error_message = 'revoked', owner_id = ? WHERE id = ?", other.id, d1.accountId);
    const fourth = await admin("POST", "/api/admin/accounts/onboard", { method: "session_key", sessionKey: "s4", nodeId: "node-prov", name: "dup-4" });
    const d4 = await waitJob(admin, "/api/admin", fourth.data.jobId);
    assert.equal(d4.status, "failed", JSON.stringify(d4));
    assert.match(d4.error, /^account_exists: /);
    assert.equal(one("SELECT status FROM accounts WHERE id = ?", d1.accountId).status, "error", "foreign row untouched");

    run("UPDATE node_proxies SET bound_account_id = NULL WHERE bound_account_id = ?", d1.accountId);
    run("DELETE FROM accounts WHERE id = ?", d1.accountId);
  } finally {
    delete process.env.ONBOARD_MOCK_ACCOUNT_UUID;
  }
});

await test("POST /accounts/:id/reauth: pinned to the account's proxy, identity checked, ops role allowed", async () => {
  process.env.ONBOARD_MOCK_ACCOUNT_UUID = "acct_mock_re";
  run("UPDATE node_proxies SET bound_account_id = NULL, status = 'live', cooldown_until = NULL WHERE node_id = 'node-prov' AND id <> ?", pDead);
  const opsUser = createUser("ops", "ops-1");
  const ops = await login(opsUser.loginKey);
  try {
    const first = await admin("POST", "/api/admin/accounts/onboard", { method: "session_key", sessionKey: "s", nodeId: "node-prov", name: "re-1" });
    const d1 = await waitJob(admin, "/api/admin", first.data.jobId);
    assert.equal(d1.status, "done", JSON.stringify(d1));
    const id = d1.accountId;
    const row0 = one("SELECT * FROM accounts WHERE id = ?", id);

    // Active account: refused (a fresh grant must not race live sessions).
    let r = await admin("POST", `/api/admin/accounts/${id}/reauth`, { method: "session_key", sessionKey: "s" });
    assert.equal(r.status, 400, JSON.stringify(r));
    assert.equal(r.error?.code, "account_active");

    // Revoked: the authorized identity must be this account.
    run("UPDATE accounts SET status = 'error', error_message = 'upstream 401: revoked', temp_unschedulable_until = NULL WHERE id = ?", id);
    process.env.ONBOARD_MOCK_ACCOUNT_UUID = "acct_mock_someone_else";
    r = await admin("POST", `/api/admin/accounts/${id}/reauth`, { method: "session_key", sessionKey: "s" });
    assert.equal(r.status, 200, JSON.stringify(r));
    let job = one("SELECT * FROM onboarding_jobs WHERE id = ?", r.data.jobId);
    assert.equal(job.proxy_id, row0.bound_proxy_id, "job pinned to the account's own (live) proxy");
    assert.equal(job.node_id, row0.node_id);
    let done = await waitJob(admin, "/api/admin", r.data.jobId);
    assert.equal(done.status, "failed", JSON.stringify(done));
    assert.match(done.error, /^account_mismatch: /);
    assert.equal(one("SELECT status FROM accounts WHERE id = ?", id).status, "error", "mismatch leaves the row alone");

    // Non-admin job errors retain a useful code without disclosing the other
    // account's email/UUID or the organization's internal identity.
    r = await ops("POST", `/api/admin/accounts/${id}/reauth`, { method: "session_key", sessionKey: "s" });
    assert.equal(r.status, 200, JSON.stringify(r));
    const privateError = await waitJob(ops, "/api/admin", r.data.jobId);
    assert.equal(privateError.status, "failed");
    assert.match(privateError.error, /^account_mismatch:/);
    assert.ok(!privateError.error.includes("mock@example.com") && !privateError.error.includes("acct_mock_someone_else") && !privateError.error.includes(TEAM));

    // Same identity, done by the ops role.
    process.env.ONBOARD_MOCK_ACCOUNT_UUID = "acct_mock_re";
    r = await ops("POST", `/api/admin/accounts/${id}/reauth`, { method: "session_key", sessionKey: "s" });
    assert.equal(r.status, 200, JSON.stringify(r));
    done = await waitJob(ops, "/api/admin", r.data.jobId);
    assert.equal(done.status, "done", JSON.stringify(done));
    assert.equal(done.accountId, id);
    assert.equal(done.reused, true);
    let row = one("SELECT * FROM accounts WHERE id = ?", id);
    assert.equal(row.status, "active");
    assert.equal(row.error_message, null);
    assert.equal(row.bound_proxy_id, row0.bound_proxy_id, "proxy binding kept");
    assert.notEqual(core.readCredential(row).accessToken, core.readCredential(row0).accessToken, "credential replaced");
    assert.equal(one("SELECT payload_enc FROM onboarding_jobs WHERE id = ?", r.data.jobId).payload_enc, null, "sessionKey cleared");

    // auth_url through the re-auth endpoint (two steps, the second one scoped to this account).
    run("UPDATE accounts SET status = 'error', error_message = 'revoked' WHERE id = ?", id);
    const r1 = await ops("POST", `/api/admin/accounts/${id}/reauth`, { method: "auth_url" });
    assert.equal(r1.data?.status, "pending_callback", JSON.stringify(r1));
    const state = new URL(r1.data.authorizeUrl).searchParams.get("state");
    const wrongAcc = await ops("POST", `/api/admin/accounts/${row0.id}x/reauth`, { method: "auth_url", jobId: r1.data.jobId, callbackUrl: `x#${state}` });
    assert.equal(wrongAcc.status, 404, "job is bound to its account");
    const ok = await ops("POST", `/api/admin/accounts/${id}/reauth`, { method: "auth_url", jobId: r1.data.jobId, callbackUrl: `https://platform.claude.com/oauth/code/callback?code=fake_code&state=${state}` });
    assert.equal(ok.data?.status, "working", JSON.stringify(ok));
    done = await waitJob(ops, "/api/admin", r1.data.jobId);
    assert.equal(done.status, "done", JSON.stringify(done));
    assert.equal(one("SELECT status FROM accounts WHERE id = ?", id).status, "active");

    // A dead exit cannot silently move this account to another IP.
    run("UPDATE accounts SET status='error',error_message='revoked' WHERE id=?", id);
    run("UPDATE node_proxies SET status='dead' WHERE id=?", row0.bound_proxy_id);
    r = await ops("POST", `/api/admin/accounts/${id}/reauth`, { method: "session_key", sessionKey: "s" });
    assert.equal(r.status, 400, JSON.stringify(r));
    assert.equal(r.error?.code, "fixed_proxy_unavailable");
    row = one("SELECT * FROM accounts WHERE id=?", id);
    assert.equal(row.bound_proxy_id, row0.bound_proxy_id, "the fixed proxy binding survives failure");
    assert.equal(row.status, "error");
    assert.equal(one("SELECT team_id FROM node_proxies WHERE id=?", row0.bound_proxy_id).team_id, TEAM);
    run("UPDATE node_proxies SET status='live' WHERE id=?", row0.bound_proxy_id);

    // Not a subscription account / unknown id.
    const apiAcc = core.newId();
    run("INSERT INTO accounts (id, name, platform, type, protocol, credential_enc, status, created_at, updated_at) VALUES (?, 'relay', 'openai', 'upstream', 'openai', ?, 'error', ?, ?)", apiAcc, core.encryptJson({ apiKey: "k" }), now, now);
    r = await ops("POST", `/api/admin/accounts/${apiAcc}/reauth`, { method: "session_key", sessionKey: "s" });
    assert.equal(r.status, 400);
    assert.equal((await ops("POST", `/api/admin/accounts/nope/reauth`, { method: "session_key", sessionKey: "s" })).status, 404);

    // ops role gates (docs/auth.md §2): pool monitoring yes, everything else no.
    assert.equal((await ops("GET", "/api/admin/accounts")).status, 200);
    assert.equal((await ops("GET", "/api/admin/nodes")).status, 200);
    assert.equal((await ops("GET", "/api/admin/groups")).status, 200);
    assert.equal((await ops("POST", `/api/admin/accounts/${id}/test`, {})).status, 200);
    const picker = await ops("GET", "/api/admin/nodes/node-prov/proxies");
    assert.equal(picker.status, 200);
    assert.ok(picker.data.length > 0 && !("url" in picker.data[0]) && !("lastError" in picker.data[0]), "ops only sees the credential-free picker shape");
    assert.equal((await ops("PATCH", `/api/admin/accounts/${id}`, { priority: 1 })).status, 403, "ops cannot edit account settings");
    assert.equal((await ops("PATCH", `/api/admin/accounts/${id}`, { status: "disabled" })).status, 200, "ops can disable");
    assert.equal((await ops("PATCH", `/api/admin/accounts/${id}`, { status: "active" })).status, 200, "ops can enable");
    for (const [m, p] of [["GET", "/api/admin/users"], ["GET", "/api/admin/dashboard"], ["DELETE", `/api/admin/accounts/${id}`], ["POST", "/api/admin/accounts"], ["GET", "/api/admin/settings"], ["GET", "/api/admin/nodes/monitor"], ["GET", "/api/user/keys"]]) {
      assert.equal((await ops(m, p, m === "POST" ? {} : undefined)).status, 403, `${m} ${p} denied for ops`);
    }

    run("UPDATE node_proxies SET bound_account_id = NULL WHERE bound_account_id = ?", id);
    run("DELETE FROM accounts WHERE id IN (?, ?)", id, apiAcc);
  } finally {
    delete process.env.ONBOARD_MOCK_ACCOUNT_UUID;
  }
});

await app.close();
