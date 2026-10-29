// POST /api/{admin,provider}/accounts/onboard/proxy (docs/onboarding.md §4.1, 2026-10-28):
// operator-supplied proxy for one onboarding — parsed into a socks5 URL, reused when the
// endpoint is already in a pool (any spelling), otherwise appended to the node's pool.
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const dir = mkdtempSync(join(tmpdir(), "1dayapi-proxy-supplied-"));
process.env.DATA_DIR = dir;
process.env.CCR_WINDOW_POLL = "0";
process.env.ALLOW_UNTRUSTED_EXECUTION = "1";
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));

const core = await import("@1dayapi/core");
const { buildApp } = await import("../dist/app.js");
const { replaceNodeProxies, resolveTeamProxy } = await import("../dist/node/proxies.js");
const { createUser } = await import("../dist/session.js");
const { run, one, all } = core;

const app = await buildApp();
await app.listen({ port: 0, host: "127.0.0.1" });
const BASE = `http://127.0.0.1:${app.server.address().port}`;
async function login(key) {
  const r = await fetch(`${BASE}/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key }) });
  const cookie = (r.headers.get("set-cookie") ?? "").split(";")[0];
  return async (method, path, body) => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { cookie, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, ...(await res.json().catch(() => ({}))) };
  };
}
const admin = await login(readFileSync(join(dir, "admin-key.txt"), "utf8").trim());
const prov = createUser("provider", "sp-provider");
const other = createUser("provider", "sp-other");
const provider = await login(prov.loginKey);
run("INSERT INTO nodes(node_id,provider_id,secret_hash,online,accepting_sessions,created_at) VALUES ('sp-node-a',?,'h',1,1,?)", prov.id, core.nowIso());
run("INSERT INTO nodes(node_id,provider_id,secret_hash,online,accepting_sessions,created_at) VALUES ('sp-node-b',?,'h',1,1,?)", prov.id, core.nowIso());
run("INSERT INTO nodes(node_id,provider_id,secret_hash,online,accepting_sessions,created_at) VALUES ('sp-node-x',?,'h',1,1,?)", other.id, core.nowIso());
run("INSERT INTO nodes(node_id,provider_id,secret_hash,online,accepting_sessions,created_at) VALUES ('sp-node-off',?,'h',0,1,?)", prov.id, core.nowIso());

// Existing pool rows, stored the way provider lists arrive (raw socks5 URLs).
const known = "socks5://alice:s3cret@140.188.37.27:1080";
replaceNodeProxies("sp-node-a", [{ url: known, label: "list-1" }]);
replaceNodeProxies("sp-node-x", [{ url: "socks5://bob:pw@198.51.100.77:1080" }]);
const knownId = core.sha256Hex(known).slice(0, 12);
run("UPDATE node_proxies SET status='live', exit_ip='140.188.37.27', resource_key='ip:140.188.37.27', exit_country='US', last_check_at=? WHERE id=?", core.nowIso(), knownId);
const TEAM = "11111111-2222-4333-8444-555555555555";

test("existing proxy is reused whatever the spelling, never a failure", async () => {
  for (const spelling of [known, "140.188.37.27:1080:alice:s3cret", "alice:s3cret@140.188.37.27:1080", "140.188.37.27 1080 alice s3cret", "http://alice:s3cret@140.188.37.27:1080"]) {
    const r = await admin("POST", "/api/admin/accounts/onboard/proxy", { nodeId: "sp-node-a", proxy: spelling, orgUuid: TEAM });
    assert.equal(r.status, 200, spelling);
    assert.equal(r.data.proxyId, knownId, spelling);
    assert.equal(r.data.nodeId, "sp-node-a");
    assert.equal(r.data.existed, true);
    assert.equal(r.data.added, false);
    assert.equal(r.data.status, "live");
    assert.equal(r.data.country, "US");
    assert.equal(r.data.blocked, null);
    assert.equal(r.data.parsed.display, "socks5://alice:***@140.188.37.27:1080");
    assert.equal(JSON.stringify(r.data).includes("s3cret"), false, "password never leaves the server");
  }
  assert.equal(one("SELECT COUNT(*) n FROM node_proxies WHERE node_id='sp-node-a'").n, 1, "no duplicate row");
  // an explicit pick of the reused proxy goes through the allocator
  assert.equal(resolveTeamProxy("sp-node-a", TEAM, knownId).id, knownId);
});

test("a proxy known on another node is answered with that node", async () => {
  // the admin may onboard anywhere: the row's node comes back so the form can switch
  const r = await admin("POST", "/api/admin/accounts/onboard/proxy", { nodeId: "sp-node-a", proxy: "198.51.100.77:1080:bob:pw" });
  assert.equal(r.status, 200);
  assert.equal(r.data.nodeId, "sp-node-x");
  assert.equal(r.data.existed, true);
  // a provider may not touch another provider's pool
  const p = await provider("POST", "/api/provider/accounts/onboard/proxy", { nodeId: "sp-node-a", proxy: "198.51.100.77:1080:bob:pw" });
  assert.equal(p.status, 400);
  assert.equal(p.error?.code ?? p.code, "proxy_on_other_node");
  assert.equal(one("SELECT COUNT(*) n FROM node_proxies WHERE node_id='sp-node-a'").n, 1);
});

test("dry run parses and looks up without writing", async () => {
  const r = await admin("POST", "/api/admin/accounts/onboard/proxy", { nodeId: "sp-node-a", proxy: "203.0.113.5:1080:carol:pw", dryRun: true });
  assert.equal(r.status, 200);
  assert.equal(r.data.proxyId, null);
  assert.equal(r.data.existed, false);
  assert.equal(r.data.blocked, "not_in_pool");
  assert.equal(r.data.parsed.display, "socks5://carol:***@203.0.113.5:1080");
  assert.equal(one("SELECT COUNT(*) n FROM node_proxies").n, 2);
  const k = await admin("POST", "/api/admin/accounts/onboard/proxy", { nodeId: "sp-node-a", proxy: "140.188.37.27:1080:alice:s3cret", dryRun: true });
  assert.equal(k.data.existed, true);
  assert.equal(k.data.proxyId, knownId);
});

test("a new proxy is appended to the node's pool as a canonical socks5 url and waits for the probe", async () => {
  const r = await provider("POST", "/api/provider/accounts/onboard/proxy", { nodeId: "sp-node-a", proxy: "203.0.113.5 1080 carol pw" });
  assert.equal(r.status, 200, JSON.stringify(r));
  const id = core.sha256Hex("socks5://carol:pw@203.0.113.5:1080").slice(0, 12);
  assert.equal(r.data.proxyId, id);
  assert.equal(r.data.added, true);
  assert.equal(r.data.existed, false);
  assert.equal(r.data.pushed, false, "no live WS connection in the test");
  assert.equal(r.data.status, "unknown");
  assert.equal(r.data.blocked, "unprobed");
  const row = one("SELECT * FROM node_proxies WHERE id=?", id);
  assert.equal(row.node_id, "sp-node-a");
  assert.equal(row.isolation_version, 1);
  assert.equal(core.decryptString(row.url_enc), "socks5://carol:pw@203.0.113.5:1080");
  assert.match(row.label, /^supplied:/);
  // not assignable until the node has measured its exit
  assert.throws(() => resolveTeamProxy("sp-node-a", TEAM, id), /proxy_unassignable: unprobed/);
  // second call with another spelling: reused, still one row
  const again = await admin("POST", "/api/admin/accounts/onboard/proxy", { nodeId: "sp-node-a", proxy: "socks5h://carol:pw@203.0.113.5:1080" });
  assert.equal(again.data.proxyId, id);
  assert.equal(again.data.existed, true);
  assert.equal(all("SELECT id FROM node_proxies WHERE node_id='sp-node-a'").length, 2);
  // once the heartbeat has verified the exit it becomes assignable
  run("UPDATE node_proxies SET status='live', exit_ip='203.0.113.5', resource_key='ip:203.0.113.5', last_check_at=? WHERE id=?", core.nowIso(), id);
  const ready = await admin("POST", "/api/admin/accounts/onboard/proxy", { nodeId: "sp-node-a", proxy: "203.0.113.5:1080:carol:pw", orgUuid: TEAM });
  assert.equal(ready.data.blocked, null);
  assert.equal(resolveTeamProxy("sp-node-a", TEAM, id).id, id);
});

test("explicit pick: third slot allowed, fourth refused (normal 2, maximum 3)", async () => {
  const id = core.sha256Hex("socks5://carol:pw@203.0.113.5:1080").slice(0, 12);
  run("INSERT INTO upstream_teams(id,name,created_at) VALUES (?,?,?) ON CONFLICT DO NOTHING", TEAM, "t", core.nowIso());
  const mk = (n) => run(`INSERT INTO accounts(id,name,platform,type,protocol,executor,credential_enc,owner_id,route,node_id,review_status,bound_proxy_id,team_id)
    VALUES (?,?,'anthropic','oauth','anthropic','ccr_worker',?,NULL,'node','sp-node-a','approved',?,?)`, `sp-acc-${n}`, `sp-acc-${n}`, core.encryptJson({ accessToken: "x" }), id, TEAM);
  mk(1); mk(2);
  run("UPDATE node_proxies SET team_id=? WHERE id=?", TEAM, id); // what claimTeamProxy does on the first binding
  // another verified exit with a free normal slot exists (the known one) — the explicit pick still gets slot 3
  assert.equal(resolveTeamProxy("sp-node-a", TEAM, id).id, id);
  let r = await admin("POST", "/api/admin/accounts/onboard/proxy", { nodeId: "sp-node-a", proxy: "203.0.113.5:1080:carol:pw", orgUuid: TEAM });
  assert.equal(r.data.boundAccounts, 2);
  assert.equal(r.data.blocked, null);
  mk(3);
  assert.throws(() => resolveTeamProxy("sp-node-a", TEAM, id), /proxy_full/);
  r = await admin("POST", "/api/admin/accounts/onboard/proxy", { nodeId: "sp-node-a", proxy: "203.0.113.5:1080:carol:pw", orgUuid: TEAM });
  assert.equal(r.data.blocked, "full");
  // automatic pick skips the full exit and lands on the one with a normal slot
  assert.equal(resolveTeamProxy("sp-node-a", TEAM, "auto").id, knownId);
  // another organization is told why
  r = await admin("POST", "/api/admin/accounts/onboard/proxy", { nodeId: "sp-node-a", proxy: "203.0.113.5:1080:carol:pw", orgUuid: "99999999-2222-4333-8444-555555555555" });
  assert.equal(r.data.blocked, "other_organization");
});

test("bad input and offline node", async () => {
  let r = await admin("POST", "/api/admin/accounts/onboard/proxy", { nodeId: "sp-node-a", proxy: "not a proxy at all" });
  assert.equal(r.status, 400);
  assert.equal(r.error?.code ?? r.code, "proxy_unparseable");
  r = await admin("POST", "/api/admin/accounts/onboard/proxy", { nodeId: "sp-node-off", proxy: "203.0.113.9:1080" });
  assert.equal(r.status, 400);
  assert.equal(r.error?.code ?? r.code, "node_offline");
  // dry run works on an offline node (preview only)
  r = await admin("POST", "/api/admin/accounts/onboard/proxy", { nodeId: "sp-node-off", proxy: "203.0.113.9:1080", dryRun: true });
  assert.equal(r.status, 200);
  r = await provider("POST", "/api/provider/accounts/onboard/proxy", { nodeId: "sp-node-x", proxy: "203.0.113.9:1080" });
  assert.equal(r.status, 404, "another provider's node is invisible");
  assert.equal(one("SELECT COUNT(*) n FROM node_proxies WHERE node_id IN ('sp-node-off','sp-node-x')").n, 1);
});

test.after(async () => {
  await app.close();
});
