// Organizations as an operations object (2026-11-01): overview, exit-claim release with its waiting period,
// enable/disable, node cleanup gate, account list filter by organization.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "1day-teams-ops-"));
process.env.DATA_DIR = dir;
process.env.ALLOW_UNTRUSTED_EXECUTION = "1";
process.env.CCR_WINDOW_POLL = "0";
const core = await import("@1dayapi/core");
const { buildApp } = await import("../dist/app.js");
const { replaceNodeProxies, recordNodeProxyExit } = await import("../dist/node/proxies.js");
const { teamClaims, releaseTeamClaims, teamOverview } = await import("../dist/node/teams.js");
const { createUser } = await import("../dist/session.js");
const { run, one } = core;
const A = "11111111-1111-4111-8111-111111111111", B = "22222222-2222-4222-8222-222222222222";
core.ensureUpstreamTeam(A, "Org A"); core.ensureUpstreamTeam(B, "Org B");
core.claimProxyResource("ip:198.51.100.10", A); core.claimProxyResource("ip:198.51.100.11", A); core.claimProxyResource("ip:198.51.100.12", B);
const owner = createUser("provider", "teams-fixture");
const admin = createUser("admin", "teams-admin");
run("INSERT INTO nodes(node_id,provider_id,secret_hash,online,accepting_sessions) VALUES ('t-node',?,?,1,1)", owner.id, core.sha256Hex("s"));
const urls = ["http://u:p@198.51.100.10:8000", "http://u:p@198.51.100.11:8000", "http://u:p@198.51.100.12:8000"];
const [pA1, pA2, pB1] = urls.map((u) => core.sha256Hex(u).slice(0, 12));
replaceNodeProxies("t-node", urls.map((url) => ({ url })));
recordNodeProxyExit("t-node", pA1, "198.51.100.10"); recordNodeProxyExit("t-node", pA2, "198.51.100.11"); recordNodeProxyExit("t-node", pB1, "198.51.100.12");
run("UPDATE node_proxies SET status='live',team_id=? WHERE id IN (?,?)", A, pA1, pA2);
run("UPDATE node_proxies SET status='live',team_id=? WHERE id=?", B, pB1);
run(`INSERT INTO accounts(id,name,platform,type,protocol,executor,credential_enc,owner_id,route,node_id,review_status,bound_proxy_id,team_id,concurrency)
  VALUES ('a1','a1','anthropic','oauth','anthropic','ccr_worker',?,?,'node','t-node','approved',?,?,9)`, core.encryptJson({ accessToken: "x" }), owner.id, pA1, A);
core.recordProxyTeamEvent({ resourceKey: "ip:198.51.100.10", proxyId: pA1, nodeId: "t-node", teamId: A, accountId: "a1", event: "account_bound", reason: "fixture" });
// exit .11 was used by an account that has since been deleted, 10 days ago
run("INSERT INTO proxy_team_events(id,resource_key,proxy_id,node_id,team_id,account_id,event,reason,created_at) VALUES (?,?,?,?,?,?,?,?,?)", core.newId(), "ip:198.51.100.11", pA2, "t-node", A, "gone", "account_released", "fixture", new Date(Date.now() - 10 * 86_400_000).toISOString().replace(/\.\d{3}Z$/, "Z"));
// exit .12 (org B) released an account yesterday
run("INSERT INTO proxy_team_events(id,resource_key,proxy_id,node_id,team_id,account_id,event,reason,created_at) VALUES (?,?,?,?,?,?,?,?,?)", core.newId(), "ip:198.51.100.12", pB1, "t-node", B, "gone2", "account_released", "fixture", new Date(Date.now() - 86_400_000).toISOString().replace(/\.\d{3}Z$/, "Z"));

