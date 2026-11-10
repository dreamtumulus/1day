// Review fixes 2026-11-10 (control plane): shared-proxy heartbeats, node removal, identity alerts, account
// reactivation, onboarder token organizations, audit redaction, SSH host key pin, internal routes behind a reverse
// proxy, restart hygiene, bind / download codes. Everything runs against a temp DATA_DIR with fake sockets — no node,
// no SSH connection and no upstream is ever contacted.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const dir = mkdtempSync(join(tmpdir(), "1dayapi-review-1110-"));
process.env.DATA_DIR = dir;
process.env.CCR_WINDOW_POLL = "0";
process.env.NODE_LINK_GRACE_MS = "0";
process.env.ONBOARD_MOCK = "1";
process.env.ONBOARD_PROFILE_FETCH = "0";
delete process.env.ALLOW_UNTRUSTED_EXECUTION;
process.env.TRUSTED_EXECUTION_NODE_IDS = "t-home,t-share,r-home,r-other";
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));

const core = await import("@1dayapi/core");
const { run, one, all, nowIso, sha256Hex } = core;
const { createUser } = await import("../dist/session.js");
const proxies = await import("../dist/node/proxies.js");
const reg = await import("../dist/node/registry.js");
const deploy = await import("../dist/node/deploy.js");
const audit = await import("../dist/audit.js");
const { resetLogLimits } = await import("../dist/log-limit.js");

const now = nowIso();
const P1 = createUser("provider", "rf-provider-1");
const P2 = createUser("provider", "rf-provider-2");
const TEAM = "55555555-5555-4555-8555-555555555555";
core.ensureUpstreamTeam(TEAM);
const mkNode = (id, providerId, name = id, secret = "sec") =>
  run("INSERT INTO nodes (node_id, provider_id, secret_hash, online, in_flight, accepting_sessions, deploy_meta, created_at) VALUES (?, ?, ?, 1, 0, 1, ?, ?)", id, providerId, sha256Hex(secret), JSON.stringify({ name }), now);
const pid = (url) => sha256Hex(url).slice(0, 12);
const mkAccount = (id, nodeId, proxyId, extra = {}) =>
  run(`INSERT INTO accounts(id,name,platform,type,protocol,executor,credential_enc,owner_id,route,node_id,review_status,bound_proxy_id,team_id,status,created_at,updated_at)
    VALUES (?,?,'anthropic','oauth','anthropic','ccr_worker',?,?,?,?,?,?,?,?,?,?)`, id, extra.name ?? id, core.encryptJson({ accessToken: "x" }), extra.ownerId ?? null,
    nodeId ? "node" : "direct", nodeId, extra.review ?? "approved", proxyId, extra.team === undefined ? TEAM : extra.team, extra.status ?? "active", now, now);
const acc = (id) => one("SELECT * FROM accounts WHERE id=?", id);
const captured = (method, fn) => {
  const orig = console[method]; const lines = [];
  console[method] = (...a) => { lines.push(a.map(String).join(" ")); };
  try { fn(); } finally { console[method] = orig; }
  return lines;
};

// ---------- state left behind by a "previous process" (item 9), written before the app boots ----------
mkNode("boot-node", P1.id);
run("UPDATE nodes SET in_flight = 7 WHERE node_id='boot-node'");
proxies.replaceNodeProxies("boot-node", [{ url: "socks5://u:p@198.51.100.50:1080" }]);
const bootProxy = pid("socks5://u:p@198.51.100.50:1080");
run(`INSERT INTO onboarding_jobs (id, requester_id, scope, method, node_id, proxy_id, status, isolation_version, proxy_resource_key, egress_started_at, created_at, updated_at)
  VALUES ('job-working', ?, 'admin', 'session_key', 'boot-node', ?, 'working', 1, 'ip:198.51.100.50', ?, ?, ?)`, P1.id, bootProxy, now, now, now);
run(`INSERT INTO onboarding_jobs (id, requester_id, scope, method, node_id, proxy_id, status, isolation_version, proxy_resource_key, created_at, updated_at)
  VALUES ('job-waiting', ?, 'admin', 'auth_url', 'boot-node', ?, 'pending_callback', 1, 'ip:198.51.100.50', ?, ?)`, P1.id, bootProxy, now, now);

const { buildApp } = await import("../dist/app.js");
const app = await buildApp();
await app.listen({ port: 0, host: "127.0.0.1" });
const BASE = `http://127.0.0.1:${app.server.address().port}`;

