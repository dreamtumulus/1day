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

console.log("proxy-pool: ALL PASSED");
