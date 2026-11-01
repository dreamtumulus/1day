// Key-policy judge (spec §6.2 / WP8): rules, hysteresis, persistence shape, append-only events; plus I12 (bare 429 "Error").
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const dir = mkdtempSync(join(tmpdir(), "1dayapi-judge-"));
process.env.DATA_DIR = dir;
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
const core = await import("../dist/index.js");
const { proposeKeyPolicy, reconcileAuto, nextKeyPolicyJson, parseKeyPolicyDoc, parseKeyPolicy, recordKeyPolicyEvents, listKeyPolicyEvents, layersEqual, JUDGE_MIN_REQUESTS, JUDGE_STABLE_MS, classifyDirectRateLimit, setSetting, run, one } = core;

const obs = (o) => ({ apiKeyId: "k1", windowDays: 14, requests: 200, ccRequests: 0, genuineRequests: 0, messagesRequests: 200, streamRequests: 150, longNonStream: 0, errorRequests: 2, since: "2026-10-20T00:00:00Z", ...o });
const DAY = 86_400_000;
const T0 = Date.parse("2026-11-01T00:00:00Z");

test("rules: too few requests → no opinion; ≥95% genuine CC → canonical/native/strict/strict/passthrough; API client → warn + keepalive only with long non-stream", () => {
  assert.equal(proposeKeyPolicy(obs({ requests: JUDGE_MIN_REQUESTS - 1 })), null);
  const cc = proposeKeyPolicy(obs({ ccRequests: 198, genuineRequests: 195 }));
  assert.deepEqual(cc.layer, { workerMode: "canonical", telemetryPolicy: "native-required", parameterPolicy: "strict", responseMode: "strict", historyPolicy: "passthrough" });
  assert.match(cc.basis, /cc_genuine_ratio=0\.975;.*rule=genuine_cc/);
  const api = proposeKeyPolicy(obs());
  assert.deepEqual(api.layer, { workerMode: "canonical", telemetryPolicy: "native-required", parameterPolicy: "warn", responseMode: "strict" });
  assert.equal(api.layer.historyPolicy, undefined, "no foreign-history observation yet → no opinion");
  assert.equal(proposeKeyPolicy(obs({ longNonStream: 3 })).layer.responseMode, "keepalive");
  assert.equal(proposeKeyPolicy(obs({ ccRequests: 200, genuineRequests: 180 })).layer.parameterPolicy, "warn", "90% genuine is not ≥95%");
});

test("hysteresis: first judgement adopted at once; a different proposal must stay identical ≥3 days; same opinion clears pending", () => {
  const api = proposeKeyPolicy(obs());
  const cc = proposeKeyPolicy(obs({ ccRequests: 200, genuineRequests: 200 }));
  let { auto, changes } = reconcileAuto({}, api, T0);
  assert.equal(auto.decidedAt, new Date(T0).toISOString()); assert.equal(auto.workerMode, "canonical");
  assert.deepEqual(changes.map((c) => c.field).sort(), ["parameterPolicy", "responseMode", "telemetryPolicy", "workerMode"]);
  // day 1: traffic now looks like genuine CC → pending, nothing adopted
  ({ auto, changes } = reconcileAuto(auto, cc, T0 + DAY));
  assert.deepEqual(changes, []); assert.ok(auto.pending); assert.equal(auto.pending.since, new Date(T0 + DAY).toISOString()); assert.equal(auto.parameterPolicy, "warn");
  // day 2: still CC, not yet 3 days → still pending (since unchanged)
  ({ auto, changes } = reconcileAuto(auto, cc, T0 + 2 * DAY));
  assert.deepEqual(changes, []); assert.equal(auto.pending.since, new Date(T0 + DAY).toISOString());
  // day 3: flips back to API → pending restarts with the new proposal
  ({ auto, changes } = reconcileAuto(auto, api, T0 + 3 * DAY));
  assert.deepEqual(changes, []); assert.equal(auto.pending, undefined, "same as current → pending cleared");
  // CC for 3 straight days → adopted, with per-field events
  ({ auto } = reconcileAuto(auto, cc, T0 + 4 * DAY));
  ({ auto } = reconcileAuto(auto, cc, T0 + 5 * DAY));
  ({ auto, changes } = reconcileAuto(auto, cc, T0 + 4 * DAY + JUDGE_STABLE_MS));
  assert.equal(auto.parameterPolicy, "strict"); assert.equal(auto.historyPolicy, "passthrough"); assert.equal(auto.pending, undefined);
  assert.deepEqual(changes.map((c) => `${c.field}:${c.old}>${c.new}`).sort(), ["historyPolicy:null>passthrough", "parameterPolicy:warn>strict"]);
  assert.ok(layersEqual(auto, cc.layer));
});

