// Per-account scheduling gates (docs/onboarding.md §6.3) — pure, against dist/.
import assert from "node:assert/strict";
import { test } from "node:test";
import { AccountGates } from "../dist/limits.js";

test("0 caps = unlimited", () => {
  const g = new AccountGates();
  for (let i = 0; i < 100; i++) assert.ok(g.tryAcquire("a", 0, 0));
  assert.equal(g.inFlightCount("a"), 100);
});

test("concurrency cap blocks and release reopens", () => {
  const g = new AccountGates();
  assert.ok(g.tryAcquire("a", 2, 0));
  assert.ok(g.tryAcquire("a", 2, 0));
  assert.equal(g.tryAcquire("a", 2, 0), false, "third in-flight request over cap 2");
  g.release("a");
  assert.ok(g.tryAcquire("a", 2, 0));
  g.release("a");
  g.release("a");
  assert.equal(g.inFlightCount("a"), 0);
  g.release("a"); // over-release is a no-op
  assert.equal(g.inFlightCount("a"), 0);
});

test("rpm sliding window: counts successes and failures, expires after 60s", () => {
  let now = 1_000_000;
  const g = new AccountGates(() => now);
  assert.ok(g.tryAcquire("a", 0, 3));
  assert.ok(g.tryAcquire("a", 0, 3));
  assert.ok(g.tryAcquire("a", 0, 3));
  assert.equal(g.tryAcquire("a", 0, 3), false, "4th request within the window over rpm 3");
  g.release("a");
  g.release("a");
  g.release("a");
  assert.equal(g.tryAcquire("a", 0, 3), false, "releasing concurrency does not refund rpm");
  now += 30_000;
  assert.equal(g.tryAcquire("a", 0, 3), false, "still within 60s");
  now += 31_000;
  assert.ok(g.tryAcquire("a", 0, 3), "oldest hit aged out of the window");
  assert.equal(g.rpmCount("a"), 1);
});

test("caps are per account", () => {
  const g = new AccountGates();
  assert.ok(g.tryAcquire("a", 1, 1));
  assert.equal(g.tryAcquire("a", 1, 1), false);
  assert.ok(g.tryAcquire("b", 1, 1), "account b unaffected");
});


test("shared leases coordinate two gateway instances including aggregate statistics and RPM",async()=>{
 const {SharedAccountGates}=await import("../dist/limits.js");
 let now=100_000;const a=new SharedAccountGates(()=>now),b=new SharedAccountGates(()=>now);
 assert.ok(a.tryAcquire("shared-account",1,2));
 assert.equal(b.tryAcquire("shared-account",1,2),false);
 assert.equal(b.inFlightCount("shared-account"),1);
 assert.equal(b.snapshot()["shared-account"],1);
 a.release("shared-account");assert.ok(b.tryAcquire("shared-account",1,2));b.release("shared-account");
 assert.equal(a.tryAcquire("shared-account",1,2),false,"RPM is shared even after all slots release");
 now+=61_000;assert.ok(a.tryAcquire("shared-account",1,2));
 now+=91_000;assert.ok(b.tryAcquire("shared-account",1,2),"crashed instance lease expires");
 a.release("shared-account");b.release("shared-account");
});


test("lost leases fence the old request and cannot be revived after another instance admits",async()=>{
 const {SharedAccountGates}=await import("../dist/limits.js");
 let now=200_000;let lost=0;
 const a=new SharedAccountGates(()=>now),b=new SharedAccountGates(()=>now);
 const old=a.acquireLease("fenced-account",1,0,()=>lost++);assert.ok(old);
 now+=91_000;const replacement=b.acquireLease("fenced-account",1,0);assert.ok(replacement);
 a.renewLeases();assert.equal(lost,1);assert.equal(old.isValid(),false);assert.equal(replacement.isValid(),true);
 old.release();assert.equal(replacement.isValid(),true,"old handle cannot release a newer request");replacement.release();
});
test("out of order completion removes only that exact request lease",async()=>{
 const {SharedAccountGates}=await import("../dist/limits.js");const gates=new SharedAccountGates();
 const first=gates.acquireLease("identity-account",2,0);const second=gates.acquireLease("identity-account",2,0);
 second.release();assert.equal(first.isValid(),true);assert.equal(second.isValid(),false);assert.equal(gates.inFlightCount("identity-account"),1);first.release();
});
