// Subscription-window helpers (sub2api-style threshold + passive sampling) — pure, no DB.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseThresholdPercent,
  parseUnifiedRateLimitHeaders,
  parseUsageSnapshot,
  rejectedWindow,
  windowAllows,
  windowExhausted,
} from "../dist/window.js";

const NOW = "2026-10-15T12:00:00Z";
const acc = (o) => ({ executor: "direct", window_used: null, window_reset_at: null, window_exhausted_until: null, ...o });

test("never probed -> allowed", () => assert.ok(windowAllows(acc({}), NOW)));

test("window cooldown blocks until it passes", () => {
  assert.ok(!windowAllows(acc({ window_exhausted_until: "2026-10-15T12:00:01Z" }), NOW));
  assert.ok(windowAllows(acc({ window_exhausted_until: "2026-10-15T12:00:00Z" }), NOW));
});

test("threshold percent", () => {
  assert.ok(windowAllows(acc({ window_used: 0.9, window_reset_at: "2026-10-15T15:00:00Z" }), NOW));
  assert.ok(!windowAllows(acc({ window_used: 0.96, window_reset_at: "2026-10-15T15:00:00Z" }), NOW));
  assert.ok(windowAllows(acc({ window_used: 0.96, window_reset_at: "2026-10-15T15:00:00Z" }), NOW, 98));
  assert.ok(windowAllows(acc({ window_used: 1 }), NOW, 100), "100 = off");
  assert.ok(!windowAllows(acc({ window_used: 1 }), NOW));
});

test("stale snapshot past reset is allowed again", () => {
  assert.ok(windowAllows(acc({ window_used: 1, window_reset_at: "2026-10-15T11:59:59Z" }), NOW));
});

test("windowExhausted / parseThresholdPercent", () => {
  assert.ok(windowExhausted(0.95));
  assert.ok(!windowExhausted(0.949));
  assert.ok(!windowExhausted(null));
  assert.ok(!windowExhausted(1, 100));
  assert.equal(parseThresholdPercent("80"), 80);
  assert.equal(parseThresholdPercent("x"), 95);
  assert.equal(parseThresholdPercent("0"), 95);
});

test("usage probe body: binding window + per-window detail", () => {
  const snap = parseUsageSnapshot({
    five_hour: { utilization: 12.5, resets_at: "2026-10-15T14:00:00.000Z" },
    seven_day: { utilization: 63, resets_at: "2026-10-20T00:00:00Z" },
    seven_day_sonnet: { utilization: 0, resets_at: null },
    extra: "ignored",
  });
  assert.equal(snap.used, 0.63);
  assert.equal(snap.window, "seven_day");
  assert.equal(snap.resetAt, "2026-10-20T00:00:00Z");
  assert.deepEqual(snap.fiveHour, { used: 0.125, resetAt: "2026-10-15T14:00:00Z" });
  assert.equal(parseUsageSnapshot({ foo: "bar" }), null);
  assert.equal(parseUsageSnapshot({ five_hour: { utilization: 250 } }).used, 1);
  // Real probe body (docs/ccr-supply.md A.1): percent values, null windows, extra_usage ignored.
  const real = parseUsageSnapshot({
    five_hour: { utilization: 0.5, resets_at: null, limit_dollars: null },
    seven_day: { utilization: 0.0, resets_at: "2026-10-16T06:00:00+00:00" },
    seven_day_opus: null,
    extra_usage: { is_enabled: false, utilization: null },
  });
  assert.equal(real.used, 0.005, "0.5 means 0.5 percent, not 50%");
  assert.equal(real.window, "five_hour");
});

test("passive sampling from unified rate-limit headers", () => {
  const h = new Headers({
    "anthropic-ratelimit-unified-5h-utilization": "0.42",
    "anthropic-ratelimit-unified-5h-reset": "1792000000",
    "anthropic-ratelimit-unified-5h-status": "allowed",
    "anthropic-ratelimit-unified-7d-utilization": "0.1",
    "anthropic-ratelimit-unified-7d-reset": "1792400000",
    "anthropic-ratelimit-unified-7d-status": "allowed",
  });
  const snap = parseUnifiedRateLimitHeaders(h);
  assert.equal(snap.window, "five_hour");
  assert.equal(snap.used, 0.42);
  assert.equal(snap.resetAt, "2026-10-14T17:46:40Z");
  assert.equal(snap.sevenDay.used, 0.1);
  assert.equal(parseUnifiedRateLimitHeaders(new Headers({ "content-type": "application/json" })), null);
  // plain object source (node http headers)
  assert.equal(parseUnifiedRateLimitHeaders({ "anthropic-ratelimit-unified-7d-utilization": "0.5" }).used, 0.5);
});