test("nextKeyPolicyJson keeps the override layer and legacy flat documents; pending survives a parse round-trip", () => {
  const legacy = JSON.stringify({ historyPolicy: "reject", directOnly: true });
  const r = nextKeyPolicyJson(legacy, obs(), T0);
  const doc = parseKeyPolicyDoc(r.json);
  assert.deepEqual(doc.override, { historyPolicy: "reject", directOnly: true }, "flat doc became the override layer, untouched");
  assert.equal(doc.auto.workerMode, "canonical"); assert.match(doc.auto.basis, /rule=api_client/);
  // auto in force only via the switch; override still wins
  setSetting("key_policy_auto", "1");
  const eff = parseKeyPolicy(r.json);
  assert.equal(eff.historyPolicy, "reject"); assert.equal(eff.directOnly, true); assert.equal(eff.workerMode, "canonical");
  setSetting("key_policy_auto", "0");
  assert.equal(parseKeyPolicy(r.json).workerMode, "legacy", "0 = recorded only");
  const r2 = nextKeyPolicyJson(r.json, obs({ ccRequests: 200, genuineRequests: 200 }), T0 + DAY);
  const doc2 = parseKeyPolicyDoc(r2.json);
  assert.ok(doc2.auto.pending); assert.equal(doc2.auto.pending.layer.parameterPolicy, "strict"); assert.equal(doc2.auto.pending.since, new Date(T0 + DAY).toISOString());
  assert.equal(nextKeyPolicyJson(null, obs({ requests: 10 }), T0), null);
});

test("migration 35: key_policy_events exists, records flips, append-only", () => {
  assert.ok(one("SELECT 1 FROM sqlite_master WHERE type='table' AND name='key_policy_events'"));
  recordKeyPolicyEvents("k-ev", [{ field: "workerMode", old: null, new: "canonical" }, { field: "responseMode", old: "keepalive", new: "strict" }], "requests=60;rule=api_client", "2026-11-01T00:00:00Z");
  const ev = listKeyPolicyEvents("k-ev");
  assert.equal(ev.length, 2);
  assert.deepEqual(ev.map((e) => [e.field, e.old, e.new]).sort(), [["responseMode", '"keepalive"', '"strict"'], ["workerMode", null, '"canonical"']]);
  assert.throws(() => run("UPDATE key_policy_events SET new = 'x' WHERE api_key_id = 'k-ev'"), /append-only/);
  assert.throws(() => run("DELETE FROM key_policy_events WHERE api_key_id = 'k-ev'"), /append-only/);
});

test("I12: a bare 429 {rate_limit_error, \"Error\"} is request-scoped (answered once, no account cooldown, no retry)", () => {
  const r = classifyDirectRateLimit(JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "Error" } }), false);
  assert.equal(r.scope, "request"); assert.equal(r.code, "upstream_request_rejected"); assert.equal(r.retryable, false);
  assert.equal(classifyDirectRateLimit(JSON.stringify({ error: { type: "rate_limit_error", message: "Error." } }), false).scope, "request");
  // real account rate limits keep their account scope
  assert.equal(classifyDirectRateLimit(JSON.stringify({ error: { type: "rate_limit_error", message: "This request would exceed your organization's rate limit" } }), false).scope, "account");
  assert.equal(classifyDirectRateLimit(JSON.stringify({ error: { type: "rate_limit_error", message: "Error: something longer" } }), false).scope, "account");
});
