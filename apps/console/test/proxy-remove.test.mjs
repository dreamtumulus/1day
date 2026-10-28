// POST /api/admin/nodes/:id/proxies/remove (2026-10-28): bulk removal by id; bound / reserved rows stay and are reported.
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const dir = mkdtempSync(join(tmpdir(), "1dayapi-proxy-remove-"));
process.env.DATA_DIR = dir;
process.env.CCR_WINDOW_POLL = "0";
process.env.ALLOW_UNTRUSTED_EXECUTION = "1";
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));

const core = await import("@1dayapi/core");
const { buildApp } = await import("../dist/app.js");
const { replaceNodeProxies } = await import("../dist/node/proxies.js");
const { createUser } = await import("../dist/session.js");
const { run, one } = core;

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
const owner = createUser("provider", "rm-fixture");
run("INSERT INTO nodes(node_id,provider_id,secret_hash,online,accepting_sessions,created_at) VALUES ('rm-node',?,'h',1,1,?)", owner.id, core.nowIso());
const urls = ["http://u:p@198.51.100.21:8000", "http://u:p@198.51.100.22:8000", "http://u:p@198.51.100.23:8000"];
replaceNodeProxies("rm-node", urls.map((url) => ({ url })));
const ids = urls.map((u) => core.sha256Hex(u).slice(0, 12));
run(`INSERT INTO accounts(id,name,platform,type,protocol,executor,credential_enc,owner_id,route,node_id,review_status,bound_proxy_id)
  VALUES ('rm-acc','rm-acc','anthropic','oauth','anthropic','ccr_worker',?,?,'node','rm-node','approved',?)`, core.encryptJson({ accessToken: "x" }), owner.id, ids[2]);

test("remove: free rows deleted, bound row reported, unknown id reported, pool count updated", async () => {
  const r = await admin("POST", "/api/admin/nodes/rm-node/proxies/remove", { proxyIds: [ids[0], ids[1], ids[2], "000000000000"] });
  assert.equal(r.status, 200, JSON.stringify(r));
  assert.deepEqual(r.data.removed.sort(), [ids[0], ids[1]].sort());
  assert.deepEqual(r.data.bound, [ids[2]]);
  assert.deepEqual(r.data.notFound, ["000000000000"]);
  assert.equal(r.data.remaining, 1);
  assert.equal(one("SELECT COUNT(*) n FROM node_proxies WHERE node_id='rm-node'").n, 1);
  assert.equal(one("SELECT COUNT(*) n FROM proxy_team_events WHERE event='proxy_removed'").n, 2);
  const empty = await admin("POST", "/api/admin/nodes/rm-node/proxies/remove", { proxyIds: [] });
  assert.equal(empty.status, 400);
  const prov = await (await login(owner.loginKey))("POST", "/api/admin/nodes/rm-node/proxies/remove", { proxyIds: [ids[2]] });
  assert.equal(prov.status, 403);
});
test.after(async () => { await app.close(); });