test("429 with a rejected window -> cool until that window resets", () => {
  const now = "2026-10-15T12:00:00Z";
  const reset5h = String(Math.floor(Date.parse("2026-10-15T15:00:00Z") / 1000));
  const h = new Headers({
    "anthropic-ratelimit-unified-5h-utilization": "1",
    "anthropic-ratelimit-unified-5h-reset": reset5h,
    "anthropic-ratelimit-unified-5h-status": "rejected",
    "anthropic-ratelimit-unified-7d-utilization": "0.3",
  });
  const snap = parseUnifiedRateLimitHeaders(h);
  assert.equal(snap.used, 1);
  assert.deepEqual(rejectedWindow(snap, now), { window: "five_hour", resetAt: "2026-10-15T15:00:00Z" });
  // reset in the past or absurdly far -> ignored
  assert.equal(rejectedWindow(parseUnifiedRateLimitHeaders(new Headers({ "anthropic-ratelimit-unified-5h-status": "rejected", "anthropic-ratelimit-unified-5h-reset": "100" })), now), null);
  assert.equal(rejectedWindow(null, now), null);
});

test("Fable 7d_oi window: sampled separately, never the binding window; scoped rejection", async () => {
  const { fableRejectedWindow, isCreditsRequired, modelScope } = await import("../dist/window.js");
  const now = "2026-10-15T12:00:00Z";
  const reset = String(Math.floor(Date.parse("2026-10-18T12:00:00Z") / 1000));
  const h = new Headers({
    "anthropic-ratelimit-unified-5h-utilization": "0.2",
    "anthropic-ratelimit-unified-7d-utilization": "0.3",
    "anthropic-ratelimit-unified-7d_oi-utilization": "1.0",
    "anthropic-ratelimit-unified-7d_oi-surpassed-threshold": "1.0",
    "anthropic-ratelimit-unified-7d_oi-reset": reset,
  });
  const snap = parseUnifiedRateLimitHeaders(h);
  assert.equal(snap.window, "seven_day", "binding stays 5h/7d");
  assert.equal(snap.used, 0.3);
  assert.equal(snap.fable.used, 1);
  assert.equal(snap.fable.resetAt, "2026-10-18T12:00:00Z");
  assert.deepEqual(fableRejectedWindow(snap, now), { resetAt: "2026-10-18T12:00:00Z" });
  assert.equal(rejectedWindow(snap, now), null, "account-wide windows are not exhausted");
  // usage body: seven_day_fable / seven_day_overage_included are not folded into the binding window
  const body = { five_hour: { utilization: 10, resets_at: "2026-10-15T15:00:00Z" }, seven_day: { utilization: 20, resets_at: "2026-10-20T00:00:00Z" }, seven_day_overage_included: { utilization: 100, resets_at: "2026-10-18T00:00:00Z" }, seven_day_sonnet: { utilization: 99 } };
  const u = parseUsageSnapshot(body);
  assert.equal(u.window, "seven_day");
  assert.equal(u.used, 0.2, "sonnet/fable family windows do not pause the account");
  assert.equal(u.fable.used, 1);
  assert.equal(modelScope("claude-fable-5-1"), "fable");
  assert.equal(modelScope("claude-opus-5-5"), null);
  assert.ok(isCreditsRequired(JSON.stringify({ error: { type: "rate_limit_error", details: { error_code: "credits_required" } } })));
  assert.ok(!isCreditsRequired("{}") && !isCreditsRequired("not json"));
});

test("ccLimitReset: Claude Code limit text → window + reset instant in the quoted zone", async () => {
  const { ccLimitReset } = await import("../dist/window.js");
  const now = new Date("2026-10-17T04:00:00Z"); // 06:00 in Europe/Berlin (CEST, UTC+2)
  assert.deepEqual(ccLimitReset("You've hit your session limit · resets 8:50am (Europe/Berlin)", now), { window: "session", resetAt: "2026-10-17T06:50:00Z" });
  // Wall time already past today → tomorrow.
  assert.deepEqual(ccLimitReset("You've hit your session limit · resets 5:00am (Europe/Berlin)", now), { window: "session", resetAt: "2026-10-18T03:00:00Z" });
  // Weekly form with a date; 3pm Berlin = 13:00Z.
  assert.deepEqual(ccLimitReset("You've hit your weekly limit · resets Oct 21, 3pm (Europe/Berlin)", now), { window: "weekly", resetAt: "2026-10-21T13:00:00Z" });
  // No zone → UTC; no time → null reset (caller falls back to 1h).
  assert.deepEqual(ccLimitReset("hit your usage limit, resets 9pm", now), { window: "usage", resetAt: "2026-10-17T21:00:00Z" });
  assert.deepEqual(ccLimitReset("You've hit your session limit", now), { window: "session", resetAt: null });
  assert.equal(ccLimitReset("stream: upstream closed", now), null);
  assert.equal(ccLimitReset("API Error: 529 overloaded", now), null);
});
