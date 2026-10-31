// ProxyPool.getPinned (docs/onboarding.md §6.2): exact pinned proxy selection
// for account-bound egress. Run under Bun:
//   bun apps/provider-node/test/proxy-pool.test.mjs
import assert from "node:assert/strict";
import { ProxyPool, proxyId } from "../dist/proxy-pool.js";

// Minimal NodeConfigStore stand-in: in-memory, save() is a no-op.
const fakeStore = () => ({ data: {}, save() {} });

const P1 = "http://user:pass@10.0.0.1:8080";
const P2 = "socks5://user:pass@10.0.0.2:1080";
const P3 = "http://10.0.0.3:3128";

// autoCheck:false — no probe pass, every entry stays live=null (usable).
const pool = new ProxyPool(fakeStore(), { autoCheck: false });
pool.replaceAll([P1, P2, P3]);

const id1 = proxyId(P1);
assert.equal(pool.getPinned(id1), P1, "pinned id resolves to its pool url");
assert.equal(pool.getPinned(proxyId(P2)), P2);
assert.equal(pool.getPinned("000000000000"), null, "unknown id -> null (caller hard-fails)");
assert.equal(pool.getPinned(""), null);

// One proxy-layer failure is a strike, not a verdict: the pin keeps working.
pool.markDead(P1, "test: blip");
assert.equal(pool.getPinned(id1), P1, "suspect pinned proxy still resolves (1/3)");
pool.markAlive(P1);
pool.markDead(P1, "test: blip");
assert.equal(pool.getPinned(id1), P1, "a success in between cleared the streak (1/3 again)");
// deadAfter consecutive strikes withdraw it; a known-dead pin is rejected and does NOT fall back to sticky.
pool.markDead(P1, "test: dead");
pool.markDead(P1, "test: dead");
assert.equal(pool.getPinned(id1), null, "dead pinned proxy -> null after 3 consecutive failures");
assert.equal(pool.getPinned(proxyId(P3)), P3, "other pool members unaffected");

// Sticky assignment still works alongside pinning.
assert.equal(pool.pickForAccount("acct-1"), pool.pickForAccount("acct-1"), "sticky is stable");
assert.notEqual(pool.pickForAccount("acct-1"), P1, "sticky never rehashes onto a dead proxy");

// Pool replacement drops the pinned id.
pool.replaceAll([P3]);
assert.equal(pool.getPinned(proxyId(P2)), null, "replaced pool no longer has the pin");
assert.equal(pool.getPinned(proxyId(P3)), P3);

// deadAfter:1 restores the strict policy (one failure = dead).
const strict = new ProxyPool(fakeStore(), { autoCheck: false, deadAfter: 1 });
strict.replaceAll([P1, P2]);
strict.markDead(P1, "test: dead");
assert.equal(strict.getPinned(id1), null, "deadAfter=1: first failure withdraws the proxy");

// Unassigned sentinel is not an organization: legacy accounts may pin these proxies.
{
  const legacy = new ProxyPool(fakeStore(), { autoCheck: false });
  legacy.replaceAll([P1], { proxyTeams: { [id1]: `unassigned:${id1}` }, proxyAccounts: { [id1]: [] } });
  assert.equal(legacy.getPinned(id1), P1, "unassigned sentinel does not block an unbound pin");
  assert.equal(legacy.getPinned(id1, "legacy-acct"), P1, "unassigned sentinel accepts a legacy account");
  assert.equal(legacy.getPinned(id1, "team-acct", "team-a"), null, "a real team cannot take an unassigned legacy pin");
}

console.log("proxy-pool: ALL PASSED");

// 2026-10-28: a pool push keeps the health of proxies that stay in the pool (liveness,
// strikes, measured exit IP) and only new URLs start unprobed; a served request never
// promotes an unprobed entry to live (the platform would read "alive, exit unknown").
{
  const keep = new ProxyPool(fakeStore(), { autoCheck: false });
  keep.replaceAll([P1, P2]);
  const h1 = keep.health.get(P1);
  h1.live = true; h1.exitIp = "203.0.113.7"; h1.latencyMs = 42; h1.lastCheckAt = Date.now();
  keep.markDead(P2, "test: blip"); // one strike, still usable
  keep.replaceAll([P1, P2, P3], { proxyTeams: { [proxyId(P1)]: "team-a" }, proxyAccounts: { [proxyId(P1)]: ["acct-a"] } });
  const r1 = keep.heartbeatReport().proxies.find((p) => p.id === proxyId(P1));
  assert.equal(r1.live, true, "retained proxy keeps its verdict across a pool push");
  assert.equal(r1.exitIp, "203.0.113.7", "retained proxy keeps its measured exit");
  assert.equal(keep.health.get(P2).failStreak, 1, "retained proxy keeps its strike streak");
  assert.equal(keep.health.get(P3).live, null, "new proxy starts unprobed");
  assert.equal(keep.getPinned(proxyId(P1), "acct-a", "team-a"), P1, "policy metadata still applied");
  keep.replaceAll([P2, P3]);
  assert.equal(keep.health.has(P1), false, "dropped URL leaves the pool");
  // markAlive on an unprobed entry: strikes cleared, verdict stays unprobed.
  keep.markDead(P3, "test: blip");
  keep.markAlive(P3);
  assert.equal(keep.health.get(P3).failStreak, 0);
  assert.equal(keep.health.get(P3).live, null, "served request does not fake a probe");
  keep.health.get(P3).live = true;
  keep.markDead(P3, "test: blip");
  keep.markAlive(P3);
  assert.equal(keep.health.get(P3).live, true, "probed entry is marked alive as before");
  keep.stopHealthChecks();
  console.log("proxy-pool: pool push retains health OK");
}

// 2026-10-28: exit lookup parsing (ipinfo.io / ipwho.is JSON with country, ipify JSON, plain-text IP)
{
  const { parseExitLookup } = await import("../dist/proxy-pool.js");
  assert.deepEqual(parseExitLookup('{"ip":"203.0.113.9","city":"X","country":"US"}'), { ip: "203.0.113.9", country: "US" });
  assert.deepEqual(parseExitLookup('{"ip":"203.0.113.9","success":true,"country_code":"jp"}'), { ip: "203.0.113.9", country: "JP" });
  assert.deepEqual(parseExitLookup('{"ip":"203.0.113.9"}'), { ip: "203.0.113.9", country: null });
  assert.deepEqual(parseExitLookup("203.0.113.9\n"), { ip: "203.0.113.9", country: null });
  assert.deepEqual(parseExitLookup('{"success":false,"message":"limit"}'), { ip: null, country: null });
  assert.deepEqual(parseExitLookup("<html>blocked</html>"), { ip: null, country: null });
  console.log("proxy-pool: exit lookup parsing OK");
}
