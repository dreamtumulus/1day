// Quarantine semantics (docs/onboarding.md §12.1), the admin unquarantine endpoint and the
// onboarding precheck: a platform-side failure releases the slot without tainting the exit,
// an upstream verdict on a virgin exit still quarantines it, an administrator can lift a
// quarantine, and pasted keys are checked for shape and duplicates before any reservation.
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const dir = mkdtempSync(join(tmpdir(), "1dayapi-onboard-quarantine-"));
process.env.DATA_DIR = dir;
process.env.CCR_WINDOW_POLL = "0";
process.env.ALLOW_UNTRUSTED_EXECUTION = "1";
process.env.ONBOARD_MOCK = "1";
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));

const core = await import("@1dayapi/core");
const { buildApp } = await import("../dist/app.js");
const { createUser } = await import("../dist/session.js");
const { endReservation, failureTaintsExit } = await import("../dist/onboard/reservations.js");
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
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { cookie, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const j = await res.json().catch(() => ({}));
    return { status: res.status, ...j };
  };
}

const adminKey = readFileSync(join(dir, "admin-key.txt"), "utf8").trim();
const admin = await login(adminKey);
const ops = createUser("ops", "quarantine-ops");
const opsCall = await login(ops.loginKey);
const provider = createUser("provider", "quarantine-provider");
const prov = await login(provider.loginKey);
const other = createUser("provider", "quarantine-other");

// ---------- fixture: one node with two measured proxies ----------
const now = core.nowIso();
const TEAM = "33333333-3333-4333-8333-333333333333";
core.ensureUpstreamTeam(TEAM);
run("INSERT INTO nodes (node_id, provider_id, secret_hash, online, accepting_sessions, created_at) VALUES ('q-node', ?, 'h', 1, 1, ?)", provider.id, now);
const mkProxy = (id, ip) =>
  run(
    "INSERT INTO node_proxies (id, node_id, url_enc, status, isolation_version, exit_ip, resource_key, created_at) VALUES (?, 'q-node', ?, 'live', 1, ?, ?, ?)",
    id, core.encryptString(`http://u:p@${ip}:8000`), ip, `ip:${ip}`, now,
  );
mkProxy("qproxy000001", "203.0.113.11");
mkProxy("qproxy000002", "203.0.113.12");
mkProxy("qproxy000003", "203.0.113.13");

let jobN = 0;
function mkJob({ proxyId, ip, team = TEAM, wentOut = true }) {
  const id = `job-${++jobN}-${core.newId().slice(0, 8)}`;
  const future = new Date(Date.now() + 120_000).toISOString().slice(0, 19) + "Z";
  run(
    `INSERT INTO onboarding_jobs (id, requester_id, scope, method, node_id, proxy_id, status, created_at, updated_at, team_id, isolation_version, egress_started_at, proxy_resource_key, expires_at)
     VALUES (?, ?, 'admin', 'session_key', 'q-node', ?, 'working', ?, ?, ?, 1, ?, ?, ?)`,
    id, provider.id, proxyId, now, now, team, wentOut ? now : null, `ip:${ip}`, future,
  );
  return id;
}
const quarantineRows = (proxyId, ip) => all("SELECT resource_key, reason FROM proxy_quarantine WHERE resource_key IN (?, ?)", `proxy:${proxyId}`, `ip:${ip}`);

test("failure classes: platform-side codes never taint, upstream verdicts do", () => {
  for (const c of ["node_offline", "job_expired", "job_cancelled", "callback_expired", "account_exists", "proxy_pool_empty", "no_proxy_available"]) {
    assert.equal(failureTaintsExit(c), false, c);
  }
  for (const c of ["session_key_invalid", "session_stale_relogin", "authorize_failed", "token_exchange_failed", "validate_failed", "team_mismatch", "cloudflare_challenge"]) {
    assert.equal(failureTaintsExit(c), true, c);
  }
});

test("endReservation: node_offline after egress with the organization known keeps the exit for that organization", () => {
  const id = mkJob({ proxyId: "qproxy000001", ip: "203.0.113.11" });
  assert.equal(endReservation(id, "node_offline", "node egress failed"), true);
  assert.equal(one("SELECT status FROM onboarding_jobs WHERE id=?", id).status, "failed");
  assert.deepEqual(quarantineRows("qproxy000001", "203.0.113.11"), [], "exit not tainted by a platform-side failure");
  assert.equal(one("SELECT team_id FROM proxy_team_claims WHERE resource_key='ip:203.0.113.11'").team_id, TEAM, "exit reserved for the specified organization");
  const ev = all("SELECT event, reason FROM proxy_team_events WHERE job_id=? ORDER BY created_at", id);
  assert.equal(ev.some((e) => e.event === "quarantined"), false);
  assert.ok(ev.some((e) => e.event === "exit_kept_for_team"));
  const released = ev.find((e) => e.event === "slot_released");
  assert.ok(released && /node_offline/.test(released.reason) && /not tainted/.test(released.reason), JSON.stringify(ev));
});

