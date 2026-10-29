// Proxy groups (docs/onboarding.md §4.2, 2026-10-29): batch group on add (known rows move into the
// group), regroup endpoint, per-group tallies, "auto within a group" on onboarding.
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const dir = mkdtempSync(join(tmpdir(), "1dayapi-proxy-groups-"));
process.env.DATA_DIR = dir;
process.env.CCR_WINDOW_POLL = "0";
process.env.ALLOW_UNTRUSTED_EXECUTION = "1";
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));

const core = await import("@1dayapi/core");
const { buildApp } = await import("../dist/app.js");
const { resolveTeamProxy } = await import("../dist/node/proxies.js");
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
const prov = createUser("provider", "pg-provider");
const provider = await login(prov.loginKey);
run("INSERT INTO nodes(node_id,provider_id,secret_hash,online,accepting_sessions,created_at) VALUES ('pg-node',?,'h',1,1,?)", prov.id, core.nowIso());
const N = "/api/admin/nodes/pg-node";
const id = (u) => core.sha256Hex(u).slice(0, 12);
const TEAM = "11111111-2222-4333-8444-555555555555";

test("append with a batch group; known rows move into the group instead of being skipped", async () => {
  let r = await admin("POST", `${N}/proxies`, { proxies: [{ url: "socks5://a:b@198.51.100.1:1080" }, { url: "socks5://a:b@198.51.100.2:1080", label: "two" }] });
  assert.equal(r.data.added, 2);
  assert.equal(r.data.regrouped, 0);
  assert.deepEqual(r.data.proxies.map((p) => p.group), [null, null]);
  // the same two lines plus a new one, under group "acme"
  r = await admin("POST", `${N}/proxies`, { group: " acme ", proxies: [{ url: "socks5://a:b@198.51.100.1:1080" }, { url: "198.51.100.2:1080:a:b" }, { url: "198.51.100.3:1080:a:b" }] });
  assert.equal(r.status, 200, JSON.stringify(r));
  assert.equal(r.data.added, 1);
  assert.equal(r.data.regrouped, 2);
  assert.equal(r.data.skipped.alreadyInPool, 0);
  assert.deepEqual(r.data.proxies.map((p) => p.group), ["acme", "acme", "acme"]);
  // without a group, a known line is still just skipped (nothing moves)
  r = await admin("POST", `${N}/proxies`, { proxies: [{ url: "socks5://a:b@198.51.100.1:1080" }] });
  assert.equal(r.data.added, 0);
  assert.equal(r.data.regrouped, 0);
  assert.equal(r.data.skipped.alreadyInPool, 1);
  assert.equal(one("SELECT group_name g FROM node_proxies WHERE id=?", id("socks5://a:b@198.51.100.1:1080")).g, "acme");
  // per-proxy group wins over the batch group; empty string = ungrouped
  r = await admin("POST", `${N}/proxies`, { group: "acme", proxies: [{ url: "198.51.100.4:1080", group: "beta" }, { url: "198.51.100.5:1080", group: "" }] });
  assert.equal(r.data.added, 2);
  assert.equal(one("SELECT group_name g FROM node_proxies WHERE id=?", id("socks5://198.51.100.4:1080")).g, "beta");
  assert.equal(one("SELECT group_name g FROM node_proxies WHERE id=?", id("socks5://198.51.100.5:1080")).g, null);
});

test("regroup endpoint and per-group tallies", async () => {
  let r = await admin("POST", `${N}/proxies/group`, { proxyIds: [id("socks5://198.51.100.5:1080"), id("socks5://198.51.100.4:1080"), "nonexistent00"], group: "beta" });
  assert.equal(r.status, 200, JSON.stringify(r));
  assert.equal(r.data.changed, 1, "only the ungrouped one changed; the other already was beta");
  r = await admin("GET", `${N}/proxy-groups`);
  assert.deepEqual(r.data.map((g) => [g.group, g.total]), [["acme", 3], ["beta", 2]]);
  // ungroup
  r = await admin("POST", `${N}/proxies/group`, { proxyIds: [id("socks5://198.51.100.5:1080")], group: null });
  assert.equal(r.data.changed, 1);
  r = await admin("GET", `${N}/proxy-groups`);
  assert.deepEqual(r.data.map((g) => [g.group, g.total]), [["acme", 3], ["beta", 1], [null, 1]]);
  // provider sees the groups of its own node, nobody else's
  const p = await provider("GET", "/api/provider/nodes/pg-node/proxy-groups");
  assert.equal(p.status, 200);
  assert.equal(p.data.length, 3);
  const bad = await admin("POST", `${N}/proxies/group`, { proxyIds: ["x"], group: "x".repeat(61) });
  assert.equal(bad.status, 400);
});

test("auto-assign within a group picks only that group's verified proxies", async () => {
  // verify acme#1 and beta#4; leave acme#2/#3 unprobed
  for (const [u, ip] of [["socks5://a:b@198.51.100.1:1080", "198.51.100.1"], ["socks5://198.51.100.4:1080", "198.51.100.4"]]) {
    run("UPDATE node_proxies SET status='live', exit_ip=?, resource_key=?, last_check_at=? WHERE id=?", ip, `ip:${ip}`, core.nowIso(), id(u));
  }
  assert.equal(resolveTeamProxy("pg-node", TEAM, "auto", "", undefined, "acme").id, id("socks5://a:b@198.51.100.1:1080"));
  assert.equal(resolveTeamProxy("pg-node", TEAM, "auto", "", undefined, "beta").id, id("socks5://198.51.100.4:1080"));
  assert.throws(() => resolveTeamProxy("pg-node", TEAM, "auto", "", undefined, "nothing"), /in group nothing/);
  assert.throws(() => resolveTeamProxy("pg-node", TEAM, "auto", "", undefined, null), /\(ungrouped\)/);
  // no group → any verified proxy; explicit pick ignores the group
  assert.ok(resolveTeamProxy("pg-node", TEAM, "auto").id);
  assert.equal(resolveTeamProxy("pg-node", TEAM, id("socks5://198.51.100.4:1080"), "", undefined, "acme").id, id("socks5://198.51.100.4:1080"));
  // tallies know what is assignable per group
  const r = await admin("GET", `${N}/proxy-groups`);
  const acme = r.data.find((g) => g.group === "acme");
  assert.equal(acme.live, 1);
  assert.equal(acme.assignable, 1);
  // picker rows carry the group
  const pick = await admin("GET", `${N}/proxies?free=1`);
  assert.deepEqual(pick.data.map((p) => p.group).sort(), ["acme", "beta"]);
  // onboarding with proxyGroup → 400 proxy_pool_empty names the group when it has nothing
  const ob = await admin("POST", "/api/admin/accounts/onboard", { method: "auth_url", nodeId: "pg-node", proxyId: "auto", proxyGroup: "nothing" });
  assert.equal(ob.status, 400);
  assert.match(ob.error?.message ?? JSON.stringify(ob), /in group nothing/);
});

test.after(async () => { await app.close(); });
