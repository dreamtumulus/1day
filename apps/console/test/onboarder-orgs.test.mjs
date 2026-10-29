// Organization profiles for onboarders (docs/onboarding.md §10.1, 2026-10-29): organization →
// domain → node / IP-group route; the server derives the organization UUID, validates each pick,
// limits the automatic proxy to the route's group and refuses an account from another domain.
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const dir = mkdtempSync(join(tmpdir(), "1dayapi-onb-orgs-"));
process.env.DATA_DIR = dir;
process.env.CCR_WINDOW_POLL = "0";
process.env.ALLOW_UNTRUSTED_EXECUTION = "1";
process.env.ONBOARD_MOCK = "1";
process.env.ONBOARD_PROFILE_FETCH = "0";
const TEAM = "11111111-1111-4111-8111-111111111111";
process.env.ONBOARD_MOCK_ORG_UUID = TEAM;
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));

const core = await import("@1dayapi/core");
const { buildApp } = await import("../dist/app.js");
const { replaceNodeProxies, setNodeProxyGroup } = await import("../dist/node/proxies.js");
const { run, one } = core;

const app = await buildApp();
await app.listen({ port: 0, host: "127.0.0.1" });
const BASE = `http://127.0.0.1:${app.server.address().port}`;
async function req(headers, method, path, body) {
  const res = await fetch(`${BASE}${path}`, { method, headers: { ...headers, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, ...(await res.json().catch(() => ({}))) };
}
const lr = await fetch(`${BASE}/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: readFileSync(join(dir, "admin-key.txt"), "utf8").trim() }) });
const cookie = (lr.headers.get("set-cookie") ?? "").split(";")[0];
const admin = (m, p, b) => req({ cookie }, m, p, b);

const { createUser } = await import("../dist/session.js");
const owner = createUser("provider", "oo-owner");
run("INSERT INTO nodes(node_id,provider_id,secret_hash,online,accepting_sessions,capacity,created_at) VALUES ('oo-a',?,'h',1,1,50,?)", owner.id, core.nowIso());
run("INSERT INTO nodes(node_id,provider_id,secret_hash,online,accepting_sessions,capacity,created_at) VALUES ('oo-b',?,'h',1,1,50,?)", owner.id, core.nowIso());
const urls = { a1: "socks5://u:p@203.0.113.1:1080", a2: "socks5://u:p@203.0.113.2:1080", b1: "socks5://u:p@203.0.113.3:1080" };
replaceNodeProxies("oo-a", [{ url: urls.a1 }, { url: urls.a2 }]);
replaceNodeProxies("oo-b", [{ url: urls.b1 }]);
const id = (u) => core.sha256Hex(u).slice(0, 12);
for (const [k, ip] of [["a1", "203.0.113.1"], ["a2", "203.0.113.2"], ["b1", "203.0.113.3"]]) {
  run("UPDATE node_proxies SET status='live', exit_ip=?, resource_key=?, last_check_at=? WHERE id=?", ip, `ip:${ip}`, core.nowIso(), id(urls[k]));
}
setNodeProxyGroup("oo-a", [id(urls.a1)], "g1");
setNodeProxyGroup("oo-a", [id(urls.a2)], "g2");
run("UPDATE settings SET value='0' WHERE key IN ('onboard_cooldown_min_sec','onboard_cooldown_max_sec')");

let orgId, otherOrgId, onb;

test("organization profile CRUD: domains + routes validated, enriched on read", async () => {
  let r = await admin("POST", "/api/admin/onboard/orgs", { name: "Camp", orgUuid: TEAM, domains: "evenld.org, @Mail.Example.COM\nevenld.org", routes: [{ nodeId: "oo-a", group: "g1" }, { nodeId: "oo-b" }] });
  assert.equal(r.status, 201, JSON.stringify(r));
  orgId = r.data.id;
  assert.deepEqual(r.data.domains, ["evenld.org", "mail.example.com"]);
  assert.deepEqual(r.data.routes.map((x) => [x.nodeId, x.group, x.assignable, x.nodeOnline]), [["oo-a", "g1", 1, true], ["oo-b", null, 1, true]]);
  assert.equal(r.data.status, "active");
  r = await admin("POST", "/api/admin/onboard/orgs", { name: "Bad", orgUuid: "22222222-1111-4111-8111-111111111111", domains: ["not a domain"] });
  assert.equal(r.status, 400);
  r = await admin("POST", "/api/admin/onboard/orgs", { name: "Bad", orgUuid: "22222222-1111-4111-8111-111111111111", routes: [{ nodeId: "nope" }] });
  assert.equal(r.status, 400);
  assert.equal(r.error?.code, "node_not_found");
  r = await admin("POST", "/api/admin/onboard/orgs", { name: "Other", orgUuid: "33333333-1111-4111-8111-111111111111", domains: ["other.org"], routes: [{ nodeId: "oo-a", group: "g2" }] });
  assert.equal(r.status, 201);
  otherOrgId = r.data.id;
  // patch keeps unspecified fields
  r = await admin("PATCH", `/api/admin/onboard/orgs/${orgId}`, { note: "hello" });
  assert.deepEqual(r.data.domains, ["evenld.org", "mail.example.com"]);
  assert.equal(r.data.routes.length, 2);
});

test("token limited to organizations; /me lists them without UUIDs", async () => {
  let r = await admin("POST", "/api/admin/onboard-tokens", { label: "op", nodeId: "*", orgIds: [orgId] });
  assert.equal(r.status, 200, JSON.stringify(r));
  assert.deepEqual(r.data.orgIds, [orgId]);
  assert.deepEqual(r.data.orgNames, ["Camp"]);
  onb = (m, p, b) => req({ authorization: `Bearer ${r.data.token}` }, m, p, b);
  const me = await onb("GET", "/api/onboard/me");
  assert.equal(me.status, 200);
  assert.equal(me.data.orgs.length, 1);
  assert.equal(me.data.orgs[0].name, "Camp");
  assert.equal("orgUuid" in me.data.orgs[0], false, "UUID stays hidden from operators");
  assert.deepEqual(me.data.orgs[0].domains, ["evenld.org", "mail.example.com"]);
  assert.equal(me.data.orgs[0].routes.length, 2);
  // proxies can be filtered by group
  const px = await onb("GET", "/api/onboard/proxies?nodeId=oo-a&group=g1");
  assert.deepEqual(px.data.map((p) => p.id), [id(urls.a1)]);
  // the token's org list can be widened later
  const t2 = await admin("PATCH", `/api/admin/onboard-tokens/${r.data.id}`, { orgIds: null });
  assert.equal(t2.data.orgIds, null);
  const me2 = await onb("GET", "/api/onboard/me");
  assert.equal(me2.data.orgs.length, 2);
  await admin("PATCH", `/api/admin/onboard-tokens/${r.data.id}`, { orgIds: [orgId] });
});

test("job validation: organization required, domain and route must belong to it, proxy stays in the group", async () => {
  let r = await onb("POST", "/api/onboard/jobs", { method: "auth_url", nodeId: "oo-a" });
  assert.equal(r.error?.code, "org_required");
  r = await onb("POST", "/api/onboard/jobs", { method: "auth_url", nodeId: "oo-a", orgId: otherOrgId, domain: "other.org", proxyGroup: "g2" });
  assert.equal(r.error?.code, "org_not_allowed");
  r = await onb("POST", "/api/onboard/jobs", { method: "auth_url", nodeId: "oo-a", orgId, domain: "wrong.org", proxyGroup: "g1" });
  assert.equal(r.error?.code, "domain_invalid");
  r = await onb("POST", "/api/onboard/jobs", { method: "auth_url", nodeId: "oo-a", orgId, domain: "evenld.org", proxyGroup: "g2" });
  assert.equal(r.error?.code, "route_invalid", JSON.stringify(r));
  r = await onb("POST", "/api/onboard/jobs", { method: "auth_url", nodeId: "oo-a", orgId, domain: "Evenld.org", proxyGroup: "g1" });
  assert.equal(r.status, 200, JSON.stringify(r));
  const job = one("SELECT * FROM onboarding_jobs WHERE id=?", r.data.jobId);
  assert.equal(job.proxy_id, id(urls.a1), "automatic pick limited to group g1");
  assert.equal(job.team_id, TEAM);
  const params = JSON.parse(job.params_json);
  assert.equal(params.expectedDomain, "evenld.org");
  assert.equal(params.teamName, "Camp");
  assert.equal(params.orgProfileId, orgId);
  const out = await onb("GET", `/api/onboard/jobs/${r.data.jobId}`);
  assert.equal(out.data.orgName, "Camp");
  assert.equal(out.data.domain, "evenld.org");
  await onb("POST", `/api/onboard/jobs/${r.data.jobId}/cancel`, {});
  // a route without a group accepts any group on that node
  r = await onb("POST", "/api/onboard/jobs", { method: "auth_url", nodeId: "oo-b", orgId, domain: "evenld.org" });
  assert.equal(r.status, 200, JSON.stringify(r));
  await onb("POST", `/api/onboard/jobs/${r.data.jobId}/cancel`, {});
});

async function waitJob(jobId) {
  for (let i = 0; i < 200; i++) {
    const r = await onb("GET", `/api/onboard/jobs/${jobId}`);
    if (r.data.status === "done" || r.data.status === "failed") return r.data;
    await new Promise((x) => setTimeout(x, 50));
  }
  throw new Error("job did not finish");
}

test("domain rule on completion: the mock account (mock@example.com) is refused under evenld.org and accepted under example.com", async () => {
  let r = await onb("POST", "/api/onboard/jobs", { method: "session_key", sessionKey: "sk-ant-sid01-mock", nodeId: "oo-b", orgId, domain: "evenld.org" });
  assert.equal(r.status, 200, JSON.stringify(r));
  let j = await waitJob(r.data.jobId);
  assert.equal(j.status, "failed");
  assert.match(j.error, /^domain_mismatch/);
  assert.equal(one("SELECT COUNT(*) n FROM accounts WHERE team_id=?", TEAM).n, 0, "nothing written");
  // allow example.com and retry
  await admin("PATCH", `/api/admin/onboard/orgs/${orgId}`, { domains: ["evenld.org", "example.com"] });
  r = await onb("POST", "/api/onboard/jobs", { method: "session_key", sessionKey: "sk-ant-sid01-mock2", nodeId: "oo-b", orgId, domain: "example.com" });
  assert.equal(r.status, 200, JSON.stringify(r));
  j = await waitJob(r.data.jobId);
  assert.equal(j.status, "done", JSON.stringify(j));
  assert.equal(j.accountEmail, "mock@example.com");
  assert.equal(one("SELECT team_id FROM accounts WHERE id=?", j.accountId).team_id, TEAM);
});

test.after(async () => { await app.close(); });