test("endReservation: node_offline after egress with no organization known still quarantines (unknown egress)", () => {
  mkProxy("qproxy000004", "203.0.113.14");
  const id = mkJob({ proxyId: "qproxy000004", ip: "203.0.113.14", team: null });
  assert.equal(endReservation(id, "node_offline", "node egress failed"), true);
  assert.equal(quarantineRows("qproxy000004", "203.0.113.14").length, 2, "an unidentified egress cannot be attributed, so the exit is tainted");
});

test("endReservation: upstream rejection on a virgin exit quarantines proxy and exit", () => {
  const id = mkJob({ proxyId: "qproxy000002", ip: "203.0.113.12" });
  assert.equal(endReservation(id, "session_key_invalid", "authorize: HTTP 403"), true);
  const rows = quarantineRows("qproxy000002", "203.0.113.12");
  assert.equal(rows.length, 2, JSON.stringify(rows));
  assert.ok(rows.every((r) => r.reason === "session_key_invalid"));
  const ev = all("SELECT event, reason FROM proxy_team_events WHERE job_id=? ORDER BY created_at", id);
  assert.ok(ev.some((e) => e.event === "quarantined"));
  assert.ok(/exit quarantined/.test(ev.find((e) => e.event === "slot_released").reason));
});

test("endReservation: an upstream code before any egress releases without quarantine", () => {
  const id = mkJob({ proxyId: "qproxy000003", ip: "203.0.113.13", wentOut: false });
  assert.equal(endReservation(id, "session_key_invalid", "rejected before egress"), true);
  assert.deepEqual(quarantineRows("qproxy000003", "203.0.113.13"), []);
  assert.ok(/released before egress/.test(one("SELECT reason FROM proxy_team_events WHERE job_id=? AND event='slot_released'", id).reason));
});

test("unquarantine: admin lifts it, history kept, repeat is 400, unknown proxy 404, ops 403", async () => {
  // qproxy000002 was quarantined by the previous test.
  run("UPDATE node_proxies SET status='dead', last_error='exit resource quarantined' WHERE id='qproxy000002'");
  const listed = await admin("GET", "/api/admin/nodes/q-node/proxies");
  const row = listed.data.find((p) => p.id === "qproxy000002");
  assert.equal(row.quarantined, true);
  assert.equal(row.quarantineReason, "session_key_invalid");
  const picker = await admin("GET", "/api/admin/nodes/q-node/proxies?free=1");
  assert.equal(picker.data.some((p) => p.id === "qproxy000002"), false, "quarantined proxy is not offered");

  const denied = await opsCall("POST", "/api/admin/nodes/q-node/proxies/qproxy000002/unquarantine", {});
  assert.equal(denied.status, 403);

  const r = await admin("POST", "/api/admin/nodes/q-node/proxies/qproxy000002/unquarantine", {});
  assert.equal(r.status, 200, JSON.stringify(r));
  assert.equal(r.data.ok, true);
  // The verdict rows stay (append-only history); the lift is what makes the quarantine inactive.
  assert.equal(quarantineRows("qproxy000002", "203.0.113.12").length, 2);
  assert.equal(all("SELECT resource_key FROM proxy_quarantine_lifts WHERE resource_key IN ('proxy:qproxy000002','ip:203.0.113.12')").length, 2);
  const p = one("SELECT status, last_error FROM node_proxies WHERE id='qproxy000002'");
  assert.equal(p.status, "unknown");
  assert.equal(p.last_error, null);
  const ev = one("SELECT actor_id, reason FROM proxy_team_events WHERE proxy_id='qproxy000002' AND event='unquarantined'");
  assert.ok(ev, "decision recorded");
  assert.equal(ev.actor_id, one("SELECT id FROM users WHERE role='admin' ORDER BY created_at LIMIT 1").id);
  const after = await admin("GET", "/api/admin/nodes/q-node/proxies");
  assert.equal(after.data.find((x) => x.id === "qproxy000002").quarantined, false);
  assert.equal(core.boundProxyDown({ bound_proxy_id: "qproxy000002", team_id: null, node_id: "q-node" }), true, "unknown status until re-probed");
  // Re-quarantining a lifted key makes it active again.
  core.quarantineResource("proxy:qproxy000002", "test: again");
  assert.equal((await admin("GET", "/api/admin/nodes/q-node/proxies")).data.find((x) => x.id === "qproxy000002").quarantined, true);
  const lifted2 = await admin("POST", "/api/admin/nodes/q-node/proxies/qproxy000002/unquarantine", {});
  assert.equal(lifted2.status, 200);

  const again = await admin("POST", "/api/admin/nodes/q-node/proxies/qproxy000002/unquarantine", {});
  assert.equal(again.status, 400);
  assert.equal(again.error.code, "proxy_not_quarantined");
  const missing = await admin("POST", "/api/admin/nodes/q-node/proxies/nope00000000/unquarantine", {});
  assert.equal(missing.status, 404);
  const badNode = await admin("POST", "/api/admin/nodes/no-such-node/proxies/qproxy000002/unquarantine", {});
  assert.equal(badNode.status, 404);
});

