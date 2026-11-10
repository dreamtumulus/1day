// Node / proxy / account lifecycle against a real console app on a temp
// DATA_DIR: pool replacement and node/user deletion with bound accounts
// (circular FK accounts<->node_proxies), onboarding proxy reservation with a
// slow exchange, platform-node credential uploads, stale job sweeps.
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const dir = mkdtempSync(join(tmpdir(), "1dayapi-lifecycle-"));
process.env.DATA_DIR = dir;
process.env.CCR_WINDOW_POLL = "0";
// Slow mock exchange: keeps the proxy reservation observable while jobs are in flight.
process.env.ALLOW_UNTRUSTED_EXECUTION="1";
process.env.ONBOARD_MOCK = "1";
process.env.ONBOARD_MOCK_DELAY_MS = "400";
process.env.ONBOARD_PROFILE_FETCH = "0";
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));

const core = await import("@1dayapi/core");
const { buildApp } = await import("../dist/app.js");
const { createUser } = await import("../dist/session.js");
const { replaceNodeProxies, recordNodeProxyExit } = await import("../dist/node/proxies.js");
const { sweepStaleJobs } = await import("../dist/onboard/jobs.js");
const { run, one, all } = core;

const app = await buildApp();
await app.listen({ port: 0, host: "127.0.0.1" });
const BASE = `http://127.0.0.1:${app.server.address().port}`;