async function raw(method, path, body, headers = {}) {
  const res = await fetch(`${BASE}${path}`, { method, headers: { ...(body ? { "content-type": "application/json" } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  const j = await res.json().catch(() => ({}));
  return { status: res.status, ...j };
}
async function login(key) {
  const r = await fetch(`${BASE}/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key }) });
  assert.equal(r.status, 200);
  const cookie = (r.headers.get("set-cookie") ?? "").split(";")[0];
  return (method, path, body) => raw(method, path, body, { cookie });
}
const admin = await login(readFileSync(join(dir, "admin-key.txt"), "utf8").trim());
const prov1 = await login(P1.loginKey);
const adminUser = one("SELECT id FROM users WHERE role='admin' LIMIT 1");

class FakeSocket extends EventEmitter {
  readyState = 1; sent = []; bufferedAmount = 0;
  send(s) { this.sent.push(JSON.parse(s)); }
  ping() {}
  terminate() { this.readyState = 3; this.emit("close"); }
  close() { this.readyState = 3; }
  fromNode(msg) { this.emit("message", Buffer.from(JSON.stringify(msg))); }
}
function connect(nodeId, providerId) {
  const sock = new FakeSocket();
  reg.attachNode(nodeId, providerId, sock);
  sock.fromNode({ type: "provider.hello", nodeId, nodeVersion: "test", capabilities: ["team_isolation_v1"], acceptingSessions: true });
  return sock;
}
const beat = (sock, body) => sock.fromNode({ type: "provider.heartbeat", inFlight: 0, acceptingSessions: true, ...body });

test("restart hygiene: interrupted working jobs fail as console_restarted without quarantining the exit; nodes start offline", () => {
  const j = one("SELECT status, error FROM onboarding_jobs WHERE id='job-working'");
  assert.equal(j.status, "failed");
  assert.match(j.error, /^console_restarted:/);
  assert.equal(one("SELECT COUNT(*) n FROM proxy_quarantine WHERE resource_key IN ('ip:198.51.100.50', ?)", `proxy:${bootProxy}`).n, 0, "the exit is not quarantined");
  assert.equal(one("SELECT COUNT(*) n FROM proxy_team_events WHERE job_id='job-working' AND event='slot_released'").n, 1, "the reservation is released, with an event");
  assert.equal(one("SELECT COUNT(*) n FROM proxy_team_events WHERE job_id='job-working' AND event='quarantined'").n, 0);
  assert.equal(proxies.proxyOccupancy("ip:198.51.100.50", "job-waiting").reserved, 0, "the slot is free again");
  assert.equal(one("SELECT status FROM onboarding_jobs WHERE id='job-waiting'").status, "pending_callback", "a job waiting for the operator survives a restart");
  const n = one("SELECT online, in_flight FROM nodes WHERE node_id='boot-node'");
  assert.deepEqual({ online: n.online, in_flight: n.in_flight }, { online: 0, in_flight: 0 });
});

// ---------- item 1: heartbeats on a shared proxy ----------
const shUrl = "socks5://u:p@198.51.100.60:1080";
const SH = pid(shUrl);
const A_HOME = "aaaaaaaa-0000-4000-8000-000000000001", A_SHARE = "aaaaaaaa-0000-4000-8000-000000000002", A_UNTR = "aaaaaaaa-0000-4000-8000-000000000003";
for (const [id, p] of [["t-home", P1.id], ["t-share", P1.id], ["u-share", P1.id], ["u-home", P1.id]]) mkNode(id, p);
proxies.replaceNodeProxies("t-home", [{ url: shUrl }]);
proxies.addNodeProxies("t-share", [{ url: shUrl }]);
proxies.addNodeProxies("u-share", [{ url: shUrl }]);
const untrustedUrl = "socks5://u:p@198.51.100.61:1080";
proxies.replaceNodeProxies("u-home", [{ url: untrustedUrl }]);
core.claimProxyResource("ip:198.51.100.60", TEAM); core.claimProxyResource(`proxy:${SH}`, TEAM);
assert.equal(proxies.recordNodeProxyExit("t-home", SH, "198.51.100.60"), true);
run("UPDATE node_proxies SET status='live', team_id=? WHERE id=?", TEAM, SH);
run("UPDATE node_proxies SET status='live' WHERE id=?", pid(untrustedUrl));
mkAccount(A_HOME, "t-home", SH); mkAccount(A_SHARE, "t-share", SH); mkAccount(A_UNTR, "u-home", pid(untrustedUrl));
const sockHome = connect("t-home", P1.id), sockShare = connect("t-share", P1.id), sockUShare = connect("u-share", P1.id), sockUHome = connect("u-home", P1.id);
const thaw = (id) => run("UPDATE accounts SET status='active', error_message=NULL, proxy_down_since=NULL, proxy_down_reason=NULL, proxy_down_proxy_id=NULL WHERE id=?", id);
const proxyRow = (id) => one("SELECT status, exit_ip, last_error FROM node_proxies WHERE id=?", id);

test("a sharing node's dead report freezes only its own accounts and leaves the home row alone", () => {
  resetLogLimits();
  const lines = captured("warn", () => beat(sockShare, { proxies: [{ id: SH, live: false, error: "connect timeout" }] }));
  assert.equal(acc(A_SHARE).status, "proxy_down", "the reporting node's account is frozen");
  assert.equal(acc(A_HOME).status, "active", "the home node's account is untouched");
  assert.equal(proxyRow(SH).status, "live", "the home row keeps the home node's verdict");
  assert.equal(reg.sharerProxyView("t-share", SH).live, false, "the sharer's own view is remembered");
  assert.equal(proxies.listNodeProxies("t-share").find((p) => p.id === SH).localView.live, false);
  assert.equal(proxies.listNodeProxies("t-home").find((p) => p.id === SH).localView, null);
  assert.ok(lines.some((l) => /proxy report ignored for the row: sharing node t-share/.test(l)), "the ignored row update is logged");
  thaw(A_SHARE);
});

test("a sharing node that measures another exit IP changes nothing and freezes nobody", () => {
  resetLogLimits();
  const lines = captured("warn", () => beat(sockShare, { proxies: [{ id: SH, live: true, exitIp: "203.0.113.77" }] }));
  assert.equal(proxyRow(SH).exit_ip, "198.51.100.60");
  assert.equal(acc(A_SHARE).status, "active");
  assert.equal(acc(A_HOME).status, "active");
  assert.ok(lines.some((l) => /sharing node t-share measured exit 203\.0\.113\.77/.test(l)));
  // the same through the function a heartbeat would call
  assert.equal(proxies.recordNodeProxyExit("t-share", SH, "203.0.113.78"), true);
  assert.equal(proxyRow(SH).exit_ip, "198.51.100.60");
  assert.equal(one("SELECT COUNT(*) n FROM accounts WHERE status='proxy_down'").n, 0);
});

test("an untrusted node never freezes: sharer report ignored, home report only updates its own row", () => {
  resetLogLimits();
  beat(sockUShare, { proxies: [{ id: SH, live: false, error: "boom" }] });
  assert.equal(acc(A_SHARE).status, "active");
  assert.equal(acc(A_HOME).status, "active");
  assert.equal(proxyRow(SH).status, "live");
  const lines = captured("warn", () => beat(sockUHome, { proxies: [{ id: pid(untrustedUrl), live: false, error: "boom" }, { id: "feedfacecafe", live: false }] }));
  assert.equal(proxyRow(pid(untrustedUrl)).status, "dead", "the home row records the verdict");
  assert.equal(acc(A_UNTR).status, "active", "but an untrusted node's verdict freezes nothing");
  assert.ok(lines.some((l) => /not a trusted execution node/.test(l)));
  assert.ok(lines.some((l) => /feedfacecafe is not in node u-home's pool/.test(l)), "a report for a proxy outside the pool is logged and ignored");
});

test("the trusted home node's dead report freezes its own accounts only", () => {
  beat(sockHome, { proxies: [{ id: SH, live: false, error: "refused" }] });
  assert.equal(proxyRow(SH).status, "dead");
  assert.equal(acc(A_HOME).status, "proxy_down");
  assert.equal(acc(A_SHARE).status, "active", "the sharing node's account waits for its own node's verdict");
  beat(sockHome, { proxies: [{ id: SH, live: true, exitIp: "198.51.100.60" }] });
  assert.equal(proxyRow(SH).status, "live");
  thaw(A_HOME);
});

// ---------- item 3: silent skips ----------
test("assignments: an untrusted or all-mismatched report no longer deletes the node's mappings", () => {
  resetLogLimits();
  const A_HOME2 = "aaaaaaaa-0000-4000-8000-000000000004";
  mkAccount(A_HOME2, "t-home", SH);
  run("INSERT INTO node_proxy_assignments(node_id, account_id, proxy_id, updated_at) VALUES ('t-home', ?, ?, ?), ('t-home', ?, ?, ?)", A_HOME, SH, now, A_HOME2, SH, now);
  run("INSERT INTO node_proxy_assignments(node_id, account_id, proxy_id, updated_at) VALUES ('u-home', ?, ?, ?)", A_UNTR, pid(untrustedUrl), now);
  const count = (n) => one("SELECT COUNT(*) n FROM node_proxy_assignments WHERE node_id=?", n).n;
  let lines = captured("warn", () => beat(sockHome, { assignments: { "not-an-account": SH, [A_HOME]: "wrongproxy00" } }));
  assert.equal(count("t-home"), 2, "nothing valid in the report: mappings kept");
  assert.ok(lines.some((l) => /assignments report from t-home: 2 entries ignored/.test(l)));
  beat(sockHome, { assignments: {} });
  assert.equal(count("t-home"), 2, "an empty report deletes nothing");
  lines = captured("warn", () => beat(sockUHome, { assignments: { [A_UNTR]: "zzz" } }));
  assert.equal(count("u-home"), 1, "untrusted node: mappings kept");
  assert.ok(lines.some((l) => /assignments report ignored: node u-home is not a trusted execution node/.test(l)));
  beat(sockHome, { assignments: { [A_HOME]: SH } });
  assert.deepEqual(all("SELECT account_id FROM node_proxy_assignments WHERE node_id='t-home'").map((r) => r.account_id), [A_HOME], "a valid trusted report still prunes what it no longer lists");
  run("DELETE FROM accounts WHERE id=?", A_HOME2);
});

test("device identity mismatch: ALERT line, counter, persistent event, admin endpoint; the report is not applied", async () => {
  resetLogLimits();
  const registered = "a".repeat(64), reported = "b".repeat(64);
  run("UPDATE accounts SET device_id=? WHERE id=?", registered, A_HOME);
  const before = reg.identityHealth().mismatches;
  const lines = captured("warn", () => {
    beat(sockHome, { ccIdentities: { [A_HOME]: { deviceId: reported, teamId: TEAM } } });
    beat(sockHome, { ccIdentities: { [A_HOME]: { deviceId: reported, teamId: TEAM } } });
  });
  assert.equal(acc(A_HOME).device_id, registered, "the registered identity stays");
  const alerts = lines.filter((l) => l.includes("ALERT device identity mismatch"));
  assert.equal(alerts.length, 1, "logged once per account per 10 minutes");
  assert.equal(alerts[0], `[registry] ALERT device identity mismatch node=t-home account=${A_HOME.slice(0, 8)} reported=bbbbbbbb registered=aaaaaaaa kind=device`);
  const h = reg.identityHealth();
  assert.equal(h.mismatches, before + 2, "every mismatching report is counted");
  assert.equal(h.byKind.device, 2);
  assert.equal(h.recent[0].accountId, A_HOME);
  assert.equal(one("SELECT COUNT(*) n FROM proxy_team_events WHERE event='device_identity_mismatch' AND account_id=?", A_HOME).n, 1);
  // another account's device, and a wrong organization
  resetLogLimits();
  const l2 = captured("warn", () => beat(sockShare, { ccIdentities: { [A_SHARE]: { deviceId: registered, teamId: TEAM } } }));
  assert.ok(l2.some((l) => /kind=device_in_use/.test(l)));
  assert.equal(acc(A_SHARE).device_id, null);
  resetLogLimits();
  const l3 = captured("warn", () => beat(sockShare, { ccIdentities: { [A_SHARE]: { deviceId: "c".repeat(64), teamId: "66666666-6666-4666-8666-666666666666" } } }));
  assert.ok(l3.some((l) => /kind=team/.test(l)));
  // a clean report is still applied
  beat(sockShare, { ccIdentities: { [A_SHARE]: { deviceId: "d".repeat(64), teamId: TEAM } } });
  assert.equal(acc(A_SHARE).device_id, "d".repeat(64));
  const r = await admin("GET", "/api/admin/health/identity");
  assert.equal(r.status, 200);
  assert.equal(r.data.mismatches, before + 4);
  assert.equal(r.data.byKind.team, 1);
  assert.ok(r.data.recent.length >= 3 && r.data.recent.every((m) => m.reported.length <= 8 && m.registered.length <= 8), "identities are truncated");
  assert.ok(r.data.events.length >= 3);
  assert.equal((await prov1("GET", "/api/admin/health/identity")).status, 403, "administrators only");
});

test("an undecryptable proxy row is logged once by id (never the URL); recordAudit failures are logged, not swallowed", () => {
  run("INSERT INTO node_proxies (id, node_id, url_enc, status, isolation_version) VALUES ('brokenrow0001', 't-home', 'not-a-ciphertext', 'unknown', 1)");
  let lines = captured("error", () => { proxies.nodeProxyUrls("t-home"); proxies.nodeProxyUrls("t-home"); });
  assert.deepEqual(proxies.nodeProxyUrls("t-home"), [shUrl]);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /proxy brokenrow0001 .* cannot be decrypted/);
  assert.ok(!lines[0].includes("198.51.100"));
  run("DELETE FROM node_proxies WHERE id='brokenrow0001'");
  lines = captured("error", () => {
    audit.recordAudit({ userId: null, role: null, method: null, path: "/x", status: 200, ip: null, summary: {} });
    audit.recordAudit({ userId: null, role: null, method: null, path: "/x", status: 200, ip: null, summary: {} });
  });
  assert.equal(lines.length, 1, "at most one line per minute");
  assert.match(lines[0], /^\[audit\] 1 audit record\(s\) not written \(last: /);
});

// ---------- item 2: node removal ----------
test("node removal: refused while other nodes share its proxies; admin force freezes their accounts, cleans shares, writes events", async () => {
  mkNode("r-home", P1.id, "worker-home", "home-secret"); mkNode("r-other", P2.id, "worker-other");
  const rUrl = "socks5://u:p@198.51.100.70:1080", rUrl2 = "socks5://u:p@198.51.100.71:1080", oUrl = "socks5://u:p@198.51.100.72:1080";
  const R = pid(rUrl), R2 = pid(rUrl2), O = pid(oUrl);
  proxies.replaceNodeProxies("r-home", [{ url: rUrl }, { url: rUrl2 }]);
  proxies.replaceNodeProxies("r-other", [{ url: oUrl }]);
  proxies.addNodeProxies("r-other", [{ url: rUrl }]); // r-home's proxy shared out
  proxies.addNodeProxies("r-home", [{ url: oUrl }]);  // a share r-home holds
  run("UPDATE node_proxies SET status='live' WHERE id IN (?,?,?)", R, R2, O);
  const OWN = "bbbbbbbb-0000-4000-8000-000000000001", FOREIGN = "bbbbbbbb-0000-4000-8000-000000000002";
  mkAccount(OWN, "r-home", R2, { name: "own-acc" }); mkAccount(FOREIGN, "r-other", R, { name: "foreign-acc" });

  // provider: never, whatever is sent
  for (const path of ["/api/provider/nodes/r-home", "/api/provider/nodes/r-home?force=1"]) {
    const r = await prov1("DELETE", path);
    assert.equal(r.status, 409, JSON.stringify(r));
    assert.equal(r.error.code, "node_shared_with_other_nodes");
    assert.equal(r.error.details.forceable, "admin_force");
  }
  // the node itself: never either
  const self = await raw("POST", "/internal/provider/unbind", { force: true }, { "x-provider-node-id": "r-home", "x-provider-node-secret": "home-secret" });
  assert.equal(self.status, 409, JSON.stringify(self));
  // administrator without force: refused, with the list
  const refused = await admin("DELETE", "/api/admin/nodes/r-home");
  assert.equal(refused.status, 409);
  assert.equal(refused.error.code, "node_shared_with_other_nodes");
  assert.deepEqual(refused.error.details.otherNodeAccounts.map((a) => [a.id, a.name, a.nodeId, a.nodeName]), [[FOREIGN, "foreign-acc", "r-other", "worker-other"]]);
  assert.deepEqual(refused.error.details.sharedWith, [{ proxyId: R, nodeId: "r-other", nodeName: "worker-other" }]);
  assert.deepEqual(refused.error.details.accounts.map((a) => a.id), [OWN]);
  assert.match(refused.error.message, /worker-other/);
  assert.equal(acc(OWN).status, "active"); assert.equal(acc(FOREIGN).status, "active");
  assert.ok(one("SELECT 1 FROM nodes WHERE node_id='r-home'"), "nothing was removed");

  const ok = await admin("DELETE", "/api/admin/nodes/r-home?force=1");
  assert.equal(ok.status, 200, JSON.stringify(ok));
  assert.deepEqual(ok.data.disabledAccounts, [OWN]);
  assert.deepEqual(ok.data.frozenAccounts, [FOREIGN]);
  const own = acc(OWN), foreign = acc(FOREIGN);
  assert.deepEqual([own.status, own.node_id, own.bound_proxy_id], ["disabled", null, null]);
  assert.equal(foreign.node_id, "r-other", "an account of another node keeps its node");
  assert.equal(foreign.status, "proxy_down", "…and is frozen, not disabled");
  assert.match(foreign.proxy_down_reason, /home node r-home of the shared proxy/);
  assert.deepEqual([foreign.bound_proxy_id, foreign.proxy_down_proxy_id], [null, R], "the binding cannot outlive the proxy row; the old proxy stays on record");
  // the freeze cannot be "released" onto nothing, nor switched on by the generic toggle: only a rebind brings it back
  const rel = await admin("POST", `/api/admin/accounts/${FOREIGN}/proxy-release`, {});
  assert.deepEqual([rel.status, rel.error?.code], [400, "proxy_missing"], JSON.stringify(rel));
  assert.equal((await admin("PATCH", `/api/admin/accounts/${FOREIGN}`, { status: "active" })).error?.code, "proxy_down_use_release");
  assert.equal(acc(FOREIGN).status, "proxy_down");
  assert.equal(one("SELECT COUNT(*) n FROM proxy_team_events WHERE event='account_unbound_node_removed' AND account_id=?", OWN).n, 1);
  assert.equal(one("SELECT COUNT(*) n FROM proxy_team_events WHERE event='account_share_lost_node_removed' AND account_id=? AND actor_id=?", FOREIGN, adminUser.id).n, 1);
  assert.equal(one("SELECT COUNT(*) n FROM proxy_team_events WHERE event='proxy_unshared' AND proxy_id=? AND node_id='r-other'", R).n, 1);
  assert.equal(one("SELECT COUNT(*) n FROM node_proxy_shares WHERE node_id='r-home' OR proxy_id IN (?,?)", R, R2).n, 0, "no share row of the deleted node is left");
  assert.equal(one("SELECT COUNT(*) n FROM node_proxies WHERE node_id='r-home'").n, 0);
  assert.equal(one("SELECT COUNT(*) n FROM node_proxies WHERE id=?", O).n, 1, "the other node's own proxy stays");
});

test("node removal by its provider / by the node: refused while it carries accounts, own accounts can be forced", async () => {
  mkNode("p-own", P1.id, "p-own", "own-secret");
  const OWN = "bbbbbbbb-0000-4000-8000-000000000003";
  mkAccount(OWN, "p-own", null, { ownerId: P1.id });
  const refused = await prov1("DELETE", "/api/provider/nodes/p-own");
  assert.equal(refused.status, 409);
  assert.equal(refused.error.code, "node_has_dependents");
  assert.equal(refused.error.details.forceable, "force");
  const self = await raw("POST", "/internal/provider/unbind", undefined, { "x-provider-node-id": "p-own", "x-provider-node-secret": "own-secret" });
  assert.equal(self.status, 409);
  assert.equal(acc(OWN).status, "active");
  const ok = await prov1("DELETE", "/api/provider/nodes/p-own?force=1");
  assert.equal(ok.status, 200, JSON.stringify(ok));
  assert.equal(acc(OWN).status, "disabled");
  assert.equal(one("SELECT COUNT(*) n FROM proxy_team_events WHERE event='account_unbound_node_removed' AND account_id=? AND actor_id=?", OWN, P1.id).n, 1);
});

// ---------- item 4: reactivation ----------
test("provider may only switch its own disable back on; never out of proxy_down or an administrator's disable", async () => {
  const mk = (id, extra = {}) => run(`INSERT INTO accounts(id,name,platform,type,protocol,credential_enc,owner_id,route,review_status,status,created_at,updated_at)
    VALUES (?,?,'openai','apikey','openai',?,?,'direct',?,?,?,?)`, id, id, core.encryptJson({ apiKey: "k" }), P1.id, extra.review ?? "approved", extra.status ?? "active", now, now);
  mk("pa-1"); mk("pa-2"); mk("pa-3"); mk("pa-4", { status: "disabled" });
  // own disable ↔ enable
  let r = await prov1("PATCH", "/api/provider/accounts/pa-1", { status: "disabled" });
  assert.equal(r.status, 200, JSON.stringify(r));
  assert.equal(acc("pa-1").status, "disabled");
  r = await prov1("PATCH", "/api/provider/accounts/pa-1", { status: "active" });
  assert.equal(r.status, 200, JSON.stringify(r));
  assert.deepEqual([acc("pa-1").status, acc("pa-1").error_message], ["active", null]);
  // administrator's disable: not the provider's to undo — also after the provider "disables" it again
  assert.equal((await admin("PATCH", "/api/admin/accounts/pa-2", { status: "disabled" })).status, 200);
  r = await prov1("PATCH", "/api/provider/accounts/pa-2", { status: "active" });
  assert.equal(r.status, 403, JSON.stringify(r));
  assert.equal(r.error.code, "disabled_by_platform");
  await prov1("PATCH", "/api/provider/accounts/pa-2", { status: "disabled" });
  assert.equal((await prov1("PATCH", "/api/provider/accounts/pa-2", { status: "active" })).status, 403);
  assert.equal(acc("pa-2").status, "disabled");
  // provider disabled, then an administrator disabled as well: the administrator's decision wins
  await prov1("PATCH", "/api/provider/accounts/pa-1", { status: "disabled" });
  await admin("PATCH", "/api/admin/accounts/pa-1", { status: "disabled" });
  assert.equal((await prov1("PATCH", "/api/provider/accounts/pa-1", { status: "active" })).status, 403);
  // frozen: no status change at all
  run("UPDATE accounts SET status='proxy_down', proxy_down_since=?, proxy_down_reason='dead', error_message='proxy_down: dead' WHERE id='pa-3'", now);
  for (const status of ["active", "disabled"]) {
    r = await prov1("PATCH", "/api/provider/accounts/pa-3", { status });
    assert.equal(r.status, 409, JSON.stringify(r));
    assert.equal(r.error.code, "proxy_down_use_release");
  }
  assert.equal(acc("pa-3").status, "proxy_down");
  // …and the administrator's generic switch does not thaw it through disable → enable either
  await admin("PATCH", "/api/admin/accounts/pa-3", { status: "disabled" });
  r = await admin("PATCH", "/api/admin/accounts/pa-3", { status: "active" });
  assert.equal(r.error?.code, "proxy_down_use_release");
  // the way back for such an account is still proxy-release: no proxy here, so it is refused with the reason
  r = await admin("POST", "/api/admin/accounts/pa-3/proxy-release", {});
  assert.deepEqual([r.status, r.error?.code], [400, "proxy_missing"]);
  // …and with a live, schedulable proxy the marker is cleared and the enable switch works again
  mkAccount("cccccccc-0000-4000-8000-000000000001", "t-home", SH, { status: "disabled" });
  run("UPDATE accounts SET proxy_down_since=?, proxy_down_reason='dead' WHERE id='cccccccc-0000-4000-8000-000000000001'", now);
  core.recordProxyTeamEvent({ resourceKey: "ip:198.51.100.60", proxyId: SH, nodeId: "t-home", teamId: TEAM, accountId: "cccccccc-0000-4000-8000-000000000001", event: "account_bound", reason: "fixture" });
  assert.equal((await admin("PATCH", "/api/admin/accounts/cccccccc-0000-4000-8000-000000000001", { status: "active" })).error?.code, "proxy_down_use_release");
  r = await admin("POST", "/api/admin/accounts/cccccccc-0000-4000-8000-000000000001/proxy-release", {});
  assert.equal(r.status, 200, JSON.stringify(r));
  assert.deepEqual([acc("cccccccc-0000-4000-8000-000000000001").status, acc("cccccccc-0000-4000-8000-000000000001").proxy_down_since], ["disabled", null]);
  assert.equal((await admin("PATCH", "/api/admin/accounts/cccccccc-0000-4000-8000-000000000001", { status: "active" })).status, 200);
  run("DELETE FROM accounts WHERE id='cccccccc-0000-4000-8000-000000000001'");
  // disabled with no trace of who did it: not the provider's
  assert.equal((await prov1("PATCH", "/api/provider/accounts/pa-4", { status: "active" })).status, 403);
  // legacy rows (disabled by the provider before the mark existed): the audit trail decides
  await admin("PATCH", "/api/admin/accounts/pa-4", { status: "active" });
  await prov1("PATCH", "/api/provider/accounts/pa-4", { status: "disabled" });
  run("UPDATE accounts SET error_message = NULL WHERE id='pa-4'");
  r = await prov1("PATCH", "/api/provider/accounts/pa-4", { status: "active" });
  assert.equal(r.status, 200, JSON.stringify(r));
});

test("review approve: only a pending account, and never out of proxy_down / disabled", async () => {
  const mk = (id, status, review) => run(`INSERT INTO accounts(id,name,platform,type,protocol,credential_enc,owner_id,route,review_status,status,error_message,proxy_down_since,created_at,updated_at)
    VALUES (?,?,'openai','apikey','openai',?,?,'direct',?,?,?,?,?,?)`, id, id, core.encryptJson({ apiKey: "k" }), P1.id, review, status,
    status === "active" ? null : `${status}: reason`, status === "proxy_down" ? now : null, now, now);
  mk("rv-approved", "disabled", "approved"); mk("rv-rejected", "disabled", "rejected"); mk("rv-frozen", "proxy_down", "pending"); mk("rv-disabled", "disabled", "pending"); mk("rv-error", "error", "pending");
  for (const id of ["rv-approved", "rv-rejected"]) {
    const r = await admin("POST", `/api/admin/accounts/${id}/review`, { action: "approve" });
    assert.equal(r.status, 409, JSON.stringify(r));
    assert.equal(r.error.code, "review_not_pending");
    assert.equal(acc(id).status, "disabled");
  }
  for (const [id, status] of [["rv-frozen", "proxy_down"], ["rv-disabled", "disabled"]]) {
    const r = await admin("POST", `/api/admin/accounts/${id}/review`, { action: "approve" });
    assert.equal(r.status, 200, JSON.stringify(r));
    const a = acc(id);
    assert.deepEqual([a.review_status, a.status, a.error_message], ["approved", status, `${status}: reason`]);
  }
  const r = await admin("POST", "/api/admin/accounts/rv-error/review", { action: "approve" });
  assert.equal(r.status, 200);
  assert.deepEqual([acc("rv-error").review_status, acc("rv-error").status, acc("rv-error").error_message], ["approved", "active", null]);
});

// ---------- item 5: onboarder token organizations ----------
test("an onboarder token limited to organizations fails closed when they are disabled or deleted", async () => {
  mkNode("onb-node", adminUser.id);
  const ORG_UUID = "77777777-7777-4777-8777-777777777777", OTHER_UUID = "88888888-8888-4888-8888-888888888888";
  let r = await admin("POST", "/api/admin/onboard/orgs", { name: "Org7", orgUuid: ORG_UUID });
  assert.equal(r.status, 201, JSON.stringify(r));
  const orgId = r.data.id;
  r = await admin("POST", "/api/admin/onboard-tokens", { label: "limited", nodeId: "onb-node", orgIds: [orgId] });
  assert.equal(r.status, 200, JSON.stringify(r));
  const tokenId = r.data.id, bearer = r.data.token;
  const onb = (body) => raw("POST", "/api/onboard/jobs", body, { authorization: `Bearer ${bearer}` });
  const jobs = () => one("SELECT COUNT(*) n FROM onboarding_jobs WHERE requester_id=?", `onb:${tokenId}`).n;
  // enabled: an organization outside the list, or none, is refused
  let j = await onb({ method: "auth_url", orgUuid: OTHER_UUID });
  assert.equal(j.status, 403, JSON.stringify(j));
  assert.equal(j.error.code, "org_required");
  j = await onb({ method: "auth_url", orgId: "nope", orgUuid: OTHER_UUID });
  assert.deepEqual([j.status, j.error.code], [403, "org_not_allowed"]);
  // disabled: the token is unusable, not unrestricted
  r = await admin("PATCH", `/api/admin/onboard/orgs/${orgId}`, { status: "disabled" });
  assert.equal(r.status, 200, JSON.stringify(r));
  for (const body of [{ method: "auth_url", orgUuid: OTHER_UUID }, { method: "auth_url", orgId, orgUuid: OTHER_UUID }, { method: "session_key", sessionKey: "sk-ant-sid01-x", orgUuid: OTHER_UUID }]) {
    j = await onb(body);
    assert.deepEqual([j.status, j.error?.code], [403, "org_not_allowed"], JSON.stringify(j));
  }
  // deleted: the same
  assert.equal((await admin("DELETE", `/api/admin/onboard/orgs/${orgId}`)).status, 200);
  j = await onb({ method: "auth_url", orgUuid: OTHER_UUID });
  assert.deepEqual([j.status, j.error?.code], [403, "org_not_allowed"]);
  // a restriction that cannot be read is a restriction to nothing
  run("UPDATE onboard_tokens SET org_ids_json = '{broken' WHERE id = ?", tokenId);
  j = await onb({ method: "auth_url", orgUuid: OTHER_UUID });
  assert.deepEqual([j.status, j.error?.code], [403, "org_not_allowed"]);
  assert.equal(jobs(), 0, "no job was ever created");
});

// ---------- item 6: audit redaction ----------
test("audit redaction: by value (proxy passwords, OAuth code/state, tokens) and by precise key names", () => {
  const { redactForAudit, redactString } = audit;
  const body = {
    proxy: "socks5://alice:s3cretPW@198.51.100.9:1080",
    proxies: [{ url: "http://bob:hunter2@proxy.example.com:8000", label: "x" }, { url: "198.51.100.10:8000:carol:pw-123" }],
    text: "dave:pw456@198.51.100.11:3128\n198.51.100.12:1080:erin:topsecret",
    callbackUrl: "https://console.example.com/oauth/code/callback?code=AUTHCODE123456&state=STATE98765",
    note: "key is sk-ant-oat01-AAAAAAAAAAAAAAAAAAAA and sk-1d-0123456789abcdef0123456789abcdef0123456789abcdef; Bearer abcdefghijklmnop",
    password: "rootpw", privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nxxx", sessionKey: "sk-ant-sid01-zzz", refreshToken: "rt",
    max_keys_per_user: 7, key_policy_auto: "1", daily_token_budget: 100, status: "disabled", groupIds: ["g1"],
  };
  const out = redactForAudit(body);
  const text = JSON.stringify(out);
  for (const secret of ["s3cretPW", "hunter2", "pw-123", "pw456", "topsecret", "AUTHCODE123456", "STATE98765", "AAAAAAAAAAAAAAAAAAAA", "0123456789abcdef", "abcdefghijklmnop", "rootpw", "OPENSSH", "sid01-zzz"]) {
    assert.ok(!text.includes(secret), `leaked ${secret}: ${text}`);
  }
  assert.equal(out.proxy, "socks5://alice:***@198.51.100.9:1080", "host and user stay readable");
  assert.equal(out.proxies[1].url, "198.51.100.10:8000:carol:***");
  assert.equal(out.callbackUrl, "https://console.example.com/oauth/code/callback?code=***&state=***");
  assert.equal(out.password, "[redacted]");
  assert.equal(out.max_keys_per_user, 7, "innocent settings are no longer redacted");
  assert.equal(out.key_policy_auto, "1");
  assert.equal(out.daily_token_budget, 100);
  assert.equal(out.status, "disabled");
  assert.equal(redactString(redactString(body.text)), redactString(body.text), "idempotent");
  assert.equal(redactString("plain note without secrets: 12:30:45"), "plain note without secrets: 12:30:45");
});

test("audit rows: proxy pool bodies are stored without passwords; the own-proxy dry run is not audited", async () => {
  mkNode("aud-node", adminUser.id);
  let r = await admin("PUT", "/api/admin/nodes/aud-node/proxies", { proxies: [{ url: "socks5://frank:PoolPassw0rd@198.51.100.80:1080" }, { url: "198.51.100.81:1080:gina:LinePassw0rd" }] });
  assert.equal(r.status, 200, JSON.stringify(r));
  const row = one("SELECT summary FROM admin_audit WHERE path='/api/admin/nodes/aud-node/proxies' ORDER BY rowid DESC LIMIT 1");
  assert.ok(row.summary.includes("198.51.100.80") && row.summary.includes("frank"));
  assert.ok(!row.summary.includes("PoolPassw0rd") && !row.summary.includes("LinePassw0rd"), row.summary);
  const before = one("SELECT COUNT(*) n FROM admin_audit").n;
  r = await admin("POST", "/api/admin/accounts/onboard/proxy", { proxy: "198.51.100.82:1080:henry:DryRunPassw0rd", nodeId: "aud-node", dryRun: true });
  assert.equal(r.status, 200, JSON.stringify(r));
  assert.equal(one("SELECT COUNT(*) n FROM admin_audit").n, before, "a dry run leaves no audit row");
  assert.equal(one("SELECT COUNT(*) n FROM admin_audit WHERE summary LIKE '%Passw0rd%'").n, 0);
});

test("one-off re-redaction script: dry run writes nothing; --apply backs up first and rewrites the rows; second run is a no-op", () => {
  const script = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "redact-audit-2026-11-10.mjs");
  const dbFile = join(dir, "audit-fixture.db"), backup = join(dir, "audit-backup.db");
  const db = new DatabaseSync(dbFile);
  db.exec("CREATE TABLE admin_audit (id TEXT PRIMARY KEY, at TEXT NOT NULL, user_id TEXT, role TEXT, method TEXT NOT NULL, path TEXT NOT NULL, status INTEGER NOT NULL, ip TEXT, summary TEXT)");
  const ins = db.prepare("INSERT INTO admin_audit VALUES (?, '2026-11-01T00:00:00Z', 'u', 'admin', 'PUT', ?, 200, NULL, ?)");
  ins.run("a1", "/api/admin/nodes/n1/proxies", JSON.stringify({ params: { id: "n1" }, body: { proxies: [{ url: "socks5://u:OldSecret1@198.51.100.90:1080" }] } }));
  ins.run("a2", "/api/admin/accounts/onboard", JSON.stringify({ body: { callbackUrl: "https://x.example/cb?code=OldCode22&state=OldState33", max_keys_per_user: "[redacted]" } }));
  ins.run("a3", "/api/admin/settings", JSON.stringify({ body: { status: "ok" } }));
  ins.run("a4", "/api/admin/nodes/n1/proxies", `{"body":{"proxies":[{"url":"198.51.100.91:1080:u:CutSecret4"},{"url":"socks5://u:Cut`); // cut at 8000 chars: not JSON any more
  db.close();
  const runScript = (...args) => execFileSync(process.execPath, [script, ...args], { encoding: "utf8", env: { ...process.env, DB_PATH: "", DATA_DIR: "" } });
  const summaries = () => { const d = new DatabaseSync(dbFile); const rows = d.prepare("SELECT id, summary FROM admin_audit ORDER BY id").all(); d.close(); return Object.fromEntries(rows.map((r) => [r.id, r.summary])); };
  assert.throws(() => execFileSync(process.execPath, [script, "--db", dbFile], { encoding: "utf8", stdio: "pipe" }), /first argument must be the VACUUM INTO backup path/);
  const dry = runScript(backup, "--db", dbFile);
  assert.match(dry, /4 audit row\(s\) with a summary, 3 to re-redact \(dry run\)/);
  assert.ok(!dry.includes("OldSecret1") && !dry.includes("OldCode22"), "the dry run never prints the old values");
  assert.equal(existsSync(backup), false, "a dry run takes no backup");
  assert.ok(summaries().a1.includes("OldSecret1"), "a dry run writes nothing");
  const applied = runScript(backup, "--db", dbFile, "--apply");
  assert.match(applied, /3 row\(s\) rewritten; 0 still differ/);
  assert.equal(existsSync(backup), true);
  const after = summaries();
  for (const s of ["OldSecret1", "OldCode22", "OldState33", "CutSecret4"]) assert.ok(!JSON.stringify(after).includes(s), `${s} still stored`);
  assert.ok(after.a1.includes("socks5://u:***@198.51.100.90:1080"));
  assert.equal(after.a3, JSON.stringify({ body: { status: "ok" } }), "clean rows are untouched");
  const b = new DatabaseSync(backup); assert.ok(b.prepare("SELECT summary FROM admin_audit WHERE id='a1'").get().summary.includes("OldSecret1"), "the backup holds the original rows"); b.close();
  assert.throws(() => execFileSync(process.execPath, [script, backup, "--db", dbFile, "--apply"], { encoding: "utf8", stdio: "pipe" }), /already exists/);
  assert.match(runScript(join(dir, "audit-backup-2.db"), "--db", dbFile, "--apply"), /0 to re-redact[\s\S]*nothing to change; no backup taken/);
});

// ---------- item 7: SSH host key pin ----------
test("SSH deploy pins host keys (accept-new, own known_hosts) and explains how to clear a changed pin", async () => {
  const opts = deploy.sshConnectionOptions(2222);
  assert.ok(opts.includes("StrictHostKeyChecking=accept-new"));
  assert.ok(!opts.includes("StrictHostKeyChecking=no") && !opts.includes("UserKnownHostsFile=/dev/null"));
  const file = deploy.sshKnownHostsPath();
  assert.equal(file, join(dir, "ssh", "known_hosts"), "pins persist under the console data dir");
  assert.ok(opts.includes(`UserKnownHostsFile=${file}`));
  const key = Buffer.from("fake-ed25519-public-key-material").toString("base64");
  writeFileSync(file, `[203.0.113.5]:2222 ssh-ed25519 ${key}\nexample-host.test ssh-ed25519 ${key}\n`);
  const fp = `SHA256:${(await import("node:crypto")).createHash("sha256").update(Buffer.from(key, "base64")).digest("base64").replace(/=+$/, "")}`;
  assert.deepEqual(deploy.sshHostPins("203.0.113.5", 2222), [{ host: "[203.0.113.5]:2222", keyType: "ssh-ed25519", fingerprint: fp }]);
  assert.deepEqual(deploy.sshHostPins("203.0.113.5", 22), []);
  assert.equal(deploy.hostKeyRejected("@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@\nHost key verification failed."), true);
  assert.equal(deploy.hostKeyRejected("[deploy] ERROR: bun installation failed"), false);
  const msg = deploy.hostKeyChangedMessage("203.0.113.5", 2222);
  assert.ok(msg.includes(fp) && msg.includes("DELETE /api/admin/nodes/ssh-host-pins?host=203.0.113.5&port=2222") && msg.includes(file));
  let r = await admin("GET", "/api/admin/nodes/ssh-host-pins");
  assert.equal(r.data.length, 2);
  assert.equal((await prov1("GET", "/api/admin/nodes/ssh-host-pins")).status, 403);
  r = await admin("DELETE", "/api/admin/nodes/ssh-host-pins?host=203.0.113.5&port=2222");
  assert.deepEqual(r.data, { removed: 1 });
  assert.deepEqual(deploy.listSshHostPins().map((p) => p.host), ["example-host.test"]);
  assert.deepEqual((await admin("DELETE", "/api/admin/nodes/ssh-host-pins?host=203.0.113.5&port=2222")).data, { removed: 0 });
});

// ---------- item 8: internal routes behind the reverse proxy ----------
test("/internal/tunnel/* refuses anything that came through a reverse proxy, even with the internal token", async () => {
  const internal = { [core.INTERNAL_HEADER]: core.internalToken };
  const direct = await raw("POST", "/internal/tunnel/reset", { isolation: null }, internal);
  assert.equal(direct.status, 400, "a local call with the token reaches the handler");
  assert.equal(direct.error.code, "invalid_isolation");
  assert.equal((await raw("POST", "/internal/tunnel/reset", { isolation: null })).status, 403, "no token");
  for (const h of [{ "x-forwarded-for": "198.51.100.200" }, { "x-real-ip": "198.51.100.200" }, { "cf-connecting-ip": "198.51.100.200" }, { forwarded: "for=198.51.100.200" }]) {
    for (const [method, path, body] of [["POST", "/internal/tunnel/open", { accountId: "x", kind: "http_egress" }], ["POST", "/internal/tunnel/reset", { isolation: null }],
      ["POST", "/internal/tunnel/s1/data", { payloadBase64: "" }], ["GET", "/internal/tunnel/s1/read?timeout=1"], ["POST", "/internal/tunnel/s1/close", {}], ["POST", "/internal/tunnel/archive", {}]]) {
      const r = await raw(method, path, body, { ...internal, ...h });
      assert.equal(r.status, 403, `${method} ${path} with ${Object.keys(h)[0]}`);
    }
    // the loopback shortcut of the bundle download is closed the same way: a forwarded request needs a code
    assert.equal((await raw("GET", "/internal/provider/cc-tui-shim", undefined, { ...internal, ...h })).status, 401);
  }
});

// ---------- item 10: bind vs download codes ----------
test("download codes cannot bind; a bind code alone cannot replace an existing node's secret", async () => {
  const mkCode = (code, providerId = P1.id) => run("INSERT INTO node_bind_codes (code, provider_id, expires_at, created_at) VALUES (?, ?, ?, ?)", code, providerId, core.isoIn(600_000), now);
  const used = (code) => one("SELECT used_at FROM node_bind_codes WHERE code=?", code).used_at;
  assert.equal(deploy.codePurpose("bind_x"), "bind"); assert.equal(deploy.codePurpose("dl_bundle_x"), "bundle"); assert.equal(deploy.codePurpose("dl_shim_x"), "shim"); assert.equal(deploy.codePurpose("x"), null);
  // a deploy's download code presented as a binding code
  mkCode("dl_bundle_00000000000000000000000000000001", adminUser.id); mkCode("dl_shim_00000000000000000000000000000002", adminUser.id);
  for (const code of ["dl_bundle_00000000000000000000000000000001", "dl_shim_00000000000000000000000000000002"]) {
    const r = await raw("POST", "/internal/provider/bind", { bindingCode: code, nodeId: "evil-node" });
    assert.equal(r.status, 401, JSON.stringify(r));
    assert.equal(used(code), null, "the download code is not even spent");
  }
  assert.equal(one("SELECT 1 FROM nodes WHERE node_id='evil-node'"), undefined);
  // each download code only fetches its own file
  assert.equal((await raw("GET", "/internal/provider/bundle?code=dl_shim_00000000000000000000000000000002")).status, 401);
  assert.equal((await raw("GET", "/internal/provider/cc-tui-shim?code=dl_bundle_00000000000000000000000000000001")).status, 401);
  assert.equal(used("dl_shim_00000000000000000000000000000002"), null);
  // a fresh node binds as before
  mkCode("bind_00000000000000000000000000000003");
  let r = await raw("POST", "/internal/provider/bind", { bindingCode: "bind_00000000000000000000000000000003", nodeId: "bind-node" });
  assert.equal(r.status, 200, JSON.stringify(r));
  const firstSecret = r.providerNodeSecret;
  const hash = () => one("SELECT secret_hash FROM nodes WHERE node_id='bind-node'").secret_hash;
  assert.equal(hash(), sha256Hex(firstSecret));
  // …but a second code alone does not re-key it
  mkCode("bind_00000000000000000000000000000004");
  r = await raw("POST", "/internal/provider/bind", { bindingCode: "bind_00000000000000000000000000000004", nodeId: "bind-node" });
  assert.equal(r.status, 409, JSON.stringify(r));
  assert.equal(r.error.code, "node_already_bound");
  assert.equal(hash(), sha256Hex(firstSecret), "the node keeps its secret");
  assert.equal(used("bind_00000000000000000000000000000004"), null, "a refused bind does not spend the code");
  r = await raw("POST", "/internal/provider/bind", { bindingCode: "bind_00000000000000000000000000000004", nodeId: "bind-node" }, { "x-provider-node-secret": "wrong" });
  assert.equal(r.status, 409);
  // proving the current secret re-keys
  r = await raw("POST", "/internal/provider/bind", { bindingCode: "bind_00000000000000000000000000000004", nodeId: "bind-node" }, { "x-provider-node-secret": firstSecret });
  assert.equal(r.status, 200, JSON.stringify(r));
  assert.equal(hash(), sha256Hex(r.providerNodeSecret));
  assert.notEqual(r.providerNodeSecret, firstSecret);
  // another provider's code still cannot take the node id
  mkCode("bind_00000000000000000000000000000005", P2.id);
  r = await raw("POST", "/internal/provider/bind", { bindingCode: "bind_00000000000000000000000000000005", nodeId: "bind-node" });
  assert.deepEqual([r.status, r.error.code], [409, "node_bound_elsewhere"]);
});

test("teardown", async () => { await app.close(); });
