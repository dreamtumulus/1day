// Worker-path auth failure classification + escalation (docs/gateway.md §3) — pure, against dist/.
import assert from "node:assert/strict";
import { test } from "node:test";
import { AuthFailureTracker, isCcAccountOnHold, isCcAuthFailure } from "../dist/ccr/auth-failure.js";

test("classifies Claude Code auth texts, not limits or transport errors", () => {
  assert.ok(isCcAuthFailure("stream: ccr_worker: Failed to authenticate: OAuth token revoked. Please log in again or contact your administrator. (after partial output)"));
  assert.ok(isCcAuthFailure("stream: ccr_worker: Failed to authenticate: OAuth session expired and could not be refreshed"));
  assert.equal(isCcAuthFailure("stream: ccr_worker: fetch failed"), false);
  assert.equal(isCcAuthFailure("You've hit your session limit · resets 8:50am (Europe/Berlin)"), false);
  assert.equal(isCcAuthFailure("tunnel closed by node: claude exited 143"), false);
  // 2026-10-20: a per-model org suspension arrives wrapped in "Failed to authenticate" — it is not an auth failure
  assert.equal(isCcAuthFailure('stream: ccr_worker: Failed to authenticate. API Error: 403 model: "claude-opus-5-5" is suspended for this organization until 2026-10-20T05:36:03Z (after partial output)'), false);
});

test("account on hold is its own verdict: one hit disables, not an auth-failure retry", () => {
  const hold = "stream: ccr_worker: Your account is on hold and can't use Claude Code. View details or appeal: https://claude.ai/restricted (after partial output)";
  assert.ok(isCcAccountOnHold(hold));
  assert.ok(isCcAccountOnHold("ccr_worker: see https://claude.ai/restricted"));
  assert.equal(isCcAuthFailure(hold), false, "not routed through the 3-hit tracker");
  assert.equal(isCcAccountOnHold("stream: ccr_worker: Failed to authenticate: OAuth token revoked"), false);
  assert.equal(isCcAccountOnHold("You've hit your session limit · resets 8:50am (Europe/Berlin)"), false);
});

test("escalates on the third hit inside the window, resets on success or after the window", () => {
  let now = 1_000_000;
  const t = new AuthFailureTracker(3, 60_000, () => now);
  assert.deepEqual(t.record("a"), { count: 1, escalate: false });
  now += 10_000;
  assert.deepEqual(t.record("a"), { count: 2, escalate: false });
  now += 10_000;
  assert.deepEqual(t.record("a"), { count: 3, escalate: true });
  t.clear("a");
  assert.equal(t.count("a"), 0);
  assert.deepEqual(t.record("a"), { count: 1, escalate: false });
  now += 61_000; // window passed: the old hit is forgotten
  assert.deepEqual(t.record("a"), { count: 1, escalate: false });
  assert.deepEqual(t.record("b"), { count: 1, escalate: false }, "accounts are tracked separately");
});

test("Claude Code's expired-login sentences are auth failures; a process that never logged in is not (2026-11-11)", () => {
  assert.ok(isCcAuthFailure("stream: ccr_worker: Login expired · Please run /login (after partial output)"));
  assert.ok(isCcAuthFailure("ccr_worker: Login expired · Please run /login"));
  assert.ok(isCcAuthFailure("ccr_worker: Login reached its time limit · Please run /login"));
  assert.ok(isCcAuthFailure("Failed to authenticate: this login reached its time limit and cannot be renewed. Run `claude auth login` to sign in again"));
  // launch / config fault (2026-10-19): the process read no credential at all — not the account's verdict
  assert.equal(isCcAuthFailure("ccr_worker: Not logged in · Please run /login"), false);
});

test("three expired-login hits inside the window escalate, a served request in between resets", () => {
  let now = 0;
  const t = new AuthFailureTracker(3, 30 * 60_000, () => now);
  assert.equal(t.record("a").escalate, false);
  now += 5 * 60_000;
  assert.equal(t.record("a").escalate, false);
  t.clear("a");
  now += 5 * 60_000;
  assert.equal(t.record("a").escalate, false);
  now += 5 * 60_000;
  assert.equal(t.record("a").escalate, false);
  now += 5 * 60_000;
  assert.equal(t.record("a").escalate, true);
});
