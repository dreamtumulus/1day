import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";

const dir = mkdtempSync(join(tmpdir(), "1day-team-tunnel-"));
process.env.DATA_DIR = dir;
process.env.ALLOW_UNTRUSTED_EXECUTION="1";
process.env.CCR_WINDOW_POLL = "0";
process.env.NODE_LINK_GRACE_MS = "0";
const core = await import("@1dayapi/core");
const { buildApp } = await import("../dist/app.js");
const registry = await import("../dist/node/registry.js");
const { replaceNodeProxies, recordNodeProxyExit } = await import("../dist/node/proxies.js");
const { createUser } = await import("../dist/session.js");
const { run } = core;
const A = "11111111-1111-4111-8111-111111111111", B = "22222222-2222-4222-8222-222222222222";
core.ensureUpstreamTeam(A); core.ensureUpstreamTeam(B);
core.claimProxyResource("ip:198.51.100.10", A); core.claimProxyResource("ip:198.51.100.11", B);
const owner = createUser("provider", "team-fixture");
run("INSERT INTO nodes(node_id,provider_id,secret_hash) VALUES ('team-node',?,?)", owner.id, core.sha256Hex("fixture-secret"));
const urlA = "http://u:p@198.51.100.10:8000", urlB = "http://u:p@198.51.100.11:8000";
const pA = core.sha256Hex(urlA).slice(0, 12), pB = core.sha256Hex(urlB).slice(0, 12);
replaceNodeProxies("team-node", [{ url: urlA }, { url: urlB }]);
recordNodeProxyExit("team-node", pA, "198.51.100.10"); recordNodeProxyExit("team-node", pB, "198.51.100.11");
run("UPDATE node_proxies SET status='live',team_id=? WHERE id=?", A, pA);
run("UPDATE node_proxies SET status='live',team_id=? WHERE id=?", B, pB);
for (const [id, team, proxy] of [["a1", A, pA], ["a2", A, pA], ["a3", A, pA], ["b1", B, pB]]) {
  run(`INSERT INTO accounts(id,name,platform,type,protocol,executor,credential_enc,owner_id,route,node_id,review_status,bound_proxy_id,team_id)
    VALUES (?,?,'anthropic','oauth','anthropic','ccr_worker',?,?,'node','team-node','approved',?,?)`, id, id, core.encryptJson({ accessToken: "fixture" }), owner.id, proxy, team);
}
const now = core.nowIso();
run("INSERT INTO conversations(id,api_key_id,external_key,team_id,created_at,updated_at) VALUES ('c1','fixture-key','client-c1',?,?,?)", A, now, now);
const app = await buildApp();
await app.listen({ host: "127.0.0.1", port: 0 });
const ws = new WebSocket(`ws://127.0.0.1:${app.server.address().port}/internal/provider/connect`, { headers: { "x-provider-node-id": "team-node", "x-provider-node-secret": "fixture-secret" } });
const frames = [];
let acknowledgeResets = true;
let immediateCompletion = false;
let otherWs;
ws.on("message", (raw) => {
  const m = JSON.parse(raw.toString()); frames.push(m);
  if (["cc_worker.open", "http_egress.open"].includes(m.type)) {
    if (immediateCompletion) ws._socket.cork();
    ws.send(JSON.stringify({ type: m.type + "_response", sessionId: m.sessionId, accepted: true }));
    if (immediateCompletion) {
      const prefix = m.type.split(".")[0];
      ws.send(JSON.stringify({ type: prefix + ".data", sessionId: m.sessionId, seq: 0, payloadBase64: Buffer.from("early-result").toString("base64") }));
      ws.send(JSON.stringify({ type: prefix + ".close", sessionId: m.sessionId, reasonCode: "complete" }));
      ws._socket.uncork();
    }
  }
  if (m.type === "isolation.reset" && acknowledgeResets) ws.send(JSON.stringify({ type: "isolation.reset_ack", resetId: m.resetId }));
});
const waitFor = async (fn) => { const until = Date.now() + 3000; while (!fn()) { if (Date.now() > until) throw new Error("wait timeout"); await new Promise((r) => setTimeout(r, 10)); } };
await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
const hello = (capabilities, runtimeTeamId) => ws.send(JSON.stringify({ type: "provider.hello", nodeId: "team-node", providerId: owner.id, nodeVersion: "fixture", acceptingSessions: true, capabilities, runtimeTeamId }));
const iso = { teamId: A, conversationId: "c1", generation: 1 };
const worker = { model: "claude-sonnet-5-5", prompt: "fixture", stream: false, cred: { accessToken: "fixture" } };
try {
  hello(["cc_worker"]);
  await waitFor(() => frames.some((m) => m.type === "proxies.set"));
  const oldPolicy = frames.find((m) => m.type === "proxies.set");
  assert.deepEqual(oldPolicy.proxies, [], "old binaries never receive new team proxy URLs");
  assert.equal(await registry.openTunnel("a1", "cc_worker", undefined, 443, pA, worker, undefined, iso), null, "legacy node cannot accept isolated traffic");
  hello(["cc_worker", "http_egress", "team_isolation_v1"]);
  await waitFor(() => frames.filter((m) => m.type === "platform.ready").length === 2);
  const policy = frames.filter((m) => m.type === "proxies.set").at(-1);
  assert.equal(policy.proxyTeams[pA], A);
  assert.deepEqual(policy.proxyAccounts[pA].sort(), ["a1", "a2", "a3"]);
  // Legacy proxy/account/mapping rows are read-only even when a node repeats
  // old assignments and identity telemetry during a new release.
  const legacyId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  run("INSERT INTO accounts(id,name,platform,type,protocol,credential_enc,route,node_id) VALUES (?,'legacy','anthropic','oauth','anthropic',?,'node','team-node')", legacyId, core.encryptJson({accessToken:"fixture-legacy"}));
  run("INSERT INTO node_proxies(id,node_id,url_enc,status) VALUES ('legacy-proxy','team-node',?,'unknown')", core.encryptString("http://127.0.0.1:9099"));
  run("INSERT INTO node_proxy_assignments(node_id,account_id,proxy_id,updated_at) VALUES ('team-node',?,'legacy-proxy','2000-01-01T00:00:00Z')",legacyId);
  const legacyAccount = core.one("SELECT * FROM accounts WHERE id=?",legacyId);
  const legacyProxy = core.one("SELECT * FROM node_proxies WHERE id='legacy-proxy'");
  const legacyMapping = core.one("SELECT * FROM node_proxy_assignments WHERE account_id=?",legacyId);
  ws.send(JSON.stringify({type:"provider.heartbeat",acceptingSessions:true,proxies:[{id:"legacy-proxy",live:true}],assignments:{[legacyId]:pB,a1:pA},ccIdentities:{[legacyId]:{deviceId:"f".repeat(64),accountUuid:legacyId}}}));
  await new Promise((r)=>setTimeout(r,30));
  assert.deepEqual(core.one("SELECT * FROM accounts WHERE id=?",legacyId),legacyAccount);
  assert.deepEqual(core.one("SELECT * FROM node_proxies WHERE id='legacy-proxy'"),legacyProxy);
  assert.deepEqual(core.one("SELECT * FROM node_proxy_assignments WHERE account_id=?",legacyId),legacyMapping);
  assert.equal(core.one("SELECT proxy_id FROM node_proxy_assignments WHERE account_id='a1'").proxy_id,pA);
  // 2026-10-28: a heartbeat that reports a proxy alive without an exit measurement (fresh pool copy
  // after a push, or markAlive on a served request) must keep an already verified exit and must
  // not push the pool; never-measured exits are still refused, and one heartbeat costs one push.
  {
    const pushes = () => frames.filter((m) => m.type === "proxies.set").length;
    const before = pushes();
    const rowA = core.one("SELECT status,exit_ip,resource_key FROM node_proxies WHERE id=?", pA);
    assert.equal(rowA.status, "live");
    ws.send(JSON.stringify({ type: "provider.heartbeat", acceptingSessions: true, proxies: [{ id: pA, live: true, exitIp: null }, { id: pB, live: true }], assignments: { a1: pA } }));
    await new Promise((r) => setTimeout(r, 200));
    assert.deepEqual(core.one("SELECT status,exit_ip,resource_key FROM node_proxies WHERE id=?", pA), rowA, "verified exit kept, proxy stays live");
    assert.equal(core.one("SELECT status FROM node_proxies WHERE id=?", pB).status, "live");
    assert.equal(pushes(), before, "no pool push for an unmeasured but known exit");
    run("INSERT INTO node_proxies(id,node_id,url_enc,status,isolation_version) VALUES ('fresh-1','team-node',?,'unknown',1),('fresh-2','team-node',?,'unknown',1)",
      core.encryptString("http://u:p@198.51.100.20:8000"), core.encryptString("http://u:p@198.51.100.21:8000"));
    ws.send(JSON.stringify({ type: "provider.heartbeat", acceptingSessions: true, proxies: [{ id: "fresh-1", live: true }, { id: "fresh-2", live: true }], assignments: { a1: pA } }));
    await waitFor(() => pushes() > before);
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(pushes(), before + 1, "one push per heartbeat");
    assert.equal(core.one("SELECT last_error FROM node_proxies WHERE id='fresh-1'").last_error, "exit identity unavailable");
    assert.equal(core.one("SELECT status FROM node_proxies WHERE id='fresh-2'").status, "dead");
    run("DELETE FROM node_proxies WHERE id IN ('fresh-1','fresh-2')");
    console.log("team-tunnel: heartbeat without exit measurement OK");
  }
  assert.equal(await registry.openTunnel("a1", "cc_worker", undefined, 443, pB, worker, undefined, iso), null, "foreign proxy override refused");
  assert.equal(await registry.openTunnel("a1", "cc_worker", undefined, 443, pA, worker), null, "missing conversation context refused");
  assert.equal(await registry.openTunnel("b1", "cc_worker", undefined, 443, pB, worker, undefined, iso), null, "account team checked from DB");
  immediateCompletion = true;
  const instant = await registry.openTunnel("a1", "cc_worker", undefined, 443, pA, worker, undefined, iso);
  const early = await registry.readTunnel(instant.sessionId, 0);
  assert.equal(early.closed, true, "open response + stdout + close in one TCP packet stays closed");
  assert.equal(Buffer.from(early.chunks[0].payloadBase64, "base64").toString(), "early-result", "early output is buffered before the Promise continuation");
  registry.closeTunnel(instant.sessionId);
  immediateCompletion = false;
  const opened = await registry.openTunnel("a1", "cc_worker", undefined, 443, pA, worker, undefined, iso);
  assert.ok(opened);
  const envelope = frames.find((m) => m.type === "cc_worker.open");
  assert.deepEqual(envelope.isolation, iso);
  assert.match(envelope.deviceId, /^[0-9a-f]{64}$/);
  ws.send(JSON.stringify({ type: "cc_worker.data", sessionId: opened.sessionId, seq: 0, payloadBase64: Buffer.from("old-secret").toString("base64") }));
  await new Promise((r) => setTimeout(r, 20));
  run("UPDATE conversations SET generation=2,team_id=? WHERE id='c1'", B);
  assert.equal(registry.writeTunnel(opened.sessionId, Buffer.from("late-user-input")), false);
  const old = await registry.readTunnel(opened.sessionId, 0);
  assert.equal(old.error, "isolation_retired");
  assert.deepEqual(old.chunks, [], "queued old-generation output is discarded");
  await registry.resetIsolationSessions(iso);
  assert.ok(frames.some((m) => m.type === "isolation.reset" && m.isolation.generation === 1));
  const fresh = await registry.openTunnel("b1", "cc_worker", undefined, 443, pB, worker, undefined, { ...iso, teamId: B, generation: 2 });
  assert.ok(fresh, "new generation can start in another team");
  registry.closeTunnel(fresh.sessionId);
  hello(["cc_worker", "team_isolation_v1"], A);
  await waitFor(() => frames.filter((m) => m.type === "platform.ready").length === 3);
  assert.equal(await registry.openTunnel("b1", "cc_worker", undefined, 443, pB, worker, undefined, { ...iso, teamId: B, generation: 2 }), null, "dedicated runtime cannot receive another team");

  // A different healthy team is independent of an old node that accepts control traffic
  // but never acknowledges its teardown. Unrelated nodes must not receive/reset-wait A.
  run("INSERT INTO nodes(node_id,provider_id,secret_hash) VALUES ('healthy-team-b',?,?)", owner.id, core.sha256Hex("healthy-secret"));
  run("UPDATE node_proxies SET node_id='healthy-team-b' WHERE id=?", pB);
  run("UPDATE accounts SET node_id='healthy-team-b' WHERE id='b1'");
  const otherFrames = [];
  otherWs = new WebSocket(`ws://127.0.0.1:${app.server.address().port}/internal/provider/connect`, { headers: { "x-provider-node-id": "healthy-team-b", "x-provider-node-secret": "healthy-secret" } });
  otherWs.on("message", (raw) => {
    const m = JSON.parse(raw.toString()); otherFrames.push(m);
    if (m.type === "cc_worker.open") otherWs.send(JSON.stringify({ type: "cc_worker.open_response", sessionId: m.sessionId, accepted: true }));
    // Deliberately no reset acknowledgements: this unrelated team must never be asked.
  });
  await new Promise((resolve, reject) => { otherWs.once("open", resolve); otherWs.once("error", reject); });
  otherWs.send(JSON.stringify({ type: "provider.hello", nodeId: "healthy-team-b", providerId: owner.id, acceptingSessions: true, runtimeTeamId: B, capabilities: ["cc_worker", "team_isolation_v1"] }));
  await waitFor(() => otherFrames.some((m) => m.type === "platform.ready"));
  run("INSERT INTO conversations(id,api_key_id,external_key,team_id,created_at,updated_at) VALUES ('c-reset','fixture-key','reset-test',?,?,?)", A, now, now);
  const oldContext = { teamId: A, conversationId: "c-reset", generation: 1 };
  const oldRuntime = await registry.openTunnel("a1", "cc_worker", undefined, 443, pA, worker, undefined, oldContext);
  assert.ok(oldRuntime);
  acknowledgeResets = false;
  run("UPDATE conversations SET generation=2,team_id=? WHERE id='c-reset'", B);
  await registry.resetIsolationSessions(oldContext);
  assert.equal(registry.isNodeOnline("team-node"), false, "unacknowledged old runtime is withdrawn");
  assert.equal(otherFrames.some((m) => m.type === "isolation.reset"), false, "unrelated team is not a reset dependency");
  assert.equal((await registry.readTunnel(oldRuntime.sessionId, 0)).error, "isolation_retired");
  const healthy = await registry.openTunnel("b1", "cc_worker", undefined, 443, pB, worker, undefined, { ...oldContext, teamId: B, generation: 2 });
  assert.ok(healthy, "healthy B starts after old A's missing ACK without needing A recovery");
  registry.closeTunnel(healthy.sessionId);
  console.log("team-tunnel: ALL PASSED");
} finally {
  ws.terminate();
  otherWs?.terminate();
  await app.close();
  rmSync(dir, { recursive: true, force: true });
}
