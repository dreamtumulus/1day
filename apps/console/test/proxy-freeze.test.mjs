// Operator rule 2026-11-01 (docs/onboarding.md §1.2): a bound proxy that stops working freezes its accounts
// (status proxy_down) until an operator releases them (proxy live again) or rebinds them — never an automatic
// return, never a silent proxy change. Triggers: dead heartbeat, node refusing the pin (no_proxy_available),
// exit IP change / conflict. Run under node (console test suite).
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";

const dir = mkdtempSync(join(tmpdir(), "1day-proxy-freeze-"));
process.env.DATA_DIR = dir;
process.env.ALLOW_UNTRUSTED_EXECUTION = "1";
process.env.CCR_WINDOW_POLL = "0";
process.env.NODE_LINK_GRACE_MS = "0";
const core = await import("@1dayapi/core");
const { buildApp } = await import("../dist/app.js");
const registry = await import("../dist/node/registry.js");
const { replaceNodeProxies, recordNodeProxyExit } = await import("../dist/node/proxies.js");
const { createUser } = await import("../dist/session.js");
const { run, one } = core;
const A = "11111111-1111-4111-8111-111111111111";
core.ensureUpstreamTeam(A);
core.claimProxyResource("ip:198.51.100.10", A); core.claimProxyResource("ip:198.51.100.11", A);
const owner = createUser("provider", "freeze-fixture");
const admin = createUser("admin", "freeze-admin");
run("INSERT INTO nodes(node_id,provider_id,secret_hash,online,accepting_sessions) VALUES ('fz-node',?,?,1,1)", owner.id, core.sha256Hex("fixture-secret"));
const urlA = "http://u:p@198.51.100.10:8000", urlB = "http://u:p@198.51.100.11:8000";
const pA = core.sha256Hex(urlA).slice(0, 12), pB = core.sha256Hex(urlB).slice(0, 12);
replaceNodeProxies("fz-node", [{ url: urlA }, { url: urlB }]);
recordNodeProxyExit("fz-node", pA, "198.51.100.10"); recordNodeProxyExit("fz-node", pB, "198.51.100.11");
run("UPDATE node_proxies SET status='live',team_id=? WHERE id IN (?,?)", A, pA, pB);
for (const [id, proxy] of [["a1", pA], ["a2", pA]]) {
  run(`INSERT INTO accounts(id,name,platform,type,protocol,executor,credential_enc,owner_id,route,node_id,review_status,bound_proxy_id,team_id)
    VALUES (?,?,'anthropic','oauth','anthropic','ccr_worker',?,?,'node','fz-node','approved',?,?)`, id, id, core.encryptJson({ accessToken: "fixture" }), owner.id, proxy, A);
  core.recordProxyTeamEvent({ resourceKey: "ip:198.51.100.10", proxyId: pA, nodeId: "fz-node", teamId: A, accountId: id, event: "account_bound", reason: "fixture" });
}
const app = await buildApp();
await app.listen({ host: "127.0.0.1", port: 0 });
const BASE = `http://127.0.0.1:${app.server.address().port}`;
const ws = new WebSocket(`ws://127.0.0.1:${app.server.address().port}/internal/provider/connect`, { headers: { "x-provider-node-id": "fz-node", "x-provider-node-secret": "fixture-secret" } });
const frames = [];
let refuseOpens = false;
ws.on("message", (raw) => {
  const m = JSON.parse(raw.toString()); frames.push(m);
  if (["cc_worker.open", "http_egress.open"].includes(m.type)) {
    ws.send(JSON.stringify(refuseOpens ? { type: m.type + "_response", sessionId: m.sessionId, accepted: false, reasonCode: "no_proxy_available" } : { type: m.type + "_response", sessionId: m.sessionId, accepted: true }));
  }
});
const waitFor = async (fn, what = "condition") => { const until = Date.now() + 3000; while (!fn()) { if (Date.now() > until) throw new Error(`wait timeout: ${what}`); await new Promise((r) => setTimeout(r, 10)); } };
await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
ws.send(JSON.stringify({ type: "provider.hello", nodeId: "fz-node", providerId: owner.id, nodeVersion: "fixture", acceptingSessions: true, capabilities: ["cc_worker", "http_egress", "team_isolation_v1"] }));
await waitFor(() => frames.some((m) => m.type === "platform.ready"), "platform.ready");
const status = (id) => one("SELECT status, proxy_down_since s, proxy_down_reason r, proxy_down_proxy_id p, bound_proxy_id b FROM accounts WHERE id=?", id);
const events = (ev, id) => one("SELECT COUNT(*) n FROM proxy_team_events WHERE event=? AND account_id=?", ev, id).n;

