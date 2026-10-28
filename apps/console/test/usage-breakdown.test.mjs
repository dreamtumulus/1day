// Hourly / daily consumption breakdown (admin per user / per key, user per key)
// and the users list's lastRequestAt, against a real console app on a temp DATA_DIR.
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const dir = mkdtempSync(join(tmpdir(), "1dayapi-breakdown-"));
process.env.DATA_DIR = dir;
process.env.CCR_WINDOW_POLL = "0";
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));

const core = await import("@1dayapi/core");
const { buildApp } = await import("../dist/app.js");
const { createUser } = await import("../dist/session.js");
const { run, one } = core;

const app = await buildApp();
await app.listen({ port: 0, host: "127.0.0.1" });
const BASE = `http://127.0.0.1:${app.server.address().port}`;

async function login(key) {
  const r = await fetch(`${BASE}/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key }) });
  assert.equal(r.status, 200);
  const cookie = (r.headers.get("set-cookie") ?? "").split(";")[0];
  return async (method, path, body) => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { cookie, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const j = await res.json().catch(() => ({}));
    return { status: res.status, ...j };
  };
}

const admin = await login(readFileSync(join(dir, "admin-key.txt"), "utf8").trim());
const alice = createUser("consumer", "bd-alice");
const bob = createUser("consumer", "bd-bob");
const aliceCall = await login(alice.loginKey);
const bobCall = await login(bob.loginKey);
const k1 = (await aliceCall("POST", "/api/user/keys", { name: "alice-k1" })).data;
const k2 = (await aliceCall("POST", "/api/user/keys", { name: "alice-k2" })).data;
const kb = (await bobCall("POST", "/api/user/keys", { name: "bob-k" })).data;

let seq = 0;
function log(userId, keyId, at, cost, status = 200) {
  seq++;
  run(
    `INSERT INTO usage_logs (id, request_id, user_id, api_key_id, model, endpoint, status_code, input_tokens, output_tokens, actual_cost, total_cost, created_at)
     VALUES (?, ?, ?, ?, 'claude-sonnet-5', '/v1/messages', ?, 10, 5, ?, ?, ?)`,
    `l${seq}`,
    `r${seq}`,
    userId,
    keyId,
    status,
    cost,
    cost,
    at,
  );
}

// Fixture: two UTC hours on 2026-10-20 plus one on 2026-10-21 (all inside the 31-day hour window as of test time? no —
// the hour view is anchored to "now", so use dates relative to today).
const now = Date.now();
const iso = (offsetHours) => new Date(now - offsetHours * 3_600_000).toISOString().slice(0, 19) + "Z";
const H0 = iso(0); // this hour
const H1 = iso(1); // previous hour
const D1 = iso(26); // yesterday-ish (26 h ago)
log(alice.id, k1.id, H0, 1.5);
log(alice.id, k1.id, H0, 0.5, 429); // error: counted in errors, not requests; cost still summed (0.5)
log(alice.id, k2.id, H1, 2);
log(bob.id, kb.id, H1, 0.25);
log(bob.id, kb.id, D1, 4);
const day = (s) => s.slice(0, 10);
const from = day(iso(26 + 24));
const to = day(H0);

await test("admin breakdown by user, daily buckets", async () => {
  const r = await admin("GET", `/api/admin/usage/breakdown?bucket=day&from=${from}&to=${to}`);
  assert.equal(r.status, 200, JSON.stringify(r));
  assert.equal(r.data.bucket, "day");
  assert.equal(r.data.by, "user");
  const a = r.data.series.find((s) => s.key === alice.id);
  const b = r.data.series.find((s) => s.key === bob.id);
  assert.equal(a.name, "bd-alice");
  assert.equal(a.requests, 2);
  assert.equal(a.errors, 1);
  assert.ok(Math.abs(a.costUsd - 4) < 1e-9, `alice cost ${a.costUsd}`);
  assert.equal(a.lastAt, H0 >= H1 ? H0 : H1);
  assert.ok(Math.abs(b.costUsd - 4.25) < 1e-9);
  assert.equal(b.lastAt, H1);
  // series sorted by cost desc → bob first
  assert.equal(r.data.series[0].key, bob.id);
  // every cell carries the ISO start of its UTC day
  for (const c of r.data.cells) assert.match(c.t, /^\d{4}-\d{2}-\d{2}T00:00:00Z$/);
  const bobDays = r.data.cells.filter((c) => c.key === bob.id);
  assert.ok(bobDays.length >= 1 && bobDays.length <= 2);
});

await test("admin breakdown by hour for one user, per key", async () => {
  const r = await admin("GET", `/api/admin/usage/breakdown?bucket=hour&by=key&userId=${alice.id}&from=${from}&to=${to}`);
  assert.equal(r.status, 200, JSON.stringify(r));
  assert.equal(r.data.bucket, "hour");
  assert.equal(r.data.by, "key");
  assert.deepEqual(
    r.data.series.map((s) => s.name).sort(),
    ["alice-k1", "alice-k2"],
  );
  assert.ok(r.data.series.every((s) => s.key !== kb.id), "bob's key must not leak in");
  for (const c of r.data.cells) assert.match(c.t, /^\d{4}-\d{2}-\d{2}T\d{2}:00:00Z$/);
  const k1cell = r.data.cells.find((c) => c.key === k1.id);
  assert.equal(k1cell.requests, 1);
  assert.equal(k1cell.errors, 1);
  assert.ok(Math.abs(k1cell.costUsd - 2) < 1e-9);
});

await test("user breakdown is scoped to the caller's keys", async () => {
  const r = await bobCall("GET", `/api/user/usage/breakdown?bucket=day&from=${from}&to=${to}`);
  assert.equal(r.status, 200, JSON.stringify(r));
  assert.equal(r.data.by, "key");
  assert.deepEqual(r.data.series.map((s) => s.key), [kb.id]);
  assert.ok(Math.abs(r.data.series[0].costUsd - 4.25) < 1e-9);
  const keyFiltered = await aliceCall("GET", `/api/user/usage/breakdown?bucket=hour&keyId=${k2.id}&from=${from}&to=${to}`);
  assert.deepEqual(keyFiltered.data.series.map((s) => s.name), ["alice-k2"]);
});

await test("users list carries lastRequestAt", async () => {
  const r = await admin("GET", "/api/admin/users?q=bd-");
  assert.equal(r.status, 200);
  const a = r.data.items.find((u) => u.id === alice.id);
  const b = r.data.items.find((u) => u.id === bob.id);
  assert.equal(a.lastRequestAt, one("SELECT MAX(created_at) AS m FROM usage_logs WHERE user_id = ?", alice.id).m);
  assert.equal(b.lastRequestAt, H1);
  const idle = createUser("consumer", "bd-idle");
  const r2 = await admin("GET", "/api/admin/users?q=bd-idle");
  assert.equal(r2.data.items.find((u) => u.id === idle.id).lastRequestAt, null);
});

await app.close();