async function login(key) {
  const r = await fetch(`${BASE}/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key }) });
  assert.equal(r.status, 200);
  const cookie = (r.headers.get("set-cookie") ?? "").split(";")[0];
  return async (method, path, body) => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { cookie, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
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

const admin = await login(readFileSync(join(dir, "admin-key.txt"), "utf8").trim());
const provider = createUser("provider", "lc-provider");
const prov = await login(provider.loginKey);
const adminUser = one("SELECT id FROM users WHERE role='admin' LIMIT 1");
const now = core.nowIso();
const mkNode = (id, providerId, secret = "sec") =>
  run("INSERT INTO nodes (node_id, provider_id, secret_hash, online, accepting_sessions, created_at) VALUES (?, ?, ?, 1, 1, ?)", id, providerId, core.sha256Hex(secret), now);
const pid = (url) => core.sha256Hex(url).slice(0, 12);
const live = (nodeId) => {
  run("UPDATE node_proxies SET status='live', last_check_at=? WHERE node_id=?", now, nodeId);
  for (const p of all("SELECT id,url_enc FROM node_proxies WHERE node_id=?", nodeId)) {
    assert.equal(recordNodeProxyExit(nodeId, p.id, new URL(core.decryptString(p.url_enc)).hostname), true);
  }
};
const urls = (n, base) => Array.from({ length: n }, (_, i) => `http://u:p@${base}.${i + 1}:8000`);

// ---------- fixture: provider node with 3 proxies, one bound account ----------
mkNode("lc-prov", provider.id);
replaceNodeProxies("lc-prov", urls(3, "10.9.0").map((url) => ({ url })));
live("lc-prov");
const [u1, u2, u3] = urls(3, "10.9.0");
run(
  `INSERT INTO accounts (id, name, platform, type, executor, protocol, credential_enc, owner_id, route, node_id, review_status, bound_proxy_id, created_at, updated_at)
   VALUES ('acc-bound', 'bound', 'anthropic', 'oauth', 'ccr', 'anthropic', ?, ?, 'node', 'lc-prov', 'approved', ?, ?, ?)`,
  core.encryptJson({ accessToken: "t", refreshToken: "r" }),
  provider.id,
  pid(u1),
  now,
  now,
);
run("UPDATE node_proxies SET bound_account_id='acc-bound' WHERE id=?", pid(u1));

await test("PUT proxies: dropping a bound proxy is refused; keeping it preserves the binding", async () => {
  let r = await admin("PUT", "/api/admin/nodes/lc-prov/proxies", { proxies: [{ url: u2 }, { url: u3 }] });
  assert.equal(r.status, 400, JSON.stringify(r));
  assert.equal(r.error?.code, "proxy_bound");
  assert.equal(one("SELECT bound_account_id FROM node_proxies WHERE id=?", pid(u1)).bound_account_id, "acc-bound", "nothing changed on refusal");

  r = await admin("PUT", "/api/admin/nodes/lc-prov/proxies", { proxies: [{ url: u1, label: "kept" }, { url: "http://u:p@10.9.1.1:8000" }] });
  assert.equal(r.status, 200, JSON.stringify(r));
  const rows = all("SELECT id, label, status, bound_account_id FROM node_proxies WHERE node_id='lc-prov' ORDER BY id");
  assert.equal(rows.length, 2);
  const kept = rows.find((x) => x.id === pid(u1));
  assert.equal(kept.bound_account_id, "acc-bound");
  assert.equal(kept.status, "live", "health of a retained proxy survives the replacement");
  assert.equal(kept.label, "kept");
  assert.equal(one("SELECT bound_proxy_id FROM accounts WHERE id='acc-bound'").bound_proxy_id, pid(u1));
});

await test("POST proxies: duplicates (in batch / in pool) are dropped, a line on another node is shared in (2026-11-08), the rest added, counts reported", async () => {
  mkNode("lc-other", adminUser.id);
  replaceNodeProxies("lc-other", [{ url: "http://u:p@10.9.6.1:8000" }]);
  const before = one("SELECT COUNT(*) AS n FROM node_proxies WHERE node_id='lc-prov'").n;
  const r = await admin("POST", "/api/admin/nodes/lc-prov/proxies", {
    proxies: [
      { url: "http://u:p@10.9.7.1:8000", label: "fresh-1" },
      { url: "http://u:p@10.9.7.1:8000", label: "same line again" },
      { url: u1, label: "do-not-touch" }, // already in lc-prov's pool (and bound)
      { url: "http://u:p@10.9.6.1:8000" }, // lives on lc-other
      { url: "http://u:p@10.9.7.2:8000" },
    ],
  });
  assert.equal(r.status, 200, JSON.stringify(r));
  assert.equal(r.data.added, 2);
  assert.equal(r.data.shared, 1, "the line living on lc-other is shared into lc-prov instead of being dropped");
  assert.deepEqual(r.data.skipped, { duplicateInBatch: 1, alreadyInPool: 1, onOtherNode: 0 });
  assert.equal(r.data.skippedUrls.length, 2);
  assert.ok(r.data.skippedUrls.every((u) => !u.includes(":p@")), "skipped urls are masked");
  assert.equal(one("SELECT COUNT(*) AS n FROM node_proxies WHERE node_id='lc-prov'").n, before + 2);
  assert.equal(one("SELECT COUNT(*) AS n FROM node_proxy_shares WHERE node_id='lc-prov'").n, 1);
  const sharedRow = r.data.proxies.find((p) => p.id === pid("http://u:p@10.9.6.1:8000"));
  assert.equal(sharedRow?.shared, true);
  assert.equal(sharedRow?.homeNodeId, "lc-other");
  const kept = one("SELECT label, bound_account_id FROM node_proxies WHERE id=?", pid(u1));
  assert.equal(kept.label, "kept", "existing row's label untouched");
  assert.equal(kept.bound_account_id, "acc-bound");
  assert.equal(one("SELECT node_id FROM node_proxies WHERE id=?", pid("http://u:p@10.9.6.1:8000")).node_id, "lc-other", "other node keeps its proxy");
  assert.equal(one("SELECT label FROM node_proxies WHERE id=?", pid("http://u:p@10.9.7.1:8000")).label, "fresh-1", "first occurrence wins");

  // A home row another node uses through a share cannot be dropped by a replace (2026-11-08): remove the share first.
  const refused = await admin("PUT", "/api/admin/nodes/lc-other/proxies", { proxies: [{ url: "http://u:p@10.9.6.2:8000" }] });
  assert.equal(refused.status, 400, JSON.stringify(refused));
  assert.match(refused.error?.message ?? "", /shared with other nodes/);
  // Replace mode dedupes the batch the same way and reports it; a line living on lc-prov (u1) becomes a share.
  const r2 = await admin("PUT", "/api/admin/nodes/lc-other/proxies", {
    proxies: [{ url: "http://u:p@10.9.6.2:8000" }, { url: "http://u:p@10.9.6.2:8000" }, { url: u1 }, { url: "http://u:p@10.9.6.1:8000" }],
  });
  assert.equal(r2.status, 200, JSON.stringify(r2));
  assert.equal(r2.data.total, 3);
  assert.equal(r2.data.shared, 1);
  assert.deepEqual(r2.data.skipped, { duplicateInBatch: 1, alreadyInPool: 0, onOtherNode: 0 });
  assert.equal(one("SELECT COUNT(*) AS n FROM node_proxies WHERE node_id='lc-other'").n, 2);
  assert.equal(one("SELECT COUNT(*) AS n FROM node_proxy_shares WHERE node_id='lc-other'").n, 1);
  assert.equal(one("SELECT node_id FROM node_proxies WHERE id=?", pid(u1)).node_id, "lc-prov", "u1 stays home on lc-prov");
});

await test("DELETE node (admin) with a bound account: 200, account unbound+disabled, ledger cleared", async () => {
  mkNode("lc-del", provider.id);
  replaceNodeProxies("lc-del", [{ url: "http://u:p@10.9.2.1:8000" }]);
  live("lc-del");
  run("INSERT INTO accounts (id, name, platform, type, protocol, credential_enc, owner_id, route, node_id, review_status, bound_proxy_id, created_at, updated_at) VALUES ('acc-del','d','anthropic','oauth','anthropic',?,?,'node','lc-del','approved',?,?,?)",
    core.encryptJson({ accessToken: "t" }), provider.id, pid("http://u:p@10.9.2.1:8000"), now, now);
  run("UPDATE node_proxies SET bound_account_id='acc-del' WHERE node_id='lc-del'");
  run("INSERT INTO onboarding_jobs (id, requester_id, scope, method, node_id, proxy_id, status, created_at, updated_at) VALUES ('job-del', ?, 'admin', 'auth_url', 'lc-del', ?, 'pending_callback', ?, ?)", adminUser.id, pid("http://u:p@10.9.2.1:8000"), now, now);
  // 2026-11-10: a node that still carries accounts is refused until the removal is forced.
  const refused = await admin("DELETE", "/api/admin/nodes/lc-del");
  assert.equal(refused.status, 409, JSON.stringify(refused));
  assert.equal(refused.error.code, "node_has_dependents");
  assert.deepEqual(refused.error.details.accounts.map((a) => a.id), ["acc-del"]);
  assert.equal(one("SELECT status FROM accounts WHERE id='acc-del'").status, "active", "a refused removal changes nothing");
  const r = await admin("DELETE", "/api/admin/nodes/lc-del?force=1");
  assert.equal(r.status, 200, JSON.stringify(r));
  assert.deepEqual(r.data.disabledAccounts, ["acc-del"]);
  assert.equal(one("SELECT COUNT(*) n FROM proxy_team_events WHERE event='account_unbound_node_removed' AND account_id='acc-del'").n, 1);
  assert.equal(one("SELECT 1 FROM nodes WHERE node_id='lc-del'"), undefined);
  assert.equal(all("SELECT 1 FROM node_proxies WHERE node_id='lc-del'").length, 0);
  const a = one("SELECT status, node_id, bound_proxy_id, error_message FROM accounts WHERE id='acc-del'");
  assert.equal(a.status, "disabled");
  assert.equal(a.node_id, null);
  assert.equal(a.bound_proxy_id, null);
  assert.ok(a.error_message.includes("node removed"));
  assert.equal(one("SELECT status FROM onboarding_jobs WHERE id='job-del'").status, "failed");
});

await test("DELETE node (provider) cleans the same way; other provider's node is 404", async () => {
  mkNode("lc-pdel", provider.id);
  replaceNodeProxies("lc-pdel", [{ url: "http://u:p@10.9.3.1:8000" }]);
  const other = createUser("provider", "lc-other");
  const oth = await login(other.loginKey);
  assert.equal((await oth("DELETE", "/api/provider/nodes/lc-pdel")).status, 404);
  const r = await prov("DELETE", "/api/provider/nodes/lc-pdel");
  assert.equal(r.status, 200, JSON.stringify(r));
  assert.equal(all("SELECT 1 FROM node_proxies WHERE node_id='lc-pdel'").length, 0);
});

await test("unknown organizations reserve separate discovery exits before authorization; capacity reflects pending reservations", async () => {
  mkNode("lc-onb", adminUser.id); // platform node
  replaceNodeProxies("lc-onb", urls(2, "10.9.4").map((url) => ({ url })));
  live("lc-onb");
  const [r1, r2, r3] = await Promise.all([
    admin("POST", "/api/admin/accounts/onboard", { method: "session_key", sessionKey: "s1", nodeId: "lc-onb" }),
    admin("POST", "/api/admin/accounts/onboard", { method: "session_key", sessionKey: "s2", nodeId: "lc-onb" }),
    admin("POST", "/api/admin/accounts/onboard", { method: "session_key", sessionKey: "s3", nodeId: "lc-onb" }),
  ]);
  const ok = [r1, r2, r3].filter((r) => r.status === 200);
  const rejected = [r1, r2, r3].filter((r) => r.status !== 200);
  assert.equal(ok.length, 2, JSON.stringify([r1, r2, r3]));
  assert.equal(rejected[0].error?.code, "proxy_pool_empty", "third job finds both proxies reserved");
  const picked = ok.map((r) => one("SELECT proxy_id FROM onboarding_jobs WHERE id=?", r.data.jobId).proxy_id);
  assert.notEqual(picked[0], picked[1], "two in-flight jobs never share a proxy");
  const r4 = await admin("POST", "/api/admin/accounts/onboard", { method: "session_key", sessionKey: "s4", nodeId: "lc-onb", proxyId: picked[0] });
  assert.equal(r4.error?.code, "proxy_pool_empty", JSON.stringify(r4));
  const picker = await admin("GET", "/api/admin/nodes/lc-onb/proxies?free=1");
  assert.equal(picker.data.length, 2, "capacity picker includes reserved exits with a remaining slot");
  assert.ok(picker.data.every((p) => p.reservedAccounts === 1 && p.normalSlots === 1));
  for (const r of ok) {
    const done = await waitJob(admin, "/api/admin", r.data.jobId);
    assert.equal(done.status, "done", JSON.stringify(done));
  }
  const bound = all("SELECT id FROM accounts WHERE node_id='lc-onb' AND bound_proxy_id IS NOT NULL");
  assert.equal(bound.length, 2);
});

await test("credentials upload: platform node -> platform-owned + pinned; provider node -> provider-owned", async () => {
  mkNode("lc-plat", adminUser.id, "s-plat");
  replaceNodeProxies("lc-plat", urls(1, "10.9.8").map((url) => ({ url })));
  live("lc-plat");
  live("lc-prov");
  const up = (nodeId, secret) =>
    fetch(`${BASE}/internal/provider/credentials`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-provider-node-id": nodeId, "x-provider-node-secret": secret },
      body: JSON.stringify({ vendor: "anthropic", accessToken: "tok", accountEmail: "u@example.com" }),
    }).then(async (r) => ({ status: r.status, ...(await r.json()) }));
  let r = await up("lc-plat", "s-plat");
  assert.equal(r.status, 200, JSON.stringify(r));
  let a = one("SELECT owner_id, node_id,team_id,bound_proxy_id FROM accounts WHERE id=?", r.credentialBindingId);
  assert.equal(a.owner_id, null);
  assert.equal(a.node_id, "lc-plat");
  assert.equal(a.team_id, "11111111-1111-4111-8111-111111111111");
  assert.ok(a.bound_proxy_id);
  r = await up("lc-prov", "sec");
  assert.equal(r.status, 200, JSON.stringify(r));
  a = one("SELECT owner_id, node_id,team_id,bound_proxy_id FROM accounts WHERE id=?", r.credentialBindingId);
  assert.equal(a.owner_id, provider.id);
  assert.equal(a.node_id, "lc-prov", "new team accounts always pin their execution node");
  assert.equal(a.team_id, "11111111-1111-4111-8111-111111111111");
  assert.ok(a.bound_proxy_id);
  assert.equal((await up("lc-plat", "wrong")).status, 401);
});

await test("stale onboarding jobs are swept (working past the exchange timeout, pending_callback past 30 min)", () => {
  const old = new Date(Date.now() - 2 * 3600e3).toISOString().slice(0, 19) + "Z";
  run("INSERT INTO onboarding_jobs (id, requester_id, scope, method, node_id, status, payload_enc, isolation_version, created_at, updated_at) VALUES ('j-w', ?, 'admin', 'session_key', 'lc-prov', 'working', 'x', 1, ?, ?)", adminUser.id, old, old);
  run("INSERT INTO onboarding_jobs (id, requester_id, scope, method, node_id, status, payload_enc, isolation_version, created_at, updated_at) VALUES ('j-p', ?, 'admin', 'auth_url', 'lc-prov', 'pending_callback', 'x', 1, ?, ?)", adminUser.id, old, old);
  run("INSERT INTO onboarding_jobs (id, requester_id, scope, method, node_id, status, payload_enc, isolation_version, created_at, updated_at) VALUES ('j-fresh', ?, 'admin', 'auth_url', 'lc-prov', 'pending_callback', 'x', 1, ?, ?)", adminUser.id, now, now);
  assert.equal(sweepStaleJobs(), 2);
  assert.equal(one("SELECT status, payload_enc FROM onboarding_jobs WHERE id='j-w'").payload_enc, null);
  assert.equal(one("SELECT status FROM onboarding_jobs WHERE id='j-p'").status, "failed");
  assert.equal(one("SELECT status FROM onboarding_jobs WHERE id='j-fresh'").status, "pending_callback");
});

await test("DELETE provider user with bound accounts and nodes: 200, bindings released", async () => {
  const victim = createUser("provider", "lc-victim");
  mkNode("lc-vnode", victim.id);
  replaceNodeProxies("lc-vnode", [{ url: "http://u:p@10.9.5.1:8000" }]);
  run("INSERT INTO accounts (id, name, platform, type, protocol, credential_enc, owner_id, route, node_id, review_status, bound_proxy_id, created_at, updated_at) VALUES ('acc-v','v','anthropic','oauth','anthropic',?,?,'node','lc-vnode','approved',?,?,?)",
    core.encryptJson({ accessToken: "t" }), victim.id, pid("http://u:p@10.9.5.1:8000"), now, now);
  run("UPDATE node_proxies SET bound_account_id='acc-v' WHERE node_id='lc-vnode'");
  const r = await admin("DELETE", `/api/admin/users/${victim.id}`);
  assert.equal(r.status, 200, JSON.stringify(r));
  assert.equal(one("SELECT 1 FROM users WHERE id=?", victim.id), undefined);
  assert.equal(one("SELECT 1 FROM accounts WHERE id='acc-v'"), undefined, "accounts cascade with the user");
  assert.equal(all("SELECT 1 FROM node_proxies WHERE node_id='lc-vnode'").length, 0);
});

await app.close();