const app = await buildApp();
await app.listen({ host: "127.0.0.1", port: 0 });
const BASE = `http://127.0.0.1:${app.server.address().port}`;
async function login(key) {
  const r = await fetch(`${BASE}/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key }) });
  const cookie = (r.headers.get("set-cookie") ?? "").split(";")[0];
  return async (method, path, body) => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { cookie, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, ...(await res.json().catch(() => ({}))) };
  };
}
const api = await login(admin.loginKey);
try {
  // claims: .10 bound → not releasable; .11 quiet for 10 d → releasable (min 7 d); B's .12 used yesterday → too_recent
  const ca = teamClaims(A);
  assert.deepEqual(ca.map((c) => [c.exitIp, c.releasable, c.blocker]), [["198.51.100.10", false, "bound_accounts"], ["198.51.100.11", true, null]]);
  assert.deepEqual(teamClaims(B).map((c) => [c.exitIp, c.releasable, c.blocker]), [["198.51.100.12", false, "too_recent"]]);
  // overview
  const ov = teamOverview({ a1: 3 });
  const rowA = ov.find((r) => r.id === A);
  assert.equal(rowA.accounts.total, 1); assert.equal(rowA.inFlight, 3); assert.equal(rowA.accounts.concurrency, 9);
  assert.deepEqual(rowA.exits, { claimed: 2, bound: 1, releasable: 1 });
  // release all releasable of A: .11 goes, .10 stays; the exit is virgin again (no claim, no row tag)
  const r1 = await api("POST", `/api/admin/teams/${A}/release-claims`, { reason: "unused" });
  assert.equal(r1.status, 200, JSON.stringify(r1));
  assert.deepEqual(r1.data.released, ["ip:198.51.100.11"]);
  assert.deepEqual(r1.data.skipped, [{ resourceKey: "ip:198.51.100.10", blocker: "bound_accounts" }]);
  assert.equal(one("SELECT COUNT(*) n FROM proxy_team_claims WHERE resource_key='ip:198.51.100.11'").n, 0);
  assert.equal(one("SELECT team_id FROM node_proxies WHERE id=?", pA2).team_id, null);
  assert.equal(one("SELECT COUNT(*) n FROM proxy_team_claim_releases WHERE resource_key='ip:198.51.100.11' AND team_id=?", A).n, 1);
  assert.equal(one("SELECT COUNT(*) n FROM proxy_team_events WHERE event='claim_released' AND team_id=?", A).n, 1);
  // another organization can claim the released exit now
  core.claimProxyResource("ip:198.51.100.11", B);
  // B's recent exit: refused without force, released with force
  const r2 = await api("POST", `/api/admin/teams/${B}/release-claims`, { resourceKeys: ["ip:198.51.100.12"] });
  assert.deepEqual(r2.data.released, []); assert.equal(r2.data.skipped[0].blocker, "too_recent");
  const r3 = await api("POST", `/api/admin/teams/${B}/release-claims`, { resourceKeys: ["ip:198.51.100.12"], force: true });
  assert.deepEqual(r3.data.released, ["ip:198.51.100.12"]);
  // disable / enable; cleanup gate
  const d1 = await api("PATCH", `/api/admin/teams/${A}`, { status: "disabled", name: "Org A (paused)" });
  assert.equal(d1.status, 200); assert.equal(d1.data.status, "disabled"); assert.equal(d1.data.name, "Org A (paused)");
  assert.equal(core.listCandidates(core.getSetting("default_group_id") || "x", "claude-sonnet-5-5").some((a) => a.id === "a1"), false, "a disabled organization's accounts are not candidates");
  const c1 = await api("POST", `/api/admin/teams/${A}/cleanup-nodes`, {});
  assert.equal(c1.status, 400); assert.equal(c1.error.code, "team_has_accounts");
  const c2 = await api("POST", `/api/admin/teams/${B}/cleanup-nodes`, {});
  assert.equal(c2.status, 400); assert.equal(c2.error.code, "team_active");
  await api("PATCH", `/api/admin/teams/${B}`, { status: "disabled" });
  const c3 = await api("POST", `/api/admin/teams/${B}/cleanup-nodes`, {});
  assert.equal(c3.status, 200, JSON.stringify(c3)); assert.deepEqual(c3.data.nodes, [], "no isolation-capable node connected in this fixture");
  assert.equal(one("SELECT COUNT(*) n FROM proxy_team_events WHERE event='team_node_cleanup_requested' AND team_id=?", B).n, 1);
  // account list filter by organization (admin)
  const l = await api("GET", `/api/admin/accounts?teamId=${A}`);
  assert.equal(l.data.items.length, 1); assert.equal(l.data.items[0].id, "a1");
  const l2 = await api("GET", `/api/admin/accounts?teamId=${B}`);
  assert.equal(l2.data.items.length, 0);
  console.log("teams-ops: ALL PASSED");
} finally {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
}
