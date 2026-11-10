// Review 2026-11-09, items G (settlement blast radius, lease-renew retries) and H (public /health, bounded counters).
// No upstream is involved: every request here ends at admission.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import Fastify from "fastify";

process.env.PROBE_INTERCEPT = "0";
process.env.METRICS_MAX_SERIES_PER_NAME = "5";
process.env.METRICS_MAX_KEYS = "40";
const core = await import("@1dayapi/core");
const { registerRoutes } = await import("../dist/routes.js");
const metrics = await import("../dist/metrics.js");
const { renewWithRetry } = await import("../dist/lifecycle.js");
const { SharedAccountGates } = await import("../dist/limits.js");
const app = Fastify();
registerRoutes(app);
await app.ready();
after(async () => { await app.close(); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let n = 0;
function key(balance) {
  const id = `hms-${++n}`;
  core.run("INSERT INTO users(id,role,name,login_key_hash,login_key_preview,balance_usd) VALUES (?,'consumer',?,?,?,?)", id, id, `login-${id}`, "login", balance);
  core.run("INSERT INTO groups(id,name) VALUES (?,?)", id, id);
  core.run("INSERT INTO api_keys(id,user_id,name,key_hash,key_preview,group_id) VALUES (?,?,?,?,?,?)", id, id, id, core.sha256Hex(id), id, id);
  return { id, headers: { authorization: `Bearer ${id}`, "anthropic-version": "2023-06-01" } };
}
const post = (k, body) => app.inject({ method: "POST", url: "/v1/messages", headers: k.headers, payload: body });
const breakUsageLog = () => core.db.exec("CREATE TRIGGER hms_fail BEFORE INSERT ON usage_logs BEGIN SELECT RAISE(FAIL,'injected log write failure'); END");
const fixUsageLog = () => core.db.exec("DROP TRIGGER IF EXISTS hms_fail");

// ---------- H: /health and /internal/metrics ----------

test("H: public /health is liveness only — no counters, no labels", async () => {
  metrics.bump("org_budget_exhausted_total", { team: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa" });
  const res = await app.inject({ method: "GET", url: "/health" });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.deepEqual(Object.keys(body).sort(), ["service", "status", "time"]);
  assert.equal(body.status, "ok");
  assert.ok(!res.body.includes("aaaaaaaa-aaaa"), "no organisation id leaves on the public endpoint");
});

for (const c of [
  { name: "no token", headers: {}, status: 401 },
  { name: "wrong token", headers: { "x-1dayapi-internal": "not-the-token" }, status: 401 },
  { name: "an API key is not the internal token", headers: { authorization: "Bearer hms-1" }, status: 401 },
  { name: "internal token", headers: null, status: 200 },
]) {
  test(`H: /internal/metrics — ${c.name} → ${c.status}`, async () => {
    const headers = c.headers ?? { [core.INTERNAL_HEADER]: core.internalToken };
    const res = await app.inject({ method: "GET", url: "/internal/metrics", headers });
    assert.equal(res.statusCode, c.status);
    if (c.status === 200) {
      const body = res.json();
      assert.equal(typeof body.counters, "object", "same shape /health used to have: {status, service, time, counters}");
      assert.ok(Object.keys(body.counters).some((k) => k.startsWith("org_budget_exhausted_total")));
      for (const g of ["settlement_journal_pending", "settlement_journal_dead_letter", "settlement_healthy"]) assert.ok(g in body.counters, `${g} exposed`);
    } else {
      assert.ok(!res.body.includes("counters"));
    }
  });
}

test("H: label values are sanitised and truncated", () => {
  for (const [input, expected] of [
    ["cli", "cli"],
    ["cc-2.1.312-restricted", "cc-2.1.312-restricted"],
    ['a"b}c,d=e\nf', "a_b_c_d_e_f"],
    ["", "_"],
    ["x".repeat(500), `${"x".repeat(63)}~`],
    ["{evil=1},other_total", "_evil_1__other_total"],
  ]) assert.equal(metrics.sanitizeLabelValue(input), expected, JSON.stringify(input.slice(0, 20)));
});

test("H: client-controlled label values cannot grow the map — per-name cap, overflow in `other`", () => {
  metrics.resetCounters();
  for (let i = 0; i < 500; i++) metrics.bump("custom_entrypoint_denied_total", { entrypoint: `attacker-${i}` });
  const keys = Object.keys(metrics.countersSnapshot()).filter((k) => k.startsWith("custom_entrypoint_denied_total"));
  assert.equal(keys.length, 6, "5 series + the overflow bucket");
  assert.equal(metrics.counterValue("custom_entrypoint_denied_total{other=1}"), 495);
  // known series keep counting after the cap is reached
  metrics.bump("custom_entrypoint_denied_total", { entrypoint: "attacker-0" });
  assert.equal(metrics.counterValue("custom_entrypoint_denied_total{entrypoint=attacker-0}"), 2);
});

test("H: the whole map has a key cap; plain names and overflow buckets are always admitted", () => {
  metrics.resetCounters();
  for (let name = 0; name < 30; name++) for (let v = 0; v < 5; v++) metrics.bump(`m${name}_total`, { v: `v${v}` });
  const snap = Object.keys(metrics.countersSnapshot()).filter((k) => /^m\d+_total/.test(k));
  assert.ok(snap.length <= 40 + 30, `bounded: ${snap.length}`);
  metrics.bump("plain_total");
  assert.equal(metrics.counterValue("plain_total"), 1);
  metrics.resetCounters();
});

// ---------- G: zero-cost rows never close admission ----------

for (const c of [
  { name: "402 insufficient_balance (auth.ts reject)", balance: 0, body: { model: "claude-sonnet-5", max_tokens: 8, messages: [{ role: "user", content: "hi" }] }, status: 402 },
  { name: "404 model_not_found (proxy.ts reject)", balance: 5, body: { model: "no-such-model-xyz", max_tokens: 8, messages: [{ role: "user", content: "hi" }] }, status: 404 },
  { name: "400 missing max_tokens (proxy.ts reject)", balance: 5, body: { model: "claude-sonnet-5", messages: [{ role: "user", content: "hi" }] }, status: 400 },
]) {
  test(`G: a failed zero-cost log write does not 503 the next request — ${c.name}`, async () => {
    const rejected = key(c.balance), healthy = key(5);
    assert.equal(core.settlementHealthy(), true);
    breakUsageLog();
    try {
      const r = await post(rejected, c.body);
      assert.equal(r.statusCode, c.status, r.body);
      assert.equal(core.settlementJournalStats().healthy, true, "healthy untouched by a log row");
      assert.equal(core.settlementJournalStats().pending, 0, "nothing queued");
      // any other caller is still admitted (it fails later for its own reasons, never with settlement_unavailable)
      const next = await post(healthy, { model: "no-such-model-xyz", max_tokens: 8, messages: [{ role: "user", content: "hi" }] });
      assert.equal(next.statusCode, 404, next.body);
      assert.ok(!next.body.includes("settlement_unavailable"));
    } finally { fixUsageLog(); }
    await sleep(5);
    assert.equal(core.settlementHealthy(), true);
  });
}

test("G: a pending MONEY row still fails closed (503 settlement_unavailable) until it is replayed", async () => {
  const u = key(5);
  breakUsageLog();
  try {
    const r = core.settleRequestDurably({ requestId: core.newId(), userId: u.id, apiKeyId: u.id, groupId: u.id, rateMultiplier: 1, accountId: null, providerId: null, payoutRate: 0,
      model: "claude-sonnet-5", upstreamModel: "claude-sonnet-5", endpoint: "/v1/messages", stream: false, statusCode: 200, usage: { input_tokens: 10, output_tokens: 10 }, usageEstimated: false });
    assert.equal(r.pending, true);
    const blocked = await post(u, { model: "no-such-model-xyz", max_tokens: 8, messages: [{ role: "user", content: "hi" }] });
    assert.equal(blocked.statusCode, 503);
    assert.ok(blocked.body.includes("settlement_unavailable"));
    const m = await app.inject({ method: "GET", url: "/internal/metrics", headers: { [core.INTERNAL_HEADER]: core.internalToken } });
    assert.equal(m.json().counters.settlement_journal_pending, 1);
    assert.equal(m.json().counters.settlement_healthy, 0);
  } finally { fixUsageLog(); }
  assert.equal(core.retryPendingSettlements(), 0);
  const open = await post(u, { model: "no-such-model-xyz", max_tokens: 8, messages: [{ role: "user", content: "hi" }] });
  assert.equal(open.statusCode, 404);
});

// ---------- G: lease / budget renewals retry before aborting ----------

for (const c of [
  { name: "succeeds first time", script: ["ok"], lost: 0, calls: 1 },
  { name: "one failed write, then ok", script: ["throw", "ok"], lost: 0, calls: 2 },
  { name: "two failed writes, then ok", script: ["throw", "throw", "ok"], lost: 0, calls: 3 },
  { name: "three failed writes → request aborted", script: ["throw", "throw", "throw", "ok"], lost: 1, calls: 3 },
  { name: "lease really gone (returns false) → aborted at once, no retry", script: ["false", "ok"], lost: 1, calls: 1 },
  { name: "lease really gone (loss error) → aborted at once, no retry", script: ["loss", "ok"], lost: 1, calls: 1 },
  { name: "failure then real loss", script: ["throw", "false"], lost: 1, calls: 2 },
]) {
  test(`G: renewWithRetry — ${c.name}`, async () => {
    let calls = 0, lost = 0;
    renewWithRetry(() => {
      const step = c.script[calls++];
      if (step === "throw") throw new Error("SQLITE_BUSY: database is locked");
      if (step === "loss") throw new Error("request budget lease lost");
      return step !== "false";
    }, () => { lost++; }, { tries: 3, backoffMs: 5, label: "test", isLoss: (e) => /lease lost/.test(e.message) });
    await sleep(80);
    assert.deepEqual({ calls, lost }, { calls: c.calls, lost: c.lost });
  });
}

test("G: renewWithRetry stops retrying once the request has finished", async () => {
  let calls = 0, lost = 0, done = false;
  renewWithRetry(() => { calls++; throw new Error("busy"); }, () => { lost++; }, { tries: 3, backoffMs: 5, label: "test", stopped: () => done });
  done = true;
  await sleep(60);
  assert.deepEqual({ calls, lost }, { calls: 1, lost: 0 });
});

const breakLeases = () => core.db.exec("ALTER TABLE gateway_account_leases RENAME TO gateway_account_leases_broken");
const fixLeases = () => core.db.exec("ALTER TABLE gateway_account_leases_broken RENAME TO gateway_account_leases");

test("G: account lease renewal — a transient database failure is retried and the request survives", async () => {
  let lost = 0;
  const gates = new SharedAccountGates();
  const lease = gates.acquireLease("renew-retry-ok", 1, 0, () => lost++);
  breakLeases();
  let fixed = false;
  try {
    gates.renewLeases(3, 20);
    assert.equal(lost, 0, "first failure does not abort");
    await sleep(5);
  } finally { fixLeases(); fixed = true; }
  await sleep(120);
  assert.ok(fixed);
  assert.equal(lost, 0);
  assert.equal(lease.isValid(), true);
  lease.release();
});

test("G: account lease renewal — a database that keeps failing aborts after 3 tries", async () => {
  let lost = 0;
  const gates = new SharedAccountGates();
  const lease = gates.acquireLease("renew-retry-fail", 1, 0, () => lost++);
  breakLeases();
  try {
    gates.renewLeases(3, 10);
    await sleep(15);
    assert.equal(lost, 0, "still retrying after the first backoff");
    await sleep(120);
    assert.equal(lost, 1, "aborted once, after the third failure");
  } finally { fixLeases(); }
  lease.release();
});
