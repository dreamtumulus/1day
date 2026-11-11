// usage.w5 of the admin account list: what an account served inside its five-hour quota window
// ([window_5h_reset_at − 5 h, window_5h_reset_at)), as opposed to usage.h5, the rolling last five hours.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const dir = mkdtempSync(join(tmpdir(), "1dayapi-window-yield-"));
process.env.DATA_DIR = dir;
process.env.CCR_WINDOW_POLL = "0";
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));

const core = await import("@1dayapi/core");
const { accountUsageStats } = await import("../dist/shapes.js");
const { createUser } = await import("../dist/session.js");
const { run } = core;

const user = createUser("consumer", "wy-user");
const iso = (ms) => new Date(ms).toISOString().slice(0, 19) + "Z";
const HOUR = 3_600_000;
const now = Date.now();

function account(id, resetAt) {
  run(
    "INSERT INTO accounts (id, name, platform, type, protocol, credential_enc, window_5h_reset_at) VALUES (?, ?, 'anthropic', 'oauth', 'anthropic', 'x', ?)",
    id,
    id,
    resetAt,
  );
}
let seq = 0;
function log(accountId, at, cost, status = 200) {
  seq++;
  run(
    `INSERT INTO usage_logs (id, request_id, user_id, api_key_id, account_id, model, endpoint, status_code, input_tokens, output_tokens, actual_cost, total_cost, created_at)
     VALUES (?, ?, ?, 'wy-key', ?, 'claude-sonnet-5', '/v1/messages', ?, 10, 5, ?, ?, ?)`,
    `wy${seq}`,
    `wyr${seq}`,
    user.id,
    accountId,
    status,
    cost,
    cost,
    at,
  );
}

test("w5 is the yield of the finished quota window while h5 has rolled past it", () => {
  // window 8 h ago → 3 h ago, drained in its first two hours (the 2026-11-11 case: 5H showed $20, the window made $60)
  const reset = now - 3 * HOUR;
  account("wy-rested", iso(reset));
  log("wy-rested", iso(reset - 5 * HOUR + 60_000), 30); // first minutes of the window: outside the rolling 5 h
  log("wy-rested", iso(reset - 4 * HOUR), 10);
  log("wy-rested", iso(reset - 3.5 * HOUR), 20); // inside the window, still outside the rolling 5 h
  log("wy-rested", iso(reset - 1.5 * HOUR), 5); // inside both
  log("wy-rested", iso(reset - 5 * HOUR - 60_000), 99); // the window before: in neither
  const u = accountUsageStats(["wy-rested"]).get("wy-rested");
  assert.equal(u.w5.costUsd, 65);
  assert.equal(u.w5.requests, 4);
  assert.equal(u.w5.startAt, iso(reset - 5 * HOUR));
  assert.equal(u.w5.endAt, iso(reset));
  assert.equal(u.h5.costUsd, 5);
  assert.equal(u.all.costUsd, 164);
});

test("w5 covers the running window when the reset is still ahead, and excludes the bounds correctly", () => {
  const reset = now + 2 * HOUR;
  account("wy-live", iso(reset));
  log("wy-live", iso(reset - 5 * HOUR), 7); // exactly at the start: inside
  log("wy-live", iso(now - 60_000), 3);
  log("wy-live", iso(now - 30_000), 4, 502); // failed request: its cost counts like in the other buckets, the request does not
  log("wy-live", iso(reset - 5 * HOUR - 1_000), 50); // one second before the window
  const u = accountUsageStats(["wy-live"]).get("wy-live");
  assert.equal(u.w5.costUsd, 14);
  assert.equal(u.w5.requests, 2);
  assert.equal(u.h5.costUsd, 64); // the rolling 5 h also holds the row of the window before
});

test("no reported five-hour reset → w5 is null; a window without usage is an empty bucket", () => {
  account("wy-none", null);
  log("wy-none", iso(now - HOUR), 2);
  account("wy-idle", iso(now + HOUR));
  const m = accountUsageStats(["wy-none", "wy-idle", "wy-missing"]);
  assert.equal(m.get("wy-none").w5, null);
  assert.equal(m.get("wy-none").h5.costUsd, 2);
  assert.deepEqual(m.get("wy-idle").w5, { requests: 0, costUsd: 0, tokens: 0, startAt: iso(now + HOUR - 5 * HOUR), endAt: iso(now + HOUR) });
  assert.equal(m.get("wy-idle").all.requests, 0);
  assert.equal(m.has("wy-missing"), false);
});
