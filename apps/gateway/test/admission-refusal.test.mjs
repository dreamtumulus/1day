// X-55: a refused admission (429 user_inflight_limit) names its reason to the customer, is counted per reason and
// logged once per user per minute.
import assert from "node:assert/strict";
import { test } from "node:test";
const { admissionRefusalMessage, admissionRefusalNumbers, noteAdmissionRefusal } = await import("../dist/proxy.js");
const { countersSnapshot, resetCounters } = await import("../dist/metrics.js");

const refusal = (o) => ({ ok: false, reason: "concurrency_cap", inFlight: 4, maxInflight: 4, reservedUsd: 0.4, capUsd: 25, capIsBalance: true, availableUsd: 25, keyRemainingUsd: null, keyReservedUsd: null, wantedUsd: 0.1, ...o });

test("the message tells the customer which limit refused the request and what to do", () => {
  assert.match(admissionRefusalMessage(refusal({})), /4 are already in flight and your limit is 4 concurrent requests\. Lower your concurrency/);
  assert.match(admissionRefusalMessage(refusal({ reason: "insufficient_funds", inFlight: null, maxInflight: null })), /balance and remaining credit are used up.*Top up/);
  assert.match(admissionRefusalMessage(refusal({ reason: "key_quota_exhausted" })), /API key has used up its quota/);
  assert.match(admissionRefusalMessage(refusal({ reason: "reserved_spending_cap", reservedUsd: 24.95, capUsd: 25 })), /reserve your whole available balance \(24\.95 of 25\.00 USD reserved; this request needs about 0\.10 USD more\)\. Top up/);
  const capped = admissionRefusalMessage(refusal({ reason: "reserved_spending_cap", capIsBalance: false, reservedUsd: 9.5, capUsd: 10 }));
  assert.match(capped, /in-flight spending limit \(9\.50 of 10\.00 USD reserved/);
  assert.doesNotMatch(capped, /Top up/);
  assert.match(admissionRefusalMessage(refusal({ reason: "key_quota_reserved", keyRemainingUsd: 1, keyReservedUsd: 0.8, wantedUsd: 0.8 })), /in flight on this API key reserve what is left of its quota \(0\.80 of 1\.00 USD remaining/);
});

test("numbers: in_flight=<n>/<cap> reserved=<usd>/<cap>, key quota only when the key has one, tiny amounts keep their digits", () => {
  assert.equal(admissionRefusalNumbers(refusal({})), "in_flight=4/4 reserved=0.40/25.00 available=25.00 wanted=0.10");
  assert.equal(admissionRefusalNumbers(refusal({ reason: "insufficient_funds", inFlight: null, maxInflight: null, reservedUsd: null, capUsd: null, availableUsd: 0, wantedUsd: 0.000321 })), "in_flight=-/- reserved=-/- available=0.00 wanted=0.000321");
  assert.equal(admissionRefusalNumbers(refusal({ keyRemainingUsd: 1, keyReservedUsd: 0.8 })), "in_flight=4/4 reserved=0.40/25.00 available=25.00 key_remaining=1.00 key_reserved=0.80 wanted=0.10");
});

test("every refusal is counted by reason; the log line is written once per user per minute", () => {
  resetCounters();
  const lines = [];
  const log = (l) => lines.push(l);
  const t0 = 1_800_000_000_000;
  assert.equal(noteAdmissionRefusal("user-aaaa-1111", "key-bbbb-2222", refusal({}), t0, log), true);
  for (let i = 1; i <= 50; i++) assert.equal(noteAdmissionRefusal("user-aaaa-1111", "key-bbbb-2222", refusal({}), t0 + i * 1000, log), false);
  assert.equal(noteAdmissionRefusal("user-cccc-3333", "key-dddd-4444", refusal({ reason: "reserved_spending_cap" }), t0 + 2000, log), true, "another user has its own line");
  assert.equal(noteAdmissionRefusal("user-aaaa-1111", "key-bbbb-2222", refusal({ reason: "insufficient_funds" }), t0 + 60_000, log), true, "a minute later the user is logged again");
  assert.deepEqual(lines, [
    "[admission] user=user-aaa key=key-bbbb refused: concurrency_cap in_flight=4/4 reserved=0.40/25.00 available=25.00 wanted=0.10",
    "[admission] user=user-ccc key=key-dddd refused: reserved_spending_cap in_flight=4/4 reserved=0.40/25.00 available=25.00 wanted=0.10",
    "[admission] user=user-aaa key=key-bbbb refused: insufficient_funds in_flight=4/4 reserved=0.40/25.00 available=25.00 wanted=0.10",
  ]);
  const c = countersSnapshot();
  assert.equal(c["admission_refused_total{reason=concurrency_cap}"], 51);
  assert.equal(c["admission_refused_total{reason=reserved_spending_cap}"], 1);
  assert.equal(c["admission_refused_total{reason=insufficient_funds}"], 1);
});
