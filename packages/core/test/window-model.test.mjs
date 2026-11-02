// Which windows an account is subject to (accounts.window_model), from the usage probe / unified headers / Claude Code's
// rate_limit_event; a verified Ultra account (no five-hour window since 2026-10-30) is never "rested" past its reset.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const dir = mkdtempSync(join(tmpdir(), "1dayapi-core-window-model-"));
process.env.DATA_DIR = dir;
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
const core = await import("../dist/index.js");
const { run, one } = core;
const now = core.nowIso();
for (const id of ["u1", "m1", "h1"]) {
  run(`INSERT INTO accounts (id, name, platform, type, protocol, credential_enc, created_at, updated_at, team_id) VALUES (?, ?, 'anthropic', 'oauth', 'anthropic', ?, ?, ?, NULL)`, id, id, core.encryptJson({ accessToken: "k" }), now, now);
}
const model = (id) => core.parseWindowModel(one("SELECT window_model FROM accounts WHERE id=?", id).window_model);
const acct = (id) => one("SELECT window_exhausted_until, window_reason, window_5h_used, window_7d_used FROM accounts WHERE id=?", id);
const plus = (ms) => new Date(Date.now() + ms).toISOString().slice(0, 19) + "Z";

test("usage probe: five_hour null → window_model.five_hour=false; Pro/Max body → true", () => {
  const ultra = core.parseUsageSnapshot({ five_hour: null, seven_day: { utilization: 18, resets_at: plus(86_400_000) }, seven_day_sonnet: null });
  assert.deepEqual(ultra.presence, { five_hour: false, seven_day: true, fable: false });
  core.recordWindowUsage("u1", ultra, undefined, "usage_probe");
  assert.equal(model("u1").five_hour, false);
  assert.equal(model("u1").source, "usage_probe");
  assert.equal(core.accountHasFiveHour("u1"), false);
  const max = core.parseUsageSnapshot({ five_hour: { utilization: 1, resets_at: plus(3_600_000) }, seven_day: { utilization: 18, resets_at: plus(86_400_000) } });
  core.recordWindowPresence("m1", max.presence, "usage_probe");
  assert.equal(model("m1").five_hour, true);
  assert.equal(core.accountHasFiveHour("h1"), null, "never observed = unknown");
});

test("rate_limit_event: parsed like headers, five_hour event proves the window exists, rejected pauses the account", () => {
  const ev = core.parseRateLimitEvent({ status: "allowed_warning", rateLimitType: "five_hour", utilization: 0.93, resetsAt: Math.floor(Date.now() / 1000) + 1800 });
  assert.equal(ev.window, "five_hour");
  assert.equal(ev.used, 0.93);
  assert.ok(ev.resetAt > now);
  assert.equal(core.parseRateLimitEvent({ status: "allowed" }), null, "no window named → nothing to record");
  assert.equal(core.parseRateLimitEvent({ status: "allowed", rateLimitType: "seven_day_opus", utilization: 0.2 }).window, "seven_day_opus");
  core.recordRateLimitEvent("h1", { status: "allowed", rateLimitType: "five_hour", utilization: 0.5, resetsAt: Math.floor(Date.now() / 1000) + 1800 });
  assert.equal(model("h1").five_hour, true);
  assert.equal(acct("h1").window_5h_used, 0.5);
  const rejected = core.recordRateLimitEvent("h1", { status: "rejected", rateLimitType: "five_hour", utilization: 1, resetsAt: Math.floor(Date.now() / 1000) + 600 });
  assert.equal(rejected.used, 1);
  assert.ok(acct("h1").window_exhausted_until > now, "rejected five_hour pauses the account");
});

test("no five-hour window: exhaustion reopens exactly at the reset, no post-reset rest", () => {
  const reset = plus(1_800_000);
  core.markFailure("u1", { kind: "window_exhausted", resetAt: reset, window: "five_hour" });
  assert.equal(acct("u1").window_exhausted_until, reset, "verified Ultra: until == reset");
  core.markFailure("m1", { kind: "window_exhausted", resetAt: reset, window: "five_hour" });
  assert.ok(acct("m1").window_exhausted_until > reset, "Max keeps the configured rest after reset");
});

test("unified headers: 7d without 5h needs three agreeing samples before 'no five-hour window' is believed", () => {
  const snap = core.parseUnifiedRateLimitHeaders({ "anthropic-ratelimit-unified-7d-utilization": "0.2", "anthropic-ratelimit-unified-7d-reset": String(Math.floor(Date.now() / 1000) + 86_400) });
  assert.deepEqual(snap.presence, { five_hour: false, seven_day: true, fable: false });
  run("UPDATE accounts SET window_model=NULL WHERE id='h1'");
  core.recordWindowPresence("h1", snap.presence, "headers");
  core.recordWindowPresence("h1", snap.presence, "headers");
  assert.equal(model("h1").five_hour, null);
  core.recordWindowPresence("h1", snap.presence, "headers");
  assert.equal(model("h1").five_hour, false);
  const both = core.parseUnifiedRateLimitHeaders({ "anthropic-ratelimit-unified-5h-utilization": "0.1", "anthropic-ratelimit-unified-7d-utilization": "0.2" });
  core.recordWindowPresence("h1", both.presence, "headers");
  assert.equal(model("h1").five_hour, true, "a 5h header flips it straight back");
});
