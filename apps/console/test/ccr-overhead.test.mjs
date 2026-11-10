// X-54, console side: the admin-only overhead view (learned keys with the value in force and its source, pins,
// shipped defaults), the reset, and validation of the two settings. Real console app, temp DATA_DIR.
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const dir = mkdtempSync(join(tmpdir(), "1dayapi-console-overhead-"));
process.env.DATA_DIR = dir;
process.env.CCR_WINDOW_POLL = "0";
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));

const core = await import("@1dayapi/core");
const { buildApp } = await import("../dist/app.js");
const { createUser } = await import("../dist/session.js");

const app = await buildApp();
await app.listen({ port: 0, host: "127.0.0.1" });
after(() => app.close());
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
const consumer = await login(createUser("consumer", "ov-alice").loginKey);
const saveSettings = async (patch) => {
  const cur = (await admin("GET", "/api/admin/settings")).data;
  return admin("PUT", "/api/admin/settings", { ...patch, _revision: cur._revision });
};

test("admin only", async () => {
  assert.equal((await consumer("GET", "/api/admin/ccr-overhead")).status, 403);
  assert.equal((await consumer("DELETE", "/api/admin/ccr-overhead")).status, 403);
});

test("the view lists learned keys with the value in force and its source, pins and the shipped defaults", async () => {
  const cal = new core.OverheadCalibrator({ flushMs: 0 });
  const tui = { lane: "tui", tools: "none", model: "claude-opus-5-5", version: "2.1.322" };
  for (let i = 0; i < 8; i++) cal.record(tui, 29710 + i);
  for (let i = 0; i < 3; i++) cal.record({ lane: "p", tools: "none", model: "claude-opus-5-5", version: "2.1.312" }, 12330);
  let d = (await admin("GET", "/api/admin/ccr-overhead")).data;
  assert.equal(d.calibration, "on");
  assert.deepEqual([d.window, d.minSamples], [64, 8]);
  assert.ok(d.defaults.some((x) => x.lane === "p" && x.tools === "none" && x.value === 12200));
  const byKey = Object.fromEntries(d.keys.map((k) => [k.key, k]));
  const learned = byKey["tui|none|claude-opus-5-5|2.1.322"];
  assert.deepEqual([learned.value, learned.source, learned.learned, learned.samples, learned.n, learned.lane, learned.version], [29710, "learned", 29710, 8, 8, "tui", "2.1.322"]);
  assert.match(learned.updatedAt, /^\d{4}-\d\d-\d\dT/);
  const pending = byKey["p|none|claude-opus-5-5|2.1.312"];
  assert.deepEqual([pending.value, pending.source, pending.learned, pending.samples], [12200, "default", null, 3], "below 8 samples the default is in force");

  assert.equal((await saveSettings({ ccr_overhead_pins: "tui:none=30000" })).status, 200);
  d = (await admin("GET", "/api/admin/ccr-overhead")).data;
  assert.deepEqual(d.pins, [{ spec: "tui:none=30000", lane: "tui", tools: "none", model: null, value: 30000 }]);
  const pinned = d.keys.find((k) => k.key === "tui|none|claude-opus-5-5|2.1.322");
  assert.deepEqual([pinned.value, pinned.source, pinned.learned], [30000, "pinned", 29710]);

  assert.equal((await saveSettings({ ccr_overhead_pins: "", ccr_overhead_calibration: "off" })).status, 200);
  d = (await admin("GET", "/api/admin/ccr-overhead")).data;
  assert.equal(d.calibration, "off");
  assert.deepEqual([d.keys.find((k) => k.lane === "tui").value, d.keys.find((k) => k.lane === "tui").source], [29600, "default"], "off: the learned value is not in force");
  assert.equal((await saveSettings({ ccr_overhead_calibration: "on" })).status, 200);
});

test("settings validation: calibration is on|off, pins must parse", async () => {
  assert.equal((await saveSettings({ ccr_overhead_calibration: "maybe" })).status, 400);
  const bad = await saveSettings({ ccr_overhead_pins: "tui=29000, moon:none=5" });
  assert.equal(bad.status, 400);
  assert.match(JSON.stringify(bad), /moon:none=5/);
  assert.equal((await saveSettings({ ccr_overhead_pins: "legacy=0, p=0, tui=0, cloud=0" })).status, 200);
  assert.equal((await saveSettings({ ccr_overhead_pins: "" })).status, 200);
});

test("reset: one key or everything", async () => {
  assert.equal((await admin("DELETE", "/api/admin/ccr-overhead?key=nonsense")).status, 400);
  assert.deepEqual((await admin("DELETE", `/api/admin/ccr-overhead?key=${encodeURIComponent("p|none|claude-opus-5-5|2.1.312")}`)).data, { removed: 1 });
  assert.deepEqual((await admin("GET", "/api/admin/ccr-overhead")).data.keys.map((k) => k.key), ["tui|none|claude-opus-5-5|2.1.322"]);
  assert.deepEqual((await admin("DELETE", "/api/admin/ccr-overhead")).data, { removed: 1 });
  assert.deepEqual((await admin("GET", "/api/admin/ccr-overhead")).data.keys, []);
});