test("one-off rebind helper: isolated account moves to a verified same-node exit with claim + account_bound; legacy account to any live free proxy", async () => {
  const TEAM = "33333333-3333-4333-8333-333333333333";
  core.ensureUpstreamTeam(TEAM);
  const { recordNodeProxyExit, replaceNodeProxies: rep } = await import("../dist/node/proxies.js");
  run("INSERT INTO nodes(node_id,provider_id,secret_hash,online,accepting_sessions,created_at) VALUES ('rb-node',?,'h',1,1,?)", owner.id, core.nowIso());
  const rbUrls = ["http://u:p@198.51.100.31:8000", "http://u:p@198.51.100.32:8000", "http://u:p@198.51.100.33:8000", "http://u:p@198.51.100.34:8000"];
  rep("rb-node", rbUrls.map((url) => ({ url })));
  const rb = rbUrls.map((u) => core.sha256Hex(u).slice(0, 12));
  rbUrls.forEach((u, i) => { run("UPDATE node_proxies SET status='live' WHERE id=?", rb[i]); recordNodeProxyExit("rb-node", rb[i], `198.51.100.${31 + i}`); });
  // old proxy rb[0] carries the team account; rb[1] is the one we will exclude; rb[2] free verified exit; rb[3] legacy target
  run("UPDATE node_proxies SET team_id=? WHERE id=?", TEAM, rb[0]);
  core.claimProxyResource(`proxy:${rb[0]}`, TEAM); core.claimProxyResource("ip:198.51.100.31", TEAM);
  run(`INSERT INTO accounts(id,name,platform,type,protocol,executor,credential_enc,owner_id,route,node_id,review_status,bound_proxy_id,team_id)
    VALUES ('rb-team','rb-team','anthropic','oauth','anthropic','ccr_worker',?,?,'node','rb-node','approved',?,?)`, core.encryptJson({ accessToken: "x" }), owner.id, rb[0], TEAM);
  run(`INSERT INTO accounts(id,name,platform,type,protocol,executor,credential_enc,owner_id,route,node_id,review_status,bound_proxy_id)
    VALUES ('rb-legacy','rb-legacy','anthropic','oauth','anthropic','ccr_worker',?,?,'node','rb-node','approved',?)`, core.encryptJson({ accessToken: "y" }), owner.id, rb[3]);
  run("UPDATE node_proxies SET bound_account_id='rb-legacy' WHERE id=?", rb[3]);

  const { rebindAccountProxy } = await import("../dist/node/proxies.js");
  const r = { status: 200, data: core.tx(() => rebindAccountProxy("rb-team", "test-admin", { excludeProxyIds: [rb[1]] })) };
  assert.equal(r.data.oldProxyId, rb[0]);
  assert.equal(r.data.newProxyId, rb[2], "excluded rb[1] skipped; rb[3] is legacy-bound (never shared); rb[2] is the verified free exit");
  assert.equal(one("SELECT bound_proxy_id b FROM accounts WHERE id='rb-team'").b, rb[2]);
  assert.equal(one("SELECT team_id t FROM node_proxies WHERE id=?", rb[2]).t, TEAM);
  assert.equal(one("SELECT team_id t FROM proxy_team_claims WHERE resource_key='ip:198.51.100.33'").t, TEAM);
  assert.ok(one("SELECT 1 FROM proxy_team_events WHERE event='account_bound' AND account_id='rb-team' AND proxy_id=?", rb[2]));
  assert.ok(one("SELECT 1 FROM proxy_team_events WHERE event='account_released' AND account_id='rb-team' AND proxy_id=?", rb[0]));
  // the old proxy is now removable
  const rm = await admin("POST", "/api/admin/nodes/rb-node/proxies/remove", { proxyIds: [rb[0]] });
  assert.deepEqual(rm.data.removed, [rb[0]]);
  // legacy account: any live unbound proxy (rb[1] is the only one left free)
  const l = { data: core.tx(() => rebindAccountProxy("rb-legacy", "test-admin", {})) };
  assert.equal(l.data.newProxyId, rb[1]);
  assert.equal(one("SELECT bound_account_id b FROM node_proxies WHERE id=?", rb[1]).b, "rb-legacy");
  assert.equal(one("SELECT bound_account_id b FROM node_proxies WHERE id=?", rb[3]).b, null);
  // nothing free left → 400
  // rb[3] (just released) is free again; remove it, then nothing is left → the helper refuses
  assert.deepEqual((await admin("POST", "/api/admin/nodes/rb-node/proxies/remove", { proxyIds: [rb[3]] })).data.removed, [rb[3]]);
  assert.throws(() => core.tx(() => rebindAccountProxy("rb-legacy", "test-admin", {})), /No free live proxy/);
  // the route is deliberately absent: one-off operation, not a feature
  const route = await admin("POST", "/api/admin/accounts/rb-legacy/rebind-proxy", {});
  assert.equal(route.status, 404);
});