async function login(key) {
  const r = await fetch(`${BASE}/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key }) });
  assert.equal(r.status, 200);
  const cookie = (r.headers.get("set-cookie") ?? "").split(";")[0];
  return async (method, path, body) => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { cookie, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, ...(await res.json().catch(() => ({}))) };
  };
}
const api = await login(admin.loginKey);

try {
  // 1. dead heartbeat → both accounts on pA frozen, with reason / since / proxy and an event
  ws.send(JSON.stringify({ type: "provider.heartbeat", acceptingSessions: true, proxies: [{ id: pA, live: false, error: "connect ETIMEDOUT" }, { id: pB, live: true, exitIp: "198.51.100.11" }], assignments: {} }));
  await waitFor(() => status("a1").status === "proxy_down" && status("a2").status === "proxy_down", "freeze on dead heartbeat");
  const f = status("a1");
  assert.match(f.r, /dead/); assert.match(f.r, /ETIMEDOUT/); assert.equal(f.p, pA); assert.ok(f.s);
  assert.equal(events("account_frozen_proxy_down", "a1"), 1);
  // frozen accounts are not candidates and the generic enable switch is refused
  assert.equal(one("SELECT COUNT(*) n FROM accounts WHERE status='active' AND bound_proxy_id=?", pA).n, 0);
  const sw = await api("PATCH", "/api/admin/accounts/a1", { status: "active" });
  assert.equal(sw.status, 400); assert.equal(sw.error.code, "proxy_down_use_release");
  // repeated dead heartbeats are idempotent (one event, since unchanged)
  ws.send(JSON.stringify({ type: "provider.heartbeat", acceptingSessions: true, proxies: [{ id: pA, live: false, error: "connect ETIMEDOUT" }], assignments: {} }));
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(events("account_frozen_proxy_down", "a1"), 1);
  assert.equal(status("a1").s, f.s);

  // 2. release refused while the proxy is still dead
  const r1 = await api("POST", "/api/admin/accounts/a1/proxy-release", {});
  assert.equal(r1.status, 400, JSON.stringify(r1)); assert.equal(r1.error.code, "proxy_not_live");
  assert.equal(status("a1").status, "proxy_down");

  // 3. proxy comes back → still frozen (no automatic return); operator release → active
  ws.send(JSON.stringify({ type: "provider.heartbeat", acceptingSessions: true, proxies: [{ id: pA, live: true, exitIp: "198.51.100.10" }], assignments: {} }));
  await waitFor(() => one("SELECT status FROM node_proxies WHERE id=?", pA).status === "live", "proxy live again");
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(status("a1").status, "proxy_down", "a live proxy does not un-freeze the account by itself");
  const r2 = await api("POST", "/api/admin/accounts/a1/proxy-release", { note: "vendor fixed the proxy" });
  assert.equal(r2.status, 200, JSON.stringify(r2));
  assert.equal(status("a1").status, "active"); assert.equal(status("a1").s, null); assert.equal(status("a1").r, null);
  assert.equal(events("account_proxy_released", "a1"), 1);
  const again = await api("POST", "/api/admin/accounts/a1/proxy-release", {});
  assert.equal(again.status, 400); assert.equal(again.error.code, "not_proxy_down");

  // 4. node refuses the pinned proxy (no_proxy_available) on open → frozen
  refuseOpens = true;
  const opened = await registry.openTunnel("a1", "cc_worker", undefined, 443, pA, { model: "claude-sonnet-5-5", prompt: "x", stream: false, cred: { accessToken: "fixture" } }, undefined, undefined, A);
  assert.equal(opened, null);
  await waitFor(() => status("a1").status === "proxy_down", "freeze on no_proxy_available");
  assert.match(status("a1").r, /no_proxy_available/);
  refuseOpens = false;

  // 5. rebind: a2 (still frozen) moves to pB and becomes active; a1 stays frozen
  const r3 = await api("POST", "/api/admin/accounts/a2/proxy-rebind", {});
  assert.equal(r3.status, 200, JSON.stringify(r3));
  assert.equal(r3.data.oldProxyId, pA); assert.equal(r3.data.newProxyId, pB);
  assert.equal(status("a2").status, "active"); assert.equal(status("a2").b, pB); assert.equal(status("a2").s, null);
  assert.equal(events("account_proxy_released", "a2"), 1);
  assert.equal(status("a1").status, "proxy_down");

  // 6. the provider moves the exit IP of pB → a2 frozen with the old → new IP in the reason; the new exit is recorded
  recordNodeProxyExit("fz-node", pB, "198.51.100.12");
  assert.equal(status("a2").status, "proxy_down");
  assert.match(status("a2").r, /198\.51\.100\.11 → 198\.51\.100\.12/);
  assert.equal(one("SELECT exit_ip FROM node_proxies WHERE id=?", pB).exit_ip, "198.51.100.12");
  // release accepts the new exit (proxy live, claimed by the same organization)
  const r4 = await api("POST", "/api/admin/accounts/a2/proxy-release", {});
  assert.equal(r4.status, 200, JSON.stringify(r4));
  assert.equal(status("a2").status, "active");

  // 7. dashboard / list counters
  const dash = await api("GET", "/api/admin/dashboard");
  assert.equal(dash.data.accounts.proxyDown, 1);
  assert.ok(dash.data.accounts.proxyDownOldestSince);
  const list = await api("GET", "/api/admin/accounts?status=proxy_down");
  assert.equal(list.data.items.length, 1);
  assert.equal(list.data.counts.count, 1);
  assert.equal(core.proxyDownSummary().count, 1);
  console.log("proxy-freeze: ALL PASSED");
} finally {
  ws.terminate();
  await app.close();
  rmSync(dir, { recursive: true, force: true });
}