// A sessionKey whose embedded account uuid is known: chars 13–35 are base64url of the 16 bytes.
function keyFor(uuid) {
  const hex = uuid.replace(/-/g, "");
  const b64 = Buffer.from(hex, "hex").toString("base64url");
  return `sk-ant-sid01-${b64}${"a".repeat(80)}`;
}

test("precheck: shape, embedded account uuid, duplicates by owner scope, admin/provider only", async () => {
  const uuidA = "0a1b2c3d-4e5f-4a6b-8c7d-8e9f0a1b2c3d";
  const uuidB = "1b2c3d4e-5f6a-4b7c-9d8e-9f0a1b2c3d4e";
  run(
    `INSERT INTO accounts (id, name, platform, type, protocol, executor, credential_enc, owner_id, route, node_id, review_status, status, account_uuid, account_email, team_id, created_at, updated_at)
     VALUES ('acc-a', 'a', 'anthropic', 'oauth', 'anthropic', 'ccr_worker', ?, NULL, 'node', 'q-node', 'approved', 'active', ?, 'a@example.com', ?, ?, ?)`,
    core.encryptJson({ accessToken: "fixture" }), uuidA, TEAM, now, now,
  );
  run(
    `INSERT INTO accounts (id, name, platform, type, protocol, executor, credential_enc, owner_id, route, node_id, review_status, status, account_uuid, account_email, created_at, updated_at)
     VALUES ('acc-b', 'b', 'anthropic', 'oauth', 'anthropic', 'ccr_worker', ?, ?, 'node', 'q-node', 'approved', 'error', ?, 'b@example.com', ?, ?)`,
    core.encryptJson({ accessToken: "fixture" }), provider.id, uuidB, now, now,
  );

  const r = await admin("POST", "/api/admin/accounts/onboard/precheck", { sessionKeys: [keyFor(uuidA), "nope", ` "${keyFor(uuidB)}" `, keyFor("ffffffff-ffff-4fff-8fff-ffffffffffff")] });
  assert.equal(r.status, 200, JSON.stringify(r));
  assert.equal(r.data.length, 4);
  assert.deepEqual(r.data[0], { index: 0, formatOk: true, accountUuid: uuidA, existing: { id: "acc-a", email: "a@example.com", status: "active", teamId: TEAM } });
  assert.deepEqual(r.data[1], { index: 1, formatOk: false, accountUuid: null, existing: null });
  assert.equal(r.data[2].formatOk, true, "surrounding quotes/blanks are stripped");
  assert.equal(r.data[2].existing.id, "acc-b");
  assert.equal(r.data[3].existing, null);

  // Provider scope sees only its own accounts.
  const p = await prov("POST", "/api/provider/accounts/onboard/precheck", { sessionKeys: [keyFor(uuidA), keyFor(uuidB)] });
  assert.equal(p.status, 200, JSON.stringify(p));
  assert.equal(p.data[0].existing, null, "platform-owned account is invisible to a provider");
  assert.equal(p.data[1].existing.id, "acc-b");
  const o = await (await login(other.loginKey))("POST", "/api/provider/accounts/onboard/precheck", { sessionKeys: [keyFor(uuidB)] });
  assert.equal(o.data[0].existing, null, "another provider's account is invisible");

  // Validation and scope.
  const empty = await admin("POST", "/api/admin/accounts/onboard/precheck", { sessionKeys: [] });
  assert.equal(empty.status, 400);
  const tooMany = await admin("POST", "/api/admin/accounts/onboard/precheck", { sessionKeys: Array.from({ length: 201 }, () => "x") });
  assert.equal(tooMany.status, 400);
  const notStrings = await admin("POST", "/api/admin/accounts/onboard/precheck", { sessionKeys: [1] });
  assert.equal(notStrings.status, 400);
  const denied = await opsCall("POST", "/api/admin/accounts/onboard/precheck", { sessionKeys: ["x"] });
  assert.equal(denied.status, 403);
  // Nothing was written.
  assert.equal(one("SELECT COUNT(*) n FROM onboarding_jobs WHERE status='working'").n, 0);
});

test.after(async () => {
  await app.close();
});

test("endReservation: proxy_quarantine_on_failure=0 releases the slot after an upstream rejection without tainting the exit", () => {
  core.setSetting("proxy_quarantine_on_failure", "0");
  try {
    mkProxy("qproxy000009", "203.0.113.19");
    const id = mkJob({ proxyId: "qproxy000009", ip: "203.0.113.19" });
    assert.equal(endReservation(id, "session_key_invalid", "authorize: HTTP 403"), true);
    assert.deepEqual(quarantineRows("qproxy000009", "203.0.113.19"), [], "quarantine on failure disabled: exit untouched");
    const ev = all("SELECT event, reason FROM proxy_team_events WHERE job_id=? ORDER BY created_at", id);
    assert.equal(ev.some((e) => e.event === "quarantined"), false);
    assert.ok(/quarantine on failure disabled/.test(ev.find((e) => e.event === "slot_released").reason), JSON.stringify(ev));
  } finally {
    core.setSetting("proxy_quarantine_on_failure", "1");
  }
});
