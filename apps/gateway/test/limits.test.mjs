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
